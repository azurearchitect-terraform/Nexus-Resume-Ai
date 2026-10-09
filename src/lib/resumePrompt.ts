/**
 * Single source of truth for the resume generation prompt.
 *
 * Both generation paths consume this builder:
 *   - server.ts        -> POST /api/v2/optimize (primary hybrid pipeline, structured input)
 *   - geminiService.ts -> optimizeResume() legacy/fallback path (raw resume text input)
 *
 * Keep this module dependency-free: it is bundled by both esbuild (node) and vite (browser).
 */

import { activeBulletRules, describeBudgetRules, formatBudgetTable } from "./bulletBudget";
import type { BulletBudget, BulletRules, PlatformDecision } from "./bulletBudget";

export interface ResumePromptOptions {
  targetRole: string;
  audience: string;
  mode: string;
  /** Raw resume text or pre-extracted JSON, already trimmed by the caller. */
  inputData: string;
  /** Label describing the shape of inputData, shown to the model. */
  inputLabel?: string;
  targetCompany?: string;
  customPrompt?: string;
  brainDump?: string;
  jobDescription?: string;
  /** Known role count from structured extraction. Omit for raw-text input. */
  roleCount?: number;
  jdKeywords?: string[];
  masterResumes?: unknown[];
  currentDate?: string;
  /** Hiring-manager rejection review instead of a rewrite. */
  recruiterSimulationMode?: boolean;
  bulletBudgets?: BulletBudget[];
  bulletRules?: BulletRules | null;
  platformDecision?: PlatformDecision | null;
  trendBrief?: string;
}

const BANNED_VERBS = [
  "Spearheaded",
  "Orchestrated",
  "Pioneered",
  "Leveraged",
  "Empowered",
  "Synergized",
  "Revolutionized",
  "Championed",
  "Utilized",
  "Facilitated",
];

const APPROVED_VERBS = [
  "Architected",
  "Designed",
  "Built",
  "Migrated",
  "Implemented",
  "Automated",
  "Standardized",
  "Governed",
  "Configured",
  "Reduced",
  "Consolidated",
  "Instrumented",
  "Partnered",
  "Defined",
  "Evaluated",
  "Delivered",
  "Diagnosed",
  "Hardened",
  "Refactored",
  "Negotiated",
  "Mentored",
];

const CORPORATE_DNA: Record<string, string> = {
  amazon:
    'Emphasize "Ownership", "Bias for Action", and data-driven results, using Amazon Leadership Principles vocabulary.',
  microsoft:
    'Emphasize "Enterprise Scale", "Cloud Transformation", and collaborative cross-org ecosystems.',
  google:
    'Emphasize systems design, extreme scale, algorithmic efficiency, and the Google XYZ bullet formula.',
  meta:
    'Emphasize moving fast, shipping end-to-end impact, and performance optimization.',
  accenture:
    'Emphasize client delivery, global managed services, and cross-functional deployment.',
  infosys:
    'Emphasize client delivery, global managed services, and cross-functional deployment.',
};

const OUTPUT_SCHEMA = `{
  "personal_info": { "name": "string", "location": "string", "email": "string", "phone": "string", "linkedin": "string", "linkedinText": "string" },
  "summary": "string",
  "skills": { "Category 1": ["string"], "Category 2": ["string"], "Category 3": ["string"], "Category 4": ["string"] },
  "experience": [ { "id": "string", "role": "string", "company": "string", "duration": "string", "bullets": ["string"] } ],
  "projects": [ { "title": "string", "description": "string" } ],
  "education": [ { "degree": "string", "institution": "string", "semester": "string, only if the source states it", "expected_completion": "string" } ],
  "certifications": [ { "name": "string", "issuer": "string", "date": "string" } ],
  "ats_keywords_from_jd": ["string"],
  "ats_keywords_added_to_resume": ["string"],
  "keyword_gap": ["string"],
  "improvement_notes": ["string"],
  "audience_alignment_notes": "string",
  "rejection_reasons": ["string"],
  "star_stories": [ { "bullet": "string", "situation": "string", "task": "string", "action": "string", "result": "string" } ],
  "audit_report": {
    "score": 85,
    "flags": [
      { "id": "string", "type": "tool_dropping|passive_ownership|leadership_signal|ats_cohesion", "message": "string", "fix": "string", "severity": "low|medium|high" }
    ],
    "trajectory": { "stage": "string", "description": "string", "recommendation": "string" }
  }
}`;

function section(condition: unknown, text: string): string {
  return condition ? text : "";
}

export function buildResumeGenerationPrompt(options: ResumePromptOptions): string {
  const {
    targetRole,
    audience,
    mode,
    inputData,
    inputLabel = "INPUT DATA",
    targetCompany,
    customPrompt,
    brainDump,
    jobDescription,
    roleCount,
    jdKeywords,
    masterResumes,
    currentDate = new Date().toLocaleDateString("en-US", {
      year: "numeric",
      month: "long",
      day: "numeric",
    }),
    recruiterSimulationMode = false,
    bulletBudgets,
    bulletRules,
    platformDecision,
    trendBrief,
  } = options;

  const activeRules = activeBulletRules(bulletRules);
  const budgetSection = activeRules
    ? `${describeBudgetRules("   ", { rules: activeRules, platform: platformDecision })}
   Per-role budgets (authoritative; never add bullets to reach a minimum):
${formatBudgetTable(bulletBudgets || [], "   ", { markSource: true })}`
    : `If a role carries a "bullet_budget" field, that value is authoritative. Otherwise derive
   counts from tenure: under 3 months: 1; 3-12 months: 2-3; over 1 year, current/most recent:
   6-7; over 1 year, earlier: 3-4; roles ending more than 10 years ago: 1-2. For unreadable
   dates use a proportionate count, never more than 7. Never pad or invent bullets.`;

  const dnaKey = (targetCompany || "").toLowerCase();
  const corporateDna =
    CORPORATE_DNA[dnaKey] ||
    "Focus on internal product growth, feature ownership, and end-to-end delivery.";

  const roleCountRule =
    typeof roleCount === "number"
      ? `The input contains exactly ${roleCount} roles. Return exactly ${roleCount} objects in "experience".`
      : `Count the roles present in the source input and return EXACTLY that many objects in "experience".`;

  return `ACT AS:
Principal Resume Intelligence Architect + Tier-1 Technical Recruiter + Enterprise ATS Strategist.
Produce a recruiter-safe, ATS-parseable, technically mature resume that reflects factual realism
and believable ownership. Your output is consumed by a JSON parser, never read as prose by a human.

TARGET ROLE: ${targetRole}
TARGET COMPANY: ${targetCompany || "General Product Tech"}
AUDIENCE: ${audience} | MODE: ${mode} | CURRENT DATE: ${currentDate}
TASK: ${
    recruiterSimulationMode
      ? "Critical hiring-manager review. Populate rejection_reasons with concrete, evidence-based reasons this profile would be screened out, then still return the full rewritten document."
      : "Rewrite the source into a top-tier professional document adhering to operational realism."
  }
${section(customPrompt, `CUSTOM INSTRUCTIONS: ${customPrompt}`)}
${section(
    brainDump,
    `BRAIN DUMP (raw, unverified): ${brainDump}
Mine this only for achievements that are grounded in the roles listed below. Ignore anything unverifiable.`
  )}
${section(
    masterResumes && masterResumes.length > 0,
    `STRATEGIC REFERENCE (MASTER RESUMES):
Study these only for style, structure, and high-impact phrasing. Never copy their facts,
employers, metrics, or technologies into this candidate's document.
${(masterResumes || []).map((r) => JSON.stringify(r)).join("\n---\n")}`
  )}

=== PHASE 1 - SILENT GAP ANALYSIS (internal reasoning; DO NOT emit as prose) ===
Before writing anything, assess the source against these four axes. Every finding must be
recorded as a structured entry in audit_report.flags - never as free text outside the JSON.

A. TECHNICAL DEPTH vs. TOOL DROPPING
   Locate bullets that merely name technologies without architecture, constraint, or scale.
   Rewrite them to expose the design decision made, the constraint it resolved, and the
   operating scale (users, data volume, environments, uptime, cost) - but ONLY using scale
   facts already present in the source. If no scale fact exists, express depth through the
   technical decision itself, never through an invented number.

B. OWNERSHIP & DELIVERY
   Find passive framing ("worked on", "helped with", "was part of", "assisted", "involved in",
   "responsible for"). Convert to first-line execution ownership. Ownership is scale-agnostic:
   a university capstone and an enterprise migration both warrant direct-ownership phrasing
   when the source supports it. Do NOT inflate team scope or invent direct reports.

C. LEADERSHIP & TRAJECTORY
   Surface buried signals of readiness for the target role: architecture or design authority,
   vendor and stakeholder negotiation, mentoring, standards definition, cost or risk ownership,
   incident command, roadmap input. Map each signal to a concrete requirement of the target
   role and record the mapping in audit_report.trajectory.

D. ATS COHESION
   Detect structural risks: unexplained chronological gaps, inconsistent date formats,
   unexplained title or seniority regressions, duplicate or contradictory skill naming,
   acronym-only usage where the JD spells the term out (or vice versa), and JD keywords
   absent from the resume body. Emit each as a flag with a concrete fix.

=== PHASE 2 - REWRITE ===

HARD CONSTRAINTS (violating any of these is a critical failure):

1. PRESERVE EVERY ROLE - HIGHEST PRIORITY, OUTRANKS ALL LENGTH RULES.
   ${roleCountRule}
   Reverse-chronological, no merging, no collapsing, no truncation, no gaps in the timeline.
   A dropped role reads as an unexplained employment gap and gets the candidate rejected.
   If content will not fit, remove BULLETS from the oldest roles - never a role.
   Losing a bullet is acceptable; losing a job is not.

2. ZERO FABRICATION. Do not invent metrics, percentages, currency amounts, team sizes,
   technologies, tools, certifications, employers, or dates. If the source contains no
   number, the bullet ships without a number. A precise, unquantified, technically specific
   bullet always beats an invented statistic. Every noun in the output must be traceable to
   the source input, or to the JD's vocabulary applied to work the source actually supports.

3. PRESERVE ALL CERTIFICATIONS AND TITLES verbatim, including issuer and date. Never
   normalise, "correct", re-case, or abbreviate a job title or company name.

4. BULLET BUDGET (trim wording, never roles):
${budgetSection}
   Never pad a role or invent a bullet to meet a minimum. Remove the weakest bullets from
   older, system-budgeted roles first when fitting the document.
   The total document must fit 1-2 pages, achieved by trimming bullets and tightening
   wording ONLY. Rule 1 always wins over this rule.

5. BULLET SHAPE - DELIBERATE VARIATION (there is NO single bullet template):
   Rotate across these shapes so that no two consecutive bullets share a cadence:
   (a) Outcome-led:  action -> technical work -> result
   (b) Scope-led:    action -> system or surface owned -> what it enabled
   (c) Decision-led: action -> the trade-off evaluated -> what it resolved
   (d) Problem-led:  the constraint or failure hit -> what you changed -> what stopped happening
   Vary length deliberately: some bullets 8-12 words, others 18-25. Uniform bullet length is
   itself a tell of generated text. One line preferred; two lines only when genuine
   architectural complexity requires it. Never pad to fill a line.

6. METRIC DISCIPLINE - DENSITY CAP (violating this makes the whole document read as fake):
   A number in every bullet is the single strongest tell of an AI-written resume. Recruiters
   do not discount only the suspect figure - they discount the entire document.
   - Use a metric ONLY where the source explicitly supplies one. Never derive, infer,
     estimate, extrapolate, or round one up.
   - Across the document, aim for roughly one bullet in three carrying a number, and never
     more than two consecutive bullets containing one.
   - ATTRIBUTION TEST: include a metric only if the person in THAT role would plausibly have
     had visibility into it. A support analyst does not know company revenue impact.
   - NO ROUND-NUMBER THEATRE: avoid 30%, 50%, 2x, "over 100", "millions of". Real figures are
     specific and uneven. Reproduce source figures exactly; never tidy them.
   - When no metric exists, close the bullet on a CONCRETE, VERIFIABLE outcome instead: the
     manual step removed, the failure mode eliminated, the system retired, the audit passed,
     the recurring escalation ended. Specificity replaces quantification. Vagueness does not.

7. VERB POLICY. Lead every bullet with a strong, concrete, grounded verb.
   BANNED (AI-slop markers): ${BANNED_VERBS.join(", ")}.
   USE: ${APPROVED_VERBS.join(", ")}.

8. SENIORITY CALIBRATION. Infer seniority from the source dates and the target role - do not
   assume. For senior or principal targets, weight architectural judgement, selection criteria,
   cost optimization, security posture, and roadmap alignment. For early-career targets, weight
   implementation depth, systems reasoning, and measurable delivery. Never apply executive
   vocabulary to junior work, or junior vocabulary to executive work.

9. SKILLS. Exactly 4 short Title Case category keys (e.g. "Cloud Infrastructure",
   "Security & Governance"). No snake_case, no underscores, no long unbroken strings.
   Only skills evidenced in the source.

10. PROJECTS. Output EVERY project. Maximum 2 sentences each: technical architecture first,
    then business outcome.

11. JD TAILORING - THIS IS WHAT MAKES THE DOCUMENT SPECIFIC TO THIS POSTING.
    Read the full job description below, not just the extracted keyword list. Two different
    postings for a similar title MUST produce visibly different documents: different summary
    framing, a different ordering of emphasis within each role, and a different selection of
    which source bullets are promoted or dropped.
    - Reorder and reselect bullets so the work closest to THIS posting's priorities appears
      first within each role.
    - Mirror the posting's own vocabulary where the underlying work genuinely occurred
      (if it says "observability" and the source says "monitoring", adopt the posting's term).
    - Rewrite the summary to answer this specific posting, never as a generic profile.
    - Weave JD vocabulary into bullets ONLY where the underlying work genuinely occurred.
      Genuinely missing keywords belong in "keyword_gap", never in a bullet.
    Tailoring changes EMPHASIS, SELECTION, and WORDING. It never changes facts.
${section(
    jdKeywords && jdKeywords.length > 0,
    `    Priority JD keywords: ${(jdKeywords || []).join(", ")}.`
  )}${section(trendBrief, `\n${trendBrief}`)}

12. HUMANIZATION. The document must read as if a competent engineer wrote it under time
    pressure - specific, uneven, and concrete - not as a uniformly polished template.
    Deliberate unevenness is the goal: bullets of differing length, some roles richer than
    others, and no repeated sentence skeleton anywhere in the document.

13. CORPORATE DNA: ${corporateDna}
    Tailor emphasis only. Never rename, reframe, or alter a factual claim to fit a company.
${section(
    mode === "Player-Coach",
    `
14. PLAYER-COACH BALANCE: Weight bullets roughly 60% hands-on technical execution and
    40% leadership (mentoring, design review, standards, cross-team coordination). Use hybrid
    framing such as "Architected & Led", "Designed & Mentored", "Built & Standardized".
    Apply this balance only to roles where the source supports both dimensions.`
  )}

${inputLabel}:
${inputData}
${section(
    jobDescription,
    `
=== TARGET JOB DESCRIPTION (tailor against this in full - see rule 11) ===
${jobDescription}`
  )}

OUTPUT:
Return ONE valid JSON object and nothing else. No markdown fences, no preamble, no commentary,
no trailing explanation. All Phase 1 findings go into audit_report.flags and improvement_notes.

OUTPUT JSON SCHEMA (MUST MATCH EXACTLY):
${OUTPUT_SCHEMA}
`;
}
