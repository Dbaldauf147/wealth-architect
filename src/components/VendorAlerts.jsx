import { useMemo, useState } from 'react';
import { useData, useDataActions } from '../contexts/DataContext';
import { evaluateVendorAlerts, evaluateVendorAlert, newVendorAlert, todayIn, PERIODS } from '../lib/vendorAlerts';
import styles from './VendorAlerts.module.css';

function fmt(n) {
  if (n == null || !Number.isFinite(n)) return '—';
  return new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', minimumFractionDigits: 0, maximumFractionDigits: 0 }).format(n);
}

function fmtCents(n) {
  return new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' }).format(n);
}

function fmtDay(date) {
  const iso = /^(\d{4})-(\d{2})-(\d{2})/.exec(date || '');
  const d = iso ? new Date(Number(iso[1]), Number(iso[2]) - 1, Number(iso[3])) : new Date(date);
  return Number.isNaN(d.getTime()) ? date : d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
}

const PERIOD_WORD = { month: 'this month', week: 'this week', purchase: 'this month' };

/* Merchants worth suggesting in the vendor box: the ones actually spent at
   lately, with the store numbers and processor prefixes a card network adds
   taken off so "AMAZON MKTPL*2K4" and "AMAZON MKTPL*9QQ" offer one "amazon mktpl". */
function vendorSuggestions(transactions) {
  const totals = new Map();
  const since = Date.now() - 180 * 86400000;
  for (const t of transactions || []) {
    const amt = Number(t.amount) || 0;
    if (amt >= 0) continue;
    const d = new Date(t.date);
    if (Number.isNaN(d.getTime()) || d.getTime() < since) continue;
    const name = String(t.description || '')
      .toLowerCase()
      .replace(/^(sq|tst|sp|pp|paypal)\s*\*\s*/, '')
      .split(/[*#]/)[0]
      .replace(/[^a-z& ]+/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();
    if (name.length < 3) continue;
    totals.set(name, (totals.get(name) || 0) + -amt);
  }
  return [...totals.entries()].sort((a, b) => b[1] - a[1]).slice(0, 60).map(([name]) => name);
}

function statusLine(r) {
  const when = PERIOD_WORD[r.rule.period];
  if (r.rule.period === 'purchase') {
    if (r.crossed) {
      return `${r.over.length} ${r.over.length === 1 ? 'purchase' : 'purchases'} of ${fmt(r.threshold)} or more ${when}`;
    }
    return r.matches.length ? `Largest purchase ${when}: ${fmt(r.spent)}` : `No purchases ${when}`;
  }
  if (r.crossed) {
    return `${fmt(r.spent)} spent ${when} — over by ${fmt(r.spent - r.threshold)}${r.crossedOn ? ` since ${fmtDay(r.crossedOn)}` : ''}`;
  }
  return `${fmt(r.spent)} of ${fmt(r.threshold)} ${when} · ${fmt(r.threshold - r.spent)} left`;
}

export function VendorAlerts() {
  const { transactions, vendorAlerts } = useData();
  const { setVendorAlerts } = useDataActions();
  const [adding, setAdding] = useState(false);
  const [draft, setDraft] = useState({ vendor: '', threshold: '', period: 'month', email: true });
  const [openId, setOpenId] = useState(null);

  // The browser's own calendar day: "this month" should mean the user's month.
  const today = todayIn(Intl.DateTimeFormat().resolvedOptions().timeZone);
  const rules = useMemo(() => vendorAlerts || [], [vendorAlerts]);
  const results = useMemo(() => evaluateVendorAlerts(rules, transactions, today), [rules, transactions, today]);
  const suggestions = useMemo(() => (adding ? vendorSuggestions(transactions) : []), [adding, transactions]);
  const crossedCount = results.filter(r => r.crossed).length;

  // What the rule being typed would match right now, so a vendor string that
  // catches nothing (or far too much) is obvious before saving.
  const preview = useMemo(() => {
    if (!adding || !draft.vendor.trim()) return null;
    return evaluateVendorAlert({ ...draft, threshold: Number(draft.threshold) || 1 }, transactions, today);
  }, [adding, draft, transactions, today]);

  const canSave = draft.vendor.trim() && Number(draft.threshold) > 0;

  function save(e) {
    e.preventDefault();
    if (!canSave) return;
    setVendorAlerts([...rules, newVendorAlert({ ...draft, threshold: Number(draft.threshold) })]);
    setDraft({ vendor: '', threshold: '', period: draft.period, email: true });
    setAdding(false);
  }

  function remove(id) {
    const rule = rules.find(r => r.id === id);
    if (rule && !window.confirm(`Delete the alert for "${rule.vendor}"?`)) return;
    setVendorAlerts(rules.filter(r => r.id !== id));
  }

  function toggleEmail(id) {
    setVendorAlerts(rules.map(r => (r.id === id ? { ...r, email: r.email === false } : r)));
  }

  return (
    <section className={styles.card} aria-labelledby="vendor-alerts-title">
      <div className={styles.head}>
        <div>
          <div id="vendor-alerts-title" className={styles.title}>
            Vendor alerts
            {crossedCount > 0 && <span className={styles.countBadge}>{crossedCount} over</span>}
          </div>
          <div className={styles.sub}>
            Get warned when spending at a vendor passes a limit. Crossed alerts are emailed once a day, once per period.
          </div>
        </div>
        {!adding && (
          <button type="button" className={styles.addBtn} onClick={() => setAdding(true)}>
            <span className="material-symbols-outlined" style={{ fontSize: 16 }}>add_alert</span>
            Add alert
          </button>
        )}
      </div>

      {adding && (
        <form className={styles.form} onSubmit={save}>
          <label className={styles.field}>
            <span>Vendor</span>
            <input
              type="text"
              list="vendor-alert-suggestions"
              placeholder="e.g. amazon"
              value={draft.vendor}
              onChange={e => setDraft(d => ({ ...d, vendor: e.target.value }))}
              autoFocus
            />
            <datalist id="vendor-alert-suggestions">
              {suggestions.map(s => <option key={s} value={s} />)}
            </datalist>
          </label>
          <label className={styles.field}>
            <span>Alert above</span>
            <input
              type="number"
              min="1"
              step="any"
              inputMode="decimal"
              placeholder="$"
              value={draft.threshold}
              onChange={e => setDraft(d => ({ ...d, threshold: e.target.value }))}
            />
          </label>
          <label className={styles.field}>
            <span>Period</span>
            <select value={draft.period} onChange={e => setDraft(d => ({ ...d, period: e.target.value }))}>
              {PERIODS.map(p => <option key={p.id} value={p.id}>{p.label}</option>)}
            </select>
          </label>
          <label className={styles.check}>
            <input
              type="checkbox"
              checked={draft.email}
              onChange={e => setDraft(d => ({ ...d, email: e.target.checked }))}
            />
            Email me
          </label>
          <div className={styles.formActions}>
            <button type="submit" className={styles.saveBtn} disabled={!canSave}>Save alert</button>
            <button type="button" className={styles.cancelBtn} onClick={() => setAdding(false)}>Cancel</button>
          </div>
          {preview && (
            <div className={styles.preview}>
              {preview.matches.length
                ? `Matches ${preview.matches.length} ${preview.matches.length === 1 ? 'transaction' : 'transactions'} ${PERIOD_WORD[draft.period]}`
                  + (draft.period === 'purchase' ? `, largest ${fmt(preview.spent)}` : `, ${fmt(preview.spent)} so far`)
                : `Nothing matches "${draft.vendor.trim()}" ${PERIOD_WORD[draft.period]} yet — check the spelling against a transaction.`}
            </div>
          )}
        </form>
      )}

      {results.length === 0 && !adding && (
        <div className={styles.empty}>No vendor alerts yet.</div>
      )}

      {results.length > 0 && (
        <ul className={styles.list}>
          {results.map(r => {
            const open = openId === r.rule.id;
            const shown = r.rule.period === 'purchase' && r.crossed ? r.over : r.matches;
            return (
              <li key={r.rule.id} className={`${styles.item} ${r.crossed ? styles.itemCrossed : ''}`} data-crossed={r.crossed || undefined}>
                <div className={styles.row}>
                  <button
                    type="button"
                    className={styles.rowMain}
                    onClick={() => setOpenId(open ? null : r.rule.id)}
                    aria-expanded={open}
                    title={open ? 'Hide transactions' : 'Show the transactions counted'}
                  >
                    <span className={`material-symbols-outlined ${styles.icon}`}>
                      {r.crossed ? 'notification_important' : 'notifications'}
                    </span>
                    <span className={styles.vendor}>{r.rule.vendor}</span>
                    <span className={styles.limit}>
                      {fmt(r.threshold)} {PERIODS.find(p => p.id === r.rule.period)?.label}
                    </span>
                    <span className={styles.status}>{statusLine(r)}</span>
                  </button>
                  <button
                    type="button"
                    className={`${styles.iconBtn} ${r.rule.email !== false ? styles.iconBtnOn : ''}`}
                    onClick={() => toggleEmail(r.rule.id)}
                    aria-pressed={r.rule.email !== false}
                    title={r.rule.email !== false ? 'Emailing when crossed — click to stop' : 'Not emailing — click to email when crossed'}
                  >
                    <span className="material-symbols-outlined" style={{ fontSize: 16 }}>
                      {r.rule.email !== false ? 'mail' : 'mail_off'}
                    </span>
                  </button>
                  <button type="button" className={styles.iconBtn} onClick={() => remove(r.rule.id)} title="Delete alert">
                    <span className="material-symbols-outlined" style={{ fontSize: 16 }}>delete</span>
                  </button>
                </div>
                <div className={styles.bar} aria-hidden="true">
                  <div className={styles.barFill} style={{ width: `${Math.min(100, Math.round(r.pct * 100))}%` }} />
                </div>
                {open && (
                  <ul className={styles.txns}>
                    {shown.length === 0 && <li className={styles.txnEmpty}>No matching transactions {PERIOD_WORD[r.rule.period]}.</li>}
                    {shown.slice().reverse().map((t, i) => (
                      <li key={`${t.transactionId || t.description}-${i}`} className={styles.txn}>
                        <span className={styles.txnDate}>{fmtDay(t.date)}</span>
                        <span className={styles.txnDesc}>{t.description}</span>
                        <span className={Number(t.amount) < 0 ? styles.txnAmt : styles.txnRefund}>
                          {Number(t.amount) < 0 ? fmtCents(-Number(t.amount)) : `−${fmtCents(Number(t.amount))}`}
                        </span>
                      </li>
                    ))}
                  </ul>
                )}
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}
