import { ATS_FONTS, exportBlocks, hasYearOnlyDates } from "./atsDocument";
import type { AtsDocument, ExportBlock } from "./atsDocument";
import { parseDurationRange } from "./bulletBudget";

export interface CompatibilityIssue {
  severity: "warning" | "info" | "error";
  message: string;
}

export function checkAtsCompatibility(resume: AtsDocument, blocks: ExportBlock[], options: {
  masked?: boolean; font?: string; sizePt?: number; scale?: number;
} = {}): CompatibilityIssue[] {
  const issues: CompatibilityIssue[] = [];
  const add = (severity: CompatibilityIssue["severity"], message: string) => issues.push({ severity, message });
  const info = resume.personal_info;
  if (!info.name.trim()) add("warning", "Candidate name is missing.");
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(info.email)) add("warning", "Email address is missing or invalid.");
  if (!info.phone.trim()) add("warning", "Phone number is missing.");
  if (!info.location.trim()) add("warning", "Location is missing.");
  const ranges = resume.experience.map((role, index) => {
    if (!role.company?.trim()) add("warning", `Employment ${index + 1}: company is missing.`);
    if (!role.role?.trim()) add("warning", `Employment ${index + 1}: job title is missing.`);
    const range = parseDurationRange(role.duration);
    if (!range) add("warning", `Employment ${index + 1}: dates are missing or unreadable. Verify the source.`);
    else if (hasYearOnlyDates(role.duration)) {
      add("warning", `Employment ${index + 1}: year-only dates are preserved. Confirm months in the application; do not infer them.`);
    }
    return range;
  });
  ranges.forEach((range, index) => {
    if (!range) return;
    ranges.slice(index + 1).forEach((other, offset) => {
      if (other && Math.max(range.start.getTime(), other.start.getTime()) < Math.min(range.end.getTime(), other.end.getTime())) {
        add("info", `Employment ${index + 1} and ${index + offset + 2} overlap. Concurrent roles may be valid; verify the dates.`);
      }
    });
  });
  resume.education.forEach((entry, index) => {
    if (typeof entry === "string") add("info", `Education ${index + 1}: verify institution, degree and dates against the source; free text is not field-verified.`);
    else {
      const education = (entry || {}) as Record<string, unknown>;
      if (!education.degree || !(education.institution || education.school)) add("warning", `Education ${index + 1}: degree or institution is missing.`);
      if (!(education.duration || education.graduation_date || education.expected_completion)) add("info", `Education ${index + 1}: supply dates only if known.`);
    }
  });
  const content = blocks.map(block => block.text).join("\n");
  if (/\p{Extended_Pictographic}/u.test(content)) add("warning", "Emoji can interfere with text extraction; use plain text.");
  if (/[\uE000-\uF8FF\u{F0000}-\u{FFFFD}\u{100000}-\u{10FFFD}]/u.test(content)) add("warning", "Private-use characters may extract incorrectly.");
  if (/[\uFB00-\uFB06]/u.test(content)) add("warning", "Literal ligatures found. Replace them with ordinary letters.");
  if (/[•·●▪◦◆◇►➤✓✔★]/u.test(content)) {
    add("warning", "Decorative or embedded bullet characters found. Use the document's real list bullets.");
  }
  const font = (options.font || "Calibri").replace(/["']/g, "").split(",")[0].trim();
  if (!ATS_FONTS.some(name => name.toLowerCase() === font.toLowerCase())) add("warning", "Custom font: verify embedding and extraction, or use Calibri/Arial.");
  const size = (options.sizePt ?? 11) * (options.scale ?? 1);
  if (!Number.isFinite(size) || size < 10) add("warning", "Effective body text is below the recommended 10 pt readability floor.");
  if (options.masked || /\[(?:REDACTED|MASKED)\b/i.test(content)) add("error", "PII masking is enabled. PDF and DOCX exports are blocked.");
  return issues;
}

const normalize = (text: string) => text.normalize("NFKC").toLowerCase().replace(/[\u2010-\u2015]/g, "-").replace(/[^\p{L}\p{N}@.+#%$£€₹-]/gu, "");

export function validateExportText(expectedText: string, pages: string[], pageLimit = 2) {
  const blocks = expectedText.split(/\r?\n/).map(value => value.trim()).filter(value => normalize(value));
  const actual = normalize(pages.join("\n"));
  const report = { page_count: pages.length, blocks_checked: blocks.length, errors: [] as string[], warnings: [] as string[] };
  if (!blocks.length) report.errors.push("The resume has no readable text to validate.");
  if (!actual) report.errors.push("The exported document has no extractable text.");
  let cursor = 0;
  for (const block of blocks) {
    const token = normalize(block);
    const position = actual.indexOf(token, cursor);
    if (position < 0) report.errors.push(`${actual.includes(token) ? "Reading order or duplicate content mismatch" : "Missing or altered content"}: ${block.slice(0, 100)}`);
    else cursor = position + token.length;
  }
  pages.forEach((page, index) => {
    if (!normalize(page)) report.errors.push(`Page ${index + 1} has no extractable text.`);
    if (/[\uFB00-\uFB06]/u.test(page)) report.errors.push(`Page ${index + 1} contains extracted ligatures.`);
  });
  if (pages.length > pageLimit) report.warnings.push(`The document is ${pages.length} pages. Review length; do not shrink below readable text sizes.`);
  return report;
}

export function plainResumeText(resume: AtsDocument): string {
  return exportBlocks(resume).map(block => block.kind === "bullet" ? `- ${block.text}` : block.text).join("\n");
}
