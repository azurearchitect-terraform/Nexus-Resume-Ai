/**
 * Deterministic resume-to-job-description match scoring.
 *
 * The "Match Score" used to be a number the LLM wrote about its own rewrite -
 * the prompt schema even pre-filled it with 85 - so it was not reproducible and
 * not derived from the documents. This module computes it in code instead: the
 * same resume and job description always produce the same score, and every
 * point traces back to a concrete keyword, title, tenure or degree check.
 *
 * Score = weighted blend of the components the job description actually asks about:
 *   - JD keywords (70%): weighted share of the JD's skills, tools and repeated domain
 *     terms that appear in the resume. Items listed under "required" headings or
 *     repeated in the JD weigh more; "preferred" items and soft skills weigh less.
 *   - Job title   (10%): the target title, or its core words, appears in the resume.
 *   - Experience  (10%): years covered by the resume's role dates vs. the JD's "N+ years".
 *   - Education   (10%): highest degree in the resume vs. the minimum degree the JD requires.
 * Components the job description does not mention are dropped and the rest re-weighted.
 *
 * Keep this module dependency-free: it is bundled by both esbuild (node) and vite (browser).
 * Avoid regex lookbehind - older Safari versions cannot parse it.
 */

export type MatchComponentId = "keywords" | "title" | "experience" | "education";

export interface MatchComponent {
  id: MatchComponentId;
  label: string;
  /** 0-100 score for this component on its own. */
  score: number;
  /** Share of the overall score (0-1) after dropping components the JD does not mention. */
  weight: number;
  detail: string;
}

export interface MatchScoreResult {
  /** Overall match, 0-100. */
  score: number;
  components: MatchComponent[];
  /** JD requirements found in the resume, most important first. */
  matchedKeywords: string[];
  /** JD requirements missing from the resume, most important first. */
  missingKeywords: string[];
  totalKeywords: number;
}

export interface MatchScoreOptions {
  targetRole?: string;
  /** Hiring company. Its name is never mistaken for a skill requirement. */
  companyName?: string;
  /** Reference date for "Present" in role durations. Defaults to the current date. */
  now?: Date;
}

const COMPONENT_WEIGHTS: Record<MatchComponentId, number> = {
  keywords: 0.7,
  title: 0.1,
  experience: 0.1,
  education: 0.1,
};

const COMPONENT_LABELS: Record<MatchComponentId, string> = {
  keywords: "JD keywords",
  title: "Job title",
  experience: "Experience",
  education: "Education",
};

type SectionKind = "required" | "duties" | "general" | "preferred" | "boilerplate";

const SECTION_MULTIPLIER: Record<SectionKind, number> = {
  required: 1.5,
  duties: 1,
  general: 1,
  preferred: 0.6,
  boilerplate: 0,
};

type RequirementKind = "skill" | "soft" | "tool" | "term";

/** Hard skills dominate ATS screening; soft skills and inferred terms count for less. */
const KIND_FACTOR: Record<RequirementKind, number> = {
  skill: 1,
  tool: 0.8,
  soft: 0.5,
  term: 0.5,
};

/** Repeated domain words (e.g. "shipments", "patients") outside the skills lexicon. */
const MAX_TERM_REQUIREMENTS = 8;
const MIN_TERM_OCCURRENCES = 2;

const DEGREE_NAMES = ["None", "Diploma/Associate", "Bachelor's", "Master's", "PhD"];

/*
 * Skills lexicon. Each entry is "Canonical|alias|alias". Aliases are matched as whole,
 * lightly stemmed token sequences, so "Kubernetes clusters" and "k8s" both count as
 * Kubernetes, but "Java" never matches "JavaScript".
 * A leading "~" marks a canonical name that is too ambiguous to match as plain text
 * (e.g. "Go", "React", "Excel"); those are detected only through SKILL_PATTERNS.
 */
const HARD_SKILLS: string[] = [
  // Programming languages
  "Python|python3|python 3",
  "Java|core java|java 8|java 11|java 17",
  "JavaScript|js|ecmascript|es6",
  "TypeScript",
  "C++|cpp",
  "C#|csharp|c sharp",
  "~C|c programming|c language|ansi c",
  "~Go|golang|go programming|go language",
  "~R|r programming|r language|rstudio",
  "~Rust|rust programming|rust language|rustlang",
  "~Swift|swift programming|swift language",
  "~Dart|dart programming|dart language",
  "Ruby", "PHP", "Perl", "Scala", "Kotlin", "Objective-C|objective c", "Elixir", "Haskell",
  "Lua", "MATLAB", "SAS", "VBA|excel vba", "Groovy", "Solidity",
  "Bash|shell scripting|shell scripts|shell script|bash scripting|unix shell",
  "PowerShell|powershell scripting|powershell scripts",
  "Scripting|scripting languages|scripts|automation scripts",
  "SQL|structured query language|sql queries",
  "NoSQL|no-sql|nosql databases",
  "HTML|html5", "CSS|css3", "Sass|scss", "YAML", "JSON", "XML", "GraphQL",

  // Web, API and application frameworks
  "~React|react.js|reactjs|react js|react hooks",
  "React Native",
  "Angular|angularjs|angular.js",
  "Vue.js|vue|vuejs|vue js",
  "Next.js|nextjs|next js",
  "Node.js|nodejs|node js",
  "Express.js|expressjs|express js",
  "Spring Boot|springboot|spring framework|spring mvc|spring cloud",
  "Django", "Flask", "FastAPI|fast api",
  ".NET|dotnet|.net core|.net framework",
  "ASP.NET|asp.net core|asp.net mvc|aspnet",
  "Ruby on Rails|rails|ror",
  "Laravel", "jQuery", "Redux", "Tailwind CSS|tailwind|tailwindcss", "Svelte", "Webpack",
  "REST APIs|rest api|rest apis|restful|restful api|restful apis|restful services|rest services",
  "gRPC",
  "APIs|api|apis|api development|api integration|api integrations|api design|web services",
  "Microservices|microservice|micro services|microservices architecture|microservice architecture",
  "WebSockets|websocket",

  // Mobile
  "iOS", "Android", "Flutter", "SwiftUI|swift ui", "Xamarin",
  "Mobile Development|mobile app development|mobile applications|mobile apps",

  // Cloud platforms and services
  "AWS|amazon web services|aws cloud",
  "Azure|microsoft azure|azure cloud",
  "GCP|google cloud|google cloud platform",
  "Oracle Cloud|oci|oracle cloud infrastructure",
  "Cloud Computing|cloud|cloud computing|cloud platforms|cloud platform|cloud services|cloud infrastructure|cloud environments|cloud environment|public cloud|cloud technologies|cloud based|cloud native",
  "Hybrid Cloud|hybrid cloud environments|hybrid infrastructure",
  "Multi-Cloud|multicloud|multi cloud",
  "Cloud Migration|cloud migrations|migration to the cloud|migrating to the cloud|cloud adoption",
  "Cloud Security|cloud security posture|cspm",
  "Cloud Architecture|cloud architectures|cloud solution architecture",
  "Landing Zones|landing zone|azure landing zone|azure landing zones",
  "EC2|amazon ec2", "S3|amazon s3", "AWS Lambda|amazon lambda", "RDS|amazon rds", "DynamoDB",
  "CloudFormation|aws cloudformation", "CloudWatch|amazon cloudwatch",
  "VPC|vpcs|virtual private cloud", "EKS|amazon eks", "ECS|amazon ecs", "Fargate",
  "Route 53|route53", "SQS", "SNS", "Kinesis", "Aurora", "API Gateway", "CloudTrail",
  "AWS Organizations", "Control Tower",
  "Azure DevOps|vsts|azure devops services|azure boards|azure repos",
  "Azure Pipelines",
  "AKS|azure kubernetes service",
  "Azure Functions",
  "Azure Monitor|azure monitoring",
  "Azure Policy|azure policies",
  "Azure Arc",
  "Microsoft Sentinel|azure sentinel",
  "Entra ID|azure ad|azure active directory|microsoft entra|microsoft entra id|aad|entra",
  "Conditional Access|conditional access policies",
  "Azure Virtual Desktop|avd|windows virtual desktop|wvd",
  "ARM Templates|arm template|azure resource manager",
  "Bicep",
  "Azure SQL|azure sql database",
  "Cosmos DB|cosmosdb|azure cosmos db",
  "Key Vault|azure key vault",
  "Azure Firewall",
  "ExpressRoute|express route",
  "Azure Backup",
  "Azure Site Recovery|asr",
  "Defender for Cloud|microsoft defender for cloud|azure security center",
  "Microsoft Defender|defender for endpoint|microsoft defender for endpoint|mde|defender xdr|microsoft defender xdr",
  "Microsoft Purview|purview",
  "Azure Data Factory|adf|data factory",
  "Azure Synapse|synapse|synapse analytics",
  "Databricks|azure databricks",
  "Logic Apps|azure logic apps",
  "Azure OpenAI|azure openai service",
  "Power Automate|microsoft flow",
  "Power Apps|powerapps",
  "Power BI|powerbi|power bi desktop",
  "Power Platform|microsoft power platform",
  "Dynamics 365|d365|dynamics crm|microsoft dynamics",
  "SharePoint|sharepoint online|sharepoint server",
  "Exchange Online|exchange server|microsoft exchange|exchange 2016|exchange 2019",
  "Microsoft 365|m365|office 365|o365|microsoft office 365|ms 365",
  "Microsoft Teams|ms teams",
  "OneDrive|onedrive for business",
  "Intune|microsoft intune|endpoint manager|microsoft endpoint manager|mem",
  "SCCM|mecm|configuration manager|configmgr|system center configuration manager|microsoft endpoint configuration manager",
  "Windows Autopilot|autopilot",
  "Group Policy|gpo|gpos|group policies|group policy objects",
  "Active Directory|ad ds|active directory domain services",
  "Windows Server|windows servers|windows server 2016|windows server 2019|windows server 2022",
  "~Windows|windows 10|windows 11|windows os|microsoft windows|windows desktop|windows client",
  "Hyper-V|hyperv",
  "Microsoft Office|ms office|office suite|microsoft office suite",
  "~Excel|microsoft excel|ms excel|advanced excel|excel spreadsheets",
  "Visio|microsoft visio|ms visio",
  "Microsoft Project|ms project",
  "BigQuery|big query", "GKE|google kubernetes engine", "Cloud Run", "Pub/Sub|pubsub", "Dataflow",
  "Vertex AI", "Firebase", "Firestore",
  // DevOps, infrastructure as code and containers
  "Docker|docker containers|dockerfile|dockerfiles",
  "Kubernetes|k8s|kubernetes clusters",
  "Containerization|containerisation|containerized|containerised|container orchestration|container platforms|container technologies",
  "~Helm|helm charts|helm chart",
  "OpenShift|red hat openshift", "Rancher", "Istio|service mesh",
  "Terraform|terraform cloud|terraform enterprise",
  "Ansible|ansible playbooks", "Puppet", "Chef", "Pulumi", "~Packer|hashicorp packer", "Vagrant",
  "Infrastructure as Code|iac|infrastructure-as-code",
  "Configuration Management",
  "CI/CD|ci cd|cicd|ci/cd pipelines|ci/cd pipeline|continuous integration|continuous delivery|continuous deployment",
  "Jenkins", "GitHub Actions", "GitLab CI|gitlab ci/cd", "CircleCI|circle ci", "Travis CI", "TeamCity",
  "Bamboo", "Argo CD|argocd|argo",
  "Git", "GitHub|github enterprise", "GitLab", "Bitbucket", "SVN|subversion",
  "Version Control|source control|version control systems|source code management",
  "DevOps|devops practices|devops culture|devops engineering|devops principles",
  "DevSecOps",
  "Site Reliability Engineering|sre|site reliability",
  "GitOps", "Platform Engineering",
  "Release Management|release engineering|release process",
  "Automation|automate|automated|automating|process automation|it automation|workflow automation|infrastructure automation|task automation",

  // Operating systems, virtualization and platform operations
  "Linux|linux administration|linux servers|linux systems",
  "Unix|unix systems", "Ubuntu", "RHEL|red hat enterprise linux|red hat linux|redhat", "CentOS",
  "macOS|mac os|osx|os x",
  "Virtualization|virtualisation|virtual machines|vms|virtualized environments|virtualization technologies",
  "VMware|vmware vsphere|vsphere|esxi|vcenter|vmware esxi",
  "Citrix|citrix virtual apps|xenapp|xendesktop",
  "VDI|virtual desktop infrastructure|virtual desktops",
  "Nginx", "Apache HTTP Server|apache httpd|apache web server|httpd", "IIS|internet information services",
  "Load Balancing|load balancer|load balancers",
  "CDN|content delivery network|content delivery networks",
  "Serverless|serverless architecture|serverless computing",
  "Event-Driven Architecture|event driven architecture|event-driven",
  "Distributed Systems|distributed computing|distributed architecture",
  "System Design|systems design",
  "High Availability|highly available",
  "Disaster Recovery|dr planning|bcdr|disaster recovery planning",
  "Business Continuity|business continuity planning|bcp",
  "Backup and Recovery|backup and restore|backups|data backup|backup solutions|backup systems",
  "Veeam|veeam backup", "Commvault", "Rubrik", "Cohesity", "Acronis", "Veritas NetBackup|netbackup",
  "Performance Tuning|performance optimization|performance optimisation",
  "Capacity Planning|capacity management",
  "Cost Optimization|cost optimisation|cloud cost optimization|cloud cost management|cost management|cost reduction",
  "FinOps",
  "Observability|monitoring and observability|observability tools",
  "Monitoring|system monitoring|infrastructure monitoring|application monitoring|performance monitoring|monitoring tools|monitoring and alerting|alerting",
  "Logging|centralized logging|log management|log analysis|logs",
  "Prometheus", "Grafana", "Datadog", "Splunk", "New Relic|newrelic", "Dynatrace", "AppDynamics",
  "ELK Stack|elk|elastic stack|logstash|kibana",
  "Elasticsearch|elastic search|opensearch",
  "Nagios", "Zabbix", "SolarWinds", "PagerDuty", "OpenTelemetry|otel",
  "Log Analytics|azure log analytics|log analytics workspace",

  // IT service management, support and operations
  "Incident Management|incident handling|major incident management|incident resolution|incidents",
  "Incident Response|security incident response|incident response planning",
  "Problem Management",
  "Change Management|change control|change requests|change advisory board|cab",
  "Root Cause Analysis|rca|root-cause analysis|root cause",
  "Troubleshooting|troubleshoot|troubleshot|diagnose|diagnosing|diagnosed",
  "On-Call|on call|on-call rotation|24x7 support|24/7 support",
  "Runbooks|runbook|playbooks|standard operating procedures|sops|sop",
  "ITIL|itil v3|itil v4|itil 4|itil foundation|itil framework|itil processes",
  "IT Service Management|itsm|service management",
  "ServiceNow|service now|servicenow itsm",
  "Jira|atlassian jira|jira software",
  "Confluence|atlassian confluence",
  "Jira Service Management|jsm|jira service desk",
  "BMC Remedy|remedy|bmc helix",
  "Zendesk", "Freshservice|freshdesk",
  "SLA Management|sla|slas|service level agreements|service level agreement|service levels",
  "KPIs|kpi|key performance indicators|key performance indicator",
  "OKRs|okr|objectives and key results",
  "Help Desk|helpdesk|service desk|it helpdesk|it service desk",
  "IT Support|technical support|tech support|desktop support|end user support|end-user support|user support|l1 support|l2 support|level 1 support|level 2 support",
  "End User Computing|euc|end-user computing|end user devices",
  "Endpoint Management|endpoint administration|device management|unified endpoint management|uem",
  "Mobile Device Management|mdm",
  "IT Asset Management|asset management|itam|hardware asset management|software asset management|asset lifecycle|asset tracking|it assets",
  "Inventory Management|inventory control|stock management|inventory",
  "Procurement|purchasing|it procurement|procurement process",
  "Vendor Management|vendor relations|supplier management|vendor coordination|third-party management|vendor relationships|vendors|suppliers",
  "Logistics|logistics management|logistics operations|logistics coordination",
  "Supply Chain|supply chain management|supply chain operations",
  "Warehouse Management|warehousing|wms|warehouse operations",
  "Contract Management|contract negotiation|contract negotiations|contracts management|contract administration",

  // Networking
  "Networking|computer networking|network administration|network management|network infrastructure|network engineering|networks|network operations",
  "TCP/IP|tcp|udp",
  "DNS|dns management|domain name system",
  "DHCP",
  "VPN|vpns|site-to-site vpn|remote access vpn|ipsec",
  "LAN/WAN|lan|wan",
  "VLANs|vlan",
  "Routing and Switching|routing & switching|routers and switches|switches and routers|routers|switching",
  "BGP", "OSPF", "SD-WAN|sdwan",
  "Firewalls|firewall|firewall management|next-generation firewall|ngfw|firewall rules",
  "Palo Alto Networks|palo alto|panorama", "Fortinet|fortigate",
  "Cisco|cisco ios|cisco networking|cisco switches|cisco routers", "Juniper|junos", "Meraki|cisco meraki",
  "Wireless Networking|wi-fi|wifi|wlan|wireless|wireless networks",
  "Network Security|network security controls",
  "Zero Trust|zero-trust|zero trust architecture|ztna|zero trust network access",
  "SSL/TLS|ssl|tls|ssl certificates|tls certificates|certificate management",
  "PKI|public key infrastructure",
  "Wireshark|packet analysis|packet capture",
  "CCNA", "CCNP", "CCIE",
  // Security, identity and compliance
  "Cybersecurity|cyber security|information security|infosec|it security|security engineering",
  "Security Operations|secops|security operations center|soc operations|soc",
  "SIEM|security information and event management|siem tools",
  "SOAR|security orchestration automation and response",
  "EDR/XDR|edr|xdr|endpoint detection and response|extended detection and response",
  "Vulnerability Management|vulnerability assessment|vulnerability assessments|vulnerability scanning|vulnerability remediation|vulnerabilities|vulnerability",
  "Penetration Testing|pen testing|pentesting|penetration tests|pentest|ethical hacking",
  "Threat Intelligence|threat intel|cyber threat intelligence",
  "Threat Modeling|threat modelling",
  "Threat Hunting|threat detection|threat detection and response",
  "Identity and Access Management|iam|identity management|access management|identity & access management|identity governance|access control|access controls",
  "SSO|single sign-on|single sign on",
  "MFA|multi-factor authentication|multifactor authentication|2fa|two-factor authentication",
  "Privileged Access Management|pam|privileged access|privileged identity management",
  "CyberArk", "Okta", "SAML|saml 2.0", "OAuth|oauth2|oauth 2.0", "OpenID Connect|oidc",
  "RBAC|role-based access control",
  "LDAP", "Kerberos",
  "Encryption|data encryption|encryption at rest|encryption in transit",
  "Data Loss Prevention|dlp",
  "Data Privacy|data protection|privacy compliance",
  "GDPR", "HIPAA", "PCI DSS|pci|pci-dss|pci compliance",
  "SOC 2|soc2|soc 2 type ii|soc 2 type 2",
  "ISO 27001|iso/iec 27001|iso27001",
  "ISO 9001",
  "NIST|nist csf|nist 800-53|nist cybersecurity framework|nist framework",
  "CIS Benchmarks|cis controls|cis benchmark|cis",
  "SOX|sarbanes-oxley|sarbanes oxley|sox compliance",
  "FedRAMP",
  "Compliance|regulatory compliance|compliance management|it compliance|security compliance|compliance requirements|compliance frameworks",
  "Risk Management|risk assessment|risk assessments|it risk management|risk mitigation|risk analysis",
  "Governance|it governance|cloud governance|security governance",
  "GRC|governance risk and compliance|governance risk compliance",
  "IT Audit|it audits|security audit|security audits|compliance audit|compliance audits|audit|audits|auditing|audit readiness",
  "Patch Management|patching|security patching|os patching|patch deployment|patches",
  "Endpoint Security|endpoint protection|antivirus|anti-virus|anti-malware|malware protection",
  "System Hardening|hardening|server hardening|security hardening|os hardening|hardened",
  "Application Security|appsec|secure coding|secure development",
  "OWASP|owasp top 10", "SAST", "DAST",
  "Secrets Management|hashicorp vault|secret management",
  "Security Awareness|security awareness training",
  "Email Security|email filtering|proofpoint|mimecast",

  // Certifications
  "CISSP", "CISM", "CISA", "CEH|certified ethical hacker", "OSCP",
  "CompTIA Security+|security+|comptia security+|security plus|sec+",
  "CompTIA A+|a+|comptia a+|a+ certification",
  "CompTIA Network+|network+|comptia network+",
  "PMP|project management professional|pmp certification|pmp certified",
  "PRINCE2|prince 2",
  "Certified Scrum Master|scrum master certification|psm|professional scrum master",
  "CKA|certified kubernetes administrator", "CKAD|certified kubernetes application developer",
  "AWS Certification|aws certified|aws certifications|aws solutions architect|aws certified solutions architect",
  "Azure Certification|azure certified|azure certifications|microsoft certified|microsoft certification|microsoft certifications",
  "AZ-104|az104", "AZ-305|az305", "AZ-500|az500", "AZ-900|az900",
  "MCSE", "MCSA",
  "Six Sigma|lean six sigma|six sigma green belt|six sigma black belt|green belt|black belt",
  "Lean Methodology|lean manufacturing|lean principles|lean management",

  // Data, analytics and AI
  "Data Analysis|data analytics|analytics|data analyses|analyzing data|analysing data",
  "Data Science", "Data Engineering", "Data Governance", "Data Quality",
  "Data Migration|data migrations",
  "Master Data Management",
  "Data Visualization|data visualisation|dashboards|dashboard|dashboarding",
  "Data Pipelines|data pipeline|data ingestion|data workflows",
  "ETL|elt|etl pipelines|etl processes|extract transform load",
  "Data Warehousing|data warehouse|data warehouses|dwh|enterprise data warehouse",
  "Data Lake|data lakes|lakehouse|data lakehouse",
  "Data Modeling|data modelling|data models|dimensional modeling|dimensional modelling",
  "Big Data|big data technologies",
  "Databases|database|database management|database administration|dba|relational databases|rdbms",
  "MySQL", "PostgreSQL|postgres", "SQL Server|ms sql|mssql|microsoft sql server|ms sql server|t-sql|tsql",
  "Oracle Database|oracle db|oracle|oracle databases|pl/sql|plsql",
  "MongoDB|mongo", "Redis", "Cassandra|apache cassandra", "Snowflake", "Redshift|amazon redshift",
  "SQLite", "MariaDB",
  "~Spark|apache spark|pyspark|spark sql|spark streaming",
  "Hadoop|hdfs|apache hadoop|mapreduce", "~Hive|apache hive|hiveql", "Kafka|apache kafka|kafka streams",
  "Airflow|apache airflow", "dbt|data build tool", "RabbitMQ",
  "Message Queues|message queue|message queuing|message brokers",
  "Tableau", "Looker", "Qlik|qlikview|qlik sense",
  "Pandas", "NumPy", "scikit-learn|sklearn|scikit learn", "TensorFlow", "PyTorch", "Keras",
  "Machine Learning|ml|machine-learning|ml models|machine learning models",
  "Deep Learning|neural networks",
  "NLP|natural language processing",
  "Computer Vision",
  "Generative AI|genai|gen ai|generative artificial intelligence",
  "LLMs|llm|large language models|large language model",
  "Artificial Intelligence|ai",
  "Prompt Engineering",
  "RAG|retrieval augmented generation|retrieval-augmented generation|rag pipelines|rag architecture",
  "MLOps|ml ops", "LangChain", "Hugging Face|huggingface", "OpenAI API|openai",
  "Statistics|statistical analysis|statistical modeling|statistical modelling|statistical methods",
  "A/B Testing|a/b tests|experimentation",
  "SPSS", "Jupyter|jupyter notebooks",
  // Software engineering practices
  "Object-Oriented Programming|oop|object oriented programming|object-oriented design|ood|object oriented design",
  "Data Structures and Algorithms|data structures|algorithms|dsa",
  "Design Patterns|software design patterns",
  "SDLC|software development life cycle|software development lifecycle",
  "Unit Testing|unit tests|unit test",
  "Integration Testing|integration tests",
  "Test Automation|automated testing|automation testing|automated tests|test automation frameworks",
  "TDD|test-driven development",
  "BDD|behavior-driven development|behaviour driven development",
  "Quality Assurance|qa|software quality assurance|qa testing",
  "Software Testing|manual testing|functional testing|regression testing|testing",
  "Selenium", "Cypress", "Playwright", "Jest", "JUnit", "pytest", "Postman", "JMeter|load testing|performance testing",
  "Code Review|code reviews",
  "Debugging|debug",
  "Full Stack|full-stack|fullstack|full stack development",
  "Frontend|front end|front-end development|frontend development",
  "Backend|back end|back-end development|backend development",
  "Web Development|web applications|web apps|web application development",
  "Embedded Systems|embedded software",
  "Firmware", "RTOS", "IoT|internet of things", "Blockchain",
  "Multithreading|multi-threading|concurrency|concurrent programming",
  "Agile|agile methodology|agile methodologies|agile development|agile environment|agile practices|agile teams",
  "Scrum|scrum methodology|scrum framework",
  "Kanban",
  "Scaled Agile|scaled agile framework|safe agile|safe framework",
  "Waterfall",

  // Project, product and business
  "Project Management|project planning|project delivery|managing projects|project execution|project manager",
  "Program Management|programme management|program manager",
  "Product Management|product manager|product owner",
  "Roadmapping|roadmap|roadmaps|product roadmap|technology roadmap",
  "Backlog Management|backlog|product backlog|backlog grooming|backlog refinement|backlog prioritization",
  "Stakeholder Management|stakeholder engagement|stakeholder communication|managing stakeholders|stakeholders",
  "Requirements Gathering|requirements analysis|requirement gathering|gathering requirements|business requirements|requirements elicitation",
  "Business Analysis|business analyst",
  "Process Improvement|continuous improvement|process optimization|process optimisation|business process improvement|process improvements",
  "Resource Planning|resource management|resource allocation",
  "Strategic Planning|strategic plans|strategy development",
  "People Management|team management|people manager|managing teams|line management|direct reports|team lead|team leadership|team leader",
  "Recruiting|recruitment|talent acquisition|interviewing candidates",
  "Customer Success|client success",
  "Account Management|key account management|account manager",
  "Business Development|biz dev",
  "Sales|b2b sales|enterprise sales|saas sales|sales cycle",
  "Digital Marketing|online marketing|performance marketing",
  "SEO|search engine optimization", "SEM|search engine marketing|google ads|ppc",
  "Go-to-Market|gtm|go to market|go-to-market strategy",
  "Market Research|market analysis",
  "Customer Service|customer support|client support|customer care|customer-facing",
  "Client Management|client relationship management|client relationships|customer relationships|client relations",
  "Technical Documentation|documentation|technical writing|documenting|knowledge base|knowledge articles",
  "End-User Training|end user training|user training|training sessions|training delivery|train users",
  "Budgeting|budget management|budget planning|budgets|budget|budget forecasting",
  "Forecasting|demand forecasting",
  "Financial Analysis|financial reporting|financial analytics",
  "Financial Modeling|financial modelling",
  "P&L Management|p&l|profit and loss|p&l responsibility",
  "ERP|erp systems|enterprise resource planning|erp system",
  "SAP|sap erp|sap s/4hana|s/4hana|sap hana|sap mm|sap sd|sap fico",
  "Oracle ERP|oracle e-business suite|oracle ebs|oracle fusion|oracle financials",
  "NetSuite", "Salesforce|sfdc|salesforce crm|salesforce.com", "CRM|crm systems|customer relationship management|crm tools",
  "HubSpot", "~Workday|workday hcm|workday financials",
  "SaaS|software as a service", "PaaS|platform as a service", "IaaS|infrastructure as a service",
  "E-commerce|ecommerce",

  // Design
  "Figma", "Adobe XD", "Adobe Creative Suite|adobe creative cloud",
  "Photoshop|adobe photoshop", "Illustrator|adobe illustrator",
  "UX Design|ux|user experience|ux/ui|ui/ux|ux design",
  "UI Design|ui|user interface|user interfaces|ui design",
  "User Research|usability testing",
  "Wireframing|wireframes|wireframe",
  "Prototyping|prototypes|prototype",
  "Accessibility|wcag|a11y|section 508",
  "Design Systems|design system",
  "Responsive Design|responsive web design",
];

const SOFT_SKILLS: string[] = [
  "Communication|communication skills|written communication|verbal communication|communicate|communicating|communications|communicated",
  "Leadership|leadership skills|led|leading|lead|leader",
  "Collaboration|collaborate|collaborated|collaborating|collaborative|teamwork|team player|partnered|partner with",
  "Cross-Functional Collaboration|cross-functional|cross-functional teams|cross-team",
  "Problem Solving|problem-solving|problem solver|solving problems|solve problems|solve complex problems|solving complex problems",
  "Analytical Thinking|analytical|analytical skills|critical thinking|analytical mindset",
  "Attention to Detail|detail-oriented|attention to details|meticulous|detail focused",
  "Time Management|multitasking|multi-tasking|competing priorities|manage multiple priorities",
  "Mentoring|mentor|mentored|mentorship|coaching|coach|coached",
  "Presentation Skills|presentations|presenting|public speaking",
  "Negotiation|negotiate|negotiated|negotiating|negotiation skills",
  "Ownership|accountability|self-starter|self-motivated|proactive|take ownership",
  "Customer Focus|customer-focused|customer obsession|customer-centric|client-focused",
  "Interpersonal Skills|interpersonal|relationship building",
  "Adaptability|adaptable",
];

/**
 * Builds a case-sensitive matcher for a short or ambiguous name that is trusted only
 * as a list item, e.g. "Python, Go, or Rust", a line reading just "Go" (a skills array
 * or a JD bullet), but not "go live" or "React to incidents".
 */
function listItemPattern(word: string, notFollowedBy = ""): RegExp {
  const name = word.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const guard = notFollowedBy ? `(?!${notFollowedBy})` : "";
  return new RegExp(
    `(?:[,/(]|\\b(?:[Aa]nd|[Oo]r|[Ww]ith|[Uu]sing))\\s*${name}(?![\\w+#&'-])${guard}` +
      `|(?:^|[^\\w.+#&'-])${name}${guard}\\s*(?:[,/)]|\\s(?:and|or)\\b)` +
      `|^[ \\t]*(?:[-*\\u2022\\u00B7\\u25CF\\u25AA\\u25E6\\u25BA][ \\t]*)?${name}[ \\t]*[.;]?[ \\t]*$`,
    "m"
  );
}

/**
 * Raw-text, case-sensitive detectors for names that cannot be matched as plain tokens,
 * keyed by lexicon name, with the word each one looks for.
 */
const SKILL_PATTERNS: Record<string, { word: string; pattern: RegExp }> = {
  C: { word: "C", pattern: listItemPattern("C") },
  Go: { word: "Go", pattern: listItemPattern("Go") },
  R: { word: "R", pattern: listItemPattern("R") },
  Rust: { word: "Rust", pattern: listItemPattern("Rust") },
  Swift: { word: "Swift", pattern: listItemPattern("Swift") },
  Dart: { word: "Dart", pattern: listItemPattern("Dart") },
  React: { word: "React", pattern: listItemPattern("React", "\\s+Native") },
  "Node.js": { word: "Node", pattern: listItemPattern("Node") },
  "Express.js": { word: "Express", pattern: listItemPattern("Express") },
  "Spring Boot": { word: "Spring", pattern: listItemPattern("Spring") },
  "AWS Lambda": { word: "Lambda", pattern: listItemPattern("Lambda") },
  Spark: { word: "Spark", pattern: listItemPattern("Spark") },
  Hive: { word: "Hive", pattern: listItemPattern("Hive") },
  Helm: { word: "Helm", pattern: listItemPattern("Helm") },
  Packer: { word: "Packer", pattern: listItemPattern("Packer") },
  Windows: { word: "Windows", pattern: /\bWindows\b(?!\s+(?:Server|Autopilot|Virtual|Defender|Hello|Update|Admin))/ },
  Excel: { word: "Excel", pattern: /\bExcel\b/ },
  Workday: { word: "Workday", pattern: /\bWorkday\b/ },
  "Scaled Agile": { word: "SAFe", pattern: /\bSAFe\b/ },
};
/**
 * Evidence that satisfies a broader requirement: a resume listing PostgreSQL meets a
 * JD asking for SQL. Deliberately one level deep and one directional.
 */
const IMPLIED_BY: Record<string, string[]> = {
  SQL: ["MySQL", "PostgreSQL", "SQL Server", "Oracle Database", "SQLite", "MariaDB", "Azure SQL", "Snowflake", "BigQuery", "Redshift"],
  NoSQL: ["MongoDB", "Cassandra", "DynamoDB", "Cosmos DB", "Redis", "Firestore"],
  Databases: ["SQL", "NoSQL", "MySQL", "PostgreSQL", "SQL Server", "Oracle Database", "MongoDB", "Cassandra", "DynamoDB", "Cosmos DB", "Redis", "SQLite", "MariaDB", "Azure SQL"],
  "Cloud Computing": ["AWS", "Azure", "GCP", "Oracle Cloud", "Hybrid Cloud", "Multi-Cloud", "Cloud Migration", "Cloud Architecture", "Cloud Security"],
  AWS: ["EC2", "S3", "AWS Lambda", "RDS", "DynamoDB", "CloudFormation", "CloudWatch", "EKS", "ECS", "AWS Certification"],
  Azure: ["Azure DevOps", "AKS", "Azure Functions", "Azure Monitor", "Azure Policy", "Entra ID", "Azure Virtual Desktop", "ARM Templates", "Bicep", "Azure SQL", "Cosmos DB", "Key Vault", "Azure Firewall", "ExpressRoute", "Azure Backup", "Azure Site Recovery", "Defender for Cloud", "Azure Data Factory", "Azure Synapse", "Logic Apps", "Landing Zones", "Azure Certification", "AZ-104", "AZ-305", "AZ-500", "AZ-900", "Microsoft Sentinel", "Azure Arc"],
  GCP: ["BigQuery", "GKE", "Cloud Run", "Pub/Sub", "Vertex AI"],
  Kubernetes: ["AKS", "EKS", "GKE", "OpenShift"],
  Containerization: ["Docker", "Kubernetes", "AKS", "EKS", "GKE", "OpenShift"],
  "Infrastructure as Code": ["Terraform", "Bicep", "ARM Templates", "CloudFormation", "Pulumi"],
  "CI/CD": ["Jenkins", "GitHub Actions", "GitLab CI", "Azure Pipelines", "CircleCI", "Travis CI", "TeamCity", "Bamboo", "Argo CD"],
  "Version Control": ["Git", "GitHub", "GitLab", "Bitbucket", "SVN"],
  Git: ["GitHub", "GitLab", "Bitbucket"],
  Automation: ["Ansible", "Terraform", "PowerShell", "Power Automate", "Puppet", "Chef", "Infrastructure as Code", "Test Automation", "Logic Apps"],
  Scripting: ["Python", "PowerShell", "Bash", "Perl", "Ruby", "JavaScript"],
  Monitoring: ["Observability", "Prometheus", "Grafana", "Datadog", "Splunk", "New Relic", "Dynatrace", "AppDynamics", "Nagios", "Zabbix", "SolarWinds", "Azure Monitor", "CloudWatch", "Log Analytics"],
  Observability: ["Prometheus", "Grafana", "Datadog", "Splunk", "New Relic", "Dynatrace", "OpenTelemetry", "Azure Monitor", "CloudWatch", "ELK Stack"],
  Logging: ["Splunk", "ELK Stack", "Log Analytics", "CloudWatch"],
  Linux: ["Ubuntu", "RHEL", "CentOS"],
  Windows: ["Windows Server"],
  Virtualization: ["VMware", "Hyper-V", "Citrix", "VDI", "Azure Virtual Desktop"],
  "Microsoft 365": ["Exchange Online", "SharePoint", "Microsoft Teams", "OneDrive", "Intune"],
  "Microsoft Office": ["Excel", "Microsoft 365", "Visio", "Microsoft Project"],
  "Endpoint Management": ["Intune", "SCCM", "Mobile Device Management", "Windows Autopilot"],
  "Mobile Device Management": ["Intune"],
  "IT Service Management": ["ServiceNow", "ITIL", "Jira Service Management", "BMC Remedy", "Freshservice"],
  "Help Desk": ["IT Support", "ServiceNow", "Jira Service Management", "Zendesk", "Freshservice"],
  "IT Support": ["Help Desk"],
  "Identity and Access Management": ["Entra ID", "Active Directory", "Okta", "SSO", "MFA", "Conditional Access", "Privileged Access Management", "CyberArk", "RBAC", "SAML", "LDAP"],
  Networking: ["TCP/IP", "DNS", "DHCP", "VPN", "LAN/WAN", "VLANs", "Routing and Switching", "BGP", "OSPF", "SD-WAN", "Firewalls", "Cisco", "CCNA", "CCNP"],
  "Routing and Switching": ["Cisco", "Juniper", "CCNA", "CCNP", "BGP", "OSPF"],
  Firewalls: ["Palo Alto Networks", "Fortinet"],
  Cybersecurity: ["Network Security", "Cloud Security", "Security Operations", "SIEM", "Vulnerability Management", "Penetration Testing", "CISSP", "CISM", "CompTIA Security+", "Endpoint Security", "Application Security"],
  SIEM: ["Microsoft Sentinel", "Splunk"],
  Compliance: ["GDPR", "HIPAA", "PCI DSS", "SOC 2", "ISO 27001", "SOX", "FedRAMP", "NIST", "CIS Benchmarks"],
  "Disaster Recovery": ["Azure Site Recovery"],
  "Backup and Recovery": ["Azure Backup"],
  "Machine Learning": ["Deep Learning", "TensorFlow", "PyTorch", "scikit-learn", "Keras", "MLOps"],
  "Artificial Intelligence": ["Machine Learning", "Deep Learning", "Generative AI", "LLMs", "NLP", "Computer Vision"],
  "Generative AI": ["LLMs", "Prompt Engineering", "RAG", "Azure OpenAI", "OpenAI API", "LangChain"],
  "Data Visualization": ["Tableau", "Power BI", "Looker", "Qlik"],
  "Data Warehousing": ["Snowflake", "Redshift", "BigQuery", "Azure Synapse"],
  "Big Data": ["Spark", "Hadoop", "Hive", "Kafka", "Databricks"],
  APIs: ["REST APIs", "GraphQL", "gRPC", "API Gateway"],
  "Unit Testing": ["JUnit", "pytest", "Jest"],
  "Test Automation": ["Selenium", "Cypress", "Playwright"],
  "Software Testing": ["Unit Testing", "Integration Testing", "Test Automation", "Quality Assurance", "Selenium", "Cypress", "Playwright", "Jest", "JUnit", "pytest"],
  "Quality Assurance": ["Software Testing", "Test Automation"],
  Agile: ["Scrum", "Kanban", "Scaled Agile"],
  "Project Management": ["PMP", "PRINCE2", "Program Management"],
  ERP: ["SAP", "Oracle ERP", "NetSuite", "Dynamics 365", "Workday"],
  CRM: ["Salesforce", "HubSpot", "Dynamics 365"],
  Leadership: ["People Management", "Mentoring"],
  Collaboration: ["Cross-Functional Collaboration"],
};

const STOPWORDS = new Set(
  ("a an the and or but if of to in on at by for with from as is are was were be been being this that these those " +
    "it its into over under about across after before between through during within without per via than then so such " +
    "not no nor any all each every both either neither some more most other own same very can could should would may " +
    "might must will shall do does did done have has had having we you your our us they them their he she his her i me " +
    "my who whom whose which what when where why how also etc eg ie plus up out off again further once here there only " +
    "just too well go get got like one two three new").split(" ")
);

/** Common job-ad vocabulary that never counts as a requirement on its own. */
const GENERIC_WORDS =
  "ability abilities able accountable accuracy accurate achieve achieving act action actions active actively activities " +
  "activity add additional address adhere advance advanced advantage align aligned alignment already always ambiguity " +
  "analysis analyze analyse annual another anticipate applicable applicant application applications apply appropriate " +
  "approach approaches area areas articulate aspects assess assigned assist assistance assisting attend attitude available " +
  "aware awareness background balance base based basic basis become believe benefit best better beyond big bring broad " +
  "build building business call candidate candidates capabilities capability capable care career case cases center centre " +
  "certain challenge challenges challenging change changes changing check choice clear clearly client clients close closely " +
  "collect come comfortable commitment committed common company companies competitive complete completing completion " +
  "complex complexity comprehensive concept concepts conduct conducting confidence confident consider consistent " +
  "consistently contact context continue continuing continuous contribute contributing contribution contributions control " +
  "coordinate coordinating coordination core correct cost create creating creative critical culture current currently " +
  "customer customers daily data date day days deadline deadlines deal decision decisions dedicated deep deeply define " +
  "defined defining degree deliver delivered deliverables delivering delivery demand demands demonstrate demonstrated " +
  "department departments depth describe description design designing desire desired detail detailed details determine " +
  "develop developed developing development different difficult direct direction directly discuss diverse document domain " +
  "drive driven drives driving due duties duty dynamic early effective effectively efficiency efficient efficiently effort " +
  "efforts eligible emerging employee employees employer employment enable enabling encourage end energy engage engaged " +
  "engagement enhance enhancing enjoy ensure ensuring enterprise entire environment environments equal equivalent essential " +
  "establish established evaluate evaluating even everyday evolve evolving example excellence excellent exceptional " +
  "excited exciting execute executing execution existing expand expect expectations expected experience experienced " +
  "experiences expert expertise explain explore exposure extend extensive external extremely face facing factor factors " +
  "familiar familiarity fast feedback field fields find first fit flexibility flexible focus focused focusing follow " +
  "following foster foundation framework frameworks free frequently friendly full fully function functional functions " +
  "fundamental fundamentals future gain general generate give given global goal goals good great group groups grow " +
  "growing growth guidance guide guidelines hand hands handle handling happy hard help helping high higher highly hire " +
  "holistic hour hours ideal ideally ideas identify identifying impact impactful implement implementation implementing " +
  "importance important improve improvement improvements improving include includes including increase independent " +
  "independently individual individuals industry influence information initiative initiatives innovation innovative input " +
  "insight insights inspire integrity interact interest interested internal international involve involved issue issues " +
  "item items job jobs join joining journey judgment keen keep key kind know knowledge knowledgeable known large latest " +
  "learn learning least level levels leverage life line lines listen live local location locations long look looking lot " +
  "love made maintain maintaining maintenance major make making manage managed management manager managers managing " +
  "mandatory manner many market matter matters mature maximize meaningful means measurable measure meet meeting meetings " +
  "member members mentality method methods metrics mind mindset minimum mission model models modern month months " +
  "motivated move moving much multiple name nature necessary need needed needs next nice note number numbers objective " +
  "objectives obtain offer offering offers office often ongoing online open operate operating operation operational " +
  "operations opportunities opportunity optimal optimize order organization organizational organizations organisation " +
  "organised organized others outcome outcomes outside outstanding overall overview owner pace paced part participate " +
  "particular partners passion passionate past people perform performance performing period person personal perspective " +
  "phase place plan planning plans platform platforms play player please point points policies policy position positions " +
  "positive possible potential power practical practice practices prefer preferred prepare presence present prior " +
  "priorities priority proactively problem problems procedure procedures process processes produce product production " +
  "productive productivity products professional professionals proficiency proficient profile program programs progress " +
  "project projects promote proper proud proven provide provided provides providing purpose qualification qualifications " +
  "qualified quality quickly range rapidly rate reach ready real receive recognize recommend recommendations record " +
  "reduce regular regularly related relationship relationships relevant reliable reliability remote report reporting " +
  "reports represent request requests require required requirement requirements requires research resolve resolving " +
  "resource resources respect respond response responsibilities responsibility responsible result results review " +
  "reviewing reviews reward right rigor role roles routine run running safety salary scale scope second see seek seeking " +
  "self senior sense serve service services set sets setting several shape share sharing shift show significant similar " +
  "simple single site size skill skilled skills small smart solid solution solutions solve solving someone sound source " +
  "sources space specific speed stack staff stage standard standards start state status stay step steps story strategic " +
  "strategies strategy stream streamline strength strengths strive strong strongly structure structured style subject " +
  "submit success successful successfully suitable superior support supported supporting supports sure system systems " +
  "take taking talent talented task tasks team teams technical technically technique techniques technological " +
  "technologies technology term terms thinking thorough thrive time timely times today together tool tools top track " +
  "traditional transform transformation travel trends trust type types typically understand understanding unique unit " +
  "update updates use used user users using utilize valid value values variety various verbal version vision want way " +
  "ways week weekly welcome wide willing willingness work worked working works workplace world write writing written " +
  "year years yes engineer engineers engineering developer developers analyst analysts specialist specialists consultant " +
  "consultants architect architects administrator administrators officer officers coordinator coordinators director " +
  "directors executive executives associate associates intern interns technician technicians representative head " +
  "principal hybrid onsite environment window windows";

/** Capitalised tokens that look like tool names but never are. */
const TOOL_EXCLUDE = new Set(
  ("eeo eoe usa us uk eu uae hr pto ceo cto cio cfo coo cmo vp svp evp llc inc ltd plc gmbh pvt faq asap fte fyi tbd " +
    "wfh wfo hq nyc emea apac latam anz ist est pst cst mst gmt utc cet am pm jd yoe ctc lpa inr usd eur gbp dei ada " +
    "ofccp h1b opt cpt gc ok bs ba ms ma mba phd bsc msc btech mtech be me bca mca sde swe sdet ii iii iv nice plus must " +
    "note bonus job role team new key top req id no yes and or the you our we all any one per via who why how what pay " +
    "tax fy linkedin glassdoor indeed naukri youtube facebook twitter instagram whatsapp").split(" ")
);

/** Seniority and filler words ignored when matching the target job title. */
const TITLE_FILLER = new Set(
  ("senior sr junior jr lead principal staff associate assistant head chief entry mid level intern trainee " +
    "i ii iii iv v vi 1 2 3 4 l1 l2 l3 l4 of and the for in at to a an with cum remote hybrid contract contractor " +
    "full time part temporary permanent").split(" ")
);

/* ------------------------------------------------------------------ */
/* Text helpers                                                        */
/* ------------------------------------------------------------------ */

function normalizeText(text: string): string {
  return String(text || "")
    .replace(/[\u2018\u2019\u201B\u2032]/g, "'")
    .replace(/[\u201C\u201D\u2033]/g, '"')
    .replace(/[\u2010-\u2015\u2212]/g, "-")
    .replace(/\u00A0/g, " ");
}

/** Phrases never span these boundaries, so "...Azure. Data..." is not "azure data". */
const SEGMENT_SPLIT = /[\r\n;:!?|\u2022\u00B7\u25CF\u25AA\u25E6\u25BA*()[\]{}"<>]+|,\s+|\.(?:\s+|$)|\s-\s/;

function splitSegments(text: string): string[] {
  return text.split(SEGMENT_SPLIT).filter((segment) => segment.trim().length > 0);
}

/** Keeps tech tokens intact: "c++", "c#", ".net", "node.js", "asp.net", "ec2". */
const TOKEN_PATTERN = /[a-z0-9][a-z0-9+#]*(?:\.[a-z0-9][a-z0-9+#]*)*|\.[a-z][a-z0-9]*/gi;

function rawTokens(text: string): string[] {
  return text.match(TOKEN_PATTERN) || [];
}

/**
 * Light suffix stripping so "tests", "testing" and "tested" all compare equal.
 * It only has to be consistent, not linguistically correct: both the job
 * description and the resume go through the same function.
 */
function stem(token: string): string {
  if (token.length <= 3 || !/^[a-z]+$/.test(token)) return token;
  let word = token;
  if (word.endsWith("ies") && word.length > 4) word = `${word.slice(0, -3)}y`;
  else if (/(?:ss|sh|ch|x|z)es$/.test(word)) word = word.slice(0, -2);
  else if (word.endsWith("s") && !/(?:ss|us|is)$/.test(word)) word = word.slice(0, -1);

  if (word.endsWith("ing") && word.length >= 7) word = word.slice(0, -3);
  else if (word.endsWith("ed") && word.length >= 6) word = word.slice(0, -2);
  if (word.endsWith("e") && word.length >= 5) word = word.slice(0, -1);
  return word;
}

function phraseStems(text: string): string[] {
  return rawTokens(normalizeText(text)).map((token) => stem(token.toLowerCase()));
}

const GENERIC_STEMS = new Set(GENERIC_WORDS.split(/\s+/).filter(Boolean).map(stem));

/* ------------------------------------------------------------------ */
/* Lexicon index                                                       */
/* ------------------------------------------------------------------ */

interface LexiconEntry {
  name: string;
  soft: boolean;
  /** Stemmed token sequences joined by single spaces. */
  phrases: string[];
  patterns: RegExp[];
  /** Stemmed trigger word of a SKILL_PATTERNS detector, e.g. "react". */
  patternWord?: string;
}

interface Lexicon {
  byName: Map<string, LexiconEntry>;
  phraseIndex: Map<string, LexiconEntry>;
  patternEntries: LexiconEntry[];
  /** Words that already name a skill, so they never become generic "domain terms". */
  skillWordStems: Set<string>;
  maxPhraseLength: number;
}

let lexiconCache: Lexicon | null = null;

function getLexicon(): Lexicon {
  if (lexiconCache) return lexiconCache;

  const byName = new Map<string, LexiconEntry>();
  const phraseIndex = new Map<string, LexiconEntry>();
  const skillWordStems = new Set<string>();
  let maxPhraseLength = 1;

  const register = (spec: string, soft: boolean) => {
    const parts = spec.split("|");
    const patternOnly = parts[0].startsWith("~");
    const name = patternOnly ? parts[0].slice(1) : parts[0];
    const entry: LexiconEntry = { name, soft, phrases: [], patterns: [] };
    const aliases = patternOnly ? parts.slice(1) : parts;

    for (const alias of aliases) {
      const stems = phraseStems(alias);
      if (stems.length === 0) continue;
      const phrase = stems.join(" ");
      if (!entry.phrases.includes(phrase)) entry.phrases.push(phrase);
      if (!phraseIndex.has(phrase)) phraseIndex.set(phrase, entry);
      if (stems.length === 1) skillWordStems.add(phrase);
      maxPhraseLength = Math.max(maxPhraseLength, stems.length);
    }
    byName.set(name, entry);
  };

  HARD_SKILLS.forEach((spec) => register(spec, false));
  SOFT_SKILLS.forEach((spec) => register(spec, true));

  const patternEntries: LexiconEntry[] = [];
  for (const [name, { word, pattern }] of Object.entries(SKILL_PATTERNS)) {
    const entry = byName.get(name);
    if (!entry) continue;
    entry.patterns.push(pattern);
    entry.patternWord = stem(word.toLowerCase());
    skillWordStems.add(entry.patternWord);
    patternEntries.push(entry);
  }

  lexiconCache = { byName, phraseIndex, patternEntries, skillWordStems, maxPhraseLength };
  return lexiconCache;
}

/* ------------------------------------------------------------------ */
/* Job description analysis                                            */
/* ------------------------------------------------------------------ */

interface JdSentence {
  text: string;
  /** Heading the sentence was written under on the same line, e.g. "Experience" in "Experience: 5+ years". */
  label: string;
  mult: number;
  preferred: boolean;
}

// Distinctive headings count even in sentence case; generic ones need a colon or Title Case.
const STRONG_HEADERS: Array<[SectionKind, RegExp]> = [
  ["preferred", /\b(preferred|nice[\s-]to[\s-]haves?|good[\s-]to[\s-]haves?|bonus points?|pluses|desired (skills|qualifications|experience))\b/i],
  ["boilerplate", /\b(about us|who we are|benefits|perks|compensation|salary|what we offer|why join|equal (employment )?opportunit|eeo|our (culture|values|mission|story)|life at|how to apply)\b/i],
  ["required", /\b(requirements?|qualifications?|must[\s-]haves?|what you('ll| will)? (need|bring)|who you are|what we('re| are) looking for|about you|your profile)\b/i],
  ["duties", /\b(responsibilit(y|ies)|what you('ll| will) do|duties|day[\s-]to[\s-]day|key accountabilities|in this role|the role|about the (role|job|position))\b/i],
];

const WEAK_HEADERS: Array<[SectionKind, RegExp]> = [
  ["boilerplate", /^(location|diversity|inclusion|privacy|disclaimer|job type|schedule|about (?!the (role|job|position|team)\b|you\b)\w+)/i],
  ["required", /\b(skills|experience|knowledge|competenc(y|ies)|essential|you have|ideal candidate)\b/i],
  ["duties", /\b(overview|job description|job summary|position summary|the opportunity|your impact)\b/i],
];

const SMALL_WORDS = new Set("a an the and or of to for in on at with you we our your".split(" "));
const BULLET_PREFIX = /^\s*(?:[-*\u2022\u00B7\u25CF\u25AA\u25E6\u25BAo]|\d+[.)])\s+/;
/** Words that may accompany a generic heading word: "Technical Skills", "Years of Experience". */
const HEADER_MODIFIERS = new Set(
  ("technical key core required desired desirable additional professional relevant job role essential minimum " +
    "basic other soft hard general specific preferred skills skill experience knowledge qualifications " +
    "requirements years total work industry").split(" ")
);

function isTitleCase(text: string): boolean {
  const words = text.split(/\s+/).filter((word) => /[a-z]/i.test(word));
  return words.length > 0 && words.every((word) => /^[A-Z0-9]/.test(word) || SMALL_WORDS.has(word.toLowerCase()));
}

function leftoverWords(text: string, matched: string): string[] {
  return text
    .replace(matched, " ")
    .split(/\s+/)
    .filter((word) => /[a-z]/i.test(word) && !SMALL_WORDS.has(word.toLowerCase()));
}

/**
 * A heading is essentially just the heading phrase. Copied web JDs lose their bullet
 * glyphs, so list items such as "Operate our mission-critical platform" or "Bachelor's
 * degree preferred" merely contain such a phrase and must not switch the section.
 */
function classifyHeader(line: string, hasColon: boolean): SectionKind | null {
  if (BULLET_PREFIX.test(line)) return null;
  const text = line.replace(/^[#*_\s]+|[#*_:\s]+$/g, "");
  if (!text || text.length > 60 || /[.!]$/.test(text) || text.split(/\s+/).length > 7) return null;

  for (const [kind, pattern] of STRONG_HEADERS) {
    const match = text.match(pattern);
    if (match && leftoverWords(text, match[0]).length <= (hasColon ? 3 : 1)) return kind;
  }
  if (!hasColon && !isTitleCase(text)) return null;
  for (const [kind, pattern] of WEAK_HEADERS) {
    const match = text.match(pattern);
    if (match && leftoverWords(text, match[0]).every((word) => HEADER_MODIFIERS.has(word.toLowerCase()))) {
      return kind;
    }
  }
  return null;
}

const BOILERPLATE_SENTENCE =
  /\b(equal (employment )?opportunity|eeo\b|affirmative action|regardless of (race|color|religion|gender|sex|age)|reasonable accommodation|veteran status|sexual orientation|benefits (include|package)|we offer|our benefits|401\s?\(?k\)?|paid time off|health insurance|salary range|pay range|base pay|compensation (range|package)|visa sponsorship|privacy (policy|notice)|background check|drug (test|screen)|e-verify|recruitment agenc|unsolicited resume)/i;
const PREFERRED_CUE =
  /\b(preferred|preferably|nice[\s-]to[\s-]have|a plus|bonus|desirable|desired|ideally|good[\s-]to[\s-]have|advantageous|an advantage|optional)\b/i;
const REQUIRED_CUE = /\b(required|must|mandatory|minimum|at least|essential|requires?|necessary)\b/i;

/**
 * Splits the JD into sentences tagged with how strongly each one states a requirement.
 * Boilerplate (benefits, EEO, "about us") is dropped entirely.
 */
function analyseJobDescription(jobDescription: string): JdSentence[] {
  const sentences: JdSentence[] = [];
  let section: SectionKind = "general";

  for (const rawLine of normalizeText(jobDescription).split(/\r?\n/)) {
    let line = rawLine.trim();
    if (!line) continue;

    let lineSection = section;
    let label = "";
    const colon = line.indexOf(":");
    const labelKind = colon > 0 && colon <= 40 ? classifyHeader(line.slice(0, colon), true) : null;
    const labelValue = labelKind ? line.slice(colon + 1).trim() : "";
    if (labelKind && labelValue) {
      // "Location: Remote" or "Requirements: 5+ years ..." - the label covers this line only.
      lineSection = labelKind;
      label = line.slice(0, colon).trim();
      line = labelValue;
    } else {
      const header = classifyHeader(line, line.endsWith(":"));
      if (header) section = lineSection = header;
    }
    if (lineSection === "boilerplate") continue;

    const parts = line.replace(/([.!?])\s+(?=[A-Z0-9])/g, "$1\n").split("\n");
    for (const text of parts) {
      if (!text.trim() || BOILERPLATE_SENTENCE.test(text)) continue;
      const preferredCue = PREFERRED_CUE.test(text);
      const requiredCue = REQUIRED_CUE.test(text);
      let kind: SectionKind = lineSection;
      if (preferredCue && !requiredCue) kind = "preferred";
      else if (requiredCue && !preferredCue) kind = "required";
      sentences.push({ text, label, mult: SECTION_MULTIPLIER[kind], preferred: kind === "preferred" });
    }
  }
  return sentences;
}

interface Requirement {
  key: string;
  label: string;
  kind: RequirementKind;
  entry?: LexiconEntry;
  /** Stemmed token for tool/term requirements. */
  token?: string;
  count: number;
  mult: number;
  order: number;
}

const TOOL_SHAPES = [
  /^[A-Z][a-z0-9]+(?:[A-Z][a-z0-9]*)+$/, // PascalCase: ServiceNow, PagerDuty
  /^[a-z]+[A-Z][A-Za-z0-9]*$/, // camelCase: iOS, macOS
  /^[A-Z]{3,6}\d{0,3}s?$/, // acronyms: SIEM, ITSM
  /^[A-Za-z]{2,6}\d{1,4}[A-Za-z]{0,3}$/, // alphanumeric: EC2, IPv6, HL7
  /^[A-Za-z0-9]+\.(?:js|net|io|ai|py)$/i, // dotted: D3.js, Socket.io
  /^[A-Za-z]+[+#]+$/, // F#
];

function isShouting(text: string): boolean {
  const letters = text.replace(/[^A-Za-z]/g, "");
  return letters.length >= 8 && letters.replace(/[^A-Z]/g, "").length / letters.length > 0.7;
}

function requirementWeight(req: Requirement): number {
  return KIND_FACTOR[req.kind] * req.mult * (1 + 0.25 * Math.min(req.count - 1, 2));
}

function extractRequirements(sentences: JdSentence[], lexicon: Lexicon, excluded: Set<string>): Requirement[] {
  const requirements = new Map<string, Requirement>();
  const terms = new Map<string, Requirement>();
  let order = 0;

  // Each requirement counts at most once per sentence, so frequency means "mentioned in N places".
  const record = (
    target: Map<string, Requirement>,
    seen: Set<string>,
    key: string,
    mult: number,
    create: () => Pick<Requirement, "label" | "kind" | "entry" | "token">
  ) => {
    if (seen.has(key)) return;
    seen.add(key);
    const existing = target.get(key);
    if (existing) {
      existing.count += 1;
      existing.mult = Math.max(existing.mult, mult);
    } else {
      target.set(key, { key, ...create(), count: 1, mult, order: order++ });
    }
  };

  for (const sentence of sentences) {
    const seen = new Set<string>();
    const addEntry = (entry: LexiconEntry) =>
      record(requirements, seen, `lex:${entry.name}`, sentence.mult, () => ({
        label: entry.name,
        kind: entry.soft ? "soft" : "skill",
        entry,
      }));

    for (const entry of lexicon.patternEntries) {
      if (entry.patternWord && excluded.has(entry.patternWord)) continue;
      if (entry.patterns.some((pattern) => pattern.test(sentence.text))) addEntry(entry);
    }

    const shouting = isShouting(sentence.text);
    for (const segment of splitSegments(sentence.text)) {
      const raw = rawTokens(segment);
      const lower = raw.map((token) => token.toLowerCase());
      const stems = lower.map(stem);
      const consumed: boolean[] = new Array(stems.length).fill(false);

      // Greedy longest match, so "Azure DevOps" is one requirement rather than "Azure" + "DevOps".
      for (let i = 0; i < stems.length; ) {
        let length = 0;
        for (let n = Math.min(lexicon.maxPhraseLength, stems.length - i); n >= 1; n--) {
          const span = stems.slice(i, i + n);
          const entry = lexicon.phraseIndex.get(span.join(" "));
          if (entry) {
            // The employer's own name ("Datadog is hiring...") is not a skill requirement.
            if (!span.every((token) => excluded.has(token))) addEntry(entry);
            length = n;
            break;
          }
        }
        if (length > 0) {
          consumed.fill(true, i, i + length);
          i += length;
        } else {
          i += 1;
        }
      }

      for (let i = 0; i < stems.length; i++) {
        const token = stems[i];
        if (consumed[i] || excluded.has(token) || STOPWORDS.has(lower[i]) || GENERIC_STEMS.has(token)) continue;

        if (!shouting && TOOL_SHAPES.some((shape) => shape.test(raw[i])) && !TOOL_EXCLUDE.has(lower[i])) {
          record(requirements, seen, `tool:${token}`, sentence.mult, () => ({ label: raw[i], kind: "tool", token }));
        } else if (/^[a-z]{4,}$/.test(token) && !lexicon.skillWordStems.has(token)) {
          record(terms, seen, `term:${token}`, sentence.mult, () => ({ label: lower[i], kind: "term", token }));
        }
      }
    }
  }

  // Domain words the lexicon does not know only count once the JD repeats them.
  const repeated = [...terms.values()]
    .filter((term) => term.count >= MIN_TERM_OCCURRENCES)
    .sort((a, b) => b.count - a.count || a.order - b.order)
    .slice(0, MAX_TERM_REQUIREMENTS);
  for (const term of repeated) requirements.set(term.key, term);

  return [...requirements.values()];
}

/* ------------------------------------------------------------------ */
/* Resume side                                                         */
/* ------------------------------------------------------------------ */

interface ResumeDocument {
  /** All resume content, one field per line. */
  text: string;
  /** Text fragments that carry role date ranges. */
  durations: string[];
  /** Education content only. */
  education: string;
}

/**
 * Only real resume sections are scored. Optimizer output also carries analysis fields
 * such as keyword_gap and ats_keywords_from_jd, which list JD keywords verbatim and
 * would otherwise inflate the score.
 */
const RESUME_SECTION_KEYS = [
  "personal_info", "headline", "title", "summary", "objective", "skills", "technical_skills",
  "core_competencies", "experience", "work_experience", "early_career", "projects", "education",
  "certifications", "awards", "achievements", "publications", "languages", "volunteer", "training", "courses",
];
const SKILL_SECTION_KEYS = new Set(["skills", "technical_skills", "core_competencies"]);
const SKIPPED_FIELDS = new Set([
  "id", "email", "phone", "linkedin", "linkedinText", "url", "link", "website",
  "isOptional", "isActive", "bullet_budget", "tenure_months",
]);
const EDUCATION_LINE =
  /(university|college|institute|school|academy|degree|bachelor|master|diploma|graduat|b\.?\s?tech|m\.?\s?tech|\bmba\b|ph\.?\s?d)/i;

function collectStrings(value: unknown, out: string[], depth = 0): void {
  if (value === null || value === undefined || depth > 8) return;
  if (typeof value === "string") {
    if (value.trim()) out.push(value);
    return;
  }
  if (Array.isArray(value)) {
    for (const item of value) collectStrings(item, out, depth + 1);
    return;
  }
  if (typeof value === "object") {
    for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
      if (!SKIPPED_FIELDS.has(key) && !key.startsWith("_")) collectStrings(child, out, depth + 1);
    }
  }
}

function parseResumeInput(resume: unknown): { value: unknown; trailingText: string } {
  if (typeof resume !== "string") return { value: resume, trailingText: "" };
  const trimmed = resume.trim();
  if (!trimmed.startsWith("{")) return { value: resume, trailingText: "" };
  try {
    return { value: JSON.parse(trimmed), trailingText: "" };
  } catch {
    // "Add missing skills" appends plain text after a JSON master resume.
    const end = trimmed.lastIndexOf("}");
    try {
      return { value: JSON.parse(trimmed.slice(0, end + 1)), trailingText: trimmed.slice(end + 1) };
    } catch {
      return { value: resume, trailingText: "" };
    }
  }
}

function roleDuration(role: unknown): string {
  if (typeof role === "string") return role;
  if (!role || typeof role !== "object") return "";
  const r = role as Record<string, unknown>;
  const direct = r.duration || r.dates || r.period || r.date;
  if (typeof direct === "string") return direct;
  const start = r.start_date || r.startDate;
  const end = r.end_date || r.endDate;
  return typeof start === "string" ? `${start} - ${typeof end === "string" ? end : "Present"}` : "";
}

function buildResumeDocument(resume: unknown): ResumeDocument {
  const { value, trailingText } = parseResumeInput(resume);

  if (typeof value === "string") {
    const text = normalizeText(value);
    const lines = text.split(/\r?\n/);
    return {
      text,
      durations: lines.filter((line) => !EDUCATION_LINE.test(line)),
      education: lines.filter((line) => EDUCATION_LINE.test(line)).join("\n"),
    };
  }
  if (!value || typeof value !== "object") return { text: "", durations: [], education: "" };

  const record = value as Record<string, unknown>;
  const parts: string[] = [];
  const sections = RESUME_SECTION_KEYS.filter((key) => record[key] !== undefined && record[key] !== null);
  if (sections.length > 0) {
    for (const key of sections) {
      const section = record[key];
      // Skill category names ("Cloud Infrastructure") are printed on the resume too.
      if (SKILL_SECTION_KEYS.has(key) && section && typeof section === "object" && !Array.isArray(section)) {
        parts.push(...Object.keys(section as Record<string, unknown>));
      }
      collectStrings(section, parts);
    }
  } else {
    collectStrings(record, parts);
  }
  if (trailingText.trim()) parts.push(trailingText);

  const roles = [record.experience, record.work_experience].find(Array.isArray) as unknown[] | undefined;
  const durations = (roles || []).map(roleDuration).filter(Boolean);
  if (Array.isArray(record.early_career)) {
    durations.push(...record.early_career.filter((item): item is string => typeof item === "string"));
  }
  const education: string[] = [];
  collectStrings(record.education, education);

  return {
    text: normalizeText(parts.join("\n")),
    durations: durations.map(normalizeText),
    education: normalizeText(education.join("\n")),
  };
}

interface ResumeIndex {
  grams: Set<string>;
  raw: string;
  presence: Map<LexiconEntry, boolean>;
}

function buildResumeIndex(text: string, maxLength: number): ResumeIndex {
  const grams = new Set<string>();
  for (const segment of splitSegments(text)) {
    const stems = rawTokens(segment).map((token) => stem(token.toLowerCase()));
    for (let i = 0; i < stems.length; i++) {
      let phrase = "";
      for (let n = 0; n < maxLength && i + n < stems.length; n++) {
        phrase = n === 0 ? stems[i] : `${phrase} ${stems[i + n]}`;
        grams.add(phrase);
      }
    }
  }
  return { grams, raw: text, presence: new Map() };
}

function entryPresent(entry: LexiconEntry, index: ResumeIndex): boolean {
  let present = index.presence.get(entry);
  if (present === undefined) {
    present =
      entry.phrases.some((phrase) => index.grams.has(phrase)) ||
      entry.patterns.some((pattern) => pattern.test(index.raw));
    index.presence.set(entry, present);
  }
  return present;
}

function requirementMet(req: Requirement, index: ResumeIndex, lexicon: Lexicon): boolean {
  if (!req.entry) return !!req.token && index.grams.has(req.token);
  if (entryPresent(req.entry, index)) return true;
  return (IMPLIED_BY[req.entry.name] || []).some((name) => {
    const evidence = lexicon.byName.get(name);
    return !!evidence && entryPresent(evidence, index);
  });
}

/* ------------------------------------------------------------------ */
/* Title, experience and education                                     */
/* ------------------------------------------------------------------ */

type ComponentResult = { score: number; detail: string } | null;

function scoreTitle(targetRole: string | undefined, index: ResumeIndex): ComponentResult {
  const title = normalizeText(targetRole || "").replace(/\(.*?\)/g, " ").split(/\s[-|]\s|,|\|/)[0].trim();
  if (!title || /^professional candidate$/i.test(title)) return null;

  const tokens = rawTokens(title).map((token) => token.toLowerCase());
  const core = tokens.filter((token) => !TITLE_FILLER.has(token)).map(stem);
  if (core.length === 0) return null;

  if (index.grams.has(tokens.map(stem).join(" ")) || index.grams.has(core.join(" "))) {
    return { score: 100, detail: `"${title}" appears in the resume` };
  }
  const found = core.filter((token) => index.grams.has(token)).length;
  return { score: (70 * found) / core.length, detail: `${found} of ${core.length} title words found` };
}

const NUMBER_WORDS: Record<string, string> = {
  one: "1", two: "2", three: "3", four: "4", five: "5", six: "6", seven: "7", eight: "8",
  nine: "9", ten: "10", eleven: "11", twelve: "12", fifteen: "15", twenty: "20",
};
const YEARS_PATTERNS = [
  /(\d{1,2})\s*\+?\s*(?:(?:-|to)\s*\d{1,2}\s*\+?\s*)?(?:years?|yrs?)'?\s*(?:\+\s*)?(?:of|in|experience|exp|working|hands-on|hands on|relevant|related|professional|industry|progressive|proven|direct|technical|practical|overall|total)\b/gi,
  /\b(?:experience|exp)\b[^.;]{0,40}?\b(\d{1,2})\s*\+?\s*(?:(?:-|to)\s*\d{1,2}\s*\+?\s*)?(?:years?|yrs?)\b/gi,
  /\b(?:minimum|min|at least|over|more than)\s*(?:of\s*)?(\d{1,2})\s*\+?\s*(?:years?|yrs?)\b/gi,
];
const COMPANY_HISTORY = /\b(founded|in business|our (company|firm|history)|we have been|has been (serving|operating)|history)\b/i;
/** Age limits ("at least 18 years of age") are not experience requirements. */
const AGE_LIMIT = /\b\d{1,2}\s*\+?\s*(?:years?|yrs?)\s*(?:of\s+age|old|or\s+older)\b/g;

function requiredYears(sentences: JdSentence[]): number | null {
  let required: number | null = null;
  for (const sentence of sentences) {
    if (sentence.preferred || COMPANY_HISTORY.test(sentence.text)) continue;
    const text = `${sentence.label ? `${sentence.label}: ` : ""}${sentence.text}`
      .toLowerCase()
      .replace(/\b(one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|fifteen|twenty)\b/g, (word) => NUMBER_WORDS[word])
      .replace(AGE_LIMIT, " ");

    const found: number[] = [];
    for (const pattern of YEARS_PATTERNS) {
      for (const match of text.matchAll(pattern)) found.push(parseInt(match[1], 10));
    }
    // "Years of Experience: 8+" puts the bare number after the label.
    if (/\b(experience|exp)\b/i.test(sentence.label)) {
      const lead = sentence.text.match(/^\s*(\d{1,2})\s*(?:\+|-|to\b|years?\b|yrs?\b|$)/i);
      if (lead) found.push(parseInt(lead[1], 10));
    }
    for (const years of found) {
      if (years >= 1 && years <= 25) required = required === null ? years : Math.max(required, years);
    }
  }
  return required;
}

const MONTHS: Record<string, number> = {
  jan: 0, feb: 1, mar: 2, apr: 3, may: 4, jun: 5, jul: 6, aug: 7, sep: 8, oct: 9, nov: 10, dec: 11,
};
const DATE_SOURCE =
  "(?:(?:jan|feb|mar|apr|may|jun|jul|aug|sep|sept|oct|nov|dec)[a-z]*\\.?,?\\s*(?:19|20)\\d{2}|\\d{1,2}[/.-](?:19|20)\\d{2}|(?:19|20)\\d{2})";
const DATE_RANGE = new RegExp(
  `(${DATE_SOURCE})\\s*(?:-|to|until|till|through)\\s*(${DATE_SOURCE}|present|current|now|till date|to date|today|ongoing|date)`,
  "gi"
);

function monthIndex(value: string, isEnd: boolean, now: Date): number | null {
  const text = value.toLowerCase().trim();
  if (/^(present|current|now|till date|to date|today|ongoing|date)$/.test(text)) {
    return now.getFullYear() * 12 + now.getMonth();
  }
  let match = text.match(/^([a-z]{3,9})\.?,?\s*((?:19|20)\d{2})$/);
  if (match && MONTHS[match[1].slice(0, 3)] !== undefined) return Number(match[2]) * 12 + MONTHS[match[1].slice(0, 3)];
  match = text.match(/^(\d{1,2})[/.-]((?:19|20)\d{2})$/);
  if (match && Number(match[1]) >= 1 && Number(match[1]) <= 12) return Number(match[2]) * 12 + Number(match[1]) - 1;
  match = text.match(/^((?:19|20)\d{2})$/);
  if (match) return Number(match[1]) * 12 + (isEnd ? 11 : 0);
  return null;
}

/** Total years covered by the role date ranges. Overlapping roles are counted once. */
function experienceYears(durations: string[], now: Date): number | null {
  const current = now.getFullYear() * 12 + now.getMonth();
  const intervals: Array<[number, number]> = [];
  for (const duration of durations) {
    for (const match of duration.matchAll(DATE_RANGE)) {
      const start = monthIndex(match[1], false, now);
      const end = monthIndex(match[2], true, now);
      if (start === null || end === null) continue;
      const cappedEnd = Math.min(end, current);
      if (cappedEnd >= start) intervals.push([start, cappedEnd]);
    }
  }
  if (intervals.length === 0) return null;

  intervals.sort((a, b) => a[0] - b[0]);
  let months = 0;
  let [spanStart, spanEnd] = intervals[0];
  for (const [start, end] of intervals.slice(1)) {
    if (start <= spanEnd + 1) {
      spanEnd = Math.max(spanEnd, end);
    } else {
      months += spanEnd - spanStart + 1;
      [spanStart, spanEnd] = [start, end];
    }
  }
  months += spanEnd - spanStart + 1;
  return months / 12;
}

function scoreExperience(sentences: JdSentence[], resume: ResumeDocument, now: Date): ComponentResult {
  const required = requiredYears(sentences);
  if (required === null) return null;
  const actual = experienceYears(resume.durations, now);
  // Unparseable dates are a gap in our reading, not evidence of no experience.
  if (actual === null) return null;
  const rounded = Math.round(actual * 10) / 10;
  return { score: Math.min(1, actual / required) * 100, detail: `${rounded} yrs vs ${required}+ required` };
}

// Abbreviations without dots ("MS", "BE") are only trusted in a degree context.
const JD_DEGREE_PATTERNS: Array<[number, RegExp]> = [
  [4, /(?:^|[^a-z])(?:ph\.?\s?d|doctorate|doctoral degree)(?![a-z])/i],
  [3, /(?:^|[^a-z])(?:master'?s|masters|mba|m\.?\s?tech|msc|m\.sc|m\.s\.|postgraduate|graduate degree)(?![a-z])/i],
  [3, /(?:^|[^A-Za-z])(?:MS|MA)(?=\s*(?:\/|or\b|in\b|degree\b))/],
  [2, /(?:^|[^a-z])(?:bachelor'?s?|bachelors|undergraduate degree|b\.?\s?tech|bsc|b\.sc|b\.s\.|b\.e\.|b\.a\.|(?:4|four)[\s-]year (?:college |university )?degree|college degree|university degree)(?![a-z])/i],
  // "Graduate with 3+ years" - common shorthand for a bachelor's degree.
  [2, /(?:^|[^a-z])graduate(?![a-z]|\s+degree)/i],
  [2, /(?:^|[^A-Za-z])(?:BS|BA|BE)(?=\s*(?:\/|or\b|in\b|degree\b))/],
  [1, /(?:^|[^a-z])(?:associate'?s? degree|diploma|high school|ged)(?![a-z])/i],
];
const GENERIC_DEGREE =
  /(?:^|[^a-z])(?:a|any|relevant|related|technical|university|college|engineering|science)\s+degree(?![a-z])|(?:^|[^a-z-])degree\s+(?:in|from)(?![a-z])/i;
const EQUIVALENT_CUE =
  /\b(or equivalent|equivalent (practical |work |professional )?experience|or relevant experience|or related experience|in lieu of|equivalent combination)\b/i;

const RESUME_DEGREE_PATTERNS: Array<[number, RegExp]> = [
  [4, /(?:^|[^a-z])(?:ph\.?\s?d|doctorate|doctor of philosophy)(?![a-z])/i],
  [3, /(?:^|[^a-z])(?:master'?s?|masters|mba|m\.?\s?tech|msc|m\.sc|m\.s\.|mca|m\.?\s?com|m\.e\.|post[\s-]?graduate|pgdm)(?![a-z])/i],
  [3, /(?:^|[^A-Za-z])(?:MS|MA|ME|MSc|MBA|MCA|MTech|MCom)(?![A-Za-z])/],
  [2, /(?:^|[^a-z])(?:bachelor'?s?|bachelors|b\.?\s?tech|bsc|b\.sc|b\.s\.|b\.e\.|bca|bba|b\.?\s?com|b\.a\.|undergraduate|graduate)(?![a-z])/i],
  [2, /(?:^|[^A-Za-z])(?:BS|BA|BE|BSc|BCA|BBA|BTech|BCom)(?![A-Za-z])/],
  [1, /(?:^|[^a-z])(?:associate'?s? degree|diploma|high school|secondary school|hsc|ssc|intermediate)(?![a-z])/i],
];

function requiredDegree(sentences: JdSentence[]): { level: number; equivalentAllowed: boolean } | null {
  let level: number | null = null;
  let equivalentAllowed = false;
  for (const sentence of sentences) {
    // "Post Graduate" is a master's-level qualification, not a bachelor's "graduate".
    const text = sentence.text.replace(/post[\s-]+graduate/gi, "postgraduate");
    const explicit = JD_DEGREE_PATTERNS.filter(([, pattern]) => pattern.test(text)).map(([lvl]) => lvl);
    const sentenceLevel = explicit.length > 0 ? Math.min(...explicit) : GENERIC_DEGREE.test(text) ? 2 : null;
    if (sentenceLevel === null) continue;
    if (EQUIVALENT_CUE.test(text)) equivalentAllowed = true;
    // A degree that is only "preferred" is not a requirement.
    if (sentence.preferred) continue;
    level = level === null ? sentenceLevel : Math.min(level, sentenceLevel);
  }
  return level === null ? null : { level, equivalentAllowed };
}

function scoreEducation(sentences: JdSentence[], resume: ResumeDocument): ComponentResult {
  const requirement = requiredDegree(sentences);
  if (!requirement) return null;

  const found = RESUME_DEGREE_PATTERNS.filter(([, pattern]) => pattern.test(resume.education)).map(([lvl]) => lvl);
  const level = found.length > 0 ? Math.max(...found) : 0;
  const { level: needed, equivalentAllowed } = requirement;

  let score: number;
  if (level >= needed) score = 100;
  // No recognisable degree name: uncertain if education is listed, otherwise absent.
  else if (level === 0) score = resume.education.trim() ? 50 : equivalentAllowed ? 40 : 0;
  else if (level === needed - 1) score = equivalentAllowed ? 60 : 40;
  else score = equivalentAllowed ? 40 : 20;

  return { score, detail: `${DEGREE_NAMES[needed]} required, ${level > 0 ? DEGREE_NAMES[level] : "no degree"} found` };
}

/* ------------------------------------------------------------------ */
/* Public API                                                          */
/* ------------------------------------------------------------------ */

/**
 * Scores how well a resume matches a job description, 0-100.
 *
 * `resume` may be raw resume text, a JSON string (e.g. a master resume) or a parsed
 * resume/optimizer-output object. Returns null when there is nothing to score against.
 */
export function computeMatchScore(
  resume: unknown,
  jobDescription: string,
  options: MatchScoreOptions = {}
): MatchScoreResult | null {
  if (typeof jobDescription !== "string" || !jobDescription.trim()) return null;
  const document = buildResumeDocument(resume);
  if (!document.text.trim()) return null;

  const lexicon = getLexicon();
  const sentences = analyseJobDescription(jobDescription);
  const index = buildResumeIndex(document.text, Math.max(lexicon.maxPhraseLength, 8));
  const excluded = new Set(phraseStems(options.companyName || ""));

  const requirements = extractRequirements(sentences, lexicon, excluded);
  const matched: Requirement[] = [];
  const missing: Requirement[] = [];
  let totalWeight = 0;
  let matchedWeight = 0;
  for (const req of requirements) {
    const weight = requirementWeight(req);
    totalWeight += weight;
    if (requirementMet(req, index, lexicon)) {
      matched.push(req);
      matchedWeight += weight;
    } else {
      missing.push(req);
    }
  }
  const byImportance = (a: Requirement, b: Requirement) =>
    requirementWeight(b) - requirementWeight(a) || a.order - b.order;
  matched.sort(byImportance);
  missing.sort(byImportance);

  const results: Array<[MatchComponentId, ComponentResult]> = [
    [
      "keywords",
      requirements.length > 0
        ? { score: (100 * matchedWeight) / totalWeight, detail: `${matched.length} of ${requirements.length} found` }
        : null,
    ],
    ["title", scoreTitle(options.targetRole, index)],
    ["experience", scoreExperience(sentences, document, options.now || new Date())],
    ["education", scoreEducation(sentences, document)],
  ];
  const present = results.filter((entry): entry is [MatchComponentId, { score: number; detail: string }] => entry[1] !== null);
  if (present.length === 0) return null;

  const weightSum = present.reduce((sum, [id]) => sum + COMPONENT_WEIGHTS[id], 0);
  let score = 0;
  const components: MatchComponent[] = present.map(([id, result]) => {
    const weight = COMPONENT_WEIGHTS[id] / weightSum;
    score += result.score * weight;
    return {
      id,
      label: COMPONENT_LABELS[id],
      score: Math.round(result.score),
      weight: Math.round(weight * 100) / 100,
      detail: result.detail,
    };
  });

  return {
    score: Math.round(score),
    components,
    matchedKeywords: matched.map((req) => req.label),
    missingKeywords: missing.map((req) => req.label),
    totalKeywords: requirements.length,
  };
}

/** One line per component, e.g. for a tooltip explaining where the score came from. */
export function describeMatchScore(result: MatchScoreResult): string {
  return result.components
    .map((c) => `${c.label}: ${c.score}% (weight ${Math.round(c.weight * 100)}%) - ${c.detail}`)
    .join("\n");
}

/**
 * Named tools, platforms and technologies in a short text such as one resume bullet.
 *
 * Soft skills never count, and a lexicon phrase only counts when it is written as a
 * name (capitalised, or carrying digits/symbols) somewhere other than the opening
 * word - so "Automated Terraform plans" names Terraform, while "automated" and
 * "monitoring" stay practices rather than systems.
 */
export function namedTechnologies(text: string): string[] {
  const lexicon = getLexicon();
  const normalized = normalizeText(text);
  const found = new Set<string>();

  for (const entry of lexicon.patternEntries) {
    if (!entry.soft && entry.patterns.some((pattern) => pattern.test(normalized))) found.add(entry.name);
  }

  let isOpeningToken = true;
  for (const segment of splitSegments(normalized)) {
    const raw = rawTokens(segment);
    const stems = raw.map((token) => stem(token.toLowerCase()));
    for (let i = 0; i < stems.length; ) {
      let length = 0;
      for (let n = Math.min(lexicon.maxPhraseLength, stems.length - i); n >= 1; n--) {
        const entry = lexicon.phraseIndex.get(stems.slice(i, i + n).join(" "));
        if (entry) {
          // Multi-word names ("load balancer", "data warehouse") are specific even in lowercase.
          const writtenAsName = /^[A-Z0-9.]/.test(raw[i]) || /[0-9+#]/.test(raw[i]) || n >= 2;
          if (!entry.soft && writtenAsName && !(isOpeningToken && i === 0)) found.add(entry.name);
          length = n;
          break;
        }
      }
      i += length > 0 ? length : 1;
    }
    if (raw.length > 0) isOpeningToken = false;
  }
  return [...found];
}
