import { test } from "node:test";
import assert from "node:assert/strict";
import { enforceBulletBudgets, pickStrongestBullets } from "./bulletBudget";
import { applyImpactAudit } from "./impactScore";

const NOW = new Date(2026, 9, 8);

/** The key enforceBulletBudgets uses to match a story's bullet to a bullet on the resume. */
const normalizeKey = (text: string) => text.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();

test("bullets that back a STAR story are kept ahead of stronger unprotected ones", () => {
  const bullets = [
    "Built the landing zone modules, reducing provisioning from days to hours",
    "Designed hub-and-spoke connectivity, eliminating the site VPN outages",
    "Migrated the file servers to Azure, retiring the leased data center",
    "Hardened Entra ID with Conditional Access across the tenant",
    "Automated onboarding with PowerShell, so accounts exist before day one",
  ];
  const protectedKeys = new Set([normalizeKey(bullets[3])]);
  const { kept, removed } = pickStrongestBullets(bullets, 2, { protectedKeys });
  assert.equal(kept.length, 2);
  assert.ok(kept.includes(bullets[3]), "the story's bullet survives");
  assert.equal(removed.length, 3);
});

test("protected bullets are capped at the ceiling, strongest first, and keep their order", () => {
  const bullets = [
    "Worked on various infra things",
    "Built the landing zone modules, reducing provisioning from days to hours",
    "Designed hub-and-spoke connectivity, eliminating the site VPN outages",
    "Migrated the file servers to Azure, retiring the leased data center",
  ];
  const protectedKeys = new Set(bullets.map(normalizeKey));
  const { kept } = pickStrongestBullets(bullets, 2, { protectedKeys });
  assert.equal(kept.length, 2);
  assert.ok(!kept.includes(bullets[0]), "the weakest protected bullet is the one that goes");
  assert.deepEqual(kept, bullets.filter((b) => kept.includes(b)), "original order is retained");
});

test("every verb the prompts approve counts as a strong lead when bullets are trimmed", () => {
  const approved = ["Governed", "Configured", "Consolidated", "Instrumented", "Partnered", "Defined", "Evaluated", "Diagnosed", "Hardened", "Negotiated", "Mentored"];
  // Both bullets are otherwise identical, so the earlier one wins only if its verb is not penalised.
  const listed = "Built the production estate across three business units";
  for (const verb of approved) {
    const candidate = `${verb} the production estate across three business units`;
    const { kept } = pickStrongestBullets([candidate, listed], 1);
    assert.deepEqual(kept, [candidate], `${verb} must score like the verbs the trimmer already knew`);
  }
});

test("trimming an over-budget role never orphans a story the audit would then drop", () => {
  const bullets = [
    "Built the landing zone modules, reducing provisioning from days to hours",
    "Designed hub-and-spoke connectivity, eliminating the site VPN outages",
    "Migrated the file servers to Azure, retiring the leased data center",
    "Automated onboarding with PowerShell, so accounts exist before day one",
    "Hardened Entra ID with Conditional Access across the tenant",
    "Diagnosed recurring Exchange outages to a misconfigured load balancer probe",
    "Replaced ad-hoc backups with Veeam jobs and tested every restore",
  ];
  const story = (bullet: string) => ({
    bullet, competency: "Dive Deep", situation: "It was broken.", task: "I owned it.",
    action: "I investigated the failure, reproduced it, and fixed the root cause.", result: "It stopped happening.",
  });
  const resume: any = {
    experience: [
      { role: "Cloud Engineer", company: "Fabrikam", duration: "Jan 2021 - Present", bullets: ["Built Terraform modules for hub networking", "Cut deploys from 40 to 12 minutes by caching providers"] },
      { role: "Systems Engineer", company: "Northwind", duration: "Mar 2018 - Dec 2020", bullets },
    ],
    star_stories: [story(bullets[4]), story(bullets[5])],
  };
  enforceBulletBudgets(resume, { rules: null, now: NOW, sourceText: bullets.join("\n") });
  const earlier = resume.experience[1].bullets;
  assert.ok(earlier.length <= 4, "an earlier role of 24+ months is capped at 4");
  assert.ok(earlier.includes(bullets[4]) && earlier.includes(bullets[5]), "both story bullets survive the trim");
  applyImpactAudit(resume, { sourceText: bullets.join("\n") });
  assert.equal(resume.star_stories.length, 2, "both stories still link to a bullet that is on the resume");
});
