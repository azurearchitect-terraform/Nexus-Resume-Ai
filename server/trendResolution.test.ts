import { test } from "node:test";
import assert from "node:assert/strict";
import { needsMarketTrends, resolveRequestTrends } from "./trendResolution";
import { createTrendImport } from "../src/lib/linkedinImport";
import { curatedTrends } from "../src/lib/linkedinTrends";

const record = createTrendImport({
  text: "Terraform\nKubernetes\nAzure\nZero Trust",
  source: "LinkedIn Talent Insights export",
  publishedAt: "2026-09-30",
  region: "India",
  role: "Cloud Engineer",
  permissionConfirmed: true,
  now: new Date("2026-10-09T10:00:00Z"),
}).record;

const market = (calls: string[]) => async (role: string) => {
  calls.push(role);
  return curatedTrends(role);
};
const failingMarket = async () => {
  throw new Error("Adzuna quota exhausted");
};

test("imported LinkedIn data is used and the job-market snapshot is never fetched", async () => {
  const calls: string[] = [];
  const result = await resolveRequestTrends(
    { trendImport: record, linkedinTrends: true, targetRole: "Cloud Engineer", jobDescription: "Azure and Terraform" },
    market(calls)
  );
  assert.ok(!result.error && result.trends);
  assert.equal(result.trends?.imported?.source, "LinkedIn Talent Insights export");
  assert.equal(result.trends?.market, undefined);
  assert.deepEqual(calls, []);
});

test("a tampered import is an error, not a silent switch to another source", async () => {
  const calls: string[] = [];
  for (const bad of [{ ...record, version: 9 }, { ...record, skills: [] }, { ...record, permission: undefined }, "nonsense", 5]) {
    const result = await resolveRequestTrends({ trendImport: bad, linkedinTrends: true, targetRole: "x", jobDescription: "y" }, market(calls));
    assert.ok(result.error, JSON.stringify(bad)?.slice(0, 60));
    assert.equal(result.trends, null);
  }
  assert.deepEqual(calls, []);
});

test("the server rebuilds the trends from the stored record, ignoring anything extra the client sent", async () => {
  const forged = { ...record, skills: [{ name: "Terraform", rank: 1, growth: null, share: null }], extra: { evil: true } };
  const result = await resolveRequestTrends({ trendImport: forged, targetRole: "Cloud Engineer", jobDescription: "" }, market([]));
  assert.ok(!result.error && result.trends);
  assert.deepEqual(result.trends?.skills.map((s) => s.name), ["Terraform"]);
  assert.equal(Object.prototype.hasOwnProperty.call(result.trends!, "extra"), false);
});

test("without an import, linkedinTrends:true asks for the job-market snapshot", async () => {
  const calls: string[] = [];
  const result = await resolveRequestTrends({ linkedinTrends: true, targetRole: "Azure Engineer", jobDescription: "jd" }, market(calls));
  assert.ok(!result.error && result.trends);
  assert.deepEqual(calls, ["Azure Engineer"]);
});

test("an unavailable snapshot lets the optimization proceed without trends and says why", async () => {
  const result = await resolveRequestTrends({ linkedinTrends: true, targetRole: "Azure Engineer", jobDescription: "jd" }, failingMarket);
  assert.equal(result.error, undefined);
  assert.equal(result.trends, null);
  assert.equal(result.warning, "Adzuna quota exhausted");
});

test("nothing is requested, nothing is resolved (only a literal true switches trends on)", async () => {
  const calls: string[] = [];
  for (const request of [{}, { linkedinTrends: false }, { linkedinTrends: "true" }, { linkedinTrends: 1 }, { trendImport: null }]) {
    const result = await resolveRequestTrends({ ...request, targetRole: "x", jobDescription: "y" }, market(calls));
    assert.deepEqual(result, { trends: null });
  }
  assert.deepEqual(calls, []);
});

test("only the job-market path needs a signed-in user", () => {
  assert.equal(needsMarketTrends({ linkedinTrends: true }), true);
  assert.equal(needsMarketTrends({ linkedinTrends: true, trendImport: record }), false);
  assert.equal(needsMarketTrends({}), false);
  assert.equal(needsMarketTrends({ linkedinTrends: "true" }), false);
});
