import { test } from "node:test";
import assert from "node:assert/strict";
import { EDITOR_CANDIDATE_ID, compareMasterResumes, hasUnsavedEdits, selectMasterSource } from "./masterSelection";
import type { MasterResume } from "../types";

function master(id: string, skills: string[]): MasterResume {
  return {
    id, name: id, description: "", createdAt: 0,
    data: {
      personal_info: { name: "Candidate", location: "", email: "", phone: "", linkedin: "", summary: "Cloud engineer" },
      skills,
      experience: [], certifications: [], projects: [], education: [],
    },
  };
}
const jd = "Required: Terraform, Kubernetes, Microsoft Azure. Build cloud infrastructure.";

test("selects the strongest JD match, not the first master", () => {
  const masters = [master("unrelated", ["Photoshop"]), master("cloud", ["Terraform", "Kubernetes", "Microsoft Azure"])];
  const result = compareMasterResumes(masters, jd, "unrelated", "");
  assert.equal(result[0].id, "cloud");
  assert.ok(result[0].analysis.score > result[1].analysis.score);
  assert.equal(masters[0].id, "unrelated");
});

test("ties keep the current master", () => {
  const result = compareMasterResumes([master("first", ["Terraform"]), master("selected", ["Terraform"])], jd, "selected", "");
  assert.equal(result[0].id, "selected");
});

test("selected editor draft is scored and passed intact", () => {
  const draft = JSON.stringify(master("draft", ["Terraform", "Kubernetes", "Microsoft Azure"]).data);
  const result = compareMasterResumes([master("first", ["Terraform"]), master("selected", ["Photoshop"])], jd, "selected", draft);
  assert.equal(result[0].id, "selected");
  assert.equal(result[0].text, draft);
});

test("unreadable sources and a missing JD never throw or invent scores", () => {
  assert.deepEqual(compareMasterResumes([], jd, "", ""), []);
  assert.deepEqual(compareMasterResumes([master("a", ["Terraform"])], "", "a", ""), []);
  assert.deepEqual(compareMasterResumes([master("a", ["Terraform"])], "   ", "a", "Terraform engineer"), []);
});

test("editor text that matches no saved master still competes instead of being ignored", () => {
  const upload = "Cloud engineer. Terraform, Kubernetes and Microsoft Azure in production.";
  const result = compareMasterResumes([master("other", ["Photoshop"])], jd, "deleted-master", upload);
  assert.equal(result[0].id, EDITOR_CANDIDATE_ID);
  assert.equal(result[0].fromEditor, true);
  assert.equal(result[0].text, upload);
  assert.equal(result.length, 2);
});

test("with no saved masters the editor text is the only candidate", () => {
  const result = compareMasterResumes([], jd, "default", "Terraform and Kubernetes on Microsoft Azure");
  assert.equal(result.length, 1);
  assert.equal(result[0].id, EDITOR_CANDIDATE_ID);
});

test("an editor tie goes to the text the user is looking at", () => {
  const same = master("same", ["Terraform"]);
  const draft = JSON.stringify(same.data);
  const result = compareMasterResumes([master("other", ["Terraform"]), same], jd, "same", draft);
  assert.equal(result[0].id, "same");
  assert.equal(result[0].fromEditor, true);
});

test("unsaved edits are recognised regardless of whitespace, and ignored when identical", () => {
  const saved = master("a", ["Terraform"]);
  assert.equal(hasUnsavedEdits(saved, JSON.stringify(saved.data)), false);
  assert.equal(hasUnsavedEdits(saved, JSON.stringify(saved.data, null, 4)), false);
  assert.equal(hasUnsavedEdits(saved, JSON.stringify(master("a", ["Terraform", "Kubernetes"]).data)), true);
  assert.equal(hasUnsavedEdits(undefined, "pasted resume text"), true);
  assert.equal(hasUnsavedEdits(saved, "   "), false);
});

test("a clean editor follows the winning master", () => {
  const masters = [master("unrelated", ["Photoshop"]), master("cloud", ["Terraform", "Kubernetes", "Microsoft Azure"])];
  const decision = selectMasterSource(masters, jd, "unrelated", JSON.stringify(masters[0].data, null, 2));
  assert.equal(decision.best?.id, "cloud");
  assert.equal(decision.syncEditor, true);
});

test("a winning master never overwrites the user's unsaved edits", () => {
  const masters = [master("unrelated", ["Photoshop"]), master("cloud", ["Terraform", "Kubernetes", "Microsoft Azure"])];
  const edited = JSON.stringify(master("unrelated", ["Photoshop", "Illustrator"]).data, null, 2);
  const decision = selectMasterSource(masters, jd, "unrelated", edited);
  assert.equal(decision.best?.id, "cloud");
  assert.equal(decision.syncEditor, false);
  assert.ok(decision.comparison.some((c) => c.fromEditor && c.text === edited));
});

test("nothing is switched when the editor text already wins or nothing can be scored", () => {
  const masters = [master("unrelated", ["Photoshop"]), master("cloud", ["Terraform"])];
  const strong = JSON.stringify(master("unrelated", ["Terraform", "Kubernetes", "Microsoft Azure"]).data);
  const winning = selectMasterSource(masters, jd, "unrelated", strong);
  assert.equal(winning.best?.fromEditor, true);
  assert.equal(winning.syncEditor, false);
  const empty = selectMasterSource([], jd, "x", "");
  assert.equal(empty.best, null);
  assert.equal(empty.syncEditor, false);
});
