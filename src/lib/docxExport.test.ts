import assert from "node:assert/strict";
import test from "node:test";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import JSZip from "jszip";
import { createResumeDOCX } from "./docxExport";
import { canonicalResume, exportBlocks, groupExportUnits } from "./atsDocument";
import type { AtsDocument } from "./atsDocument";
import { validateExportText } from "./exportValidation";

const resume: AtsDocument = {
  personal_info: { name: "Jordan Candidate", email: "jordan@example.org", phone: "+1 555 123 4567", location: "Seattle",
    linkedin: "https://www.linkedin.com/in/jordan-candidate" },
  summary: "Configured efficient workflows.",
  skills: { Infrastructure: ["Azure", "Bicep"] },
  experience: [{ role: "Engineer", company: "Example & Co", duration: "2018 - 2020", bullets: ["Defined firewalls and office workflows."] }],
  projects: [{ title: "Platform", description: "Reliable infrastructure" }],
  certifications: ["Azure Fundamentals"],
  education: [{ degree: "BSc", institution: "Example University", duration: "2014 - 2018" }],
};

const decode = (value: string) => value.replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">")
  .replace(/&quot;/g, '"').replace(/&apos;/g, "'");

test("DOCX XML has canonical body content, built-in headings, real bullets and one plain section", async () => {
  const blocks = exportBlocks(resume);
  const blob = await createResumeDOCX(resume, blocks);
  const bytes = await blob.arrayBuffer();
  const zip = await JSZip.loadAsync(bytes);
  const xml = await zip.file("word/document.xml")!.async("string");
  const styles = await zip.file("word/styles.xml")!.async("string");
  const core = await zip.file("docProps/core.xml")!.async("string");
  const relationships = await zip.file("word/_rels/document.xml.rels")!.async("string");
  const paragraphs = [...xml.matchAll(/<w:p\b[^>]*>([\s\S]*?)<\/w:p>/g)].map(match =>
    [...match[1].matchAll(/<w:t\b[^>]*>([\s\S]*?)<\/w:t>/g)].map(item => decode(item[1])).join(""));
  assert.deepEqual(validateExportText(blocks.map(block => block.text).join("\n"), [paragraphs.join("\n")]).errors, []);
  assert.ok(!/<w:(?:tbl|txbxContent|drawing|pict|headerReference|footerReference)\b/.test(xml));
  assert.equal((xml.match(/<w:sectPr\b/g) || []).length, 1);
  assert.equal((xml.match(/<w:pStyle w:val="Heading1"/g) || []).length, 6);
  assert.ok(xml.includes("<w:numPr>"));
  assert.ok(xml.includes('w:sz w:val="22"'));
  assert.ok(styles.includes('w:ascii="Calibri"'));
  assert.ok(xml.includes('w:color w:val="000000"'));
  assert.ok(relationships.includes(resume.personal_info.linkedin));
  assert.ok(xml.includes("<w:hyperlink"));
  const allParagraphXML = [...xml.matchAll(/<w:p\b[^>]*>([\s\S]*?)<\/w:p>/g)].map(match => match[1]);
  const roleIndex = paragraphs.findIndex(paragraph => paragraph.startsWith("Engineer"));
  assert.equal(paragraphs[roleIndex + 1], "Example & Co", "company is the line after the role");
  assert.ok(allParagraphXML[roleIndex].includes('<w:tab w:val="right" w:pos="10092"'));
  assert.ok(allParagraphXML[roleIndex].includes("<w:tab/>"));
  for (const [index, value] of [[roleIndex, "Engineer"], [roleIndex + 1, "Example &amp; Co"]] as const) {
    const run = [...allParagraphXML[index].matchAll(/<w:r\b[^>]*>([\s\S]*?)<\/w:r>/g)].find(match => match[1].includes(`>${value}</w:t>`));
    assert.ok(run?.[1].includes("<w:b/>"), value);
  }
  const project = allParagraphXML[paragraphs.indexOf("Platform")];
  assert.ok(project.includes("<w:b/>"), "project title is bold");
  assert.ok(paragraphs.indexOf("Azure Fundamentals") < roleIndex, "certifications precede work experience");
  assert.ok(xml.includes(">linkedin.com/in/jordan-candidate</w:t>"));
  assert.ok(!xml.includes(">https://www.linkedin.com"));
  assert.ok(xml.includes('<w:jc w:val="center"'));
  assert.ok([...xml.matchAll(/<w:r\b[^>]*>([\s\S]*?)<\/w:r>/g)]
    .some(match => match[1].includes("<w:b/>") && match[1].includes(">Infrastructure:</w:t>")));
  assert.ok(core.includes("Jordan Candidate - Resume"));
  assert.ok(!core.includes("Example &amp; Co"));
  for (const filename of Object.keys(zip.files).filter(name => /word\/(?:header|footer)\d*\.xml$/.test(name))) {
    const text = await zip.file(filename)!.async("string");
    assert.ok(!text.includes("jordan@example.org"), "contacts are never stored in headers or footers");
  }
  if (process.env.ATS_EXPORT_ARTIFACT_DIR) {
    await mkdir(process.env.ATS_EXPORT_ARTIFACT_DIR, { recursive: true });
    await writeFile(path.join(process.env.ATS_EXPORT_ARTIFACT_DIR, "ats-canonical.docx"), Buffer.from(bytes));
    await writeFile(path.join(process.env.ATS_EXPORT_ARTIFACT_DIR, "ats-document.xml"), xml);
  }
});

test("DOCX exports reject PII masking and metadata strips control characters", async () => {
  await assert.rejects(createResumeDOCX(resume, undefined, true), /PII masking/);
  const blob = await createResumeDOCX({ ...resume, personal_info: { ...resume.personal_info, name: "Jordan\u0000 Candidate" } });
  const zip = await JSZip.loadAsync(await blob.arrayBuffer());
  const core = await zip.file("docProps/core.xml")!.async("string");
  assert.ok(core.includes("Jordan Candidate - Resume"));
  assert.ok(!core.includes("\u0000"));
});

test("full master DOCX preserves every block and uses bold employment runs, right tabs and body-only contacts", async () => {
  const master = canonicalResume(JSON.parse(await readFile(path.join(process.cwd(), "src", "services", "master_resume.json"), "utf8")));
  const blocks = exportBlocks(master);
  const bytes = await (await createResumeDOCX(master, blocks)).arrayBuffer();
  const zip = await JSZip.loadAsync(bytes);
  const xml = await zip.file("word/document.xml")!.async("string");
  const paragraphXML = [...xml.matchAll(/<w:p\b[^>]*>([\s\S]*?)<\/w:p>/g)].map(match => match[1]);
  let paragraphIndex = 0;
  for (const unit of groupExportUnits(blocks)) {
    unit.blocks.forEach((_, index) => {
      const paragraph = paragraphXML[paragraphIndex++];
      assert.ok(paragraph.includes("<w:keepLines/>"), `${unit.unit}: all paragraphs keep their lines`);
      assert.equal(paragraph.includes("<w:keepNext/>"), index < unit.blocks.length - 1,
        `${unit.unit}: only the last paragraph ends the keep-together chain`);
    });
  }
  const paragraphs = paragraphXML.map(paragraph => [...paragraph.matchAll(/<w:t\b[^>]*>([\s\S]*?)<\/w:t>/g)].map(item => decode(item[1])).join(""));
  assert.deepEqual(validateExportText(blocks.map(block => block.text).join("\n"), [paragraphs.join("\n")]).errors, []);
  assert.ok(!/<w:(?:tbl|txbxContent|drawing|pict|headerReference|footerReference)\b/.test(xml));
  assert.equal((xml.match(/<w:sectPr\b/g) || []).length, 1);
  assert.equal((xml.match(/<w:tab w:val="right"/g) || []).length, master.experience.length);
  for (const role of master.experience) {
    const index = paragraphXML.findIndex(value => decode(value).includes(`>${role.role}</w:t>`));
    assert.ok(index >= 0, role.role);
    for (const [paragraph, value] of [[paragraphXML[index], role.role], [paragraphXML[index + 1], role.company]]) {
      assert.ok([...paragraph.matchAll(/<w:r\b[^>]*>([\s\S]*?)<\/w:r>/g)]
        .some(match => match[1].includes("<w:b/>") && decode(match[1]).includes(value)), value);
    }
  }
  assert.ok(xml.includes(master.personal_info.email));
  for (const name of Object.keys(zip.files).filter(name => /word\/(?:header|footer)\d*\.xml$/.test(name))) {
    const part = await zip.file(name)!.async("string");
    for (const value of Object.values(master.personal_info)) if (value) assert.ok(!part.includes(value));
  }
  if (process.env.ATS_EXPORT_ARTIFACT_DIR) {
    await writeFile(path.join(process.env.ATS_EXPORT_ARTIFACT_DIR, "ats-master.docx"), Buffer.from(bytes));
    await writeFile(path.join(process.env.ATS_EXPORT_ARTIFACT_DIR, "ats-master-document.xml"), xml);
  }
});
