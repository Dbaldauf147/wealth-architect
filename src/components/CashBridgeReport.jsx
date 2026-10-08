import { useMemo, useState } from 'react';
import { computeCashBridge } from '../lib/cashBridge';
import styles from './CashBridgeReport.module.css';

/* "I earned more than I spent — so why is my cash underwater?" A walk from
   the Cash Flow surplus to the actual change in cash position over a period
   you choose, one named reason at a time (lib/cashBridge.js). */

const MONTH_SHORT = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const MONTH_LONG = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
const short = key => { const [y, m] = key.split('-'); return `${MONTH_SHORT[m - 1]} ${y}`; };
const long = key => { const [y, m] = key.split('-'); return `${MONTH_LONG[m - 1]} ${y}`; };
const money = n => new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 0 }).format(Math.abs(n));
const cents = n => new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' }).format(n);
const signed = n => (n > 0.5 ? '+' : n < -0.5 ? '−' : '') + money(n);
const day = d => d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });

const SHORT_LABEL = {
  outsideIncome: 'Income outside cash',
  outsideSpending: 'Spending from outside',
  timing: 'Rent timing',
  investing: 'Investing',
  transfers: 'Transfers out',
  cardPayments: 'Card payments',
  other: 'Other',
  accounts: 'Accounts started/stopped',
  unexplained: 'No matching transaction',
};

const ADD = '#2a78d6';      // adds to cash — same blue as income on this page
const TAKE = '#d03b3b';     // takes from cash — critical red; every row also says it in words

/**
 * @param monthKeys  the months that can be picked, oldest first (the last may be in progress)
 */
export function CashBridgeReport({ transactions, balanceHistory, overrides, monthKeys, onToggleAccount }) {
  const complete = monthKeys.slice(0, -1);
  const lastComplete = complete[complete.length - 1] || monthKeys[monthKeys.length - 1];
  const back = n => complete[Math.max(0, complete.length - n)] || monthKeys[0];
  const [from, setFrom] = useState(() => back(6));
  const [to, setTo] = useState(lastComplete);
  const [open, setOpen] = useState(() => new Set());

  const bridge = useMemo(() => {
    if (!from || !to || from > to) return null;
    return computeCashBridge({ transactions, balanceHistory, overrides, from, to, today: new Date() });
  }, [transactions, balanceHistory, overrides, from, to]);

  const preset = n => { setFrom(back(n)); setTo(lastComplete); };
  const isPreset = n => from === back(n) && to === lastComplete;
  const toggle = id => setOpen(prev => { const s = new Set(prev); if (s.has(id)) s.delete(id); else s.add(id); return s; });

  return (
    <section className={styles.card} data-testid="cash-bridge">
      <div className={styles.head}>
        <div>
          <h2 className={styles.title}>Why your cash doesn’t match your surplus</h2>
          <div className={styles.hint}>
            Income minus spending and your cash position measure different things. Pick a period to see, step by step, what turned one into the other.
          </div>
        </div>
        <div className={styles.controls}>
          <div className={styles.segment} role="group" aria-label="Report period">
            {[3, 6, 12].map(n => (
              <button key={n} type="button" className={`${styles.segmentBtn} ${isPreset(n) ? styles.segmentActive : ''}`} onClick={() => preset(n)}>
                {n}M
              </button>
            ))}
          </div>
          <label className={styles.field}>
            <span>From</span>
            <select value={from} onChange={e => setFrom(e.target.value)} data-testid="bridge-from">
              {monthKeys.map(k => <option key={k} value={k}>{short(k)}</option>)}
            </select>
          </label>
          <label className={styles.field}>
            <span>To</span>
            <select value={to} onChange={e => setTo(e.target.value)} data-testid="bridge-to">
              {monthKeys.map(k => <option key={k} value={k}>{short(k)}{k === monthKeys[monthKeys.length - 1] ? ' (so far)' : ''}</option>)}
            </select>
          </label>
        </div>
      </div>

      {from > to && <div className={styles.notice}>Pick a start month on or before the end month.</div>}
      {from <= to && !bridge && <div className={styles.notice}>There’s no balance history for that period yet.</div>}
      {bridge && <Bridge bridge={bridge} open={open} toggle={toggle} onPickMonth={k => { setFrom(k); setTo(k); }} onToggleAccount={onToggleAccount} />}
    </section>
  );
}

function Bridge({ bridge, open, toggle, onPickMonth, onToggleAccount }) {
  const b = bridge;
  const span = b.from === b.to ? long(b.from) : `${long(b.from)} – ${long(b.to)}`;
  const gap = b.actualChange - b.surplus;
  // Lines worth a row: anything a dollar or more, and always the leftover so
  // you can see how much is accounted for.
  const shown = b.lines.filter(l => Math.abs(l.amount) >= 1 || l.id === 'unexplained');
  const named = b.lines.filter(l => !['other', 'unexplained'].includes(l.id));
  const namedTotal = named.reduce((s, l) => s + l.amount, 0);
  const coverage = Math.abs(gap) >= 1 ? Math.min(1, Math.max(0, namedTotal / gap)) : null;

  // Waterfall geometry: running total from 0 → surplus → … → actual change.
  const steps = [];
  let run = 0;
  steps.push({ id: 'surplus', from: 0, to: b.surplus });
  run = b.surplus;
  for (const l of shown) { steps.push({ id: l.id, from: run, to: run + l.amount }); run += l.amount; }
  steps.push({ id: 'actual', from: 0, to: b.actualChange });
  const lo = Math.min(0, ...steps.flatMap(s => [s.from, s.to]));
  const hi = Math.max(0, ...steps.flatMap(s => [s.from, s.to]));
  const pct = v => ((v - lo) / (hi - lo || 1)) * 100;
  const bar = (s, color) => (
    <div className={styles.track}>
      <div className={styles.zero} style={{ left: `${pct(0)}%` }} />
      <div className={styles.bar} style={{ left: `${pct(Math.min(s.from, s.to))}%`, width: `${Math.max(0.6, Math.abs(pct(s.to) - pct(s.from)))}%`, background: color }} />
    </div>
  );
  const stepOf = id => steps.find(s => s.id === id);

  return (
    <>
      <p className={styles.lede} data-testid="bridge-lede">
        Over {span} you {b.surplus >= 0 ? <>earned <b>{money(b.surplus)} more</b> than you spent</> : <>spent <b>{money(b.surplus)} more</b> than you earned</>},
        {' '}{(b.surplus >= 0) === (b.actualChange >= 0) ? 'and' : 'but'} your cash position {b.actualChange >= 0 ? 'rose' : 'fell'} <b>{money(b.actualChange)}</b>
        {' '}(from {signed(b.start.net)} to {signed(b.end.net)}).
        {Math.abs(gap) >= 1 && <> That’s a <b>{money(gap)}</b> difference{coverage != null && coverage > 0 ? <>; the named reasons below account for {Math.round(coverage * 100)}% of it.</> : '.'}</>}
      </p>

      {b.overlaps.map(o => (
        <div key={o.key} className={styles.overlap} data-testid="bridge-overlap">
          <span className="material-symbols-outlined">credit_card_off</span>
          <div>
            <b>{o.old} may be counted twice.</b> Its balance has sat at {money(o.balance)} owed since {day(o.frozenSince)}, and it stopped
            updating on {day(o.lastUpdate)}. Meanwhile {o.replacedBy.join(', ')} started reporting. If one of them replaced it, that{' '}
            {money(o.balance)} was counted on both from then until {day(o.droppedOut)}, when the old card dropped out, so the position looks
            {' '}{money(o.balance)} worse over those months and jumps back after.
            <div className={styles.overlapActions}>
              <button type="button" className={styles.linkBtn} onClick={() => onToggleAccount(o.key, false)}>Stop counting {o.old}</button>
              <span className={styles.muted}>This removes its whole history from the position; switch it back on under Accounts counted.</span>
            </div>
          </div>
        </div>
      ))}

      <div className={styles.walk} aria-label="From surplus to cash position">
        <div className={`${styles.row} ${styles.rowTotal}`}>
          <div className={styles.label}>Income − spending <span className={styles.muted}>as on Cash Flow · {money(b.income)} in, {money(b.spending)} out</span></div>
          {bar(stepOf('surplus'), 'var(--color-text-secondary)')}
          <div className={styles.amount}>{signed(b.surplus)}</div>
        </div>

        {shown.map(l => {
          const isOpen = open.has(l.id);
          const has = l.items?.length > 0;
          return (
            <div key={l.id} className={styles.lineWrap}>
              <button type="button" className={styles.row} onClick={() => toggle(l.id)} aria-expanded={isOpen} data-line={l.id}>
                <div className={styles.label}>
                  <span className="material-symbols-outlined" style={{ fontSize: 16, transform: isOpen ? 'rotate(90deg)' : 'none' }}>chevron_right</span>
                  {l.label}
                  {l.count > 0 && <span className={styles.muted}> · {l.count}</span>}
                </div>
                {bar(stepOf(l.id), l.amount >= 0 ? ADD : TAKE)}
                <div className={styles.amount}>
                  {signed(l.amount)}
                  <div className={styles.effect}>{Math.abs(l.amount) < 1 ? 'no effect' : l.amount > 0 ? 'added to cash' : 'took from cash'}</div>
                </div>
              </button>
              {isOpen && (
                <div className={styles.detail}>
                  <p>{l.hint}</p>
                  {has && (
                    <table className={styles.items}>
                      <thead><tr><th>Date</th><th>Description</th><th>Account</th><th className={styles.num}>Transaction</th><th className={styles.num}>Effect here</th></tr></thead>
                      <tbody>
                        {l.items.map((it, i) => (
                          <tr key={i}>
                            <td className={styles.nowrap}>{day(it.date)}</td>
                            <td>{it.description}<div className={styles.muted}>{it.category}</div></td>
                            <td className={styles.muted}>{it.account}</td>
                            <td className={styles.num}>{cents(it.amount)}</td>
                            <td className={styles.num}>{cents(it.effect)}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  )}
                  {has && l.count > l.items.length && <div className={styles.muted}>The {l.items.length} largest of {l.count}.</div>}
                </div>
              )}
            </div>
          );
        })}

        {b.internal.count > 0 && (
          <div className={`${styles.row} ${styles.rowInfo}`}>
            <div className={styles.label}>
              <span className="material-symbols-outlined" style={{ fontSize: 16 }}>sync_alt</span>
              Moves between your own accounts
              <span className={styles.muted}> · {b.internal.count / 2} card payments and transfers, {money(b.internal.volume)}, paired up</span>
            </div>
            <div />
            <div className={styles.amount}>$0<div className={styles.effect}>cancel out</div></div>
          </div>
        )}

        <div className={`${styles.row} ${styles.rowTotal} ${styles.rowEnd}`}>
          <div className={styles.label}>
            Change in cash position
            <span className={styles.muted}> {signed(b.start.net)} at {day(b.start.asOf)} → {signed(b.end.net)} at {day(b.end.asOf)}</span>
          </div>
          {bar(stepOf('actual'), b.actualChange >= 0 ? ADD : TAKE)}
          <div className={styles.amount}>{signed(b.actualChange)}</div>
        </div>
      </div>

      {b.months.length > 1 && (
        <div className={styles.tableWrap}>
          <table className={styles.months} data-testid="bridge-months">
            <thead>
              <tr>
                <th>Month</th>
                <th className={styles.num}>Income − spending</th>
                <th className={styles.num}>Cash position change</th>
                <th className={styles.num}>Difference</th>
                <th>Biggest reason</th>
              </tr>
            </thead>
            <tbody>
              {[...b.months].reverse().map(m => (
                <tr
                  key={m.key}
                  className={`${styles.monthRow} ${m.surplus > 0 && m.actual != null && m.actual < 0 ? styles.flag : ''}`}
                  onClick={() => onPickMonth(m.key)}
                  onKeyDown={e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onPickMonth(m.key); } }}
                  tabIndex={0}
                  title={`Show the walk for ${long(m.key)} alone`}
                >
                  <td className={styles.nowrap}>{long(m.key)}</td>
                  <td className={styles.num}>{signed(m.surplus)}</td>
                  <td className={styles.num}>{m.actual == null ? '—' : signed(m.actual)}</td>
                  <td className={styles.num}>{m.gap == null ? '—' : signed(m.gap)}</td>
                  <td>{m.top ? <>{SHORT_LABEL[m.top]} <span className={styles.muted}>{signed(m.lines[m.top])}</span></> : <span className={styles.muted}>—</span>}</td>
                </tr>
              ))}
            </tbody>
          </table>
          <div className={styles.muted}>Highlighted: months you earned more than you spent while your cash position still fell. Click a month to see its walk on its own.</div>
        </div>
      )}
    </>
  );
}
