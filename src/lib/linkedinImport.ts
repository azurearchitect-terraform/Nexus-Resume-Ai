/**
 * Import of LinkedIn trend data that the candidate exported or copied themselves.
 *
 * The app never contacts LinkedIn and a LinkedIn username cannot be used to fetch
 * anything: LinkedIn has no public trends API and prohibits scraping. This module
 * reads the candidate's own file or pasted list, records where it came from, and
 * turns it into the same evidence-gated trend list the rest of the pipeline uses -
 * skills the candidate's material does not support are still never added.
 *
 * Pure and shared by the browser (preview, storage) and the server (re-validation).
 */
import {
  MAX_TREND_SKILLS,
  isBannedTrendTerm,
  matchRoleFamilies,
  normalizeTrendSkills,
  trendCatalogue,
  trendFamilies,
  trendNameKey,
  trendSkillTerms,
  type LinkedInTrends,
  type TrendSkill,
} from "./linkedinTrends";
import { findTerms } from "./bulletBudget";
import {
  IMPORT_FORMATS,
  IMPORT_LIMITS,
  IMPORT_PROVIDER,
  IMPORT_TREND_METHOD,
  cleanLabel,
  cleanText,
  normalizeImportDate,
  readSignal,
  type ImportFormat,
  type TrendImportMetadata,
  type TrendImportSignal,
} from "./trendImportMetadata";

export { IMPORT_LIMITS, IMPORT_TREND_METHOD } from "./trendImportMetadata";
export type { ImportFormat, TrendImportSignal } from "./trendImportMetadata";

/** An import older than this many days is flagged as possibly out of date. */
export const OLD_IMPORT_DAYS = 365;

export class TrendImportError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TrendImportError";
  }
}

export interface ParsedTrendImport {
  format: ImportFormat;
  /** Cleaned, de-duplicated skills in priority order. */
  rows: TrendImportSignal[];
  /** Entries left out (banned terms, duplicates, prose). */
  skipped: number;
  warnings: string[];
}

/** What is stored for the candidate (locally and in their profile) and sent to the server for re-validation. */
export interface TrendImportRecord {
  version: 1;
  source: string;
  published_at: string;
  region: string;
  role: string;
  imported_at: string;
  /** The candidate's confirmation that they may use this data, and when they gave it. */
  permission: { confirmed: true; confirmed_at: string };
  format: ImportFormat;
  skipped: number;
  warnings: string[];
  skills: TrendImportSignal[];
}

/* ------------------------------------------------------------------ *
 * Numbers and names
 * ------------------------------------------------------------------ */

const round1 = (value: number) => Math.round(value * 10) / 10;

interface ParsedNumber {
  value: number;
  percent: boolean;
  signed: boolean;
}

function parseNumber(cell: unknown): ParsedNumber | null {
  const text = (typeof cell === "number" && Number.isFinite(cell) ? String(cell) : typeof cell === "string" ? cell : "")
    .trim()
    .replace(/[\u2212\u2012-\u2015]/g, "-")
    .replace(/\s+/g, "");
  if (!text || text.length > 40) return null;
  const grouped = /^([+-]?)(\d+(?:,\d{3})*)(?:\.(\d+))?(%?)$/.exec(text);
  const match = grouped || /^([+-]?)(\d+),(\d{1,2})(%?)$/.exec(text);
  if (!match) return null;
  const value = Number(`${match[2].replace(/,/g, "")}.${match[3] || "0"}`) * (match[1] === "-" ? -1 : 1);
  return Number.isFinite(value) ? { value, percent: match[4] === "%", signed: match[1] !== "" } : null;
}

const MISSING_CELL = /^(?:n\/?a|none|null|-|\u2013|\u2014)?$/i;

function toRank(cell: unknown): number | null {
  const n = parseNumber(cell);
  return n && !n.percent && Number.isInteger(n.value) && n.value >= 1 && n.value <= 100_000 ? n.value : null;
}

function toGrowth(cell: unknown): number | null {
  const n = parseNumber(cell);
  return n && n.value >= -1000 && n.value <= 100_000 ? round1(n.value) : null;
}

function toShare(cell: unknown): number | null {
  const n = parseNumber(cell);
  return n && n.value >= 0 && n.value <= 100 ? round1(n.value) : null;
}

const LIST_MARKER = /^\s*(?:#\s*(\d{1,3})(?![\d.])[\s.):-]*|(\d{1,3})\s*[.)\]:]\s+|[-*\u2022\u25aa\u25cf\u25e6\u2023\u00b7]+\s+)/;

function stripMarker(text: string): { text: string; rank: number | null } {
  const match = LIST_MARKER.exec(text);
  if (!match) return { text, rank: null };
  const rank = Number(match[1] ?? match[2]);
  return { text: text.slice(match[0].length), rank: Number.isInteger(rank) && rank >= 1 ? rank : null };
}

// Sentence openers ("These are...", "The following...", "A growing number...", "(c) 2026"). Case matters:
// "IT Service Management" and "A/B Testing" are skills, "It is..." is a sentence.
const PROSE_START =
  /^(?:(?:[Tt]hese|[Tt]hose|[Tt]his|[Tt]hat|[Hh]ere|[Tt]here|[Tt]he|[Ww]e|[Yy]ou|[Oo]ur|[Yy]our|[Tt]hey|[Ii]t(?![A-Z])|[Aa]re|[Ii]s|[Ww]as|[Ww]ere|[Pp]lease)\b(?!\/)|[Aa]n?\s+[a-z]|\u00a9)/;
// The same openers in capitals ("THE FOLLOWING SKILLS ARE RISING"). "IT" and "IS" are left out: they are acronyms.
const PROSE_CAPS = /^(?:THESE|THOSE|THIS|THAT|HERE|THERE|THE|WE|YOU|OUR|YOUR|THEY|ARE|WAS|WERE|PLEASE)\b/;
// Footers and captions: "Source: ...", "Copyright 2026 ...", "Published - ...". "Source Control" and "Copyright Law" are skills.
const PROSE_LABEL = /^(?:(?:source|notes?|published|copyright)\s*[:\u2013\u2014-]|copyright\s*(?:\u00a9|\(c\)|\d))/i;
// "Note that percentages are rounded", "Published on March 3": the next word is lowercase. "Note Taking" is a skill.
const PROSE_CAPTION = /^(?:[Nn]otes?|[Pp]ublished)\s+[a-z]/;

const looksLikeProse = (text: string) =>
  PROSE_START.test(text) || PROSE_CAPS.test(text) || PROSE_LABEL.test(text) || PROSE_CAPTION.test(text);

type NameRejection = "" | "short" | "unreadable";

/** A skill name as plain text, or a reason it is not one (prose, a link, markup, too long, a single letter). */
function cleanSkillName(raw: string): { name: string; reason: NameRejection } {
  // Names are short; refusing long input also keeps every pattern below cheap on hostile files.
  if (raw.length > 200) return { name: "", reason: "unreadable" };
  let name = raw
    .replace(/[\u0000-\u001f\u007f\u00a0]+/g, " ")
    .replace(/^["'\u201c\u201d\u2018\u2019`]+|["'\u201c\u201d\u2018\u2019`]+$/g, "")
    .replace(/\s+/g, " ")
    .replace(/^[\s:;,\u2013\u2014|-]+|[\s:;,\u2013\u2014|-]+$/g, "")
    .replace(/^(?:and|&)\s+/i, "")
    .replace(/([\p{L}\p{N})])\.$/u, "$1")
    .trim();
  if (/https?:\/\/|www\.|\S@\S+\.\S|[<>{}[\]\\=]|\d\s*%/i.test(name)) return { name: "", reason: "unreadable" };
  // Before label cleaning, which would strip the "(c)" sign this test looks for.
  if (looksLikeProse(name)) return { name: "", reason: "unreadable" };
  name = cleanLabel(name, IMPORT_LIMITS.maxNameLength + 1);
  if (!/\p{L}/u.test(name)) return { name: "", reason: "unreadable" };
  if (name.length < 2) return { name: "", reason: "short" };
  if (name.length > IMPORT_LIMITS.maxNameLength) return { name: "", reason: "unreadable" };
  if (name.split(" ").length > IMPORT_LIMITS.maxWordsPerName || looksLikeProse(name)) return { name: "", reason: "unreadable" };
  return { name, reason: "" };
}

/**
 * Everyday words that are also tool or language names. Matching the bare word would let ordinary
 * prose ("go-live", "swift response", "excel at") "support" the skill, which the curated catalogue
 * deliberately avoids. Each maps to an unambiguous spelling, or to null when there is none and the
 * skill must be left out.
 */
const AMBIGUOUS_NAMES: Record<string, string | null> = {
  go: "Golang",
  react: "React.js",
  node: "Node.js",
  rest: "REST APIs",
  teams: "Microsoft Teams",
  exchange: "Exchange Online",
  spark: "Apache Spark",
  excel: "Microsoft Excel",
  word: "Microsoft Word",
  access: "Microsoft Access",
  office: "Microsoft Office",
  swift: "Swift Programming Language",
  rust: "Rust Programming Language",
  ruby: "Ruby Programming Language",
  dart: "Dart Programming Language",
  julia: "Julia Programming Language",
  delta: null,
  hive: null,
  chef: null,
  puppet: null,
  unity: null,
  flask: null,
  lean: null,
  ray: null,
  spring: null,
  express: null,
  next: null,
  gin: null,
  power: null,
  defender: null,
  copilot: null,
  hybrid: null,
};

/** Spellings recruiters use for the renamed Microsoft products. */
const SAFE_ALIASES: Record<string, string[]> = {
  "Microsoft Excel": ["ms excel"],
  "Microsoft Word": ["ms word"],
  "Microsoft Access": ["ms access"],
  "Microsoft Office": ["ms office"],
};

/** Own-property lookup: skill names such as "constructor" or "toString" must not reach Object.prototype. */
const own = <T>(table: Record<string, T>, key: string): T | undefined =>
  Object.prototype.hasOwnProperty.call(table, key) ? table[key] : undefined;

/** Initialisms that are also ordinary words or names in prose; the curated catalogue refuses several of them as bare terms too. */
const AMBIGUOUS_ACRONYMS = new Set([
  "rag", "waf", "caf", "pam", "sap", "ops", "dev", "map", "gap", "pro", "web", "cad",
  "soap", "soar", "mean", "lamp", "raid", "can", "safe", "core", "case", "base",
]);

/** Two-letter initialisms that are safe as aliases. Others (IT, DR, HR, PM, CD, CI, AD, ID, IP) are ordinary words or names in prose. */
const SAFE_SHORT_ACRONYMS = new Set(["ai", "ml", "ux", "ui", "bi", "qa"]);

/**
 * An initialism such as IaC, SEO, AI or K8s - the only kind of parenthetical that is an alias rather than a
 * qualifier - provided its lower-case form does not read as an ordinary word in prose.
 */
function isAcronym(token: string): boolean {
  if (!/^[A-Za-z0-9+#.]{2,10}$/.test(token)) return false;
  const initialism = token.replace(/[^A-Z]/g, "").length >= 2 || (/\d/.test(token) && /[A-Z]/.test(token));
  if (!initialism) return false;
  const lower = token.toLowerCase();
  if (token.length === 2) return SAFE_SHORT_ACRONYMS.has(lower);
  return !AMBIGUOUS_ACRONYMS.has(lower) && !isAmbiguousName(token);
}

interface SafeName {
  /** The name to use; "" when the skill cannot be matched safely. */
  name: string;
  renamedFrom?: string;
  /** Left out because it is an everyday word with no unambiguous spelling. */
  ambiguous?: string;
  /** Left out because the name is a single letter ("R", "C"), which prose cannot be matched against safely. */
  short?: boolean;
}

const isAmbiguousName = (name: string) => own(AMBIGUOUS_NAMES, trendNameKey(name)) !== undefined;

/**
 * LinkedIn disambiguates names with a qualifier: "Python (Programming Language)". The qualifier is
 * dropped (it would otherwise become an evidence term that any resume mentioning "programming
 * language" satisfies); only an acronym such as "(IaC)" is kept, as an alias. Ambiguous everyday
 * words are renamed or left out. Idempotent.
 */
function safeSkillName(raw: string): SafeName {
  const base = raw.replace(/\([^)]*\)/g, " ").replace(/\s+/g, " ").trim();
  if (!base || !/\p{L}/u.test(base)) return { name: "" };
  if (base.length < 2) return { name: "", short: true };
  if (isAmbiguousName(base)) {
    const replacement = own(AMBIGUOUS_NAMES, trendNameKey(base));
    return replacement ? { name: replacement, renamedFrom: base } : { name: "", ambiguous: base };
  }
  const acronyms = Array.from(raw.matchAll(/\(([^)]*)\)/g))
    .flatMap((match) => match[1].split(/[/,]/))
    .map((part) => part.trim())
    .filter(isAcronym);
  return { name: acronyms.length ? `${base} (${acronyms.join(", ")})` : base };
}

/* ------------------------------------------------------------------ *
 * Collecting rows
 * ------------------------------------------------------------------ */

class Collector {
  rows: TrendImportSignal[] = [];
  format: ImportFormat = "text";
  skipped = 0;
  banned = 0;
  duplicates = 0;
  prose = 0;
  tooShort = 0;
  truncated = 0;
  headings = 0;
  unreadableNumbers = 0;
  ignoredShares = 0;
  ambiguousPercents = 0;
  duplicateMetrics = 0;
  uninterpretedColumns = false;
  renamed: string[] = [];
  ambiguousLeftOut: string[] = [];
  private seen = new Set<string>();

  add(rawName: string, rank: number | null, growth: number | null, share: number | null): void {
    const cleaned = cleanSkillName(rawName);
    if (!cleaned.name) {
      if (cleaned.reason === "short") this.tooShort++;
      else this.prose++;
      this.skipped++;
      return;
    }
    // The banned terms are checked on the name as written: "(CI/CD)" would otherwise become "(CI, CD)" and slip through.
    if (isBannedTrendTerm(cleaned.name)) {
      this.banned++;
      this.skipped++;
      return;
    }
    const safe = safeSkillName(cleaned.name);
    if (!safe.name) {
      if (safe.ambiguous) this.ambiguousLeftOut.push(safe.ambiguous);
      else if (safe.short) this.tooShort++;
      else this.prose++;
      this.skipped++;
      return;
    }
    const name = safe.name;
    if (isBannedTrendTerm(name)) {
      this.banned++;
      this.skipped++;
      return;
    }
    const key = trendNameKey(name.replace(/\([^)]*\)/g, " "));
    if (!key) {
      this.skipped++;
      return;
    }
    if (this.seen.has(key)) {
      this.duplicates++;
      this.skipped++;
      return;
    }
    if (this.rows.length >= IMPORT_LIMITS.maxRows) {
      this.truncated++;
      return;
    }
    if (safe.renamedFrom) this.renamed.push(`${safe.renamedFrom} \u2192 ${name}`);
    this.seen.add(key);
    this.rows.push({ name, rank, growth, share });
  }

  growthCell(cell: unknown): number | null {
    if (typeof cell === "string" ? MISSING_CELL.test(cell.trim()) : cell === null || cell === undefined) return null;
    const value = toGrowth(cell);
    if (value === null) this.unreadableNumbers++;
    return value;
  }

  shareCell(cell: unknown): number | null {
    if (typeof cell === "string" ? MISSING_CELL.test(cell.trim()) : cell === null || cell === undefined) return null;
    const n = parseNumber(cell);
    if (!n) {
      this.unreadableNumbers++;
      return null;
    }
    const value = toShare(cell);
    if (value === null) this.ignoredShares++;
    return value;
  }

  rankCell(cell: unknown): number | null {
    if (typeof cell === "string" ? MISSING_CELL.test(cell.trim()) : cell === null || cell === undefined) return null;
    const value = toRank(cell);
    if (value === null) this.unreadableNumbers++;
    return value;
  }
}

/* ---- delimited text ---- */

function parseDelimited(text: string, delimiter: string, maxRows = 5000): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = "";
  let quoted = false;
  const endRow = () => {
    row.push(cell);
    cell = "";
    if (row.some((value) => value.trim() !== "")) rows.push(row);
    row = [];
  };
  for (let i = 0; i < text.length && rows.length < maxRows; i++) {
    const ch = text[i];
    if (quoted) {
      if (ch === '"') {
        if (text[i + 1] === '"') {
          cell += '"';
          i++;
        } else {
          quoted = false;
        }
      } else {
        cell += ch;
      }
    } else if (ch === '"' && cell === "") {
      quoted = true;
    } else if (ch === delimiter) {
      row.push(cell);
      cell = "";
    } else if (ch === "\n" || ch === "\r") {
      if (ch === "\r" && text[i + 1] === "\n") i++;
      endRow();
    } else {
      cell += ch;
    }
  }
  if (rows.length < maxRows) endRow();
  return rows;
}

function detectDelimiter(text: string): string | null {
  const sample = text.split(/\r?\n/).filter((line) => line.trim()).slice(0, 20).join("\n");
  let best: { delimiter: string; columns: number } | null = null;
  for (const delimiter of [",", "\t", ";"]) {
    const rows = parseDelimited(sample, delimiter, 20);
    if (rows.length < 2) continue;
    const lengths = rows.map((row) => row.length);
    const mode = [...lengths].sort((a, b) => lengths.filter((n) => n === b).length - lengths.filter((n) => n === a).length)[0];
    const agreement = lengths.filter((n) => n === mode).length / lengths.length;
    if (mode >= 2 && agreement >= 0.8 && (!best || mode > best.columns)) best = { delimiter, columns: mode };
  }
  return best ? best.delimiter : null;
}

const SKILL_HEADER = /^(?:skills?|skill name|skill_name|skillname|skill title|name|keywords?|competenc(?:y|ies)|technolog(?:y|ies)|tools?|capabilit(?:y|ies)|topics?|trending skills?|top skills?|skills? on the rise|rising skills?|in[- ]demand skills?)$/i;
const RANK_HEADER = /^(?:rank|ranking|#|no\.?|position|order)$/i;
const GROWTH_HEADER = /growth|change|yoy|y\/y|increase|\brise\b|delta|momentum/i;
// Count columns (postings, mentions) are deliberately not here: a count of 45 is not a 45% share.
const SHARE_HEADER = /share|percent|percentage|pct|%|prevalence|penetration|frequency|popularity/i;
// Recognised so a table with only a count column still has its header row skipped, but never read as a metric.
const COUNT_HEADER = /postings|mentions|count|volume|demand|openings|jobs/i;

function looksLikeHeader(first: string[], second: string[] | undefined): boolean {
  if (first.some((cell) => parseNumber(cell) !== null)) return false;
  if (first.some((cell) => SKILL_HEADER.test(cell.trim()))) return true;
  const metric = first.some(
    (cell) => RANK_HEADER.test(cell.trim()) || GROWTH_HEADER.test(cell) || SHARE_HEADER.test(cell) || COUNT_HEADER.test(cell)
  );
  return metric && !!second && second.some((cell) => parseNumber(cell) !== null);
}

function collectCsv(text: string, c: Collector): void {
  const delimiter = detectDelimiter(text);
  if (!delimiter) {
    collectText(text, c);
    return;
  }
  c.format = "csv";
  const table = parseDelimited(text, delimiter);
  if (!table.length) return;
  const header = looksLikeHeader(table[0], table[1]);
  const body = header ? table.slice(1) : table;
  let skillCol = -1;
  let rankCol = -1;
  let growthCol = -1;
  let shareCol = -1;

  if (header) {
    const first = table[0];
    skillCol = first.findIndex((cell) => SKILL_HEADER.test(cell.trim()));
    rankCol = first.findIndex((cell) => RANK_HEADER.test(cell.trim()));
    growthCol = first.findIndex((cell, i) => i !== skillCol && i !== rankCol && GROWTH_HEADER.test(cell));
    shareCol = first.findIndex((cell, i) => i !== skillCol && i !== rankCol && i !== growthCol && SHARE_HEADER.test(cell));
    if (skillCol < 0) {
      skillCol = first.findIndex((cell, i) => i !== rankCol && i !== growthCol && i !== shareCol && !COUNT_HEADER.test(cell));
    }
  } else {
    const columns = Math.max(...body.map((row) => row.length));
    const filled = (col: number) => body.filter((row) => (row[col] ?? "").trim() !== "");
    const textual = (col: number) => {
      const cells = filled(col);
      return cells.length > 0 && cells.filter((row) => parseNumber(row[col]) === null).length / cells.length >= 0.6;
    };
    skillCol = Array.from({ length: columns }, (_, col) => col).find(textual) ?? -1;
    for (let col = 0; col < skillCol; col++) {
      const cells = filled(col);
      if (cells.length > 0 && cells.every((row) => toRank(row[col]) !== null)) {
        rankCol = col;
        break;
      }
    }
    if (Array.from({ length: columns }, (_, col) => col).some((col) => col !== skillCol && col !== rankCol)) {
      c.uninterpretedColumns = true;
    }
  }
  if (skillCol < 0) throw new TrendImportError("No column with skill names was found. Add a header row such as \"Skill\".");

  for (const row of body) {
    const cleaned = stripMarker((row[skillCol] ?? "").trim());
    if (!cleaned.text.trim()) continue;
    c.add(
      cleaned.text,
      rankCol >= 0 ? c.rankCell(row[rankCol]) : cleaned.rank,
      growthCol >= 0 ? c.growthCell(row[growthCol]) : null,
      shareCol >= 0 ? c.shareCell(row[shareCol]) : null
    );
  }
}

/* ---- JSON ---- */

const hasOwn = (record: Record<string, unknown>, key: string) => Object.prototype.hasOwnProperty.call(record, key);
const pick = (record: Record<string, unknown>, keys: string[]): unknown => {
  const key = keys.find((candidate) => hasOwn(record, candidate));
  return key === undefined ? undefined : record[key];
};

function findList(data: unknown, depth = 0): unknown[] | null {
  if (Array.isArray(data)) return data;
  if (data && typeof data === "object" && depth < 2) {
    for (const key of ["skills", "items", "results", "data", "trends", "list"]) {
      const value = hasOwn(data as Record<string, unknown>, key) ? (data as Record<string, unknown>)[key] : undefined;
      const found = value === undefined ? null : findList(value, depth + 1);
      if (found) return found;
    }
  }
  return null;
}

function collectJson(text: string, c: Collector): void {
  c.format = "json";
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch {
    throw new TrendImportError("This looks like JSON but could not be read. Check for a missing bracket or quote.");
  }
  const list = findList(data);
  if (!list) throw new TrendImportError('No skill list was found. Use an array of skills, or an object with a "skills" array.');
  for (const item of list.slice(0, 5000)) {
    if (typeof item === "string") {
      const cleaned = stripMarker(item);
      c.add(cleaned.text, cleaned.rank, null, null);
    } else if (item && typeof item === "object" && !Array.isArray(item)) {
      const record = item as Record<string, unknown>;
      const name = pick(record, ["skill", "name", "title", "keyword", "label"]);
      c.add(
        typeof name === "string" ? name : "",
        c.rankCell(pick(record, ["rank", "position"])),
        c.growthCell(pick(record, ["growth", "growth_rate", "growthRate", "yoy", "change"])),
        c.shareCell(pick(record, ["share", "percentage", "percent", "pct"]))
      );
    } else {
      c.skipped++;
    }
  }
}

/* ---- plain text ---- */

const HEADING = /\b(?:skills? on the rise|jobs? on the rise|top skills?|trending skills?|in[- ]demand skills?|fastest[- ]growing)\b/i;
const GROWTH_WORD = "growth|grew|growing|up|increase[ds]?|yoy|y\\/y|change|rise|rose|rising";
const SHARE_WORD = "share|demand|prevalence|penetration|of\\s+(?:postings|jobs|members|talent|listings)";
const GROWTH_WORDS = new RegExp(`\\b(?:${GROWTH_WORD})\\b`, "i");
// A label directly before ("Growth: 45%") or directly after ("45% growth") the number it names. The captured separator
// tells "growth: 45%" (names the next number) from "45% growth 12%" (trails the previous one).
const BEFORE_LABEL = new RegExp(`\\b(${GROWTH_WORD}|${SHARE_WORD})\\s*([:=]?)\\s*$`, "i");
const AFTER_LABEL = new RegExp(`^\\s*(${GROWTH_WORD}|${SHARE_WORD})\\b`, "i");
// A "-" is a minus sign only when it touches the digits and starts a token ("Kubernetes - 45%" is a separator); "+" and the
// arrows may follow a letter ("Kubernetes+45%"). Thousands separators ("1,200%") and decimal commas ("45,5%") are both
// read by parseNumber.
const PERCENT = /(^|[\s(:,;|~\u2248=]|(?=[+\u2191\u2193]\d))([+\-\u2212\u2013\u2191\u2193]?)(\d+(?:,\d{3})*(?:[.,]\d+)?)\s*%/g;
const ANY_PERCENT = /\d+(?:[.,]\d+)*\s*%/g;
// The metric expression ("+45% YoY", "(growth: 32%)", "12% of postings"). It must start at a boundary so label words
// inside names ("Exchange", "Backup", "Startup") are not mistaken for labels and cut the name short.
const METRIC_TEXT =
  /(?:^|[\s(:,;|~\u2248=]|(?=[+\u2191\u2193]\d))\(?\s*(?:(?:growth|change|yoy|y\/y|up|increase[ds]?|share)\b)?\s*:?\s*[+\-\u2212\u2013\u2191\u2193]?\s*\d+(?:,\d{3})*(?:[.,]\d+)?\s*%\s*(?:(?:growth|yoy|y\/y|increase[ds]?|change|share|of\s+(?:postings|jobs|members|talent|listings)|demand)\b)?\s*\)?/gi;
const TRAILING_COUNT = /(?:[-\u2013\u2014:|,]\s*\d[\d,.]*|\s\d[\d,.]*\s*(?:postings?|jobs?|mentions?|members?|results?))\s*$/i;

function splitList(text: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let current = "";
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (ch === "(") depth++;
    else if (ch === ")") depth = Math.max(0, depth - 1);
    // A comma between digits is a thousands separator ("1,234 postings"), not a list separator.
    const thousands = ch === "," && /\d/.test(text[i - 1] ?? "") && /\d/.test(text[i + 1] ?? "");
    if (depth === 0 && !thousands && (ch === "," || ch === ";" || ch === "|" || ch === "\u2022")) {
      parts.push(current);
      current = "";
    } else {
      current += ch;
    }
  }
  parts.push(current);
  return parts.map((part) => part.trim()).filter(Boolean);
}

/** One skill's text ("Kubernetes +45% YoY"): its numbers and its name. Every percentage is read or reported, never dropped silently. */
function collectSkillSegment(body: string, rank: number | null, c: Collector): void {
  let growth: number | null = null;
  let share: number | null = null;
  let interpreted = 0;
  for (const match of body.matchAll(PERCENT)) {
    interpreted++;
    const start = (match.index ?? 0) + match[1].length;
    const end = (match.index ?? 0) + match[0].length;
    const sign = match[2];
    const parsed = parseNumber(match[3]);
    if (!parsed) {
      c.unreadableNumbers++;
      continue;
    }
    const value = sign === "-" || sign === "\u2212" || sign === "\u2013" || sign === "\u2193" ? -parsed.value : parsed.value;
    // A label with no colon right after another percentage ("45% growth 12% share") names that percentage, not this one.
    const beforeText = body.slice(Math.max(0, start - 16), start);
    const before = BEFORE_LABEL.exec(beforeText);
    const trailsPrevious = before !== null && before[2] === "" && /%\s*$/.test(beforeText.slice(0, before.index));
    const beforeLabel = before && !trailsPrevious ? before[1] : undefined;
    const label = beforeLabel ?? AFTER_LABEL.exec(body.slice(end, end + 16))?.[1];
    const kind = label ? (GROWTH_WORDS.test(label) ? "growth" : "share") : sign ? "growth" : null;
    if (kind === null) c.ambiguousPercents++;
    else if (kind === "growth") {
      if (value < -1000 || value > 100_000) c.unreadableNumbers++;
      else if (growth === null) growth = round1(value);
      else c.duplicateMetrics++;
    } else if (value < 0 || value > 100) c.ignoredShares++;
    else if (share === null) share = round1(value);
    else c.duplicateMetrics++;
  }
  const present = Array.from(body.matchAll(ANY_PERCENT)).length;
  if (present > interpreted) c.unreadableNumbers += present - interpreted;

  // The skill name is what precedes the first metric; trailing commentary ("strong demand") is not part of it.
  const metricAt = body.search(METRIC_TEXT);
  const head = metricAt > 0 ? body.slice(0, metricAt) : "";
  const name = (head.trim() ? head : body.replace(METRIC_TEXT, " ")).replace(TRAILING_COUNT, "").trim();
  c.add(name, rank, growth, share);
}

// Words that make up commentary about a number ("up from 30% last year") rather than a skill name.
const COMMENTARY_WORDS = new Set([
  "up", "down", "from", "to", "by", "at", "of", "in", "vs", "growth", "change", "yoy", "qoq", "mom", "share", "demand",
  "grew", "rose", "rising", "increase", "increased", "decrease", "decreased", "strong", "last", "year", "month", "quarter",
]);

/** A part of a line that names a skill and carries its own number: "Terraform +30%", "5G Networks +30%" (not "up from 30%"). */
function hasNameAndMetric(part: string): boolean {
  const at = part.search(METRIC_TEXT);
  if (at <= 0) return false;
  const words = part.slice(0, at).toLowerCase().match(/[\p{L}\p{N}.+#]+/gu) ?? [];
  return words.some((word) => /\p{L}/u.test(word)) && !words.every((word) => COMMENTARY_WORDS.has(word));
}

function collectTextLine(rawLine: string, c: Collector): void {
  const line = rawLine.replace(/[\u0000-\u001f\u007f\u00a0]+/g, " ").replace(/\s+/g, " ").trim();
  if (!line) return;
  if (line.length > 400) {
    c.prose++;
    c.skipped++;
    return;
  }
  const marker = stripMarker(line);
  const body = marker.text.trim();
  if (!body) return;
  const metricCount = Array.from(body.matchAll(ANY_PERCENT)).length;
  if (/:$/.test(body) || (HEADING.test(body) && metricCount === 0)) {
    c.headings++;
    return;
  }

  // Several skills on one line. Without numbers it is a list ("Python, SQL"). With numbers it is split only when every
  // part is a skill with its own number ("Kubernetes +45%, Terraform +30%"); otherwise it is one skill followed by
  // commentary ("+45% YoY, driven by AI adoption") or by its other numbers ("growth 45%, share 12%"). Every part
  // takes the line's rank, so a ranked line keeps its place in the order.
  const parts = splitList(body);
  const several = parts.length > 1 && (metricCount === 0 || parts.every(hasNameAndMetric));
  if (several) for (const part of parts) collectSkillSegment(part, marker.rank, c);
  else collectSkillSegment(body, marker.rank, c);
}

function collectText(text: string, c: Collector): void {
  c.format = "text";
  let first = true;
  for (const line of text.split(/\r?\n/).slice(0, 20_000)) {
    if (first && line.trim()) {
      first = false;
      // A header such as "Skill" or "Name" labels the list; it is not itself a skill (it may be quoted). A header is
      // short, so only the start of the line is tested: quote-stripping a huge line would be quadratic.
      const head = line.trim().slice(0, 100).replace(/^["'\u201c\u201d]+|["'\u201c\u201d]+$/g, "").trim();
      if (SKILL_HEADER.test(head)) {
        c.headings++;
        continue;
      }
    }
    collectTextLine(line, c);
  }
}

/* ------------------------------------------------------------------ *
 * Parsing
 * ------------------------------------------------------------------ */

/** A cell that is a number in its own right. "Kubernetes +45,5%" splits at the decimal comma: its "5%" is the tail of a number. */
function isNumericCell(row: string[], index: number): boolean {
  if (parseNumber(row[index]) === null) return false;
  return !(index > 0 && /\d\s*$/.test(row[index - 1]) && /^\s*\d{1,2}\s*%?\s*$/.test(row[index]));
}

function detectFormat(text: string): ImportFormat {
  const trimmed = text.trim();
  if (/^[[{]/.test(trimmed)) return "json";
  const lines = trimmed.split(/\r?\n/).filter((line) => line.trim());
  if (lines.length < 2) return "text";
  const delimiter = detectDelimiter(trimmed);
  if (!delimiter) return "text";
  const sample = parseDelimited(lines.slice(0, 20).join("\n"), delimiter, 20);
  if (looksLikeHeader(sample[0], sample[1])) return "csv";
  // Text separated by tabs is a table (nobody writes a list with tabs).
  if (delimiter === "\t") return "csv";
  // Otherwise a table has numbers in its rows (ranks or metrics); lines of names with commas do not.
  const numeric = sample.filter((row) => row.some((_, i) => isNumericCell(row, i))).length;
  return numeric / sample.length >= 0.6 ? "csv" : "text";
}

function plural(count: number, one: string, many: string): string {
  return `${count} ${count === 1 ? one : many}`;
}

/**
 * Read skills from pasted text or a file's contents: a CSV/TSV table (with or without a
 * header row), a JSON list, or plain lines such as "1. Kubernetes - +45% YoY".
 * Throws TrendImportError, with a message meant for the user, when nothing usable is found.
 */
export function parseTrendImport(raw: unknown, hint: ImportFormat | "auto" = "auto"): ParsedTrendImport {
  if (typeof raw !== "string") throw new TrendImportError("No data to import.");
  const text = raw.replace(/^\uFEFF/, "");
  if (!text.trim()) throw new TrendImportError("Paste LinkedIn trend data or choose a file first.");
  if (text.length > IMPORT_LIMITS.maxChars) {
    throw new TrendImportError(
      `This data is too large (the limit is ${IMPORT_LIMITS.maxChars.toLocaleString("en-US")} characters). Import only the skills table or list.`
    );
  }
  const c = new Collector();
  const format = hint === "auto" ? detectFormat(text) : IMPORT_FORMATS.includes(hint) ? hint : "text";
  if (format === "json") collectJson(text, c);
  else if (format === "csv") collectCsv(text, c);
  else collectText(text, c);

  if (!c.rows.length) {
    throw new TrendImportError(
      'No skills could be read from this data. Use one skill per line, a table with a "Skill" column, or a JSON list.'
    );
  }

  let rows = c.rows;
  if (rows.some((row) => row.rank !== null)) {
    rows = rows
      .map((row, index) => ({ row, index }))
      .sort(
        (a, b) =>
          Number(a.row.rank === null) - Number(b.row.rank === null) ||
          (a.row.rank ?? 0) - (b.row.rank ?? 0) ||
          a.index - b.index
      )
      .map(({ row }) => row);
  }

  const warnings: string[] = [];
  if (c.banned) {
    warnings.push(
      `${plural(c.banned, "entry", "entries")} (CI/CD, Pipelines, DevOps, DevSecOps) left out: resumes written by this app never use those terms.`
    );
  }
  if (c.duplicates) warnings.push(`${plural(c.duplicates, "duplicate", "duplicates")} merged into the first occurrence.`);
  if (c.prose) warnings.push(`${plural(c.prose, "line", "lines")} did not look like skill names (sentences, links or too long) and were skipped.`);
  if (c.tooShort) {
    warnings.push(
      `${plural(c.tooShort, "single-letter skill", "single-letter skills")} (such as R or C) cannot be matched safely in a resume and ${c.tooShort === 1 ? "was" : "were"} left out.`
    );
  }
  if (c.renamed.length) {
    warnings.push(
      `Renamed so ordinary words cannot count as evidence: ${c.renamed.slice(0, 6).join(", ")}${c.renamed.length > 6 ? ", ..." : ""}.`
    );
  }
  if (c.ambiguousLeftOut.length) {
    warnings.push(
      `Left out because they are everyday words with no unambiguous spelling: ${c.ambiguousLeftOut.slice(0, 6).join(", ")}${c.ambiguousLeftOut.length > 6 ? ", ..." : ""}.`
    );
  }
  if (c.truncated) warnings.push(`Only the first ${IMPORT_LIMITS.maxRows} skills were kept; ${c.truncated} more were not read.`);
  if (c.unreadableNumbers) warnings.push(`${plural(c.unreadableNumbers, "value", "values")} could not be read as numbers and were ignored.`);
  if (c.ignoredShares) warnings.push(`${plural(c.ignoredShares, "share value", "share values")} outside 0-100% were ignored.`);
  if (c.ambiguousPercents) {
    warnings.push(`${plural(c.ambiguousPercents, "percentage", "percentages")} had no sign or label (growth or share?) and were ignored.`);
  }
  if (c.duplicateMetrics) {
    warnings.push(
      `${plural(c.duplicateMetrics, "extra number", "extra numbers")} for a skill that already had a growth or share value ${c.duplicateMetrics === 1 ? "was" : "were"} ignored.`
    );
  }
  if (c.uninterpretedColumns) {
    warnings.push('No header row was found, so the first text column was used as the skill name. Add a header such as "Skill" if this is wrong.');
  }
  if (rows.length > IMPORT_LIMITS.maxUsed) {
    warnings.push(
      `Only the first ${IMPORT_LIMITS.maxUsed} skills are used per optimization. Put the most important skills first, or include a Rank column.`
    );
  }
  return { format: c.format, rows, skipped: c.skipped, warnings };
}

/* ------------------------------------------------------------------ *
 * Records
 * ------------------------------------------------------------------ */

export interface TrendImportInput {
  text: string;
  format?: ImportFormat | "auto";
  /** What the data is, e.g. "LinkedIn Talent Insights export". */
  source: string;
  /** When LinkedIn published (or the candidate exported) the data: YYYY-MM-DD or YYYY-MM. */
  publishedAt: string;
  region: string;
  /** The role or job family the data describes. */
  role: string;
  permissionConfirmed: boolean;
  now?: Date;
}

/** Validate the provenance the candidate gave, read their data, and build the record to store. */
export function createTrendImport(input: TrendImportInput): { record: TrendImportRecord; parsed: ParsedTrendImport } {
  if (!input.permissionConfirmed) {
    throw new TrendImportError("Confirm that this data came from your own LinkedIn account or licence and that you may use it here.");
  }
  const source = cleanLabel(input.source, IMPORT_LIMITS.source);
  if (source.length < 3) {
    throw new TrendImportError('Say where the data came from, for example "LinkedIn Talent Insights export".');
  }
  const role = cleanLabel(input.role, IMPORT_LIMITS.role);
  if (role.length < 2) throw new TrendImportError("Say which role or job family the data describes.");
  const region = cleanLabel(input.region, IMPORT_LIMITS.region);
  if (region.length < 2) throw new TrendImportError("Enter the region the data covers, for example India.");
  const published = normalizeImportDate(input.publishedAt);
  if (!published) {
    throw new TrendImportError("Enter the date the data was published or exported as YYYY-MM-DD (or YYYY-MM).");
  }
  const now = input.now ?? new Date();
  const publishedMs = Date.parse(published.length === 7 ? `${published}-01` : published);
  if (publishedMs > now.getTime() + 86_400_000) throw new TrendImportError("The publication date cannot be in the future.");

  const parsed = parseTrendImport(input.text, input.format ?? "auto");
  return {
    parsed,
    record: {
      version: 1,
      source,
      published_at: published,
      region,
      role,
      imported_at: now.toISOString(),
      permission: { confirmed: true, confirmed_at: now.toISOString() },
      format: parsed.format,
      skipped: parsed.skipped,
      warnings: parsed.warnings,
      skills: parsed.rows,
    },
  };
}

/**
 * Re-validate a record that crossed a trust boundary (local storage, the user's profile, a request
 * body). Anything malformed yields null; individual bad skills are dropped.
 */
export function normalizeTrendImportRecord(raw: unknown): TrendImportRecord | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const r = raw as Record<string, unknown>;
  if (r.version !== 1) return null;
  const source = cleanLabel(r.source, IMPORT_LIMITS.source);
  const role = cleanLabel(r.role, IMPORT_LIMITS.role);
  const region = cleanLabel(r.region, IMPORT_LIMITS.region);
  const published = normalizeImportDate(r.published_at);
  const importedMs = typeof r.imported_at === "string" ? Date.parse(r.imported_at) : NaN;
  if (!source || !role || !region || !published || !Number.isFinite(importedMs)) return null;
  if (!IMPORT_FORMATS.includes(r.format as ImportFormat) || !Array.isArray(r.skills)) return null;
  // The permission gate lives in the record, not only in the form that produced it.
  const permission = r.permission && typeof r.permission === "object" && !Array.isArray(r.permission) ? (r.permission as Record<string, unknown>) : null;
  const permissionMs = permission && typeof permission.confirmed_at === "string" ? Date.parse(permission.confirmed_at) : NaN;
  if (!permission || permission.confirmed !== true || !Number.isFinite(permissionMs)) return null;

  const skills: TrendImportSignal[] = [];
  const seen = new Set<string>();
  for (const item of r.skills.slice(0, IMPORT_LIMITS.maxRows * 2)) {
    const signal = readSignal(item);
    if (!signal) continue;
    // Same safeguards as a fresh import, so a record that skipped the parser cannot bypass them. Banned terms are
    // checked on the name as stored, before renaming ("(CI/CD)" would otherwise become "(CI, CD)").
    if (isBannedTrendTerm(signal.name)) continue;
    const safe = safeSkillName(signal.name);
    if (!safe.name || isBannedTrendTerm(safe.name)) continue;
    const key = trendNameKey(withoutParentheses(safe.name));
    if (!key || seen.has(key)) continue;
    seen.add(key);
    skills.push({ ...signal, name: safe.name });
    if (skills.length >= IMPORT_LIMITS.maxRows) break;
  }
  if (!skills.length) return null;

  const skipped = typeof r.skipped === "number" && Number.isInteger(r.skipped) && r.skipped >= 0 && r.skipped <= 1_000_000 ? r.skipped : 0;
  const warnings = Array.isArray(r.warnings)
    ? r.warnings.slice(0, IMPORT_LIMITS.warnings).map((warning) => cleanText(warning, IMPORT_LIMITS.warningLength)).filter(Boolean)
    : [];
  return {
    version: 1,
    source,
    published_at: published,
    region,
    role,
    imported_at: new Date(importedMs).toISOString(),
    permission: { confirmed: true, confirmed_at: new Date(permissionMs).toISOString() },
    format: r.format as ImportFormat,
    skipped,
    warnings,
    skills,
  };
}

/** Whole days between a publication date (YYYY-MM[-DD]) and `now`; 0 for unreadable or future dates. */
export function importAgeDays(publishedAt: string, now: Date = new Date()): number {
  const published = normalizeImportDate(publishedAt);
  if (!published) return 0;
  const ms = Date.parse(published.length === 7 ? `${published}-01` : published);
  return Math.max(0, Math.floor((now.getTime() - ms) / 86_400_000));
}

/* ------------------------------------------------------------------ *
 * From record to trend list
 * ------------------------------------------------------------------ */

const withoutParentheses = (name: string) => name.replace(/\([^)]*\)/g, " ");

let catalogueIndex: Map<string, TrendSkill> | null = null;

/** The curated skill an imported name denotes, so its aliases and evidence terms can be reused. */
function catalogueMatch(name: string): TrendSkill | undefined {
  if (!catalogueIndex) {
    const index = new Map<string, TrendSkill>();
    const catalogue = trendCatalogue();
    // A skill's own name wins over another skill's alias.
    for (const skill of catalogue) {
      const key = trendNameKey(withoutParentheses(skill.name));
      if (key && !index.has(key)) index.set(key, skill);
    }
    for (const skill of catalogue) {
      for (const alias of skill.aliases) {
        const key = trendNameKey(alias);
        if (key && !index.has(key)) index.set(key, skill);
      }
    }
    catalogueIndex = index;
  }
  return catalogueIndex.get(trendNameKey(withoutParentheses(name)));
}

function toTrendSkill(row: TrendImportSignal): TrendSkill {
  // Re-applied so a record built without the parser still never evidences a skill from everyday words.
  const name = safeSkillName(row.name).name;
  const skill: TrendSkill = { name, aliases: [...(own(SAFE_ALIASES, name) ?? [])] };
  const match = catalogueMatch(name);
  if (match) {
    // Keep LinkedIn's wording as the name; the curated spelling and evidence terms help detect the skill.
    const ownKey = trendNameKey(withoutParentheses(name));
    // A curated alias or evidence term that is itself an everyday word ("spark", "excel") would reintroduce the ambiguity.
    const curated = [match.name, ...match.aliases].filter((alias) => trendNameKey(alias) !== ownKey && !isAmbiguousName(alias));
    skill.aliases = Array.from(new Set([...skill.aliases, ...curated])).slice(0, 24);
    if (match.key) skill.key = match.key;
    const evidence = (match.evidence ?? []).filter((term) => !isAmbiguousName(term));
    if (evidence.length) skill.evidence = evidence;
  }
  return skill;
}

/**
 * The trend list for one optimization, built from the candidate's import. The first
 * 32 skills in priority order are used. The result carries the import's provenance so
 * prompts and reports say exactly where it came from.
 */
export function importedTrends(record: TrendImportRecord, targetRole: unknown, jobDescription?: unknown): LinkedInTrends {
  // A row that cannot be matched safely (an everyday word with no unambiguous spelling, a single letter) is skipped.
  const rows = record.skills.filter((row) => safeSkillName(row.name).name).slice(0, IMPORT_LIMITS.maxUsed);
  const skills = normalizeTrendSkills(rows.map(toTrendSkill)).slice(0, MAX_TREND_SKILLS);
  const rowByName = new Map(rows.map((row) => [trendNameKey(withoutParentheses(safeSkillName(row.name).name)), row]));
  const signals: TrendImportSignal[] = skills.map((skill) => {
    const row = rowByName.get(trendNameKey(skill.name));
    return { name: skill.name, rank: row?.rank ?? null, growth: row?.growth ?? null, share: row?.share ?? null };
  });

  const described = matchRoleFamilies(record.role);
  const wanted = matchRoleFamilies(targetRole, jobDescription);
  const warnings = [...record.warnings];
  const posting = typeof jobDescription === "string" ? jobDescription : "";
  if (posting.trim() && skills.length >= 4) {
    // Warn only when nothing imported relates to the posting or the target role's usual skills.
    const wantedIds = new Set(wanted.map((match) => match.id));
    const familyKeys = new Set(
      trendFamilies()
        .filter((family) => wantedIds.has(family.id))
        .flatMap((family) => family.skills.map(trendNameKey))
    );
    const related = skills.some(
      (skill) => trendSkillTerms(skill).some((term) => familyKeys.has(trendNameKey(term))) || findTerms(posting, trendSkillTerms(skill)).length > 0
    );
    if (!related) {
      warnings.push(
        `None of the imported skills relate to this job or your target role, but the data describes "${record.role}". Check that you imported the right list.`
      );
    }
  }

  const imported: TrendImportMetadata = {
    provider: IMPORT_PROVIDER,
    source: record.source,
    published_at: record.published_at,
    region: record.region,
    role: record.role,
    imported_at: record.imported_at,
    permission_confirmed_at: record.permission.confirmed_at,
    format: record.format,
    rows: record.skills.length,
    skipped: record.skipped,
    used: skills.length,
    warnings: warnings.map((warning) => cleanText(warning, IMPORT_LIMITS.warningLength)).slice(0, IMPORT_LIMITS.warnings),
    signals,
  };
  return {
    method: IMPORT_TREND_METHOD,
    role_family: described[0].id,
    families: described.map((match) => match.id),
    label: record.role,
    target_role: cleanText(targetRole, 160),
    as_of: record.published_at,
    skills,
    imported,
  };
}
