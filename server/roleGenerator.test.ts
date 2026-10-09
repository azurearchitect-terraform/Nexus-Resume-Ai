import { test } from "node:test";
import assert from "node:assert/strict";
import {
  budgetHintFor, generatePerRole, generateRole, parseRoleOutput, selectStarStories, starQuotaFor, validateRoleOutput,
} from "./roleGenerator";
import { deduplicateAndScore } from "./dedup";
import { roleBudgetHint } from "../src/lib/resumePrompt";
import {
  applyImpactAudit, buildFigureIndex, computeImpactScore, resumeForAudit,
} from "../src/lib/impactScore";
import { defaultBulletRules, enforceBulletBudgets, planBulletBudgets } from "../src/lib/bulletBudget";
import { activeLinkedInTrends } from "../src/lib/linkedinTrends";

const NOW = new Date(2026, 9, 8);

const role = {
  id: "role_1",
  role: "Cloud Engineer",
  company: "Fabrikam",
  duration: "Jan 2021 - Present",
  tenure_months: 30,
  bullet_budget: "2-3",
  original_bullets: ["Built Terraform modules for 3 regions", "Cut deploys from 40 to 12 minutes", "Ran on-call"],
};
const shared = { targetRole: "Senior Cloud Engineer", targetCompany: "amazon", jobDescription: "JD", extraRules: [] as string[] };
const figureIndex = buildFigureIndex("Built Terraform modules for 3 regions. Cut deploys from 40 to 12 minutes.");

const reply = (bullets: string[], star_stories: unknown[] = []) => JSON.stringify({ bullets, star_stories });

test("STAR quota follows the bullet budget", () => {
  const quota = (budget: unknown, index = 0) => starQuotaFor(roleBudgetHint({ bullet_budget: budget }), index);
  assert.equal(quota("6-7"), 2);
  assert.equal(quota("4-5", 1), 2);
  assert.equal(quota("3-4", 1), 1);
  assert.equal(quota("2-3", 2), 1);
  assert.equal(quota("1-2"), 0);
  assert.equal(starQuotaFor(roleBudgetHint({}), 0), 2);
  assert.equal(starQuotaFor(roleBudgetHint({}), 3), 1);
});

test("model replies parse from fenced objects, bare arrays and text-object bullets", () => {
  const parsed = parseRoleOutput('```json\n{"bullets":["A b c", {"text":"D e f"}],"star_stories":[{"bullet":"A b c"}, null, 5]}\n```');
  assert.equal(parsed.bullets.length, 2);
  assert.equal(parsed.bullets[1], "D e f");
  assert.equal(parsed.star_stories.length, 1);
  assert.equal(parseRoleOutput('["x y z"]').bullets[0], "x y z");
  assert.throws(() => parseRoleOutput('{"items": []}'));
});

test("validation names every hard problem and keeps weak leads soft", () => {
  const v = validateRoleOutput(
    {
      bullets: [
        "Spearheaded the Terraform rollout across 3 regions",
        "Responsible for on-call",
        "I automated patching with Azure Update Manager",
        "Cut deploys from 40 to 9 minutes by caching providers",
        "Rebuilt the DevOps release flow",
        "Cut deploys from 40 to 9 minutes by caching providers",
        "Managing the cost dashboards",
      ],
      star_stories: [{ bullet: "x", action: "We designed it and we shipped it together.", result: "Saved 25 hours" }],
    },
    roleBudgetHint({ bullet_budget: "3-4" }),
    { sourceCount: 6, figureIndex }
  );
  const hard = v.hard.join(" | ");
  assert.ok(hard.includes('banned verb "spearheaded"'), hard);
  assert.ok(hard.includes('"responsible for"'), hard);
  assert.ok(hard.includes('"I" or "my"'), hard);
  assert.ok(hard.includes('"9"'), hard);
  assert.ok(hard.includes('forbidden term "DevOps"'), hard);
  assert.ok(hard.includes("repeats bullet 4"), hard);
  assert.ok(hard.includes("exceed this role's budget of 3-4"), hard);
  assert.ok(hard.includes('told as "we"'), hard);
  assert.ok(hard.includes('STAR story 1 states "25"') && hard.includes("prep_gaps"), hard);
  assert.ok(v.soft.some((s) => s.includes('"managing"')) && !hard.includes("managing"));
});

test("the bullet floor is capped by how much evidence the source holds", () => {
  const budget = roleBudgetHint({ bullet_budget: "3-4" });
  const bullets = ["Built Terraform modules for 3 regions"];
  const under = validateRoleOutput({ bullets, star_stories: [] }, budget, { sourceCount: 2, figureIndex });
  assert.ok(under.hard.some((h) => h.includes("at least 2 distinct")), under.hard.join(" | "));
  const enough = validateRoleOutput({ bullets, star_stories: [] }, budget, { sourceCount: 1, figureIndex });
  assert.deepEqual(enough.hard, []);
});

test("numbered STAR steps are not figures", () => {
  const v = validateRoleOutput(
    {
      bullets: ["Built Terraform modules for 3 regions"],
      star_stories: [{
        bullet: "Built Terraform modules for 3 regions",
        action: "1. I inventoried the hand-built networks. 2. I grouped them by region. 3. I ran terraform import for each.",
        result: "The 3 regions were managed as code.",
      }],
    },
    roleBudgetHint({}),
    { sourceCount: 1, figureIndex }
  );
  assert.deepEqual(v.hard, []);
});

test("a role that fails its checks is retried once with the exact corrections", async () => {
  const prompts: string[] = [];
  const replies = [
    reply(["Spearheaded Terraform modules for 3 regions", "Cut deploys from 40 to 9 minutes", "We ran on-call"]),
    reply(
      [
        "Built Terraform modules covering 3 regions, replacing hand-built networks",
        "Cut deploys from 40 to 12 minutes by caching provider plugins",
      ],
      [
        {
          bullet: "Cut deploys from 40 to 12 minutes by caching provider plugins",
          competency: "Deliver Results",
          question: "Tell me about a time you sped something up.",
          situation: "Deploys were slow.",
          task: "I owned the deploy tooling.",
          action: "I profiled the deploy, found provider downloads dominated, and added a plugin cache.",
          result: "Deploys went from 40 to 12 minutes.",
          learning: "Measure before optimizing.",
        },
        { bullet: "Something the resume never says", action: "I did it.", result: "It worked." },
      ]
    ),
  ];
  const result = await generateRole(async (prompt) => {
    prompts.push(prompt);
    return replies[prompts.length - 1] ?? replies[replies.length - 1];
  }, role, 0, shared, {}, 0);

  assert.ok(result.generation.retried);
  assert.equal(result.generation.model_calls, 2);
  assert.ok(prompts[1].includes("CORRECTIONS REQUIRED") && prompts[1].includes('banned verb "spearheaded"') && prompts[1].includes('"9"'));
  assert.equal(result.bullets.length, 2);
  assert.ok(result.bullets[1].includes("40 to 12"));
  assert.equal(result.star_stories.length, 1, "the invented story is dropped");
  assert.equal(result.star_stories[0].role, "Cloud Engineer");
  assert.equal(result.star_stories[0].company, "Fabrikam");
  assert.equal(result.generation.star_quota, 1);
});

test("there is at most one corrective retry, and the cleaner attempt wins", async () => {
  let calls = 0;
  const result = await generateRole(async () => {
    calls++;
    return calls === 1
      ? reply(["We built it", "Spearheaded stuff", "Responsible for things"])
      : reply(["Built Terraform modules for 3 regions", "Spearheaded the cache"]);
  }, role, 0, shared, {}, 0);
  assert.equal(calls, 2);
  assert.equal(result.bullets[0], "Built Terraform modules for 3 regions");
});

test("when every call fails the source bullets are used within budget", async () => {
  const failed = await generateRole(async () => { throw new Error("quota"); }, role, 0, shared, {}, 0);
  assert.ok(failed.generation.fallback);
  assert.equal(failed.bullets.length, 3);
  assert.equal(failed.generation.model_calls, 3);
  const garbage = await generateRole(async () => "not json at all", { ...role, bullet_budget: "1-2" }, 0, shared, {}, 0);
  assert.ok(garbage.generation.fallback);
  assert.equal(garbage.bullets.length, 2);
});

test("tenure stated in the prompt and forward-looking learnings cause no paid retry", async () => {
  let calls = 0;
  const result = await generateRole(async () => {
    calls++;
    return reply(
      [
        "Built Terraform modules covering 3 regions, replacing hand-built networks",
        "Cut deploys from 40 to 12 minutes by caching provider plugins",
      ],
      [{
        bullet: "Cut deploys from 40 to 12 minutes by caching provider plugins",
        action: "Over my 40 months at Fabrikam I profiled the deploy, found provider downloads dominated, and added a plugin cache.",
        result: "Deploys went from 40 to 12 minutes.",
        learning: "Next time I'd run a 2-week pilot before rolling it out.",
      }]
    );
  }, { ...role, tenure_months: 40 }, 0, shared, {}, 0);
  assert.equal(calls, 1);
  assert.ok(!result.generation.retried);
  assert.equal(result.star_stories.length, 1);
});

test("story selection favours recent roles and distinct competencies within the limit", () => {
  const story = (name: string, competency: string) => ({ bullet: `${name}-${competency}`, competency, action: "I did a thing carefully.", result: "It changed." });
  const picked = selectStarStories([
    { star_stories: [story("old", "Ownership")], generation: { star_quota: 1 } },
    { star_stories: [story("recent", "Ownership"), story("recent", "Dive Deep")], generation: { star_quota: 2 } },
    { star_stories: [story("mid", "Deliver Results"), story("mid", "Earn Trust")], generation: { star_quota: 1 } },
  ], 4);
  assert.equal(picked.length, 4);
  assert.equal(picked[0].bullet, "recent-Ownership");
  const firstThree = picked.slice(0, 3).map((s) => s.competency);
  assert.equal(new Set(firstThree).size, 3);
});

test("server assembly keeps stories out of experience and the client audit links them", async () => {
  const good = await generateRole(async () => reply(
    [
      "Built Terraform modules covering 3 regions, replacing hand-built networks",
      "Cut deploys from 40 to 12 minutes by caching provider plugins",
    ],
    [{
      bullet: "Cut deploys from 40 to 12 minutes by caching provider plugins",
      competency: "Deliver Results",
      situation: "Deploys were slow.",
      task: "I owned the deploy tooling.",
      action: "I profiled the deploy, found provider downloads dominated, and added a plugin cache.",
      result: "Deploys went from 40 to 12 minutes.",
    }]
  ), role, 0, shared, {}, 0);
  const failed = await generateRole(async () => { throw new Error("quota"); }, { ...role, id: "role_2", role: "Systems Engineer", company: "Northwind" }, 1, shared, {}, 0);
  const roleResults = [good, failed];

  const experience = deduplicateAndScore(roleResults.map(({ star_stories, generation, ...r }: any) => r));
  assert.ok(experience.every((r: any) => !("star_stories" in r) && !("generation" in r)));

  const finalResult: any = JSON.parse(JSON.stringify({ summary: "x", experience, star_stories: selectStarStories(roleResults) }));
  const sourceText = JSON.stringify({ experience: [role] });
  applyImpactAudit(finalResult, { sourceText });
  assert.equal(typeof finalResult.impact_audit?.score, "number");
  assert.equal(finalResult.star_stories.length, 1);
  assert.equal(finalResult.impact_audit.star_linked, 1);
  assert.equal(finalResult.impact_audit.unverified_figure_bullets, 0);
  const baseline = computeImpactScore(resumeForAudit(sourceText), { expectStarStories: false });
  assert.equal(typeof baseline?.score, "number");
});

test("the planner's budget replaces the budget written on the role", () => {
  const planned = planBulletBudgets([{ ...role, bullet_budget: undefined }], { now: NOW }).budgets[0];
  const hint = budgetHintFor({ ...role, bullet_budget: "1" }, planned);
  assert.equal(hint.label, planned.label);
  assert.equal(hint.max, planned.max);
  assert.equal(hint.reason, planned.reason);
  assert.equal(budgetHintFor({ ...role, bullet_budget: "1" }).max, 1, "no plan: the role's own budget is read");
});

test("a planned budget drives the prompt, the quota and the ceiling", async () => {
  const planned = planBulletBudgets([role], { now: NOW }).budgets[0];
  assert.equal(planned.label, "6-7");
  const prompts: string[] = [];
  const result = await generateRole(async (prompt) => {
    prompts.push(prompt);
    return reply(["Built Terraform modules for 3 regions", "Cut deploys from 40 to 12 minutes", "Ran the on-call rotation"]);
  }, { ...role, bullet_budget: "1" }, 0, shared, { plannedBudget: planned }, 0);
  assert.ok(prompts[0].includes("HARD LIMIT: 6 to 7 bullets"));
  assert.ok(prompts[0].includes(`Set by the bullet planner: ${planned.reason}.`));
  assert.equal(result.generation.budget, "6-7");
  assert.equal(result.generation.star_quota, 2);
});

test("a ceiling-only budget (unreadable dates) still rejects an over-long role", async () => {
  const undated = { ...role, duration: "Freelance", bullet_budget: undefined, tenure_months: undefined };
  const planned = planBulletBudgets([undated], { now: NOW }).budgets[0];
  assert.equal(planned.min, null);
  assert.equal(planned.label, null);
  const many = Array.from({ length: planned.max + 1 }, (_, i) => `Built Terraform module number ${i + 1} for the network`);
  const prompts: string[] = [];
  const result = await generateRole(async (prompt) => {
    prompts.push(prompt);
    return prompts.length === 1 ? reply(many) : reply(many.slice(0, 3));
  }, undated, 0, shared, { plannedBudget: planned }, 0);
  assert.ok(prompts[0].includes(`proportionate to the evidence, never more than ${planned.max}`));
  assert.ok(prompts[1].includes(`bullets exceed this role's budget of at most ${planned.max}`));
  assert.equal(result.bullets.length, 3);
});

test("an empty reply is retried, and an empty role is never delivered while the source has evidence", async () => {
  const undated = { ...role, duration: "Freelance", bullet_budget: undefined, tenure_months: undefined };
  const planned = planBulletBudgets([undated], { now: NOW }).budgets[0];
  assert.equal(planned.min, null, "no floor to catch it");

  let calls = 0;
  const recovered = await generateRole(async () => {
    calls++;
    return calls === 1 ? reply([]) : reply(["Built Terraform modules for 3 regions", "Cut deploys from 40 to 12 minutes"]);
  }, undated, 0, shared, { plannedBudget: planned }, 0);
  assert.equal(calls, 2, "the empty reply is a hard issue that earns one corrective retry");
  assert.equal(recovered.bullets.length, 2);
  assert.ok(!recovered.generation.fallback);

  const stubborn = await generateRole(async () => reply([]), undated, 0, shared, { plannedBudget: planned }, 0);
  assert.ok(stubborn.generation.fallback, "still empty after the retry: the source bullets are used");
  assert.equal(stubborn.bullets.length, undated.original_bullets.length);
  assert.ok(stubborn.generation.issues.some((issue) => issue.includes("no bullets were written")));

  const bare = await generateRole(async () => reply([]), { ...undated, original_bullets: [] }, 0, shared, { plannedBudget: planned }, 0);
  assert.equal(bare.bullets.length, 0, "a role with no evidence at all stays empty rather than inventing bullets");
  assert.ok(!bare.generation.fallback);
});

test("custom instructions and the audience brief are not evidence; the brain dump is", async () => {
  const claim = reply(["Kept production uptime at 99% across the estate", "Built Terraform modules for 3 regions"]);
  const withPrompt = await generateRole(
    async () => claim, role, 0, { ...shared, customPrompt: "AUDIENCE BRIEF: stress the 99% uptime" }, {}, 0
  );
  assert.ok(withPrompt.generation.retried, "a figure that only the custom prompt states is unverified");
  assert.ok(withPrompt.generation.issues.some((issue) => issue.includes('"99%"')));

  let calls = 0;
  const withBrainDump = await generateRole(
    async () => { calls++; return claim; }, role, 0, { ...shared, brainDump: "We held 99% uptime all year" }, {}, 0
  );
  assert.equal(calls, 1);
  assert.ok(!withBrainDump.generation.retried);
});

test("generatePerRole hands every role its planned budget, the rules, the trends and the posting", async () => {
  const roles = [
    { id: "role_1", role: "Cloud Engineer", company: "Fabrikam", duration: "Jan 2021 - Present", original_bullets: ["Built Terraform modules for 3 regions", "Cut deploys from 40 to 12 minutes", "Ran the on-call rotation"] },
    { id: "role_2", role: "Systems Engineer", company: "Northwind", duration: "Mar 2018 - Dec 2020", original_bullets: ["Managed Active Directory for 3000 users", "Automated onboarding with PowerShell", "Replaced backups with Veeam jobs"] },
  ];
  const rules = defaultBulletRules();
  const budgetPlan = planBulletBudgets(roles, { rules, jobDescription: "Azure Terraform", now: NOW });
  const trends = activeLinkedInTrends(true, "Cloud Engineer", "Azure Terraform Kubernetes");
  assert.ok(trends, "curated trends exist for a cloud engineer");

  const bulletsByCompany: Record<string, string[]> = {
    Fabrikam: ["Built Terraform modules covering 3 regions", "Cut deploys from 40 to 12 minutes by caching provider plugins", "Ran the production on-call rotation"],
    Northwind: ["Managed Active Directory for 3000 users", "Automated user onboarding with PowerShell", "Replaced ad-hoc backups with Veeam jobs"],
  };
  const prompts: Record<string, string> = {};
  const results = await generatePerRole(roles, "unused", "amazon", "Cloud Engineer", "Recruiters", "balanced", "AUDIENCE BRIEF: x", undefined, {
    budgetPlan, bulletRules: rules, trends, jobDescription: "POSTING BODY", jdKeywords: ["Terraform"],
    callModel: async (prompt) => {
      const company = Object.keys(bulletsByCompany).find((name) => prompt.includes(`Company: ${name}`))!;
      prompts[company] = prompt;
      return reply(bulletsByCompany[company]);
    },
  });

  assert.equal(results.length, 2);
  assert.deepEqual(results.map((r) => r.id), ["role_1", "role_2"]);
  for (const prompt of Object.values(prompts)) {
    assert.ok(prompt.includes("POSTING BODY") && prompt.includes("Priority JD keywords: Terraform"));
    assert.ok(prompt.includes("THE CANDIDATE'S BULLET RULES"));
    assert.ok(prompt.includes("LINKEDIN TRENDING SKILLS"));
    assert.ok(prompt.includes("Set by the bullet planner: ") && prompt.includes("bullet rule - one of the 2 most recent roles"));
    assert.ok(prompt.includes("TERMINOLOGY BAN"));
  }
  assert.equal(results[0].generation.budget, budgetPlan.budgets[0].label);
  assert.equal(results[1].generation.budget, budgetPlan.budgets[1].label);
});

test("generatePerRole without a plan, rules or trends still reads each role's own budget", async () => {
  const prompts: string[] = [];
  const results = await generatePerRole([role], "unused", undefined, "Cloud Engineer", undefined, undefined, undefined, undefined, {
    callModel: async (prompt) => {
      prompts.push(prompt);
      return reply(["Built Terraform modules for 3 regions", "Cut deploys from 40 to 12 minutes"]);
    },
  });
  assert.equal(results.length, 1);
  assert.ok(prompts[0].includes("HARD LIMIT: 2 to 3 bullets"));
  assert.ok(!prompts[0].includes("THE CANDIDATE'S BULLET RULES") && !prompts[0].includes("LINKEDIN TRENDING SKILLS"));
});

test("the Bullet Rules trimmer keeps the bullet that backs a STAR story", () => {
  const bullets = [
    "Built the landing zone modules for hub networking",
    "Built the policy baseline for subscription governance",
    "Built the monitoring workbooks for platform health",
    "Built the patch orchestration for server maintenance",
  ];
  const resume: any = {
    experience: [{ role: "Cloud Engineer", company: "Fabrikam", duration: "Jan 2025 - Jun 2025", bullets }],
    star_stories: [{ bullet: bullets[3], action: "I built it.", result: "It worked." }],
  };
  enforceBulletBudgets(resume, { rules: null, now: NOW, sourceText: bullets.join("\n") });
  assert.equal(resume.experience[0].bullets.length, 2, "a 6-month role is capped at 2 bullets");
  assert.ok(resume.experience[0].bullets.includes(bullets[3]), "the story's bullet survives the trim");
});
