/**
 * Bullet budgets: the single source of truth for how many bullets each role may
 * carry, and the deterministic enforcement of that rule.
 *
 * A role's budget is decided in two layers:
 *   1. The candidate's Bullet Rules, when supplied and enabled (first match wins):
 *      a pinned company, the N most recent roles, then any other role whose own
 *      evidence shows the target platform (named by the job description, else a
 *      keyword list). These are "rule" roles.
 *   2. The tenure tiers below, for every role no rule claims ("system" roles).
 * A page-fit cap then lowers the system roles, oldest first, so the document
 * stays inside two pages without ever touching a rule role.
 *
 * Without rules, or with rules disabled, the budgets are exactly the tenure-only
 * budgets this module has always produced.
 *
 * The budget is computed here, rendered into every generation prompt, and applied
 * to the finished document, where an over-budget role is trimmed weakest-first.
 *
 * Keeps its deterministic scoring helpers local so the same rules work in the
 * browser and server bundles without app-specific dependencies.
 */

type FigureIndex = Set<string>;

function bulletStrength(text: string): number {
  const value = text.trim();
  const words = value.split(/\s+/).length;
  let score = 0;
  if (/^(architected|built|designed|implemented|migrated|automated|reduced|delivered|led|created|launched|secured|optimized|standardized|refactored)\b/i.test(value)) score += 2;
  else score -= 1;
  if (/\b(worked on|helped|assisted|responsible for|involved in)\b/i.test(value)) score -= 2;
  if (/\b(improved|reduced|increased|enabled|eliminated|prevented|delivered|launched|retired|resolved)\b/i.test(value)) score += 2;
  if (/\b(thing|various|several|multiple|successfully|robust|innovative)\b/i.test(value)) score -= 1;
  if (words > 34 || words < 6) score -= 1;
  if (/\b\d+(?:\.\d+)?%?/.test(value)) score += 0.5;
  return score;
}

function canonicalFigure(value: string): string {
  const number = Number(value.replace(/,/g, ""));
  return Number.isFinite(number) ? String(number) : value;
}

function buildFigureIndex(sourceText: string): FigureIndex {
  const index: FigureIndex = new Set();
  for (const match of String(sourceText || "").matchAll(/\d[\d,]*(?:\.\d+)?/g)) {
    index.add(canonicalFigure(match[0]));
  }
  return index;
}

function findUnsupportedFigures(text: string, index: FigureIndex): string[] {
  return [...String(text || "").matchAll(/[$€£]?\d[\d,]*(?:\.\d+)?%?/g)]
    .map((match) => match[0])
    .filter((figure) => {
      const numeric = figure.replace(/^[$€£]|%$/g, "");
      if (/^(19|20)\d{2}$/.test(numeric)) return false;
      if (["0", "1"].includes(numeric)) return false;
      return !index.has(canonicalFigure(numeric));
    });
}

/** Budgets decided by tenure and recency alone. */
export type TenureBasis =
  | "short_stint"
  | "brief"
  | "sub_year"
  | "current_long"
  | "current_mid"
  | "older_than_10y"
  | "earlier_long"
  | "earlier_mid";

/** Budgets decided by one of the candidate's bullet rules. */
export type RuleBasis = "pinned" | "recent" | "platform_match";

export type BudgetBasis = TenureBasis | RuleBasis | "unparseable";

const RULE_BASES: ReadonlySet<string> = new Set<RuleBasis>(["pinned", "recent", "platform_match"]);

/** True when one of the candidate's bullet rules, not the tenure tiers, decided the budget. */
export function isRuleBasis(basis: unknown): basis is RuleBasis {
  return typeof basis === "string" && RULE_BASES.has(basis);
}

interface BudgetTier {
  min: number;
  max: number;
  rule: string;
}

/**
 * Tiers in precedence order: tenure first, then recency, then age. Tenure
 * dominates deliberately - a long bullet list under a very short stint reads as
 * padding and undermines the credibility of the whole document. Only the
 * candidate's own bullet rules outrank these tiers.
 */
export const BUDGET_TIERS: Record<TenureBasis, BudgetTier> = {
  short_stint: { min: 1, max: 1, rule: "Tenure of 2 months or less" },
  brief: { min: 1, max: 2, rule: "Tenure of 3 to 6 months" },
  sub_year: { min: 2, max: 3, rule: "Tenure of 7 to 12 months" },
  current_long: { min: 6, max: 7, rule: "Current or most recent substantial role, 24+ months" },
  current_mid: { min: 4, max: 5, rule: "Current or most recent substantial role, 13 to 23 months" },
  older_than_10y: { min: 1, max: 2, rule: "Earlier role that ended more than 10 years ago" },
  earlier_long: { min: 3, max: 4, rule: "Earlier role, 24+ months" },
  earlier_mid: { min: 2, max: 3, rule: "Earlier role, 13 to 23 months" },
};

/** A role whose dates cannot be read is never allowed deeper than the deepest tier. */
export const UNPARSEABLE_MAX = 7;

export interface BulletBudget {
  index: number;
  id?: string;
  role: string;
  company: string;
  duration: string;
  tenureMonths: number | null;
  /** Fewest bullets the budget warrants; null when the dates are unparseable and no rule applies. */
  min: number | null;
  /** Hard ceiling, enforced after generation. */
  max: number;
  /** "6-7", "1", or null when the model decides. */
  label: string | null;
  basis: BudgetBasis;
  /** Short human-readable justification, e.g. "55 months, current role". */
  reason: string;
  /** Platform terms found in the role's own evidence (platform rule only). */
  matchedTerms?: string[];
  /** Set when the page-fit cap lowered this budget: the range it had before the cap. */
  fit?: { min: number | null; max: number; label: string | null };
}

export interface BulletBudgetReportRole {
  role: string;
  company: string;
  duration: string;
  tenure_months: number | null;
  budget: string | null;
  min: number | null;
  max: number;
  basis: BudgetBasis;
  reason: string;
  /** Bullets the model produced before enforcement. */
  generated: number;
  /** Bullets that remain in the document. */
  delivered: number;
  status: "within" | "trimmed" | "under" | "unbudgeted";
  /** Bullets removed by enforcement, in their original order. */
  removed: string[];
  /** "rule" when one of the candidate's bullet rules set the budget, "system" for the tenure tiers. */
  source?: "rule" | "system";
  /** True when the page-fit cap lowered this role's budget. */
  fit_trimmed?: boolean;
  /** The budget before the page-fit cap, e.g. "3-4". */
  base_budget?: string | null;
  /** The ceiling before the page-fit cap. */
  base_max?: number;
  /** Platform terms that matched this role's source evidence. */
  matched?: string[];
}

export interface BulletBudgetReport {
  method: string;
  roles: BulletBudgetReportRole[];
  trimmed: number;
  /** True when every role with a budget sits inside it. */
  compliant: boolean;
  /** The bullet rules applied (bullet-rules method only), so a later pass reuses the same decisions. */
  rules?: BulletRules;
  /** How the platform rule chose its platform (bullet-rules method only). */
  platform?: PlatformDecision | null;
  /** What the page-fit cap did (bullet-rules method only). */
  page_fit?: PageFitDecision | null;
}

/** Report method without bullet rules: tenure tiers only. */
export const TENURE_BUDGET_METHOD = "tenure-bullet-budget-v1";
/** Report method when the candidate's bullet rules decided the budgets. */
export const BULLET_RULES_METHOD = "bullet-rules-budget-v2";

/* ------------------------------------------------------------------ *
 * Bullet rules (the candidate's own overrides)
 * ------------------------------------------------------------------ */

export interface BulletRange {
  min: number;
  max: number;
}

export interface PinnedCompanyRule extends BulletRange {
  company: string;
}

export interface BulletRules {
  /** Master switch: false reproduces the tenure-only budgets exactly. */
  enabled: boolean;
  /** The N most recent roles, by end date. */
  recent: BulletRange & { enabled: boolean; count: number };
  /** Any other role whose own evidence shows the target platform. */
  platform: BulletRange & {
    enabled: boolean;
    /** Prefer the platform(s) the job description names; fall back to the keywords. */
    detectFromJd: boolean;
    keywords: string[];
  };
  /** Companies with a fixed budget. Checked first, so a pinned role keeps its count everywhere. */
  pinned: PinnedCompanyRule[];
  /** Total-bullet cap that keeps the document inside two pages. */
  pageFit: { enabled: boolean; maxTotalBullets: number };
}

/** Bounds applied to untrusted rules (request bodies, saved profiles). */
export const BULLET_RULE_LIMITS = {
  maxBulletsPerRole: 10,
  maxRecentCount: 5,
  minTotalBullets: 10,
  maxTotalBullets: 60,
  maxKeywords: 20,
  maxPinned: 10,
  maxTextLength: 60,
} as const;

/** Fresh copy of the default rules: the candidate's own rules, pre-filled. */
export function defaultBulletRules(): BulletRules {
  return {
    enabled: true,
    recent: { enabled: true, count: 2, min: 6, max: 7 },
    platform: { enabled: true, detectFromJd: true, keywords: ["Azure"], min: 4, max: 5 },
    pinned: [{ company: "HCLTech", min: 2, max: 2 }],
    pageFit: { enabled: true, maxTotalBullets: 32 },
  };
}

export const DEFAULT_BULLET_RULES: Readonly<BulletRules> = defaultBulletRules();

function clampInt(value: unknown, lo: number, hi: number, fallback: number): number {
  const n =
    typeof value === "number" ? value : typeof value === "string" && value.trim() ? Number(value) : NaN;
  if (!Number.isFinite(n)) return fallback;
  return Math.min(hi, Math.max(lo, Math.round(n)));
}

function normalizeRange(raw: any, fallback: BulletRange): BulletRange {
  const a = clampInt(raw?.min, 1, BULLET_RULE_LIMITS.maxBulletsPerRole, fallback.min);
  const b = clampInt(raw?.max, 1, BULLET_RULE_LIMITS.maxBulletsPerRole, fallback.max);
  return { min: Math.min(a, b), max: Math.max(a, b) };
}

function cleanRuleText(value: unknown): string {
  return typeof value === "string"
    ? value.replace(/\s+/g, " ").trim().slice(0, BULLET_RULE_LIMITS.maxTextLength)
    : "";
}

function flag(value: unknown, fallback: boolean): boolean {
  return typeof value === "boolean" ? value : fallback;
}

/**
 * Validates and clamps rules from an untrusted source. Missing fields take their
 * default; anything that is not an object yields null, meaning "no rules".
 */
export function normalizeBulletRules(input: unknown): BulletRules | null {
  if (!input || typeof input !== "object" || Array.isArray(input)) return null;
  const raw = input as any;
  const d = defaultBulletRules();

  const keywords: string[] = [];
  const seenKeywords = new Set<string>();
  const rawKeywords: unknown[] = Array.isArray(raw.platform?.keywords) ? raw.platform.keywords : d.platform.keywords;
  for (const value of rawKeywords) {
    const text = cleanRuleText(value);
    const key = text.toLowerCase();
    if (!text || seenKeywords.has(key)) continue;
    seenKeywords.add(key);
    keywords.push(text);
    if (keywords.length >= BULLET_RULE_LIMITS.maxKeywords) break;
  }

  const pinned: PinnedCompanyRule[] = [];
  const seenCompanies = new Set<string>();
  const rawPinned: unknown[] = Array.isArray(raw.pinned) ? raw.pinned : d.pinned;
  for (const value of rawPinned) {
    if (!value || typeof value !== "object") continue;
    const company = cleanRuleText((value as any).company);
    const key = companyMatchKey(company);
    if (!company || !key || seenCompanies.has(key)) continue;
    seenCompanies.add(key);
    pinned.push({ company, ...normalizeRange(value, { min: 2, max: 2 }) });
    if (pinned.length >= BULLET_RULE_LIMITS.maxPinned) break;
  }

  return {
    enabled: flag(raw.enabled, d.enabled),
    recent: {
      enabled: flag(raw.recent?.enabled, d.recent.enabled),
      count: clampInt(raw.recent?.count, 0, BULLET_RULE_LIMITS.maxRecentCount, d.recent.count),
      ...normalizeRange(raw.recent, d.recent),
    },
    platform: {
      enabled: flag(raw.platform?.enabled, d.platform.enabled),
      detectFromJd: flag(raw.platform?.detectFromJd, d.platform.detectFromJd),
      keywords,
      ...normalizeRange(raw.platform, d.platform),
    },
    pinned,
    pageFit: {
      enabled: flag(raw.pageFit?.enabled, d.pageFit.enabled),
      maxTotalBullets: clampInt(
        raw.pageFit?.maxTotalBullets,
        BULLET_RULE_LIMITS.minTotalBullets,
        BULLET_RULE_LIMITS.maxTotalBullets,
        d.pageFit.maxTotalBullets
      ),
    },
  };
}

/** Normalized rules when they are present and switched on; null otherwise. */
export function activeBulletRules(input: unknown): BulletRules | null {
  const rules = normalizeBulletRules(input);
  return rules && rules.enabled ? rules : null;
}

/** Stable identity of a rule set, for cache keys and for reusing earlier decisions. */
export function bulletRulesFingerprint(input: unknown): string {
  const rules = activeBulletRules(input);
  return rules ? JSON.stringify(rules) : "off";
}

/* ------------------------------------------------------------------ *
 * Platform detection and company matching
 * ------------------------------------------------------------------ */

export interface CloudPlatform {
  name: string;
  /** Lower-case terms that evidence the platform, longest first when matched. */
  aliases: string[];
}

export const CLOUD_PLATFORMS: CloudPlatform[] = [
  {
    name: "Azure",
    aliases: ["azure", "microsoft azure", "aks", "entra id", "entra", "bicep", "arm template", "arm templates"],
  },
  {
    name: "AWS",
    aliases: ["aws", "amazon web services", "ec2", "s3", "eks", "cloudformation", "cloudwatch"],
  },
  {
    name: "GCP",
    aliases: ["gcp", "google cloud", "google cloud platform", "gke", "bigquery"],
  },
];

/** A platform must hold at least this share of the posting's platform mentions to count. */
const PLATFORM_MIN_SHARE = 0.3;

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Case-insensitive matcher for whole terms. Boundaries are "not a letter or
 * digit" rather than \b, so terms such as "C#" or ".NET" still match.
 */
export function buildTermPattern(terms: string[]): RegExp | null {
  const parts = Array.from(new Set(terms.map((t) => asText(t).trim().toLowerCase()).filter(Boolean)))
    .sort((a, b) => b.length - a.length)
    .map((t) => escapeRegExp(t).replace(/\s+/g, "[\\s\\-]+"));
  if (parts.length === 0) return null;
  return new RegExp(`(^|[^a-z0-9])(${parts.join("|")})(?=$|[^a-z0-9])`, "gi");
}

/** Every whole-term match of `terms` in `text`, lower-cased, in order of appearance. */
export function findTerms(text: unknown, terms: string[] | RegExp | null): string[] {
  const source = asText(text);
  const pattern = terms instanceof RegExp ? terms : terms ? buildTermPattern(terms) : null;
  if (!source || !pattern) return [];
  const re = new RegExp(pattern.source, "gi");
  const found: string[] = [];
  let match: RegExpExecArray | null;
  while ((match = re.exec(source)) !== null) {
    found.push(match[2].toLowerCase().replace(/[\s\-]+/g, " "));
    if (match[0].length === 0) re.lastIndex += 1;
  }
  return found;
}

/**
 * The cloud platform(s) a job description asks for, most-mentioned first. A
 * platform mentioned only in passing (under 30% of the platform mentions) is
 * ignored, so "AWS a plus" does not dilute an Azure posting.
 */
export function detectJdPlatforms(jobDescription: unknown): string[] {
  const text = asText(jobDescription);
  if (!text.trim()) return [];
  const counts = CLOUD_PLATFORMS.map((platform) => ({
    name: platform.name,
    count: findTerms(text, platform.aliases).length,
  }));
  const total = counts.reduce((sum, c) => sum + c.count, 0);
  if (total === 0) return [];
  return counts
    .filter((c) => c.count > 0 && c.count / total >= PLATFORM_MIN_SHARE)
    .sort((a, b) => b.count - a.count)
    .map((c) => c.name);
}

/** A keyword that names a known platform expands to all of that platform's terms. */
export function platformTermsFor(keyword: string): string[] {
  const key = asText(keyword).trim().toLowerCase();
  if (!key) return [];
  const platform = CLOUD_PLATFORMS.find(
    (p) => p.name.toLowerCase() === key || p.aliases.includes(key)
  );
  return platform ? [...platform.aliases] : [key];
}

const COMPANY_NOISE_WORDS = new Set([
  "the", "inc", "incorporated", "llc", "llp", "ltd", "limited", "pvt", "private", "plc", "corp",
  "corporation", "co", "company", "gmbh", "ag", "sa", "bv", "nv", "pte", "pty", "sdn", "bhd",
]);

/** Remainders that still name the same employer: "HCL" + "Tech", "Infosys" + "India". */
const COMPANY_GENERIC_REMAINDER =
  /^(?:tech|systems|solutions|services|software|consulting|consultancy|group|global|india|international|labs|digital|it)+$/;

/**
 * Compact key for comparing employer names: legal suffixes and punctuation are
 * dropped and "Technologies" folds to "tech", so "HCL Technologies Ltd.",
 * "HCL Tech" and "HCLTech" all become "hcltech".
 */
export function companyMatchKey(name: unknown): string {
  return asText(name)
    .toLowerCase()
    .replace(/\([^)]*\)/g, " ")
    .replace(/&/g, " and ")
    .split(/[^a-z0-9]+/)
    .filter((word) => word && !COMPANY_NOISE_WORDS.has(word))
    .join("")
    .replace(/technolog(?:y|ies)/g, "tech");
}

function companyKeysMatch(x: string, y: string): boolean {
  if (!x || !y) return false;
  if (x === y) return true;
  const [short, long] = x.length <= y.length ? [x, y] : [y, x];
  if (short.length < 3 || !long.startsWith(short)) return false;
  return COMPANY_GENERIC_REMAINDER.test(long.slice(short.length));
}

/**
 * Fuzzy employer match, also tried against each segment of a compound name such
 * as "HCLTech - Noida" or "HCL Technologies | Client: Microsoft".
 */
export function companiesMatch(a: unknown, b: unknown): boolean {
  const segments = (name: unknown) => {
    const text = asText(name);
    const parts = text.split(/\s[-\u2013\u2014|]\s|[|,;/]|\bclient\b|\bvia\b/i);
    return Array.from(new Set([text, ...parts].map(companyMatchKey).filter(Boolean)));
  };
  const left = segments(a);
  const right = segments(b);
  return left.some((x) => right.some((y) => companyKeysMatch(x, y)));
}

function bulletText(value: unknown): string {
  if (typeof value === "string") return value.trim();
  if (value && typeof value === "object") {
    const v = value as { text?: unknown; bullet?: unknown };
    if (typeof v.text === "string") return v.text.trim();
    if (typeof v.bullet === "string") return v.bullet.trim();
  }
  return "";
}

/** A role's own bullets, whichever field the upstream extraction used. */
export function roleSourceBullets(role: any): string[] {
  const list = [role?.original_bullets, role?.achievements, role?.bullets].find(
    (candidate) => Array.isArray(candidate) && candidate.length > 0
  );
  return (Array.isArray(list) ? list : []).map(bulletText).filter(Boolean);
}

/** The evidence the platform rule reads: the role's title and its own bullets. */
export function roleEvidenceText(role: any): string {
  return [asText(role?.role ?? role?.title), ...roleSourceBullets(role)].filter(Boolean).join("\n");
}

/**
 * The roles of a JSON master resume (`experience` or `work_experience`);
 * undefined for free-form text, whose roles are only known after extraction.
 */
export function rolesFromResumeText(resumeText: unknown): any[] | undefined {
  if (typeof resumeText !== "string") return undefined;
  try {
    const source = JSON.parse(resumeText);
    const roles = source?.experience || source?.work_experience;
    return Array.isArray(roles) && roles.length > 0 ? roles : undefined;
  } catch {
    return undefined;
  }
}

/* ------------------------------------------------------------------ *
 * Date parsing
 * ------------------------------------------------------------------ */

const MONTHS: Record<string, number> = {
  jan: 0, feb: 1, mar: 2, apr: 3, may: 4, jun: 5,
  jul: 6, aug: 7, sep: 8, oct: 9, nov: 10, dec: 11,
};

const ONGOING_PATTERN = /\b(?:present|current|currently|now|ongoing|today)\b/;

/** "Jan 2024", "Jan-2024", "Jan/2024", "January 15, 2024", "Sept. 2021". */
const MONTH_YEAR_PATTERN = /\b([a-z]{3,9})\.?(?:[\s\-/]*\d{1,2}(?:st|nd|rd|th)?)?[\s,\-/]*(\d{4})\b/g;
/** "Jan '24", "Jan-24", "Jan/24" - a bare space is ambiguous with a day, so it is not accepted. */
const MONTH_SHORT_YEAR_PATTERN = /\b([a-z]{3,9})\.?\s*['\u2019\-/]\s*(\d{2})\b/g;
/** "2024 Jan", "2024-January". */
const YEAR_MONTH_PATTERN = /\b(\d{4})[\s,\-/]*([a-z]{3,9})\b/g;
const MONTH_WORD =
  /\b(?:jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|june?|july?|aug(?:ust)?|sept?(?:ember)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)\b/;

interface Endpoint {
  date: Date;
  ongoing: boolean;
}

/** First month-name/year pair in the text whose word is a real month. */
function findMonthYear(
  s: string,
  pattern: RegExp,
  monthGroup = 1,
  yearGroup = 2
): { month: number; year: string } | null {
  const re = new RegExp(pattern.source, "g");
  let match: RegExpExecArray | null;
  while ((match = re.exec(s)) !== null) {
    const month = MONTHS[match[monthGroup].slice(0, 3)];
    if (month !== undefined) return { month, year: match[yearGroup] };
  }
  return null;
}

function expandShortYear(yy: number, now: Date): number {
  return yy <= (now.getFullYear() % 100) + 1 ? 2000 + yy : 1900 + yy;
}

function parseEndpoint(part: string, isEnd: boolean, now: Date): Endpoint | null {
  const s = part.trim().toLowerCase();
  if (!s) return null;
  if (ONGOING_PATTERN.test(s)) return { date: now, ongoing: true };

  const monthYear = findMonthYear(s, MONTH_YEAR_PATTERN);
  if (monthYear) return { date: new Date(Number(monthYear.year), monthYear.month, 1), ongoing: false };

  const monthShortYear = findMonthYear(s, MONTH_SHORT_YEAR_PATTERN);
  if (monthShortYear) {
    return {
      date: new Date(expandShortYear(Number(monthShortYear.year), now), monthShortYear.month, 1),
      ongoing: false,
    };
  }

  const yearMonth = findMonthYear(s, YEAR_MONTH_PATTERN, 2, 1);
  if (yearMonth) return { date: new Date(Number(yearMonth.year), yearMonth.month, 1), ongoing: false };

  const numeric = s.match(/\b(\d{1,2})[/\-.](\d{4})\b/);
  if (numeric) {
    const m = Number(numeric[1]);
    if (m >= 1 && m <= 12) return { date: new Date(Number(numeric[2]), m - 1, 1), ongoing: false };
  }

  const isoish = s.match(/\b(\d{4})[/\-.](\d{1,2})\b/);
  if (isoish) {
    const m = Number(isoish[2]);
    if (m >= 1 && m <= 12) return { date: new Date(Number(isoish[1]), m - 1, 1), ongoing: false };
  }

  // A month we could not pin down must not silently widen to a whole year.
  if (MONTH_WORD.test(s)) return null;

  const yearOnly = s.match(/\b(?:19|20)\d{2}\b/);
  if (yearOnly) {
    const y = Number(yearOnly[0]);
    // A bare year covers the whole year: Jan 1 as a start, Dec 31 as an end.
    return { date: isEnd ? new Date(y, 11, 31) : new Date(y, 0, 1), ongoing: false };
  }

  return null;
}

export interface DurationRange {
  start: Date;
  end: Date;
  ongoing: boolean;
}

/**
 * Best-effort parse of a duration string such as "Mar 2022 - Present",
 * "Jan 2024 - Feb 2024", "Jan-2024 - Feb-2024", "Jan '24 - Mar '24", "2016 - 2019",
 * "05/2019 - 08/2021", "2019-05 - 2021-08" or "Jan 2020 to date". Returns null for
 * anything it cannot read confidently, such as "Freelance" - a wrong budget is
 * worse than no budget.
 */
export function parseDurationRange(duration: unknown, now: Date = new Date()): DurationRange | null {
  if (typeof duration !== "string") return null;
  const text = duration
    .replace(/\b(?:till|to|until|up to)\s+(?:date|now|today)\b/gi, " - Present")
    .trim();
  if (!text) return null;

  let parts = text
    .split(/\s+[-\u2013\u2014]+\s+|\s*[\u2013\u2014]+\s*|\s+(?:to|until|through|thru)\s+/i)
    .map((p) => p.trim())
    .filter(Boolean);
  // "2016-2019" and "Jan 2024-Feb 2024" use an unspaced hyphen. Only split on it
  // when nothing else separated the endpoints, so "2019-05 - 2021-08" survives.
  if (parts.length < 2) {
    parts = text.split(/\s*-\s*/).map((p) => p.trim()).filter(Boolean);
  }
  if (parts.length < 2) return null;

  const start = parseEndpoint(parts[0], false, now);
  const end = parseEndpoint(parts[parts.length - 1], true, now);
  if (!start || !end) return null;
  if (end.date.getTime() < start.date.getTime()) return null;
  return { start: start.date, end: end.date, ongoing: end.ongoing };
}

function monthsInclusive(start: Date, end: Date): number {
  const months = (end.getFullYear() - start.getFullYear()) * 12 + (end.getMonth() - start.getMonth());
  return Math.max(1, months + 1);
}

/** Tenure of a role in whole months (inclusive), or null when the duration cannot be parsed. */
export function parseTenureMonths(duration: unknown, now: Date = new Date()): number | null {
  const range = parseDurationRange(duration, now);
  return range ? monthsInclusive(range.start, range.end) : null;
}

/* ------------------------------------------------------------------ *
 * Budget computation
 * ------------------------------------------------------------------ */

function asText(value: unknown): string {
  return typeof value === "string" ? value : value == null ? "" : String(value);
}

function validNow(now: unknown): Date {
  return now instanceof Date && !isNaN(now.getTime()) ? now : new Date();
}

function basisPhrase(basis: BudgetBasis, ongoing: boolean): string {
  switch (basis) {
    case "short_stint":
      return "short stint";
    case "brief":
      return "brief role";
    case "sub_year":
      return "under a year";
    case "current_long":
    case "current_mid":
      return ongoing ? "current role" : "most recent substantial role";
    case "older_than_10y":
      return "ended over 10 years ago";
    case "earlier_long":
    case "earlier_mid":
      return "earlier role";
    default:
      return "dates unreadable";
  }
}

/**
 * Computes the budget for every role in a list. Recency is decided by the actual
 * end dates rather than array position, so an out-of-order extraction cannot hand
 * the "current role" depth to the wrong job.
 *
 * The recency tier goes to any ongoing role and to the most recent SUBSTANTIAL
 * (over 12 months) role, so a candidate whose latest gig was a short contract
 * still gets full depth on the multi-year role that preceded it. When the
 * candidate's own recent-roles rule is on it decides recency instead, so the
 * tiers stop boosting any role.
 */
function tenureBudgets(
  list: any[],
  ranges: (DurationRange | null)[],
  tenure: (number | null)[],
  now: Date,
  currentBoost: boolean
): BulletBudget[] {
  let latestSubstantialEnd = -Infinity;
  ranges.forEach((range, i) => {
    const months = tenure[i];
    if (range && months !== null && months > 12) {
      latestSubstantialEnd = Math.max(latestSubstantialEnd, range.end.getTime());
    }
  });
  const tenYearsAgo = new Date(now.getFullYear() - 10, now.getMonth(), now.getDate()).getTime();

  return list.map((raw, index) => {
    const base = {
      index,
      id: typeof raw?.id === "string" && raw.id ? raw.id : undefined,
      role: asText(raw?.role ?? raw?.title),
      company: asText(raw?.company),
      duration: asText(raw?.duration),
    };
    const range = ranges[index];
    const months = tenure[index];

    if (!range || months === null) {
      return {
        ...base,
        tenureMonths: null,
        min: null,
        max: UNPARSEABLE_MAX,
        label: null,
        basis: "unparseable" as const,
        reason: `dates unreadable - model decides, max ${UNPARSEABLE_MAX}`,
      };
    }

    let basis: TenureBasis;
    if (months <= 2) basis = "short_stint";
    else if (months <= 6) basis = "brief";
    else if (months <= 12) basis = "sub_year";
    else if (currentBoost && (range.ongoing || range.end.getTime() === latestSubstantialEnd)) {
      basis = months >= 24 ? "current_long" : "current_mid";
    } else if (range.end.getTime() < tenYearsAgo) basis = "older_than_10y";
    else basis = months >= 24 ? "earlier_long" : "earlier_mid";

    const tier = BUDGET_TIERS[basis];
    return {
      ...base,
      tenureMonths: months,
      min: tier.min,
      max: tier.max,
      label: tier.min === tier.max ? `${tier.min}` : `${tier.min}-${tier.max}`,
      basis,
      reason: `${months} months, ${basisPhrase(basis, range.ongoing)}`,
    };
  });
}

export interface BudgetOptions {
  now?: Date;
  /** The candidate's bullet rules. Omitted, null or disabled: the tenure tiers alone. */
  rules?: BulletRules | null;
  /** The target posting; the platform rule favours the platform it names. */
  jobDescription?: string;
  /** Evidence the platform rule reads for a role; defaults to its title and own bullets. */
  evidenceFor?: (role: any, index: number) => string;
}

export interface PlatformDecision {
  /** Where the matched terms came from: the posting, the keyword list, or nothing matched. */
  source: "jd" | "keywords" | "none";
  /** The platforms or keywords the rule matched on. */
  names: string[];
  /** Platforms the posting named, even when no role showed them. */
  jd_platforms: string[];
}

export interface PageFitDecision {
  cap: number;
  /** Sum of every role's ceiling before the cap. */
  before: number;
  /** Sum after the cap lowered the system roles; above the cap only when rule roles alone exceed it. */
  after: number;
  /** Roles the cap lowered. */
  trimmed_roles: number;
}

export interface BudgetPlan {
  budgets: BulletBudget[];
  /** The rules applied; null when only the tenure tiers were used. */
  rules: BulletRules | null;
  platform: PlatformDecision | null;
  pageFit: PageFitDecision | null;
}

function rangeLabel(min: number | null, max: number): string | null {
  if (min === null) return null;
  return min === max ? `${min}` : `${min}-${max}`;
}

function ruleBudget(prev: BulletBudget, basis: RuleBasis, range: BulletRange, why: string): BulletBudget {
  const { index, id, role, company, duration, tenureMonths } = prev;
  return {
    index,
    id,
    role,
    company,
    duration,
    tenureMonths,
    min: range.min,
    max: range.max,
    label: rangeLabel(range.min, range.max),
    basis,
    reason: `${tenureMonths !== null ? `${tenureMonths} months` : "dates unreadable"}, ${why}`,
  };
}

/**
 * Indices of the `count` most recent roles by end date (ongoing roles first,
 * then the later start). A role with unreadable dates cannot be placed, so it is
 * left out - unless no role has readable dates, when document order is trusted.
 */
function recentWindow(ranges: (DurationRange | null)[], count: number): Set<number> {
  if (count <= 0) return new Set();
  const dated = ranges
    .map((range, index) => ({ range, index }))
    .filter((entry): entry is { range: DurationRange; index: number } => entry.range !== null);
  const order =
    dated.length > 0
      ? dated
          .sort(
            (a, b) =>
              b.range.end.getTime() - a.range.end.getTime() ||
              b.range.start.getTime() - a.range.start.getTime() ||
              a.index - b.index
          )
          .map((entry) => entry.index)
      : ranges.map((_, index) => index);
  return new Set(order.slice(0, count));
}

/**
 * Roles (among `eligible`) whose own evidence shows the target platform. The
 * posting's platform wins; when it names none, or no eligible role shows it,
 * the candidate's keyword list decides.
 */
function matchPlatformRoles(
  list: any[],
  eligible: number[],
  rules: BulletRules,
  options: BudgetOptions
): { matches: Map<number, string[]>; decision: PlatformDecision } {
  const evidence = (index: number): string => {
    if (options.evidenceFor) {
      try {
        return asText(options.evidenceFor(list[index], index));
      } catch {
        // Fall through to the role's own evidence.
      }
    }
    return roleEvidenceText(list[index]);
  };
  const rolesShowing = (terms: string[]) => {
    const matches = new Map<number, string[]>();
    const pattern = buildTermPattern(terms);
    if (!pattern) return matches;
    for (const index of eligible) {
      const found = Array.from(new Set(findTerms(evidence(index), pattern)));
      if (found.length > 0) matches.set(index, found);
    }
    return matches;
  };

  const jdPlatforms = rules.platform.detectFromJd ? detectJdPlatforms(options.jobDescription) : [];
  if (jdPlatforms.length > 0) {
    const matches = rolesShowing(jdPlatforms.flatMap(platformTermsFor));
    if (matches.size > 0) {
      return { matches, decision: { source: "jd", names: jdPlatforms, jd_platforms: jdPlatforms } };
    }
  }
  const keywords = rules.platform.keywords;
  const matches = rolesShowing(keywords.flatMap(platformTermsFor));
  return {
    matches,
    decision: {
      source: matches.size > 0 ? "keywords" : "none",
      names: matches.size > 0 ? [...keywords] : [],
      jd_platforms: jdPlatforms,
    },
  };
}

/**
 * Lowers the system (tenure-tier) roles until the total ceiling fits the cap:
 * one bullet at a time, round-robin, oldest role first (unreadable dates before
 * all of them), never below 1 bullet and never touching a rule role. If the rule
 * roles alone exceed the cap they stand - the candidate set them - and the PDF
 * auto-fit remains the safety net.
 */
function applyPageFit(
  budgets: BulletBudget[],
  ranges: (DurationRange | null)[],
  cap: number
): PageFitDecision {
  const total = () => budgets.reduce((sum, b) => sum + b.max, 0);
  const before = total();
  const order = budgets
    .filter((budget) => !isRuleBasis(budget.basis))
    .sort((a, b) => {
      const ra = ranges[a.index];
      const rb = ranges[b.index];
      if (!ra || !rb) return (ra ? 1 : 0) - (rb ? 1 : 0) || b.index - a.index;
      return (
        ra.end.getTime() - rb.end.getTime() ||
        ra.start.getTime() - rb.start.getTime() ||
        b.index - a.index
      );
    });

  let over = before - cap;
  while (over > 0) {
    let progressed = false;
    for (const budget of order) {
      if (over <= 0) break;
      if (budget.max <= 1) continue;
      if (!budget.fit) budget.fit = { min: budget.min, max: budget.max, label: budget.label };
      budget.max -= 1;
      if (budget.min !== null && budget.min > budget.max) budget.min = budget.max;
      over -= 1;
      progressed = true;
    }
    if (!progressed) break;
  }

  let trimmedRoles = 0;
  for (const budget of order) {
    if (!budget.fit) continue;
    trimmedRoles += 1;
    if (budget.label === null) {
      budget.reason = `dates unreadable - model decides, max ${budget.max} (page fit lowered it from ${budget.fit.max})`;
    } else {
      budget.label = rangeLabel(budget.min, budget.max);
      budget.reason = `${budget.reason}; page fit lowered ${budget.fit.label} to ${budget.label}`;
    }
  }
  return { cap, before, after: total(), trimmed_roles: trimmedRoles };
}

/**
 * Plans every role's budget. Precedence, first match wins:
 *   1. pinned company  2. the N most recent roles (by end date; a pinned role in
 *   that window keeps its pinned count)  3. platform match  4. tenure tiers.
 * Then the page-fit cap lowers tenure-tier roles, oldest first.
 *
 * Without active rules this is exactly the tenure-only plan.
 */
export function planBulletBudgets(roles: unknown, options: BudgetOptions = {}): BudgetPlan {
  const list: any[] = Array.isArray(roles) ? roles : [];
  const now = validNow(options.now);
  const rules = activeBulletRules(options.rules);
  const ranges = list.map((role) => parseDurationRange(role?.duration, now));
  const tenure = ranges.map((range) => (range ? monthsInclusive(range.start, range.end) : null));
  const recentOn = rules !== null && rules.recent.enabled && rules.recent.count > 0;

  const budgets = tenureBudgets(list, ranges, tenure, now, !recentOn);
  if (!rules) return { budgets, rules: null, platform: null, pageFit: null };

  const claimed = new Set<number>();
  list.forEach((raw, index) => {
    const pin = rules.pinned.find((rule) => companiesMatch(rule.company, raw?.company));
    if (!pin) return;
    budgets[index] = ruleBudget(budgets[index], "pinned", pin, `bullet rule - pinned company ${pin.company}`);
    claimed.add(index);
  });

  if (recentOn) {
    const which =
      rules.recent.count === 1 ? "the most recent role" : `one of the ${rules.recent.count} most recent roles`;
    for (const index of recentWindow(ranges, rules.recent.count)) {
      if (claimed.has(index)) continue;
      budgets[index] = ruleBudget(budgets[index], "recent", rules.recent, `bullet rule - ${which}`);
      claimed.add(index);
    }
  }

  let platform: PlatformDecision | null = null;
  if (rules.platform.enabled) {
    const eligible = list.map((_, index) => index).filter((index) => !claimed.has(index));
    const { matches, decision } = matchPlatformRoles(list, eligible, rules, options);
    platform = decision;
    const shows = decision.names.join("/");
    for (const [index, terms] of matches) {
      budgets[index] = {
        ...ruleBudget(budgets[index], "platform_match", rules.platform, `bullet rule - shows ${shows} experience`),
        matchedTerms: terms,
      };
      claimed.add(index);
    }
  }

  const pageFit = rules.pageFit.enabled ? applyPageFit(budgets, ranges, rules.pageFit.maxTotalBullets) : null;
  return { budgets, rules, platform, pageFit };
}

/** Every role's budget; see planBulletBudgets for the precedence. */
export function computeBulletBudgets(roles: unknown, options: BudgetOptions = {}): BulletBudget[] {
  return planBulletBudgets(roles, options).budgets;
}

/* ------------------------------------------------------------------ *
 * Prompt rendering (so the prompt text can never drift from the code)
 * ------------------------------------------------------------------ */

function countPhrase(range: BulletRange): string {
  return range.min === range.max
    ? `exactly ${range.min} bullet${range.min === 1 ? "" : "s"}`
    : `${range.min}-${range.max} bullets`;
}

/** The candidate's bullet rules as prompt lines, in precedence order; empty when none are active. */
export function describeUserBulletRules(
  rulesInput: unknown,
  platform?: PlatformDecision | null,
  indent = "   "
): string[] {
  const rules = activeBulletRules(rulesInput);
  if (!rules) return [];
  const lines: string[] = [];
  for (const pin of rules.pinned) {
    lines.push(`${indent}- Pinned company "${pin.company}" (however it is spelled): ${countPhrase(pin)}`);
  }
  if (rules.recent.enabled && rules.recent.count > 0) {
    const which = rules.recent.count === 1 ? "The most recent role" : `The ${rules.recent.count} most recent roles`;
    lines.push(`${indent}- ${which}, by end date: ${countPhrase(rules.recent)}`);
  }
  if (rules.platform.enabled) {
    const names = platform && platform.names.length > 0 ? platform.names : rules.platform.keywords;
    if (names.length > 0) {
      lines.push(
        `${indent}- Any other role whose own source shows ${names.join("/")} experience: ${countPhrase(rules.platform)}`
      );
    }
  }
  if (rules.pageFit.enabled) {
    lines.push(
      `${indent}- Page fit: at most ${rules.pageFit.maxTotalBullets} bullets in the whole document; the oldest ` +
        `tenure-tier roles give way first, never a rule role`
    );
  }
  return lines;
}

/**
 * The budget rules as prompt lines, in precedence order. With active bullet
 * rules, the candidate's rules come first and the tenure tiers cover the rest.
 */
export function describeBudgetRules(
  indent = "   ",
  context: { rules?: BulletRules | null; platform?: PlatformDecision | null } = {}
): string {
  const rules = activeBulletRules(context.rules);
  const recentOn = rules !== null && rules.recent.enabled && rules.recent.count > 0;
  const tierIndent = rules ? `${indent}  ` : indent;
  const tierLines = (Object.keys(BUDGET_TIERS) as TenureBasis[])
    .filter((key) => !(recentOn && (key === "current_long" || key === "current_mid")))
    .map((key) => {
      const tier = BUDGET_TIERS[key];
      const count = tier.min === tier.max ? `exactly ${tier.min} bullet` : `${tier.min}-${tier.max} bullets`;
      return `${tierIndent}- ${tier.rule}: ${count}`;
    });
  tierLines.push(
    `${tierIndent}- Dates that cannot be read (e.g. "Freelance"): proportionate to the evidence, never more than ${UNPARSEABLE_MAX}`
  );
  if (!rules) return tierLines.join("\n");
  return [
    `${indent}THE CANDIDATE'S BULLET RULES - they override the tenure tiers (first match wins):`,
    ...describeUserBulletRules(rules, context.platform, `${indent}  `),
    `${indent}TENURE TIERS - for every role no bullet rule claims (first match wins):`,
    ...tierLines,
  ].join("\n");
}

/**
 * One line per role, for the whole-document prompt. `markSource` prefixes each
 * line with [RULE] (set by a bullet rule) or [SYSTEM] (set by the tenure tiers).
 */
export function formatBudgetTable(
  budgets: BulletBudget[],
  indent = "   ",
  options: { markSource?: boolean } = {}
): string {
  return budgets
    .map((budget) => {
      const who = [budget.role, budget.company].filter(Boolean).join(" @ ") || `Role ${budget.index + 1}`;
      const ref = budget.id ? `${budget.id}: ` : "";
      const mark = options.markSource ? (isRuleBasis(budget.basis) ? "[RULE] " : "[SYSTEM] ") : "";
      const count =
        budget.label === null
          ? `model decides, never more than ${budget.max}`
          : budget.min === budget.max
            ? `EXACTLY ${budget.min}`
            : `${budget.min}-${budget.max}`;
      return `${indent}- ${mark}${ref}${who} (${budget.duration || "no dates"}) -> ${count} bullets [${budget.reason}]`;
    })
    .join("\n");
}

/* ------------------------------------------------------------------ *
 * Enforcement
 * ------------------------------------------------------------------ */

function normalizeKey(text: unknown): string {
  return asText(text).toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
}

function roleKey(entry: any): string {
  return [entry?.company, entry?.role ?? entry?.title, entry?.duration].map(normalizeKey).join("|");
}

function isUsableBullet(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

/**
 * The strongest `max` bullets, in their original order. Strength uses action,
 * specificity, outcome and length signals; bullets carrying a figure the source never
 * states are pushed down, bullets backing a STAR story are protected, and a small
 * prior respects the model's own ordering (which the prompts tie to relevance to
 * the posting). Ties go to the earlier bullet.
 */
export function pickStrongestBullets(
  bullets: string[],
  max: number,
  options: {
    protectedKeys?: Set<string>;
    figureIndex?: FigureIndex | null;
    /** Terms (e.g. supported trending skills) that tip a close call toward the bullet carrying them. */
    preferTerms?: string[] | null;
  } = {}
): { kept: string[]; removed: string[] } {
  const usable = bullets.filter(isUsableBullet);
  const limit = Math.max(0, Math.floor(max));
  if (usable.length <= limit) return { kept: usable, removed: [] };

  const prefer = Array.isArray(options.preferTerms) ? buildTermPattern(options.preferTerms) : null;
  const total = usable.length;
  const ranked = usable.map((text, idx) => {
    let score = bulletStrength(text);
    if (options.figureIndex && findUnsupportedFigures(text, options.figureIndex).length > 0) score -= 3;
    if (options.protectedKeys && options.protectedKeys.has(normalizeKey(text))) score += 3;
    if (prefer && findTerms(text, prefer).length > 0) score += 0.5;
    score += total > 1 ? 1 - idx / (total - 1) : 0;
    return { idx, score };
  });
  ranked.sort((a, b) => b.score - a.score || a.idx - b.idx);
  const keep = new Set(ranked.slice(0, limit).map((r) => r.idx));
  return {
    kept: usable.filter((_, idx) => keep.has(idx)),
    removed: usable.filter((_, idx) => !keep.has(idx)),
  };
}

/** Provenance only refines the trim order, so a failure here must never block enforcement. */
function safeFigureIndex(sourceText: string | undefined): FigureIndex | null {
  if (!sourceText) return null;
  try {
    return buildFigureIndex(sourceText);
  } catch (e: any) {
    console.warn("[bulletBudget] Figure provenance unavailable; trimming by strength alone:", e?.message || e);
    return null;
  }
}

export interface EnforceBudgetOptions {
  now?: Date;
  sourceText?: string;
  /**
   * The candidate's bullet rules. Leave undefined to reuse the decisions an
   * earlier pass recorded in the report (server first, then client); pass null
   * or disabled rules to force the tenure tiers.
   */
  rules?: BulletRules | null;
  /** The target posting, for the platform rule. */
  jobDescription?: string;
  /**
   * The source roles with their original bullets, so the platform rule reads the
   * candidate's own evidence rather than the rewrite.
   */
  sourceRoles?: unknown[];
  /** Terms (e.g. supported trending skills) that tip a close trimming call. */
  preferTerms?: string[] | null;
}

function identityKeys(role: any): [string, string] {
  const company = companyMatchKey(role?.company);
  const title = normalizeKey(role?.role ?? role?.title);
  return [`${company}|${title}|${normalizeKey(role?.duration)}`, `${company}|${title}`];
}

/** Maps each generated role to its source role: exact identity, then company and title, then position. */
function sourceEvidenceLookup(
  sourceRoles: unknown,
  experience: any[]
): ((role: any, index: number) => string) | undefined {
  if (!Array.isArray(sourceRoles) || sourceRoles.length === 0) return undefined;
  const exact = new Map<string, any>();
  const loose = new Map<string, any>();
  for (const source of sourceRoles) {
    if (!source || typeof source !== "object") continue;
    const [full, partial] = identityKeys(source);
    if (!exact.has(full)) exact.set(full, source);
    if (!loose.has(partial)) loose.set(partial, source);
  }
  const aligned = sourceRoles.length === experience.length;
  return (role, index) => {
    const [full, partial] = identityKeys(role);
    const match = exact.get(full) ?? loose.get(partial) ?? (aligned ? sourceRoles[index] : undefined);
    return roleEvidenceText(match && typeof match === "object" ? match : role);
  };
}

function isKnownBasis(basis: unknown): basis is BudgetBasis {
  return (
    typeof basis === "string" &&
    (Object.prototype.hasOwnProperty.call(BUDGET_TIERS, basis) || isRuleBasis(basis) || basis === "unparseable")
  );
}

function labelMin(label: unknown): number | null {
  const match = typeof label === "string" ? label.match(/^(\d+)/) : null;
  return match ? Number(match[1]) : null;
}

/** The budget an earlier pass recorded for this role, or null when the record is unusable. */
function budgetFromPrior(prior: any, fresh: BulletBudget): BulletBudget | null {
  if (!prior || typeof prior !== "object" || !isKnownBasis(prior.basis)) return null;
  const max = Number(prior.max);
  if (!Number.isFinite(max) || max < 0) return null;
  const min = prior.min === null || prior.min === undefined ? null : Number(prior.min);
  if (min !== null && !Number.isFinite(min)) return null;

  const budget: BulletBudget = {
    index: fresh.index,
    id: fresh.id,
    role: fresh.role,
    company: fresh.company,
    duration: fresh.duration,
    tenureMonths: typeof prior.tenure_months === "number" ? prior.tenure_months : fresh.tenureMonths,
    min,
    max,
    label: typeof prior.budget === "string" ? prior.budget : null,
    basis: prior.basis,
    reason: asText(prior.reason) || fresh.reason,
  };
  if (Array.isArray(prior.matched)) budget.matchedTerms = prior.matched.filter((t: unknown) => typeof t === "string");
  if (prior.fit_trimmed === true) {
    const baseLabel = typeof prior.base_budget === "string" ? prior.base_budget : null;
    const baseMax = Number(prior.base_max);
    budget.fit = { min: labelMin(baseLabel), max: Number.isFinite(baseMax) ? baseMax : max, label: baseLabel };
  }
  return budget;
}

/**
 * Decides which plan enforcement applies. A report written under bullet rules is
 * authoritative for a later pass that brings no rules, or the same rules, so the
 * client never re-litigates what the server decided from evidence it no longer has.
 */
function resolveBudgetPlan(
  experience: any[],
  priorReport: any,
  previous: Map<string, BulletBudgetReportRole>,
  options: EnforceBudgetOptions
): BudgetPlan {
  const evidenceFor = sourceEvidenceLookup(options.sourceRoles, experience);
  const base = { now: options.now, jobDescription: options.jobDescription, evidenceFor };
  const rulesGiven = options.rules !== undefined;
  const priorRules =
    priorReport && priorReport.method === BULLET_RULES_METHOD ? activeBulletRules(priorReport.rules) : null;
  const reuse =
    priorRules !== null &&
    (!rulesGiven || bulletRulesFingerprint(options.rules) === bulletRulesFingerprint(priorRules));

  if (!reuse) return planBulletBudgets(experience, { ...base, rules: rulesGiven ? options.rules : null });

  const fresh = planBulletBudgets(experience, { ...base, rules: priorRules });
  const objectOrNull = (value: unknown) => (value && typeof value === "object" ? (value as any) : null);
  return {
    budgets: fresh.budgets.map(
      (budget, i) => budgetFromPrior(previous.get(roleKey(experience[i])), budget) ?? budget
    ),
    rules: priorRules,
    platform: objectOrNull(priorReport.platform) ?? fresh.platform,
    pageFit: objectOrNull(priorReport.page_fit) ?? fresh.pageFit,
  };
}

/**
 * Enforces every role's ceiling on a generated resume, mutating resume.experience
 * and attaching resume.bullet_budget_report.
 *
 * Over-budget roles keep their strongest bullets (by the deterministic quality
 * signals above), with bullets backing a STAR story protected and a small prior for
 * the model's own ordering, which the prompts tie to relevance to the posting.
 * Kept bullets retain their original order.
 *
 * A role below its minimum is reported, never padded: inventing a bullet to meet
 * a count is exactly the fabrication the rest of the pipeline exists to prevent.
 *
 * Idempotent, and it carries a previous report forward so a second application
 * (server, then client) still shows what the first one removed. Never throws.
 */
export function enforceBulletBudgets(
  resume: any,
  options: EnforceBudgetOptions = {}
): BulletBudgetReport | null {
  if (!resume || typeof resume !== "object" || !Array.isArray(resume.experience)) return null;

  try {
    const experience: any[] = resume.experience;
    const priorReport =
      resume.bullet_budget_report && typeof resume.bullet_budget_report === "object"
        ? resume.bullet_budget_report
        : null;

    const previous = new Map<string, BulletBudgetReportRole>();
    const priorRoles = priorReport?.roles;
    if (Array.isArray(priorRoles)) {
      for (const prior of priorRoles) {
        if (prior && typeof prior === "object") previous.set(roleKey(prior), prior);
      }
    }

    const plan = resolveBudgetPlan(experience, priorReport, previous, options);
    const budgets = plan.budgets;
    const withRules = plan.rules !== null;

    const protectedBullets = new Set<string>();
    if (Array.isArray(resume.star_stories)) {
      for (const story of resume.star_stories) {
        const key = normalizeKey(story?.bullet);
        if (key) protectedBullets.add(key);
      }
    }

    const figureIndex = safeFigureIndex(options.sourceText);
    const preferTerms = Array.isArray(options.preferTerms) ? options.preferTerms : null;

    const roles: BulletBudgetReportRole[] = experience.map((entry, i) => {
      const budget = budgets[i];
      const bullets: string[] = Array.isArray(entry?.bullets) ? entry.bullets.filter(isUsableBullet) : [];
      let kept = bullets;
      let removed: string[] = [];

      if (bullets.length > budget.max) {
        const picked = pickStrongestBullets(bullets, budget.max, {
          protectedKeys: protectedBullets,
          figureIndex,
          preferTerms,
        });
        kept = picked.kept;
        removed = picked.removed;
        entry.bullets = kept;
      }

      const prior = previous.get(roleKey(entry));
      const priorRemoved = Array.isArray(prior?.removed) ? prior!.removed.filter(isUsableBullet) : [];
      const allRemoved = [...priorRemoved, ...removed];
      const generated = Math.max(
        typeof prior?.generated === "number" ? prior.generated : 0,
        bullets.length
      );
      const delivered = kept.length;

      let status: BulletBudgetReportRole["status"];
      if (allRemoved.length > 0) status = "trimmed";
      else if (budget.label === null) status = "unbudgeted";
      else if (budget.min !== null && delivered < budget.min) status = "under";
      else status = "within";

      const row: BulletBudgetReportRole = {
        role: budget.role,
        company: budget.company,
        duration: budget.duration,
        tenure_months: budget.tenureMonths,
        budget: budget.label,
        min: budget.min,
        max: budget.max,
        basis: budget.basis,
        reason: budget.reason,
        generated,
        delivered,
        status,
        removed: allRemoved,
      };
      if (withRules) {
        row.source = isRuleBasis(budget.basis) ? "rule" : "system";
        row.fit_trimmed = Boolean(budget.fit);
        if (budget.fit) {
          row.base_budget = budget.fit.label;
          row.base_max = budget.fit.max;
        }
        if (budget.matchedTerms && budget.matchedTerms.length > 0) row.matched = budget.matchedTerms;
      }
      return row;
    });

    const report: BulletBudgetReport = {
      method: withRules ? BULLET_RULES_METHOD : TENURE_BUDGET_METHOD,
      roles,
      trimmed: roles.reduce((sum, r) => sum + r.removed.length, 0),
      compliant: roles.every((r) => r.status !== "under" && r.delivered <= r.max),
    };
    if (withRules) {
      report.rules = plan.rules!;
      report.platform = plan.platform;
      report.page_fit = plan.pageFit;
    }
    resume.bullet_budget_report = report;
    return report;
  } catch (e: any) {
    console.warn("[bulletBudget] Budget enforcement failed; document left as generated:", e?.message || e);
    return null;
  }
}
