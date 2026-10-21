import { useMemo, useState } from 'react';
import { useCommissions } from '../hooks/useCommissions';
import { earnedByMonth, monthLabel, payMonthOf, ymKey } from '../lib/commissions';
import styles from './IncomePage.module.css';

/* The Prospect Tracker's Commissions table, read-only. It's edited in the
   tracker; this page reads it live through /api/commissions (lib/commissions
   decides which year each month column is and when it's paid). */

const money = n => new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 0 }).format(n);
const dayY = d => d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
const shortDate = s => (s ? new Date(`${s}T00:00:00`).toLocaleDateString('en-US', { month: 'short', year: 'numeric' }) : '—');
const pct = r => (r == null ? '—' : `${Math.round(r * 1000) / 10}%`);
const VIEWS = [
  { id: 'active', label: 'Active' },
  { id: 'all', label: 'All' },
];

function Stat({ value, label, sub }) {
  return (
    <div>
      <div className={styles.heroStatValue}>{value}</div>
      <div className={styles.heroStatLabel}>{label}</div>
      {sub && <div className={styles.heroStatSub}>{sub}</div>}
    </div>
  );
}

export function CommissionsPage() {
  const { loading, error, updatedAt, commissions, payouts } = useCommissions();
  const [view, setView] = useState('all');
  const [sort, setSort] = useState('recent');

  const today = new Date();
  const byMonth = useMemo(() => earnedByMonth(commissions), [commissions]);
  // The last 12 months that have ended, oldest first.
  const last12 = useMemo(() => {
    const out = [];
    for (let i = 12; i >= 1; i--) {
      const d = new Date(today.getFullYear(), today.getMonth() - i, 1);
      const key = ymKey(d.getFullYear(), d.getMonth());
      out.push({ key, amount: byMonth[key] || 0 });
    }
    return out;
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [byMonth]);
  const total12 = last12.reduce((s, m) => s + m.amount, 0);
  const ytd = Object.entries(byMonth).filter(([k]) => k.startsWith(`${today.getFullYear()}-`)).reduce((s, [, v]) => s + v, 0);
  const latest = payouts.length ? payouts[payouts.length - 1] : null;
  const max = Math.max(1, ...last12.map(m => m.amount));

  const rows = useMemo(() => {
    const list = commissions.filter(c => (view === 'active' ? c.active : true));
    const key = sort === 'total' ? (c => -c.total) : (c => -(c.lastPaid ? Number(c.lastPaid.replace('-', '')) : 0));
    return [...list].sort((a, b) => key(a) - key(b) || a.account.localeCompare(b.account));
  }, [commissions, view, sort]);

  if (loading && !commissions.length) return <div className={styles.empty}>Reading the Prospect Tracker…</div>;
  if (error && !commissions.length) return <div className={styles.empty}>Couldn’t read the Prospect Tracker: {error}</div>;
  if (!commissions.length) return <div className={styles.empty}>The tracker’s Commissions table is empty.</div>;

  return (
    <div className={styles.page}>
      <div className={styles.hero} data-testid="commissions-hero">
        <div className={styles.heroLabel}>Commissions</div>
        <h1 className={styles.heroTitle}>
          {money(total12)}
          <span className={styles.heroTitleSub}> earned over the last 12 months, before tax</span>
        </h1>
        <div className={styles.heroStats}>
          <Stat value={money(ytd)} label={`${today.getFullYear()} so far`} />
          <Stat value={money(total12 / 12)} label="Average a month" />
          {latest && (
            <Stat
              value={money(latest.amount)}
              label={`Latest: ${monthLabel(latest.earnedMonth)}`}
              sub={`paid in the ${monthLabel(payMonthOf(latest.earnedMonth), { month: 'short', year: 'numeric' })} month-end paycheck`}
            />
          )}
          <Stat value={commissions.filter(c => c.active).length} label="Active" sub={`of ${commissions.length} in the tracker`} />
        </div>
      </div>

      <div className={styles.controls}>
        <div className={styles.segment} role="group" aria-label="Which commissions">
          {VIEWS.map(v => (
            <button key={v.id} type="button" className={`${styles.segmentBtn} ${view === v.id ? styles.segmentActive : ''}`} onClick={() => setView(v.id)}>
              {v.label}
            </button>
          ))}
        </div>
        <div className={styles.segment} role="group" aria-label="Sort">
          {[{ id: 'recent', label: 'Latest paid' }, { id: 'total', label: 'Biggest' }].map(s => (
            <button key={s.id} type="button" className={`${styles.segmentBtn} ${sort === s.id ? styles.segmentActive : ''}`} onClick={() => setSort(s.id)}>
              {s.label}
            </button>
          ))}
        </div>
        <div className={styles.controlsNote}>
          Read from the Prospect Tracker{updatedAt ? ` (last edited there ${dayY(new Date(updatedAt))})` : ''}; edit it there.
          {error && ` Couldn’t refresh just now (${error}) — showing the last copy.`}
        </div>
      </div>

      <section className={styles.card}>
        <div className={styles.cardHead}>
          <div>
            <h2 className={styles.cardTitle}>By month earned</h2>
            <div className={styles.cardHint}>Each is paid in the following month’s month-end paycheck.</div>
          </div>
        </div>
        <div className={styles.tableWrap}>
          <table className={styles.table} data-testid="commissions-months">
            <tbody>
              {[...last12].reverse().map(m => (
                <tr key={m.key}>
                  <td className={styles.nowrap}>{monthLabel(m.key, { month: 'short', year: 'numeric' })}</td>
                  <td className={styles.shareCell}>
                    <div className={styles.shareBar}><div style={{ width: `${Math.max(m.amount ? 2 : 0, (m.amount / max) * 100)}%`, background: '#2a78d6' }} /></div>
                  </td>
                  <td className={styles.num}>{m.amount ? money(m.amount) : <span className={styles.muted}>—</span>}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>

      <section className={styles.card}>
        <div className={styles.cardHead}>
          <div>
            <h2 className={styles.cardTitle}>{view === 'active' ? 'Active commissions' : 'Every commission'}</h2>
            <div className={styles.cardHint}>
              Active: the window hasn’t ended, or it paid within the last two months.
            </div>
          </div>
        </div>
        <div className={styles.tableWrap}>
          <table className={styles.table} data-testid="commissions-table">
            <thead>
              <tr>
                <th>Account</th>
                <th>Project</th>
                <th className={styles.num}>Rate</th>
                <th>Window</th>
                <th>Status</th>
                <th>Last paid</th>
                <th className={styles.num}>Total</th>
              </tr>
            </thead>
            <tbody>
              {rows.map(c => (
                <tr key={c.id}>
                  <td>{c.account || '—'}</td>
                  <td className={styles.muted}>{c.project || '—'}</td>
                  <td className={styles.num}>{pct(c.rate)}</td>
                  <td className={styles.nowrap}>{shortDate(c.start)} – {shortDate(c.end)}</td>
                  <td>{c.active ? 'Active' : <span className={styles.muted}>Ended</span>}</td>
                  <td className={styles.nowrap}>
                    {c.lastPaid ? <>{monthLabel(c.lastPaid, { month: 'short', year: 'numeric' })} <span className={styles.muted}>{money(c.months[c.lastPaid])}</span></> : <span className={styles.muted}>—</span>}
                  </td>
                  <td className={styles.num}>{money(c.total)}</td>
                </tr>
              ))}
              {!rows.length && <tr><td colSpan={7} className={styles.muted}>None {view === 'active' ? 'active' : ''} right now.</td></tr>}
            </tbody>
          </table>
        </div>
      </section>
    </div>
  );
}
