import React from 'react';
import {
  CURATED_TRENDS_REVIEWED,
  TREND_COVERAGE_METHOD,
  type TrendCoverageEntry,
  type TrendCoverageReport,
} from '../lib/linkedinTrends';

interface LinkedInTrendsCardProps {
  /** resume.linkedin_trends. Anything the pipeline did not write renders nothing. */
  report: unknown;
  isDarkMode: boolean;
}

type SectionKey = 'used' | 'available' | 'gaps' | 'unsupported';

const SECTIONS: { key: SectionKey; title: string; hint: string; tone: string }[] = [
  {
    key: 'used',
    title: 'In this resume',
    hint: 'Trending skills your own material supports, named in this resume.',
    tone: 'bg-emerald-500/10 text-emerald-500 border-emerald-500/20',
  },
  {
    key: 'available',
    title: 'Supported, not used',
    hint: 'Your material shows these, but this resume does not name them. Mention one only where it fits the job.',
    tone: 'bg-sky-500/10 text-sky-500 border-sky-500/20',
  },
  {
    key: 'gaps',
    title: 'Trending gaps',
    hint: 'Trending for this role but not in your material, so they were left out. Add one to your master resume only if it is true.',
    tone: 'bg-amber-500/10 text-amber-500 border-amber-500/20',
  },
  {
    key: 'unsupported',
    title: 'Check before sending',
    hint: 'Named in this resume, but your material does not show it. Remove it, or add the evidence to your master resume.',
    tone: 'bg-rose-500/10 text-rose-500 border-rose-500/20',
  },
];

const isStringList = (value: unknown): value is string[] =>
  Array.isArray(value) && value.every((item) => typeof item === 'string');

/** The report when the pipeline wrote it; null for anything else, such as an object the model made up. */
function readReport(value: unknown): TrendCoverageReport | null {
  if (!value || typeof value !== 'object') return null;
  const report = value as Partial<TrendCoverageReport>;
  if (report.method !== TREND_COVERAGE_METHOD || !Array.isArray(report.entries)) return null;
  if (![report.used, report.available, report.gaps, report.unsupported, report.removed].every(isStringList)) return null;
  return report as TrendCoverageReport;
}

function chipTitle(section: SectionKey, entry: TrendCoverageEntry | undefined): string {
  if (section === 'gaps') return 'Not found in your material';
  const terms = section === 'unsupported' ? entry?.found : entry?.evidence;
  const list = isStringList(terms) ? terms.join(', ') : '';
  if (section === 'unsupported') return list ? `Named in this resume as: ${list}` : 'Named in this resume';
  return list ? `In your material as: ${list}` : 'In your material';
}

/**
 * How the resume follows the curated LinkedIn trends for the target role: the
 * trending skills it names, the supported ones it could still name, the gaps
 * (never inserted) and any mention the candidate's material does not support.
 */
export const LinkedInTrendsCard: React.FC<LinkedInTrendsCardProps> = ({ report: value, isDarkMode }) => {
  const report = readReport(value);
  if (!report) return null;
  const entries = new Map<string, TrendCoverageEntry>();
  for (const entry of report.entries) {
    if (entry && typeof entry === 'object' && typeof entry.name === 'string') entries.set(entry.name, entry);
  }
  const coverage = typeof report.coverage === 'number' && Number.isFinite(report.coverage) ? report.coverage : null;
  const tone = coverage === null ? 'opacity-50' : coverage >= 70 ? 'text-emerald-500' : coverage >= 45 ? 'text-amber-500' : 'text-rose-500';
  const label = typeof report.label === 'string' && report.label ? report.label : 'the target role';
  const asOf = typeof report.as_of === 'string' && report.as_of ? report.as_of : CURATED_TRENDS_REVIEWED;
  const supported = report.used.length + report.available.length;
  const sections = SECTIONS.filter((section) => report[section.key].length > 0);
  return (
    <div className={`p-4 rounded-xl border ${isDarkMode ? 'glass-panel border-white/10' : 'glass-panel-light border-black/5'}`}>
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <h3 className={`text-xs font-bold uppercase tracking-widest ${isDarkMode ? 'text-blue-400' : 'text-blue-700'}`}>LinkedIn Trends</h3>
          <p className="text-[10px] mt-1 opacity-70 truncate" title={`Curated LinkedIn trends for ${label} (reviewed ${asOf})`}>
            Curated LinkedIn trends for {label} (reviewed {asOf})
          </p>
          <p className="text-[10px] mt-0.5 opacity-50">
            Only trending skills your own material supports are used &middot; gaps are never added for you
          </p>
        </div>
        <div className="text-right whitespace-nowrap">
          <span className="text-[10px] uppercase tracking-widest opacity-60 block">Supported used</span>
          <span className={`text-sm font-bold tabular-nums ${tone}`}>
            {coverage === null ? 'None yet' : `${coverage}%`}
          </span>
          {supported > 0 && (
            <span className="text-[10px] opacity-50 block tabular-nums">{report.used.length} of {supported}</span>
          )}
        </div>
      </div>
      <div className="mt-3 pt-3 border-t border-white/10 space-y-3">
        {supported === 0 && (
          <p className="text-[10px] opacity-70">
            Your material does not show any of the trending skills for this role yet, so none were named.
          </p>
        )}
        {sections.map((section) => (
          <div key={section.key} className="text-[10px]">
            <p className="font-bold uppercase tracking-wider opacity-80">
              {section.title} <span className="opacity-50 tabular-nums">({report[section.key].length})</span>
            </p>
            <p className="mt-0.5 opacity-50">{section.hint}</p>
            <div className="mt-1.5 flex flex-wrap gap-1">
              {report[section.key].map((name, idx) => (
                <span
                  key={`${section.key}-${name}-${idx}`}
                  className={`px-1.5 py-px rounded border ${section.tone}`}
                  title={chipTitle(section.key, entries.get(name))}
                >
                  {name}
                </span>
              ))}
            </div>
          </div>
        ))}
        {report.removed.length > 0 && (
          <details className="text-[10px]">
            <summary className="cursor-pointer opacity-60">
              {report.removed.length} skills {report.removed.length === 1 ? 'entry' : 'entries'} removed - your material does not show {report.removed.length === 1 ? 'it' : 'them'}
            </summary>
            <ul className="mt-1 space-y-0.5">
              {report.removed.map((entry, idx) => (
                <li key={idx} className="opacity-40 italic truncate" title={entry}>&ldquo;{entry}&rdquo;</li>
              ))}
            </ul>
          </details>
        )}
      </div>
    </div>
  );
};
