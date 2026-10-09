export interface MarketSkillDemand {
  name: string;
  postings: number;
  share: number;
  change: number | null;
}

export interface MarketTrendMetadata {
  provider: "Adzuna";
  refreshed_at: string;
  countries: string[];
  sample_size: number;
  remote_postings: number;
  previous_sample_at: string | null;
  demand: MarketSkillDemand[];
  stale: boolean;
  warnings: string[];
}

export const MARKET_TREND_METHOD = "adzuna-job-demand-v1";

export function readMarketMetadata(value: unknown): MarketTrendMetadata | undefined {
  if (!value || typeof value !== "object") return undefined;
  const m = value as Partial<MarketTrendMetadata>;
  if (m.provider !== "Adzuna" || typeof m.refreshed_at !== "string" ||
      !Number.isFinite(Date.parse(m.refreshed_at)) ||
      !Array.isArray(m.countries) || !m.countries.every(v => typeof v === "string") ||
      typeof m.sample_size !== "number" || m.sample_size < 1 || !Number.isInteger(m.sample_size) ||
      typeof m.remote_postings !== "number" || !Number.isInteger(m.remote_postings) ||
      m.remote_postings < 0 || m.remote_postings > m.sample_size ||
      !Array.isArray(m.warnings) || !m.warnings.every(v => typeof v === "string") ||
      typeof m.stale !== "boolean" || !Array.isArray(m.demand)) return undefined;
  if (m.previous_sample_at !== null &&
      (typeof m.previous_sample_at !== "string" || !Number.isFinite(Date.parse(m.previous_sample_at)))) return undefined;
  if (!m.demand.every(d => d && typeof d.name === "string" &&
      Number.isInteger(d.postings) && d.postings >= 0 && d.postings <= m.sample_size! &&
      Number.isFinite(d.share) && d.share >= 0 && d.share <= 100 &&
      (d.change === null || (Number.isFinite(d.change) && Math.abs(d.change) <= 100)))) return undefined;
  return m as MarketTrendMetadata;
}
