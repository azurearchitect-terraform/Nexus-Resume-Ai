import { normalizeLinkedInTrends, type LinkedInTrends } from "./linkedinTrends";
import { MARKET_TREND_METHOD } from "./jobMarketTrends";

/** The daily Adzuna job-market snapshot for a role, from the signed-in user's server session. */
export async function fetchJobMarketTrends(
  targetRole: string,
  jobDescription: string,
  idToken?: string
): Promise<LinkedInTrends> {
  if (!idToken) throw new Error("Sign in to retrieve job-market trends.");
  const response = await fetch("/api/job-market-trends", {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${idToken}` },
    body: JSON.stringify({ targetRole, jobDescription }),
  });
  const body = await response.json();
  if (!response.ok) throw new Error(typeof body.error === "string" ? body.error : "Job-market trends are unavailable.");
  const trends = normalizeLinkedInTrends(body);
  if (!trends?.market || trends.method !== MARKET_TREND_METHOD) {
    throw new Error("The server returned an invalid job-market trend snapshot.");
  }
  return trends;
}
