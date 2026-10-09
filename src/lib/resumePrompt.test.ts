import { test } from "node:test";
import assert from "node:assert/strict";
import {
  buildResumeGenerationPrompt, buildRoleBulletPrompt, companyKey, resolvePromptCompany, roleBudgetHint,
  starFrameworkFor,
} from "./resumePrompt";
import { defaultBulletRules, describeBudgetRules, planBulletBudgets } from "./bulletBudget";

const roleBase = {
  role: { role: "Cloud Engineer", company: "Fabrikam", duration: "Jan 2021 - Present" },
  sourceBullets: ["Built Terraform modules", "Ran the on-call rotation"],
  targetRole: "Senior Cloud Engineer",
  targetCompany: "amazon",
  jobDescription: "POSTING BODY",
  jdKeywords: ["Terraform", "AKS"],
  extraRules: ["TERMINOLOGY BAN: test"],
};

test("the hiring company stands in when the picker says Generic Tech", () => {
  assert.equal(resolvePromptCompany("none", "Contoso"), "Contoso");
  assert.equal(resolvePromptCompany("amazon", "Contoso"), "amazon");
  assert.equal(resolvePromptCompany("none", "  "), undefined);
  assert.equal(resolvePromptCompany(undefined, undefined), undefined);
});

test("a typed hiring company the platform knows beats a picker filled in from the posting's tech words", () => {
  // The picker auto-selects "amazon" from "AWS" in a posting, whoever is hiring.
  assert.equal(resolvePromptCompany("amazon", "Microsoft"), "Microsoft");
  assert.equal(resolvePromptCompany("microsoft", "Amazon Web Services"), "Amazon Web Services");
  assert.equal(starFrameworkFor(resolvePromptCompany("amazon", "Google LLC")).name, "Google's hiring attributes");
  // An employer the platform has no framework for leaves the picker in charge.
  assert.equal(resolvePromptCompany("microsoft", "Fabrikam"), "microsoft");
});

test("company keys resolve subsidiaries but never prototype keys or look-alikes", () => {
  assert.equal(companyKey("Amazon Web Services"), "amazon");
  assert.equal(companyKey("AWS"), "amazon");
  assert.equal(companyKey("Azure Power Global"), null);
  assert.equal(companyKey("Constructor"), null);
  assert.equal(companyKey("toString"), null);
});

test("each company gets its own competency model, with a general fallback", () => {
  assert.ok(starFrameworkFor("amazon").competencies.includes("Dive Deep"));
  assert.ok(starFrameworkFor("Netflix").name.includes("Netflix"));
  assert.ok(starFrameworkFor("Contoso").competencies.includes("Ownership"));
});

test("whole-document prompt carries the FAANG and STAR standards", () => {
  const prompt = buildResumeGenerationPrompt({
    targetRole: "Cloud Engineer", audience: "Recruiters", mode: "balanced", inputData: "{}",
    targetCompany: "none", jobDescription: "JD TEXT HERE",
  });
  assert.ok(!/TARGET COMPANY: none/.test(prompt));
  assert.ok(prompt.includes("TARGET COMPANY: General Product Tech"));
  assert.ok(prompt.includes("PHASE 1.5 - STAR GROUNDING"));
  assert.ok(prompt.includes("STAR is the reasoning scaffold, NOT a bullet template"));
  assert.ok(prompt.includes("FAANG BULLET STANDARD"));
  assert.ok(prompt.includes("Include\n      Y ONLY when the source states the measure"));
  assert.ok(prompt.includes("checked mechanically against the candidate's own material"));
  assert.ok(prompt.includes("copied VERBATIM from a bullet in experience"));
  assert.ok(prompt.includes("AUDIT SCORE RUBRIC"));
  assert.ok(prompt.includes("Helmed") && prompt.includes("Spearheaded"));
  assert.ok(prompt.includes("JD TEXT HERE"));
});

test("whole-document prompt never anchors the model to a score", () => {
  const prompt = buildResumeGenerationPrompt({
    targetRole: "SDE", audience: "x", mode: "balanced", inputData: "{}",
  });
  assert.ok(!/"score": 85|"match_score"|"baseline_score"/.test(prompt));
});

test("whole-document rules stay numbered 1-13 with no gaps", () => {
  const prompt = buildResumeGenerationPrompt({
    targetRole: "SDE", audience: "x", mode: "balanced", inputData: "{}",
  });
  for (let n = 1; n <= 13; n++) assert.ok(prompt.includes(`\n${n}. `), `rule ${n} missing`);
});

test("Amazon's Leadership Principles frame the stories for an Amazon target", () => {
  const prompt = buildResumeGenerationPrompt({
    targetRole: "SDE", audience: "x", mode: "balanced", inputData: "{}", targetCompany: "amazon",
  });
  assert.ok(prompt.includes("Amazon's Leadership Principles"));
  assert.ok(prompt.includes("Have Backbone; Disagree and Commit"));
});

test("custom instructions and the audience brief are labelled as emphasis, never evidence", () => {
  const doc = buildResumeGenerationPrompt({
    targetRole: "SDE", audience: "x", mode: "balanced", inputData: "{}", customPrompt: "AUDIENCE BRIEF: reader",
  });
  const role = buildRoleBulletPrompt({ ...roleBase, budget: roleBudgetHint({}), customPrompt: "AUDIENCE BRIEF: reader" });
  assert.ok(doc.includes("(emphasis only, never evidence): AUDIENCE BRIEF: reader"));
  assert.ok(role.includes("(emphasis only, never evidence): AUDIENCE BRIEF: reader"));
});

test("the whole-document prompt keeps Bullet Rules, trend guidance and the FAANG/STAR standard together", () => {
  const roles = [
    { role: "Engineer", company: "Fabrikam", duration: "Jan 2023 - Present", bullets: ["Built Azure landing zones"] },
    { role: "Analyst", company: "Northwind", duration: "Jan 2015 - Dec 2016", bullets: ["Wrote reports"] },
  ];
  const rules = defaultBulletRules();
  const plan = planBulletBudgets(roles, { rules, now: new Date(2026, 9, 8) });
  const prompt = buildResumeGenerationPrompt({
    targetRole: "Cloud Engineer", audience: "Recruiters", mode: "balanced", inputData: "{}",
    bulletBudgets: plan.budgets, bulletRules: rules, platformDecision: plan.platform,
    trendBrief: "LINKEDIN TREND ALIGNMENT (test)", targetCompany: "google",
  });
  assert.ok(prompt.includes("THE CANDIDATE'S BULLET RULES"));
  assert.ok(prompt.includes("Per-role budgets (authoritative; never add bullets to reach a minimum)"));
  assert.ok(prompt.includes("LINKEDIN TREND ALIGNMENT (test)"));
  assert.ok(prompt.includes("PHASE 1.5 - STAR GROUNDING"));
  assert.ok(prompt.includes("Google's hiring attributes"));
  assert.ok(prompt.includes("FAANG BULLET STANDARD"));
  assert.ok(prompt.includes("Never pad a role or invent a bullet to meet a minimum"));
});

test("without Bullet Rules the whole-document prompt falls back to the tenure budget", () => {
  const prompt = buildResumeGenerationPrompt({
    targetRole: "SDE", audience: "x", mode: "balanced", inputData: "{}",
  });
  assert.ok(prompt.includes('If a role carries a "bullet_budget" field, that value is authoritative.'));
  assert.ok(!prompt.includes("THE CANDIDATE'S BULLET RULES"));
});

test("roleBudgetHint reads ranges, single counts and numbers; unreadable budgets give nulls", () => {
  assert.deepEqual(roleBudgetHint({ bullet_budget: "6-7", tenure_months: 30 }), { label: "6-7", min: 6, max: 7, tenureMonths: 30 });
  assert.equal(roleBudgetHint({ bullet_budget: 1 }).max, 1);
  assert.equal(roleBudgetHint({ bullet_budget: "2\u20133" }).min, 2);
  assert.equal(roleBudgetHint({ bullet_budget: "lots" }).max, null);
  assert.equal(roleBudgetHint({}).label, null);
});

test("role prompt states the budget, evidence, JD, keywords and STAR quota", () => {
  const prompt = buildRoleBulletPrompt({
    ...roleBase, budget: roleBudgetHint({ bullet_budget: "6-7", tenure_months: 30 }), starStoryCount: 2,
  });
  assert.ok(prompt.includes("HARD LIMIT: 6 to 7 bullets") && prompt.includes("30 months"));
  assert.ok(prompt.includes("POSTING BODY") && prompt.includes("Priority JD keywords: Terraform, AKS"));
  assert.ok(prompt.includes("1. Built Terraform modules"));
  assert.ok(prompt.includes("Draft up to 2 STAR stories") && prompt.includes("Amazon's Leadership Principles"));
  assert.ok(prompt.includes("TERMINOLOGY BAN: test"));
  assert.ok(prompt.includes('"bullets": ["string"]') && prompt.includes('"star_stories"'));
  assert.ok(!prompt.includes("CORRECTIONS REQUIRED"));
});

test("role prompt handles a single-bullet stint and a zero-story quota", () => {
  const prompt = buildRoleBulletPrompt({ ...roleBase, budget: roleBudgetHint({ bullet_budget: "1" }), starStoryCount: 0 });
  assert.ok(prompt.includes("EXACTLY 1 bullet"));
  assert.ok(prompt.includes("state the single thing that was actually delivered"));
  assert.ok(prompt.includes('Return "star_stories" as an empty array'));
});

test("role prompt covers unreadable dates, retry feedback and Player-Coach mode", () => {
  const prompt = buildRoleBulletPrompt({
    ...roleBase, targetCompany: "none", budget: roleBudgetHint({}), starStoryCount: 1, mode: "Player-Coach",
    retryFeedback: { issues: ['Bullet 2 uses "we/our"'], previousBullets: ["We built X"] },
  });
  assert.ok(prompt.includes("derive it from the dates"));
  assert.ok(prompt.includes("CORRECTIONS REQUIRED") && prompt.includes('- Bullet 2 uses "we/our"') && prompt.includes("- We built X"));
  assert.ok(prompt.includes("PLAYER-COACH BALANCE"));
  assert.ok(!prompt.includes("TARGET COMPANY: none"));
});

test("a planned budget explains itself to the model and overrides its own reading of the dates", () => {
  const prompt = buildRoleBulletPrompt({
    ...roleBase,
    budget: { label: "6-7", min: 6, max: 7, tenureMonths: 55, reason: "55 months, current or most recent role" },
  });
  assert.ok(prompt.includes("HARD LIMIT: 6 to 7 bullets"));
  assert.ok(prompt.includes("Set by the bullet planner: 55 months, current or most recent role."));
  assert.ok(prompt.includes("overrides your own reading of the dates"));
});

test("a ceiling-only budget (unreadable dates) is stated as a ceiling, not re-derived", () => {
  const prompt = buildRoleBulletPrompt({
    ...roleBase,
    budget: { label: null, min: null, max: 7, tenureMonths: null, reason: "dates could not be read" },
  });
  assert.ok(prompt.includes("proportionate to the evidence, never more than 7"));
  assert.ok(!prompt.includes("derive it from the dates"));
});

test("the candidate's bullet rules and the role's trend brief appear in the role prompt when supplied", () => {
  const rules = defaultBulletRules();
  const prompt = buildRoleBulletPrompt({
    ...roleBase,
    budget: roleBudgetHint({ bullet_budget: "4-5" }),
    budgetRules: describeBudgetRules("   ", { rules }),
    trendBrief: "LINKEDIN TRENDING SKILLS (Cloud Engineer):\n- Shown in this role's source: Terraform.",
  });
  assert.ok(prompt.includes("THE CANDIDATE'S BULLET RULES"));
  assert.ok(prompt.includes("this role's budget above is already resolved against them"));
  assert.ok(prompt.includes("LINKEDIN TRENDING SKILLS (Cloud Engineer):"));
  const plain = buildRoleBulletPrompt({ ...roleBase, budget: roleBudgetHint({ bullet_budget: "4-5" }) });
  assert.ok(!plain.includes("THE CANDIDATE'S BULLET RULES") && !plain.includes("LINKEDIN TRENDING SKILLS"));
});
