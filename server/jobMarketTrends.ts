import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import {
  curatedTrends, normalizeLinkedInTrends, trendSkillTerms,
  type LinkedInTrends,
} from "../src/lib/linkedinTrends";
import { findTerms } from "../src/lib/bulletBudget";
import { MARKET_TREND_METHOD, type MarketSkillDemand } from "../src/lib/jobMarketTrends";

const DAY = 24 * 60 * 60 * 1000;
const COUNTRIES = new Set(["in", "au", "nz", "sg"]);
const QUERIES: Record<string, string> = {
  "azure-cloud": "Azure", "aws-cloud": "AWS", "gcp-cloud": "Google Cloud",
  "cloud-generic": "cloud engineer", infrastructure: "infrastructure",
  "modern-workplace": "Microsoft 365", "sre-platform": "site reliability",
  security: "cybersecurity", data: "data engineer", software: "software engineer",
  architecture: "solution architect", leadership: "technology manager", general: "professional",
};

interface Posting {
  id: string;
  text: string;
  remote: boolean;
}

interface CachedProfile {
  template: LinkedInTrends;
  snapshot?: LinkedInTrends;
}

interface MarketConfig {
  appId: string;
  appKey: string;
  countries: string[];
  cacheFile: string;
}

function profileKey(template: LinkedInTrends): string {
  return createHash("sha256").update(JSON.stringify([
    template.families, template.skills.map(s => [s.name, s.aliases]),
  ])).digest("hex");
}

export function aggregateDemand(
  template: LinkedInTrends,
  postings: Posting[],
  previous?: LinkedInTrends
): MarketSkillDemand[] {
  const unique = [...new Map(postings.map(p => [p.id, p])).values()];
  if (!unique.length) throw new Error("Adzuna returned no readable job postings for this role.");
  return template.skills.map(skill => {
    const count = unique.filter(p => findTerms(p.text, trendSkillTerms(skill)).length > 0).length;
    const share = Math.round(count / unique.length * 1000) / 10;
    const old = previous?.market?.demand.find(d => d.name === skill.name);
    return { name: skill.name, postings: count, share, change: old ? Math.round((share - old.share) * 10) / 10 : null };
  }).sort((a, b) => b.postings - a.postings || a.name.localeCompare(b.name));
}

export class JobMarketTrendService {
  private profiles = new Map<string, CachedProfile>();
  private pending = new Map<string, Promise<LinkedInTrends>>();
  private failures = new Map<string, { until: number; message: string }>();
  private persistWarning = "";

  constructor(
    private config: MarketConfig,
    private request: typeof fetch = fetch,
    private clock: () => number = Date.now
  ) {
    this.config = {
      ...config,
      appId: (config.appId || "").trim(),
      appKey: (config.appKey || "").trim(),
      countries: config.countries.map(c => c.trim()),
    };
    if (!this.config.countries.length || this.config.countries.some(c => !COUNTRIES.has(c))) {
      throw new Error("ADZUNA_COUNTRIES must use supported APAC codes: in, au, nz, sg.");
    }
    this.load();
  }

  /** The cache only saves requests: a missing or damaged file starts empty rather than stopping the server. */
  private load(): void {
    try {
      if (!fs.existsSync(this.config.cacheFile)) return;
      const raw: unknown = JSON.parse(fs.readFileSync(this.config.cacheFile, "utf8"));
      if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new Error("Invalid job-market cache.");
      for (const [key, value] of Object.entries(raw)) {
        if (!value || typeof value !== "object") continue;
        const record = value as Record<string, unknown>;
        const template = normalizeLinkedInTrends(record.template);
        if (!template || key !== this.key(template)) continue;
        const snapshot = record.snapshot ? normalizeLinkedInTrends(record.snapshot) : null;
        this.profiles.set(key, { template, snapshot: snapshot || undefined });
      }
    } catch (e) {
      this.profiles.clear();
      console.warn("[JobMarketTrends] Ignoring unreadable cache file:", e instanceof Error ? e.message : "unknown error");
    }
  }

  private key(template: LinkedInTrends): string {
    return `${this.config.countries.join("-")}:${profileKey(template)}`;
  }

  private save(): void {
    try {
      fs.mkdirSync(path.dirname(this.config.cacheFile), { recursive: true });
      const temporary = `${this.config.cacheFile}.tmp`;
      fs.writeFileSync(temporary, JSON.stringify(Object.fromEntries(this.profiles)));
      fs.renameSync(temporary, this.config.cacheFile);
      this.persistWarning = "";
    } catch (e) {
      this.persistWarning = "Snapshots could not be saved (check ADZUNA_CACHE_FILE), so day-to-day comparisons reset when the server restarts.";
      console.warn("[JobMarketTrends] Unable to persist snapshots:", e instanceof Error ? e.message : "unknown error");
    }
  }

  private async postings(query: string, country: string, remote: boolean): Promise<Posting[]> {
    const url = new URL(`https://api.adzuna.com/v1/api/jobs/${country}/search/1`);
    url.search = new URLSearchParams({
      app_id: this.config.appId, app_key: this.config.appKey,
      ...(remote ? { what_and: `${query} remote` } : { what: query }),
      results_per_page: "50", sort_by: "date", max_days_old: "30",
      "content-type": "application/json",
    }).toString();
    let response: Response;
    try {
      response = await this.request(url, { signal: AbortSignal.timeout(20000) });
    } catch {
      // Do not log the provider URL: its query string contains credentials.
      throw new Error(`Adzuna ${country}${remote ? " remote" : ""} request failed or timed out.`);
    }
    if (!response.ok) throw new Error(`Adzuna ${country} request failed (HTTP ${response.status}).`);
    let text: string;
    try {
      text = await response.text();
    } catch {
      throw new Error(`Adzuna ${country} response could not be read. Retry after the service recovers.`);
    }
    if (!text.trim()) throw new Error(`Adzuna ${country} returned an empty response (HTTP ${response.status}).`);
    let raw: unknown;
    try {
      raw = JSON.parse(text);
    } catch {
      throw new Error(`Adzuna ${country} returned invalid JSON (HTTP ${response.status}).`);
    }
    if (!raw || typeof raw !== "object" || !("results" in raw) || !Array.isArray(raw.results)) {
      throw new Error(`Adzuna ${country} returned an invalid response.`);
    }
    return raw.results.flatMap((item: unknown) => {
      if (!item || typeof item !== "object") return [];
      const p = item as Record<string, unknown>;
      if (typeof p.title !== "string" || typeof p.description !== "string" || !p.description.trim()) return [];
      const text = `${p.title}\n${p.description}`.replace(/<[^>]*>/g, " ");
      const company = p.company && typeof p.company === "object" && "display_name" in p.company
        ? String(p.company.display_name) : "";
      const id = createHash("sha256").update(`${p.title}|${company}|${p.description}`).digest("hex");
      return [{ id, text, remote: /\bremote\b|work from home|work anywhere/i.test(text) }];
    });
  }

  private withStatus(snapshot: LinkedInTrends, warning?: string): LinkedInTrends {
    const market = snapshot.market!;
    return {
      ...snapshot,
      market: {
        ...market,
        stale: this.clock() - Date.parse(market.refreshed_at) >= DAY,
        warnings: [
          ...market.warnings,
          ...(this.persistWarning ? [this.persistWarning] : []),
          ...(warning ? [warning] : []),
        ],
      },
    };
  }

  private async refresh(key: string, template: LinkedInTrends): Promise<LinkedInTrends> {
    const old = this.profiles.get(key)?.snapshot;
    const warnings: string[] = [];
    const covered: string[] = [];
    const postings: Posting[] = [];
    try {
      if (!this.config.appId || !this.config.appKey) {
        throw new Error("Job Market Trends is not configured. Set ADZUNA_APP_ID and ADZUNA_APP_KEY on the server.");
      }
      const query = QUERIES[template.role_family] || QUERIES.general;
      for (const country of this.config.countries) {
        let succeeded = false;
        try {
          postings.push(...await this.postings(query, country, false));
          succeeded = true;
        } catch (e) {
          warnings.push(e instanceof Error ? e.message : "Adzuna country search failed.");
        }
        try {
          postings.push(...await this.postings(query, country, true));
          succeeded = true;
        } catch (e) {
          warnings.push(e instanceof Error ? e.message : "Adzuna remote search failed.");
        }
        if (succeeded) covered.push(country);
      }
      if (!covered.length) throw new Error(`All Adzuna market searches failed. ${warnings.join(" ")}`);
      const unique = [...new Map(postings.map(p => [p.id, p])).values()];
      const comparable = old?.market?.countries.join(",") === covered.join(",") &&
        !warnings.length && !old?.market?.warnings.some(w => w.includes("Adzuna"));
      const demand = aggregateDemand(template, unique, comparable ? old : undefined);
      const found = demand.filter(d => d.postings > 0);
      if (!found.length) throw new Error("No recognized market skills were found in the sampled posting snippets.");
      const snapshot: LinkedInTrends = {
        ...template,
        method: MARKET_TREND_METHOD,
        as_of: new Date(this.clock()).toISOString().slice(0, 7),
        skills: found.map(d => template.skills.find(s => s.name === d.name)!),
        market: {
          provider: "Adzuna", refreshed_at: new Date(this.clock()).toISOString(),
          countries: covered, sample_size: unique.length,
          remote_postings: unique.filter(p => p.remote).length,
          previous_sample_at: comparable ? old?.market?.refreshed_at || null : null,
          demand, stale: false,
          warnings: [
            ...warnings,
            "Sampled posting snippets, not the entire market. Remote mentions do not establish eligibility to work from India.",
            ...(unique.length < 30 ? ["Small sample: fewer than 30 unique postings."] : []),
          ],
        },
      };
      this.profiles.set(key, { template, snapshot });
      this.save();
      this.failures.delete(key);
      return this.withStatus(snapshot);
    } catch (e) {
      const message = e instanceof Error ? e.message : "Job-market refresh failed.";
      console.warn("[JobMarketTrends]", message);
      this.failures.set(key, { until: this.clock() + 60 * 60 * 1000, message });
      if (old) return this.withStatus(old, `Daily refresh failed: ${message}`);
      throw new Error(message);
    }
  }

  async get(targetRole: string, jd = ""): Promise<LinkedInTrends> {
    return this.getProfile(curatedTrends(targetRole, jd));
  }

  private async getProfile(template: LinkedInTrends): Promise<LinkedInTrends> {
    const targetRole = template.target_role;
    const key = this.key(template);
    if (!this.profiles.has(key)) {
      if (this.profiles.size >= 40) throw new Error("Job-market profile limit reached. Contact the administrator.");
      this.profiles.set(key, { template });
      this.save();
    }
    const snapshot = this.profiles.get(key)?.snapshot;
    if (snapshot?.market && this.clock() - Date.parse(snapshot.market.refreshed_at) < DAY) {
      return { ...this.withStatus(snapshot), target_role: targetRole };
    }
    const failure = this.failures.get(key);
    if (failure && failure.until > this.clock()) {
      if (snapshot) return { ...this.withStatus(snapshot, `Daily refresh failed: ${failure.message}`), target_role: targetRole };
      throw new Error(failure.message);
    }
    let pending = this.pending.get(key);
    if (!pending) {
      pending = this.refresh(key, template).finally(() => this.pending.delete(key));
      this.pending.set(key, pending);
    }
    return { ...await pending, target_role: targetRole };
  }

  async refreshKnown(): Promise<void> {
    for (const profile of this.profiles.values()) {
      try {
        await this.getProfile(profile.template);
      } catch (e) {
        console.warn("[JobMarketTrends] Scheduled refresh:", e instanceof Error ? e.message : "failed");
      }
    }
  }
}
