import type { MasterResume } from "../types";
import { computeMatchScore, type MatchScoreOptions, type MatchScoreResult } from "./matchScore";

export function masterResumeText(data: MasterResume["data"]): string {
  return typeof data === "string" ? data : JSON.stringify(data, null, 2);
}

export const EDITOR_CANDIDATE_ID = "__editor__";

export interface MasterComparison {
  id: string;
  name: string;
  text: string;
  analysis: MatchScoreResult;
  /** This candidate is the text currently in the editor, not a saved master's stored content. */
  fromEditor: boolean;
}

function canonicalResume(text: string): string {
  try {
    return JSON.stringify(JSON.parse(text));
  } catch {
    return text.replace(/\s+/g, " ").trim();
  }
}

/** The editor holds text that differs from the selected master as saved (or matches no saved master). */
export function hasUnsavedEdits(selected: MasterResume | undefined, editorText: string): boolean {
  if (!editorText.trim()) return false;
  if (!selected) return true;
  return canonicalResume(editorText) !== canonicalResume(masterResumeText(selected.data));
}

/**
 * Score every saved master against the job description, best first.
 *
 * The editor's text stands in for the selected master (it may carry edits), and competes
 * as its own candidate when no saved master is selected. Returns an empty list - never
 * throws - when there is nothing to score, so a selection problem cannot block an
 * optimization of the text already in the editor.
 */
export function compareMasterResumes(
  masters: MasterResume[],
  jd: string,
  selectedId: string,
  currentText: string,
  options: MatchScoreOptions = {}
): MasterComparison[] {
  if (!jd.trim()) return [];
  const comparisons: MasterComparison[] = [];
  const hasEditorText = currentText.trim().length > 0;
  for (const master of masters) {
    const fromEditor = master.id === selectedId && hasEditorText;
    const text = fromEditor ? currentText : masterResumeText(master.data);
    const analysis = computeMatchScore(text, jd, options);
    if (analysis) comparisons.push({ id: master.id, name: master.name, text, analysis, fromEditor });
  }
  if (hasEditorText && !masters.some((master) => master.id === selectedId)) {
    const analysis = computeMatchScore(currentText, jd, options);
    if (analysis) {
      comparisons.push({ id: EDITOR_CANDIDATE_ID, name: "Current editor text", text: currentText, analysis, fromEditor: true });
    }
  }
  const isCurrent = (candidate: MasterComparison) => candidate.fromEditor || candidate.id === selectedId;
  return comparisons.sort((a, b) =>
    b.analysis.score - a.analysis.score || Number(isCurrent(b)) - Number(isCurrent(a))
  );
}

export interface MasterSourceDecision {
  comparison: MasterComparison[];
  /** The resume to optimize; null when nothing could be scored (optimize the editor text as before). */
  best: MasterComparison | null;
  /** Move the editor and the selected master to `best`; false when that would discard the user's unsaved edits. */
  syncEditor: boolean;
}

export function selectMasterSource(
  masters: MasterResume[],
  jd: string,
  selectedId: string,
  editorText: string,
  options: MatchScoreOptions = {}
): MasterSourceDecision {
  const comparison = compareMasterResumes(masters, jd, selectedId, editorText, options);
  const best = comparison[0] ?? null;
  const selected = masters.find((master) => master.id === selectedId);
  return {
    comparison,
    best,
    syncEditor: best !== null && !best.fromEditor && !hasUnsavedEdits(selected, editorText),
  };
}
