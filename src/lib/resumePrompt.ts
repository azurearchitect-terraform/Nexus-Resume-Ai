/**
 * Single source of truth for the resume generation prompts.
 *
 * Every generation path consumes these builders:
 *   - server.ts            -> POST /api/v2/optimize, OpenAI branch (whole document)
 *   - server/roleGenerator -> POST /api/v2/optimize, default hybrid-gemini branch (one role at a time)
 *   - geminiService.ts     -> optimizeResume() legacy/fallback path (raw resume text input)
 *
 * The FAANG bullet standard and the STAR standard are defined once here and shared by
 * both prompt shapes, so the paths cannot drift apart. They are adapted from PR #3
 * (eceae3e, ba1c542), which the 6b3e3ec rollback removed.
 *
 * Only imports other dependency-free src/lib modules: it is bundled by both esbuild
 * (node) and vite (browser).
 */

import { BANNED_LEAD_VERBS } from "./impactScore";

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
}

function titleCase(word: string): string {
  return word.charAt(0).toUpperCase() + word.slice(1);
}

/** Shared with the impact audit, so the prompt and the audit cannot disagree. */
const BANNED_VERBS = BANNED_LEAD_VERBS.map(titleCase);

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
    "Emphasize Ownership, Bias for Action, Dive Deep and Deliver Results: customer impact, operational excellence, and decisions backed by data. Demonstrate the Leadership Principles through the work; never name them in a bullet.",
  microsoft:
    "Emphasize enterprise scale, cloud transformation, customer outcomes, and collaboration across organizational boundaries.",
  google:
    "Emphasize systems design, scale, and technical depth, in XYZ-shaped bullets that carry the measure only where the source states it.",
  meta:
    "Emphasize moving fast, shipping end-to-end impact, and performance optimization.",
  apple:
    "Emphasize craftsmanship and attention to detail, user-facing quality, privacy and security by design, and tight cross-functional collaboration.",
  netflix:
    "Emphasize independent judgment, ownership of outcomes with minimal process, candid communication, and the business impact of each decision.",
  accenture:
    "Emphasize client delivery, global managed services, and cross-functional deployment.",
  infosys:
    "Emphasize client delivery, global managed services, and cross-functional deployment.",
};

const DEFAULT_CORPORATE_DNA =
  "Focus on internal product growth, feature ownership, and end-to-end delivery.";

/** Subsidiaries and products that share their parent's hiring bar. */
const COMPANY_ALIASES: Record<string, string> = {
  amazon: "amazon", aws: "amazon",
  google: "google", alphabet: "google", youtube: "google", deepmind: "google",
  meta: "meta", facebook: "meta", instagram: "meta", whatsapp: "meta",
  microsoft: "microsoft",
  apple: "apple",
  netflix: "netflix",
  accenture: "accenture",
  infosys: "infosys",
};

/** Own-key lookup, so a company named "Constructor" never resolves to Object.prototype.constructor. */
function ownEntry<T>(table: Record<string, T>, key: string): T | undefined {
  return Object.prototype.hasOwnProperty.call(table, key) ? table[key] : undefined;
}

/**
 * Canonical key for a target company, matched per word so that "Amazon Web Services",
 * "AWS" and "Google LLC" resolve like "Amazon" and "Google" do.
 */
export function companyKey(company?: string): string | null {
  const tokens = String(company || "").toLowerCase().match(/[a-z0-9]+/g) || [];
  for (const token of tokens) {
    const key = ownEntry(COMPANY_ALIASES, token);
    if (key) return key;
  }
  return null;
}

/**
 * The company the prompts should tailor for: the Target Company picker when one is
 * chosen, otherwise the hiring company typed in by the candidate. "none" (Generic
 * Tech) is never shown to the model as a company name.
 */
export function resolvePromptCompany(targetCompany?: string, companyName?: string): string | undefined {
  const picked = String(targetCompany || "").trim();
  if (picked && picked.toLowerCase() !== "none") return picked;
  const typed = String(companyName || "").trim();
  return typed || undefined;
}

function corporateDnaFor(targetCompany?: string): string {
  const key = companyKey(targetCompany);
  return (key && ownEntry(CORPORATE_DNA, key)) || DEFAULT_CORPORATE_DNA;
}

export interface StarFramework {
  name: string;
  competencies: string[];
}

/** The competency model each company's behavioral interviews are organized around. */
const STAR_FRAMEWORKS: Record<string, StarFramework> = {
  amazon: {
    name: "Amazon's Leadership Principles",
    competencies: [
      "Customer Obsession", "Ownership", "Invent and Simplify", "Are Right, A Lot",
      "Learn and Be Curious", "Hire and Develop the Best", "Insist on the Highest Standards",
      "Think Big", "Bias for Action", "Frugality", "Earn Trust", "Dive Deep",
      "Have Backbone; Disagree and Commit", "Deliver Results",
      "Strive to be Earth's Best Employer", "Success and Scale Bring Broad Responsibility",
    ],
  },
  google: {
    name: "Google's hiring attributes",
    competencies: [
      "Googleyness", "Emergent Leadership", "Comfort with Ambiguity", "Bias to Action",
      "Collaboration", "Role-Related Knowledge",
    ],
  },
  meta: {
    name: "the signals Meta's behavioral interview assesses",
    competencies: [
      "Driving Results", "Moving Fast", "Resolving Conflict", "Embracing Ambiguity",
      "Growing Continuously", "Communicating Effectively",
    ],
  },
  microsoft: {
    name: "Microsoft's culture and leadership principles",
    competencies: [
      "Growth Mindset", "Customer Obsession", "Collaboration (One Microsoft)", "Create Clarity",
      "Generate Energy", "Deliver Success",
    ],
  },
  apple: {
    name: "the qualities Apple interviewers commonly probe",
    competencies: [
      "Attention to Detail", "User Focus", "Cross-Functional Collaboration", "Ownership",
      "Simplicity", "Handling Ambiguity",
    ],
  },
  netflix: {
    name: "Netflix's culture values",
    competencies: [
      "Judgment", "Communication", "Curiosity", "Courage", "Passion", "Selflessness",
      "Innovation", "Inclusion", "Integrity", "Impact",
    ],
  },
};

const DEFAULT_STAR_FRAMEWORK: StarFramework = {
  name: "the core behavioral competencies top-tier loops assess",
  competencies: [
    "Ownership", "Delivering Results", "Technical Depth", "Problem Solving",
    "Handling Ambiguity", "Collaboration", "Influence Without Authority",
    "Conflict Resolution", "Customer Focus", "Learning from Failure",
  ],
};

export function starFrameworkFor(targetCompany?: string): StarFramework {
  const key = companyKey(targetCompany);
  return (key && ownEntry(STAR_FRAMEWORKS, key)) || DEFAULT_STAR_FRAMEWORK;
}

const STAR_STORY_FIELDS =
  '"competency": "string", "question": "string", "situation": "string", "task": "string", ' +
  '"action": "string, first person singular", "result": "string", "learning": "string", ' +
  '"follow_ups": ["string"], "prep_gaps": ["string"]';

const OUTPUT_SCHEMA = `{
  "personal_info": { "name": "string", "location": "string", "email": "string", "phone": "string", "linkedin": "string", "linkedinText": "string" },
  "summary": "string",
  "skills": { "Category 1": ["string"], "Category 2": ["string"], "Category 3": ["string"], "Category 4": ["string"] },
  "experience": [ { "id": "string", "role": "string", "company": "string", "duration": "string", "bullets": ["string"] } ],
  "projects": [ { "title": "string", "description": "string" } ],
  "education": [ { "degree": "string", "institution": "string", "expected_completion": "string" } ],
  "certifications": [ { "name": "string", "issuer": "string", "date": "string" } ],
  "ats_keywords_from_jd": ["string"],
  "ats_keywords_added_to_resume": ["string"],
  "keyword_gap": ["string"],
  "improvement_notes": ["string"],
  "audience_alignment_notes": "string",
  "rejection_reasons": ["string"],
  "star_stories": [ { "bullet": "string, copied VERBATIM from a bullet in experience", "role": "string, the role that bullet belongs to", "company": "string", ${STAR_STORY_FIELDS} } ],
  "audit_report": {
    "score": "integer 0-100, computed per the AUDIT SCORE RUBRIC below",
    "flags": [
      { "id": "string", "type": "tool_dropping|passive_ownership|leadership_signal|ats_cohesion", "message": "string", "fix": "string", "severity": "low|medium|high" }
    ],
    "trajectory": { "stage": "string", "description": "string", "recommendation": "string" }
  }
}`;

function section(condition: unknown, text: string): string {
  return condition ? text : "";
}

/* ------------------------------------------------------------------ *
 * Shared standards. Each block is referenced by NAME, never by number,
 * because the whole-document and per-role prompts number their rules
 * differently.
 * ------------------------------------------------------------------ */

const STAR_GROUNDING = `For each role, identify the achievements the source actually evidences, and for each one
silently reconstruct the four STAR elements FROM THE SOURCE ONLY:
  S - the situation: the system, constraint, failure, or business condition that existed
  T - the task: what this person specifically owned in it, not what the team owned
  A - the action: the concrete technical or organisational decision they made and executed
  R - the result: what measurably or observably changed as a consequence

Then write the bullet as the compressed A -> R of that story: the action taken and what it
changed. The S and T stay in your reasoning as the context that makes the bullet specific;
they are what stops it collapsing into a tool-dropping list.

RULES FOR THIS STEP:
- If the source does not support an element, leave it thin and factual. NEVER invent a
  situation, a stakeholder, a deadline, or a result to complete the pattern. An honest
  three-element story beats a fabricated four-element one. ZERO FABRICATION outranks STAR
  completeness absolutely.
- If a Result cannot be evidenced, close on the concrete change instead - the manual step
  removed, the failure mode eliminated, the system retired, the escalation that stopped.
- STAR is the reasoning scaffold, NOT a bullet template. Do NOT write bullets shaped
  "Faced with X, tasked with Y, I did Z, achieving W" - that cadence is an instant tell and
  violates BULLET SHAPE. The reader must never be able to see the scaffold in the prose.
- A bullet that is pure responsibility description with no action and no change is not a
  STAR-grounded bullet. Rewrite it or drop it.`;

const ZERO_FABRICATION = `ZERO FABRICATION. Do not invent metrics, percentages, currency amounts, team sizes,
   technologies, tools, certifications, employers, or dates. If the source contains no
   number, the bullet ships without a number. A precise, unquantified, technically specific
   bullet always beats an invented statistic. Every noun in the output must be traceable to
   the source input, or to the JD's vocabulary applied to work the source actually supports.
   Every figure you write is checked mechanically against the candidate's own material; one
   that cannot be found there is shown to the candidate as UNVERIFIED. Reproduce source
   figures exactly - never round them, and never derive a new one (such as a percentage
   computed from two source numbers); state the before and after as the source gives them.`;

const FAANG_BULLET_STANDARD = `FAANG BULLET STANDARD - how a top-tier screen reads every bullet:
   a. IMPACT FIRST, XYZ SHAPE: "Accomplished [X], as measured by [Y], by doing [Z]". Include
      Y ONLY when the source states the measure. When it does not, X must still be concrete:
      the system shipped, the failure mode removed, the process retired. Never manufacture a
      Y to complete the formula - a missing measure is honest, an invented one disqualifies.
      Not every bullet carries a number (see METRIC DISCIPLINE).
   b. LEGIBLE SCOPE: make the size of the problem visible with facts the source gives - what
      the system does for the business, who depends on it, how many services, environments,
      teams, or regions it spans. Scope stands in for a metric and never needs invention.
   c. INDIVIDUAL ATTRIBUTION: every bullet states what THIS person did. No "we", "our", "I",
      or "my" - implied first person, verb first. For team efforts, name the part that was
      theirs ("Designed the failover logic for..."); the team appears only as scope.
   d. LEVEL CALIBRATION: infer seniority from the source dates and the target role. Senior
      and above: architectural judgement, trade-offs weighed, cost and risk ownership,
      cross-team influence, ambiguity resolved. Earlier career: implementation depth,
      systems reasoning, delivery. Never apply executive vocabulary to junior work, or
      junior vocabulary to executive work.
   e. TENSE: past tense for every accomplishment, including in the current role - the work
      is finished even if the job is not.
   f. ONE CLAIM PER BULLET: one accomplishment in one to two lines. Two unrelated wins joined
      by "and" are two bullets, or one bullet and one cut.
   g. DEFENSIBILITY: keep a bullet only if the candidate could answer "walk me through that"
      for five minutes using nothing but the source. Otherwise cut it back to what they can
      defend.`;

const BULLET_SHAPE = `BULLET SHAPE - DELIBERATE VARIATION (there is NO single bullet template):
   Rotate across these shapes so that no two consecutive bullets share a cadence. Every
   shape still opens on the action verb:
   (a) Outcome-led:  action -> technical work -> result
   (b) Scope-led:    action -> system or surface owned -> what it enabled
   (c) Decision-led: action -> the trade-off evaluated -> what it resolved
   (d) Problem-led:  action -> the constraint or failure it removed -> what stopped happening
   Vary length deliberately: some bullets 8-12 words, others 18-25. Uniform bullet length is
   itself a tell of generated text. One line preferred; two lines only when genuine
   architectural complexity requires it. Never pad to fill a line.`;

const METRIC_DISCIPLINE = `METRIC DISCIPLINE - DENSITY CAP (violating this makes the whole document read as fake):
   A number in every bullet is the single strongest tell of an AI-written resume. Recruiters
   do not discount only the suspect figure - they discount the entire document.
   - Use a metric ONLY where the source explicitly supplies one. Never derive, infer,
     estimate, extrapolate, or round one up.
   - Aim for roughly one bullet in three carrying a number, and never more than two
     consecutive bullets containing one.
   - ATTRIBUTION TEST: include a metric only if the person in THAT role would plausibly have
     had visibility into it. A support analyst does not know company revenue impact.
   - NO ROUND-NUMBER THEATRE: avoid 30%, 50%, 2x, "over 100", "millions of". Real figures are
     specific and uneven. Reproduce source figures exactly; never tidy them.
   - When no metric exists, close the bullet on a CONCRETE, VERIFIABLE outcome instead: the
     manual step removed, the failure mode eliminated, the system retired, the audit passed,
     the recurring escalation ended. Specificity replaces quantification. Vagueness does not.`;

const VERB_POLICY = `VERB POLICY. Lead every bullet with a strong, concrete, past-tense verb, and never open
   two bullets of the same role with the same verb.
   BANNED (AI-slop markers): ${BANNED_VERBS.join(", ")}.
   USE: ${APPROVED_VERBS.join(", ")}.`;

function starStoryStandard(framework: StarFramework): string {
  return `STAR STORY STANDARD - every story must survive a top-tier behavioral interview loop:
- Build a story only from a bullet whose source evidence supports a real answer.
- "competency": the ONE competency the story best evidences, taken from ${framework.name}:
  ${framework.competencies.join(" | ")}.
  Give each story a DIFFERENT competency where the evidence allows: each interviewer in a
  loop is assigned different ones.
- "question": the behavioral question this story answers, phrased the way an interviewer
  asks it ("Tell me about a time you...").
- "situation" (1-2 sentences) and "task" (1 sentence): brief context, about a fifth of the
  story. The task is what THIS person owned, not what the team owned.
- "action": the bulk of the story, about half of it - 3 to 5 concrete steps told in FIRST
  PERSON SINGULAR ("I profiled...", "I proposed..."), never "we". Include the reasoning
  behind the key decision and the trade-off that was weighed.
- "result": what changed, using the source's own figures where they exist and otherwise
  the concrete qualitative change. Never a figure the source does not state.
- "learning": one sentence on what the candidate took away or would do differently.
- "follow_ups": the 2-3 probing questions an interviewer is most likely to ask next.
- "prep_gaps": details the candidate must prepare because the source does not supply them
  (for example "the latency before the change"). Empty when nothing is missing. Missing
  evidence goes HERE - never into the story itself.
- Spoken aloud, a story runs about two minutes: specific, first person, no preamble.`;
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
  } = options;

  const promptCompany = resolvePromptCompany(targetCompany);
  const corporateDna = corporateDnaFor(promptCompany);
  const framework = starFrameworkFor(promptCompany);

  const roleCountRule =
    typeof roleCount === "number"
      ? `The input contains exactly ${roleCount} roles. Return exactly ${roleCount} objects in "experience".`
      : `Count the roles present in the source input and return EXACTLY that many objects in "experience".`;

  return `ACT AS:
Principal Resume Intelligence Architect + Tier-1 Technical Recruiter + Enterprise ATS Strategist.
Produce a recruiter-safe, ATS-parseable, technically mature resume that reflects factual realism
and believable ownership. Your output is consumed by a JSON parser, never read as prose by a human.

TARGET ROLE: ${targetRole}
TARGET COMPANY: ${promptCompany || "General Product Tech"}
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

=== PHASE 1.5 - STAR GROUNDING (internal reasoning; DO NOT emit as prose) ===
This step happens BEFORE you write a single bullet, and it determines what the bullets say.

${STAR_GROUNDING}

Then populate "star_stories" with the 4-6 STRONGEST of these, weighted toward the most
recent and most senior roles, including at least one from the current or most recent role.
Each entry's "bullet" field MUST be copied VERBATIM, character for character, from a bullet
you actually emitted in "experience" - it is the interview-prep expansion of that exact
bullet, and entries that do not match an emitted bullet are discarded by the platform.
Set "role" and "company" to the role that bullet belongs to.

${starStoryStandard(framework)}

=== PHASE 2 - REWRITE ===

HARD CONSTRAINTS (violating any of these is a critical failure):

1. PRESERVE EVERY ROLE - HIGHEST PRIORITY, OUTRANKS ALL LENGTH RULES.
   ${roleCountRule}
   Reverse-chronological, no merging, no collapsing, no truncation, no gaps in the timeline.
   A dropped role reads as an unexplained employment gap and gets the candidate rejected.
   If content will not fit, remove BULLETS from the oldest roles - never a role.
   Losing a bullet is acceptable; losing a job is not.

2. ${ZERO_FABRICATION}

3. PRESERVE ALL CERTIFICATIONS AND TITLES verbatim, including issuer and date. Never
   normalise, "correct", re-case, or abbreviate a job title or company name.

4. BULLET BUDGET - TENURE FIRST, THEN RECENCY (trim wording, never roles):
   If a role in the input carries a "bullet_budget" field, that value is AUTHORITATIVE -
   produce exactly that many bullets for that role. It was computed from the actual dates
   and overrides every heuristic below.
   Where no "bullet_budget" is given, derive tenure from the duration field and apply:
   - Under 3 months:        exactly 1 bullet, single line
   - 3 to 12 months:        2-3 bullets
   - Over 1 year, current or most recent role:  6-7 bullets
   - Over 1 year, earlier roles:                3-4 bullets
   - Anything before the last ~10 years:        1-2 bullets, core outcome only

   ANTI-PADDING RULE: bullet count must stay proportionate to time served. A long list
   under a short stint reads as padding, invites scrutiny of the entire document, and is
   a worse outcome than saying less. Never inflate a brief role to match the depth of a
   multi-year one, however senior the title or well known the employer. For a stint under
   three months, state the single thing that was actually delivered and stop.

   Depth belongs to the roles that earned it: give substantial, long-tenure positions the
   fullest treatment, and let short ones stay deliberately thin.
   The total document must fit 1-2 pages, achieved by trimming bullets and tightening
   wording ONLY. Rule 1 always wins over this rule.

5. ${BULLET_SHAPE}

6. ${METRIC_DISCIPLINE}

7. ${VERB_POLICY}

8. ${FAANG_BULLET_STANDARD}

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
  )}

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
"ats_keywords_from_jd", "ats_keywords_added_to_resume" and "keyword_gap" must contain only terms
that literally appear in the supplied job description. Never invent a keyword.

AUDIT SCORE RUBRIC (audit_report.score):
Start at 100 and subtract, then report the integer result. Do NOT default to a round number.
  -15  a role, certification, or date from the source is missing or altered
  -10  any metric, employer, technology, or title that is not traceable to the source
  -10  bullet counts are disproportionate to tenure (padding a short stint)
   -8  more than half of the bullets carry a number, or the same bullet skeleton repeats
   -6  each unresolved ATS cohesion flag (gap, inconsistent dates, acronym mismatch)
   -5  passive ownership phrasing survives anywhere in the document
   -4  a banned verb appears
   -4  a bullet uses "we", "our", "I" or "my", or a STAR action is told as "we"
   -3  a core JD requirement is absent from the resume body AND missing from keyword_gap
   -3  each star_stories entry whose "bullet" does not match a bullet you emitted verbatim
Two documents with different flaws MUST receive different scores.

OUTPUT JSON SCHEMA (MUST MATCH EXACTLY):
${OUTPUT_SCHEMA}
`;
}

/* ------------------------------------------------------------------ *
 * Per-role prompt (default hybrid-gemini pipeline)
 * ------------------------------------------------------------------ */

/** A role's bullet budget as computed upstream (trimContentForAI in server/optimization.ts). */
export interface RoleBudgetHint {
  /** As written by the planner, e.g. "6-7"; null when the dates could not be read. */
  label: string | null;
  min: number | null;
  max: number | null;
  tenureMonths: number | null;
}

/** Reads the "bullet_budget" ("6-7", "1") and "tenure_months" fields a structured role may carry. */
export function roleBudgetHint(role: any): RoleBudgetHint {
  const value = role?.bullet_budget;
  const raw = typeof value === "string" || typeof value === "number" ? String(value).trim() : "";
  const match = raw.match(/^(\d{1,2})(?:\s*(?:-|\u2013|to)\s*(\d{1,2}))?$/);
  const tenure = Number(role?.tenure_months);
  const tenureMonths = Number.isFinite(tenure) && tenure > 0 ? Math.round(tenure) : null;
  if (!match) return { label: null, min: null, max: null, tenureMonths };
  const first = Number(match[1]);
  const second = match[2] ? Number(match[2]) : first;
  return { label: raw, min: Math.min(first, second), max: Math.max(first, second), tenureMonths };
}

function budgetPhrase(budget: RoleBudgetHint): string {
  if (budget.min === null || budget.max === null) {
    return "derive it from the dates - under 3 months: 1 bullet; 3-12 months: 2-3; over a year and " +
      "current or most recent: 6-7; over a year and earlier: 3-4; older than ~10 years: 1-2";
  }
  if (budget.min === budget.max) return `EXACTLY ${budget.min} bullet${budget.min === 1 ? "" : "s"}`;
  return `${budget.min} to ${budget.max} bullets`;
}

export interface RoleBulletPromptOptions {
  role: { role?: string; company?: string; duration?: string };
  /** The role's source bullets: the only evidence the model may use. */
  sourceBullets: string[];
  budget: RoleBudgetHint;
  targetRole?: string;
  targetCompany?: string;
  audience?: string;
  mode?: string;
  customPrompt?: string;
  brainDump?: string;
  jobDescription?: string;
  jdKeywords?: string[];
  /** STAR stories to draft from this role; 0 asks for none. */
  starStoryCount?: number;
  /** Pipeline-specific rules appended after the shared standards. */
  extraRules?: string[];
  /** Problems found in a previous attempt, fed back for one corrective retry. */
  retryFeedback?: { issues: string[]; previousBullets: string[] };
  currentDate?: string;
}

/**
 * Prompt for rewriting ONE role, used by the default split-generation pipeline.
 *
 * Carries the same FAANG and STAR standards as the whole-document prompt, plus the
 * job description, so bullets written role-by-role are tailored exactly like bullets
 * written in a single pass.
 */
export function buildRoleBulletPrompt(options: RoleBulletPromptOptions): string {
  const {
    role,
    sourceBullets,
    budget,
    targetRole,
    targetCompany,
    audience,
    mode,
    customPrompt,
    brainDump,
    jobDescription,
    jdKeywords,
    starStoryCount = 0,
    extraRules = [],
    retryFeedback,
    currentDate = new Date().toLocaleDateString("en-US", {
      year: "numeric",
      month: "long",
      day: "numeric",
    }),
  } = options;

  const promptCompany = resolvePromptCompany(targetCompany);
  const framework = starFrameworkFor(promptCompany);
  const evidence = sourceBullets.length > 0
    ? sourceBullets.map((b, i) => `  ${i + 1}. ${b}`).join("\n")
    : "  (no bullets in the source - write only what the title and company alone support)";
  const tenure = budget.tenureMonths !== null ? `${budget.tenureMonths} months` : "tenure unreadable";
  const shortStint = budget.max === 1
    ? "\n  For a stint this short, state the single thing that was actually delivered and stop."
    : "";

  const rules = [
    ZERO_FABRICATION,
    FAANG_BULLET_STANDARD,
    BULLET_SHAPE,
    METRIC_DISCIPLINE,
    VERB_POLICY,
    `JD TAILORING. Select which of this role's achievements to feature, and order them, by
   relevance to the target posting: the closest work comes first. Mirror the posting's
   vocabulary only where the underlying work genuinely occurred. Tailoring changes
   emphasis, selection, and wording - never facts.${
      jdKeywords && jdKeywords.length > 0 ? `\n   Priority JD keywords: ${jdKeywords.join(", ")}.` : ""
    }`,
    ...(mode === "Player-Coach"
      ? [
          `PLAYER-COACH BALANCE: weight bullets roughly 60% hands-on technical execution and
   40% leadership (mentoring, design review, standards, cross-team coordination), only where
   the source supports both dimensions.`,
        ]
      : []),
    ...extraRules,
  ];

  const starSection = starStoryCount > 0
    ? `=== STAR STORIES (interview preparation) ===
Draft up to ${starStoryCount} STAR ${starStoryCount === 1 ? "story" : "stories"} from this role's strongest bullets. Each
"bullet" field MUST be copied VERBATIM from your "bullets" array - stories that match no
bullet are discarded by the platform. Draft fewer, or none, if the source cannot support a
real answer.

${starStoryStandard(framework)}`
    : `Return "star_stories" as an empty array for this role.`;

  const retrySection = retryFeedback && retryFeedback.issues.length > 0
    ? `
=== CORRECTIONS REQUIRED - your previous attempt was rejected ===
The platform's checks found these problems:
${retryFeedback.issues.map((issue) => `- ${issue}`).join("\n")}
Previous attempt, for reference only (fix every problem above; do not repeat them):
${retryFeedback.previousBullets.map((b) => `- ${b}`).join("\n")}
`
    : "";

  return `ACT AS:
Principal Resume Intelligence Architect + Tier-1 Technical Recruiter, holding the FAANG
hiring bar. You are rewriting ONE role of a resume; every other role is written separately.
Your output is consumed by a JSON parser, never read as prose by a human.

TARGET ROLE: ${targetRole || "Professional"}
TARGET COMPANY: ${promptCompany || "General Product Tech"}
AUDIENCE: ${audience || "Recruiters"} | MODE: ${mode || "Standard"} | CURRENT DATE: ${currentDate}
CORPORATE DNA: ${corporateDnaFor(promptCompany)}
  Tailor emphasis only. Never rename, reframe, or alter a factual claim to fit a company.
${section(customPrompt, `CUSTOM INSTRUCTIONS: ${customPrompt}`)}

ROLE TO REWRITE:
  Title: ${role.role || "(untitled)"}
  Company: ${role.company || "(unnamed)"}
  Dates: ${role.duration || "(none given)"} - ${tenure}

SOURCE EVIDENCE FOR THIS ROLE (the only facts you may use):
${evidence}
${section(
    brainDump,
    `BRAIN DUMP (raw, unverified): ${brainDump}
Use only what is clearly about THIS role at THIS company. Ignore anything unverifiable.`
  )}

BULLET BUDGET FOR THIS ROLE - HARD LIMIT: ${budgetPhrase(budget)}.${
    budget.label ? `\n  Computed from the role's dates (${tenure}); it overrides your own reading of them.` : ""
  }${shortStint}
  The low end of a range is a target, not a quota: if the source evidences fewer distinct
  achievements, write fewer bullets rather than invent one. Splitting a compound source
  bullet into two genuine achievements is allowed; restating one achievement twice is not.

=== STAR GROUNDING (silent reasoning; DO NOT emit as prose) ===
${STAR_GROUNDING}

=== WRITING RULES (all mandatory) ===
${rules.map((rule, i) => `${i + 1}. ${rule}`).join("\n\n")}
${section(
    jobDescription,
    `
=== TARGET JOB DESCRIPTION (tailor this role against it) ===
${jobDescription}`
  )}

${starSection}
${retrySection}
OUTPUT:
Return ONE valid JSON object and nothing else - no markdown fences, no commentary:
{
  "bullets": ["string"],
  "star_stories": [ { "bullet": "string, copied VERBATIM from bullets", ${STAR_STORY_FIELDS} } ]
}
`;
}
