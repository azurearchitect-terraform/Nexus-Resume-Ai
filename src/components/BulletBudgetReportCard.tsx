import React from 'react';
import type { BulletBudgetReport } from '../lib/bulletBudget';
import { describeBudgetReport, type ReportBadge } from '../lib/bulletRulesPreview';

interface BulletBudgetReportCardProps {
  report: BulletBudgetReport;
  isDarkMode: boolean;
}

const STATUS_TONE: Record<string, string> = {
  within: 'text-emerald-500',
  trimmed: 'text-amber-500',
  under: 'text-sky-500',
  unbudgeted: 'opacity-50',
};

const STATUS_LABEL: Record<string, string> = {
  within: 'Within',
  trimmed: 'Trimmed',
  under: 'Under',
  unbudgeted: 'Model decided',
};

const STATUS_HINT: Record<string, string> = {
  within: 'Inside the budget for this tenure.',
  trimmed: 'The model wrote more than the ceiling; the weakest bullets were removed.',
  under: 'Fewer bullets than the budget. The platform never pads a role - add more detail about this role to your resume to reach it.',
  unbudgeted: 'The dates could not be read, so the count was left to the model (never more than the maximum).',
};

/** Hints for a role whose count one of the candidate's Bullet Rules set. */
const RULE_STATUS_HINT: Record<string, string> = {
  within: 'Inside the range your Bullet Rules set.',
  trimmed: 'The model wrote more than your Bullet Rules allow; the weakest bullets were removed.',
  under: 'Fewer bullets than your Bullet Rules ask for. Bullets are never invented - add more detail about this role to your resume to reach it.',
};

const BADGE_TONES: Record<ReportBadge, string> = {
  pinned: 'bg-violet-500/10 text-violet-500 border-violet-500/20',
  recent: 'bg-emerald-500/10 text-emerald-500 border-emerald-500/20',
  platform: 'bg-sky-500/10 text-sky-500 border-sky-500/20',
  system: 'bg-gray-500/10 border-gray-500/20',
};

/**
 * Per-role bullet budgets of a generated resume. When the candidate's Bullet
 * Rules decided them, each role is badged with the rule (or "System") that set
 * its count; a tenure-only report renders exactly as it always has.
 */
export const BulletBudgetReportCard: React.FC<BulletBudgetReportCardProps> = ({ report, isDarkMode }) => {
  const rulesView = describeBudgetReport(report);
  const notes = rulesView ? [rulesView.platformNote, rulesView.pageFitNote].filter((note): note is string => !!note) : [];
  return (
    <div className={`p-4 rounded-xl border ${isDarkMode ? 'glass-panel border-white/10' : 'glass-panel-light border-black/5'}`}>
      <div className="flex items-start justify-between gap-3">
        <div>
          <h3 className={`text-xs font-bold uppercase tracking-widest ${isDarkMode ? 'text-teal-400' : 'text-teal-700'}`}>Bullet Budget</h3>
          <p className="text-[10px] mt-1 opacity-70">
            {rulesView ? 'Bullets follow your Bullet Rules, then tenure' : 'Bullets per role follow tenure, then recency'} &middot;{' '}
            {report.trimmed > 0
              ? `${report.trimmed} over-budget bullet${report.trimmed === 1 ? '' : 's'} removed`
              : 'nothing removed'}
          </p>
          {notes.map((note, idx) => (
            <p key={idx} className="text-[10px] mt-0.5 opacity-50">{note}</p>
          ))}
        </div>
        <span className={`text-[10px] font-bold uppercase tracking-widest whitespace-nowrap ${report.compliant ? 'text-emerald-500' : 'text-amber-500'}`}>
          {report.compliant ? 'Compliant' : 'Review'}
        </span>
      </div>
      <div className="mt-3 pt-3 border-t border-white/10 space-y-2">
        {report.roles.map((role, idx) => {
          const view = rulesView?.rows[idx] ?? null;
          const hint = (view && view.badge !== 'system' && RULE_STATUS_HINT[role.status]) || STATUS_HINT[role.status] || '';
          const label = (
            <span className="opacity-80 truncate" title={[role.role, role.company, role.duration].filter(Boolean).join(' \u00b7 ')}>
              {[role.role, role.company].filter(Boolean).join(' \u00b7 ') || `Role ${idx + 1}`}
              <span className="opacity-50"> &middot; {role.tenure_months !== null ? `${role.tenure_months} mo` : 'dates unreadable'}</span>
            </span>
          );
          return (
            <div key={`${role.company}-${role.role}-${idx}`} className="text-[10px]">
              <div className="flex items-center justify-between gap-3">
                {view ? (
                  <span className="flex items-center gap-1.5 min-w-0">
                    <span
                      className={`shrink-0 px-1.5 py-px rounded border text-[9px] font-bold uppercase tracking-wider ${BADGE_TONES[view.badge]}`}
                      title={view.badgeTitle}
                    >
                      {view.badgeText}
                    </span>
                    {label}
                  </span>
                ) : (
                  label
                )}
                <span className="font-bold tabular-nums whitespace-nowrap" title={`${role.reason}. ${hint}`}>
                  {role.delivered} / {role.budget ?? `max ${role.max}`}
                  <span className={`ml-2 uppercase tracking-wider ${STATUS_TONE[role.status] || ''}`}>
                    {STATUS_LABEL[role.status] || role.status}
                  </span>
                </span>
              </div>
              {view?.fitFrom && <p className="mt-0.5 opacity-50">Trimmed for 2-page fit (was {view.fitFrom})</p>}
              {view?.underNote && <p className="mt-0.5 text-sky-500">{view.underNote}</p>}
              {role.removed.length > 0 && (
                <details className="mt-1">
                  <summary className="cursor-pointer opacity-50">
                    {role.removed.length} removed to fit the budget
                  </summary>
                  <ul className="mt-1 space-y-0.5">
                    {role.removed.map((bullet, bIdx) => (
                      <li key={bIdx} className="opacity-40 italic truncate" title={bullet}>&ldquo;{bullet}&rdquo;</li>
                    ))}
                  </ul>
                </details>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
};
