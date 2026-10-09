import { test } from "node:test";
import assert from "node:assert/strict";
import { computeMatchScore, describeMatchScore } from "./matchScore";

/** One test per check, so a failure names exactly the behaviour that broke. */
const check = (name: string, ok: boolean, info: unknown = "") =>
  test(name, () => assert.ok(ok, ok ? undefined : JSON.stringify(info)));

const NOW = new Date(2026, 9, 8);

const JD = `Senior Cloud Infrastructure Engineer - Contoso - Bengaluru

About the Role
Contoso is looking for a Senior Cloud Infrastructure Engineer to run our Azure estate. Contoso engineers own production.

Responsibilities
- Design and operate Azure landing zones using Terraform and Bicep.
- Automate provisioning with PowerShell and Azure DevOps.
- Manage identity with Entra ID, Intune and Conditional Access.
- Monitor workloads with Azure Monitor and Log Analytics; lead incident response.

Requirements
- 5+ years of experience in cloud infrastructure.
- Strong hands-on experience with Azure, Terraform and PowerShell.
- Experience with Kubernetes (AKS) and Docker.
- Bachelor's degree in Computer Science or equivalent experience.
- Excellent communication skills.

Nice to have
- AZ-104 or AZ-305 certification.
- Experience with Python, Go, or Rust.

About Us
Contoso is a Kubernetes-first company. We offer health insurance and paid time off.
Contoso is an equal opportunity employer.`;

const strongResume = {
  personal_info: { name: "A", email: "a@b.com", summary: "Cloud Infrastructure Engineer with 7 years on Microsoft Azure." },
  skills: ["Azure", "Terraform", "Bicep", "PowerShell", "Azure DevOps", "Entra ID", "Intune", "AKS", "Docker", "Azure Monitor", "Log Analytics", "Python"],
  experience: [
    { id: "r1", role: "Cloud Infrastructure Engineer", company: "Fabrikam", duration: "Jan 2021 - Present", bullets: ["Built Azure landing zones with Terraform and Bicep", "Led incident response for production outages", "Automated provisioning with PowerShell"] },
    { id: "r2", role: "Systems Engineer", company: "Northwind", duration: "Mar 2018 - Dec 2020", bullets: ["Managed Intune and Entra ID for 3,000 users", "Communicated changes to stakeholders"] },
    { id: "r3", role: "Intern", company: "Northwind", duration: "Jun 2018 - Aug 2018", bullets: ["Overlapping internship"] },
  ],
  education: [{ degree: "B.Tech in Computer Science", institution: "VTU", expected_completion: "2017" }],
  certifications: [{ name: "AZ-104", issuer: "Microsoft", date: "2022" }],
};

const weakResume = {
  personal_info: { name: "B", summary: "Retail store manager." },
  skills: ["Customer Service", "Merchandising"],
  experience: [{ role: "Store Manager", company: "Shop", duration: "2023 - Present", bullets: ["Ran a retail store"] }],
  education: ["High School Diploma"],
};

const opts = { targetRole: "Senior Cloud Infrastructure Engineer", companyName: "Contoso", now: NOW };
const strong = computeMatchScore(strongResume, JD, opts)!;
const weak = computeMatchScore(weakResume, JD, opts)!;

check("strong resume scores high (>=75)", strong.score >= 75, strong.score);
check("weak resume scores low (<=25)", weak.score <= 25, weak.score);
check("deterministic", JSON.stringify(computeMatchScore(strongResume, JD, opts)) === JSON.stringify(strong));
check("JSON string input == object input", computeMatchScore(JSON.stringify(strongResume, null, 2), JD, opts)!.score === strong.score);
check("every component appears in the breakdown text", strong.components.every((c) => describeMatchScore(strong).includes(c.label)));
check("company name never a requirement", ![...strong.matchedKeywords, ...strong.missingKeywords].some((k) => /contoso/i.test(k)));
check("about-us 'Kubernetes-first' ignored but requirement Kubernetes kept", strong.matchedKeywords.includes("Kubernetes"));
check("Go and Rust detected from list", strong.missingKeywords.includes("Go") && strong.missingKeywords.includes("Rust"), strong.missingKeywords);
check("years parsed with overlap merged", strong.components.find((c) => c.id === "experience")!.detail.startsWith("8.7 yrs vs 5+"), strong.components);
check("education satisfied by B.Tech", strong.components.find((c) => c.id === "education")!.score === 100);
check("title exact match", strong.components.find((c) => c.id === "title")!.score === 100);
check("benefits boilerplate ignored", ![...strong.matchedKeywords, ...strong.missingKeywords].some((k) => /insurance|paid/i.test(k)));

// Optimizer output carries JD keywords in analysis fields - they must not count.
const inflated = { ...weakResume, keyword_gap: strong.matchedKeywords, ats_keywords_from_jd: strong.matchedKeywords, ats_keywords_added_to_resume: strong.matchedKeywords, improvement_notes: ["Azure Terraform Kubernetes"] };
check("analysis fields do not inflate the score", computeMatchScore(inflated, JD, opts)!.score === weak.score);
// The FAANG/STAR audit and a saved match analysis ride along on optimizer output too.
const withReports = { ...strongResume, star_stories: [{ bullet: "x", action: "Azure Terraform Kubernetes Docker" }], impact_audit: { findings: [{ issue: "Kubernetes" }] }, match_analysis: { optimized: { matchedKeywords: ["Kubernetes"] } } };
check("STAR stories and audit reports do not inflate the score", computeMatchScore(withReports, JD, opts)!.score === strong.score);

const kw = (jd: string, resume: unknown = "nothing relevant here at all") => {
  const r = computeMatchScore(resume, jd, {});
  return r ? [...r.matchedKeywords, ...r.missingKeywords] : [];
};
check("'React to incidents' is not React", !kw("You must react to incidents quickly. React to alerts.").includes("React"));
check("'React, Angular' is React", kw("Experience with React, Angular and TypeScript.").includes("React"));
check("'R&D' is not R", !kw("Join our R&D team working on cloud.").includes("R"));
check("'C++ and C#' is not C", !kw("Strong C++ and C# skills required.").includes("C"));
check("'maintenance windows' is not Windows", !kw("Apply patches during maintenance windows.").includes("Windows"));
check("'Windows and Linux' is Windows", kw("Administer Windows and Linux servers.").includes("Windows"));
check("'you will excel' is not Excel", !kw("You will excel in a fast-paced team.").includes("Excel"));
check("'rest of the team' is not REST", !kw("Work with the rest of the team on APIs.").includes("REST APIs"));
check("'at the helm' is not Helm", !kw("Be at the helm of our platform.").includes("Helm"));
check("'go live' is not Go", !kw("Support the go live and Go-to-market plan.").includes("Go"));
check("Java is not satisfied by JavaScript", computeMatchScore("JavaScript developer", "Java required.")!.missingKeywords.includes("Java"));
check("SQL satisfied by PostgreSQL", computeMatchScore("Tuned PostgreSQL queries", "Strong SQL skills required.")!.matchedKeywords.includes("SQL"));
check("'MS Office' is not a Master's requirement", !computeMatchScore("x", "Proficient in MS Office and MS SQL.")!.components.some((c) => c.id === "education"));
check("empty JD returns null", computeMatchScore(strongResume, "   ") === null);

check("'We are hiring' is not a recruiting skill", !kw("We are hiring a Backend Engineer.").includes("Recruiting"));
check("'prioritize the backlog' is backlog work, not time management", (() => { const k = kw("Prioritize the backlog with engineering."); return !k.includes("Time Management") && k.includes("Backlog Management"); })(), kw("Prioritize the backlog with engineering."));
const eduDetail = (jd: string) => computeMatchScore("x", jd)?.components.find((c) => c.id === "education")?.detail || "none";
check("'Graduate with 3+ years' requires a bachelor's", eduDetail("Graduate with 3+ years of experience.").startsWith("Bachelor's required"), eduDetail("Graduate with 3+ years of experience."));
check("'Post Graduate degree' requires a master's", eduDetail("Post Graduate degree required.").startsWith("Master's required"), eduDetail("Post Graduate degree required."));
check("'graduate degree' requires a master's", eduDetail("A graduate degree is required.").startsWith("Master's required"), eduDetail("A graduate degree is required."));
check("'MBA preferred' is not a requirement", eduDetail("MBA preferred.") === "none", eduDetail("MBA preferred."));

const listJd = "Experience building services with Python, Go, or Rust\nStrong experience with React, Node, and TypeScript";
const jsonSkills = computeMatchScore({ skills: { Languages: ["Python", "Go", "Rust"], Frontend: ["React", "Node", "TypeScript"] } }, listJd)!;
const flatSkills = computeMatchScore(JSON.stringify({ skills: ["Python", "Go", "Rust", "React", "Node", "TypeScript"] }), listJd)!;
const textSkills = computeMatchScore("Skills: Python, Go, Rust, React, Node, TypeScript", listJd)!;
check("skills arrays match list-only names (Go/Rust/React/Node)", jsonSkills.score === 100 && flatSkills.score === 100 && textSkills.score === 100, { json: jsonSkills.missingKeywords, flat: flatSkills.missingKeywords });
check("one-item JD bullets ('- Go') are requirements", kw("Requirements\n- Go\n- Rust").includes("Go"), kw("Requirements\n- Go\n- Rust"));
check("a bullet starting 'React to' is still not React", !kw("Requirements\n- React to incidents within SLA").includes("React"));

const sectionJd = "Requirements\nPython scripting\nOperate our mission-critical platform\nKubernetes and Terraform\nAzure and AWS";
check("a list line containing 'our mission' does not drop later lines", computeMatchScore("Python scripting", sectionJd)!.score < 60, computeMatchScore("Python scripting", sectionJd)!.missingKeywords);
const prefJd = "Requirements\nBachelor's degree preferred\n8+ years of experience in cloud infrastructure\nAzure";
const prefExp = computeMatchScore({ experience: [{ duration: "Jan 2023 - Present" }], skills: ["Azure"] }, prefJd, { now: NOW })!;
check("a 'degree preferred' line does not make later lines preferred", prefExp.components.some((c) => c.id === "experience" && c.detail.includes("8+")), prefExp.components);

const datadogJd = "Datadog is hiring a platform engineer. At Datadog, you will build our platform.\nRequirements: 5+ years of experience with Kubernetes and Terraform.";
check("the hiring company is not a requirement even when it is a known tool", !computeMatchScore("x", datadogJd, { companyName: "Datadog" })!.missingKeywords.includes("Datadog"), computeMatchScore("x", datadogJd, { companyName: "Datadog" })!.missingKeywords);

const ageJd = "5+ years of experience with Azure and Terraform.\nMust be at least 18 years of age.\nmust be 21 years of age or older";
const ageExp = computeMatchScore({ experience: [{ duration: "Jan 2018 - Present" }] }, ageJd, { now: NOW })!;
check("age limits are not experience requirements", ageExp.components.some((c) => c.id === "experience" && c.detail.endsWith("5+ required")), ageExp.components);

const yearsDetail = (jd: string) => computeMatchScore({ experience: [{ duration: "Jan 2020 - Present" }] }, jd, { now: NOW })?.components.find((c) => c.id === "experience")?.detail || "none";
check("'Experience: 5+ years' detected", yearsDetail("Experience: 5+ years").endsWith("5+ required"), yearsDetail("Experience: 5+ years"));
check("'Experience Required: 3-5 Years' detected", yearsDetail("Experience Required: 3-5 Years").endsWith("3+ required"), yearsDetail("Experience Required: 3-5 Years"));
check("'Years of Experience: 8+' detected", yearsDetail("Years of Experience: 8+").endsWith("8+ required"), yearsDetail("Years of Experience: 8+"));

const verbJd = "React quickly to production incidents.\nReact to alerts from monitoring.\nYou will excel in this role.\nWe want people who excel in a fast-paced team.\nRequirements: Terraform";
const verbBase = computeMatchScore("Terraform", verbJd)!.score;
const verbStuffed = computeMatchScore("Terraform\nSkills: React, Excel", verbJd)!.score;
check("repeated verbs 'react'/'excel' are not domain terms", verbBase === verbStuffed && !kw(verbJd).some((k) => /^(react|excel)$/i.test(k)), { verbBase, verbStuffed, kws: kw(verbJd) });

const reqJd = "Requirements\n- Terraform\n- Ansible\n\nNice to have\n- Kubernetes";
const missingReq = computeMatchScore("Ansible Kubernetes", reqJd)!.score;
const missingPref = computeMatchScore("Terraform Ansible", reqJd)!.score;
check("missing a required skill costs more than a preferred one", missingReq < missingPref, { missingReq, missingPref });

const appended = `${JSON.stringify(weakResume)}\n\nSkills: Terraform, Kubernetes`;
check("trailing text after JSON is scored", computeMatchScore(appended, JD, opts)!.matchedKeywords.includes("Terraform"));

const flat = "We need an Azure engineer with Terraform. We are an equal opportunity employer regardless of gender, and offer Kubernetes training as a benefit package.";
check("a single-paragraph boilerplate sentence is dropped", !kw(flat).includes("Kubernetes"), kw(flat));
