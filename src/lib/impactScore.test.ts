import { test } from "node:test";
import assert from "node:assert/strict";
import {
  applyImpactAudit, computeImpactScore, describeImpactScore, findUnsupportedFigures, inspectBullet, linkStarStories,
  resumeForAudit,
} from "./impactScore";
import { namedTechnologies } from "./matchScore";

/** One test per check, so a failure names exactly the behaviour that broke. */
const check = (name: string, ok: boolean, info: unknown = "") =>
  test(name, () => assert.ok(ok, ok ? undefined : JSON.stringify(info)));

const role = (roleName: string, company: string, bullets: string[]) => ({ role: roleName, company, duration: "Jan 2021 - Present", bullets });

// Strong FAANG/STAR-grade resume: varied shapes, ~1 in 3 quantified, named systems, linked stories.
const strong: any = {
  experience: [
    role("Cloud Infrastructure Engineer", "Fabrikam", [
      "Cut Azure landing-zone provisioning from 9 days to 4 hours by codifying subscriptions, policies and networking in Terraform modules",
      "Built a PowerShell drift report for Intune compliance policies, ending the monthly manual audit the service desk ran",
      "Designed hub-and-spoke ExpressRoute connectivity for 3 regional offices after the site VPNs dropped during payroll runs",
      "Migrated 214 Windows Server VMs to Azure with Azure Migrate, retiring the leased Mumbai data center",
      "Hardened Entra ID with Conditional Access and MFA, closing the legacy-auth gap flagged in the ISO 27001 audit",
    ]),
    role("Systems Engineer", "Northwind", [
      "Automated user onboarding in Active Directory with PowerShell, so new joiners received accounts before day one",
      "Replaced ad-hoc backups with Veeam jobs and tested restores, preventing a repeat of the 2019 file-server data loss",
      "Diagnosed recurring Exchange outages to a misconfigured load balancer and fixed the health probes",
    ]),
  ],
};
strong.star_stories = [
  {
    bullet: strong.experience[0].bullets[0],
    competency: "Deliver Results",
    question: "Tell me about a time you made a slow process much faster.",
    situation: "New business units waited over a week for an Azure environment.",
    task: "I owned the landing-zone build for every new subscription.",
    action: "I mapped every manual step, codified subscriptions, policies and hub networking as Terraform modules, added plan reviews, and trained two engineers to run it.",
    result: "Provisioning dropped from 9 days to 4 hours.",
    learning: "Codify the review step too, not only the build.",
  },
  {
    bullet: strong.experience[1].bullets[2],
    competency: "Dive Deep",
    question: "Tell me about a hard problem you debugged.",
    situation: "Exchange went down several times a week.",
    task: "I was asked to find the root cause.",
    action: "I correlated outage times with load balancer logs, reproduced the failure in a lab, and found the health probe was checking the wrong endpoint, then I fixed and documented the probe configuration.",
    result: "The outages stopped.",
    learning: "Check the monitoring path before the monitored system.",
  },
];
const strongSource = JSON.stringify(strong) + "\nprovisioning took 9 days, now 4 hours; 214 VMs; 3 offices";
const strongAudit = computeImpactScore(JSON.parse(JSON.stringify(strong)), { sourceText: strongSource })!;

const duties = {
  experience: [
    role("IT Officer", "Acme", [
      "Responsible for day-to-day IT support for various users",
      "Worked on server maintenance and backups as needed",
      "Helped with network issues and printer problems",
      "Managing the helpdesk queue and vendor calls",
      "Participated in the office move project",
      "Involved in procurement of laptops",
    ]),
  ],
};
const dutyAudit = computeImpactScore(duties, { expectStarStories: false })!;

const overQuant = {
  experience: [
    role("Engineer", "X", [
      "Improved deployment speed by 50% using Kubernetes",
      "Reduced costs by 30% through Terraform automation",
      "Increased uptime by 20% with Prometheus alerting",
      "Cut incident volume by 40% via runbooks in Confluence",
      "Boosted team velocity by 25% using Jira workflows",
      "Saved $100K annually by consolidating AWS accounts",
    ]),
  ],
};
const overAudit = computeImpactScore(overQuant, { sourceText: "Engineer at X. Kubernetes, Terraform, Prometheus, Jira, AWS.", expectStarStories: false })!;

const skeleton = {
  experience: [
    role("Engineer", "Y", [
      "Implemented Azure Monitor to improve visibility",
      "Implemented Azure Policy to improve compliance",
      "Implemented Azure Backup to improve resilience",
      "Implemented Azure Firewall to improve security",
      "Implemented Azure DevOps to improve delivery",
      "Implemented Azure Bastion to improve access",
    ]),
  ],
};
const skelAudit = computeImpactScore(skeleton, { expectStarStories: false })!;

const versions = {
  experience: [
    role("Systems Administrator", "Z", [
      "Deployed Windows 11 to the finance team with Intune Autopilot",
      "Administered Microsoft 365 and Exchange Online mail flow rules",
      "Prepared the evidence pack for the ISO 27001 certification audit",
      "Upgraded domain controllers to Windows Server 2022 and retired Server 2012 R2",
      "Passed the AZ-104 exam and applied it to the Azure Site Recovery design",
      "Configured SOC 2 logging controls in Microsoft Sentinel",
    ]),
  ],
};
const verAudit = computeImpactScore(versions, { expectStarStories: false })!;

check("version numbers are not measurements (Windows 11, Microsoft 365, ISO 27001, AZ-104, SOC 2)", verAudit.quantified_ratio === 0, verAudit.quantified_ratio);
check("strong resume scores high (>= 80)", strongAudit.score >= 80, strongAudit.score);
check("duty-listing resume scores low (<= 35)", dutyAudit.score <= 35, dutyAudit.score);
check("over-quantified resume flags metric density", overAudit.findings.some((f) => f.id === "metric_density"));
check("over-quantified resume flags unverified figures", overAudit.findings.some((f) => f.id === "unverified_figure"));
check("over-quantified resume flags round numbers", overAudit.findings.some((f) => f.id === "round_number"));
check("over-quantified resume scores below strong", overAudit.score < strongAudit.score, { over: overAudit.score, strong: strongAudit.score });
check("repeated skeleton / lead verb flagged", skelAudit.findings.some((f) => f.id === "repeated_skeleton" || f.id === "repeated_lead_verb"), skelAudit.findings.map((f) => f.id));
check("', so <consequence>' counts as an outcome", inspectBullet("Automated onboarding with PowerShell, so new joiners had accounts on day one").outcome);
check("'load balancer' and 'Veeam' are named systems", inspectBullet("Fixed the load balancer health probes").specific && inspectBullet("Replaced ad-hoc copies with Veeam jobs").specific);
check("repeated skeleton scores below strong", skelAudit.score < strongAudit.score - 15, skelAudit.score);
check("strong resume: every figure verified", strongAudit.unverified_figure_bullets === 0, strongAudit.findings.filter((f) => f.id === "unverified_figure"));
check("strong resume: both STAR stories linked", strongAudit.star_linked === 2, strongAudit.star_linked);
check("strong resume: STAR grounding is a scored component", strongAudit.components.some((c) => c.id === "star_grounding"));
check("source resume audit omits the STAR component", !dutyAudit.components.some((c) => c.id === "star_grounding") && dutyAudit.star_expected === false);
check("component weights sum to 1", Math.abs(strongAudit.components.reduce((s, c) => s + c.weight, 0) - 1) < 0.02, strongAudit.components.map((c) => c.weight));
check("deterministic", JSON.stringify(computeImpactScore(JSON.parse(JSON.stringify(strong)), { sourceText: strongSource })) === JSON.stringify(strongAudit));
check("the description names every component", strongAudit.components.every((c) => describeImpactScore(strongAudit).includes(c.label)));

const q = (t: string) => inspectBullet(t).quantified;
check("'1,200 users' is quantified", q("Supported 1,200 users across 3 sites"));
check("'340 VMs' is quantified", q("Migrated 340 VMs to Azure"));
check("'from 14 to 3 days' is quantified", q("Reduced patch lead time from 14 to 3 days"));
check("'team of 6' is quantified", q("Mentored a team of 6 analysts"));
check("'38%' is quantified", q("Reduced p99 latency by 38% by caching tokens"));
check("'$40K' and '2.5M' are quantified", q("Saved $40K by rightsizing") && q("Processed 2.5M records nightly"));
check("'doubled' is quantified", q("Doubled build throughput by parallelising tests"));
check("'24x7' / '24/7' is not quantified", !q("Provided 24x7 on-call cover") && !q("Ran 24/7 monitoring with Nagios"));
check("'Windows 10/11' is not quantified", !q("Upgraded laptops from Windows 10 to Windows 11"));
check("'Dynamics 365' is not quantified", !q("Administered Dynamics 365 for the sales team"));
check("'400-person org' is quantified", q("Rolled out MFA across a 400-person org"));
check("'Python', 'Terraform', 'Excel' are named systems", inspectBullet("Automated reports in Python and Excel").specific && inspectBullet("Built modules in Terraform").specific);
check("practices alone are not named systems", !inspectBullet("Automated monitoring and troubleshooting for the team").specific, namedTechnologies("Automated monitoring and troubleshooting for the team"));
check("lead verb ignores bullet glyph", inspectBullet("• Migrated 30 servers to Azure").strongLead);
check("'Experienced engineer...' is not an action lead", !inspectBullet("Experienced engineer with Azure skills").strongLead);
check("'Trained 40 new hires' is an action lead", inspectBullet("Trained 40 new hires on ServiceNow").strongLead);
check("'pending' is not an outcome", !inspectBullet("Tracked pending tickets in ServiceNow daily").outcome);
check("'ending the manual audit' is an outcome", inspectBullet("Built a drift report, ending the manual audit").outcome);
check("'Spearheaded' is a banned lead", inspectBullet("Spearheaded the migration").bannedLead);
check("'I' and 'my' are first person", inspectBullet("I automated patching for my team").firstPerson && inspectBullet("Automated my team's patching").firstPerson);
check("Roman-numeral labels are not the pronoun ('Tier I', 'Phase I', 'Level I')",
  !inspectBullet("Provided Tier I and Tier II support for 400 users").firstPerson
  && !inspectBullet("Delivered Phase I of the data center migration").firstPerson
  && !inspectBullet("Handled Level I escalations for the service desk").firstPerson);
check("'I/O' and a real pronoun after a label are handled", !inspectBullet("Tuned storage I/O for the SQL cluster").firstPerson && inspectBullet("Closed Tier I tickets and I trained two new hires").firstPerson);

const roundOk = computeImpactScore(
  { experience: [role("E", "F", ["Cut cloud spend by 30% by rightsizing VMs", "Built Terraform modules for networking", "Automated patching with Azure Update Manager, ending weekend maintenance"])] },
  { sourceText: "Cut cloud spend by 30%", expectStarStories: false }
)!;
check("source-verified round figure is not flagged", !roundOk.findings.some((f) => f.id === "round_number"), roundOk.findings);
check("unsupported figure detected", findUnsupportedFigures("Cut costs by 38%", "costs went down a lot").includes("38%"));
check("source figure supported (scaled)", findUnsupportedFigures("Saved $2.5M", "saved 2,500,000 dollars").length === 0);

const linkDoc: any = {
  experience: [role("R", "C", ["Built a PowerShell drift report for Intune compliance policies, ending the manual audit", "Migrated 214 VMs to Azure", "Hardened Entra ID with Conditional Access"])],
  star_stories: [
    { bullet: "Built a PowerShell drift report for Intune compliance policies, ending the manual audit.", action: "I built it.", result: "Audit ended." },
    { bullet: "Migrated 214 VMs to Azure", action: "I migrated.", result: "Done." },
    { bullet: "Migrated 214 VMs to Azure", action: "Dup.", result: "Dup." },
    { bullet: "Led a global SAP rollout", action: "Invented.", result: "Invented." },
    { bullet: "Hardened Entra ID with Conditional Access", action: "", result: "x" },
  ],
};
const link = linkStarStories(linkDoc);
check("STAR: verbatim/trailing-punctuation stories linked, others dropped", link.kept === 2 && link.dropped === 3, link);
check("STAR: linked story gets role and exact bullet", linkDoc.star_stories[0].role === "R" && linkDoc.star_stories[0].bullet.endsWith("manual audit"), linkDoc.star_stories[0]);

const oddStoryDoc: any = {
  experience: [role("R", "C", ["Migrated 214 VMs to Azure with Azure Migrate"])],
  star_stories: [{ bullet: "Migrated 214 VMs to Azure with Azure Migrate", competency: { name: "Ownership" }, question: 42, action: ["I planned waves.", "I ran cutovers."], result: "Done.", follow_ups: "Why waves?", prep_gaps: [null, "the downtime window", 3] }],
};
linkStarStories(oddStoryDoc);
const oddStory = oddStoryDoc.star_stories[0];
check("STAR: malformed model fields are coerced to renderable text", oddStory && oddStory.competency === "" && oddStory.question === "42" && oddStory.action === "I planned waves. I ran cutovers." && JSON.stringify(oddStory.follow_ups) === '["Why waves?"]' && JSON.stringify(oddStory.prep_gaps) === '["the downtime window"]', oddStory);

const fromText = resumeForAudit("John\nExperience\n• Migrated 214 VMs to Azure with Azure Migrate\n- Python\n- Built Terraform modules for hub networking\n");
check("plain-text resume: bullet lines extracted, skill items skipped", fromText?.experience?.[0]?.bullets?.length === 2, fromText);
check("JSON with trailing text parsed", resumeForAudit('{"experience":[]}\n\nSkills: X')?.experience !== undefined);
check("nothing to audit returns null", resumeForAudit("just a sentence") === null);

test("odd shapes never throw", () => {
  const weird: any[] = [null, 42, "x", { experience: null }, { experience: [null, { bullets: [null, 3, { text: "Built a thing that matters a lot" }] }] }, { star_stories: "nope" }];
  for (const w of weird) {
    assert.doesNotThrow(() => { applyImpactAudit(w, { sourceText: "x" }); computeImpactScore(w); });
  }
});

for (const bullet of [
  "Aligned firewall rules with NIST 800-53 controls.",
  "Mapped Azure Policy to NIST CSF 2.0 controls.",
  "Upgraded Kubernetes 1.29 clusters on AKS.",
  "Rebuilt Node.js 20 services behind Front Door.",
  "Wrote PowerShell 7 scripts to automate user onboarding.",
  "Configured Jenkins 2 jobs for the release train.",
]) {
  const inspection = inspectBullet(bullet);
  check(`version number is not a measure or outcome: "${bullet}"`, !inspection.quantified && !inspection.outcome, inspection);
}
for (const bullet of [
  "Migrated 340 VMs to Azure",
  "Rolled out MFA to 1,200 users",
  "Led 6 engineers through the cutover",
  "Cut the nightly job by 2.5 hours",
  "Upgraded 45 Windows 11 laptops for finance",
]) {
  check(`real count still quantified: "${bullet}"`, inspectBullet(bullet).quantified);
}

const steps = "1. I inventoried licences. 2. I grouped them. 3. I ran the pilot. (4) Step 5: done";
check("enumerators are not figures", findUnsupportedFigures(steps, "nothing numeric").length === 0, findUnsupportedFigures(steps, "nothing numeric"));
check("a sentence-final figure is still checked", findUnsupportedFigures("Cut pages to 12. Then I wrote runbooks.", "no numbers").includes("12"));

const tenureDoc: any = {
  experience: [role("Cloud Engineer", "Contoso", ["Built Terraform modules for networking", "Hardened Entra ID with Conditional Access", "Automated patching with Azure Update Manager, ending weekend maintenance"])],
};
tenureDoc.experience[0].duration = "Jan 2023 - Apr 2026";
tenureDoc.star_stories = [{ bullet: "Built Terraform modules for networking", action: "Over my 40 months at Contoso I codified the hub network, reviewed every plan, and trained the team to run it.", result: "Networks were rebuilt from code in 3 years of use.", learning: "Next time I'd run a 2-week pilot first." }];
const tenureAudit = computeImpactScore(tenureDoc, { sourceText: JSON.stringify({ experience: [{ duration: "Jan 2023 - Apr 2026", bullets: tenureDoc.experience[0].bullets }] }) })!;
check("a story may state tenure derived from the source dates", !tenureAudit.findings.some((f) => f.id === "star_unverified_figure"), tenureAudit.findings.filter((f) => f.id === "star_unverified_figure"));
const tenureBullet = computeImpactScore({ experience: [role("E", "C", ["Ran on-call for 40 months across 3 regions", "Built Terraform modules", "Hardened Entra ID"])] }, { sourceText: "Jan 2023 - Apr 2026", expectStarStories: false })!;
check("bullets stay strict about tenure-like numbers", tenureBullet.findings.some((f) => f.id === "unverified_figure"), tenureBullet.findings);
