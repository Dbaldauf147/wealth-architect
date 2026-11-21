import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { doc, onSnapshot, setDoc } from 'firebase/firestore';
import { db } from '../firebase';
import { parseHsaPaste, mergeHsaRows, summarizeHsa, hsaYears, hsaLimit, HSA_KINDS } from '../lib/hsa';

/* The HSA sub-tab of Cards: paste activity from the HSA provider's site, see
   contributions against the IRS limit and what was spent.

   Stored in its own doc, hsa/default, not config/default: it's a growing
   list of transactions, and keeping it apart means it can never be caught in
   that doc's merge rules. A localStorage copy makes it show instantly and
   survive being offline; Firestore wins whenever it answers. */

const REF = ['hsa', 'default'];
const CACHE = 'hsa:v1';
const EMPTY = { rows: [], coverage: 'self', catchUp: false };

function readCache() {
  try { return { ...EMPTY, ...(JSON.parse(localStorage.getItem(CACHE)) || {}) }; }
  catch { return EMPTY; }
}
function writeCache(v) {
  try { localStorage.setItem(CACHE, JSON.stringify(v)); } catch { /* Firestore still has it */ }
}

function useHsa() {
  const [data, setData] = useState(readCache);
  const [error, setError] = useState(null);
  // What save() builds on — kept outside render so two quick edits in one
  // tick both land.
  const latest = useRef(data);

  useEffect(() => onSnapshot(
    doc(db, ...REF),
    (snap) => {
      if (snap.metadata.hasPendingWrites) return;
      const next = { ...EMPTY, ...(snap.exists() ? snap.data() : {}) };
      latest.current = next;
      setData(next);
      writeCache(next);
      setError(null);
    },
    (err) => setError(err.message),
  ), []);

  const save = useCallback((patch) => {
    const next = { ...latest.current, ...patch };
    latest.current = next;
    setData(next);
    writeCache(next);
    setDoc(doc(db, ...REF), { ...JSON.parse(JSON.stringify(next)), updatedAt: new Date().toISOString() })
      .catch(err => setError(`Couldn't save to the cloud: ${err.message}`));
  }, []);

  return { ...data, save, error };
}

const fmt = (n) => new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' }).format(n || 0);
const MONTH = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const KIND_LABEL = { contribution: 'Contribution', spending: 'Spending', other: 'Other' };
const KIND_COLOR = { contribution: '#16a34a', spending: '#ba1a1a', other: 'var(--color-text-secondary)' };

const card = { background: 'var(--color-surface)', border: '1px solid var(--border-ghost)', borderRadius: 12, padding: 16 };
const th = { textAlign: 'left', fontSize: 11, fontWeight: 700, letterSpacing: '0.04em', textTransform: 'uppercase', color: 'var(--color-text-tertiary)', padding: '6px 8px', borderBottom: '1px solid var(--border-ghost)' };
const td = { fontSize: 13, padding: '7px 8px', borderBottom: '1px solid var(--border-ghost)' };
const num = { textAlign: 'right', fontVariantNumeric: 'tabular-nums' };
const btn = { display: 'inline-flex', alignItems: 'center', gap: 6, padding: '7px 14px', border: 'none', borderRadius: 8, background: 'var(--color-primary, #1d4ed8)', color: '#fff', fontSize: 12.5, fontWeight: 600, cursor: 'pointer' };
const ghostBtn = { ...btn, background: 'transparent', color: 'var(--color-text-secondary)', border: '1px solid var(--border-ghost)' };

export default function HsaTracker() {
  const { rows, coverage, catchUp, save, error } = useHsa();
  const years = useMemo(() => {
    const ys = hsaYears(rows);
    const now = new Date().getFullYear();
    return ys.includes(now) ? ys : [now, ...ys];
  }, [rows]);
  const [year, setYear] = useState(() => new Date().getFullYear());
  const summary = useMemo(() => summarizeHsa(rows, year), [rows, year]);
  const limit = hsaLimit(year, coverage, catchUp);
  const room = Math.max(0, limit - summary.contributions);
  const yearRows = useMemo(() => rows.filter(r => r.date.startsWith(String(year))), [rows, year]);

  function setKind(id, kind) {
    save({ rows: rows.map(r => (r.id === id ? { ...r, kind } : r)) });
  }
  function remove(id) {
    save({ rows: rows.filter(r => r.id !== id) });
  }
  function clearAll() {
    if (window.confirm(`Delete all ${rows.length} HSA transactions? Pasting them again brings them back.`)) save({ rows: [] });
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
      {error && <div role="alert" style={{ ...card, color: '#ba1a1a', fontSize: 13 }}>{error}</div>}

      <div style={{ display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap' }}>
        <label style={{ fontSize: 12.5, color: 'var(--color-text-secondary)' }}>
          Year{' '}
          <select aria-label="HSA year" value={year} onChange={e => setYear(Number(e.target.value))} style={{ marginLeft: 4, padding: '4px 6px' }}>
            {years.map(y => <option key={y} value={y}>{y}</option>)}
          </select>
        </label>
        <label style={{ fontSize: 12.5, color: 'var(--color-text-secondary)' }}>
          Coverage{' '}
          <select aria-label="HSA coverage" value={coverage} onChange={e => save({ coverage: e.target.value })} style={{ marginLeft: 4, padding: '4px 6px' }}>
            <option value="self">Self-only</option>
            <option value="family">Family</option>
          </select>
        </label>
        <label style={{ fontSize: 12.5, color: 'var(--color-text-secondary)', display: 'inline-flex', alignItems: 'center', gap: 4 }}>
          <input type="checkbox" checked={!!catchUp} onChange={e => save({ catchUp: e.target.checked })} />
          55+ catch-up
        </label>
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr))', gap: 12 }}>
        <Stat label={`Contributed in ${year}`} value={fmt(summary.contributions)} color={KIND_COLOR.contribution}
          sub={<Progress value={summary.contributions} max={limit} label={`of ${fmt(limit)} limit`} />} />
        <Stat label="Room left" value={fmt(room)} sub={summary.contributions > limit ? `Over the limit by ${fmt(summary.contributions - limit)}` : 'Before the IRS limit'} />
        <Stat label={`Spent in ${year}`} value={fmt(summary.spending)} color={KIND_COLOR.spending} />
        <Stat label="Net change" value={fmt(summary.net)} sub={summary.other ? `Includes ${fmt(summary.other)} other (interest, transfers, fees)` : 'Contributions minus spending'} />
      </div>

      <PasteImport rows={rows} save={save} />

      <div style={card}>
        <div style={{ fontFamily: 'var(--font-headline)', fontSize: 16, fontWeight: 700, marginBottom: 12 }}>Month by month</div>
        <div style={{ overflowX: 'auto' }}>
          <table style={{ width: '100%', borderCollapse: 'collapse', minWidth: 420 }}>
            <thead><tr>
              <th style={th}>Month</th>
              <th style={{ ...th, ...num }}>Contributions</th>
              <th style={{ ...th, ...num }}>Spending</th>
              <th style={{ ...th, ...num }}>Other</th>
            </tr></thead>
            <tbody>
              {summary.months.map(m => (
                <tr key={m.month}>
                  <td style={{ ...td, fontWeight: 600 }}>{MONTH[m.month - 1]}</td>
                  <td style={{ ...td, ...num, color: m.contributions ? KIND_COLOR.contribution : 'var(--color-text-tertiary)' }}>{m.contributions ? fmt(m.contributions) : '—'}</td>
                  <td style={{ ...td, ...num, color: m.spending ? KIND_COLOR.spending : 'var(--color-text-tertiary)' }}>{m.spending ? fmt(m.spending) : '—'}</td>
                  <td style={{ ...td, ...num, color: 'var(--color-text-tertiary)' }}>{m.other ? fmt(m.other) : '—'}</td>
                </tr>
              ))}
              <tr>
                <td style={{ ...td, fontWeight: 700 }}>Total</td>
                <td style={{ ...td, ...num, fontWeight: 700 }}>{fmt(summary.contributions)}</td>
                <td style={{ ...td, ...num, fontWeight: 700 }}>{fmt(summary.spending)}</td>
                <td style={{ ...td, ...num, fontWeight: 700 }}>{fmt(summary.other)}</td>
              </tr>
            </tbody>
          </table>
        </div>
      </div>

      <div style={card}>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12, marginBottom: 12 }}>
          <div style={{ fontFamily: 'var(--font-headline)', fontSize: 16, fontWeight: 700 }}>Transactions in {year} <span style={{ fontWeight: 500, fontSize: 13, color: 'var(--color-text-tertiary)' }}>({yearRows.length})</span></div>
          {rows.length > 0 && <button type="button" onClick={clearAll} style={ghostBtn}>Delete all</button>}
        </div>
        {yearRows.length === 0 ? (
          <div style={{ fontSize: 13, color: 'var(--color-text-tertiary)' }}>Nothing for {year} yet — paste your HSA activity above.</div>
        ) : (
          <div style={{ overflowX: 'auto' }}>
            <table style={{ width: '100%', borderCollapse: 'collapse', minWidth: 520 }}>
              <thead><tr>
                <th style={th}>Date</th>
                <th style={th}>Description</th>
                <th style={{ ...th, ...num }}>Amount</th>
                <th style={th}>Counts as</th>
                <th style={th} />
              </tr></thead>
              <tbody>
                {yearRows.map(r => (
                  <tr key={r.id}>
                    <td style={{ ...td, whiteSpace: 'nowrap' }}>{r.date}</td>
                    <td style={td}>{r.description || '—'}</td>
                    <td style={{ ...td, ...num, color: r.amount < 0 ? KIND_COLOR.spending : KIND_COLOR.contribution }}>{fmt(r.amount)}</td>
                    <td style={td}>
                      <select aria-label={`Kind for ${r.description}`} value={r.kind} onChange={e => setKind(r.id, e.target.value)} style={{ padding: '3px 4px', color: KIND_COLOR[r.kind] }}>
                        {HSA_KINDS.map(k => <option key={k} value={k}>{KIND_LABEL[k]}</option>)}
                      </select>
                    </td>
                    <td style={{ ...td, textAlign: 'right' }}>
                      <button type="button" title="Delete this row" aria-label="Delete row" onClick={() => remove(r.id)} style={{ border: 'none', background: 'transparent', cursor: 'pointer', color: 'var(--color-text-tertiary)' }}>
                        <span className="material-symbols-outlined" style={{ fontSize: 16 }}>close</span>
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  );
}

function PasteImport({ rows, save }) {
  const [text, setText] = useState('');
  const [status, setStatus] = useState(null);
  const preview = useMemo(() => (text.trim() ? parseHsaPaste(text) : null), [text]);

  function importRows() {
    if (!preview || preview.rows.length === 0) {
      setStatus({ ok: false, message: "Couldn't find any transactions in that — each row needs a date and an amount." });
      return;
    }
    const { rows: merged, added, duplicates } = mergeHsaRows(rows, preview.rows);
    save({ rows: merged });
    setStatus({ ok: true, message: `Added ${added} transaction${added === 1 ? '' : 's'}${duplicates ? `, skipped ${duplicates} already here` : ''}.` });
    setText('');
  }

  const counts = preview && preview.rows.reduce((a, r) => ({ ...a, [r.kind]: (a[r.kind] || 0) + 1 }), {});

  return (
    <div style={card}>
      <div style={{ fontFamily: 'var(--font-headline)', fontSize: 16, fontWeight: 700, marginBottom: 2 }}>Paste HSA activity</div>
      <div style={{ fontSize: 12, color: 'var(--color-text-tertiary)', marginBottom: 10 }}>
        Copy the transaction table from your HSA provider's site (or a CSV export) and paste it here, header row included if there is one. Rows already imported are skipped, so pasting an overlapping range is fine. You can change what any row counts as afterwards.
      </div>
      <textarea
        aria-label="HSA activity"
        value={text}
        onChange={e => { setText(e.target.value); setStatus(null); }}
        placeholder={'Date\tDescription\tAmount\n01/15/2026\tPayroll Contribution\t$150.00\n01/20/2026\tCard Purchase - CVS\t-$32.10'}
        rows={6}
        style={{ width: '100%', padding: 10, border: '1px solid var(--border-ghost)', borderRadius: 6, fontSize: 12.5, fontFamily: 'inherit', background: 'var(--color-surface)', color: 'var(--color-text-primary)', resize: 'vertical' }}
      />
      <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginTop: 10, flexWrap: 'wrap' }}>
        <button type="button" onClick={importRows} disabled={!text.trim()} style={{ ...btn, opacity: text.trim() ? 1 : 0.5 }}>
          <span className="material-symbols-outlined" style={{ fontSize: 16 }}>upload</span>
          Import
        </button>
        {preview && !status && (
          <span data-testid="hsa-preview" style={{ fontSize: 12.5, color: 'var(--color-text-secondary)' }}>
            {preview.rows.length
              ? `Found ${preview.rows.length}: ${counts.contribution || 0} contributions, ${counts.spending || 0} spending, ${counts.other || 0} other`
              : 'No transactions found yet'}
            {preview.skipped > 0 ? ` · ${preview.skipped} line${preview.skipped === 1 ? '' : 's'} ignored` : ''}
          </span>
        )}
        {status && <span role="status" style={{ fontSize: 12.5, fontWeight: 600, color: status.ok ? '#16a34a' : '#ba1a1a' }}>{status.message}</span>}
      </div>
    </div>
  );
}

function Progress({ value, max, label }) {
  const pct = Math.min(100, max ? (value / max) * 100 : 0);
  return (
    <span style={{ display: 'block' }}>
      <span style={{ display: 'block', height: 6, borderRadius: 3, background: 'var(--color-surface-alt)', overflow: 'hidden', margin: '6px 0 4px' }}>
        <span style={{ display: 'block', height: '100%', width: `${pct}%`, background: value > max ? '#ba1a1a' : '#16a34a' }} />
      </span>
      {Math.round(pct)}% {label}
    </span>
  );
}

function Stat({ label, value, color, sub }) {
  return (
    <div style={card}>
      <div style={{ fontSize: 11, fontWeight: 700, letterSpacing: '0.06em', textTransform: 'uppercase', color: 'var(--color-text-tertiary)' }}>{label}</div>
      <div style={{ fontFamily: 'var(--font-headline)', fontSize: 24, fontWeight: 800, marginTop: 6, color, fontVariantNumeric: 'tabular-nums' }}>{value}</div>
      {sub && <div style={{ fontSize: 11.5, color: 'var(--color-text-tertiary)', marginTop: 4 }}>{sub}</div>}
    </div>
  );
}
