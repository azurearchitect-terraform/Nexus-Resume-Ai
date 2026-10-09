import React, { useEffect, useId, useMemo, useRef, useState } from 'react';
import { Clock, Cloud, Eye, ListChecks, Pin, Plus, RotateCcw, SlidersHorizontal, X } from 'lucide-react';
import {
  BULLET_RULE_LIMITS,
  defaultBulletRules,
  normalizeBulletRules,
  rolesFromResumeText,
  type BulletRange,
  type BulletRules,
  type PinnedCompanyRule,
} from '../lib/bulletBudget';
import { buildRulesPreview, pinRowStatus, splitKeywords, type PreviewRow } from '../lib/bulletRulesPreview';

interface BulletRulesSettingsProps {
  rules: BulletRules;
  onChange: (rules: BulletRules) => void;
  isDarkMode: boolean;
  /** The resume the optimizer will use; a JSON master resume enables the preview. */
  resumeText: string;
  jobDescription: string;
}

interface PinDraft extends PinnedCompanyRule {
  id: number;
}

const PER_ROLE_COUNTS = Array.from({ length: BULLET_RULE_LIMITS.maxBulletsPerRole }, (_, i) => i + 1);
const RECENT_COUNTS = Array.from({ length: BULLET_RULE_LIMITS.maxRecentCount + 1 }, (_, i) => i);

const BADGE_TONES: Record<PreviewRow['badge'], string> = {
  pinned: 'bg-violet-500/10 text-violet-500 border-violet-500/20',
  recent: 'bg-emerald-500/10 text-emerald-500 border-emerald-500/20',
  platform: 'bg-sky-500/10 text-sky-500 border-sky-500/20',
  tenure: 'bg-gray-500/10 border-gray-500/20',
  unreadable: 'bg-amber-500/10 text-amber-500 border-amber-500/20',
};

const cleanCompany = (text: string) => text.replace(/\s+/g, ' ').trim();

/** Two selects; raising the minimum past the maximum lifts the maximum, and vice versa. */
const RangeSelect: React.FC<{
  value: BulletRange;
  onChange: (range: BulletRange) => void;
  label: string;
  selectClass: string;
}> = ({ value, onChange, label, selectClass }) => (
  <span className="inline-flex items-center gap-1.5">
    <select
      aria-label={`${label}: minimum bullets`}
      value={value.min}
      onChange={(e) => {
        const min = Number(e.target.value);
        onChange({ min, max: Math.max(value.max, min) });
      }}
      className={selectClass}
    >
      {PER_ROLE_COUNTS.map((n) => <option key={n} value={n}>{n}</option>)}
    </select>
    <span className="opacity-50">to</span>
    <select
      aria-label={`${label}: maximum bullets`}
      value={value.max}
      onChange={(e) => {
        const max = Number(e.target.value);
        onChange({ min: Math.min(value.min, max), max });
      }}
      className={selectClass}
    >
      {PER_ROLE_COUNTS.map((n) => <option key={n} value={n}>{n}</option>)}
    </select>
    <span className="opacity-50">bullets</span>
  </span>
);

export const BulletRulesSettings: React.FC<BulletRulesSettingsProps> = ({
  rules,
  onChange,
  isDarkMode,
  resumeText,
  jobDescription,
}) => {
  const nextPinId = useRef(0);
  const newPinId = useRef<number | null>(null);
  const toDrafts = (pins: PinnedCompanyRule[]): PinDraft[] => pins.map((pin) => ({ ...pin, id: nextPinId.current++ }));
  // Text fields edit local drafts: normalizing on every keystroke would drop a
  // blank new row or a half-typed duplicate before the user finishes typing.
  const [pinDrafts, setPinDrafts] = useState<PinDraft[]>(() => toDrafts(rules.pinned));
  const [keywordDraft, setKeywordDraft] = useState(() => rules.platform.keywords.join(', '));
  const keywordsId = useId();

  // What this panel last committed. A different value arriving through props means
  // the rules were replaced elsewhere (profile load, another tab), so drafts reset.
  const pinsKey = JSON.stringify(rules.pinned);
  const keywordsKey = JSON.stringify(rules.platform.keywords);
  const committedPins = useRef(pinsKey);
  const committedKeywords = useRef(keywordsKey);
  useEffect(() => {
    if (pinsKey === committedPins.current) return;
    committedPins.current = pinsKey;
    setPinDrafts(toDrafts(rules.pinned));
  }, [pinsKey]);
  useEffect(() => {
    if (keywordsKey === committedKeywords.current) return;
    committedKeywords.current = keywordsKey;
    setKeywordDraft(rules.platform.keywords.join(', '));
  }, [keywordsKey]);

  const commit = (next: BulletRules): BulletRules => {
    const normalized = normalizeBulletRules(next) ?? defaultBulletRules();
    committedPins.current = JSON.stringify(normalized.pinned);
    committedKeywords.current = JSON.stringify(normalized.platform.keywords);
    onChange(normalized);
    return normalized;
  };
  const commitPins = (drafts: PinDraft[]) => {
    setPinDrafts(drafts);
    commit({ ...rules, pinned: drafts.map(({ company, min, max }) => ({ company, min, max })) });
  };
  const commitKeywords = () => {
    const next = commit({ ...rules, platform: { ...rules.platform, keywords: splitKeywords(keywordDraft) } });
    setKeywordDraft(next.platform.keywords.join(', '));
  };
  const setRecent = (patch: Partial<BulletRules['recent']>) => commit({ ...rules, recent: { ...rules.recent, ...patch } });
  const setPlatform = (patch: Partial<BulletRules['platform']>) =>
    commit({ ...rules, platform: { ...rules.platform, ...patch } });
  const setPageFit = (patch: Partial<BulletRules['pageFit']>) =>
    commit({ ...rules, pageFit: { ...rules.pageFit, ...patch } });
  const addPin = () => {
    const id = nextPinId.current++;
    newPinId.current = id;
    setPinDrafts([...pinDrafts, { id, company: '', min: 2, max: 2 }]);
  };
  const resetToDefaults = () => {
    const next = commit(defaultBulletRules());
    setPinDrafts(toDrafts(next.pinned));
    setKeywordDraft(next.platform.keywords.join(', '));
  };

  const roles = useMemo(() => rolesFromResumeText(resumeText), [resumeText]);
  const preview = useMemo(
    () => buildRulesPreview(rules, resumeText, jobDescription),
    [rules, resumeText, jobDescription]
  );
  const pinStatus = pinRowStatus(roles, pinDrafts.map((draft) => draft.company));

  const muted = isDarkMode ? 'opacity-50' : 'opacity-70';
  const card = `rounded-xl border p-4 transition-all ${isDarkMode ? 'bg-white/5 border-white/10' : 'bg-gray-50 border-black/5'}`;
  const cardTitle = 'text-[10px] font-black uppercase tracking-widest';
  const control = `text-xs border rounded-lg focus:outline-none focus:ring-2 focus:ring-emerald-500/20 focus:border-emerald-500 transition-all ${
    isDarkMode ? 'bg-black text-white border-white/10' : 'bg-white text-black border-black/10'
  }`;
  const selectClass = `${control} px-2 py-1`;
  const inputClass = `${control} px-3 py-1.5 ${isDarkMode ? 'placeholder-white/30' : 'placeholder-black/30'}`;
  const checkRow = 'flex items-center gap-2 text-[11px] font-bold cursor-pointer select-none';
  const divider = isDarkMode ? 'border-white/5' : 'border-black/5';

  return (
    <section className={`rounded-2xl border p-6 shadow-xl transition-colors ${isDarkMode ? 'glass-panel border-white/10' : 'glass-panel-light border-black/5'}`}>
      <div className="flex items-start justify-between gap-4 mb-2">
        <div className="flex items-center gap-2">
          <ListChecks className={`w-5 h-5 ${isDarkMode ? 'text-emerald-400' : 'text-emerald-600'}`} />
          <h2 className="font-semibold text-lg">Bullet Rules</h2>
        </div>
        <div className="flex items-center gap-3">
          <button
            type="button"
            onClick={resetToDefaults}
            className={`flex items-center gap-1.5 text-[10px] font-bold uppercase tracking-widest transition-opacity ${muted} hover:opacity-100`}
          >
            <RotateCcw className="w-3.5 h-3.5" />
            Reset
          </button>
          <button
            type="button"
            role="switch"
            aria-checked={rules.enabled}
            aria-label="Use my bullet rules"
            onClick={() => commit({ ...rules, enabled: !rules.enabled })}
            className={`relative inline-flex h-6 w-11 shrink-0 items-center rounded-full transition-colors ${
              rules.enabled ? 'bg-emerald-500' : isDarkMode ? 'bg-white/15' : 'bg-black/15'
            }`}
          >
            <span className={`inline-block h-5 w-5 rounded-full bg-white shadow transition-transform ${rules.enabled ? 'translate-x-5' : 'translate-x-0.5'}`} />
          </button>
        </div>
      </div>
      <p className={`text-xs mb-5 ${muted}`}>
        How many bullets each role gets. Your rules are checked in order and the first match wins; the system sizes
        every other role by tenure. Saved on this device, and synced to your profile when you are signed in.
      </p>

      <div className={`grid gap-4 md:grid-cols-2 transition-opacity ${rules.enabled ? '' : 'opacity-50'}`}>
        <div className={card}>
          <div className="flex items-center gap-2 mb-1">
            <Pin className="w-4 h-4 text-emerald-500" />
            <h3 className={cardTitle}>1. Pinned companies</h3>
          </div>
          <p className={`text-[11px] mb-3 ${muted}`}>A fixed count wherever the company appears, however it is spelled.</p>
          <div className="space-y-3">
            {pinDrafts.length === 0 && <p className={`text-[11px] ${muted}`}>No pinned companies.</p>}
            {pinDrafts.map((draft, i) => {
              const status = pinStatus[i];
              const hint =
                status.issue === 'empty'
                  ? draft.company.trim()
                    ? 'Not a usable company name - ignored.'
                    : 'Type a company name.'
                  : status.issue === 'duplicate'
                    ? 'Same company as a row above - ignored.'
                    : status.matches === null
                      ? null
                      : status.matches === 0
                        ? 'No role in the current resume matches.'
                        : `Matches ${status.matches} role${status.matches === 1 ? '' : 's'} in the current resume.`;
              const warn = status.issue !== null || status.matches === 0;
              return (
                <div key={draft.id}>
                  <div className="flex flex-wrap items-center gap-2">
                    <input
                      type="text"
                      value={draft.company}
                      maxLength={BULLET_RULE_LIMITS.maxTextLength}
                      placeholder="Company name"
                      aria-label={`Pinned company ${i + 1}`}
                      autoFocus={draft.id === newPinId.current}
                      onChange={(e) =>
                        setPinDrafts(pinDrafts.map((d) => (d.id === draft.id ? { ...d, company: e.target.value } : d)))
                      }
                      onBlur={() =>
                        commitPins(pinDrafts.map((d) => (d.id === draft.id ? { ...d, company: cleanCompany(d.company) } : d)))
                      }
                      onKeyDown={(e) => {
                        if (e.key === 'Enter') e.currentTarget.blur();
                      }}
                      className={`${inputClass} flex-1 min-w-[8rem]`}
                    />
                    <RangeSelect
                      value={draft}
                      label={`Pinned company ${i + 1}`}
                      selectClass={selectClass}
                      onChange={(range) => commitPins(pinDrafts.map((d) => (d.id === draft.id ? { ...d, ...range } : d)))}
                    />
                    <button
                      type="button"
                      aria-label={`Remove ${draft.company.trim() || `pinned company ${i + 1}`}`}
                      onClick={() => commitPins(pinDrafts.filter((d) => d.id !== draft.id))}
                      className={`p-1 rounded-md transition-colors ${isDarkMode ? 'hover:bg-white/10' : 'hover:bg-black/5'}`}
                    >
                      <X className="w-3.5 h-3.5" />
                    </button>
                  </div>
                  {hint && <p className={`text-[10px] mt-1 ${warn ? 'text-amber-500' : muted}`}>{hint}</p>}
                </div>
              );
            })}
          </div>
          <button
            type="button"
            onClick={addPin}
            disabled={pinDrafts.length >= BULLET_RULE_LIMITS.maxPinned}
            className="mt-3 flex items-center gap-1.5 text-[10px] font-bold uppercase tracking-widest text-emerald-500 disabled:opacity-40 disabled:cursor-not-allowed"
          >
            <Plus className="w-3.5 h-3.5" />
            Add company
          </button>
        </div>

        <div className={card}>
          <div className="flex items-center gap-2 mb-1">
            <Clock className="w-4 h-4 text-emerald-500" />
            <h3 className={cardTitle}>2. Most recent roles</h3>
          </div>
          <p className={`text-[11px] mb-3 ${muted}`}>By end date. A pinned company inside this window keeps its pinned count.</p>
          <label className={checkRow}>
            <input
              type="checkbox"
              className="accent-emerald-500"
              checked={rules.recent.enabled}
              onChange={(e) => setRecent({ enabled: e.target.checked })}
            />
            <span>Apply this rule</span>
          </label>
          <div className="mt-3 flex flex-wrap items-center gap-2 text-xs">
            <span>The</span>
            <select
              aria-label="Number of most recent roles"
              value={rules.recent.count}
              onChange={(e) => setRecent({ count: Number(e.target.value) })}
              className={selectClass}
            >
              {RECENT_COUNTS.map((n) => <option key={n} value={n}>{n}</option>)}
            </select>
            <span>most recent roles get</span>
            <RangeSelect value={rules.recent} label="Most recent roles" selectClass={selectClass} onChange={(range) => setRecent(range)} />
          </div>
        </div>

        <div className={card}>
          <div className="flex items-center gap-2 mb-1">
            <Cloud className="w-4 h-4 text-emerald-500" />
            <h3 className={cardTitle}>3. Platform experience</h3>
          </div>
          <p className={`text-[11px] mb-3 ${muted}`}>
            Any other role whose own title or bullets show the platform. Nothing is added to a role to make it match.
          </p>
          <div className="space-y-2">
            <label className={checkRow}>
              <input
                type="checkbox"
                className="accent-emerald-500"
                checked={rules.platform.enabled}
                onChange={(e) => setPlatform({ enabled: e.target.checked })}
              />
              <span>Apply this rule</span>
            </label>
            <label className={checkRow}>
              <input
                type="checkbox"
                className="accent-emerald-500"
                checked={rules.platform.detectFromJd}
                onChange={(e) => setPlatform({ detectFromJd: e.target.checked })}
              />
              <span>Use the platform the job description names</span>
            </label>
          </div>
          <label htmlFor={keywordsId} className={`block text-[10px] font-bold uppercase tracking-widest mt-3 mb-1.5 ${muted}`}>
            Fallback keywords
          </label>
          <input
            id={keywordsId}
            type="text"
            value={keywordDraft}
            placeholder="Azure, AWS"
            onChange={(e) => setKeywordDraft(e.target.value)}
            onBlur={commitKeywords}
            onKeyDown={(e) => {
              if (e.key === 'Enter') e.currentTarget.blur();
            }}
            className={`${inputClass} w-full`}
          />
          <p className={`text-[10px] mt-1 ${muted}`}>Comma-separated. Used when the job description names no platform your roles show.</p>
          <div className="mt-3 flex flex-wrap items-center gap-2 text-xs">
            <span>Matching roles get</span>
            <RangeSelect value={rules.platform} label="Platform roles" selectClass={selectClass} onChange={(range) => setPlatform(range)} />
          </div>
        </div>

        <div className={card}>
          <div className="flex items-center gap-2 mb-1">
            <SlidersHorizontal className="w-4 h-4 text-emerald-500" />
            <h3 className={cardTitle}>4. Two-page fit</h3>
          </div>
          <p className={`text-[11px] mb-3 ${muted}`}>
            A cap on bullets in the whole resume. The oldest roles the system sized give up bullets first, never below 1;
            rule roles are never trimmed.
          </p>
          <label className={checkRow}>
            <input
              type="checkbox"
              className="accent-emerald-500"
              checked={rules.pageFit.enabled}
              onChange={(e) => setPageFit({ enabled: e.target.checked })}
            />
            <span>Apply this rule</span>
          </label>
          <div className="mt-3 flex items-center gap-3">
            <input
              type="range"
              aria-label="Most bullets in the resume"
              min={BULLET_RULE_LIMITS.minTotalBullets}
              max={BULLET_RULE_LIMITS.maxTotalBullets}
              step={1}
              value={rules.pageFit.maxTotalBullets}
              onChange={(e) => setPageFit({ maxTotalBullets: Number(e.target.value) })}
              className="flex-1 accent-emerald-500"
            />
            <span className="text-xs font-black tabular-nums whitespace-nowrap">{rules.pageFit.maxTotalBullets} bullets</span>
          </div>
        </div>
      </div>

      <div className={`${card} mt-4`}>
        <div className="flex items-center justify-between gap-3 mb-2">
          <div className="flex items-center gap-2">
            <Eye className="w-4 h-4 text-emerald-500" />
            <h3 className={cardTitle}>Preview for the current resume</h3>
          </div>
          {preview.status === 'ready' && (
            <span className="text-[10px] font-bold uppercase tracking-widest whitespace-nowrap">{preview.totalMax} bullets max</span>
          )}
        </div>
        {preview.status === 'empty' && (
          <p className={`text-[11px] ${muted}`}>Add a resume on the Optimizer tab to preview each role's count.</p>
        )}
        {preview.status === 'free-text' && (
          <p className={`text-[11px] ${muted}`}>
            This resume is plain text, so its roles are only known once the optimizer extracts them. Your rules still
            apply to every optimization.
          </p>
        )}
        {preview.status === 'error' && (
          <p className="text-[11px] text-amber-500">
            The roles in this resume could not be read for a preview. Your rules still apply to every optimization.
          </p>
        )}
        {preview.status === 'ready' && (
          <>
            <div className={`space-y-1 text-[11px] ${muted}`}>
              {!preview.active && <p>Rules are off: the system sizes every role by tenure.</p>}
              {preview.active && rules.platform.enabled && rules.platform.detectFromJd && !jobDescription.trim() && (
                <p>No job description yet: the platform rule uses your keywords until you paste one.</p>
              )}
              {preview.platformNote && <p>{preview.platformNote}</p>}
              {preview.pageFitNote && <p>{preview.pageFitNote}</p>}
            </div>
            <ul className="mt-3">
              {preview.rows.map((row, idx) => (
                <li key={row.key} className={`flex items-center justify-between gap-3 py-1.5 ${idx > 0 ? `border-t ${divider}` : ''}`}>
                  <div className="min-w-0 text-[11px]">
                    <div className="truncate" title={[row.role, row.company, row.duration].filter(Boolean).join(' | ')}>
                      <span className="font-bold">{row.role || `Role ${idx + 1}`}</span>
                      {row.company && <span className={muted}> &middot; {row.company}</span>}
                    </div>
                    <div className="text-[10px] opacity-40 truncate">
                      {row.duration || 'No dates'}
                      {row.fitFrom && ' \u00b7 trimmed for page fit'}
                    </div>
                  </div>
                  <div className="flex items-center gap-2 shrink-0">
                    <span
                      className={`px-1.5 py-0.5 rounded border text-[9px] font-bold uppercase tracking-wider ${BADGE_TONES[row.badge]}`}
                      title={row.matchedTerms.length > 0 ? `Shows: ${row.matchedTerms.join(', ')}` : row.reason}
                    >
                      {row.badgeText}
                    </span>
                    <span
                      className={`w-12 text-right text-[9px] font-black uppercase tracking-wider ${row.source === 'rule' ? 'text-emerald-500' : 'opacity-40'}`}
                      title={row.source === 'rule' ? 'Set by your bullet rules' : 'Set by the system from tenure'}
                    >
                      {row.source === 'rule' ? 'Rule' : 'System'}
                    </span>
                    <span className="min-w-[3.5rem] text-right text-xs font-black tabular-nums" title={row.reason}>
                      {row.fitFrom && <span className="mr-1 font-bold line-through opacity-40">{row.fitFrom}</span>}
                      {row.label}
                    </span>
                  </div>
                </li>
              ))}
            </ul>
          </>
        )}
      </div>
    </section>
  );
};
