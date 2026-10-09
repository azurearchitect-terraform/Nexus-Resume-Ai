import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { JobMarketTrendService, aggregateDemand } from "./jobMarketTrends";
import {
  curatedTrends, applyTrendCoverage, trendsFromReport, buildTrendBrief, trendFingerprint,
} from "../src/lib/linkedinTrends";
import { MARKET_TREND_METHOD } from "../src/lib/jobMarketTrends";

const DAY = 86400000;
function fixture() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "nexus-market-test-"));
  const config = { appId: "test-id", appKey: "test-secret", countries: ["in", "au"], cacheFile: path.join(dir, "cache.json") };
  return { config, clean: () => fs.rmSync(dir, { recursive: true, force: true }) };
}

function ads(extra = "") {
  return new Response(JSON.stringify({
    results: [
      { id: "one", title: "Azure engineer", description: `Terraform and Azure Kubernetes Service. Remote work. ${extra}`, company: { display_name: "A" } },
      { id: "two", title: "Azure engineer", description: "Terraform and Microsoft Azure", company: { display_name: "B" } },
    ],
  }), { headers: { "Content-Type": "application/json" } });
}

test("demand counts unique postings rather than repeated keyword occurrences", () => {
  const template = curatedTrends("Azure engineer");
  const result = aggregateDemand(template, [
    { id: "a", text: "Terraform Terraform Terraform", remote: false },
    { id: "a", text: "Terraform", remote: false },
    { id: "b", text: "Azure", remote: false },
  ]);
  assert.equal(result.find(d => d.name === "Terraform")?.share, 50);
  assert.equal(result.find(d => d.name === "Terraform")?.postings, 1);
  assert.equal(result.find(d => d.name === "Terraform")?.change, null);
});

test("snapshot is deduplicated, cached for 24h, and refreshed by scheduled check", async () => {
  const f = fixture();
  try {
    let now = Date.parse("2026-10-09T00:00:00Z");
    let calls = 0;
    const request: typeof fetch = async input => {
      calls++;
      const url = new URL(String(input));
      assert.equal(url.hostname, "api.adzuna.com");
      assert.equal(url.searchParams.get("max_days_old"), "30");
      assert.equal(url.searchParams.get("results_per_page"), "50");
      assert.equal(url.searchParams.get("sort_dir"), "down");
      if (url.searchParams.has("what_and")) assert.ok(url.searchParams.get("what_and")?.endsWith(" remote"));
      return ads();
    };
    const service = new JobMarketTrendService(f.config, request, () => now);
    const first = await service.get("Azure engineer");
    assert.equal(calls, 4);
    assert.equal(first.market?.sample_size, 2);
    assert.equal(first.market?.remote_postings, 1);
    assert.equal(first.market?.previous_sample_at, null);
    assert.equal(first.method, MARKET_TREND_METHOD);
    await service.get("Azure engineer");
    assert.equal(calls, 4);
    now += DAY;
    await service.refreshKnown();
    assert.equal(calls, 8);
    const next = await service.get("Azure engineer");
    assert.equal(next.market?.previous_sample_at, first.market?.refreshed_at);
    assert.ok(next.market?.demand.every(d => d.change === 0));
    assert.notEqual(trendFingerprint(first), trendFingerprint(next));
    const restored = new JobMarketTrendService(f.config, request, () => now);
    const cached = await restored.get("Azure engineer");
    assert.equal(calls, 8);
    assert.equal(cached.market?.refreshed_at, next.market?.refreshed_at);
    const saved = fs.readFileSync(f.config.cacheFile, "utf8");
    assert.ok(!saved.includes("test-secret"));
    assert.ok(!saved.includes("Terraform and"));
  } finally { f.clean(); }
});

test("concurrent audiences share one refresh", async () => {
  const f = fixture();
  try {
    let calls = 0;
    const service = new JobMarketTrendService(f.config, async () => { calls++; return ads(); });
    await Promise.all([service.get("Azure engineer"), service.get("Azure engineer")]);
    assert.equal(calls, 4);
  } finally { f.clean(); }
});

test("missing credentials are explicit and never replaced by curated live data", async () => {
  const f = fixture();
  try {
    const service = new JobMarketTrendService({ ...f.config, appKey: "" }, async () => { throw new Error("Must not fetch"); });
    await assert.rejects(service.get("Azure engineer"), /not configured/);
  } finally { f.clean(); }
});

test("failed refresh returns a labelled stale snapshot and backs off", async () => {
  const f = fixture();
  try {
    let now = Date.parse("2026-10-09T00:00:00Z");
    let fail = false;
    let calls = 0;
    const service = new JobMarketTrendService(f.config, async () => {
      calls++;
      return fail ? new Response("", { status: 429 }) : ads();
    }, () => now);
    const first = await service.get("Azure engineer");
    now += DAY;
    fail = true;
    const stale = await service.get("Azure engineer");
    assert.equal(stale.market?.refreshed_at, first.market?.refreshed_at);
    assert.equal(stale.market?.stale, true);
    assert.ok(stale.market?.warnings.some(w => w.includes("Daily refresh failed")));
    assert.equal(calls, 8);
    await service.get("Azure engineer");
    assert.equal(calls, 8);
  } finally { f.clean(); }
});

test("partial coverage is named and not compared with a complete sample", async () => {
  const f = fixture();
  try {
    let now = Date.parse("2026-10-09T00:00:00Z");
    let failAu = false;
    const service = new JobMarketTrendService(f.config, async input =>
      failAu && String(input).includes("/au/") ? new Response("", { status: 503 }) : ads(), () => now);
    await service.get("Azure engineer");
    now += DAY;
    failAu = true;
    const snapshot = await service.get("Azure engineer");
    assert.deepEqual(snapshot.market?.countries, ["in"]);
    assert.equal(snapshot.market?.previous_sample_at, null);
    assert.ok(snapshot.market?.demand.every(d => d.change === null));
    assert.ok(snapshot.market?.warnings.some(w => w.includes("au")));
  } finally { f.clean(); }
});

test("provider failure without history and empty snippets cannot appear successful", async () => {
  for (const response of [
    () => new Response("", { status: 401 }),
    () => new Response(JSON.stringify({ results: [] })),
    () => new Response(JSON.stringify({ wrong: true })),
  ]) {
    const f = fixture();
    try {
      const service = new JobMarketTrendService(f.config, async () => response());
      await assert.rejects(service.get("Azure engineer"));
    } finally { f.clean(); }
  }
});

test("live provenance survives report normalization and steers only evidenced skills", async () => {
  const f = fixture();
  try {
    const service = new JobMarketTrendService(f.config, async () => ads());
    const snapshot = await service.get("Azure engineer");
    const resume = { summary: "Terraform engineer", skills: ["Terraform"], experience: [] };
    applyTrendCoverage(resume, snapshot, { sourceText: "Terraform engineer" });
    const report = (resume as typeof resume & { linkedin_trends: unknown }).linkedin_trends;
    const restored = trendsFromReport(report);
    assert.equal(restored?.method, MARKET_TREND_METHOD);
    assert.equal(restored?.market?.sample_size, 2);
    const brief = buildTrendBrief(restored, { evidenceText: "Terraform engineer" });
    assert.ok(brief.includes("Adzuna"));
    assert.ok(brief.includes("- Terraform"));
    assert.ok(!brief.includes("- Azure Kubernetes Service"));
  } finally { f.clean(); }
});

test("a damaged cache file starts empty instead of stopping the server", async () => {
  const f = fixture();
  try {
    fs.writeFileSync(f.config.cacheFile, "{ this is not json");
    let service: JobMarketTrendService | undefined;
    assert.doesNotThrow(() => { service = new JobMarketTrendService(f.config, async () => ads()); });
    const snapshot = await service!.get("Azure engineer");
    assert.equal(snapshot.market?.sample_size, 2);
    assert.doesNotThrow(() => JSON.parse(fs.readFileSync(f.config.cacheFile, "utf8")));
  } finally { f.clean(); }
});

test("an unwritable cache location still serves fresh data, with a visible warning", async () => {
  const f = fixture();
  try {
    const blocker = path.join(path.dirname(f.config.cacheFile), "blocker");
    fs.writeFileSync(blocker, "a file, not a directory");
    const config = { ...f.config, cacheFile: path.join(blocker, "cache.json") };
    const service = new JobMarketTrendService(config, async () => ads());
    const snapshot = await service.get("Azure engineer");
    assert.equal(snapshot.market?.sample_size, 2);
    assert.ok(snapshot.market?.warnings.some(w => w.includes("could not be saved")));
    const again = await service.get("Azure engineer");
    assert.equal(again.market?.refreshed_at, snapshot.market?.refreshed_at);
  } finally { f.clean(); }
});

test("unsupported market codes are rejected at construction so the server can report it", () => {
  const f = fixture();
  try {
    assert.throws(() => new JobMarketTrendService({ ...f.config, countries: ["us"] }), /in, au, nz, sg/);
    assert.throws(() => new JobMarketTrendService({ ...f.config, countries: [] }), /in, au, nz, sg/);
  } finally { f.clean(); }
});
