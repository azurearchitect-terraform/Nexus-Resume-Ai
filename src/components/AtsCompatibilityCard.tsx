import type { CompatibilityIssue } from "../lib/exportValidation";

export function AtsCompatibilityCard({ issues, masked, onCopy }: {
  issues: CompatibilityIssue[]; masked: boolean; onCopy: () => void;
}) {
  return <section className="p-3 border-b border-black/10 dark:border-white/10 text-xs space-y-2" aria-label="ATS compatibility checks">
    <h3 className="font-bold">Greenhouse + Workday compatibility</h3>
    <p>Single-column body text, standard headings, real bullets and full contact details. DOCX uses Calibri 11 pt; PDF uses locally installed fonts with ligatures disabled.</p>
    <details>
      <summary className="cursor-pointer font-semibold">{issues.length ? `${issues.length} source/layout checks to review` : "No compatibility warnings detected"}</summary>
      <ul className="list-disc pl-5 mt-2 space-y-1">
        {issues.map((issue, index) => <li key={index}><strong>{issue.severity === "info" ? "Review" : issue.severity === "error" ? "Blocked" : "Warning"}:</strong> {issue.message}</li>)}
      </ul>
      <p className="mt-2">Verify every autofilled employer, job title, date, institution and degree before applying. Follow the employer portal's accepted file types and size limit. Missing dates and eligibility answers must never be inferred.</p>
    </details>
    {masked && <p role="alert" className="font-semibold">Turn off PII masking before copying or exporting.</p>}
    <button type="button" disabled={masked} onClick={onCopy} className="border rounded px-2 py-1 disabled:opacity-50">Copy plain resume text</button>
    <p className="opacity-60">Compatibility guidance, not ATS certification or a guarantee of parsing or hiring outcomes.</p>
  </section>;
}
