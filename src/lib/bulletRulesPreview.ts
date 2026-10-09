/**
 * Read-only views of the candidate's bullet rules for the settings panel: the
 * plan each role of the current resume would get, computed with the same
 * planner the optimizer uses, plus small helpers for editing the rules.
 */
import {
  BULLET_RULES_METHOD,
  BULLET_RULE_LIMITS,
  activeBulletRules,
  companiesMatch,
  companyMatchKey,
  isRuleBasis,
  planBulletBudgets,
  rolesFromResumeText,
  type BudgetBasis,
  type BulletBudget,
  type BulletRange,
  type BulletRules,
  type PageFitDecision,
  type PlatformDecision,
  type RuleBasis,
} from "./bulletBudget";

export type PreviewBadge = "pinned" | "recent" | "platform" | "tenure" | "unreadable";
type RuleBadge = Extract<PreviewBadge, "pinned" | "recent" | "platform">;

export interface PreviewRow {
  key: string;
  role: string;
  company: string;
  duration: string;
  /** "6-7", "2", or "up to 7" when the dates cannot be read. */
  label: string;
  max: number;
  /** "rule" when a bullet rule set the count, "system" for the tenure tiers. */
  source: "rule" | "system";
  badge: PreviewBadge;
  badgeText: string;
  reason: string;
  /** The label before the page-fit cap lowered it; null when untouched. */
  fitFrom: string | null;
  /** Platform terms found in the role's evidence, spelled for display. */
  matchedTerms: string[];
}

export interface RulesPreview {
  /** The rules are switched on; otherwise the rows show the tenure-only plan. */
  active: boolean;
  /**
   * ready: rows planned from a JSON resume. free-text: roles are only known after
   * extraction. empty: no resume yet. error: the roles could not be planned.
   */
  status: "ready" | "free-text" | "empty" | "error";
  rows: PreviewRow[];
  /** Sum of every role's ceiling: the most bullets the document can carry. */
  totalMax: number;
  platform: PlatformDecision | null;
  platformNote: string | null;
  pageFit: PageFitDecision | null;
  pageFitNote: string | null;
}

/** "6-7", or "2" when the range is a single count. */
export function rangeText(range: BulletRange): string {
  return range.min === range.max ? `${range.min}` : `${range.min}-${range.max}`;
}

/** How people write the platform terms the engine matches in lower case. */
const TERM_DISPLAY: Record<string, string> = {
  azure: "Azure",
  "microsoft azure": "Microsoft Azure",
  aks: "AKS",
  "entra id": "Entra ID",
  entra: "Entra",
  bicep: "Bicep",
  "arm template": "ARM template",
  "arm templates": "ARM templates",
  aws: "AWS",
  "amazon web services": "Amazon Web Services",
  ec2: "EC2",
  s3: "S3",
  eks: "EKS",
  cloudformation: "CloudFormation",
  cloudwatch: "CloudWatch",
  gcp: "GCP",
  "google cloud": "Google Cloud",
  "google cloud platform": "Google Cloud Platform",
  gke: "GKE",
  bigquery: "BigQuery",
};

/** Matched terms for display: platform terms in their usual spelling, the candidate's own keywords as typed. */
export function displayTerms(terms: string[], keywords: string[] = []): string[] {
  const typed = new Map(keywords.map((keyword) => [keyword.toLowerCase().replace(/[\s-]+/g, " "), keyword]));
  return Array.from(new Set(terms.map((term) => TERM_DISPLAY[term] ?? typed.get(term) ?? term)));
}

function plural(count: number, word: string): string {
  return `${count} ${word}${count === 1 ? "" : "s"}`;
}

function ruleBadge(basis: RuleBasis, platform: PlatformDecision | null): { badge: RuleBadge; text: string } {
  if (basis === "pinned") return { badge: "pinned", text: "Pinned" };
  if (basis === "recent") return { badge: "recent", text: "Recent" };
  const names = platform && platform.names.length > 0 ? platform.names.join("/") : "Platform";
  return { badge: "platform", text: `${names} (${platform?.source === "jd" ? "JD" : "keyword"})` };
}

function badgeFor(basis: BudgetBasis, platform: PlatformDecision | null): { badge: PreviewBadge; text: string } {
  if (isRuleBasis(basis)) return ruleBadge(basis, platform);
  if (basis === "unparseable") return { badge: "unreadable", text: "Dates unreadable" };
  return { badge: "tenure", text: "Tenure" };
}

function toRow(budget: BulletBudget, platform: PlatformDecision | null, keywords: string[]): PreviewRow {
  const { badge, text } = badgeFor(budget.basis, platform);
  return {
    key: `${budget.index}`,
    role: budget.role,
    company: budget.company,
    duration: budget.duration,
    label: budget.label ?? `up to ${budget.max}`,
    max: budget.max,
    source: isRuleBasis(budget.basis) ? "rule" : "system",
    badge,
    badgeText: text,
    reason: budget.reason,
    fitFrom: budget.fit ? budget.fit.label ?? `up to ${budget.fit.max}` : null,
    matchedTerms: displayTerms(budget.matchedTerms ?? [], keywords),
  };
}

/** How the platform rule chose its platform; `shown` counts the roles it claimed. */
function platformSentence(
  rules: BulletRules | null,
  decision: PlatformDecision | null,
  shown: number
): string | null {
  if (!rules || !decision) return null;
  const jd = decision.jd_platforms.join("/");
  const keywords = rules.platform.keywords;
  if (decision.source === "jd") {
    return `${decision.names.join("/")} is named in the job description; ${plural(shown, "other role")} show${shown === 1 ? "s" : ""} it.`;
  }
  if (decision.source === "keywords") {
    const lead = jd
      ? `The job description names ${jd}, but no other role shows it, so your keywords were used`
      : rules.platform.detectFromJd
        ? "No platform is named in the job description, so your keywords were used"
        : "Your keywords were used";
    return `${lead}: ${plural(shown, "other role")} show${shown === 1 ? "s" : ""} ${decision.names.join("/")}.`;
  }
  const terms = Array.from(new Set([...decision.jd_platforms, ...keywords]));
  if (terms.length === 0) {
    return "No platform to look for: add a keyword or paste a job description that names one.";
  }
  return `No other role shows ${terms.join("/")} experience, so the platform rule changes nothing here.`;
}

function describePageFit(fit: PageFitDecision | null): string | null {
  if (!fit) return null;
  if (fit.before <= fit.cap) {
    return `${fit.before} bullets at most - within the ${fit.cap}-bullet cap, nothing trimmed.`;
  }
  if (fit.after <= fit.cap) {
    return `${fit.before} -> ${fit.after} bullets: ${plural(fit.trimmed_roles, "older system role")} trimmed to fit the ${fit.cap}-bullet cap.`;
  }
  return (
    `${fit.before} -> ${fit.after} bullets, still over the ${fit.cap}-bullet cap: system roles are at 1 bullet and ` +
    "rule roles are never trimmed, so the PDF auto-fit takes over."
  );
}

/** What each role of the current resume would get under these rules. */
export function buildRulesPreview(
  rulesInput: unknown,
  resumeText: string,
  jobDescription: string,
  now: Date = new Date()
): RulesPreview {
  const rules = activeBulletRules(rulesInput);
  const empty: RulesPreview = {
    active: rules !== null,
    status: "empty",
    rows: [],
    totalMax: 0,
    platform: null,
    platformNote: null,
    pageFit: null,
    pageFitNote: null,
  };
  if (typeof resumeText !== "string" || !resumeText.trim()) return empty;
  const roles = rolesFromResumeText(resumeText);
  if (!roles) return { ...empty, status: "free-text" };
  try {
    const plan = planBulletBudgets(roles, { now, rules, jobDescription });
    const rows = plan.budgets.map((budget) => toRow(budget, plan.platform, rules?.platform.keywords ?? []));
    return {
      ...empty,
      status: "ready",
      rows,
      totalMax: plan.budgets.reduce((sum, budget) => sum + budget.max, 0),
      platform: plan.platform,
      platformNote: platformSentence(plan.rules, plan.platform, rows.filter((row) => row.badge === "platform").length),
      pageFit: plan.pageFit,
      pageFitNote: describePageFit(plan.pageFit),
    };
  } catch {
    return { ...empty, status: "error" };
  }
}

/** Keywords typed as one line: commas, semicolons or new lines separate them. */
export function splitKeywords(text: string): string[] {
  return String(text ?? "")
    .split(/[,;\n]+/)
    .map((part) => part.trim())
    .filter(Boolean);
}

export interface PinRowStatus {
  /** "empty": no usable company name; "duplicate": an earlier row names the same company. */
  issue: "empty" | "duplicate" | null;
  /** Roles this row would claim (first matching pin wins, as in the planner); null when unknown. */
  matches: number | null;
}

/**
 * Mirrors normalizeBulletRules and planBulletBudgets for the pinned rows being
 * edited: which rows would be ignored, and how many roles each one would claim.
 * Pass roles = undefined for a free-text resume, whose roles are not known yet.
 */
export function pinRowStatus(roles: unknown, companies: string[]): PinRowStatus[] {
  const seen = new Set<string>();
  const cleaned = companies.map((company) =>
    String(company ?? "").replace(/\s+/g, " ").trim().slice(0, BULLET_RULE_LIMITS.maxTextLength)
  );
  const issues = cleaned.map((company) => {
    const key = companyMatchKey(company);
    if (!key) return "empty" as const;
    if (seen.has(key)) return "duplicate" as const;
    seen.add(key);
    return null;
  });
  const counts = cleaned.map(() => 0);
  const list = Array.isArray(roles) ? roles : null;
  for (const role of list ?? []) {
    const owner = cleaned.findIndex((company, i) => issues[i] === null && companiesMatch(company, role?.company));
    if (owner >= 0) counts[owner] += 1;
  }
  return issues.map((issue, i) => ({ issue, matches: list && issue === null ? counts[i] : null }));
}

/** One short phrase per active rule, in precedence order; empty when the rules are off. */
export function bulletRulesSummary(rulesInput: unknown): string[] {
  const rules = activeBulletRules(rulesInput);
  if (!rules) return [];
  const parts: string[] = [];
  for (const pin of rules.pinned) parts.push(`${pin.company}: ${rangeText(pin)}`);
  if (rules.recent.enabled && rules.recent.count > 0) {
    const which = rules.recent.count === 1 ? "Latest role" : `${rules.recent.count} latest roles`;
    parts.push(`${which}: ${rangeText(rules.recent)}`);
  }
  if (rules.platform.enabled) {
    const keywords = rules.platform.keywords.join("/");
    const what = rules.platform.detectFromJd
      ? keywords
        ? `JD platform or ${keywords}`
        : "JD platform"
      : keywords;
    if (what) parts.push(`${what}: ${rangeText(rules.platform)}`);
  }
  if (rules.pageFit.enabled) parts.push(`max ${rules.pageFit.maxTotalBullets} total`);
  return parts;
}

/* ------------------------------------------------------------------ *
 * Finished reports
 * ------------------------------------------------------------------ */

export type ReportBadge = RuleBadge | "system";

export interface ReportRowView {
  badge: ReportBadge;
  /** "Pinned", "Recent", "Azure (JD)", "Azure (keyword)" or "System". */
  badgeText: string;
  /** What set the count, for the badge tooltip. */
  badgeTitle: string;
  /** The budget before the 2-page fit lowered it, e.g. "3-4"; null when untouched. */
  fitFrom: string | null;
  /** Shown under a rule role that ended below its minimum; null otherwise. */
  underNote: string | null;
}

export interface BudgetReportView {
  platformNote: string | null;
  pageFitNote: string | null;
  /** One entry per report role, in the same order. */
  rows: ReportRowView[];
}

const stringList = (value: unknown): string[] | null =>
  Array.isArray(value) && value.every((item) => typeof item === "string") ? (value as string[]) : null;

/** A stored platform decision; null when it is missing or malformed. */
function asPlatformDecision(value: unknown): PlatformDecision | null {
  if (!value || typeof value !== "object") return null;
  const { source, names, jd_platforms } = value as Record<string, unknown>;
  const nameList = stringList(names);
  const jdList = stringList(jd_platforms);
  if (!nameList || !jdList || (source !== "jd" && source !== "keywords" && source !== "none")) return null;
  return { source, names: nameList, jd_platforms: jdList };
}

/** A stored page-fit decision; null when it is missing or malformed. */
function asPageFit(value: unknown): PageFitDecision | null {
  if (!value || typeof value !== "object") return null;
  const { cap, before, after, trimmed_roles } = value as Record<string, unknown>;
  const numbers = [cap, before, after, trimmed_roles];
  if (!numbers.every((n) => typeof n === "number" && Number.isFinite(n))) return null;
  return { cap: cap as number, before: before as number, after: after as number, trimmed_roles: trimmed_roles as number };
}

function reportRowView(role: any, platform: PlatformDecision | null, keywords: string[]): ReportRowView {
  const basis = role?.basis;
  const baseMax = Number(role?.base_max);
  let fitFrom: string | null = null;
  if (role?.fit_trimmed === true) {
    if (typeof role.base_budget === "string" && role.base_budget.trim()) fitFrom = role.base_budget;
    else if (Number.isFinite(baseMax)) fitFrom = `up to ${baseMax}`;
  }
  if (!isRuleBasis(basis)) {
    return {
      badge: "system",
      badgeText: "System",
      badgeTitle: "Set by the system from tenure and recency",
      fitFrom,
      underNote: null,
    };
  }
  const { badge, text } = ruleBadge(basis, platform);
  const matched = displayTerms(stringList(role?.matched) ?? [], keywords);
  const budget = typeof role?.budget === "string" ? role.budget : null;
  return {
    badge,
    badgeText: text,
    badgeTitle: matched.length > 0 ? `Set by your Bullet Rules - shows ${matched.join(", ")}` : "Set by your Bullet Rules",
    fitFrom,
    underNote:
      role?.status === "under" && budget
        ? `Below your rule (${budget}): add more detail about this role to your master resume - bullets are never invented to reach a count.`
        : null,
  };
}

/**
 * How the candidate's bullet rules shaped a finished budget report: a badge per
 * role plus the platform and page-fit decisions. Null for a tenure-only report,
 * which the report card renders exactly as before.
 */
export function describeBudgetReport(report: unknown): BudgetReportView | null {
  if (!report || typeof report !== "object") return null;
  const { method, roles, rules, platform, page_fit } = report as Record<string, unknown>;
  if (method !== BULLET_RULES_METHOD || !Array.isArray(roles)) return null;
  const decision = asPlatformDecision(platform);
  const active = activeBulletRules(rules);
  const rows = roles.map((role) => reportRowView(role, decision, active?.platform.keywords ?? []));
  return {
    platformNote: platformSentence(active, decision, rows.filter((row) => row.badge === "platform").length),
    pageFitNote: describePageFit(asPageFit(page_fit)),
    rows,
  };
}
