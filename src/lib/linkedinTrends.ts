/**
 * Shared skill vocabulary, evidence-safe guidance, and coverage reports.
 * Active optimization uses daily Adzuna demand snapshots from the server.
 * The curated catalogue supplies role families and recognized skill names;
 * it is not a live source. Legacy LinkedIn field names remain for saved reports.
 */
import { buildTermPattern, detectJdPlatforms, findTerms } from "./bulletBudget";
import { MARKET_TREND_METHOD, readMarketMetadata, type MarketTrendMetadata } from "./jobMarketTrends";

export const TREND_METHOD = "linkedin-trends-v1";
export const TREND_COVERAGE_METHOD = "linkedin-trend-coverage-v1";
/** Month the curated catalogue was last reviewed against LinkedIn skill trends. */
export const CURATED_TRENDS_REVIEWED = "2026-10";
export const MAX_TREND_SKILLS = 32;

/** Never suggested, whatever the source says (mirrors the per-role generator's forbidden terms). */
const BANNED_TREND_TERMS = /\bci\s*\/\s*cd\b|\bpipelines?\b|\bdevops\b|\bdevsecops\b/i;

/**
 * The names the generation prompts mandate in place of the banned terms. Material
 * that uses a banned term evidences them, or the mandated rewrite would read as an
 * unsupported trending skill.
 */
export const BANNED_TERM_REPLACEMENTS = ["Infrastructure Automation", "Workflow Orchestration", "Release Engineering"];

export interface TrendSkill {
  /** Stable id shared by platform variants, e.g. "kubernetes" for AKS / EKS / GKE / Kubernetes. */
  key?: string;
  /** The trending name, meant to be used verbatim in the resume. */
  name: string;
  /** Lower-case variants that also count as naming the skill ("azure ad" for Microsoft Entra ID). */
  aliases: string[];
  /** Lower-case terms that prove the skill in the candidate's material without naming it ("bicep" for IaC). */
  evidence?: string[];
}

export interface LinkedInTrends {
  method: string;
  role_family: string;
  families: string[];
  label: string;
  target_role: string;
  /** "YYYY-MM": the month the curated catalogue was reviewed. */
  as_of: string;
  skills: TrendSkill[];
  market?: MarketTrendMetadata;
}

/**
 * used        - evidenced by the candidate's material and named in the resume
 * available   - evidenced but not named in the resume yet
 * gap         - trending, not evidenced, not in the resume (never inserted)
 * unsupported - named in the resume without evidence (flagged for review)
 */
export type TrendStatus = "used" | "available" | "gap" | "unsupported";

export interface TrendCoverageEntry {
  name: string;
  key?: string;
  aliases: string[];
  evidence_terms?: string[];
  status: TrendStatus;
  /** Terms from the candidate's material that support the skill. */
  evidence: string[];
  /** Terms naming the skill in the generated resume. */
  found: string[];
}

export interface TrendCoverageReport {
  method: string;
  trend_method: string;
  role_family: string;
  families: string[];
  label: string;
  target_role: string;
  as_of: string;
  entries: TrendCoverageEntry[];
  used: string[];
  available: string[];
  gaps: string[];
  unsupported: string[];
  /** Skills-section entries removed because they named a trending skill without evidence. */
  removed: string[];
  /** used / (used + available) as a whole percentage; null when nothing is evidenced. */
  coverage: number | null;
  market?: MarketTrendMetadata;
}

/* ------------------------------------------------------------------ *
 * Small helpers
 * ------------------------------------------------------------------ */

function asText(value: unknown): string {
  if (typeof value === "string") return value;
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  return "";
}

function unique<T>(items: T[]): T[] {
  return Array.from(new Set(items));
}

/** Comparison key for skill names: "Business Continuity & Disaster Recovery" -> "business continuity and disaster recovery". */
export function trendNameKey(name: unknown): string {
  return asText(name)
    .toLowerCase()
    .replace(/&/g, " and ")
    .replace(/[^a-z0-9#+.]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/** Lower-case, hyphens as spaces (the term pattern matches either), outer punctuation trimmed. */
function normalizeTerm(term: unknown): string {
  return asText(term)
    .toLowerCase()
    .replace(/[\u2010-\u2015]/g, "-")
    .replace(/[\u2018\u2019]/g, "'")
    .replace(/-/g, " ")
    .replace(/\s+/g, " ")
    .replace(/^[\s"'`,;:!?]+|[\s"'`,;:!?]+$/g, "")
    .trim();
}

function isUsableTerm(term: string): boolean {
  return term.length >= 2 && term.length <= 80 && /[a-z]/.test(term) && !BANNED_TREND_TERMS.test(term);
}

/** The name without parentheticals, each parenthetical part, and "&"/"and" variants. */
function nameTerms(name: unknown): string[] {
  const text = asText(name);
  const base = normalizeTerm(text.replace(/\([^)]*\)/g, " "));
  const inner = Array.from(text.matchAll(/\(([^)]*)\)/g))
    .flatMap((match) => match[1].split(/[/,]/))
    .map(normalizeTerm);
  const variants = [base, ...inner].flatMap((term) => [
    term,
    term.replace(/\s*&\s*/g, " and ").replace(/\s+/g, " ").trim(),
    term.replace(/\s+and\s+/g, " & ").replace(/\s+/g, " ").trim(),
  ]);
  return unique(variants).filter(isUsableTerm);
}

/** Terms that name the skill: its name (with variants) and its aliases. */
export function trendSkillTerms(skill: TrendSkill): string[] {
  return unique([...nameTerms(skill?.name), ...(skill?.aliases || []).map(normalizeTerm)]).filter(isUsableTerm);
}

/** Terms that prove the skill in the candidate's material: naming terms plus evidence-only terms. */
export function trendEvidenceTerms(skill: TrendSkill): string[] {
  return unique([...trendSkillTerms(skill), ...(skill?.evidence || []).map(normalizeTerm)]).filter(isUsableTerm);
}

function cloneSkill(skill: TrendSkill): TrendSkill {
  const copy: TrendSkill = { name: skill.name, aliases: [...(skill.aliases || [])] };
  if (skill.key) copy.key = skill.key;
  if (skill.evidence && skill.evidence.length) copy.evidence = [...skill.evidence];
  return copy;
}

interface OwnedSpan {
  owner: number;
  start: number;
  end: number;
  term: string;
}

/**
 * Every whole-term match of each owner's terms, with positions. A span that sits
 * inside a longer span of a different owner is dropped, so "Azure Kubernetes
 * Service" names AKS but not "Microsoft Azure", and "Data Center" is not "Data".
 */
function findOwnedSpans(text: string, termLists: string[][]): OwnedSpan[] {
  const spans: OwnedSpan[] = [];
  if (!text) return spans;
  termLists.forEach((terms, owner) => {
    const pattern = buildTermPattern(terms);
    if (!pattern) return;
    const re = new RegExp(pattern.source, "gi");
    let match: RegExpExecArray | null;
    while ((match = re.exec(text)) !== null) {
      const start = match.index + match[1].length;
      const end = start + match[2].length;
      spans.push({ owner, start, end, term: normalizeTerm(match[2]) });
      if (match[0].length === 0) re.lastIndex += 1;
    }
  });
  return spans.filter(
    (span) =>
      !spans.some(
        (other) =>
          other.owner !== span.owner &&
          other.end - other.start > span.end - span.start &&
          other.start <= span.start &&
          other.end >= span.end
      )
  );
}

/* ------------------------------------------------------------------ *
 * Curated catalogue
 *
 * Names are atomic so the model can use them verbatim without over-claiming
 * ("Containerization", not "Containers (Docker/Kubernetes)"). Aliases and
 * evidence terms are lower-case with spaces for hyphens. Ambiguous short words
 * (react, rest, node, go, rag, waf, dr, teams, exchange, defender, copilot,
 * microsoft, hybrid, caf, pam ...) are deliberately not used as bare terms.
 * ------------------------------------------------------------------ */

const NETWORK_EVIDENCE = [
  "hub spoke", "hub and spoke", "vnet", "vnets", "virtual network", "virtual networks", "expressroute",
  "express route", "azure firewall", "vpn gateway", "private endpoint", "private endpoints", "private link",
  "application gateway", "azure front door", "azure dns", "virtual wan", "vwan",
];

const SKILLS: Record<string, TrendSkill> = {
  // Cloud platforms
  azure: { key: "azure", name: "Microsoft Azure", aliases: ["azure"], evidence: ["aks", "bicep", "arm template", "arm templates"] },
  aws: { key: "aws", name: "AWS", aliases: ["amazon web services"], evidence: ["ec2", "amazon s3", "aws lambda", "amazon eks"] },
  gcp: { key: "gcp", name: "Google Cloud", aliases: ["gcp", "google cloud platform"], evidence: ["bigquery", "gke", "google kubernetes engine"] },
  azureLandingZones: {
    key: "landing-zones", name: "Azure Landing Zones",
    aliases: ["azure landing zone", "enterprise scale landing zone", "enterprise scale landing zones", "alz"],
    evidence: ["landing zone", "landing zones"],
  },
  awsLandingZones: {
    key: "landing-zones", name: "AWS Landing Zones", aliases: ["aws landing zone", "aws control tower"],
    evidence: ["landing zone", "landing zones", "control tower"],
  },
  cloudLandingZones: { key: "landing-zones", name: "Cloud Landing Zones", aliases: ["cloud landing zone", "landing zone", "landing zones"] },
  azureWaf: {
    key: "well-architected", name: "Azure Well-Architected Framework",
    aliases: ["azure well architected", "well architected framework"], evidence: ["well architected"],
  },
  awsWaf: {
    key: "well-architected", name: "AWS Well-Architected Framework",
    aliases: ["aws well architected", "well architected framework"], evidence: ["well architected"],
  },
  wellArchitected: { key: "well-architected", name: "Well-Architected Framework", aliases: ["well architected"] },
  iac: {
    key: "iac", name: "Infrastructure as Code", aliases: ["iac"],
    evidence: ["bicep", "arm template", "arm templates", "terraform", "pulumi", "cloudformation", "ansible"],
  },
  terraform: { key: "terraform", name: "Terraform", aliases: ["hashicorp terraform"] },
  cloudformation: { key: "cloudformation", name: "AWS CloudFormation", aliases: ["cloudformation"] },
  aks: { key: "kubernetes", name: "Azure Kubernetes Service", aliases: ["aks"] },
  eks: { key: "kubernetes", name: "Amazon EKS", aliases: ["eks", "elastic kubernetes service", "amazon elastic kubernetes service"] },
  gke: { key: "kubernetes", name: "Google Kubernetes Engine", aliases: ["gke"] },
  kubernetes: {
    key: "kubernetes", name: "Kubernetes", aliases: ["k8s"],
    evidence: ["aks", "eks", "gke", "openshift", "azure kubernetes service", "google kubernetes engine", "elastic kubernetes service"],
  },
  containers: {
    key: "containers", name: "Containerization", aliases: ["containerisation", "containers", "containerized", "containerised"],
    evidence: ["docker", "kubernetes", "k8s", "aks", "eks", "gke", "openshift", "container apps", "container instances", "podman"],
  },
  serverless: {
    key: "serverless", name: "Serverless Computing", aliases: ["serverless"],
    evidence: ["azure functions", "aws lambda", "lambda functions", "cloud functions", "cloud run", "logic apps"],
  },
  migration: {
    key: "cloud-migration", name: "Cloud Migration",
    aliases: ["cloud migrations", "azure migration", "azure migrations", "aws migration", "aws migrations", "gcp migration"],
    evidence: [
      "azure migrate", "migration hub", "lift and shift", "rehost", "replatform", "migrated to azure", "migration to azure",
      "migrated to aws", "migration to aws", "migrated to the cloud", "migration to the cloud", "migrated to cloud", "migration to cloud",
    ],
  },
  azureNetworking: {
    key: "cloud-networking", name: "Azure Networking",
    aliases: ["azure network", "azure virtual network", "azure virtual networks"], evidence: NETWORK_EVIDENCE,
  },
  cloudNetworking: {
    key: "cloud-networking", name: "Cloud Networking", aliases: [],
    evidence: [...NETWORK_EVIDENCE, "vpc", "vpcs", "transit gateway", "direct connect", "route 53", "cloud interconnect"],
  },
  hybridCloud: {
    key: "hybrid-cloud", name: "Hybrid Cloud", aliases: ["hybrid infrastructure", "hybrid environment", "hybrid environments"],
    evidence: ["azure arc", "azure stack", "azure stack hci", "aws outposts", "anthos", "on premises and azure", "on prem and azure", "on premises and cloud"],
  },
  multiCloud: { key: "multi-cloud", name: "Multi-Cloud", aliases: ["multicloud"] },
  finops: {
    key: "finops", name: "FinOps",
    aliases: ["cloud financial management", "cloud cost management", "cloud cost optimization", "cloud cost optimisation"],
    evidence: [
      "cost optimization", "cost optimisation", "azure cost management", "cloud cost", "cloud costs", "reserved instances",
      "savings plans", "rightsizing", "right sizing", "azure advisor", "chargeback", "showback",
    ],
  },
  governance: {
    key: "governance", name: "Cloud Governance", aliases: [],
    evidence: ["azure policy", "azure policies", "policy as code", "management groups", "aws organizations", "service control policies", "tagging strategy", "tagging policy"],
  },
  azurePolicy: { key: "azure-policy", name: "Azure Policy", aliases: ["azure policies"], evidence: ["policy as code"] },
  azureMonitor: { key: "native-monitoring", name: "Azure Monitor", aliases: [], evidence: ["log analytics", "application insights", "kql"] },
  cloudWatch: { key: "native-monitoring", name: "Amazon CloudWatch", aliases: ["cloudwatch"] },
  gcpMonitoring: { key: "native-monitoring", name: "Google Cloud Monitoring", aliases: ["stackdriver", "google cloud operations"] },
  observability: {
    key: "observability", name: "Observability", aliases: [],
    evidence: [
      "monitoring", "grafana", "prometheus", "azure monitor", "log analytics", "application insights", "cloudwatch", "datadog",
      "splunk", "dynatrace", "new relic", "opentelemetry", "elastic stack", "elk stack", "zabbix", "nagios", "solarwinds", "scom",
    ],
  },
  bcdr: {
    key: "bcdr", name: "Business Continuity & Disaster Recovery",
    aliases: ["bcdr", "bc dr", "bc/dr", "disaster recovery", "business continuity"],
    evidence: ["ha/dr", "ha dr", "site recovery", "azure site recovery", "failover", "backup and recovery", "backup & recovery", "rto", "rpo"],
  },
  ha: {
    key: "high-availability", name: "High Availability", aliases: ["highly available"],
    evidence: ["availability zones", "availability sets", "load balancing", "failover clustering", "ha/dr", "ha dr"],
  },
  scalability: { key: "scalability", name: "Scalability", aliases: ["scalable architecture"], evidence: ["autoscaling", "auto scaling", "scale sets", "vmss"] },

  // Identity and security
  entraId: {
    key: "entra-id", name: "Microsoft Entra ID",
    aliases: ["entra id", "microsoft entra", "azure ad", "azure active directory", "aad"], evidence: ["entra"],
  },
  iam: {
    key: "iam", name: "Identity and Access Management", aliases: ["iam", "identity management", "access management"],
    evidence: [
      "rbac", "role based access control", "conditional access", "privileged identity management", "single sign on", "sso", "mfa",
      "multi factor authentication", "entra id", "azure ad", "azure active directory", "active directory", "okta", "ping identity", "saml", "oauth",
    ],
  },
  zeroTrust: {
    key: "zero-trust", name: "Zero Trust", aliases: ["zero trust security", "zero trust architecture", "zero trust model"],
    evidence: ["conditional access"],
  },
  cloudSecurity: {
    key: "cloud-security", name: "Cloud Security", aliases: [],
    evidence: [
      "defender for cloud", "azure security center", "cspm", "cloud security posture management", "security hub", "guardduty",
      "network security groups", "nsg", "nsgs", "azure firewall", "key vault", "azure key vault", "zero trust", "conditional access", "sentinel",
    ],
  },
  defenderForCloud: {
    key: "defender-for-cloud", name: "Microsoft Defender for Cloud",
    aliases: ["defender for cloud", "azure defender", "azure security center"],
  },
  sentinel: { key: "sentinel", name: "Microsoft Sentinel", aliases: ["azure sentinel"] },
  siem: {
    key: "siem", name: "SIEM", aliases: ["security information and event management", "security information & event management"],
    evidence: ["microsoft sentinel", "azure sentinel", "splunk enterprise security", "qradar", "arcsight", "logrhythm", "chronicle"],
  },
  defenderXdr: {
    key: "xdr", name: "Microsoft Defender XDR",
    aliases: ["defender xdr", "microsoft 365 defender", "m365 defender", "xdr", "extended detection and response"],
    evidence: ["defender for endpoint", "defender for office 365", "defender for identity"],
  },
  defenderEndpoint: {
    key: "defender-endpoint", name: "Microsoft Defender for Endpoint",
    aliases: ["defender for endpoint", "mde", "microsoft defender atp", "defender atp"],
  },
  conditionalAccess: { key: "conditional-access", name: "Conditional Access", aliases: [] },
  pim: {
    key: "privileged-access", name: "Privileged Access Management", aliases: ["privileged identity management"],
    evidence: ["cyberark", "just in time access", "jit access", "break glass"],
  },
  purview: {
    key: "purview", name: "Microsoft Purview", aliases: ["purview"],
    evidence: ["sensitivity labels", "information protection", "data loss prevention", "dlp", "retention policies", "ediscovery"],
  },
  dlp: { key: "dlp", name: "Data Loss Prevention", aliases: ["dlp"] },
  threatDetection: {
    key: "threat-detection", name: "Threat Detection", aliases: ["threat hunting", "threat detection and response"],
    evidence: ["sentinel", "siem", "edr", "xdr", "kql"],
  },
  incidentResponse: {
    key: "incident-response", name: "Incident Response", aliases: ["security incident response"],
    evidence: ["forensics", "incident handling", "security incidents"],
  },
  vulnerability: {
    key: "vulnerability-management", name: "Vulnerability Management", aliases: ["vulnerability assessment"],
    evidence: ["qualys", "tenable", "nessus", "rapid7", "patch management", "cve", "cves"],
  },
  grc: {
    key: "grc", name: "Governance, Risk & Compliance", aliases: ["grc", "governance risk and compliance"],
    evidence: ["iso 27001", "soc 2", "nist", "pci dss", "hipaa", "gdpr", "audit", "audits"],
  },
  nist: { key: "nist", name: "NIST Cybersecurity Framework", aliases: ["nist csf", "nist 800 53", "nist framework"] },
  iso27001: { key: "iso27001", name: "ISO 27001", aliases: ["iso/iec 27001", "iso 27001:2022"] },
  threatIntel: { key: "threat-intelligence", name: "Threat Intelligence", aliases: ["cyber threat intelligence"] },
  aiSecurity: { key: "ai-security", name: "AI Security", aliases: ["securing ai", "llm security"] },

  // Infrastructure and operations
  linux: { key: "linux", name: "Linux", aliases: [], evidence: ["rhel", "red hat", "ubuntu", "centos", "suse", "debian"] },
  windowsServer: { key: "windows-server", name: "Windows Server", aliases: [], evidence: ["wintel", "hyper v"] },
  activeDirectory: {
    key: "active-directory", name: "Active Directory", aliases: ["ad ds", "active directory domain services"],
    evidence: ["group policy", "gpo", "domain controller", "domain controllers"],
  },
  virtualization: {
    key: "virtualization", name: "Virtualization", aliases: ["virtualisation", "server virtualization"],
    evidence: ["vmware", "vsphere", "esxi", "hyper v", "virtual machines", "vms", "citrix", "nutanix"],
  },
  vmware: { key: "vmware", name: "VMware vSphere", aliases: ["vsphere", "vmware"], evidence: ["esxi", "vcenter"] },
  networking: {
    key: "network-administration", name: "Network Administration", aliases: ["network management"],
    evidence: ["tcp/ip", "dns", "dhcp", "vlan", "vlans", "routing", "switching", "firewalls", "load balancers", "vpn", "bgp"],
  },
  itsm: {
    key: "itsm", name: "IT Service Management", aliases: ["itsm"],
    evidence: ["itil", "servicenow", "service now", "incident management", "change management", "problem management", "jira service management"],
  },
  itil: { key: "itil", name: "ITIL", aliases: ["itil v4", "itil 4"] },
  servicenow: { key: "servicenow", name: "ServiceNow", aliases: ["service now"] },
  incident: {
    key: "incident-management", name: "Incident Management", aliases: [],
    evidence: ["incidents", "root cause analysis", "rca", "on call", "sev1", "sev 1", "p1 incidents", "major incidents"],
  },
  rca: { key: "rca", name: "Root Cause Analysis", aliases: ["rca"], evidence: ["post incident review", "postmortem", "postmortems", "post mortem", "problem management"] },
  capacity: { key: "capacity-planning", name: "Capacity Planning", aliases: ["capacity management"] },
  automation: {
    key: "automation", name: "Infrastructure Automation", aliases: ["it automation"],
    evidence: ["powershell", "ansible", "azure automation", "runbook", "runbooks", "terraform", "bicep", "infrastructure as code", "iac", "automation scripts", "scripting"],
  },
  patching: {
    key: "patch-management", name: "Patch Management", aliases: ["patching"],
    evidence: ["wsus", "sccm", "configuration manager", "update management", "azure update manager"],
  },
  backup: {
    key: "backup", name: "Backup and Recovery", aliases: ["backup and restore"],
    evidence: ["azure backup", "veeam", "commvault", "rubrik", "backups"],
  },
  powershell: { key: "powershell", name: "PowerShell", aliases: ["power shell"] },
  python: { key: "python", name: "Python", aliases: [] },
  avd: { key: "avd", name: "Azure Virtual Desktop", aliases: ["avd", "windows virtual desktop", "wvd"] },

  // Modern workplace
  m365: {
    key: "m365", name: "Microsoft 365", aliases: ["m365", "office 365", "o365", "microsoft office 365"],
    evidence: ["exchange online", "sharepoint online", "microsoft teams", "onedrive"],
  },
  intune: { key: "intune", name: "Microsoft Intune", aliases: ["intune", "endpoint manager", "microsoft endpoint manager"] },
  exchangeOnline: { key: "exchange-online", name: "Exchange Online", aliases: [], evidence: ["exchange server", "exchange hybrid", "microsoft exchange"] },
  teams: { key: "teams", name: "Microsoft Teams", aliases: ["ms teams"], evidence: ["teams voice", "teams phone", "teams rooms"] },
  sharepoint: { key: "sharepoint", name: "SharePoint Online", aliases: ["sharepoint"], evidence: ["onedrive"] },
  autopilot: { key: "autopilot", name: "Windows Autopilot", aliases: ["autopilot"] },
  m365Copilot: { key: "m365-copilot", name: "Microsoft 365 Copilot", aliases: ["m365 copilot", "copilot for microsoft 365", "microsoft copilot"] },
  endpoint: {
    key: "endpoint-management", name: "Endpoint Management",
    aliases: ["unified endpoint management", "uem", "mobile device management", "mdm"],
    evidence: ["intune", "sccm", "configuration manager", "jamf", "workspace one", "autopilot"],
  },
  powerAutomate: { key: "power-automate", name: "Power Automate", aliases: ["microsoft flow"] },
  windows11: { key: "windows-11", name: "Windows 11", aliases: ["win11", "win 11"] },
  graph: { key: "graph", name: "Microsoft Graph", aliases: ["graph api", "microsoft graph api"] },

  // SRE and platform
  sre: { key: "sre", name: "Site Reliability Engineering", aliases: ["sre"], evidence: ["slo", "slos", "error budget", "error budgets"] },
  slo: { key: "slo", name: "Service Level Objectives", aliases: ["slo", "slos", "slis", "service level indicators"], evidence: ["error budget", "error budgets"] },
  platformEngineering: {
    key: "platform-engineering", name: "Platform Engineering",
    aliases: ["internal developer platform", "internal developer platforms"], evidence: ["backstage"],
  },
  prometheus: { key: "prometheus", name: "Prometheus", aliases: [] },
  grafana: { key: "grafana", name: "Grafana", aliases: [] },
  openTelemetry: { key: "opentelemetry", name: "OpenTelemetry", aliases: ["open telemetry", "otel"] },
  chaos: { key: "chaos-engineering", name: "Chaos Engineering", aliases: [], evidence: ["chaos studio", "fault injection", "gremlin"] },
  aiops: { key: "aiops", name: "AIOps", aliases: ["ai ops"] },
  golang: { key: "golang", name: "Golang", aliases: ["go programming language", "go language"] },

  // Data and AI
  sql: { key: "sql", name: "SQL", aliases: ["t sql", "tsql", "pl/sql", "plsql"] },
  powerBi: { key: "power-bi", name: "Power BI", aliases: ["powerbi"] },
  fabric: { key: "fabric", name: "Microsoft Fabric", aliases: [] },
  databricks: { key: "databricks", name: "Databricks", aliases: ["azure databricks"] },
  spark: { key: "spark", name: "Apache Spark", aliases: ["spark", "pyspark", "spark sql"] },
  dataModeling: {
    key: "data-modeling", name: "Data Modeling", aliases: ["data modelling", "dimensional modeling", "dimensional modelling"],
    evidence: ["star schema"],
  },
  etl: { key: "etl", name: "ETL", aliases: ["elt", "extract transform load"], evidence: ["azure data factory", "data factory", "ssis", "informatica", "dbt"] },
  snowflake: { key: "snowflake", name: "Snowflake", aliases: [] },
  dataGovernance: { key: "data-governance", name: "Data Governance", aliases: [], evidence: ["data catalog", "purview", "unity catalog", "data lineage"] },
  dataWarehousing: {
    key: "data-warehousing", name: "Data Warehousing", aliases: ["data warehouse", "data warehouses"],
    evidence: ["synapse", "redshift", "bigquery", "snowflake"],
  },
  adf: { key: "adf", name: "Azure Data Factory", aliases: ["adf", "data factory"] },
  tableau: { key: "tableau", name: "Tableau", aliases: [] },
  dataViz: {
    key: "data-visualization", name: "Data Visualization", aliases: ["data visualisation"],
    evidence: ["power bi", "tableau", "looker", "dashboards"],
  },
  dataQuality: { key: "data-quality", name: "Data Quality", aliases: [] },
  dataAnalysis: { key: "data-analysis", name: "Data Analysis", aliases: ["data analytics"], evidence: ["excel", "power bi", "tableau", "sql", "dashboards"] },
  statistics: { key: "statistics", name: "Statistical Analysis", aliases: ["statistics", "statistical modeling", "statistical modelling"] },
  ml: {
    key: "ml", name: "Machine Learning", aliases: [],
    evidence: ["ml", "scikit learn", "tensorflow", "pytorch", "xgboost", "azure machine learning", "sagemaker", "vertex ai"],
  },
  mlops: { key: "mlops", name: "MLOps", aliases: ["ml ops"], evidence: ["mlflow", "azure machine learning"] },
  genai: {
    key: "genai", name: "Generative AI", aliases: ["genai", "gen ai", "generative artificial intelligence"],
    evidence: [
      "large language models", "large language model", "llm", "llms", "openai", "azure openai", "chatgpt", "prompt engineering",
      "retrieval augmented generation", "copilot studio", "microsoft 365 copilot", "m365 copilot", "github copilot", "ai agents",
      "agentic ai", "semantic kernel", "langchain",
    ],
  },
  llm: { key: "llm", name: "Large Language Models", aliases: ["llm", "llms"], evidence: ["gpt 4", "gpt 4o", "openai", "azure openai"] },
  rag: { key: "rag", name: "Retrieval-Augmented Generation", aliases: [], evidence: ["vector search", "vector database", "azure ai search", "embeddings"] },
  promptEngineering: { key: "prompt-engineering", name: "Prompt Engineering", aliases: [] },
  agenticAi: {
    key: "agentic-ai", name: "AI Agents", aliases: ["agentic ai", "ai agent", "autonomous agents"],
    evidence: ["copilot studio", "semantic kernel", "langchain", "autogen"],
  },
  responsibleAi: { key: "responsible-ai", name: "Responsible AI", aliases: ["ai governance", "ai ethics"] },
  azureOpenAI: { key: "azure-openai", name: "Azure OpenAI", aliases: ["azure openai service", "azure open ai"], evidence: ["azure ai foundry", "ai foundry"] },
  bedrock: { key: "bedrock", name: "Amazon Bedrock", aliases: ["aws bedrock"] },
  vertexAi: { key: "vertex-ai", name: "Vertex AI", aliases: ["google vertex ai"] },
  bigquery: { key: "bigquery", name: "BigQuery", aliases: ["google bigquery"] },

  // Software engineering
  typescript: { key: "typescript", name: "TypeScript", aliases: [] },
  javascript: { key: "javascript", name: "JavaScript", aliases: ["ecmascript", "es6"], evidence: ["typescript", "node.js", "react.js"] },
  react: { key: "react", name: "React.js", aliases: ["reactjs", "react js"], evidence: ["next.js", "nextjs"] },
  nodejs: { key: "nodejs", name: "Node.js", aliases: ["nodejs", "node js"], evidence: ["express.js", "expressjs", "nestjs"] },
  java: { key: "java", name: "Java", aliases: [], evidence: ["spring boot"] },
  csharp: { key: "csharp", name: "C#", aliases: ["c sharp", "csharp"] },
  dotnet: { key: "dotnet", name: ".NET", aliases: ["dotnet", ".net core", "asp.net", "asp.net core"] },
  restApis: {
    key: "rest-apis", name: "REST APIs", aliases: ["rest api", "restful apis", "restful api", "restful services", "restful"],
    evidence: ["openapi", "swagger", "api development"],
  },
  microservices: { key: "microservices", name: "Microservices", aliases: ["microservice", "microservice architecture"] },
  cloudNative: {
    key: "cloud-native", name: "Cloud-Native Applications",
    aliases: ["cloud native", "cloud native development", "cloud native architecture"],
  },
  systemDesign: { key: "system-design", name: "System Design", aliases: ["systems design"] },
  git: { key: "git", name: "Git", aliases: [], evidence: ["github", "gitlab", "bitbucket"] },
  githubCopilot: { key: "github-copilot", name: "GitHub Copilot", aliases: [] },
  testing: {
    key: "testing", name: "Automated Testing", aliases: ["test automation", "automation testing"],
    evidence: [
      "unit testing", "unit tests", "integration testing", "jest", "pytest", "junit", "xunit", "nunit", "playwright", "cypress",
      "selenium", "tdd", "test driven development",
    ],
  },
  graphql: { key: "graphql", name: "GraphQL", aliases: [] },
  agile: { key: "agile", name: "Agile Methodologies", aliases: ["agile", "agile methodology", "scrum", "kanban"], evidence: ["sprint", "sprints"] },

  // Architecture
  solutionArchitecture: {
    key: "solution-architecture", name: "Solution Architecture",
    aliases: ["solutions architecture", "solution design", "solutions design"],
    evidence: [
      "solution architect", "solutions architect", "high level design", "low level design", "hld", "lld", "cloud architecture",
      "azure architecture", "aws architecture", "reference architecture", "reference architectures", "architectural design",
    ],
  },
  cloudArchitecture: {
    key: "cloud-architecture", name: "Cloud Architecture",
    aliases: ["cloud architectures", "cloud solution architecture", "azure architecture", "aws architecture", "gcp architecture"],
    evidence: ["landing zone", "landing zones", "well architected", "reference architecture", "cloud architect"],
  },
  enterpriseArchitecture: { key: "enterprise-architecture", name: "Enterprise Architecture", aliases: [], evidence: ["togaf", "archimate"] },
  togaf: { key: "togaf", name: "TOGAF", aliases: [] },
  eventDriven: {
    key: "event-driven", name: "Event-Driven Architecture", aliases: [],
    evidence: ["event grid", "event hubs", "service bus", "kafka", "eventbridge"],
  },
  apiManagement: { key: "api-management", name: "API Management", aliases: ["apim", "azure api management", "api gateway"] },

  // Leadership and general
  techLeadership: {
    key: "technical-leadership", name: "Technical Leadership",
    aliases: ["technology leadership", "engineering leadership", "tech leadership"],
    evidence: [
      "led a team", "led teams", "leading a team", "team lead", "mentored", "mentoring", "cross functional leadership",
      "technical hiring", "managed a team", "architecture review board",
    ],
  },
  stakeholder: {
    key: "stakeholder-management", name: "Stakeholder Management", aliases: ["stakeholder engagement"],
    evidence: ["stakeholder", "stakeholders", "executive", "executives", "leadership team", "c suite", "cxo"],
  },
  teamLeadership: {
    key: "team-leadership", name: "Team Leadership", aliases: ["team management", "people management", "people leadership"],
    evidence: ["led a team", "led teams", "leading a team", "managed a team", "managing a team", "direct reports", "team lead"],
  },
  strategicPlanning: {
    key: "strategic-planning", name: "Strategic Planning", aliases: ["technology strategy", "it strategy"],
    evidence: ["roadmap", "roadmaps"],
  },
  changeManagement: {
    key: "change-management", name: "Change Management",
    aliases: ["organizational change management", "organisational change management", "ocm"],
    evidence: ["change advisory board"],
  },
  vendor: {
    key: "vendor-management", name: "Vendor Management",
    aliases: ["vendor relationship management", "supplier management", "third party management"],
    evidence: ["vendor", "vendors", "suppliers", "msp", "managed service provider"],
  },
  budget: {
    key: "budget-management", name: "Budget Management", aliases: ["budgeting", "budget planning", "financial management"],
    evidence: ["budget", "budgets", "p&l", "opex", "capex", "cost center"],
  },
  crossFunctional: {
    key: "cross-functional", name: "Cross-Functional Collaboration", aliases: [],
    evidence: ["cross functional", "cross team", "multi disciplinary", "multidisciplinary"],
  },
  mentoring: { key: "mentoring", name: "Mentoring", aliases: ["mentorship", "coaching"], evidence: ["mentored", "coached", "upskilled", "knowledge transfer"] },
  serviceDelivery: { key: "service-delivery", name: "Service Delivery", aliases: ["it service delivery"], evidence: ["sla", "slas", "managed services"] },
  programManagement: { key: "program-management", name: "Program Management", aliases: ["programme management"], evidence: ["program manager", "programme manager", "pmo"] },
  projectManagement: {
    key: "project-management", name: "Project Management", aliases: ["project delivery"],
    evidence: ["project manager", "pmp", "prince2", "project planning", "managed projects", "led projects"],
  },
  riskManagement: {
    key: "risk-management", name: "Risk Management", aliases: ["it risk management"],
    evidence: ["risk assessment", "risk assessments", "risk register", "risk mitigation"],
  },
  riskAssessment: {
    key: "risk-assessment", name: "Risk Assessment", aliases: ["risk assessments", "risk analysis"],
    evidence: ["risk register", "risk mitigation", "threat modeling", "threat modelling"],
  },
  digitalTransformation: { key: "digital-transformation", name: "Digital Transformation", aliases: [], evidence: ["modernization", "modernisation", "cloud transformation"] },
  aiStrategy: { key: "ai-strategy", name: "AI Strategy", aliases: ["ai adoption", "ai transformation"] },
  hiring: { key: "hiring", name: "Technical Hiring", aliases: ["technical recruiting"], evidence: ["hiring", "hired", "recruited", "interviewed"] },
  aiLiteracy: {
    key: "ai-literacy", name: "AI Literacy", aliases: [],
    evidence: [
      "generative ai", "genai", "chatgpt", "copilot studio", "microsoft 365 copilot", "github copilot", "prompt engineering",
      "large language models", "llm", "llms", "artificial intelligence", "azure openai", "openai",
    ],
  },
  processOptimization: {
    key: "process-optimization", name: "Process Optimization",
    aliases: ["process optimisation", "process improvement", "continuous improvement", "business process improvement"],
    evidence: ["streamlined", "lean six sigma", "six sigma", "kaizen"],
  },
  customerEngagement: {
    key: "customer-engagement", name: "Customer Engagement", aliases: ["client engagement"],
    evidence: ["customers", "clients", "client facing", "customer facing", "customer satisfaction", "csat", "nps"],
  },
  problemSolving: {
    key: "problem-solving", name: "Problem Solving", aliases: ["analytical problem solving"],
    evidence: ["troubleshooting", "troubleshot", "root cause analysis"],
  },
  conflictResolution: {
    key: "conflict-resolution", name: "Conflict Resolution", aliases: [],
    evidence: ["escalations", "escalation management", "de escalated", "negotiation", "negotiated"],
  },
  adaptability: { key: "adaptability", name: "Adaptability", aliases: [] },
};

/* ------------------------------------------------------------------ *
 * Role families
 * ------------------------------------------------------------------ */

interface RoleFamily {
  id: string;
  label: string;
  /** Cloud platform the family is specific to (a CLOUD_PLATFORMS name). */
  platform?: string;
  /** Lower-case title terms; a match scores its word count. */
  titleTerms: string[];
  /** Trending skills, most in-demand first. */
  skills: TrendSkill[];
}

const S = SKILLS;

const ROLE_FAMILIES: RoleFamily[] = [
  {
    id: "azure-cloud",
    label: "Azure cloud",
    platform: "Azure",
    titleTerms: ["azure", "microsoft azure", "microsoft cloud"],
    skills: [
      S.azure, S.iac, S.terraform, S.aks, S.entraId, S.azureLandingZones, S.zeroTrust, S.iam, S.azurePolicy, S.governance,
      S.finops, S.azureMonitor, S.observability, S.bcdr, S.migration, S.azureNetworking, S.hybridCloud, S.defenderForCloud,
      S.azureOpenAI, S.genai, S.powershell, S.python, S.sentinel, S.azureWaf, S.avd,
    ],
  },
  {
    id: "aws-cloud",
    label: "AWS cloud",
    platform: "AWS",
    titleTerms: ["aws", "amazon web services"],
    skills: [
      S.aws, S.iac, S.terraform, S.eks, S.containers, S.iam, S.zeroTrust, S.awsLandingZones, S.governance, S.finops,
      S.cloudWatch, S.observability, S.serverless, S.migration, S.cloudNetworking, S.cloudSecurity, S.cloudformation,
      S.python, S.genai, S.bedrock, S.bcdr, S.multiCloud, S.awsWaf, S.linux,
    ],
  },
  {
    id: "gcp-cloud",
    label: "Google Cloud",
    platform: "GCP",
    titleTerms: ["gcp", "google cloud", "google cloud platform"],
    skills: [
      S.gcp, S.gke, S.terraform, S.iac, S.containers, S.bigquery, S.iam, S.zeroTrust, S.governance, S.finops,
      S.gcpMonitoring, S.observability, S.serverless, S.migration, S.cloudNetworking, S.cloudSecurity, S.vertexAi,
      S.genai, S.python, S.cloudLandingZones, S.bcdr, S.multiCloud, S.linux,
    ],
  },
  {
    id: "cloud-generic",
    label: "Cloud engineering",
    titleTerms: ["cloud", "cloud native", "multi cloud", "hybrid cloud"],
    skills: [
      S.multiCloud, S.iac, S.terraform, S.kubernetes, S.containers, S.cloudSecurity, S.iam, S.zeroTrust, S.governance,
      S.finops, S.observability, S.migration, S.cloudLandingZones, S.bcdr, S.serverless, S.hybridCloud, S.cloudNetworking,
      S.python, S.genai, S.automation, S.linux, S.wellArchitected,
    ],
  },
  {
    id: "infrastructure",
    label: "Infrastructure & operations",
    titleTerms: [
      "infrastructure", "it", "it infrastructure", "it operations", "it support", "it administrator", "it engineer",
      "it specialist", "system administrator", "systems administrator", "sysadmin", "system admin", "systems engineer",
      "system engineer", "windows engineer", "windows administrator", "server administrator", "server engineer", "wintel",
      "technical support", "support engineer", "desktop support", "service desk", "help desk", "helpdesk", "data center",
      "datacenter", "network engineer", "network administrator", "virtualization", "vmware", "noc",
    ],
    skills: [
      S.hybridCloud, S.azure, S.windowsServer, S.linux, S.activeDirectory, S.entraId, S.virtualization, S.powershell,
      S.automation, S.iac, S.networking, S.bcdr, S.backup, S.itsm, S.itil, S.observability, S.patching, S.iam, S.zeroTrust,
      S.migration, S.incident, S.capacity, S.containers, S.genai, S.python,
    ],
  },
  {
    id: "modern-workplace",
    label: "Modern workplace (Microsoft 365)",
    titleTerms: [
      "m365", "microsoft 365", "office 365", "o365", "intune", "endpoint", "end user computing", "euc", "modern workplace",
      "digital workplace", "workplace", "collaboration", "messaging", "exchange", "sharepoint", "teams engineer",
      "desktop engineer", "mdm",
    ],
    skills: [
      S.m365, S.intune, S.entraId, S.exchangeOnline, S.teams, S.sharepoint, S.defenderEndpoint, S.purview, S.conditionalAccess,
      S.zeroTrust, S.autopilot, S.m365Copilot, S.endpoint, S.avd, S.powershell, S.powerAutomate, S.iam, S.dlp, S.windows11,
      S.graph, S.genai,
    ],
  },
  {
    id: "sre-platform",
    label: "SRE & platform engineering",
    titleTerms: [
      "sre", "site reliability", "reliability engineer", "platform engineer", "platform engineering", "production engineer",
      "operations engineer", "ops engineer", "service engineer", "service reliability", "observability", "monitoring engineer",
    ],
    skills: [
      S.sre, S.observability, S.kubernetes, S.containers, S.iac, S.terraform, S.incident, S.slo, S.automation, S.python,
      S.golang, S.linux, S.prometheus, S.grafana, S.openTelemetry, S.chaos, S.capacity, S.platformEngineering, S.rca,
      S.cloudSecurity, S.aiops, S.genai,
    ],
  },
  {
    id: "security",
    label: "Cybersecurity",
    titleTerms: [
      "security", "cybersecurity", "cyber security", "infosec", "information security", "soc", "secops", "iam",
      "identity engineer", "identity and access", "grc", "compliance", "threat", "vulnerability", "penetration tester",
      "pen tester", "ciso",
    ],
    skills: [
      S.zeroTrust, S.cloudSecurity, S.iam, S.siem, S.sentinel, S.defenderXdr, S.threatDetection, S.incidentResponse,
      S.vulnerability, S.grc, S.riskAssessment, S.nist, S.iso27001, S.defenderForCloud, S.pim, S.purview, S.dlp, S.threatIntel,
      S.aiSecurity, S.genai, S.python, S.entraId,
    ],
  },
  {
    id: "data",
    label: "Data & AI",
    titleTerms: [
      "data", "analytics", "bi", "business intelligence", "ai", "ml", "machine learning", "data analyst", "data engineer",
      "data scientist", "data science", "power bi", "artificial intelligence", "llm", "genai", "generative ai", "mlops",
    ],
    skills: [
      S.python, S.sql, S.genai, S.ml, S.powerBi, S.fabric, S.databricks, S.spark, S.dataModeling, S.etl, S.llm, S.rag,
      S.agenticAi, S.promptEngineering, S.dataGovernance, S.dataWarehousing, S.snowflake, S.adf, S.dataViz, S.mlops,
      S.statistics, S.tableau, S.dataQuality, S.responsibleAi,
    ],
  },
  {
    id: "software",
    label: "Software engineering",
    titleTerms: [
      "software", "developer", "programmer", "full stack", "fullstack", "frontend", "front end", "backend", "back end",
      "web developer", "application developer", "software engineer", "sde", "swe", "mobile developer",
    ],
    skills: [
      S.typescript, S.python, S.javascript, S.react, S.nodejs, S.java, S.csharp, S.dotnet, S.restApis, S.microservices,
      S.cloudNative, S.kubernetes, S.containers, S.sql, S.systemDesign, S.git, S.githubCopilot, S.genai, S.agenticAi,
      S.testing, S.graphql, S.agile,
    ],
  },
  {
    id: "architecture",
    label: "Solution architecture",
    titleTerms: ["architect", "architecture", "solutions architect", "solution architect", "enterprise architect", "technical architect"],
    skills: [
      S.solutionArchitecture, S.cloudArchitecture, S.wellArchitected, S.cloudLandingZones, S.multiCloud, S.hybridCloud, S.iac,
      S.zeroTrust, S.cloudSecurity, S.governance, S.finops, S.migration, S.bcdr, S.ha, S.scalability, S.microservices,
      S.eventDriven, S.apiManagement, S.enterpriseArchitecture, S.togaf, S.techLeadership, S.stakeholder, S.genai,
    ],
  },
  {
    id: "leadership",
    label: "Technology leadership",
    titleTerms: [
      "manager", "management", "director", "head", "lead", "leader", "leadership", "team lead", "tech lead", "vp",
      "vice president", "chief", "cto", "cio", "ciso", "supervisor", "delivery manager", "program manager",
      "project manager", "engineering manager",
    ],
    skills: [
      S.techLeadership, S.stakeholder, S.teamLeadership, S.strategicPlanning, S.changeManagement, S.crossFunctional, S.vendor,
      S.budget, S.mentoring, S.programManagement, S.riskManagement, S.digitalTransformation, S.aiStrategy, S.serviceDelivery,
      S.agile, S.hiring,
    ],
  },
  {
    id: "general",
    label: "General professional",
    titleTerms: [],
    skills: [
      S.aiLiteracy, S.processOptimization, S.stakeholder, S.dataAnalysis, S.projectManagement, S.customerEngagement,
      S.riskAssessment, S.problemSolving, S.changeManagement, S.crossFunctional, S.conflictResolution, S.adaptability,
    ],
  },
];

const FAMILY_BY_ID = new Map(ROLE_FAMILIES.map((family) => [family.id, family]));

/** Title families that defer to the posting's cloud platform for the primary trend list. */
const PROMOTABLE_FAMILIES = new Set(["cloud-generic", "architecture", "infrastructure", "sre-platform"]);
/** New skills taken from the primary, secondary and tertiary family. */
const FAMILY_RANK_CAPS = [25, 6, 4];
/** A family found only through the posting needs this many of its skills named there. */
const MIN_JD_FAMILY_HITS = 3;

export interface RoleFamilyMatch {
  id: string;
  label: string;
  score: number;
  via: "title" | "platform" | "job_description" | "fallback";
  terms: string[];
}

/** Tie-break between title families of equal score: specialised first, broad next, leadership last. */
function familyTier(id: string): number {
  if (id === "leadership") return 2;
  return PROMOTABLE_FAMILIES.has(id) ? 1 : 0;
}

/** The role families (most relevant first, at most three) that decide which trends apply. */
export function matchRoleFamilies(targetRole: unknown, jobDescription?: unknown): RoleFamilyMatch[] {
  const title = asText(targetRole).slice(0, 300);
  const jd = asText(jobDescription);
  const families = ROLE_FAMILIES.filter((family) => family.id !== "general");
  const spans = findOwnedSpans(title, families.map((family) => family.titleTerms));
  const titleMatches = families
    .map((family, order) => {
      const own = spans.filter((span) => span.owner === order);
      // Score maximal spans only: "Solutions Architect" is one term, not "solutions architect" + "architect".
      const maximal = own.filter(
        (span) => !own.some((other) => other.end - other.start > span.end - span.start && other.start <= span.start && other.end >= span.end)
      );
      const terms = unique(maximal.map((span) => span.term));
      return { family, order, terms, score: terms.reduce((sum, term) => sum + term.split(" ").length, 0) };
    })
    .filter((match) => match.score > 0)
    .sort((a, b) => b.score - a.score || familyTier(a.family.id) - familyTier(b.family.id) || a.order - b.order);

  const selected: RoleFamilyMatch[] = [];
  const has = (id: string) => selected.some((match) => match.id === id);
  const platformSelected = () => selected.some((match) => Boolean(FAMILY_BY_ID.get(match.id)?.platform));
  const add = (family: RoleFamily, score: number, via: RoleFamilyMatch["via"], terms: string[]) => {
    if (selected.length < FAMILY_RANK_CAPS.length && !has(family.id)) {
      selected.push({ id: family.id, label: family.label, score, via, terms });
    }
  };
  const jdPlatforms = detectJdPlatforms(jd);
  const jdPlatform = jdPlatforms[0];
  const jdPlatformFamily = jdPlatform ? families.find((candidate) => candidate.platform === jdPlatform) : undefined;
  const addJdPlatform = () => {
    if (jdPlatformFamily && jdPlatform) add(jdPlatformFamily, 0, "platform", [jdPlatform.toLowerCase()]);
  };

  const titlePlatform = titleMatches.find((match) => match.family.platform);
  if (titlePlatform) {
    add(titlePlatform.family, titlePlatform.score, "title", titlePlatform.terms);
  } else if (!titleMatches.length || PROMOTABLE_FAMILIES.has(titleMatches[0].family.id)) {
    addJdPlatform();
  }

  for (const match of titleMatches) {
    if (match.family.id === "cloud-generic") {
      // A generic "cloud" title defers to the platform the posting asks for.
      if (!platformSelected()) addJdPlatform();
      if (platformSelected()) continue;
    }
    add(match.family, match.score, "title", match.terms);
  }

  if (selected.length < 2 && jd.trim()) {
    const best = families
      .map((family, order) => ({ family, order }))
      .filter(({ family }) => !has(family.id))
      .filter(({ family }) => !(family.id === "cloud-generic" && platformSelected()))
      .filter(({ family }) => !family.platform || jdPlatforms.includes(family.platform))
      .map(({ family, order }) => ({
        family,
        order,
        hits: family.skills.filter((skill) => findTerms(jd, trendSkillTerms(skill)).length > 0).length,
      }))
      .filter((candidate) => candidate.hits >= MIN_JD_FAMILY_HITS)
      .sort((a, b) => b.hits - a.hits || a.order - b.order)[0];
    if (best) add(best.family, best.hits, "job_description", []);
  }

  if (!selected.length) add(FAMILY_BY_ID.get("general") as RoleFamily, 0, "fallback", []);
  return selected;
}

/** Curated LinkedIn trends for a target role, blended across its matched families. */
export function curatedTrends(targetRole: unknown, jobDescription?: unknown): LinkedInTrends {
  const matches = matchRoleFamilies(targetRole, jobDescription);
  const skills: TrendSkill[] = [];
  const keys = new Set<string>();
  const names = new Set<string>();
  matches.forEach((match, rank) => {
    const family = FAMILY_BY_ID.get(match.id);
    const cap = FAMILY_RANK_CAPS[rank] ?? 0;
    let added = 0;
    for (const skill of family?.skills || []) {
      if (added >= cap || skills.length >= MAX_TREND_SKILLS) break;
      const nameKey = trendNameKey(skill.name);
      if ((skill.key && keys.has(skill.key)) || names.has(nameKey)) continue;
      skills.push(cloneSkill(skill));
      if (skill.key) keys.add(skill.key);
      names.add(nameKey);
      added += 1;
    }
  });
  return {
    method: TREND_METHOD,
    role_family: matches[0].id,
    families: matches.map((match) => match.id),
    label: matches.map((match) => match.label).join(" + "),
    target_role: asText(targetRole).trim().slice(0, 160),
    as_of: CURATED_TRENDS_REVIEWED,
    skills,
  };
}

/**
 * The trend list for one optimization run, or null when the candidate has
 * trends switched off. Only a literal `true` switches them on (request bodies
 * are untrusted), so an absent flag reproduces the trend-free pipeline exactly.
 */
export function activeLinkedInTrends(enabled: unknown, targetRole: unknown, jobDescription?: unknown): LinkedInTrends | null {
  if (enabled !== true) return null;
  const trends = curatedTrends(targetRole, jobDescription);
  return trends.skills.length > 0 ? trends : null;
}

/** The role families known to the catalogue, for display and tests. */
export function trendFamilies(): Array<{ id: string; label: string; platform?: string; skills: string[] }> {
  return ROLE_FAMILIES.map((family) => ({
    id: family.id,
    label: family.label,
    ...(family.platform ? { platform: family.platform } : {}),
    skills: family.skills.map((skill) => skill.name),
  }));
}

/** Every curated skill (copies), for display and tests. */
export function trendCatalogue(): TrendSkill[] {
  return Object.values(SKILLS).map(cloneSkill);
}

/* ------------------------------------------------------------------ *
 * Normalisation
 * ------------------------------------------------------------------ */

function cleanLine(value: unknown, max: number): string {
  return asText(value)
    .replace(/[\u0000-\u001f\u007f]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, max);
}

function sanitizeKey(value: unknown): string {
  const key = asText(value).trim().toLowerCase();
  return /^[a-z0-9][a-z0-9-]{0,39}$/.test(key) ? key : "";
}

/** "YYYY-MM" or "YYYY-MM-DD", or "" when the value is not such a date. */
export function sanitizeTrendDate(value: unknown): string {
  const match = /^(\d{4})-(\d{2})(?:-(\d{2}))?/.exec(asText(value).trim());
  if (!match) return "";
  const month = Number(match[2]);
  const day = match[3] ? Number(match[3]) : 1;
  if (month < 1 || month > 12 || day < 1 || day > 31) return "";
  return match[3] ? `${match[1]}-${match[2]}-${match[3]}` : `${match[1]}-${match[2]}`;
}

/**
 * Clean a skill list that crossed a trust boundary (a stored report). List
 * markers are stripped and parentheticals become aliases ("Microsoft Entra ID
 * (Azure AD)"); banned terms are dropped.
 */
export function normalizeTrendSkills(raw: unknown): TrendSkill[] {
  const list: unknown[] = Array.isArray(raw)
    ? raw
    : raw && typeof raw === "object" && Array.isArray((raw as any).skills)
      ? (raw as any).skills
      : [];
  const out: TrendSkill[] = [];
  const seen = new Set<string>();
  for (const item of list.slice(0, 200)) {
    const record = item && typeof item === "object" && !Array.isArray(item) ? (item as Record<string, unknown>) : null;
    const rawName = typeof item === "string" ? item : asText(record?.name ?? record?.skill ?? record?.title);
    const stripped = cleanLine(rawName, 200).replace(/^(?:[-*\u2022]+|\d+[.)])\s*/, "");
    if (!stripped || BANNED_TREND_TERMS.test(stripped)) continue;
    const inner = Array.from(stripped.matchAll(/\(([^)]*)\)/g)).flatMap((match) => match[1].split(/[/,]/));
    const name = stripped.replace(/\([^)]*\)/g, " ").replace(/\s+/g, " ").replace(/[\s,;:]+$/, "").trim();
    if (name.length < 2 || name.length > 60 || !/[a-z]/i.test(name)) continue;
    const nameKey = trendNameKey(name);
    if (!nameKey || seen.has(nameKey)) continue;

    const listOf = (value: unknown) => (Array.isArray(value) ? value : []);
    const aliases = unique([...listOf(record?.aliases), ...listOf(record?.synonyms), ...inner].map(normalizeTerm))
      .filter((alias) => isUsableTerm(alias) && trendNameKey(alias) !== nameKey)
      .slice(0, 24);
    const skill: TrendSkill = { name, aliases };
    const key = sanitizeKey(record?.key);
    if (key) skill.key = key;
    const evidence = unique(listOf(record?.evidence).map(normalizeTerm)).filter(isUsableTerm).slice(0, 40);
    if (evidence.length) skill.evidence = evidence;
    out.push(skill);
    seen.add(nameKey);
  }
  return out;
}

/** Validate trends that crossed a trust boundary (a stored report). */
export function normalizeLinkedInTrends(raw: unknown): LinkedInTrends | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const record = raw as Record<string, unknown>;
  const skills = normalizeTrendSkills(record.skills).slice(0, MAX_TREND_SKILLS);
  if (!skills.length) return null;
  const families = unique((Array.isArray(record.families) ? record.families : []).map(sanitizeKey).filter(Boolean)).slice(0, 3);
  const roleFamily = sanitizeKey(record.role_family) || families[0] || "general";
  const market = readMarketMetadata(record.market);
  if (record.method === MARKET_TREND_METHOD && !market) return null;
  return {
    method: market ? MARKET_TREND_METHOD : TREND_METHOD,
    role_family: roleFamily,
    families: families.length ? families : [roleFamily],
    label: cleanLine(record.label, 120) || FAMILY_BY_ID.get(roleFamily)?.label || "Target role",
    target_role: cleanLine(record.target_role, 160),
    as_of: sanitizeTrendDate(record.as_of) || CURATED_TRENDS_REVIEWED,
    skills,
    ...(market ? { market } : {}),
  };
}

/* ------------------------------------------------------------------ *
 * Evidence
 * ------------------------------------------------------------------ */

/** Keys whose values are reports, metadata or labels rather than the candidate's own material. */
const NON_EVIDENCE_KEYS = new Set([
  "personal_info", "ats_keywords_from_jd", "ats_keywords_added_to_resume", "keyword_gap", "improvement_notes",
  "audience_alignment_notes", "rejection_reasons", "audit_report", "linkedin_trends", "bullet_budget_report",
  "audience_coverage", "star_stories", "match_score", "baseline_score", "match_analysis", "score_breakdown", "impact_audit",
  "why_this_job", "company", "location", "duration", "dates", "institution", "id",
]);

function collectText(value: unknown, out: string[], depth = 0): void {
  if (value == null || depth > 8) return;
  if (typeof value === "string") {
    if (value.trim()) out.push(value);
  } else if (Array.isArray(value)) {
    for (const item of value) collectText(item, out, depth + 1);
  } else if (typeof value === "object") {
    for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
      if (key.startsWith("_") || NON_EVIDENCE_KEYS.has(key)) continue;
      collectText(item, out, depth + 1);
    }
  }
}

/**
 * The candidate's material as one text: source resume, master resume, notes.
 * JSON (objects or JSON strings) counts by its values only - key names such as
 * "observability" in a schema are not evidence - and report keys are skipped.
 * Material using a banned term also evidences BANNED_TERM_REPLACEMENTS.
 */
export function trendEvidenceText(...sources: unknown[]): string {
  const parts: string[] = [];
  for (const source of sources) {
    if (typeof source === "string") {
      const trimmed = source.trim();
      if (!trimmed) continue;
      if (trimmed.startsWith("{") || trimmed.startsWith("[")) {
        try {
          collectText(JSON.parse(trimmed), parts);
          continue;
        } catch {
          // Not JSON: read it as plain text.
        }
      }
      parts.push(source);
    } else if (source && typeof source === "object") {
      collectText(source, parts);
    }
  }
  if (parts.some((part) => BANNED_TREND_TERMS.test(part))) parts.push(BANNED_TERM_REPLACEMENTS.join("\n"));
  return parts.join("\n");
}

/** What a reader sees in a generated resume: summary, skills (with category names), role titles and bullets, projects, certifications, education. */
export function resumeVisibleText(resume: any): string {
  if (!resume || typeof resume !== "object") return "";
  const parts: string[] = [];
  collectText(resume.summary, parts);
  if (resume.skills && typeof resume.skills === "object" && !Array.isArray(resume.skills)) {
    parts.push(...Object.keys(resume.skills).filter((key) => !key.startsWith("_")));
  }
  collectText(resume.skills, parts);
  for (const role of Array.isArray(resume.experience) ? resume.experience : []) {
    if (!role || typeof role !== "object") continue;
    collectText(role.role ?? role.title, parts);
    collectText(role.bullets, parts);
    collectText(role.description, parts);
  }
  collectText(resume.projects, parts);
  collectText(resume.certifications, parts);
  collectText(resume.education, parts);
  return parts.join("\n");
}

/** Per skill, the terms in `evidenceText` that prove it (plain matching: "AKS" in the source proves Azure). */
function skillEvidence(skills: TrendSkill[], evidenceText: string): string[][] {
  return skills.map((skill) => (evidenceText ? unique(findTerms(evidenceText, trendEvidenceTerms(skill))) : []));
}

/** Per skill, the terms in `text` that name it; a term inside a longer term of another skill does not count. */
function skillMentions(skills: TrendSkill[], text: string): string[][] {
  const found: string[][] = skills.map(() => []);
  for (const span of findOwnedSpans(text, skills.map(trendSkillTerms))) found[span.owner].push(span.term);
  return found.map((terms) => unique(terms));
}

/** The trending skills the candidate's material supports, in trend order. */
export function evidencedTrendSkills(trends: LinkedInTrends | null | undefined, evidenceText: string): TrendSkill[] {
  const skills = trends?.skills || [];
  const evidence = skillEvidence(skills, evidenceText);
  return skills.filter((_, i) => evidence[i].length > 0);
}

/* ------------------------------------------------------------------ *
 * Coverage report
 * ------------------------------------------------------------------ */

export interface TrendCoverageOptions {
  /** The candidate's source resume (plain text, JSON text or an object). */
  sourceText?: unknown;
  /** More candidate material: master resume, profile text, notes. */
  extraEvidence?: unknown[];
}

/** Separators and conjunctions left after the trending names are cut out of a skills entry. */
const CONNECTIVES = /[\s,/&|;:()+.\-]+|\b(?:and|or)\b/gi;

/** The entry with the given spans blanked out and separators dropped; "" when it named only those skills. */
function remainderAfter(entry: string, spans: OwnedSpan[]): string {
  const covered = new Array<boolean>(entry.length).fill(false);
  for (const span of spans) for (let i = span.start; i < span.end; i++) covered[i] = true;
  let rest = "";
  for (let i = 0; i < entry.length; i++) rest += covered[i] ? " " : entry[i];
  return rest.replace(CONNECTIVES, " ").trim();
}

function skillEntryText(entry: unknown): string {
  if (typeof entry === "string") return entry;
  if (entry && typeof entry === "object") return asText((entry as any).name ?? (entry as any).skill);
  return "";
}

/** Every entry of the skills section, whatever its shape (list, categories, comma-separated text). */
function skillEntries(skills: unknown): string[] {
  const split = (text: string) => text.split(",").map((part) => part.trim()).filter(Boolean);
  if (typeof skills === "string") return split(skills);
  if (Array.isArray(skills)) return skills.map(skillEntryText).filter((text) => text.trim());
  if (skills && typeof skills === "object") {
    return Object.entries(skills as Record<string, unknown>)
      .filter(([key]) => !key.startsWith("_"))
      .flatMap(([, items]) => (typeof items === "string" ? split(items) : skillEntries(Array.isArray(items) ? items : [])));
  }
  return [];
}

/**
 * Drop skills-section entries that consist only of trending names the
 * candidate's material does not support ("Terraform" goes; "Bash, Terraform"
 * and "Azure & Terraform" stay). Categories left empty are removed so the
 * renderer never shows a bare heading. Returns the removed entries.
 */
function pruneUnsupportedSkillEntries(resume: any, skills: TrendSkill[], evidenced: boolean[]): string[] {
  const removed: string[] = [];
  const termLists = skills.map(trendSkillTerms);
  const keep = (entry: unknown): boolean => {
    const text = skillEntryText(entry).trim();
    if (!text) return true;
    const spans = findOwnedSpans(text, termLists);
    if (!spans.length || spans.some((span) => evidenced[span.owner]) || remainderAfter(text, spans)) return true;
    removed.push(text);
    return false;
  };
  const pruneText = (text: string): string | null => {
    const parts = text.split(",").map((part) => part.trim()).filter(Boolean);
    const kept = parts.filter(keep);
    if (kept.length === parts.length) return text;
    return kept.length ? kept.join(", ") : null;
  };

  const field = resume.skills;
  if (Array.isArray(field)) {
    const kept = field.filter(keep);
    if (kept.length !== field.length) resume.skills = kept;
  } else if (typeof field === "string") {
    const kept = pruneText(field);
    if (kept !== field) resume.skills = kept ?? "";
  } else if (field && typeof field === "object") {
    for (const [category, items] of Object.entries(field as Record<string, unknown>)) {
      if (category.startsWith("_")) continue;
      if (Array.isArray(items)) {
        const kept = items.filter(keep);
        if (kept.length === items.length) continue;
        if (kept.length) field[category] = kept;
        else delete field[category];
      } else if (typeof items === "string") {
        const kept = pruneText(items);
        if (kept === items) continue;
        if (kept) field[category] = kept;
        else delete field[category];
      }
    }
  }
  return removed;
}

function priorEntries(report: unknown): TrendCoverageEntry[] {
  const entries = report && typeof report === "object" && Array.isArray((report as any).entries) ? (report as any).entries : [];
  return entries.filter((entry: any) => entry && typeof entry === "object" && typeof entry.name === "string");
}

function stringList(value: unknown, max: number): string[] {
  return (Array.isArray(value) ? value : []).map((item) => cleanLine(item, 120)).filter(Boolean).slice(0, max);
}

/**
 * Which trending skills the resume uses, could use, or should not claim.
 * `prior` is an earlier report for the same resume: its evidence still counts
 * when this pass has less source material. Mutates `resume.skills` (prunes
 * unsupported entries) only when fresh source material is available.
 */
export function computeTrendCoverage(
  resume: any,
  trends: LinkedInTrends,
  options: TrendCoverageOptions = {},
  prior?: unknown
): TrendCoverageReport {
  const skills = trends.skills.slice(0, MAX_TREND_SKILLS);
  const extra = Array.isArray(options.extraEvidence) ? options.extraEvidence : [];
  const evidenceText = trendEvidenceText(options.sourceText, ...extra);
  const previous = priorEntries(prior);
  const previousFor = (skill: TrendSkill) =>
    previous.find((entry) => (skill.key && entry.key === skill.key) || trendNameKey(entry.name) === trendNameKey(skill.name));

  let evidence = skillEvidence(skills, evidenceText).map((terms, i) =>
    unique([...terms, ...stringList(previousFor(skills[i])?.evidence, 8)]).slice(0, 8)
  );
  let evidenced = evidence.map((terms) => terms.length > 0);
  if (!evidenceText.trim() && !evidenced.some(Boolean)) {
    // No candidate material at all: judge by the resume itself, but record no evidence
    // terms, so a later pass with real source material is not misled by them.
    evidenced = skillEvidence(skills, resumeVisibleText(resume)).map((terms) => terms.length > 0);
    evidence = skills.map(() => []);
  }

  const removedNow = evidenceText.trim() && resume && typeof resume === "object"
    ? pruneUnsupportedSkillEntries(resume, skills, evidenced)
    : [];
  const present = new Set(skillEntries(resume?.skills).map((entry) => entry.toLowerCase()));
  const termLists = skills.map(trendSkillTerms);
  const carried = stringList((prior as any)?.removed, 32).filter((entry) => {
    if (present.has(entry.toLowerCase())) return false;
    const spans = findOwnedSpans(entry, termLists);
    return spans.length > 0 && !spans.some((span) => evidenced[span.owner]);
  });

  const found = skillMentions(skills, resumeVisibleText(resume));
  const entries: TrendCoverageEntry[] = skills.map((skill, i) => {
    const named = found[i].length > 0;
    const status: TrendStatus = evidenced[i] ? (named ? "used" : "available") : named ? "unsupported" : "gap";
    const entry: TrendCoverageEntry = {
      name: skill.name,
      ...(skill.key ? { key: skill.key } : {}),
      aliases: [...skill.aliases],
      ...(skill.evidence && skill.evidence.length ? { evidence_terms: [...skill.evidence] } : {}),
      status,
      evidence: evidence[i],
      found: found[i].slice(0, 8),
    };
    return entry;
  });
  const named = (status: TrendStatus) => entries.filter((entry) => entry.status === status).map((entry) => entry.name);
  const used = named("used");
  const available = named("available");

  const report: TrendCoverageReport = {
    method: TREND_COVERAGE_METHOD,
    trend_method: trends.method || TREND_METHOD,
    role_family: trends.role_family,
    families: [...trends.families],
    label: trends.label,
    target_role: trends.target_role,
    as_of: trends.as_of,
    ...(trends.market ? { market: trends.market } : {}),
    entries,
    used,
    available,
    gaps: named("gap"),
    unsupported: named("unsupported"),
    removed: unique([...removedNow, ...carried]),
    coverage: used.length + available.length ? Math.round((used.length / (used.length + available.length)) * 100) : null,
  };
  return report;
}

/** The trend list a stored report was built from, so coverage can be re-applied after edits or a second finalize. */
export function trendsFromReport(report: unknown): LinkedInTrends | null {
  if (!report || typeof report !== "object" || Array.isArray(report)) return null;
  const record = report as Record<string, unknown>;
  const entries = priorEntries(report);
  return normalizeLinkedInTrends({
    ...record,
    skills: entries.map((entry) => ({
      key: entry.key,
      name: entry.name,
      aliases: entry.aliases,
      evidence: entry.evidence_terms,
    })),
  });
}

/**
 * Attach resume.linkedin_trends. `trends` undefined re-uses the resume's
 * existing report; null removes it. Never throws: coverage is a report, and a
 * failure leaves the resume as it was (minus a stale report). An existing
 * report counts only when it is one of ours: a `linkedin_trends` object the
 * model wrote itself must not lend its "evidence" to the next pass.
 */
export function applyTrendCoverage(resume: any, trends: LinkedInTrends | null | undefined, options: TrendCoverageOptions = {}): any {
  if (!resume || typeof resume !== "object") return resume;
  try {
    if (trends === null) {
      delete resume.linkedin_trends;
      return resume;
    }
    const existing = resume.linkedin_trends;
    const prior = existing && typeof existing === "object" && existing.method === TREND_COVERAGE_METHOD ? existing : undefined;
    const effective = trends ? normalizeLinkedInTrends(trends) : trendsFromReport(prior);
    if (!effective) {
      delete resume.linkedin_trends;
      return resume;
    }
    resume.linkedin_trends = computeTrendCoverage(resume, effective, options, prior);
  } catch (e: any) {
    console.warn("[linkedinTrends] Trend coverage failed; returning document without it:", e?.message || e);
    delete resume.linkedin_trends;
  }
  return resume;
}

/* ------------------------------------------------------------------ *
 * Prompt briefs, validation and ranking helpers
 * ------------------------------------------------------------------ */

const BRIEF_DOCUMENT_MAX = 16;
const BRIEF_ROLE_MAX = 10;
const PREFER_TERMS_MAX = 80;

/** One line naming where the trend list came from, for prompts and the report UI. */
export function describeTrendSource(trends: LinkedInTrends | null | undefined): string {
  if (!trends) return "";
  if (trends.market) {
    const m = trends.market;
    return `Adzuna job-market demand for ${trends.label}; ${m.sample_size} sampled posting snippets across ${m.countries.join(", ")}; refreshed ${m.refreshed_at}${m.stale ? " (STALE)" : ""}`;
  }
  return `Curated skill catalogue for ${trends.label || "the target role"} (labelled ${trends.as_of || CURATED_TRENDS_REVIEWED}; not live data)`;
}

/** Stable text that changes whenever the trend list does (for cache keys). */
export function trendFingerprint(trends: LinkedInTrends | null | undefined): string {
  if (!trends || !trends.skills.length) return "none";
  return [trends.market?.refreshed_at || trends.as_of, trends.families.join("+"), trends.skills.map((skill) => trendNameKey(skill.name)).join("|")].join(":");
}

export interface TrendBriefOptions {
  /** "document" for a whole-resume prompt, "role" for one experience entry. */
  scope?: "document" | "role";
  /** Candidate material; for the role scope, the role's own source text. */
  evidenceText?: string;
  /** Role scope only: the rest of the candidate's material (skills list, certifications). */
  secondaryEvidenceText?: string;
}

/**
 * Prompt instructions that steer the model toward trending names the
 * candidate's material supports. Unsupported trends are deliberately not
 * listed, so the prompt never primes the model to add them.
 */
export function buildTrendBrief(trends: LinkedInTrends | null | undefined, options: TrendBriefOptions = {}): string {
  if (!trends || !trends.skills.length) return "";
  const skills = trends.skills.slice(0, MAX_TREND_SKILLS);
  const label = trends.label || "the target role";
  const evidence = skillEvidence(skills, asText(options.evidenceText));

  if (options.scope === "role") {
    const secondary = skillEvidence(skills, asText(options.secondaryEvidenceText));
    const own = skills.filter((_, i) => evidence[i].length > 0).slice(0, BRIEF_ROLE_MAX);
    const listed = skills.filter((_, i) => !evidence[i].length && secondary[i].length > 0).slice(0, BRIEF_ROLE_MAX);
    if (!own.length && !listed.length) {
      return [
        `JOB-MARKET SKILLS (${label}):`,
        "- This role's source shows none of the trending skills. Do not name any trending skill, tool or platform the source does not show.",
      ].join("\n");
    }
    const lines = [`JOB-MARKET SKILLS (${label}) - use these evidenced names:`];
    if (own.length) {
      lines.push(`- Shown in this role's source - use the exact name when a bullet covers that work: ${own.map((skill) => skill.name).join(", ")}.`);
    }
    if (listed.length) {
      lines.push(
        `- In the candidate's skills but not shown in this role - name one only if this role's source describes that work and it fits the role's dates: ${listed.map((skill) => skill.name).join(", ")}.`
      );
    }
    lines.push("- Do not name any other trending skill, tool or platform in this role.");
    return lines.join("\n");
  }

  const supported = skills
    .map((skill, i) => ({ skill, terms: evidence[i] }))
    .filter((item) => item.terms.length > 0)
    .slice(0, BRIEF_DOCUMENT_MAX);
  const header = `JOB-MARKET SKILL ALIGNMENT (${describeTrendSource(trends)}):`;
  if (!supported.length) {
    return [
      header,
      "- None of the listed market skills appear in the candidate's material. Do not add them; the candidate sees them as gaps to close.",
    ].join("\n");
  }
  const lines = [
    header,
    "The candidate's material supports these market skills - use their exact names:",
    ...supported.map(({ skill, terms }) => {
      const shown = terms.filter((term) => trendNameKey(term) !== trendNameKey(skill.name)).slice(0, 3);
      return `- ${skill.name}${shown.length ? ` (source shows: ${shown.join(", ")})` : ""}`;
    }),
    "RULES:",
    "- SKILLS: include these trending names (most relevant to the target role first) alongside the candidate's other skills.",
    "- SUMMARY: name the 3-5 trending skills that best fit the target role.",
    "- BULLETS: use a trending name only in a role whose source shows that skill; never move a skill to a role or period that does not show it.",
    "- Do not add any other skill, tool, platform or certification that is not in the candidate's material, even if it is trending.",
  ];
  return lines.join("\n");
}

export interface UnsupportedTrendMention {
  name: string;
  terms: string[];
}

/** Trending skills named in `text` that `evidenceText` does not support (for output validation). */
export function unsupportedTrendMentions(
  text: unknown,
  trends: LinkedInTrends | null | undefined,
  evidenceText: unknown
): UnsupportedTrendMention[] {
  const skills = trends?.skills || [];
  const body = asText(text);
  if (!skills.length || !body.trim()) return [];
  const evidence = skillEvidence(skills, asText(evidenceText));
  const mentions = skillMentions(skills, body);
  return skills
    .map((skill, i) => ({ name: skill.name, terms: mentions[i], supported: evidence[i].length > 0 }))
    .filter((item) => item.terms.length > 0 && !item.supported)
    .map(({ name, terms }) => ({ name, terms }));
}

/** Terms of the supported trending skills, for ranking bullets when a budget forces cuts. */
export function trendPreferTerms(trends: LinkedInTrends | null | undefined, evidenceText: unknown): string[] {
  const supported = evidencedTrendSkills(trends, asText(evidenceText));
  return unique(supported.flatMap(trendEvidenceTerms)).slice(0, PREFER_TERMS_MAX);
}
