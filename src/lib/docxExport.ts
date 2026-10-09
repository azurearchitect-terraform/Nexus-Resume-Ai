import { AlignmentType, Document, ExternalHyperlink, HeadingLevel, Packer, Paragraph, Tab, TabStopType, TextRun } from "docx";
import { assertUnmaskedExport, exportBlocks, groupExportUnits, sanitizedMetadata } from "./atsDocument";
import type { AtsDocument, ExportBlock } from "./atsDocument";

function runs(block: ExportBlock): (TextRun | ExternalHyperlink)[] {
  const style = { font: "Calibri", color: "000000", size: block.kind === "name" ? 36 : block.kind === "heading" ? 24 : 22,
    bold: block.kind === "name" || block.kind === "heading" };
  if (block.employment) {
    const { title, dates } = block.employment;
    return [
      new TextRun({ text: title, ...style, bold: true }),
      new TextRun({ children: dates ? [new Tab(), dates] : [], ...style }),
    ];
  }
  if (block.employer || block.projectTitle) return [new TextRun({ text: block.text, ...style, bold: true })];
  if (block.skill) return [
    new TextRun({ text: `${block.skill.category}:`, ...style, bold: true }),
    new TextRun({ text: ` ${block.skill.items}`, ...style }),
  ];
  if (block.kind === "contact" && block.link && block.linkText) {
    const position = block.text.indexOf(block.linkText);
    return [
      new TextRun({ text: block.text.slice(0, position), ...style }),
      new ExternalHyperlink({ link: block.link, children: [new TextRun({ text: block.linkText, ...style })] }),
      new TextRun({ text: block.text.slice(position + block.linkText.length), ...style }),
    ];
  }
  return [new TextRun({ text: block.text, ...style })];
}

export async function createResumeDOCX(resume: AtsDocument, blocks = exportBlocks(resume), masked = false): Promise<Blob> {
  assertUnmaskedExport(masked, blocks);
  const name = sanitizedMetadata(resume.personal_info.name) || "Candidate";
  const document = new Document({
    creator: name,
    title: `${name} - Resume`,
    description: "Resume",
    styles: {
      default: { document: { run: { font: "Calibri", size: 22, color: "000000" }, paragraph: { spacing: { line: 300, after: 120 } } } },
      paragraphStyles: [{
        id: "Heading1", name: "Heading 1", basedOn: "Normal", next: "Normal",
        run: { font: "Calibri", size: 24, bold: true, color: "000000" },
        paragraph: { keepNext: true, outlineLevel: 0 },
      }],
    },
    sections: [{
      properties: { page: { size: { width: 11906, height: 16838 }, margin: { top: 907, bottom: 907, left: 907, right: 907 } } },
      children: groupExportUnits(blocks).flatMap(unit => unit.blocks.map((block, index) => new Paragraph({
        children: runs(block),
        ...(block.kind === "heading" ? { heading: HeadingLevel.HEADING_1 } : {}),
        ...(block.kind === "bullet" ? { bullet: { level: 0 } } : {}),
        ...(block.employment ? { tabStops: [{ type: TabStopType.RIGHT, position: 10092 }] } : {}),
        ...(block.section === "header" ? { alignment: AlignmentType.CENTER } : {}),
        keepNext: index < unit.blocks.length - 1,
        keepLines: true,
        spacing: { before: block.kind === "heading" ? 240 : 0, after: block.employment ? 0 : 120, line: 300 },
      }))),
    }],
  });
  return Packer.toBlob(document);
}
