import { test } from "node:test";
import assert from "node:assert/strict";
import {
  audienceBrief, audiencesToApply, buildAudiencePrompt, describeAppliedAudiences, extractJdSignals, selectionMatchesDecision,
  fuseAudienceDecision, jdFingerprint, scoreAudiencesByRules,
} from "./audienceIntelligence";

const ic = "Senior Cloud Architect. This is a hands-on individual contributor position. Design Azure infrastructure and implement Kubernetes platforms. Require 8 years of experience. Partner with engineering teams on systems design.";
const manager = "Cloud Engineering Manager. Manage a team of 12 engineers. Own hiring and performance reviews. Build Azure infrastructure and platform engineering capabilities.";

test("an IC architect posting cannot select director, platform director or executive personas", () => {
  const rules = scoreAudiencesByRules(extractJdSignals(ic, "Director"));
  assert.ok(rules.some((pick) => pick.id === "cloud-architect"));
  assert.ok(!rules.some((pick) => /director|cto-vp|platform-dir|leadership|mgr/.test(pick.id)));
  const decision = fuseAudienceDecision({
    audiences: [{ id: "cto-vp", confidence: 1, evidence: [ic] }, { id: "director-large", confidence: 1, evidence: [ic] }],
  }, rules, ic, "Director");
  assert.ok(!decision.audiences.some((pick) => /director|cto-vp/.test(pick.id)));
});

test("reporting to executives and having no direct reports does not imply management", () => {
  const jd = `${ic} Report to the Director of Engineering. Partner with the CTO. No direct reports or people management.`;
  const rules = scoreAudiencesByRules(extractJdSignals(jd));
  assert.ok(!rules.some((pick) => /director|cto-vp|platform-dir|leadership|mgr/.test(pick.id)));
});

test("a leadership suggestion must quote the actual management evidence", () => {
  const decision = fuseAudienceDecision({
    audiences: [{ id: "leadership", confidence: 1, evidence: ["Build Azure infrastructure and platform engineering capabilities."] }],
  }, scoreAudiencesByRules(extractJdSignals(manager)), manager);
  assert.equal(decision.source, "rules");
  assert.match(decision.warnings.join(" "), /Rejected leadership/);
});

test("a stated team of 12 enables people-leadership selection", () => {
  const signals = extractJdSignals(manager, "Cloud Engineering Manager");
  assert.equal(signals.teamSize, 12);
  assert.equal(signals.peopleManagement.value, "people management");
  const rules = scoreAudiencesByRules(signals);
  assert.ok(rules.some((pick) => pick.id === "leadership"));
  assert.ok(!rules.some((pick) => pick.id === "cto-vp"));
  const decision = fuseAudienceDecision({
    audiences: [{ id: "leadership", confidence: 0.9, evidence: ["Manage a team of 12 engineers."] }],
  }, rules, manager);
  assert.ok(["leadership", "cloud-eng-mgr"].includes(decision.primary));
  assert.ok(decision.audiences.some((pick) => pick.id === "leadership"));
  assert.ok(decision.audiences[0].confidence >= 0.8);
});

test("unknown catalog IDs and fabricated JD evidence are rejected", () => {
  const decision = fuseAudienceDecision({
    audiences: [
      { id: "my-own-role", confidence: 1, evidence: [ic] },
      { id: "microsoft", confidence: 1, evidence: ["Manage 500 direct reports at Microsoft."] },
      { id: "custom", confidence: 1, evidence: [ic] },
      { id: "__proto__", confidence: 1, evidence: [ic] },
      { id: "toString", confidence: 1, evidence: [ic] },
    ],
    custom_persona: "CEO",
  }, scoreAudiencesByRules(extractJdSignals(ic)), ic);
  assert.equal(decision.source, "rules");
  assert.equal(decision.customPersona, undefined);
  assert.ok(decision.warnings.length >= 2);
});

test("fingerprint is stable under whitespace/case normalization, sensitive to role and JD", () => {
  assert.equal(jdFingerprint("  Azure\nArchitect ", " Cloud "), jdFingerprint("azure architect", "cloud"));
  assert.notEqual(jdFingerprint(ic, "Architect"), jdFingerprint(ic, "Manager"));
  assert.notEqual(jdFingerprint(ic, "Architect"), jdFingerprint(manager, "Architect"));
});

test("platform persona needs actual Microsoft/Azure evidence and decisions remain bounded", () => {
  const jd = "Principal Architect. Hands-on individual contributor designing AWS cloud systems.";
  const signals = extractJdSignals(jd);
  assert.deepEqual(signals.platforms, ["AWS"]);
  const rules = scoreAudiencesByRules(signals);
  assert.ok(!rules.some((pick) => pick.id === "microsoft"));
  const decision = fuseAudienceDecision(null, rules, jd);
  assert.ok(decision.audiences.length >= 1 && decision.audiences.length <= 3);
  assert.match(audienceBrief(decision, decision.primary), /SOURCE RESUME does not evidence/);
});

test("prompt contains the catalog, strict JSON and bounded posting excerpt", () => {
  const prompt = buildAudiencePrompt("A".repeat(20000) + "Manage a team of 12 engineers.", "Manager");
  assert.ok(prompt.length < 19000);
  assert.match(prompt, /posting middle omitted/);
  assert.match(prompt, /cloud-architect:/);
  assert.match(prompt, /custom is never an ID/);
});

test("principal architect in the Office of the CTO stays an IC architect", () => {
  const jd = `Principal Cloud Architect
Join the Office of the CTO as a hands-on Principal Cloud Architect.
Design multi-region Azure landing zones and review architecture decisions.
This is an individual contributor role with no direct reports.`;
  const rules = scoreAudiencesByRules(extractJdSignals(jd, "Principal Cloud Architect"));
  assert.equal(rules[0].id, "principal-architect");
  assert.ok(!rules.some((pick) => /cto-vp|director|leadership|mgr/.test(pick.id)));
});

test("advising executive stakeholders does not make a solutions architect an executive", () => {
  const jd = `Senior Solutions Architect
Advise C-level executives on cloud strategy and present architecture options to VP and Director stakeholders.
Lead customer-facing solution design workshops on AWS.`;
  const rules = scoreAudiencesByRules(extractJdSignals(jd, "Senior Solutions Architect"));
  assert.ok(rules.some((pick) => pick.id === "solution-architect"));
  assert.ok(!rules.some((pick) => /cto-vp|director|leadership|mgr/.test(pick.id)));
  const decision = fuseAudienceDecision({
    audiences: [{ id: "cto-vp", confidence: 0.9, reason: "Executive",
      evidence: ["Advise C-level executives on cloud strategy and present architecture options to VP and Director stakeholders"] }],
  }, rules, jd, "Senior Solutions Architect");
  assert.equal(decision.source, "rules");
  assert.ok(!decision.audiences.some((pick) => pick.id === "cto-vp"));
});

test("working closely with the Head of Platform does not promote a platform engineer", () => {
  const jd = `Senior Platform Engineer
You will work closely with the Head of Platform to build Kubernetes tooling.
Hands-on role: implement CI/CD pipelines and SRE practices on GCP.`;
  const rules = scoreAudiencesByRules(extractJdSignals(jd, "Senior Platform Engineer"));
  assert.ok(!rules.some((pick) => /director|platform-dir|leadership/.test(pick.id)));
});

test("Office-suite proficiency is not Microsoft enterprise/cloud evidence", () => {
  const jd = `Cloud Engineer
Build infrastructure on Google Cloud (GCP) with Terraform.
Proficiency in Microsoft Office and Microsoft Teams is required.`;
  const rules = scoreAudiencesByRules(extractJdSignals(jd, "Cloud Engineer"));
  assert.ok(!rules.some((pick) => pick.id === "microsoft"));
  const cloudJd = "Enterprise Engineer\nImplement Microsoft 365, Entra and Intune across the organization.";
  assert.ok(scoreAudiencesByRules(extractJdSignals(cloudJd)).some((pick) => pick.id === "microsoft"));
});

test("real people-management duties outrank architecture in rules-only decisions", () => {
  const jd = `Cloud Engineering Manager
Manage a team of 12 cloud engineers on Azure, own hiring and performance reviews.
Drive architecture decisions for the platform.`;
  const rules = scoreAudiencesByRules(extractJdSignals(jd, "Cloud Engineering Manager"));
  assert.equal(rules[0].id, "cloud-eng-mgr");
  for (const id of ["leadership", "cloud-eng-mgr", "microsoft"]) assert.ok(rules.some((pick) => pick.id === id));
});

test("typographic-normalized contiguous quotes are accepted, ellipses are not", () => {
  const jd = 'Cloud Architect\nDesign Azure landing zones – including the “hub-and-spoke” network topology.';
  const rules = scoreAudiencesByRules(extractJdSignals(jd, "Cloud Architect"));
  const decision = fuseAudienceDecision({
    audiences: [{ id: "cloud-architect", confidence: 0.9, reason: "Design",
      evidence: ['Design Azure landing zones - including the "hub-and-spoke" network topology'] }],
  }, rules, jd, "Cloud Architect");
  assert.equal(decision.source, "ai+rules");
  const invalid = fuseAudienceDecision({
    audiences: [{ id: "cloud-architect", confidence: 0.9, evidence: ["Design Azure...network topology"] }],
  }, rules, jd, "Cloud Architect");
  assert.equal(invalid.source, "rules");
});

test("automatic application caps cost at two close confident readers and excludes general secondaries", () => {
  const decision = fuseAudienceDecision(null, scoreAudiencesByRules(extractJdSignals(manager)), manager);
  assert.equal(audiencesToApply(decision).length, 2);
  decision.audiences = [
    { id: "cloud-architect", label: "Cloud Architect", confidence: 0.95, evidence: [], reason: "Primary" },
    { id: "microsoft", label: "Microsoft", confidence: 0.75, evidence: [], reason: "Too distant" },
    { id: "general", label: "General", confidence: 0.94, evidence: [], reason: "General" },
  ];
  decision.primary = "cloud-architect";
  assert.deepEqual(audiencesToApply(decision), ["cloud-architect"]);
  decision.audiences[1].confidence = 0.85;
  assert.deepEqual(audiencesToApply(decision), ["cloud-architect", "microsoft"]);
  decision.audiences[0].confidence = 0.9;
  decision.audiences[1].confidence = 0.75;
  assert.deepEqual(audiencesToApply(decision), ["cloud-architect", "microsoft"]);
});

test("AI badge requires the current complete automatic selection and no manual changes", () => {
  const decision = fuseAudienceDecision(null, scoreAudiencesByRules(extractJdSignals(manager)), manager);
  const selection = audiencesToApply(decision);
  assert.ok(selectionMatchesDecision(decision, [...selection].reverse(), decision.fingerprint, false));
  assert.equal(selectionMatchesDecision(decision, selection, decision.fingerprint, true), false);
  assert.equal(selectionMatchesDecision(decision, selection, "different-jd", false), false);
  assert.equal(selectionMatchesDecision(decision, [...selection, "general"], decision.fingerprint, false), false);
  assert.equal(selectionMatchesDecision(decision, selection.slice(1), decision.fingerprint, false), false);
  assert.equal(selectionMatchesDecision(null, selection, decision.fingerprint, false), false);
});

test("explicit Auto-Select success describes only applied readers and rules fallback", () => {
  const jd = "Principal Cloud Architect\nDesign Azure cloud architecture. Individual contributor, no direct reports.";
  const decision = fuseAudienceDecision(null, scoreAudiencesByRules(extractJdSignals(jd)), jd);
  assert.equal(describeAppliedAudiences(decision),
    "Selected: Principal Cloud Architect (90%) + Cloud Architect (80%) (rules fallback)");
  decision.source = "ai+rules";
  assert.equal(describeAppliedAudiences(decision),
    "Selected: Principal Cloud Architect (90%) + Cloud Architect (80%)");
});
