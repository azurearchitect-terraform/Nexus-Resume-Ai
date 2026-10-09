import React, { useId, useMemo, useState } from 'react';
import { AlertTriangle, FileText, Info, Trash2, Upload } from 'lucide-react';
import {
  IMPORT_LIMITS,
  OLD_IMPORT_DAYS,
  TrendImportError,
  createTrendImport,
  importAgeDays,
  parseTrendImport,
  type ImportFormat,
  type TrendImportRecord,
} from '../lib/linkedinImport';

interface LinkedInTrendImportProps {
  record: TrendImportRecord | null;
  /** The current target role, offered as the default for "role the data describes". */
  defaultRole: string;
  isDarkMode: boolean;
  onSave: (record: TrendImportRecord) => void;
  onRemove: () => void;
}

const SOURCE_SUGGESTIONS = [
  'LinkedIn Talent Insights export',
  'LinkedIn Skills on the Rise report',
  'LinkedIn Premium insights (copied)',
  'LinkedIn Economic Graph report',
];
const MAX_FILE_BYTES = 5_000_000;
const PREVIEW_ROWS = 10;

const localToday = () => new Date().toLocaleDateString('en-CA');

function ageText(publishedAt: string): string {
  const days = importAgeDays(publishedAt);
  if (days < 1) return 'today';
  if (days < 60) return `${days} days ago`;
  return `${Math.round(days / 30)} months ago`;
}

/**
 * Imports trend data the candidate exported or copied from LinkedIn, recording where it came
 * from. Nothing here contacts LinkedIn, and a LinkedIn username cannot be used to fetch data.
 */
export const LinkedInTrendImport: React.FC<LinkedInTrendImportProps> = ({
  record,
  defaultRole,
  isDarkMode,
  onSave,
  onRemove,
}) => {
  const ids = useId();
  const [open, setOpen] = useState(false);
  const [source, setSource] = useState('');
  const [publishedAt, setPublishedAt] = useState('');
  const [region, setRegion] = useState('India');
  const [role, setRole] = useState('');
  const [text, setText] = useState('');
  const [format, setFormat] = useState<ImportFormat | 'auto'>('auto');
  const [fileName, setFileName] = useState('');
  const [confirmed, setConfirmed] = useState(false);
  const [error, setError] = useState('');
  const [reading, setReading] = useState(false);

  const box = isDarkMode ? 'bg-white/5 border-white/10' : 'bg-gray-50 border-black/5';
  const field = `w-full px-3 py-2 border rounded-lg text-xs focus:outline-none focus:ring-2 focus:ring-emerald-500/20 focus:border-emerald-500 ${
    isDarkMode ? 'bg-white/5 border-white/10 text-white' : 'bg-white border-black/10 text-black'
  }`;
  const button = `px-3 py-1.5 rounded-lg text-[10px] font-bold uppercase tracking-widest border transition-colors disabled:opacity-40 disabled:cursor-not-allowed ${
    isDarkMode ? 'border-white/15 hover:bg-white/10' : 'border-black/10 hover:bg-black/5'
  }`;

  const preview = useMemo(() => {
    if (!text.trim()) return null;
    try {
      return { parsed: parseTrendImport(text, format) };
    } catch (e) {
      return { error: e instanceof TrendImportError ? e.message : 'This data could not be read.' };
    }
  }, [text, format]);

  const begin = () => {
    setOpen(true);
    setError('');
    setText('');
    setFormat('auto');
    setFileName('');
    setConfirmed(false);
    setPublishedAt('');
    setSource(record?.source ?? '');
    setRegion(record?.region ?? 'India');
    setRole(record?.role ?? defaultRole);
  };

  const cancel = () => {
    setOpen(false);
    setError('');
  };

  const onFile = async (event: React.ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    event.target.value = '';
    if (!file) return;
    setError('');
    const lower = file.name.toLowerCase();
    if (/\.(xlsx?|xlsm|numbers|ods)$/.test(lower)) {
      setError('Spreadsheet files are not supported. Save the sheet as CSV and choose that file.');
      return;
    }
    if (lower.endsWith('.pdf') || file.type === 'application/pdf') {
      setError('PDF text is not read reliably. Open the PDF, copy the skills list or table, and paste it below, or export CSV.');
      return;
    }
    if (file.size > MAX_FILE_BYTES) {
      setError('That file is too large. Choose an export under 5 MB.');
      return;
    }
    setReading(true);
    try {
      setText(await file.text());
      setFileName(file.name);
      setFormat(lower.endsWith('.json') ? 'json' : lower.endsWith('.csv') ? 'csv' : 'auto');
    } catch {
      setError('Could not read that file. Try pasting its contents instead.');
    } finally {
      setReading(false);
    }
  };

  const submit = () => {
    setError('');
    try {
      const { record: next } = createTrendImport({
        text,
        format,
        source,
        publishedAt,
        region,
        role,
        permissionConfirmed: confirmed,
      });
      onSave(next);
      setOpen(false);
      setText('');
      setFileName('');
    } catch (e) {
      setError(e instanceof TrendImportError ? e.message : 'Could not import this data.');
    }
  };

  const old = record ? importAgeDays(record.published_at) > OLD_IMPORT_DAYS : false;

  return (
    <div className={`px-3 py-2 rounded-xl border text-[11px] space-y-2 ${box}`}>
      <div className="flex items-start justify-between gap-3">
        <span className="min-w-0">
          <span className="block text-[10px] font-bold uppercase tracking-widest">LinkedIn data you imported</span>
          {record ? (
            <span className={isDarkMode ? 'opacity-70' : 'opacity-80'}>
              {record.source} &middot; published {record.published_at} ({ageText(record.published_at)}) &middot; {record.region} &middot;{' '}
              {record.role} &middot; {record.skills.length} skills &middot; unverified by Nexus &middot; permission confirmed{' '}
              {record.permission.confirmed_at.slice(0, 10)}
            </span>
          ) : (
            <span className="opacity-60">Nothing imported yet. Trends stay off for this source until you import data.</span>
          )}
        </span>
        {!open && (
          <span className="flex shrink-0 gap-1.5">
            <button type="button" onClick={begin} className={button}>
              <Upload className="w-3 h-3 inline -mt-0.5 mr-1" />
              {record ? 'Replace' : 'Import'}
            </button>
            {record && (
              <button type="button" onClick={onRemove} className={button} aria-label="Remove imported LinkedIn data">
                <Trash2 className="w-3 h-3 inline -mt-0.5" />
              </button>
            )}
          </span>
        )}
      </div>

      {record && old && !open && (
        <p className="flex items-start gap-1.5 text-amber-500">
          <AlertTriangle className="w-3 h-3 mt-0.5 shrink-0" />
          This data was published more than a year ago. Replace it with a recent export for current guidance.
        </p>
      )}
      {record && !open && record.warnings.length > 0 && (
        <details className="opacity-70">
          <summary className="cursor-pointer">{record.warnings.length} import notes</summary>
          <ul className="mt-1 list-disc pl-4 space-y-0.5">
            {record.warnings.map((warning, i) => <li key={i}>{warning}</li>)}
          </ul>
        </details>
      )}

      <details className="opacity-80">
        <summary className="cursor-pointer flex items-center gap-1.5">
          <Info className="w-3 h-3" /> What can be imported (and what cannot)
        </summary>
        <div className="mt-1.5 space-y-1.5 leading-relaxed">
          <p>
            Nexus never connects to LinkedIn. <strong>A LinkedIn username cannot be used to download trends</strong>: LinkedIn offers no
            public API for them and prohibits automated scraping. Import data you exported or copied yourself, for example:
          </p>
          <ul className="list-disc pl-4 space-y-0.5">
            <li>a skills export (CSV) from LinkedIn Talent Insights or another licensed LinkedIn product;</li>
            <li>a LinkedIn-published report such as Skills on the Rise (copy the list);</li>
            <li>the skills LinkedIn shows for a role you are researching (copy them).</li>
          </ul>
          <p>
            The skills in your own profile export are evidence about <em>you</em>, not market trends; use the LinkedIn PDF import for those.
            Only skills your own resume material supports are ever used, and the data is stored with its source and date.
          </p>
        </div>
      </details>

      {open && (
        <div className="space-y-2 pt-1">
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
            <label className="block" htmlFor={`${ids}-source`}>
              <span className="block mb-1 opacity-70">Where did this data come from? *</span>
              <input
                id={`${ids}-source`}
                list={`${ids}-sources`}
                value={source}
                onChange={(e) => setSource(e.target.value)}
                maxLength={IMPORT_LIMITS.source}
                placeholder="LinkedIn Talent Insights export"
                className={field}
              />
              <datalist id={`${ids}-sources`}>
                {SOURCE_SUGGESTIONS.map((suggestion) => <option key={suggestion} value={suggestion} />)}
              </datalist>
            </label>
            <label className="block" htmlFor={`${ids}-date`}>
              <span className="block mb-1 opacity-70">Date published or exported *</span>
              <input
                id={`${ids}-date`}
                type="date"
                value={publishedAt}
                max={localToday()}
                onChange={(e) => setPublishedAt(e.target.value)}
                className={field}
              />
            </label>
            <label className="block" htmlFor={`${ids}-region`}>
              <span className="block mb-1 opacity-70">Region the data covers *</span>
              <input
                id={`${ids}-region`}
                value={region}
                onChange={(e) => setRegion(e.target.value)}
                maxLength={IMPORT_LIMITS.region}
                placeholder="India"
                className={field}
              />
            </label>
            <label className="block" htmlFor={`${ids}-role`}>
              <span className="block mb-1 opacity-70">Role or job family it describes *</span>
              <input
                id={`${ids}-role`}
                value={role}
                onChange={(e) => setRole(e.target.value)}
                maxLength={IMPORT_LIMITS.role}
                placeholder="Cloud Engineer"
                className={field}
              />
            </label>
          </div>

          <div className="flex flex-wrap items-center gap-2">
            <label className={`${button} cursor-pointer`}>
              <FileText className="w-3 h-3 inline -mt-0.5 mr-1" />
              {reading ? 'Reading...' : 'Choose CSV, TXT or JSON file'}
              <input type="file" accept=".csv,.tsv,.txt,.json,text/plain,text/csv,application/json" onChange={onFile} className="sr-only" />
            </label>
            {fileName && <span className="opacity-60 truncate">{fileName}</span>}
            <span className="opacity-50">or paste the list or table:</span>
          </div>
          <textarea
            aria-label="Pasted LinkedIn trend data"
            value={text}
            onChange={(e) => {
              setText(e.target.value);
              setFormat('auto');
              setFileName('');
            }}
            rows={6}
            placeholder={'Skill,Rank,Growth\nGenerative AI,1,+120%\nKubernetes,2,+45%\n\nor one skill per line:\n1. Generative AI\n2. Kubernetes - +45% YoY'}
            className={`${field} font-mono resize-y`}
          />

          {preview && 'error' in preview && (
            <p role="alert" className="text-rose-500">{preview.error}</p>
          )}
          {preview && 'parsed' in preview && (
            <div className="space-y-1.5">
              <p>
                <strong>{preview.parsed.rows.length}</strong> skills read as {preview.parsed.format.toUpperCase()}
                {preview.parsed.skipped > 0 && <> &middot; {preview.parsed.skipped} {preview.parsed.skipped === 1 ? 'entry' : 'entries'} left out</>}
                {preview.parsed.rows.length > IMPORT_LIMITS.maxUsed && <> &middot; the first {IMPORT_LIMITS.maxUsed} are used</>}
              </p>
              <div className="flex flex-wrap gap-1">
                {preview.parsed.rows.slice(0, PREVIEW_ROWS).map((row) => (
                  <span
                    key={row.name}
                    className={`px-1.5 py-px rounded border ${isDarkMode ? 'border-white/15' : 'border-black/10'}`}
                    title={[
                      row.rank !== null ? `Rank ${row.rank}` : '',
                      row.growth !== null ? `Growth ${row.growth > 0 ? '+' : ''}${row.growth}%` : '',
                      row.share !== null ? `Share ${row.share}%` : '',
                    ].filter(Boolean).join(' · ') || 'No numbers in the file'}
                  >
                    {row.rank !== null ? `${row.rank}. ` : ''}{row.name}
                  </span>
                ))}
                {preview.parsed.rows.length > PREVIEW_ROWS && (
                  <span className="opacity-50">+{preview.parsed.rows.length - PREVIEW_ROWS} more</span>
                )}
              </div>
              {preview.parsed.warnings.length > 0 && (
                <ul className="list-disc pl-4 text-amber-500 space-y-0.5">
                  {preview.parsed.warnings.map((warning, i) => <li key={i}>{warning}</li>)}
                </ul>
              )}
            </div>
          )}

          <label className="flex items-start gap-2 cursor-pointer" htmlFor={`${ids}-permission`}>
            <input
              id={`${ids}-permission`}
              type="checkbox"
              checked={confirmed}
              onChange={(e) => setConfirmed(e.target.checked)}
              className="mt-0.5 accent-emerald-500"
            />
            <span>
              I exported or copied this from my own LinkedIn account or a LinkedIn product I am licensed to use, and I am allowed to
              use it in this app. *
            </span>
          </label>

          {error && <p role="alert" className="text-rose-500">{error}</p>}

          <div className="flex gap-2">
            <button type="button" onClick={submit} disabled={!text.trim() || reading} className={`${button} bg-emerald-500/10 text-emerald-500 border-emerald-500/30`}>
              Save import
            </button>
            <button type="button" onClick={cancel} className={button}>Cancel</button>
          </div>
        </div>
      )}
    </div>
  );
};
