/**
 * Per-role bullet generation for the default split-generation pipeline
 * (POST /api/v2/optimize, hybrid-gemini branch).
 *
 * Each role is rewritten by its own model call using the shared per-role prompt from
 * src/lib/resumePrompt.ts, so the FAANG and STAR standards are the same ones the
 * whole-document path uses, and every role is tailored against the real job
 * description. The output is then checked mechanically (lead verbs, ownership voice,
 * figure provenance, this pipeline's terminology ban, duplicates, bullet count), and a
 * role that fails gets one corrective retry that names the exact problems.
 *
 * The bullet count comes from the Bullet Rules planner (src/lib/bulletBudget.ts) when the
 * caller passes its plan, so the candidate's own rules decide each role's budget; without
 * a plan it falls back to the "bullet_budget" field each structured role carries. The
 * LinkedIn trend brief, when enabled, is scoped to each role's own evidence.
 *
 * Adapted from PR #3 (ba1c542), without its separate budget engine.
 */

import { GoogleGenAI, ThinkingLevel } from "@google/genai";
import { activeBulletRules, describeBudgetRules } from "../src/lib/bulletBudget";
import type { BudgetPlan, BulletBudget, BulletRules } from "../src/lib/bulletBudget";
import { buildTrendBrief, trendEvidenceText } from "../src/lib/linkedinTrends";
import type { LinkedInTrends } from "../src/lib/linkedinTrends";
import { buildRoleBulletPrompt, roleBudgetHint } from "../src/lib/resumePrompt";
import type { RoleBudgetHint, RoleBulletPromptOptions } from "../src/lib/resumePrompt";
import {
  buildFigureIndex,
  findUnsupportedFigures,
  inspectBullet,
  isWeVoice,
  linkStarStories,
} from "../src/lib/impactScore";
import type { FigureIndex } from "../src/lib/impactScore";

const PRIMARY_MODEL = "gemini-3.5-flash";
const FALLBACK_MODEL = "gemini-3.1-flash-lite";
/** Failed or unparseable calls tolerated per role before falling back to the source bullets. */
const MAX_CALL_FAILURES = 3;
/** Interview-prep stories kept for the whole document. */
const MAX_STAR_STORIES = 6;

/** This pipeline's long-standing terminology ban, verified rather than only requested. */
const FORBIDDEN_TERMS: { pattern: RegExp; term: string }[] = [
  { pattern: /\bci\s*\/\s*cd\b/i, term: "CI/CD" },
  { pattern: /\bpipelines?\b/i, term: "Pipelines" },
  { pattern: /\bdevops\b/i, term: "DevOps" },
];

const TERMINOLOGY_RULE = `TERMINOLOGY BAN: the terms "CI/CD", "Pipelines", and "DevOps" are FORBIDDEN. Use
   "Infrastructure Automation", "Workflow Orchestration", or "Release Engineering" instead.`;

export interface RoleOutput {
  bullets: string[];
  star_stories: any[];
}

export interface RoleValidation {
  /** Problems worth a corrective retry. */
  hard: string[];
  /** Problems recorded for the logs and left to the impact audit. */
  soft: string[];
}

export interface RoleGenerationResult {
  id: string;
  role: string;
  company: string;
  duration: string;
  bullets: string[];
  star_stories: any[];
  generation: {
    model_calls: number;
    retried: boolean;
    /** True when every call failed and the source bullets were used instead. */
    fallback: boolean;
    budget: string | null;
    star_quota: number;
    /** Problems remaining in the delivered attempt. */
    issues: string[];
  };
}

export interface GeneratePerRoleOptions {
  /** The target posting, already trimmed by the caller. */
  jobDescription?: string;
  jdKeywords?: string[];
  /** The Bullet Rules planner's budget for every role, in the same order as `experience`. */
  budgetPlan?: BudgetPlan;
  /** The candidate's bullet rules, shown beside each budget. */
  bulletRules?: BulletRules | null;
  /** LinkedIn trend skills to favour where a role's own evidence supports them. */
  trends?: LinkedInTrends | null;
  /** Replaces the Gemini client; lets tests run the whole per-role flow without an API. */
  callModel?: RoleModelCaller;
}

/** What one role's prompt needs beyond the shared options. */
export interface RoleContext {
  /** The planner's budget for this role; it replaces the budget parsed from the role itself. */
  plannedBudget?: BulletBudget | null;
  /** The candidate's bullet rules as prompt lines, for context beside the budget. */
  budgetRules?: string;
  /** LinkedIn trend guidance scoped to this role's evidence. */
  trendBrief?: string;
}

/** Sends one prompt to the model and returns its raw text. Injectable so tests need no API. */
export type RoleModelCaller = (prompt: string) => Promise<string>;

type SharedPromptOptions = Omit<
  RoleBulletPromptOptions,
  "role" | "sourceBullets" | "budget" | "starStoryCount" | "retryFeedback" | "budgetRules" | "trendBrief"
>;

function toText(value: unknown): string {
  if (typeof value === "string") return value.trim();
  if (value && typeof value === "object") {
    const v = value as { text?: unknown; bullet?: unknown };
    if (typeof v.text === "string") return v.text.trim();
    if (typeof v.bullet === "string") return v.bullet.trim();
  }
  return "";
}

function asText(value: unknown): string {
  return typeof value === "string" ? value : value == null ? "" : String(value);
}

/** The role's own evidence, whichever field the upstream extraction used. */
function sourceBulletsOf(role: any): string[] {
  const list = [role?.original_bullets, role?.achievements, role?.bullets].find(
    (candidate) => Array.isArray(candidate) && candidate.length > 0
  );
  return (Array.isArray(list) ? list : []).map(toText).filter(Boolean);
}

function normalizeKey(text: string): string {
  return text.toLowerCase().replace(/[^a-z0-9]+/g, "");
}

function quoteList(items: string[]): string {
  return items.map((item) => `"${item}"`).join(", ");
}

/**
 * The role's bullet budget. The Bullet Rules planner's decision wins, because it is the
 * one that applies the candidate's own rules and the page-fit cap; otherwise the budget
 * written on the role itself is read.
 */
export function budgetHintFor(role: any, planned?: BulletBudget | null): RoleBudgetHint {
  if (!planned) return roleBudgetHint(role);
  return {
    label: planned.label,
    min: planned.min,
    max: planned.max,
    tenureMonths: planned.tenureMonths,
    reason: planned.reason,
  };
}

/** How a budget reads in a correction: its label, or its ceiling when the dates were unreadable. */
function budgetText(budget: RoleBudgetHint): string {
  return budget.label ?? `at most ${budget.max}`;
}

/**
 * STAR stories to draft from one role. Depth follows the bullet budget: recent,
 * long-tenure roles carry two, ordinary roles one, and brief or very old stints none.
 */
export function starQuotaFor(budget: RoleBudgetHint, index: number): number {
  if (budget.min === null || budget.max === null) return index === 0 ? 2 : 1;
  if (budget.max <= 2) return 0;
  // The planner only grants "4-5" or "6-7" to the current or most recent long role;
  // earlier long roles get "3-4".
  if (budget.min >= 4) return 2;
  return 1;
}

/** Parses the model's reply: the {bullets, star_stories} object, or a bare bullet array. */
export function parseRoleOutput(text: string): RoleOutput {
  const cleaned = String(text || "")
    .trim()
    .replace(/^```(?:json)?\s*/i, "")
    .replace(/\s*```$/, "");
  const parsed = JSON.parse(cleaned);
  const rawBullets = Array.isArray(parsed) ? parsed : parsed?.bullets;
  if (!Array.isArray(rawBullets)) throw new Error("response has no bullets array");
  const stories =
    !Array.isArray(parsed) && Array.isArray(parsed?.star_stories)
      ? parsed.star_stories.filter((story: unknown) => story !== null && typeof story === "object")
      : [];
  return { bullets: rawBullets.map(toText).filter(Boolean), star_stories: stories };
}

/**
 * Mechanical checks on one role's output against the rules its prompt states. A count
 * below the budget is only raised when the source holds enough evidence to meet it:
 * asking for more bullets than the source supports would ask for fabrication.
 */
export function validateRoleOutput(
  output: RoleOutput,
  budget: RoleBudgetHint,
  context: { sourceCount: number; figureIndex: FigureIndex | null; storyFigureIndex?: FigureIndex | null }
): RoleValidation {
  const hard: string[] = [];
  const soft: string[] = [];
  const count = output.bullets.length;

  if (budget.min !== null && budget.max !== null && context.sourceCount > 0) {
    const floor = Math.min(budget.min, context.sourceCount);
    if (count < floor) {
      hard.push(
        `Only ${count} bullet${count === 1 ? " was" : "s were"} written. This role's budget is ${budgetText(budget)} and ` +
          `the source lists ${context.sourceCount} items of evidence: write at least ${floor} distinct ` +
          `achievements drawn from it - never invent one.`
      );
    }
  } else if (count === 0 && context.sourceCount > 0) {
    // Unreadable dates leave no floor, but an empty role is never what the candidate sent.
    hard.push(
      `No bullets were written, but the source lists ${context.sourceCount} items of evidence: write this ` +
        `role's strongest distinct achievements from it - never invent one.`
    );
  }
  // The ceiling holds even when the dates were unreadable and the planner set only a maximum.
  if (budget.max !== null && count > budget.max) {
    hard.push(`${count} bullets exceed this role's budget of ${budgetText(budget)}: keep the ${budget.max} strongest.`);
  }

  const seen = new Map<string, number>();
  output.bullets.forEach((bullet, i) => {
    const n = i + 1;
    const inspection = inspectBullet(bullet);
    if (inspection.bannedLead) {
      hard.push(`Bullet ${n} opens with the banned verb "${inspection.lead}".`);
    } else if (!inspection.strongLead) {
      soft.push(`Bullet ${n} does not open with a past-tense action verb ("${inspection.lead}").`);
    }
    if (inspection.passive) {
      hard.push(`Bullet ${n} uses "${inspection.passive}" - state exactly what this person did.`);
    } else if (inspection.firstPerson) {
      hard.push(`Bullet ${n} uses "I" or "my" - write in implied first person, verb first.`);
    }
    const unsupported = context.figureIndex ? findUnsupportedFigures(bullet, context.figureIndex) : [];
    if (unsupported.length > 0) {
      hard.push(
        `Bullet ${n} states ${quoteList(unsupported)}, which the source never states - use the ` +
          `source's exact figure or remove it.`
      );
    }
    const forbidden = FORBIDDEN_TERMS.find((entry) => entry.pattern.test(bullet));
    if (forbidden) hard.push(`Bullet ${n} uses the forbidden term "${forbidden.term}".`);

    const key = normalizeKey(bullet);
    const first = seen.get(key);
    if (first !== undefined) hard.push(`Bullet ${n} repeats bullet ${first}.`);
    else seen.set(key, n);
  });

  output.star_stories.forEach((story, j) => {
    const n = j + 1;
    if (isWeVoice(asText(story?.action))) {
      hard.push(`STAR story ${n}'s action is told as "we" - rewrite it in first person singular.`);
    }
    // The same fields the client audit traces. "learning" looks forward ("next time I'd
    // pilot it for 2 weeks"), so its numbers are not claims about the past.
    const narrative = ["situation", "task", "action", "result"]
      .map((field) => asText(story?.[field]))
      .join("\n");
    const storyIndex = context.storyFigureIndex ?? context.figureIndex;
    const unsupported = storyIndex ? findUnsupportedFigures(narrative, storyIndex) : [];
    if (unsupported.length > 0) {
      hard.push(
        `STAR story ${n} states ${quoteList(unsupported)}, which the source never states - list the ` +
          `missing detail in prep_gaps instead.`
      );
    }
  });

  return { hard, soft };
}

/** Keeps only the stories that quote one of this role's bullets, as the final audit will. */
function linkRoleStories(output: RoleOutput, role: any): number {
  const mini = {
    experience: [{ role: asText(role?.role), company: asText(role?.company), bullets: output.bullets }],
    star_stories: output.star_stories,
  };
  const { dropped } = linkStarStories(mini);
  output.star_stories = mini.star_stories;
  return dropped;
}

function geminiCaller(genAI: GoogleGenAI): RoleModelCaller {
  return async (prompt: string) => {
    const contents = [{ role: "user", parts: [{ text: prompt }] }];
    try {
      const res = await genAI.models.generateContent({
        model: PRIMARY_MODEL,
        contents,
        config: {
          responseMimeType: "application/json",
          // Low thinking keeps per-role calls cheap; the validator and retry carry the quality bar.
          thinkingConfig: { thinkingLevel: ThinkingLevel.LOW },
        },
      });
      return res.text || "";
    } catch (e: any) {
      console.warn(`[RoleGen] ${PRIMARY_MODEL} failed (${e?.message || e}), trying ${FALLBACK_MODEL}...`);
      const res = await genAI.models.generateContent({
        model: FALLBACK_MODEL,
        contents,
        config: { responseMimeType: "application/json" },
      });
      return res.text || "";
    }
  };
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Writes one role: generate, validate, retry once with the exact problems, keep the cleaner attempt. */
export async function generateRole(
  callModel: RoleModelCaller,
  role: any,
  index: number,
  shared: SharedPromptOptions,
  context: RoleContext = {},
  retryDelayMs = 1000
): Promise<RoleGenerationResult> {
  const id = typeof role?.id === "string" && role.id ? role.id : `role_${index + 1}`;
  const identity = {
    id,
    role: asText(role?.role || role?.title),
    company: asText(role?.company),
    duration: asText(role?.duration),
  };
  const label = `${id} (${[identity.role, identity.company].filter(Boolean).join(" @ ") || "untitled"})`;
  const budget = budgetHintFor(role, context.plannedBudget);
  const starQuota = starQuotaFor(budget, index);
  const sourceBullets = sourceBulletsOf(role);

  let figureIndex: FigureIndex | null = null;
  let storyFigureIndex: FigureIndex | null = null;
  try {
    // The custom prompt and audience brief steer emphasis; they are never evidence, so a
    // figure that appears only there is still unverified.
    const evidenceText = [sourceBullets.join("\n"), identity.role, identity.company, identity.duration, shared.brainDump]
      .filter(Boolean)
      .join("\n");
    figureIndex = buildFigureIndex(evidenceText);
    // The prompt shows the tenure in months, so a story may repeat it.
    storyFigureIndex = buildFigureIndex(
      budget.tenureMonths !== null ? `${evidenceText}\n${budget.tenureMonths} months` : evidenceText,
      { tenure: true }
    );
  } catch (e: any) {
    // Provenance checks are skipped rather than failing the role.
    console.warn(`[RoleGen] ${label}: figure provenance unavailable:`, e?.message || e);
  }

  let best: { output: RoleOutput; validation: RoleValidation } | null = null;
  let retryFeedback: RoleBulletPromptOptions["retryFeedback"];
  let modelCalls = 0;
  let failures = 0;
  let retried = false;

  while (failures < MAX_CALL_FAILURES) {
    const prompt = buildRoleBulletPrompt({
      ...shared,
      role: identity,
      sourceBullets,
      budget,
      budgetRules: context.budgetRules,
      trendBrief: context.trendBrief,
      starStoryCount: starQuota,
      retryFeedback,
    });

    let output: RoleOutput;
    try {
      modelCalls += 1;
      output = parseRoleOutput(await callModel(prompt));
    } catch (err: any) {
      failures += 1;
      console.warn(`[RoleGen] ${label}: call failed (${failures}/${MAX_CALL_FAILURES}):`, err?.message || err);
      // A failed corrective retry keeps the attempt already in hand.
      if (best) break;
      if (failures < MAX_CALL_FAILURES) await sleep(retryDelayMs * failures);
      continue;
    }

    const droppedStories = linkRoleStories(output, identity);
    const validation = validateRoleOutput(output, budget, {
      sourceCount: sourceBullets.length,
      figureIndex,
      storyFigureIndex,
    });
    if (droppedStories > 0) {
      validation.soft.push(
        `${droppedStories} STAR ${droppedStories === 1 ? "story" : "stories"} did not quote a bullet verbatim and ${
          droppedStories === 1 ? "was" : "were"
        } discarded.`
      );
    }

    // A retry replaces the first attempt only when it is strictly cleaner.
    if (!best || validation.hard.length < best.validation.hard.length) best = { output, validation };
    if (validation.hard.length === 0 || retried) break;

    retried = true;
    retryFeedback = { issues: validation.hard, previousBullets: output.bullets };
    console.log(`[RoleGen] ${label}: ${validation.hard.length} issue(s), retrying with corrections.`);
  }

  // An empty role is never delivered while the source has evidence for it.
  const emptyDelivery = best !== null && best.output.bullets.length === 0 && sourceBullets.length > 0;
  if (!best || emptyDelivery) {
    const kept = budget.max !== null ? sourceBullets.slice(0, budget.max) : sourceBullets;
    const why = emptyDelivery ? "the model returned no bullets" : "all calls failed";
    console.warn(`[RoleGen] ${label}: ${why}; using ${kept.length} source bullet(s).`);
    return {
      ...identity,
      bullets: kept,
      star_stories: [],
      generation: {
        model_calls: modelCalls,
        retried,
        fallback: true,
        budget: budget.label,
        star_quota: starQuota,
        issues: [emptyDelivery ? "no bullets were written; the source bullets were used" : "generation failed; the source bullets were used"],
      },
    };
  }

  const issues = [...best.validation.hard, ...best.validation.soft];
  console.log(
    `[RoleGen] ${label}: ${best.output.bullets.length} bullet(s) for budget ${budget.label ?? "unset"}, ` +
      `${best.output.star_stories.length} STAR, ${modelCalls} call(s)` +
      (issues.length > 0 ? `; remaining: ${issues.join(" | ")}` : "")
  );
  return {
    ...identity,
    bullets: best.output.bullets,
    star_stories: best.output.star_stories,
    generation: {
      model_calls: modelCalls,
      retried,
      fallback: false,
      budget: budget.label,
      star_quota: starQuota,
      issues,
    },
  };
}

export async function generatePerRole(
  experience: any[],
  geminiKey: string,
  targetCompany?: string,
  targetRole?: string,
  audience?: string,
  mode?: string,
  customPrompt?: string,
  brainDump?: string,
  options: GeneratePerRoleOptions = {}
): Promise<RoleGenerationResult[]> {
  const roles = Array.isArray(experience) ? experience : [];
  const callModel = options.callModel ?? geminiCaller(new GoogleGenAI({ apiKey: geminiKey }));
  const shared: SharedPromptOptions = {
    targetRole,
    targetCompany,
    audience,
    mode,
    customPrompt,
    brainDump,
    jobDescription: options.jobDescription,
    jdKeywords: options.jdKeywords,
    extraRules: [TERMINOLOGY_RULE],
    currentDate: new Date().toLocaleDateString("en-US", { year: "numeric", month: "long", day: "numeric" }),
  };

  const rules = activeBulletRules(options.bulletRules);
  const budgetRules = rules
    ? describeBudgetRules("   ", { rules, platform: options.budgetPlan?.platform })
    : undefined;

  return Promise.all(
    roles.map((role, index) => {
      let trendBrief: string | undefined;
      if (options.trends) {
        try {
          trendBrief =
            buildTrendBrief(options.trends, {
              scope: "role",
              evidenceText: trendEvidenceText(role, brainDump),
            }) || undefined;
        } catch (e: any) {
          // Trend guidance is optional: a failure here must not stop the role being written.
          console.warn(`[RoleGen] role ${index + 1}: LinkedIn trend brief unavailable:`, e?.message || e);
        }
      }
      return generateRole(callModel, role, index, shared, {
        plannedBudget: options.budgetPlan?.budgets[index] ?? null,
        budgetRules,
        trendBrief,
      });
    })
  );
}

function competencyKey(story: any): string {
  return asText(story?.competency).toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
}

/**
 * Chooses the document's interview-prep stories from the per-role drafts: the recent
 * roles first, then one story per role per pass in document order, with distinct
 * competencies preferred because each interviewer in a loop is assigned different ones.
 */
export function selectStarStories(
  roleResults: Array<{ star_stories?: any[]; generation?: { star_quota?: number } }>,
  limit = MAX_STAR_STORIES
): any[] {
  const results = Array.isArray(roleResults) ? roleResults : [];
  const isRecent = (r: { generation?: { star_quota?: number } }) => (r?.generation?.star_quota ?? 0) >= 2;
  const ordered = [...results.filter(isRecent), ...results.filter((r) => !isRecent(r))];
  const queues = ordered.map((r) => (Array.isArray(r?.star_stories) ? r.star_stories.filter(Boolean) : []));

  const picked: any[] = [];
  const deferred: any[] = [];
  const competencies = new Set<string>();

  for (let pass = 0; picked.length < limit; pass++) {
    let found = false;
    for (const queue of queues) {
      if (picked.length >= limit) break;
      const story = queue[pass];
      if (!story) continue;
      found = true;
      const key = competencyKey(story);
      if (key && competencies.has(key)) {
        deferred.push(story);
        continue;
      }
      if (key) competencies.add(key);
      picked.push(story);
    }
    if (!found) break;
  }
  for (const story of deferred) {
    if (picked.length >= limit) break;
    picked.push(story);
  }
  return picked;
}
