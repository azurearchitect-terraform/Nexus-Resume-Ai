import assert from "node:assert/strict";
import test from "node:test";
import { fetchJobMarketTrends } from "./trendClient";
import { curatedTrends } from "./linkedinTrends";
import { MARKET_TREND_METHOD } from "./jobMarketTrends";

test("trends require authentication before contacting the server", async t => {
  const request = t.mock.method(globalThis, "fetch", async () => {
    throw new Error("Should not fetch");
  });
  await assert.rejects(fetchJobMarketTrends("Azure Engineer", ""), /Sign in/);
  assert.equal(request.mock.callCount(), 0);
});

test("empty endpoint responses identify the API route and status, not a parser error", async t => {
  for (const status of [200, 204, 401, 502]) {
    t.mock.method(globalThis, "fetch", async () => new Response(null, { status }));
    await assert.rejects(fetchJobMarketTrends("Azure Engineer", "", "test-token"),
      new RegExp(`HTTP ${status}.*empty response.*\\/api\\/job-market-trends`));
    t.mock.restoreAll();
  }
  t.mock.method(globalThis, "fetch", async () => new Response(" \n\t"));
  await assert.rejects(fetchJobMarketTrends("Azure Engineer", "", "test-token"), /empty response/);
});

test("HTML, plain text and truncated JSON responses provide server/proxy guidance", async t => {
  for (const body of ["<html>frontend page</html>", "Bad Gateway", '{"skills":']) {
    t.mock.method(globalThis, "fetch", async () => new Response(body, { status: 502 }));
    await assert.rejects(fetchJobMarketTrends("Azure Engineer", "", "test-token"),
      /HTTP 502.*invalid JSON.*API proxy/);
    t.mock.restoreAll();
  }
});

test("JSON error messages are preserved and null/errorless bodies are safe", async t => {
  for (const [body, expected] of [
    [{ error: "Set ADZUNA_APP_ID and ADZUNA_APP_KEY on the server." }, /Set ADZUNA_APP_ID/],
    [null, /HTTP 503.*unavailable/],
    [{ error: 123 }, /HTTP 503.*unavailable/],
    [{ error: " " }, /HTTP 503.*unavailable/],
  ] as const) {
    t.mock.method(globalThis, "fetch", async () => new Response(JSON.stringify(body), { status: 503 }));
    await assert.rejects(fetchJobMarketTrends("Azure Engineer", "", "test-token"), expected);
    t.mock.restoreAll();
  }
});

test("successful JSON must still be a valid market snapshot", async t => {
  for (const body of [null, [], {}, curatedTrends("Azure Engineer")]) {
    t.mock.method(globalThis, "fetch", async () => new Response(JSON.stringify(body)));
    await assert.rejects(fetchJobMarketTrends("Azure Engineer", "", "test-token"), /invalid job-market trend snapshot/);
    t.mock.restoreAll();
  }
});

test("a real market snapshot is normalized and the signed-in request is unchanged", async t => {
  const template = curatedTrends("Azure Engineer");
  const snapshot = {
    ...template, method: MARKET_TREND_METHOD,
    market: {
      provider: "Adzuna", refreshed_at: "2026-10-09T00:00:00Z", countries: ["in"],
      sample_size: 1, remote_postings: 0, previous_sample_at: null, stale: false, warnings: [],
      demand: [{ name: template.skills[0].name, postings: 1, share: 100, change: null }],
    },
  };
  t.mock.method(globalThis, "fetch", async (url, init) => {
    assert.equal(url, "/api/job-market-trends");
    assert.equal(init?.method, "POST");
    assert.deepEqual(init?.headers, { "Content-Type": "application/json", Authorization: "Bearer test-token" });
    assert.deepEqual(JSON.parse(String(init?.body)), { targetRole: "Azure Engineer", jobDescription: "Azure role" });
    return new Response(JSON.stringify(snapshot), { headers: { "Content-Type": "application/json" } });
  });
  const result = await fetchJobMarketTrends("Azure Engineer", "Azure role", "test-token");
  assert.equal(result.method, MARKET_TREND_METHOD);
  assert.deepEqual(result.market, snapshot.market);
});

test("unreadable response streams report a connection error", async t => {
  t.mock.method(globalThis, "fetch", async () => {
    const response = new Response("{}");
    t.mock.method(response, "text", async () => { throw new Error("Stream interrupted"); });
    return response;
  });
  await assert.rejects(fetchJobMarketTrends("Azure Engineer", "", "test-token"), /response could not be read/);
});
