import type { CSSProperties } from "react";
import type { ExportBlock } from "../lib/atsDocument";
import { exportSections, groupExportUnits } from "../lib/atsDocument";

export function AtsResume({ blocks, masked, sectionStyle, onSection, sectionOnly = false, activeSection }: {
  blocks: ExportBlock[]; masked: boolean;
  sectionStyle?: (section: string) => CSSProperties;
  onSection?: (section: string) => void;
  sectionOnly?: boolean;
  activeSection?: string | null;
}) {
  const standard = Boolean(sectionStyle);
  const units = groupExportUnits(blocks);
  const content = exportSections(blocks).map(section => <div key={section}
    className={`resume-section ${onSection ? "cursor-pointer transition-all rounded hover:bg-black/5" : ""} ${activeSection === section ? "bg-emerald-50/50 outline-dashed outline-1 outline-emerald-500/30" : ""}`}
    onClick={() => onSection?.(section)}
    style={{ marginBottom: "6pt", ...sectionStyle?.(section), ...(section === "header" ? { textAlign: "center" } : {}) }}>
    {units.filter(unit => unit.section === section).map(unit => <div key={unit.unit}
      className="resume-keep" data-keep-unit={unit.unit} style={{ display: "block", breakInside: "avoid", pageBreakInside: "avoid" }}>
    {unit.blocks.map((block, index) => {
      const style: CSSProperties = { margin: "0 0 4pt", overflowWrap: "break-word" };
      const content = masked && block.section === "header" ? (block.kind === "name" ? "[REDACTED NAME]" : "[REDACTED CONTACT]") :
        block.kind === "contact" && block.link && block.linkText ? <>
          {block.text.slice(0, block.text.indexOf(block.linkText))}
          <a href={block.link} style={{ color: "inherit", whiteSpace: "nowrap" }}>{block.linkText}</a>
          {block.text.slice(block.text.indexOf(block.linkText) + block.linkText.length)}
        </> : block.text;
      if (block.kind === "name") return <h1 key={index} style={{ ...style, fontSize: "18pt", fontWeight: "bold", breakAfter: "avoid" }}>{content}</h1>;
      if (block.kind === "heading") return <h2 key={index} style={{ ...style, fontSize: "12pt", fontWeight: "bold", breakAfter: "avoid",
        ...(standard ? { textTransform: "uppercase", borderBottom: "1px solid #000", paddingBottom: "2pt", letterSpacing: "0.05em" } : {}) }}>{content}</h2>;
      if (block.employment) {
        const { title, dates } = block.employment;
        return <div key={index} className="experience-heading" style={{ ...style, margin: 0, display: "flex", alignItems: "baseline", gap: "8pt", breakAfter: "avoid" }}>
          {title && <strong>{title}</strong>}
          {dates && <span style={{ marginLeft: "auto", whiteSpace: "nowrap", textAlign: "right" }}>{dates}</span>}
        </div>;
      }
      if (block.employer || block.projectTitle) return <p key={index} style={{ ...style, breakAfter: "avoid" }}><strong>{block.text}</strong></p>;
      if (block.skill) return <p key={index} style={style}><strong>{block.skill.category}:</strong> {block.skill.items}</p>;
      if (block.kind === "bullet") {
        if (unit.blocks[index - 1]?.kind === "bullet") return null;
        const bullets = unit.blocks.slice(index).findIndex(entry => entry.kind !== "bullet");
        const run = unit.blocks.slice(index, bullets < 0 ? undefined : index + bullets);
        return <ul key={index} style={{ paddingLeft: "18pt", margin: 0, listStyleType: "disc" }}>
          {run.map((entry, bulletIndex) => <li key={bulletIndex} style={{ ...style, breakInside: "avoid" }}>{entry.text}</li>)}
        </ul>;
      }
      return <p key={index} className={block.kind === "contact" ? "resume-contact" : undefined}
        style={{ ...style, ...(block.kind === "contact" ? { fontSize: "10.25pt", textAlign: "center" } : {}) }}>{content}</p>;
    })}
    </div>)}
  </div>);
  if (sectionOnly) return <>{content}</>;
  return <div className={`resume-page bg-white text-black ${standard ? "" : "ats-safe-resume"}`}
    style={{ width: "210mm", minHeight: "297mm", padding: "16mm", fontFamily: "Calibri, Arial, sans-serif", fontSize: "11pt", lineHeight: 1.25, letterSpacing: "normal" }}>
    {content}
  </div>;
}
