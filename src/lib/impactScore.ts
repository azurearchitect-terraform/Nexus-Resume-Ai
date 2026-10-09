/**
 * Deterministic FAANG / STAR impact audit for a resume.
 *
 * matchScore.ts asks "does this resume match THIS posting". This asks "would these
 * bullets survive a top-tier screen, and are the interview stories real", independently
 * of any job description:
 *   - action-verb ownership: a strong past-tense lead, no filler or borrowed credit
 *   - impact stated rather than duties: what each action changed (the XYZ "X")
 *   - measurement balance: a band, not a maximum - under- and over-quantification both cost
 *   - figure provenance: every number traced back to the candidate's own material
 *   - concrete systems named, no passive or "we" phrasing, human cadence variation
 *   - STAR grounding: interview stories that expand a bullet the resume actually makes
 *
 * It is computed, not guessed: the same document always produces the same score, and
 * every deduction points at a specific bullet with a concrete fix. No model call.
 *
 * Adapted from the audit first shipped in PR #3 (eceae3e, ba1c542), which the 6b3e3ec
 * rollback removed.
 *
 * Only imports other dependency-free src/lib modules: it is bundled by both esbuild
 * (node) and vite (browser). No regex lookbehind anywhere - vite's Safari 14 target
 * cannot parse it.
 */

import { namedTechnologies } from "./matchScore";

export interface ImpactFinding {
  id: string;
  severity: "low" | "medium" | "high";
  role: string;
  bullet: string;
  issue: string;
  fix: string;
}

export interface ImpactComponent {
  id: string;
  label: string;
  weight: number;
  /** 0-1. */
  score: number;
  detail: string;
}

export interface ImpactScoreResult {
  method: string;
  /** 0-100. */
  score: number;
  bullets_evaluated: number;
  quantified_ratio: number;
  components: ImpactComponent[];
  findings: ImpactFinding[];
  /** False for a source resume, which has no interview stories to audit. */
  star_expected: boolean;
  star_linked: number;
  star_dropped: number;
  /** Bullets containing a figure that were checked against the source; null when no source was given. */
  figure_bullets: number | null;
  /** Of those, bullets citing a figure that appears nowhere in the source. */
  unverified_figure_bullets: number | null;
  /** Score of the resume as submitted, for an old -> new comparison. Set by the caller. */
  baseline_score?: number | null;
}

export interface ImpactAuditOptions {
  /** The candidate's own material. Enables the figure provenance checks. */
  sourceText?: string;
  /** Audit STAR stories, as for a generated resume. Defaults to true. */
  expectStarStories?: boolean;
}

/* ------------------------------------------------------------------ *
 * Vocabulary
 * ------------------------------------------------------------------ */

/** Verbs that signal execution and ownership. */
const STRONG_VERBS = new Set([
  "architected", "authored", "automated", "benchmarked", "broke", "built", "centralized",
  "codified", "consolidated", "constructed", "containerized", "converted", "created",
  "cut", "debugged", "decomposed", "decoupled", "defined", "delivered", "deployed",
  "deprecated", "designed", "diagnosed", "documented", "doubled", "drove", "eliminated",
  "enabled", "enforced", "engineered", "established", "evaluated", "expanded", "extended",
  "governed", "hardened", "identified", "implemented", "improved", "increased",
  "instrumented", "integrated", "introduced", "isolated", "launched", "led", "lowered",
  "maintained", "mentored", "migrated", "minimized", "modeled", "modernized", "monitored",
  "negotiated", "onboarded", "optimized", "owned", "partnered", "patched", "ported",
  "prevented", "prioritized", "profiled", "provisioned", "rearchitected", "rebuilt",
  "reconciled", "recovered", "reduced", "refactored", "released", "remediated", "removed",
  "replaced", "resolved", "restored", "restructured", "retired", "rewrote", "scaled",
  "scoped", "secured", "shipped", "simplified", "standardized", "streamlined", "tested",
  "tightened", "tuned", "unblocked", "unified", "upgraded", "validated", "wrote",
  // Irregular past tenses that the "-ed" rule below cannot recognise.
  "ran", "won", "grew", "made", "set", "sold", "taught", "took", "brought", "began", "chose",
  "kept", "met", "oversaw", "undertook", "upheld", "spun", "sped", "stood", "laid", "paid",
  "beat", "overcame", "found", "shut", "wound", "held", "gave", "fought", "sought", "drew",
]);

/** Filler verbs that read as AI slop or as borrowed credit. */
const BANNED_VERBS = new Set([
  "spearheaded", "orchestrated", "pioneered", "leveraged", "empowered", "synergized",
  "revolutionized", "championed", "utilized", "facilitated", "helmed", "evangelized",
  "unleashed", "transformed",
]);

/** The banned lead verbs, shared with the generation prompts so prompt and audit cannot disagree. */
export const BANNED_LEAD_VERBS: readonly string[] = Array.from(BANNED_VERBS);

/** "-ed" words that open profile lines rather than accomplishments. */
const NON_VERB_ED = new Set([
  "experienced", "skilled", "talented", "dedicated", "motivated", "seasoned", "certified",
  "detailed", "advanced", "varied", "focused", "based", "related", "oriented", "interested",
  "accredited", "licensed",
]);

/** Phrases that surrender ownership of the work. */
const PASSIVE_PATTERNS: { pattern: RegExp; phrase: string }[] = [
  { pattern: /\bresponsible for\b/, phrase: "responsible for" },
  { pattern: /\bworked on\b/, phrase: "worked on" },
  { pattern: /\bworked with\b/, phrase: "worked with" },
  { pattern: /\bhelped (?:to )?\w+/, phrase: "helped" },
  { pattern: /\bassisted (?:with|in)\b/, phrase: "assisted with" },
  { pattern: /\b(?:was |were )?involved in\b/, phrase: "involved in" },
  { pattern: /\bparticipated in\b/, phrase: "participated in" },
  { pattern: /\bwas part of\b/, phrase: "was part of" },
  { pattern: /\btasked with\b/, phrase: "tasked with" },
  { pattern: /\bduties included\b/, phrase: "duties included" },
  { pattern: /\bcontributed to\b/, phrase: "contributed to" },
  { pattern: /\bexposure to\b/, phrase: "exposure to" },
  { pattern: /\bfamiliar with\b/, phrase: "familiar with" },
  // "We"/"our" hides which part of the work was this person's - the first thing a FAANG
  // screen tries to establish. Matched on lowercased text.
  { pattern: /(?:^|[^a-z0-9/])(?:we|our|ours)\b/, phrase: "we/our" },
];

/**
 * First-person singular in a bullet. Case-sensitive so "I" is not confused with
 * Roman numerals inside words or with "I/O".
 */
const FIRST_PERSON_SINGULAR = /(?:^|[^A-Za-z0-9/])(I(?![A-Za-z0-9/.-])|[Mm]y\b)/g;

/** "Tier I", "Phase I", "Level I": a Roman-numeral label, not the pronoun. */
const NUMERAL_LABEL_BEFORE =
  /\b(?:tier|level|phase|class|type|grade|stage|part|step|section|chapter|group|category|wave|release|version|volume|generation|annex|appendix|schedule|form|title|war)\s*$/i;

function usesFirstPerson(text: string): boolean {
  for (const match of text.matchAll(FIRST_PERSON_SINGULAR)) {
    const token = match[1];
    if (token !== "I") return true;
    const tokenStart = (match.index ?? 0) + match[0].length - token.length;
    if (!NUMERAL_LABEL_BEFORE.test(text.slice(0, tokenStart))) return true;
  }
  return false;
}

/** Words that occupy space without narrowing anything. */
const VAGUE_PATTERNS: { pattern: RegExp; phrase: string }[] = [
  { pattern: /\bvarious\b/, phrase: "various" },
  { pattern: /\bmultiple\b/, phrase: "multiple" },
  { pattern: /\bseveral\b/, phrase: "several" },
  { pattern: /\bnumerous\b/, phrase: "numerous" },
  { pattern: /\bas needed\b/, phrase: "as needed" },
  { pattern: /\bday[- ]to[- ]day\b/, phrase: "day-to-day" },
  { pattern: /\bbest practices\b/, phrase: "best practices" },
  { pattern: /\bcutting[- ]edge\b/, phrase: "cutting-edge" },
  { pattern: /\bstate[- ]of[- ]the[- ]art\b/, phrase: "state-of-the-art" },
  { pattern: /\bworld[- ]class\b/, phrase: "world-class" },
  { pattern: /\bseamless(?:ly)?\b/, phrase: "seamless" },
  { pattern: /\brobust\b/, phrase: "robust" },
  { pattern: /\bhighly (?:scalable|available|efficient)\b/, phrase: "highly scalable/available" },
  { pattern: /\bwide range of\b/, phrase: "wide range of" },
];

/** Signals that a bullet closes on a consequence rather than a duty. */
const OUTCOME_MARKERS = [
  "reducing", "reduced", "cutting", "eliminating", "eliminated", "improving", "improved",
  "increasing", "increased", "enabling", "enabled", "unblocking", "preventing", "prevented",
  "resulting in", "which removed", "which cut", "saving", "saved", "accelerating",
  "shortening", "raising", "lowering", "lifting", "dropping", "freeing", "removing",
  "retiring", "consolidating", "halving", "restoring", "stabilizing", "avoiding",
  "allowing", "so that", "ending", "replacing", "achieving", "leading to", "letting",
];

/** Outcome nouns worth closing on when no number exists. */
const OUTCOME_NOUNS = [
  "uptime", "latency", "downtime", "throughput", "cost", "spend", "churn", "adoption",
  "coverage", "lead time", "cycle time", "mttr", "mtbf", "error rate", "failure rate",
  "toil", "escalation", "escalations", "incident", "incidents", "outage", "outages",
  "backlog", "onboarding time", "build time", "deploy time", "page load", "conversion",
  "retention", "compliance", "audit", "sla", "slo",
];

/** Round figures that read as invented rather than measured. */
const ROUND_NUMBER_PATTERN = /\b(?:10|20|25|30|40|50|60|70|75|80|90|100)%|\b[2-9]x\b|\bover \d+00\b|\bmillions of\b/;

/** Bands for the share of bullets that should carry a number. */
const QUANT_IDEAL_LOW = 0.25;
const QUANT_IDEAL_HIGH = 0.5;

/* ------------------------------------------------------------------ *
 * Helpers
 * ------------------------------------------------------------------ */

function lower(text: string): string {
  return String(text || "").toLowerCase().replace(/\s+/g, " ").trim();
}

function words(text: string): string[] {
  return lower(text).split(" ").filter(Boolean);
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Leading verb of a bullet, ignoring any bullet glyph or quote in front of it. */
function leadVerb(bullet: string): string {
  const tokens = words(String(bullet || "").replace(/^[^A-Za-z]+/, ""));
  if (tokens.length === 0) return "";
  return tokens[0].replace(/[^a-z]/g, "");
}

function isStrongVerb(word: string): boolean {
  if (!word || BANNED_VERBS.has(word)) return false;
  if (STRONG_VERBS.has(word)) return true;
  // Regular past tense not in the list is still a credible action lead.
  return word.length > 4 && word.endsWith("ed") && !NON_VERB_ED.has(word);
}

// Whole words only: "ending" must not fire inside "pending", nor "sla" inside "slack".
const OUTCOME_PATTERN = new RegExp(
  `\\b(?:${[...OUTCOME_MARKERS, ...OUTCOME_NOUNS].map(escapeRegExp).join("|")})(?:s|es)?\\b`
);

function hasOutcome(bullet: string): boolean {
  const text = lower(bullet);
  // ", so new joiners had accounts on day one" closes on a consequence too.
  return OUTCOME_PATTERN.test(text) || /,\s*so\b(?!\s*(?:far|on|forth)\b)/.test(text);
}

/** Technology-shaped tokens: internal capitals, acronyms, alphanumerics, symbols. */
function specificTokenCount(bullet: string): number {
  const raw = String(bullet || "").split(/\s+/);
  let count = 0;
  for (const token of raw) {
    const clean = token.replace(/[^A-Za-z0-9+#./-]/g, "");
    if (clean.length < 2) continue;
    const hasInternalCaps = /[a-z][A-Z]/.test(clean);
    const isAcronym = /^(?=.*[A-Z])[A-Z0-9]{2,6}$/.test(clean);
    const mixesDigits = /[A-Za-z]/.test(clean) && /\d/.test(clean);
    const hasSymbol = /[+#./]/.test(clean) && /[A-Za-z]/.test(clean);
    if (hasInternalCaps || isAcronym || mixesDigits || hasSymbol) count += 1;
  }
  return count;
}

/** First three words, used to detect a repeated sentence skeleton. */
function skeletonOf(bullet: string): string {
  return words(bullet).slice(0, 3).join(" ");
}

function clamp01(value: number): number {
  if (!isFinite(value)) return 0;
  return Math.max(0, Math.min(1, value));
}

function pct(value: number): string {
  return `${Math.round(value * 100)}%`;
}

/* ------------------------------------------------------------------ *
 * Figure provenance
 *
 * Every number a FAANG interviewer reads is a number they will probe. A figure in a
 * generated bullet that appears nowhere in the candidate's own material is the most
 * damaging thing the pipeline can produce, so it is checked mechanically.
 *
 * Deliberately asymmetric: bullet figures are extracted strictly (skipping product
 * names like S3/EC2, years, dates and ratios such as 24/7), while the source index is
 * lenient (every digit run, number words, scaled and converted forms). A false
 * "unverified" accusation erodes trust in the whole audit; a missed small number costs
 * far less.
 * ------------------------------------------------------------------ */

export interface Figure {
  /** As written, e.g. "$2.5M", "43", "380ms", "73%". */
  raw: string;
  /** Canonical numeric value, e.g. "2.5". */
  value: string;
  /** The value with its scale applied ("2500000" for "$2.5M"), when a scale follows. */
  scaled: string | null;
}

export type FigureIndex = Set<string>;

/** Unit suffixes that may sit directly against a figure ("380ms", "2x", "40TB"). */
const FIGURE_UNITS = new Set([
  "k", "m", "mm", "mn", "bn", "b", "x", "ms", "s", "sec", "secs", "min", "mins", "h", "hr",
  "hrs", "d", "tb", "gb", "mb", "kb", "pb", "qps", "rps", "tps", "pct", "percent",
]);

/** Hyphenated compounds that name an architecture or feature rather than claim a quantity. */
const NON_QUANTITY_COMPOUNDS = new Set(["tier", "tiered", "factor", "fa", "way", "on", "click"]);

const SCALES: Record<string, number> = {
  k: 1e3, thousand: 1e3, hundred: 1e2,
  m: 1e6, mm: 1e6, mn: 1e6, million: 1e6,
  b: 1e9, bn: 1e9, billion: 1e9,
};

const SCALE_AFTER = /^\s?(k|mm|mn|m|bn|b|hundred|thousand|million|billion)\b/i;

/** Time units a source figure may be restated in ("1400ms" as "1.4s"). */
const TIME_CONVERSIONS: { pattern: RegExp; factor: number }[] = [
  { pattern: /^\s?ms\b/i, factor: 1 / 1000 },
  { pattern: /^\s?(?:s|sec|secs|seconds?)\b/i, factor: 1000 },
  { pattern: /^\s?(?:min|mins|minutes?)\b/i, factor: 60 },
  { pattern: /^\s?(?:h|hr|hrs|hours?)\b/i, factor: 60 },
];

const NUMBER_WORDS: Record<string, number> = {
  zero: 0, one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9,
  ten: 10, eleven: 11, twelve: 12, thirteen: 13, fourteen: 14, fifteen: 15, sixteen: 16,
  seventeen: 17, eighteen: 18, nineteen: 19, twenty: 20, thirty: 30, forty: 40, fifty: 50,
  sixty: 60, seventy: 70, eighty: 80, ninety: 90, hundred: 100, dozen: 12,
  hundreds: 100, thousands: 1000, millions: 1e6, billions: 1e9,
};

/** Words that state a multiple or fraction a bullet may legitimately render as a figure. */
const RATIO_WORDS: Record<string, string[]> = {
  half: ["50"], halved: ["50", "2"], halving: ["50", "2"], quarter: ["25"],
  doubled: ["2", "100"], doubling: ["2", "100"],
  tripled: ["3", "200"], tripling: ["3", "200"],
  quadrupled: ["4", "300"],
};

/** Own-key lookup, so words such as "constructor" never resolve to Object.prototype members. */
function lookupWord<T>(table: Record<string, T>, key: string | undefined): T | undefined {
  return key !== undefined && Object.prototype.hasOwnProperty.call(table, key) ? table[key] : undefined;
}

function canonicalNumber(intPart: string, fraction?: string): string {
  const int = String(intPart || "").replace(/,/g, "").replace(/^0+(?=\d)/, "");
  const frac = String(fraction || "").replace(/0+$/, "");
  return frac ? `${int}.${frac}` : int;
}

function scaleValue(value: string, factor: number): string {
  const n = Number(value) * factor;
  if (!isFinite(n)) return value;
  // Round away floating-point noise such as 1.4 * 1e6 = 1399999.9999999998.
  return String(Math.round(n * 1000) / 1000);
}

// The preceding character is captured and checked instead of using a lookbehind.
const FIGURE_PATTERN = /(^|[^A-Za-z0-9_./\\])([$€£₹]?)(\d{1,3}(?:,\d{3})+|\d+)(?:\.(\d+))?/g;

/** Words that number the parts of a list or plan ("Step 4", "Phase 2") rather than measure anything. */
const ENUMERATION_LABELS = new Set("step phase stage part wave round sprint point item option".split(" "));

interface PrecedingToken {
  text: string;
  index: number;
}

/** The word written just before position `start`, e.g. "NIST" for the 53 in "NIST 800-53". */
function precedingToken(source: string, start: number): PrecedingToken | null {
  const from = Math.max(0, start - 48);
  // "800-53" is one identifier: its second number belongs to the word before the first.
  const before = source.slice(from, start).replace(/(?:\d+[-/])+$/, "");
  const match = before.match(/([A-Za-z][A-Za-z0-9+#.]*)[^A-Za-z0-9]*$/);
  if (!match || match.index === undefined) return null;
  return { text: match[1].replace(/\.+$/, ""), index: from + match.index };
}

interface ScannedFigure extends Figure {
  /** Index of the currency sign or first digit. */
  start: number;
  /** Index just past the number. */
  end: number;
  currency: boolean;
  percent: boolean;
  /** Unit written directly against the number ("ms" in "380ms"), lowercased; "" when none. */
  unit: string;
}

function scanFigures(text: string): ScannedFigure[] {
  const source = String(text || "");
  const figures: ScannedFigure[] = [];
  const pattern = new RegExp(FIGURE_PATTERN.source, "g");
  let match: RegExpExecArray | null;

  while ((match = pattern.exec(source)) !== null) {
    const currency = match[2];
    const intRaw = match[3];
    const fraction = match[4];
    const start = match.index + match[1].length;
    const end = match.index + match[0].length;
    const rest = source.slice(end);

    if (/^\.\d/.test(rest)) continue; // version strings such as 1.2.3
    if (/^[/:]\d/.test(rest)) continue; // dates, ratios and times: 05/2019, 24/7, 1:1

    // List enumerators order steps; they claim nothing: "2. I grouped...", "(3)", "Step 4:".
    if (!currency && /^[.)](?:\s|$)/.test(rest) && /(?:^|[.;:!?(\n])\s*$/.test(source.slice(0, start))) continue;
    const label = precedingToken(source, start);
    if (label && ENUMERATION_LABELS.has(label.text.toLowerCase())) continue;

    const hyphenated = rest.match(/^-([A-Za-z]+)/);
    if (hyphenated && NON_QUANTITY_COMPOUNDS.has(hyphenated[1].toLowerCase())) continue;

    const letters = rest.match(/^[A-Za-z]+/);
    if (letters && !FIGURE_UNITS.has(letters[0].toLowerCase())) continue; // 5G, 2FA, 1st
    if (letters && /^x\d/i.test(rest)) continue; // 24x7, 1920x1080

    const percent = /^\s?(?:%|percent\b|pct\b)/i.test(rest);
    const scale = rest.match(SCALE_AFTER);
    const value = canonicalNumber(intRaw, fraction);

    const bareYear =
      !currency && !fraction && !letters && !percent && /^\d{4}$/.test(intRaw) &&
      Number(intRaw) >= 1950 && Number(intRaw) <= 2039;
    if (bareYear) continue;

    // A bare 0 or 1 is almost always grammar ("Tier 1", "1 of 3"), not a claim.
    if ((value === "0" || value === "1") && !currency && !percent && !scale) continue;

    const suffix = percent && rest.startsWith("%") ? "%" : letters ? letters[0] : "";
    figures.push({
      raw: `${currency}${intRaw}${fraction ? `.${fraction}` : ""}${suffix}`,
      value,
      scaled: scale ? scaleValue(value, lookupWord(SCALES, scale[1].toLowerCase()) ?? 1) : null,
      start,
      end,
      currency: currency.length > 0,
      percent,
      unit: letters ? letters[0].toLowerCase() : "",
    });
  }
  return figures;
}

/** Figures a bullet asserts, excluding product names, years, dates and ratios. */
export function extractFigures(text: string): Figure[] {
  return scanFigures(text).map(({ raw, value, scaled }) => ({ raw, value, scaled }));
}

const MONTH_NUMBERS: Record<string, number> = {
  jan: 0, feb: 1, mar: 2, apr: 3, may: 4, jun: 5, jul: 6, aug: 7, sep: 8, oct: 9, nov: 10, dec: 11,
};
const TENURE_DATE = "(?:(?:jan|feb|mar|apr|may|jun|jul|aug|sep|sept|oct|nov|dec)[a-z]*\\.?,?\\s*(?:19|20)\\d{2}|\\d{1,2}[/.-](?:19|20)\\d{2}|(?:19|20)\\d{2})";
const TENURE_RANGE = new RegExp(
  `(${TENURE_DATE})\\s*(?:-|\\u2013|\\u2014|to|until|till|through)\\s*(${TENURE_DATE}|present|current|now|till date|to date|today|ongoing)`,
  "gi"
);

function monthOrdinal(value: string, isEnd: boolean): number | null {
  const text = value.toLowerCase().trim();
  if (/^(?:present|current|now|till date|to date|today|ongoing)$/.test(text)) {
    const now = new Date();
    return now.getFullYear() * 12 + now.getMonth();
  }
  let match = text.match(/^([a-z]{3,9})\.?,?\s*((?:19|20)\d{2})$/);
  const month = match ? lookupWord(MONTH_NUMBERS, match[1].slice(0, 3)) : undefined;
  if (match && month !== undefined) return Number(match[2]) * 12 + month;
  match = text.match(/^(\d{1,2})[/.-]((?:19|20)\d{2})$/);
  if (match && Number(match[1]) >= 1 && Number(match[1]) <= 12) return Number(match[2]) * 12 + Number(match[1]) - 1;
  match = text.match(/^((?:19|20)\d{2})$/);
  return match ? Number(match[1]) * 12 + (isEnd ? 11 : 0) : null;
}

/** Tenure a story may state from the source's own dates: "40 months", "3 years". */
function tenureFigures(text: string): string[] {
  const figures: string[] = [];
  for (const match of text.matchAll(TENURE_RANGE)) {
    const start = monthOrdinal(match[1], false);
    const end = monthOrdinal(match[2], true);
    if (start === null || end === null || end < start) continue;
    const months = end - start + 1;
    figures.push(String(months), String(Math.floor(months / 12)), String(Math.round(months / 12)));
  }
  return figures;
}

/**
 * Every numeric value the candidate's own material supports, in all the forms a bullet
 * may restate it. With options.tenure, the time spent in each dated role counts too -
 * stories legitimately say "over my 40 months there"; bullets never need to.
 */
export function buildFigureIndex(sourceText: string, options: { tenure?: boolean } = {}): FigureIndex {
  const index: FigureIndex = new Set();
  const text = String(sourceText || "");
  if (options.tenure) tenureFigures(text).forEach((figure) => index.add(figure));

  const numberPattern = /(\d{1,3}(?:,\d{3})+|\d+)(?:\.(\d+))?/g;
  let match: RegExpExecArray | null;
  while ((match = numberPattern.exec(text)) !== null) {
    const value = canonicalNumber(match[1], match[2]);
    index.add(value);
    const after = text.slice(match.index + match[0].length, match.index + match[0].length + 12);
    const scale = after.match(SCALE_AFTER);
    if (scale) index.add(scaleValue(value, lookupWord(SCALES, scale[1].toLowerCase()) ?? 1));
    for (const conversion of TIME_CONVERSIONS) {
      if (conversion.pattern.test(after)) index.add(scaleValue(value, conversion.factor));
    }
  }

  const tokens = text.toLowerCase().match(/[a-z]+/g) || [];
  for (let i = 0; i < tokens.length; i++) {
    const ratio = lookupWord(RATIO_WORDS, tokens[i]);
    if (ratio) ratio.forEach((v) => index.add(v));

    const base = lookupWord(NUMBER_WORDS, tokens[i]);
    if (base === undefined) continue;
    index.add(String(base));

    let value = base;
    let next = i + 1;
    const unit = lookupWord(NUMBER_WORDS, tokens[next]);
    if (base >= 20 && base <= 90 && base % 10 === 0 && unit !== undefined && unit >= 1 && unit <= 9) {
      value = base + unit; // "twenty five"/"twenty-five"
      index.add(String(value));
      next += 1;
    }
    const scaleWord = tokens[next];
    const scaleFactor = scaleWord && scaleWord.length > 2 ? lookupWord(SCALES, scaleWord) : undefined;
    if (scaleFactor) {
      index.add(scaleValue(String(value), scaleFactor)); // "two million"
    }
  }
  return index;
}

/** Figures in the text that the source does not support, as written. */
export function findUnsupportedFigures(text: string, source: FigureIndex | string): string[] {
  const index = typeof source === "string" ? buildFigureIndex(source) : source;
  return extractFigures(text)
    .filter((figure) => !index.has(figure.value) && !(figure.scaled && index.has(figure.scaled)))
    .map((figure) => figure.raw);
}

/* ------------------------------------------------------------------ *
 * Quantification
 *
 * A bare number only counts as a measurement when its context makes it one. Without
 * this, "Windows Server 2019", "Microsoft 365", "ISO 27001" or "AZ-104" would make an
 * infrastructure resume look quantified when it states no measure at all.
 * ------------------------------------------------------------------ */

/** Multiples stated in words: "doubled throughput", "a three-fold drop". */
const MULTIPLE_PATTERN =
  /\b(?:doubled|doubling|tripled|tripling|quadrupled|halved|halving|(?:two|three|four|five|ten|\d+(?:\.\d+)?)[\s-]?fold)\b/i;

/** Nouns that make a bare number a count of something: "1,200 users", "340 VMs". */
const COUNT_NOUNS = new Set(
  ("user customer client employee engineer developer analyst people person member staff report hire " +
    "intern student patient partner vendor supplier stakeholder team squad department unit org " +
    "organization organisation server vm machine host node cluster container pod instance endpoint " +
    "device laptop desktop workstation printer phone tablet asset site office location branch store " +
    "warehouse plant factory facility datacenter campus country region market city tenant subscription " +
    "account mailbox license licence seat app application service microservice api database db table " +
    "schema repo repository project product feature release deployment build test script runbook " +
    "playbook policy control rule alert dashboard ticket incident request case call issue bug defect " +
    "vulnerability finding change migration workload environment pipeline job workflow process " +
    "transaction order shipment package parcel sku item record row document file page line commit " +
    "query event message log metric lead deal opportunity contract course certification module " +
    "lesson session training participant attendee school hospital vehicle truck route flight mile km " +
    "kg tonne ton pallet terabyte gigabyte petabyte megabyte tb gb pb mb rps qps tps hit visit visitor " +
    "download install signup subscriber follower view impression click conversion sale piece batch " +
    "integration connector interface network vlan firewall switch router link circuit domain " +
    "certificate identity group role permission gpo laptop handset kiosk terminal screen region zone").split(" ")
);

const TIME_UNIT_WORDS = new Set(
  "ms millisecond second sec minute min hour hr day week month quarter year yr".split(" ")
);

/** Words after which a number names a version, model or standard: "Windows 10", "ISO 27001", "AZ-104". */
const VERSION_PRECEDERS = new Set(
  ("windows server office microsoft dynamics exchange sharepoint sql iso iec soc pci dss nist python " +
    "java jdk node php perl ruby rails net dotnet angular react vue ios android macos ubuntu rhel centos " +
    "debian fedora suse oracle db tls ssl http https ipv oauth saml wifi bluetooth usb ddr pcie level " +
    "tier phase version ver release gen generation wave sprint step stage grade class type category cat " +
    "layer priority sev severity p l az ms sc dp ai pl md mb itil cmmi fortune covid web industry hl gpt " +
    "llama claude gemini gemma mistral phi chapter section rule article part room floor building block " +
    "sector plot").split(" ")
);

/** Words after which a number is a measurement: "by 38", "from 14 to 3", "a team of 6". */
const QUANTITY_PRECEDERS = new Set(
  "by from to over under within than across nearly approximately about around almost roughly up of".split(" ")
);

/**
 * True when the word before a number makes it a version, model or identifier rather
 * than a count: "Windows 11", "PowerShell 7", "Node.js 20", "NIST 800-53", "Jenkins 2".
 */
function namesAVersion(token: PrecedingToken | null, source: string): boolean {
  if (!token) return false;
  const word = token.text;
  if (VERSION_PRECEDERS.has(word.toLowerCase())) return true;
  if (/[a-z][A-Z]/.test(word) || word.includes(".")) return true; // PowerShell, vSphere, MySQL, Node.js
  if (/^[A-Z]{2,6}$/.test(word)) return true; // ISO, NIST, CSF, PHP
  // A capitalised word right before a number names a product or place - unless it is the
  // bullet's opening verb, as in "Migrated 340 VMs".
  return /^[A-Z]/.test(word) && token.index > source.search(/[A-Za-z]/);
}

function wordForms(token: string): string[] {
  return [token, token.replace(/ies$/, "y"), token.replace(/es$/, ""), token.replace(/s$/, "")];
}

function isCountWord(token: string): boolean {
  return wordForms(token).some((form) => COUNT_NOUNS.has(form));
}

function isTimeWord(token: string): boolean {
  return wordForms(token).some((form) => TIME_UNIT_WORDS.has(form));
}

function isQuantified(text: string): boolean {
  const source = String(text || "");
  if (MULTIPLE_PATTERN.test(source)) return true;
  for (const figure of scanFigures(source)) {
    if (figure.currency || figure.percent || figure.scaled !== null || figure.unit) return true;
    const before = precedingToken(source, figure.start);
    if (namesAVersion(before, source)) continue;
    if (before && QUANTITY_PRECEDERS.has(before.text.toLowerCase())) return true;
    const following = source
      .slice(figure.end, figure.end + 60)
      .toLowerCase()
      .split(/[^a-z]+/)
      .filter(Boolean)
      .slice(0, 3);
    if (following.some(isTimeWord)) return true;
    // Nobody runs 1.29 clusters: a decimal before a count noun is a version.
    if (!figure.raw.includes(".") && following.some(isCountWord)) return true;
  }
  return false;
}

/* ------------------------------------------------------------------ *
 * Bullet inspection
 * ------------------------------------------------------------------ */

const WE_VOICE = /(?:^|[^A-Za-z0-9])(?:[Ww]e|[Oo]ur|us)(?![A-Za-z0-9])/g;
const I_VOICE = /(?:^|[^A-Za-z0-9])(?:I(?![A-Za-z0-9/])|[Mm]y(?![A-Za-z0-9])|me(?![A-Za-z0-9]))/g;

function countMatches(text: string, pattern: RegExp): number {
  return (String(text || "").match(pattern) || []).length;
}

/**
 * True when a STAR action is told as "we" more than as "I". Behavioral loops credit
 * only what the candidate personally did, so a "we" story scores nothing.
 */
export function isWeVoice(text: string): boolean {
  const we = countMatches(text, WE_VOICE);
  return we > 0 && we > countMatches(text, I_VOICE);
}

export interface BulletInspection {
  lead: string;
  strongLead: boolean;
  bannedLead: boolean;
  /** The passive or borrowed-credit phrase found, if any. */
  passive: string | null;
  vague: string | null;
  firstPerson: boolean;
  quantified: boolean;
  roundNumber: boolean;
  /** Closes on a consequence (or a measurement) rather than a duty. */
  outcome: boolean;
  /** Names a concrete technology, platform or system. */
  specific: boolean;
  words: number;
}

/** Every per-bullet signal the audit uses, computed once. */
export function inspectBullet(text: string): BulletInspection {
  const raw = String(text || "");
  const low = lower(raw);
  const lead = leadVerb(raw);
  const quantified = isQuantified(raw);
  const passiveHit = PASSIVE_PATTERNS.find((p) => p.pattern.test(low));
  const vagueHit = VAGUE_PATTERNS.find((p) => p.pattern.test(low));
  return {
    lead,
    strongLead: isStrongVerb(lead),
    bannedLead: BANNED_VERBS.has(lead),
    passive: passiveHit ? passiveHit.phrase : null,
    vague: vagueHit ? vagueHit.phrase : null,
    firstPerson: usesFirstPerson(raw),
    quantified,
    roundNumber: quantified && ROUND_NUMBER_PATTERN.test(low),
    outcome: quantified || hasOutcome(raw),
    specific: specificTokenCount(raw) > 0 || namedTechnologies(raw).length > 0,
    words: words(raw).length,
  };
}

/* ------------------------------------------------------------------ *
 * Documents
 * ------------------------------------------------------------------ */

interface BulletRef {
  role: string;
  company: string;
  index: number;
  text: string;
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

function rolesOf(resume: any): any[] {
  if (Array.isArray(resume?.experience)) return resume.experience;
  if (Array.isArray(resume?.work_experience)) return resume.work_experience;
  return [];
}

/** A role's bullets, whichever field the upstream extraction used. */
function roleBullets(role: any): string[] {
  const list = [role?.bullets, role?.achievements, role?.original_bullets].find(
    (candidate) => Array.isArray(candidate) && candidate.length > 0
  );
  return (Array.isArray(list) ? list : []).map(bulletText).filter(Boolean);
}

function collectBullets(resume: any): BulletRef[] {
  const out: BulletRef[] = [];
  for (const role of rolesOf(resume)) {
    roleBullets(role).forEach((text, index) => {
      out.push({
        role: String(role?.role || role?.title || "Role"),
        company: String(role?.company || ""),
        index,
        text,
      });
    });
  }
  return out;
}

/**
 * A resume in the shape the audit reads: a parsed object as-is, a JSON string parsed
 * (tolerating text appended after it), or plain text reduced to its bulleted lines.
 * Returns null when there is nothing bullet-shaped to audit.
 */
export function resumeForAudit(input: unknown): any | null {
  if (input && typeof input === "object") return input;
  if (typeof input !== "string") return null;
  const text = input.trim();
  if (!text) return null;

  if (text.startsWith("{")) {
    try {
      return JSON.parse(text);
    } catch {
      const end = text.lastIndexOf("}");
      try {
        if (end > 0) return JSON.parse(text.slice(0, end + 1));
      } catch {
        // Not JSON after all; read it as plain text below.
      }
    }
  }

  const bullets = text
    .split(/\r?\n/)
    .map((line) => line.match(/^\s*(?:[-*\u2022\u25AA\u25CF\u25E6\u25BA\u2023\u2013\u2014]|\d{1,2}[.)])\s+(.+)$/))
    .filter((match): match is RegExpMatchArray => match !== null)
    .map((match) => match[1].trim())
    // Skill lists ("- Python") are not accomplishments.
    .filter((line) => line.split(/\s+/).length >= 4);
  return bullets.length > 0 ? { experience: [{ role: "Resume", company: "", bullets }] } : null;
}

/* ------------------------------------------------------------------ *
 * STAR linkage
 * ------------------------------------------------------------------ */

function normalizeForMatch(text: string): string {
  return lower(text).replace(/[^a-z0-9 ]/g, "");
}

/**
 * Minimum length before a non-exact STAR bullet match is trusted. Short stubs
 * prefix-match unrelated bullets, and a mis-link is worse than a dropped story: it
 * hands the candidate an interview answer for work the bullet never claimed.
 */
const MIN_FALLBACK_KEY_LENGTH = 25;

const STORY_TEXT_FIELDS = ["competency", "question", "situation", "task", "action", "result", "learning"];
const STORY_LIST_FIELDS = ["follow_ups", "prep_gaps"];

/** Model output is rendered as-is, so every story field is coerced to text or a list of text. */
function normalizeStory(story: any): any {
  const out = { ...story };
  for (const field of STORY_TEXT_FIELDS) {
    const value = out[field];
    if (value === undefined || typeof value === "string") continue;
    if (Array.isArray(value)) out[field] = value.filter((item) => typeof item === "string").join(" ");
    else out[field] = typeof value === "number" || typeof value === "boolean" ? String(value) : "";
  }
  for (const field of STORY_LIST_FIELDS) {
    const value = out[field];
    if (value === undefined) continue;
    out[field] = typeof value === "string" ? [value] : Array.isArray(value) ? value.filter((item) => typeof item === "string") : [];
  }
  return out;
}

/**
 * Ties each STAR story back to the bullet it expands and discards the ones that do
 * not correspond to any bullet in the resume.
 *
 * The prompts require star_stories[].bullet to be copied verbatim from a bullet in
 * experience. A story that matches nothing describes work the document does not
 * claim - exactly the fabrication the pipeline exists to prevent - and it would be
 * handed to the candidate as interview prep.
 */
export function linkStarStories(resume: any): { kept: number; dropped: number } {
  const stories = Array.isArray(resume?.star_stories) ? resume.star_stories : null;
  if (!stories) return { kept: 0, dropped: 0 };

  const bullets = collectBullets(resume);
  const byText = new Map<string, BulletRef>();
  for (const bullet of bullets) byText.set(normalizeForMatch(bullet.text), bullet);

  const kept: any[] = [];
  // One bullet backs at most one story, so a duplicate cannot inflate the grounding
  // score or render two interview cards for a single bullet.
  const claimed = new Set<BulletRef>();
  let dropped = 0;

  for (const story of stories) {
    if (!story || typeof story !== "object") {
      dropped += 1;
      continue;
    }
    const key = normalizeForMatch(String(story.bullet || ""));
    // A story with no action or no result is not an interview answer.
    if (!key || !String(story.action || "").trim() || !String(story.result || "").trim()) {
      dropped += 1;
      continue;
    }

    let match = byText.get(key);
    if (match && claimed.has(match)) {
      dropped += 1;
      continue;
    }

    if (!match && key.length >= MIN_FALLBACK_KEY_LENGTH) {
      // Tolerate trailing punctuation or truncation, but only on a key long enough
      // to identify one bullet.
      const candidates = bullets.filter((b) => {
        if (claimed.has(b)) return false;
        const candidate = normalizeForMatch(b.text);
        return candidate.startsWith(key) || key.startsWith(candidate);
      });
      if (candidates.length > 0) {
        const distance = (b: BulletRef) => Math.abs(normalizeForMatch(b.text).length - key.length);
        candidates.sort((a, b) => distance(a) - distance(b));
        // An exact tie means the key cannot identify one bullet; never guess.
        const ambiguous = candidates.length > 1 && distance(candidates[0]) === distance(candidates[1]);
        if (!ambiguous) match = candidates[0];
      }
    }

    if (!match) {
      dropped += 1;
      continue;
    }

    claimed.add(match);
    // The matched bullet is authoritative for where the story happened.
    kept.push(normalizeStory({ ...story, bullet: match.text, role: match.role, company: match.company }));
  }

  resume.star_stories = kept;
  return { kept: kept.length, dropped };
}

/* ------------------------------------------------------------------ *
 * Impact scoring
 * ------------------------------------------------------------------ */

/**
 * Scores bullet quality against the conventions a top-tier screen applies. Returns
 * null when there are too few bullets to say anything honest.
 *
 * With options.sourceText (the candidate's own material), every figure in every
 * bullet and STAR story is also traced back to that material. Mutates
 * resume.star_stories when stories are expected: unlinked ones are removed.
 */
export function computeImpactScore(resume: any, options: ImpactAuditOptions = {}): ImpactScoreResult | null {
  const bullets = collectBullets(resume);
  if (bullets.length < 3) return null;

  const expectStars = options.expectStarStories !== false;
  const figureIndex = options.sourceText ? buildFigureIndex(options.sourceText) : null;
  // Stories may also state time served in a role ("over my 40 months there").
  const storyFigureIndex = options.sourceText && expectStars ? buildFigureIndex(options.sourceText, { tenure: true }) : null;

  const findings: ImpactFinding[] = [];
  const addFinding = (
    id: string,
    severity: ImpactFinding["severity"],
    bullet: BulletRef,
    issue: string,
    fix: string
  ) => {
    findings.push({ id, severity, role: bullet.role, bullet: bullet.text, issue, fix });
  };

  let strongLeads = 0;
  let outcomeBullets = 0;
  let quantifiedBullets = 0;
  let passiveBullets = 0;
  let vagueBullets = 0;
  let specificBullets = 0;
  let consecutiveQuantified = 0;
  let maxConsecutiveQuantified = 0;
  let roundNumberBullets = 0;
  let figureBullets = 0;
  let unverifiedFigureBullets = 0;

  const skeletons = new Map<string, number>();
  const leadVerbs = new Map<string, number>();
  const lengths: number[] = [];

  for (const bullet of bullets) {
    const text = bullet.text;
    const inspection = inspectBullet(text);
    lengths.push(inspection.words);

    // --- verb strength ---
    const lead = inspection.lead;
    leadVerbs.set(lead, (leadVerbs.get(lead) || 0) + 1);
    if (inspection.bannedLead) {
      addFinding(
        "banned_verb",
        "medium",
        bullet,
        `Opens with "${lead}", a filler verb recruiters read as AI-generated.`,
        "Replace with the concrete action actually taken (Built, Migrated, Reduced, Automated)."
      );
    } else if (inspection.strongLead) {
      strongLeads += 1;
    } else {
      addFinding(
        "weak_lead",
        "medium",
        bullet,
        `Does not open with a past-tense action verb (starts with "${lead || "?"}").`,
        "Start the bullet with a past-tense action verb so ownership is unambiguous."
      );
    }

    // --- ownership ---
    if (inspection.passive) {
      passiveBullets += 1;
      if (inspection.passive === "we/our") {
        addFinding(
          "passive_ownership",
          "high",
          bullet,
          'Uses "we"/"our", so the reader cannot tell which part of the work was yours.',
          "Lead with the verb for what you personally did; credit the team only for scope."
        );
      } else {
        addFinding(
          "passive_ownership",
          "high",
          bullet,
          `Uses "${inspection.passive}", which hands the work to someone else.`,
          "State what you personally decided and executed, not what you were near."
        );
      }
    }
    if (inspection.firstPerson) {
      addFinding(
        "first_person",
        "low",
        bullet,
        'Writes in first person ("I"/"my"); resume bullets use implied first person.',
        "Drop the pronoun and open on the action verb."
      );
    }

    // --- specificity ---
    if (inspection.vague) {
      vagueBullets += 1;
      addFinding(
        "vague_filler",
        "low",
        bullet,
        `Contains "${inspection.vague}", which narrows nothing.`,
        "Name the actual system, count, or technology instead."
      );
    }
    if (inspection.specific) specificBullets += 1;

    // --- provenance ---
    let figures: Figure[] = [];
    let unsupported: string[] = [];
    if (figureIndex) {
      figures = extractFigures(text);
      if (figures.length > 0) {
        figureBullets += 1;
        unsupported = findUnsupportedFigures(text, figureIndex);
        if (unsupported.length > 0) {
          unverifiedFigureBullets += 1;
          addFinding(
            "unverified_figure",
            "high",
            bullet,
            `${unsupported.map((f) => `"${f}"`).join(", ")} ${
              unsupported.length === 1 ? "does" : "do"
            } not appear anywhere in your source material.`,
            "Confirm the figure and add it to your master resume, or cut it: interviewers probe every number."
          );
        }
      }
    }
    const figuresVerified = figureIndex !== null && figures.length > 0 && unsupported.length === 0;

    // --- measurement ---
    if (inspection.quantified) {
      quantifiedBullets += 1;
      consecutiveQuantified += 1;
      maxConsecutiveQuantified = Math.max(maxConsecutiveQuantified, consecutiveQuantified);
      // A round figure the source states is real; only an unverified one reads as theatre.
      if (inspection.roundNumber && !figuresVerified) {
        roundNumberBullets += 1;
        addFinding(
          "round_number",
          "medium",
          bullet,
          "Carries a suspiciously round figure; real measurements are uneven.",
          "Use the exact source figure, or drop the number and close on the concrete change."
        );
      }
    } else {
      consecutiveQuantified = 0;
    }

    // --- outcome ---
    if (inspection.outcome) {
      outcomeBullets += 1;
    } else {
      addFinding(
        "no_outcome",
        "high",
        bullet,
        "Describes an activity but never says what changed as a result.",
        "Close on the consequence: the failure mode removed, the step eliminated, the system retired."
      );
    }

    if (inspection.words > 34) {
      addFinding(
        "overlong",
        "low",
        bullet,
        `Runs to ${inspection.words} words and will wrap past two lines.`,
        "Cut to the decision and its effect; move supporting detail to the interview."
      );
    }
  }

  const total = bullets.length;

  // --- cadence variation (anti-AI-tell) ---
  for (const bullet of bullets) {
    const key = skeletonOf(bullet.text);
    skeletons.set(key, (skeletons.get(key) || 0) + 1);
  }
  const repeatedSkeletons = Array.from(skeletons.values())
    .filter((n) => n > 1)
    .reduce((sum, n) => sum + (n - 1), 0);
  const repeatedVerbs = Array.from(leadVerbs.values())
    .filter((n) => n > 1)
    .reduce((sum, n) => sum + (n - 1), 0);
  const meanLength = lengths.reduce((a, b) => a + b, 0) / total;
  const variance = lengths.reduce((sum, n) => sum + (n - meanLength) * (n - meanLength), 0) / total;
  // A deliberate mix of 8-12 and 18-25 word bullets lands around a 5-word spread.
  // Uniform length is itself a tell of generated text.
  const lengthSpread = clamp01(Math.sqrt(variance) / 5);
  const repeats = repeatedSkeletons + repeatedVerbs;
  const cadenceScore = clamp01(0.5 * (1 - repeats / total) + 0.5 * lengthSpread);
  const cadenceDetail =
    repeats === 0
      ? `no repeated skeletons or lead verbs; bullet length spread ${pct(lengthSpread)} of target`
      : `${repeatedSkeletons} repeated skeletons, ${repeatedVerbs} repeated lead verbs`;

  if (repeatedSkeletons > 0) {
    const worst = Array.from(skeletons.entries()).sort((a, b) => b[1] - a[1])[0];
    if (worst && worst[1] > 1) {
      findings.push({
        id: "repeated_skeleton",
        severity: "medium",
        role: "Document",
        bullet: worst[0],
        issue: `${worst[1]} bullets open with the same three words ("${worst[0]}").`,
        fix: "Rotate bullet shapes: outcome-led, scope-led, decision-led, problem-led.",
      });
    }
  }
  const overusedVerb = Array.from(leadVerbs.entries())
    .filter(([verb]) => verb.length > 0)
    .sort((a, b) => b[1] - a[1])[0];
  if (overusedVerb && overusedVerb[1] >= 3) {
    findings.push({
      id: "repeated_lead_verb",
      severity: "medium",
      role: "Document",
      bullet: "",
      issue: `${overusedVerb[1]} bullets open with "${overusedVerb[0]}".`,
      fix: "Open each bullet with the verb that names its specific action; never repeat one within a role.",
    });
  }

  // --- quantification balance ---
  const quantifiedRatio = quantifiedBullets / total;
  let quantScore: number;
  let quantDetail: string;
  if (quantifiedRatio < QUANT_IDEAL_LOW) {
    quantScore = clamp01(quantifiedRatio / QUANT_IDEAL_LOW);
    quantDetail = `${pct(quantifiedRatio)} of bullets carry a measurement; aim for ${pct(QUANT_IDEAL_LOW)}-${pct(QUANT_IDEAL_HIGH)}`;
  } else if (quantifiedRatio <= QUANT_IDEAL_HIGH) {
    quantScore = 1;
    quantDetail = `${pct(quantifiedRatio)} of bullets carry a measurement - in the credible band`;
  } else {
    // Over-quantification reads as fabricated and discredits the whole document.
    quantScore = clamp01(1 - (quantifiedRatio - QUANT_IDEAL_HIGH) / 0.4);
    quantDetail = `${pct(quantifiedRatio)} of bullets carry a number - dense enough to read as invented`;
    findings.push({
      id: "metric_density",
      severity: "high",
      role: "Document",
      bullet: "",
      issue: `${quantifiedBullets} of ${total} bullets contain a figure.`,
      fix: "Keep the figures the source actually supports and close the rest on concrete change.",
    });
  }
  if (maxConsecutiveQuantified > 2) {
    findings.push({
      id: "metric_run",
      severity: "medium",
      role: "Document",
      bullet: "",
      issue: `${maxConsecutiveQuantified} consecutive bullets each carry a number.`,
      fix: "Break the run so no more than two quantified bullets sit together.",
    });
  }
  // Round-number theatre discredits the figures that ARE real, so it costs score.
  if (quantifiedBullets > 0 && roundNumberBullets > 0) {
    quantScore = clamp01(quantScore * (1 - 0.5 * (roundNumberBullets / quantifiedBullets)));
    quantDetail += `; ${roundNumberBullets} of ${quantifiedBullets} figures are suspiciously round`;
  }

  const components: ImpactComponent[] = [
    {
      id: "verb_strength",
      label: "Action-verb ownership",
      weight: 0.2,
      score: strongLeads / total,
      detail: `${strongLeads} of ${total} bullets open with a strong action verb`,
    },
    {
      id: "outcome_focus",
      label: "Impact stated, not duties",
      weight: 0.25,
      score: outcomeBullets / total,
      detail: `${outcomeBullets} of ${total} bullets say what changed as a result`,
    },
    {
      id: "quantification",
      label: "Measurement balance",
      weight: 0.15,
      score: quantScore,
      detail: quantDetail,
    },
  ];
  if (figureIndex && figureBullets > 0) {
    components.push({
      id: "metric_provenance",
      label: "Figures traceable to source",
      weight: 0.15,
      score: 1 - unverifiedFigureBullets / figureBullets,
      detail:
        unverifiedFigureBullets === 0
          ? `every figure in ${figureBullets} ${figureBullets === 1 ? "bullet" : "bullets"} traces back to your source material`
          : `${unverifiedFigureBullets} of ${figureBullets} bullets with figures cite a number your source never states`,
    });
  }
  components.push(
    {
      id: "specificity",
      label: "Concrete systems named",
      weight: 0.15,
      score: clamp01(specificBullets / total - (vagueBullets / total) * 0.5),
      detail: `${specificBullets} of ${total} bullets name a concrete technology or system${
        vagueBullets > 0 ? `; ${vagueBullets} contain vague filler` : ""
      }`,
    },
    {
      id: "ownership",
      label: "No passive phrasing",
      weight: 0.1,
      score: clamp01(1 - passiveBullets / total),
      detail:
        passiveBullets === 0
          ? 'no passive, borrowed-credit or "we" phrasing'
          : `${passiveBullets} of ${total} bullets surrender ownership`,
    },
    {
      id: "cadence",
      label: "Human cadence variation",
      weight: 0.1,
      score: cadenceScore,
      detail: cadenceDetail,
    }
  );

  // --- STAR grounding and interview quality ---
  let starLink = { kept: 0, dropped: 0 };
  if (expectStars) {
    starLink = linkStarStories(resume);
    const starTarget = Math.min(4, Math.max(2, Math.round(total / 4)));
    if (starLink.dropped > 0) {
      findings.push({
        id: "star_unlinked",
        severity: "medium",
        role: "Document",
        bullet: "",
        issue: `${starLink.dropped} STAR ${starLink.dropped === 1 ? "story" : "stories"} did not match any bullet in the resume, or lacked an action or result, and ${
          starLink.dropped === 1 ? "was" : "were"
        } removed.`,
        fix: "Interview answers must expand a bullet the resume actually makes.",
      });
    }

    // Behavioral loops (Amazon's in particular) probe for the candidate's own actions,
    // in first person, with a result they can defend and a lesson learned.
    const stories: any[] = Array.isArray(resume.star_stories) ? resume.star_stories : [];
    let weVoiceStories = 0;
    let unverifiedStories = 0;
    const competencyCounts = new Map<string, number>();
    for (const story of stories) {
      const storyRef: BulletRef = {
        role: String(story.role || "STAR"),
        company: String(story.company || ""),
        index: -1,
        text: String(story.bullet || ""),
      };
      const action = String(story.action || "");
      if (isWeVoice(action)) {
        weVoiceStories += 1;
        addFinding(
          "star_we_voice",
          "medium",
          storyRef,
          'The action is told as "we", so the interviewer cannot credit you with it.',
          'Retell the action in first person: what did "I" decide, build, and change?'
        );
      }
      if (words(action).length < 12) {
        addFinding(
          "star_thin_action",
          "low",
          storyRef,
          "The action is too thin to carry an interview answer.",
          "The action is the bulk of a STAR answer: the specific steps you took, in order, and why."
        );
      }
      if (!String(story.learning || "").trim()) {
        addFinding(
          "star_no_learning",
          "low",
          storyRef,
          "The story ends without a lesson learned.",
          "Close on what you would repeat or change: senior loops probe for reflection."
        );
      }
      if (storyFigureIndex) {
        const storyText = [story.situation, story.task, story.action, story.result]
          .map((part) => String(part || ""))
          .join(" \n ");
        const unsupported = findUnsupportedFigures(storyText, storyFigureIndex);
        if (unsupported.length > 0) {
          unverifiedStories += 1;
          addFinding(
            "star_unverified_figure",
            "high",
            storyRef,
            `The story cites ${unsupported.map((f) => `"${f}"`).join(", ")}, which your source material never states.`,
            "Use only numbers you can defend under follow-up questioning, or state the change qualitatively."
          );
        }
      }
      const competency = lower(String(story.competency || ""));
      if (competency) competencyCounts.set(competency, (competencyCounts.get(competency) || 0) + 1);
    }

    if (stories.length > 0) {
      // Interviewers weight recent work. The anchor is the first role with real depth,
      // so a short latest stint does not demand a story it cannot support.
      const anchor = rolesOf(resume).find((r) => roleBullets(r).length >= 3);
      if (anchor) {
        const anchorBullets = new Set(roleBullets(anchor).map(normalizeForMatch));
        const covered = stories.some((s) => anchorBullets.has(normalizeForMatch(String(s.bullet || ""))));
        if (!covered) {
          findings.push({
            id: "star_recent_gap",
            severity: "medium",
            role: String(anchor.role || "Role"),
            bullet: "",
            issue: "None of the STAR stories come from your most recent substantial role.",
            fix: "Interviewers ask about recent work first; prepare at least one story from this role.",
          });
        }
      }
    }
    for (const [competency, count] of competencyCounts) {
      if (count > 1) {
        findings.push({
          id: "star_duplicate_competency",
          severity: "low",
          role: "Document",
          bullet: "",
          issue: `${count} STAR stories evidence the same competency ("${competency}").`,
          fix: "Each interviewer in a loop covers different competencies; point each story at a different one.",
        });
      }
    }

    let starScore = clamp01(starLink.kept / starTarget);
    if (starLink.kept > 0) {
      starScore *= 1 - 0.5 * (weVoiceStories / starLink.kept);
      starScore *= 1 - 0.5 * (unverifiedStories / starLink.kept);
    }
    const starQualityNotes = [
      weVoiceStories > 0 ? `${weVoiceStories} told as "we"` : "",
      unverifiedStories > 0 ? `${unverifiedStories} cite unverified figures` : "",
    ].filter(Boolean);
    components.push({
      id: "star_grounding",
      label: "Interview-ready STAR stories",
      weight: 0.05,
      score: starScore,
      detail: `${starLink.kept} STAR ${starLink.kept === 1 ? "story" : "stories"} linked to real bullets (target ${starTarget})${
        starQualityNotes.length > 0 ? `; ${starQualityNotes.join(", ")}` : ""
      }`,
    });
  }

  const totalWeight = components.reduce((sum, c) => sum + c.weight, 0);
  const raw = components.reduce((sum, c) => sum + c.weight * clamp01(c.score), 0) / totalWeight;

  const severityRank = { high: 0, medium: 1, low: 2 };
  findings.sort((a, b) => severityRank[a.severity] - severityRank[b.severity]);

  return {
    method: "deterministic-faang-star-audit",
    score: Math.max(5, Math.min(99, Math.round(raw * 100))),
    bullets_evaluated: total,
    quantified_ratio: Math.round(quantifiedRatio * 100) / 100,
    components: components.map((c) => ({ ...c, weight: Math.round((c.weight / totalWeight) * 100) / 100, score: clamp01(c.score) })),
    findings: findings.slice(0, 30),
    star_expected: expectStars,
    star_linked: starLink.kept,
    star_dropped: starLink.dropped,
    figure_bullets: figureIndex ? figureBullets : null,
    unverified_figure_bullets: figureIndex ? unverifiedFigureBullets : null,
  };
}

/**
 * Attaches the impact audit to a generated resume as impact_audit and prunes unlinked
 * STAR stories. Mutates and returns the resume.
 *
 * Never throws: this runs on an already-generated, already-paid-for document, so a
 * defect must degrade to "no impact audit", never discard the resume or be mistaken
 * for a malformed model response.
 */
export function applyImpactAudit(optimizedResume: any, options: ImpactAuditOptions = {}): any {
  if (!optimizedResume || typeof optimizedResume !== "object") return optimizedResume;

  try {
    const result = computeImpactScore(optimizedResume, options);
    if (result) {
      optimizedResume.impact_audit = result;
    } else {
      // Still enforce STAR linkage when there is too little to score.
      if (options.expectStarStories !== false) linkStarStories(optimizedResume);
      delete optimizedResume.impact_audit;
    }
  } catch (e: any) {
    console.warn("[impactScore] Impact audit failed; returning document unaudited:", e?.message || e);
    delete optimizedResume.impact_audit;
  }

  return optimizedResume;
}

/** One line per component, e.g. for a tooltip explaining where the score came from. */
export function describeImpactScore(result: ImpactScoreResult): string {
  return result.components
    .map((c) => `${c.label}: ${Math.round(c.score * 100)}% (weight ${Math.round(c.weight * 100)}%) - ${c.detail}`)
    .join("\n");
}
