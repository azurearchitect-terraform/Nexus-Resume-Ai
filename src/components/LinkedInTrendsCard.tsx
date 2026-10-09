import React from 'react';
import {
  CURATED_TRENDS_REVIEWED,
  TREND_COVERAGE_METHOD,
  type TrendCoverageEntry,
  type TrendCoverageReport,
  describeTrendSource,
  trendsFromReport,
} from '../lib/linkedinTrends';
import { readMarketMetadata } from '../lib/jobMarketTrends';
import { readImportMetadata } from '../lib/trendImportMetadata';

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
  // The report may come from storage or the model: read both source blocks through their validators.
  const market = readMarketMetadata(report.market);
  const imported = readImportMetadata(report.imported);
  const source = describeTrendSource(trendsFromReport(report)) || `Curated skills for ${label} (reviewed ${asOf})`;
  const title = imported ? 'LinkedIn Trends (imported)' : market ? 'Job Market Trends' : 'Skill Trends (curated catalogue)';
  const hasSignals = imported?.signals.some((s) => s.rank !== null || s.growth !== null || s.share !== null) ?? false;
  return (
    <div className={`p-4 rounded-xl border ${isDarkMode ? 'glass-panel border-white/10' : 'glass-panel-light border-black/5'}`}>
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <h3 className={`text-xs font-bold uppercase tracking-widest ${isDarkMode ? 'text-blue-400' : 'text-blue-700'}`}>{title}</h3>
          <p className="text-[10px] mt-1 opacity-70" title={source}>
            {source}
          </p>
          {imported && (
            <div className="text-[10px] mt-1 opacity-70 space-y-0.5">
              <p>
                Source: {imported.source} &middot; Published: {imported.published_at} &middot; Region: {imported.region} &middot; Role: {imported.role}
              </p>
              <p>
                Imported {imported.imported_at.slice(0, 10)} &middot; {imported.used} of {imported.rows} skills used &middot; supplied by you,
                not verified by Nexus &middot; you confirmed permission to use it on {imported.permission_confirmed_at.slice(0, 10)}.
              </p>
              {imported.warnings.length > 0 && <p>{imported.warnings.join(' ')}</p>}
            </div>
          )}
          {imported && hasSignals && (
            <details className="text-[10px] mt-2">
              <summary className="cursor-pointer">Numbers from your file (not resume coverage)</summary>
              <table className="mt-1 w-full text-left">
                <thead><tr><th>Skill</th><th>Rank</th><th>Growth</th><th>Share</th></tr></thead>
                <tbody>
                  {imported.signals.map((s) => (
                    <tr key={s.name}>
                      <td>{s.name}</td>
                      <td>{s.rank ?? '-'}</td>
                      <td>{s.growth === null ? '-' : `${s.growth > 0 ? '+' : ''}${s.growth}%`}</td>
                      <td>{s.share === null ? '-' : `${s.share}%`}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </details>
          )}
          {market && (
            <p className="text-[10px] mt-1 opacity-70">
              {market.remote_postings} postings mention remote work.
              {market.previous_sample_at
                ? ` Demand changes compare with ${market.previous_sample_at}.`
                : ' First or non-comparable sample: no growth trend claimed.'}
              {' '}{market.warnings.join(' ')}
            </p>
          )}
          {market && (
            <details className="text-[10px] mt-2">
              <summary className="cursor-pointer">Sampled skill demand (not resume coverage)</summary>
              <table className="mt-1 w-full text-left">
                <thead><tr><th>Skill</th><th>Postings</th><th>Sample share</th><th>Change</th></tr></thead>
                <tbody>
                  {market.demand.filter(d => d.postings > 0).map(d => (
                    <tr key={d.name}>
                      <td>{d.name}</td><td>{d.postings}</td><td>{d.share}%</td>
                      <td>{d.change === null ? 'No baseline' : `${d.change > 0 ? '+' : ''}${d.change} pp`}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
              <p className="opacity-60 mt-1">pp = percentage-point change in sampled posting share, not total market growth.</p>
            </details>
          )}
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
