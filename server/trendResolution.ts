import { importedTrends, normalizeTrendImportRecord } from "../src/lib/linkedinImport";
import type { LinkedInTrends } from "../src/lib/linkedinTrends";

export type MarketSource = (targetRole: string, jobDescription?: string) => Promise<LinkedInTrends>;

export interface TrendResolution {
  trends: LinkedInTrends | null;
  /** Why trends were requested but not applied; the optimization proceeds without them. */
  warning?: string;
  /** The request itself is invalid (for example a tampered import) and must be rejected. */
  error?: string;
}

export interface TrendRequest {
  linkedinTrends?: unknown;
  trendImport?: unknown;
  targetRole?: unknown;
  jobDescription?: unknown;
}

/** Whether this request will need the daily job-market snapshot (and so a signed-in user). */
export function needsMarketTrends(request: TrendRequest): boolean {
  return (request.trendImport === undefined || request.trendImport === null) && request.linkedinTrends === true;
}

/**
 * The trend list a request asks for.
 *
 * - Imported LinkedIn data is re-validated here (it crossed a trust boundary) and wins when
 *   present: the candidate chose it, so the job-market snapshot is never substituted for it.
 *   An invalid import is an error rather than a silent fallback.
 * - Otherwise `linkedinTrends: true` asks for the daily job-market snapshot; if that is
 *   unavailable the optimization proceeds without trends and the reason is returned.
 */
export async function resolveRequestTrends(request: TrendRequest, market: MarketSource): Promise<TrendResolution> {
  const targetRole = typeof request.targetRole === "string" ? request.targetRole : "";
  const jobDescription = typeof request.jobDescription === "string" ? request.jobDescription : "";

  if (request.trendImport !== undefined && request.trendImport !== null) {
    const record = normalizeTrendImportRecord(request.trendImport);
    if (!record) return { trends: null, error: "The imported LinkedIn trend data is invalid. Import it again." };
    return { trends: importedTrends(record, targetRole, jobDescription) };
  }
  if (request.linkedinTrends === true) {
    try {
      return { trends: await market(targetRole, jobDescription) };
    } catch (e) {
      return { trends: null, warning: e instanceof Error ? e.message : "Job-market trends are unavailable." };
    }
  }
  return { trends: null };
}
