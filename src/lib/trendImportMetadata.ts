/**
 * Types and strict validators for trend data the candidate imported from LinkedIn.
 *
 * This module imports nothing, so linkedinTrends.ts can use it without a cycle. The
 * app never contacts LinkedIn: everything described here was exported or copied by
 * the candidate and is displayed as provenance, never as something the app verified.
 */

export const IMPORT_TREND_METHOD = "linkedin-import-v1";
export const IMPORT_PROVIDER = "LinkedIn data imported by you";

export type ImportFormat = "csv" | "json" | "text";
export const IMPORT_FORMATS: readonly ImportFormat[] = ["csv", "json", "text"];

export const IMPORT_LIMITS = {
  /** Characters accepted from a file or paste. */
  maxChars: 200_000,
  /** Skills kept in a stored import. */
  maxRows: 200,
  /** Skills used by one optimization (matches the trend list cap). */
  maxUsed: 32,
  maxNameLength: 60,
  maxWordsPerName: 8,
  source: 80,
  role: 80,
  region: 60,
  warnings: 12,
  warningLength: 280,
} as const;

/** What the file said about one skill. Numbers are percentages and are display-only. */
export interface TrendImportSignal {
  name: string;
  /** 1 = highest priority, when the file ranks its skills. */
  rank: number | null;
  /** Percentage change (may be negative). */
  growth: number | null;
  /** Percentage share, 0-100. */
  share: number | null;
}

export interface TrendImportMetadata {
  provider: typeof IMPORT_PROVIDER;
  /** What the data is, e.g. "LinkedIn Talent Insights export". */
  source: string;
  /** "YYYY-MM-DD" or "YYYY-MM": when LinkedIn published or the candidate exported the data. */
  published_at: string;
  region: string;
  /** The role or job family the data describes. */
  role: string;
  /** ISO timestamp of the import. */
  imported_at: string;
  /** ISO timestamp of the candidate's confirmation that they may use this data. */
  permission_confirmed_at: string;
  format: ImportFormat;
  /** Skills found in the file. */
  rows: number;
  /** Entries left out (banned terms, duplicates, prose). */
  skipped: number;
  /** Skills used for this optimization. */
  used: number;
  warnings: string[];
  /** The signals of the skills used, in priority order. */
  signals: TrendImportSignal[];
}

function asText(value: unknown): string {
  if (typeof value === "string") return value;
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  return "";
}

/** A single-line label with only letters, digits and plain punctuation - safe to show and to place in a prompt. */
export function cleanLabel(value: unknown, max: number): string {
  return asText(value)
    .replace(/[^\p{L}\p{N} .,&()/+'\u2019:#%-]/gu, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, max)
    .trim();
}

/** Free text with control characters removed, for messages. */
export function cleanText(value: unknown, max: number): string {
  return asText(value)
    .replace(/[\u0000-\u001f\u007f]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, max);
}

/** "YYYY-MM-DD" or "YYYY-MM" for a real calendar date between 2000 and 2100, otherwise "". */
export function normalizeImportDate(value: unknown): string {
  const match = /^(\d{4})-(\d{2})(?:-(\d{2}))?$/.exec(asText(value).trim());
  if (!match) return "";
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = match[3] ? Number(match[3]) : 1;
  if (year < 2000 || year > 2100 || month < 1 || month > 12) return "";
  const probe = new Date(Date.UTC(year, month - 1, day));
  if (probe.getUTCFullYear() !== year || probe.getUTCMonth() !== month - 1 || probe.getUTCDate() !== day) return "";
  return match[3] ? `${match[1]}-${match[2]}-${match[3]}` : `${match[1]}-${match[2]}`;
}

function inRange(value: unknown, min: number, max: number): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= min && value <= max;
}

/** A signal's numbers, or null when any of them is out of range or of the wrong type. */
export function readSignal(value: unknown, nameMax: number = IMPORT_LIMITS.maxNameLength): TrendImportSignal | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  const name = cleanLabel(record.name, nameMax);
  if (name.length < 2 || !/\p{L}/u.test(name)) return null;
  const optional = (field: unknown, min: number, max: number, integer = false): number | null | undefined => {
    if (field === null || field === undefined) return null;
    if (!inRange(field, min, max) || (integer && !Number.isInteger(field))) return undefined;
    return field;
  };
  const rank = optional(record.rank, 1, 100_000, true);
  const growth = optional(record.growth, -1000, 100_000);
  const share = optional(record.share, 0, 100);
  if (rank === undefined || growth === undefined || share === undefined) return null;
  return { name, rank, growth, share };
}

/** Validated, cleaned import metadata, or undefined when anything about it is malformed. */
export function readImportMetadata(value: unknown): TrendImportMetadata | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const m = value as Record<string, unknown>;
  if (m.provider !== IMPORT_PROVIDER) return undefined;
  const source = cleanLabel(m.source, IMPORT_LIMITS.source);
  const role = cleanLabel(m.role, IMPORT_LIMITS.role);
  const region = cleanLabel(m.region, IMPORT_LIMITS.region);
  const published = normalizeImportDate(m.published_at);
  const importedMs = typeof m.imported_at === "string" ? Date.parse(m.imported_at) : NaN;
  const permissionMs = typeof m.permission_confirmed_at === "string" ? Date.parse(m.permission_confirmed_at) : NaN;
  if (!source || !role || !region || !published || !Number.isFinite(importedMs) || !Number.isFinite(permissionMs)) return undefined;
  if (!IMPORT_FORMATS.includes(m.format as ImportFormat)) return undefined;
  if (!inRange(m.rows, 0, 10_000) || !Number.isInteger(m.rows)) return undefined;
  if (!inRange(m.skipped, 0, 1_000_000) || !Number.isInteger(m.skipped)) return undefined;
  if (!inRange(m.used, 0, IMPORT_LIMITS.maxUsed) || !Number.isInteger(m.used)) return undefined;
  if (!Array.isArray(m.warnings) || !Array.isArray(m.signals)) return undefined;
  if (m.signals.length > IMPORT_LIMITS.maxUsed) return undefined;
  const signals: TrendImportSignal[] = [];
  for (const item of m.signals) {
    const signal = readSignal(item);
    if (!signal) return undefined;
    signals.push(signal);
  }
  return {
    provider: IMPORT_PROVIDER,
    source,
    published_at: published,
    region,
    role,
    imported_at: new Date(importedMs).toISOString(),
    permission_confirmed_at: new Date(permissionMs).toISOString(),
    format: m.format as ImportFormat,
    rows: m.rows as number,
    skipped: m.skipped as number,
    used: m.used as number,
    warnings: m.warnings
      .slice(0, IMPORT_LIMITS.warnings)
      .map((warning) => cleanText(warning, IMPORT_LIMITS.warningLength))
      .filter(Boolean),
    signals,
  };
}
