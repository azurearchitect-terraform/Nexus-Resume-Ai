import assert from "node:assert/strict";
import test from "node:test";
import type { AtsDocument } from "./atsDocument";
import { exportBlocks } from "./atsDocument";
import { checkAtsCompatibility, plainResumeText, validateExportText } from "./exportValidation";

const resume: AtsDocument = {
  personal_info: { name: "", email: "", phone: "", location: "", linkedin: "" },
  summary: "Emoji 😀 private \uE000 ligature \uFB01 decorative ★",
  skills: [],
  experience: [
    { role: "", company: "", duration: "", bullets: ["• Embedded bullet"] },
    { role: "Engineer", company: "A", duration: "2019 - 2021", bullets: [] },
    { role: "Consultant", company: "B", duration: "Jan 2020 - Dec 2022", bullets: [] },
  ],
  projects: [], certifications: [], education: ["BSc Example University", { degree: "", institution: "" }],
};

test("compatibility checks flag incomplete source fields, year precision, glyphs, typography and PII", () => {
  const issues = checkAtsCompatibility(resume, exportBlocks(resume), { font: "Fancy Font", sizePt: 9, masked: true });
  for (const token of ["name", "Email", "Phone", "Location", "company", "job title", "dates", "year-only", "overlap",
    "Education", "Emoji", "Private-use", "ligatures", "bullet", "font", "10 pt", "PII"]) {
    assert.ok(issues.some(issue => issue.message.includes(token)), token);
  }
  assert.ok(issues.filter(issue => /overlap|free text/.test(issue.message)).every(issue => issue.severity === "info"));
  assert.ok(issues.some(issue => issue.severity === "error"));
  assert.ok(checkAtsCompatibility(resume, [], { sizePt: 11, scale: 0.8 }).some(issue => /10 pt/.test(issue.message)));
});

test("export validation checks complete content, order, duplicate blocks, blank pages and literal ligatures", () => {
  assert.deepEqual(validateExportText("Name\nWork Experience\nEngineer - 2019", ["Name Work Experience Engineer – 2019"]).errors, []);
  assert.ok(validateExportText("Name\nMissing", ["Name"]).errors.some(error => /Missing/.test(error)));
  assert.ok(validateExportText("Name\nSkills", ["Skills Name"]).errors.some(error => /order/.test(error)));
  assert.ok(validateExportText("Name\nName", ["Name"]).errors.length);
  assert.ok(validateExportText("Name", ["Name", ""]).errors.some(error => /Page 2/.test(error)));
  assert.ok(validateExportText("Configured", ["Con\uFB01gured"]).errors.some(error => /ligatures/.test(error)));
});

test("plain text comes directly from canonical blocks with ordinary list markers", () => {
  const output = plainResumeText(resume);
  assert.ok(output.includes("Work Experience"));
  assert.ok(output.includes("- • Embedded bullet"));
  assert.ok(output.includes("Engineer | 2019 - 2021\nA\n"), "role line then company line");
});
