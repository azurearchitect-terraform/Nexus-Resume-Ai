import type { AtsDocument } from "../src/lib/atsDocument";

export const paginationFixture: AtsDocument = {
  personal_info: {
    name: "Morgan Candidate", location: "Hyderabad, Telangana, India", email: "morgan_candidate@example.org",
    phone: "+91-5550101234", linkedin: "https://linkedin.com/in/morgancandidate",
  },
  summary: "Strategic Azure Architect and Infrastructure Leader with 16+ years of enterprise experience. Specializes in Azure Landing Zones, FinOps, and high-availability design within hybrid cloud environments. Proven in establishing cross-functional engineering standards and leading infrastructure transformations through rigorous governance, observability practices, and capacity planning.",
  skills: {
    "Cloud Infrastructure": ["Microsoft Azure", "Azure Landing Zones", "Hybrid Cloud", "Hub-Spoke Networking", "Virtual Machines"],
    "Security & Governance": ["Azure Policy", "RBAC", "Microsoft Entra ID", "Cloud Governance", "Policy as Code"],
    "Operations & Observability": ["Azure Monitor", "Grafana", "Site Recovery", "HA/DR", "Business Continuity"],
    "Architecture & Strategy": ["FinOps", "Cloud Migration", "Capacity Planning", "ITIL", "Cross-Functional Leadership"],
  },
  experience: [
    { role: "Cloud & Collaboration Engineer II (Microsoft Engagement)", company: "Concentrix", duration: "Sep 2025 - Present", bullets: [
      "Architected enterprise-grade Azure landing zones to standardize governance patterns across 10+ customer environments.",
      "Designed HA/DR failover automation for business-critical systems, directly reducing RTO by 30%.",
      "Evaluated failure modes in hybrid topologies to harden system reliability, achieving a 25% improvement in uptime performance.",
      "Mentored a team of 20 engineers on Azure best practices and platform standards, increasing deployment velocity by 20%.",
      "Defined architecture assessment frameworks to identify and mitigate configuration drift in large-scale deployments.",
      "Partnered with cross-functional stakeholders to align infrastructure design with long-term platform roadmaps.",
    ] },
    { role: "Senior Ops Service Engineer - Azure", company: "M&M Software Development Centre India", duration: "Jan 2025 - Jul 2025", bullets: [
      "Built observability stacks utilizing Azure Monitor and Grafana to track system health, achieving a 40% reduction in MTTR.",
      "Implemented ITIL-compliant change management workflows for production environments to standardize release cycles.",
      "Executed FinOps frameworks by automating tagging governance to optimize Azure spend by 15%.",
      "Led a team of 5 infrastructure engineers in managing daily production stability and incident response.",
      "Refactored internal technical hiring workflows, resulting in a 25% increase in collective engineering capacity.",
      "Standardized operational runbooks for incident management and proactive capacity planning.",
    ] },
    { role: "Senior System Administrator (Azure)", company: "ARCHER Transnational Systems Pvt. Ltd.", duration: "Sep 2024 - Dec 2024", bullets: [
      "Designed secure hub-spoke network topologies to enhance fault isolation across multiple enterprise subscriptions.",
      "Governed disaster recovery testing cycles, ensuring 99.9% uptime compliance for critical business services.",
      "Optimized compute lifecycle management for 500+ virtual machines, reducing maintenance-related downtime by 25%.",
      "Hardened internal identity configurations to align with least-privilege access models.",
    ] },
    { role: "Senior Specialist - Azure Infrastructure", company: "HCLTech", duration: "Apr 2024 - Jun 2024", bullets: [
      "Evaluated Azure Landing Zones against the Well-Architected Framework to secure stakeholder approval for critical migration workstreams.",
      "Validated technical roadmaps for cloud transformation to ensure resource alignment, accelerating deployment milestones by 15%.",
    ] },
    { role: "Cloud Engineer - Azure", company: "Casepoint LLC", duration: "Mar 2022 - Apr 2024", bullets: [
      "Engineered infrastructure lifecycle management systems for 2500+ VMs across 5+ Azure subscriptions.",
      "Implemented policy-as-code and strict RBAC governance to scale Azure landing zones supporting enterprise growth.",
      "Delivered $200k+ annual cloud cost savings (approx 20%) through systematic FinOps resource optimization.",
      "Architected site recovery configurations that maintained business continuity during regional Azure outages.",
    ] },
    { role: "Senior Executive - IT", company: "Sterling Accuris Diagnostics", duration: "Jun 2017 - Feb 2022", bullets: [
      "Architected high-availability hybrid infrastructure, reducing operational downtime by 50%.",
      "Automated backup and disaster recovery workflows to ensure 100% data integrity for diagnostics workloads.",
    ] },
    { role: "Officer IT cum Logistics", company: "AGILUS Diagnostics", duration: "Jul 2013 - May 2017", bullets: [
      "Engineered enterprise AD and DNS migration to consolidate identity management for 300+ users.",
      "Optimized backup processes for onsite systems to ensure business resilience for critical diagnostic data.",
    ] },
    { role: "Customer Support Engineer", company: "Galaxy Office Automation Pvt. Ltd.", duration: "Aug 2012 - Jul 2013", bullets: [
      "Managed full-lifecycle server deployments and onsite technical support, achieving 98% SLA compliance for enterprise clients.",
    ] },
    { role: "Field Support Engineer", company: "Aegis Global", duration: "May 2010 - May 2012", bullets: [
      "Resolved enterprise-level service requests, maintaining a 95%+ consistent resolution rate.",
    ] },
  ],
  projects: [
    { title: "Enterprise Azure Migration & Modernization", description: "Led end-to-end migration of legacy workloads to Azure, focusing on performance, cost, and architectural resilience." },
    { title: "FinOps Cloud Governance Program", description: "Defined and implemented automated cost-tracking and governance policies, driving 20% savings across multi-subscription accounts." },
  ],
  certifications: ["Azure Solutions Architect Expert (AZ-305)", "Azure Administrator Associate (AZ-104)", "Azure Fundamentals (AZ-900)"],
  education: [{ degree: "Bachelor of Computer Applications (BCA)", institution: "Chandigarh University", expected_completion: "2027" }],
};
