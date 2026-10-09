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
  const context = `Job-market trends endpoint (HTTP ${response.status})`;
  let text: string;
  try {
    text = await response.text();
  } catch {
    throw new Error(`${context} response could not be read. Check the application server connection and retry.`);
  }
  if (!text.trim()) {
    throw new Error(`${context} returned an empty response. Check that the application server is running and /api/job-market-trends is routed to it.`);
  }
  let body: unknown;
  try {
    body = JSON.parse(text);
  } catch {
    throw new Error(`${context} returned invalid JSON. Check the application server and API proxy configuration.`);
  }
  if (!response.ok) {
    const error = body && typeof body === "object" && "error" in body ? body.error : null;
    throw new Error(typeof error === "string" && error.trim() ? error : `${context} is unavailable.`);
  }
  const trends = normalizeLinkedInTrends(body);
  if (!trends?.market || trends.method !== MARKET_TREND_METHOD) {
    throw new Error("The server returned an invalid job-market trend snapshot.");
  }
  return trends;
}
