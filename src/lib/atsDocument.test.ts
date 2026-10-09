import assert from "node:assert/strict";
import test from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { AtsResume } from "../components/AtsResume";
import { assertUnmaskedExport, canonicalResume, exportBlocks, exportSections, formatDurationForAts, groupExportUnits, resumeFileName } from "./atsDocument";
import { validateExportText } from "./exportValidation";
import type { ResumeData } from "../types";

const source: ResumeData = {
  personal_info: { name: "Taylor Example", email: "taylor@example.org", phone: "+44 20 7946 0958", location: "London",
    linkedin: "linkedin.com/in/taylor-example", summary: "Configured efficient workflows and firewalls." },
  skills: ["Azure", "TypeScript"],
  experience: [{ id: "1", role: "Engineer", company: "Example Services", duration: "05/2019 - 08/2021", bullets: ["Defined reliable workflows."] }],
  projects: [{ title: "Migration", description: "Configured infrastructure.", isOptional: true }],
  certifications: ["Azure Fundamentals"],
  education: [{ degree: "BSc", institution: "Example University", expected_completion: "2018" }],
};

test("canonical content uses profile overrides without cloning content arrays or mutating the source", () => {
  const resume = canonicalResume(source, { name: "Jordan Candidate", email: "" });
  assert.equal(resume.personal_info.name, "Jordan Candidate");
  assert.equal(resume.personal_info.email, source.personal_info.email);
  assert.equal(resume.personal_info.linkedin, "https://linkedin.com/in/taylor-example");
  assert.equal(source.personal_info.name, "Taylor Example");
  assert.equal(resume.experience, source.experience);
  assert.equal(resume.skills, source.skills);
  assert.equal(resume.summary, source.personal_info.summary);
  assert.equal("_intermediateData" in resume, false);
});

test("blocks and preview preserve body contacts, full hyperlink, standard headings and dates", () => {
  const resume = canonicalResume(source);
  const blocks = exportBlocks(resume);
  assert.deepEqual(blocks.filter(block => block.kind === "heading").map(block => block.text),
    ["Professional Summary", "Skills", "Certifications", "Work Experience", "Projects", "Education"]);
  assert.equal(blocks.find(block => block.kind === "contact")?.text,
    "London | taylor@example.org | +44 20 7946 0958 | linkedin.com/in/taylor-example");
  assert.equal(blocks.find(block => block.kind === "contact")?.link, "https://linkedin.com/in/taylor-example");
  assert.deepEqual(blocks.find(block => block.employment)?.employment,
    { title: "Engineer", dates: "May 2019 - Aug 2021" });
  const role = blocks.findIndex(block => block.text === "Engineer | May 2019 - Aug 2021");
  assert.ok(role >= 0);
  assert.deepEqual(blocks[role + 1], { kind: "text", section: "experience", unit: "experience:0", text: "Example Services", employer: true });
  const html = renderToStaticMarkup(createElement(AtsResume, { blocks, masked: false }));
  assert.ok(html.includes('href="https://linkedin.com/in/taylor-example"'));
  assert.ok(html.includes("<li"));
  assert.ok(!/<(?:table|header|footer|img)\b/.test(html));
  for (const block of blocks) assert.ok(html.includes(block.text) || block.kind === "contact" || block.employment);
  assert.ok(html.includes("<strong>Engineer</strong>"));
  assert.ok(html.includes("<p style=\"margin:0 0 4pt;overflow-wrap:break-word;break-after:avoid\"><strong>Example Services</strong></p>"),
    "company is a separate bold line");
  assert.ok(html.indexOf("<strong>Engineer</strong>") < html.indexOf("<strong>Example Services</strong>"));
  assert.ok(html.includes("<strong>Migration</strong>"), "project titles are bold");
  assert.ok(html.includes('text-align:right'));
  assert.ok(html.includes("text-align:center"));
  assert.ok(!html.includes(">https://linkedin.com"));
  const masked = renderToStaticMarkup(createElement(AtsResume, { blocks, masked: true }));
  assert.ok(!masked.includes("taylor@example.org"));
  assert.ok(!masked.includes("Taylor Example"));
  assert.throws(() => assertUnmaskedExport(true, blocks), /PII masking/);
  assert.throws(() => assertUnmaskedExport(false, [{ kind: "contact", section: "header", unit: "header", text: "[REDACTED EMAIL]" }]), /PII masking/);
});

test("empty contact fields and sections do not create dangling separators or invented content", () => {
  const resume = canonicalResume({ ...source, personal_info: { ...source.personal_info, location: "", phone: "", linkedin: "", summary: "" },
    skills: [], experience: [], projects: [], certifications: [], education: [] });
  assert.deepEqual(exportBlocks(resume).map(block => block.text), ["Taylor Example", "taylor@example.org"]);
});

test("missing generated contact values remain empty strings for source checks", () => {
  const incomplete = canonicalResume({ ...source, personal_info: {} } as ResumeData);
  assert.deepEqual(incomplete.personal_info, { name: "", email: "", phone: "", location: "", linkedin: "" });
  assert.equal(incomplete.summary, "");
});

test("ATS durations normalize known months while preserving year-only and unknown dates", () => {
  const cases: [string, string][] = [
    ["2016-2019", "2016 - 2019"], ["2016 - Present", "2016 - Present"],
    ["2016 (contract) - 2019", "2016 - 2019"], ["2016 - Aug 2019", "2016 - Aug 2019"],
    ["05/2019 - 08/2021", "May 2019 - Aug 2021"], ["2019-05 - 2021-08", "May 2019 - Aug 2021"],
    ["Jan-2024 - Feb-2024", "Jan 2024 - Feb 2024"], ["Jan '24 - Mar '24", "Jan 2024 - Mar 2024"],
    ["Jan 2020 to date", "Jan 2020 - Present"], ["Freelance", "Freelance"], ["2024 - 2020", "2024 - 2020"],
  ];
  for (const [input, expected] of cases) assert.equal(formatDurationForAts(input), expected, input);
});

test("filenames use the real candidate name and sanitize unsafe filename characters", () => {
  const resume = canonicalResume(source, { name: "Jordan: Candidate" });
  assert.equal(resumeFileName(resume, "Engineer/Lead", "docx"), "Jordan Candidate-Engineer Lead.docx");
  assert.equal(resumeFileName(resume, "Contoso: Ltd/EU", "docx"), "Jordan Candidate-Contoso Ltd EU.docx");
  assert.equal(resumeFileName(resume, "Contoso:\t Ltd/\u0000EU", "docx"), "Jordan Candidate-Contoso Ltd EU.docx");
  assert.equal(resumeFileName(resume, "", "pdf"), "Jordan Candidate-Resume.pdf");
});

test("Standard section rendering keeps heading rules, bold skill labels and section formatting; Simplified remains plain", () => {
  const blocks = exportBlocks(canonicalResume({ ...source, skills: { infrastructure: ["Azure", "Bicep"], devsecops: [], governance: [], observability: [] } }));
  assert.deepEqual(blocks.find(block => block.skill)?.skill, { category: "infrastructure", items: "Azure, Bicep" });
  const standard = renderToStaticMarkup(createElement(AtsResume, { blocks, masked: false, sectionOnly: true,
    sectionStyle: section => ({ fontFamily: "Arial", fontSize: section === "skills" ? "12pt" : "11pt", padding: "8px", marginBottom: "10px", lineHeight: 1.4 }) }));
  assert.ok(standard.includes("<strong>infrastructure:</strong>"));
  assert.ok(standard.includes("text-transform:uppercase"));
  assert.ok(standard.includes("border-bottom:1px solid #000"));
  for (const value of ["font-family:Arial", "font-size:12pt", "padding:8px", "margin-bottom:10px", "line-height:1.4"]) assert.ok(standard.includes(value), value);
  const simplified = renderToStaticMarkup(createElement(AtsResume, { blocks, masked: false }));
  assert.ok(!simplified.includes("text-transform:uppercase"));
  assert.ok(!simplified.includes("border-bottom:"));
});

test("export units keep entries and lists intact, merging section headings into the first unit only", () => {
  const resume = canonicalResume(source);
  resume.experience = [
    { role: "First Engineer", company: "Example", duration: "2020 - 2022", bullets: ["First bullet.", "Second bullet."] },
    { role: "Second Engineer", company: "Next", duration: "2022 - Present", bullets: ["Third bullet."] },
  ];
  resume.projects = [{ title: "First project", description: "First description." }, "Plain project",
    { title: "", description: "Description only." }];
  resume.certifications = ["Azure Fundamentals", "Azure Administrator"];
  resume.education = ["First degree", "Second degree"];
  const blocks = exportBlocks(resume);
  const units = groupExportUnits(blocks);
  assert.deepEqual(units.flatMap(unit => unit.blocks), blocks, "text order and content are untouched");
  assert.deepEqual(units.map(unit => unit.unit),
    ["header", "summary", "skills", "certifications", "experience:0", "experience:1", "projects:0", "projects:1", "projects:2", "education"]);
  assert.deepEqual(units.find(unit => unit.unit === "experience:0")!.blocks.map(block => block.kind), ["heading", "text", "text", "bullet", "bullet"]);
  assert.deepEqual(units.find(unit => unit.unit === "experience:1")!.blocks.map(block => block.kind), ["text", "text", "bullet"]);
  assert.deepEqual(units.find(unit => unit.unit === "projects:0")!.blocks.map(block => block.text), ["Projects", "First project", "First description."]);
  for (const section of ["summary", "skills", "experience", "projects", "certifications", "education"]) {
    const group = units.find(unit => unit.section === section)!;
    assert.equal(group.blocks[0].kind, "heading");
    assert.ok(group.blocks.length > 1);
  }
  assert.equal(units.find(unit => unit.unit === "certifications")!.blocks.length, 3);
  assert.equal(units.find(unit => unit.unit === "education")!.blocks.length, 3);
  const html = renderToStaticMarkup(createElement(AtsResume, { blocks, masked: false }));
  assert.equal((html.match(/data-keep-unit=/g) || []).length, units.length);
  assert.equal((html.match(/<ul\b/g) || []).length, 3, "one list per role and certification list");
  assert.equal((html.match(/<li\b/g) || []).length, 5);
  assert.ok(html.includes("break-inside:avoid;page-break-inside:avoid"));
});

test("education uses Degree | Institution | Sem - N | Expected YYYY and restores source-only details", () => {
  const entry = { degree: "Bachelor of Computer Applications (BCA)", institution: "Chandigarh University", semester: "5", expected_completion: "2027" };
  const expected = "Bachelor of Computer Applications (BCA) | Chandigarh University | Sem - 5 | Expected 2027";
  assert.equal(exportBlocks(canonicalResume({ ...source, education: [entry] })).at(-1)?.text, expected);
  assert.equal(exportBlocks(canonicalResume({ ...source, education: [{ ...entry, semester: 5, expected_completion: "Expected : 2027" }] })).at(-1)?.text, expected);
  const generated = { ...source, education: [{ degree: entry.degree, institution: "chandigarh university", expected_completion: "2027" }] };
  const restored = canonicalResume(generated, {}, { ...source, education: [entry] });
  assert.equal(exportBlocks(restored).at(-1)?.text, "Bachelor of Computer Applications (BCA) | chandigarh university | Sem - 5 | Expected 2027");
  assert.equal(canonicalResume(generated, {}, { ...source, education: [{ ...entry, institution: "Other University" }] }).education, generated.education,
    "details are never copied from a different institution");
  assert.equal(exportBlocks(canonicalResume({ ...source, education: [{ degree: "BSc", institution: "Example University" } as ResumeData["education"][number]] })).at(-1)?.text,
    "BSc | Example University", "no semester or date is invented");
});

test("Standard preview renders sections in canonical order so PDF text validation passes", () => {
  const blocks = exportBlocks(canonicalResume(source));
  assert.deepEqual(exportSections(blocks), ["header", "summary", "skills", "certifications", "experience", "projects", "education"]);
  // Mirrors App's Standard preview: one section-only render per section, concatenated in the given order.
  const standardText = (order: string[]) => order.map(section => renderToStaticMarkup(createElement(AtsResume, {
    blocks: blocks.filter(block => block.section === section), masked: false, sectionOnly: true, sectionStyle: () => ({}),
  }))).join("").replace(/<[^>]+>/g, "\n");
  const expected = blocks.map(block => block.text).join("\n");
  assert.deepEqual(validateExportText(expected, [standardText(exportSections(blocks))]).errors, []);
  // The previously hard-coded preview order reproduces the reported download failure.
  assert.match(validateExportText(expected, [standardText(["header", "summary", "skills", "experience", "projects", "certifications", "education"])]).errors[0],
    /^Reading order or duplicate content mismatch: Work Experience/);
});
