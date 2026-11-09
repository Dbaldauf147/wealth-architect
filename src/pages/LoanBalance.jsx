import { useMemo, useState } from 'react';
import { balanceTimeline, interestPaidSeries } from '../lib/loanInterest';
import styles from './ShortTermLoanPage.module.css';

/* The loan's balance card: what's left, what's been paid down, what interest
   has cost, a form to type in a balance and rate from a statement, and two
   charts over time. Balance and interest are different measures, so they get
   a chart each rather than sharing one with two scales. */

const money = (n, cents = true) => (n == null || !Number.isFinite(n) ? '—' : new Intl.NumberFormat('en-US', {
  style: 'currency', currency: 'USD', minimumFractionDigits: cents ? 2 : 0, maximumFractionDigits: cents ? 2 : 0,
}).format(n));

const compact = n => (Math.abs(n) >= 1000
  ? `$${(n / 1000).toFixed(Math.abs(n) >= 10000 ? 0 : 1).replace(/\.0$/, '')}k`
  : `$${Math.round(n)}`);

function localDate(iso) {
  const [y, m, d] = (iso || '').split('-').map(Number);
  return y && m && d ? new Date(y, m - 1, d) : null;
}
const shortDate = iso => localDate(iso)?.toLocaleDateString('en-US', { month: 'short', day: 'numeric' }) ?? iso;
const longDate = iso => localDate(iso)?.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' }) ?? iso;
const dayNum = iso => (localDate(iso)?.getTime() ?? 0) / 86400000;
const todayISO = () => {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
};

// Round axis ticks from 0 to just past max.
function niceTicks(max, count = 4) {
  if (!(max > 0)) return [0, 1];
  const raw = max / count;
  const mag = 10 ** Math.floor(Math.log10(raw));
  const step = [1, 2, 2.5, 5, 10].map(m => m * mag).find(s => s >= raw);
  const ticks = [];
  for (let v = 0; v < max + step * 0.999; v += step) ticks.push(v);
  return ticks;
}

const SOURCE_LABEL = { start: 'Starting principal', payment: 'Implied by interest paid', ledger: 'From loans & payments', entered: 'Entered by you' };

export function LoanBalance({ loan, readOnly, onRecordBalance }) {
  const timeline = useMemo(() => balanceTimeline(loan), [loan]);
  const interest = useMemo(() => interestPaidSeries(loan), [loan]);
  const { current, paidDown, borrowed } = timeline;
  const interestTotal = interest.length ? interest[interest.length - 1].total : 0;

  return (
    <div className={styles.card} data-testid="remaining-balance">
      <div className={styles.balanceRow}>
        <div>
          <div className={styles.statLabel}>Remaining loan balance</div>
          <div className={styles.balanceValue}>{current ? money(current.balance) : '—'}</div>
          <div className={styles.statSub}>
            {current
              ? current.source === 'payment'
                ? <>Implied by the {money(current.interest)} paid {longDate(current.date)}, covering {current.days} day{current.days === 1 ? '' : 's'}</>
                : <>{SOURCE_LABEL[current.source]} · as of {longDate(current.date)}</>
              : 'Enter your balance below, or log an interest payment.'}
          </div>
        </div>
        <div className={styles.balanceFigures}>
          {paidDown != null && (
            <div className={styles.balanceSide}>
              <div className={styles.statLabel}>{paidDown >= 0 ? 'Principal paid' : 'More than borrowed'}</div>
              <div className={styles.balanceSideValue}>{money(Math.abs(paidDown))}</div>
              <div className={styles.statSub}>{paidDown >= 0 && borrowed > 0 ? `${Math.round((paidDown / borrowed) * 100)}% of ${money(borrowed, false)} borrowed` : `vs ${money(borrowed, false)} borrowed`}</div>
            </div>
          )}
          <div className={styles.balanceSide}>
            <div className={styles.statLabel}>Interest paid</div>
            <div className={styles.balanceSideValue}>{money(interestTotal)}</div>
            <div className={styles.statSub}>{interest.length} payment{interest.length === 1 ? '' : 's'}</div>
          </div>
        </div>
      </div>

      {current && <WhereItStands principal={borrowed} remaining={current.balance} interestPaid={interestTotal} />}

      <BalanceForm loan={loan} current={current} readOnly={readOnly} onSave={onRecordBalance} />

      {(timeline.points.length > 1 || interest.length > 0) && (
        <div className={styles.chartPair}>
          <BalanceChart points={timeline.points} />
          <InterestChart series={interest} />
        </div>
      )}
    </div>
  );
}

/* One dollar scale, two bars: the principal split into paid and left, and
   the interest paid beside it — so the cost of carrying the loan reads
   against the loan itself. */
function WhereItStands({ principal, remaining, interestPaid }) {
  const paid = Math.max(0, principal - remaining);
  const scale = Math.max(principal, remaining, interestPaid, 1);
  const pct = v => `${(Math.max(0, v) / scale) * 100}%`;
  const [hover, setHover] = useState(null);
  const tip = {
    paid: `Principal paid · ${money(paid)}`,
    left: `Remaining · ${money(remaining)}`,
    interest: `Interest paid · ${money(interestPaid)}`,
  };

  return (
    <div className={styles.standsBlock} data-testid="where-it-stands">
      <div className={styles.legend}>
        <span className={styles.legendItem}><i className={styles.swatch} style={{ background: 'var(--viz-paid)' }} />Principal paid <b>{money(paid, false)}</b></span>
        <span className={styles.legendItem}><i className={styles.swatch} style={{ background: 'var(--viz-left)' }} />Remaining <b>{money(remaining, false)}</b></span>
        <span className={styles.legendItem}><i className={styles.swatch} style={{ background: 'var(--viz-interest)' }} />Interest paid <b>{money(interestPaid, false)}</b></span>
      </div>

      <div className={styles.barLabel}>Borrowed{principal > 0 ? ` · ${money(principal, false)}` : ''}</div>
      <div className={styles.barTrack} role="img" aria-label={`${tip.paid}; ${tip.left}`}>
        {paid > 0 && (
          <div className={styles.barSeg} style={{ width: pct(paid), background: 'var(--viz-paid)' }}
            onMouseEnter={() => setHover('paid')} onMouseLeave={() => setHover(null)} title={tip.paid} />
        )}
        <div className={styles.barSeg} style={{ width: pct(remaining), background: 'var(--viz-left)' }}
          onMouseEnter={() => setHover('left')} onMouseLeave={() => setHover(null)} title={tip.left} />
      </div>

      <div className={styles.barLabel}>Interest paid</div>
      <div className={styles.barTrack} role="img" aria-label={tip.interest}>
        {interestPaid > 0 && (
          <div className={styles.barSeg} style={{ width: pct(interestPaid), background: 'var(--viz-interest)' }}
            onMouseEnter={() => setHover('interest')} onMouseLeave={() => setHover(null)} title={tip.interest} />
        )}
      </div>
      <div className={styles.barHover} aria-live="polite">{hover ? tip[hover] : ' '}</div>
    </div>
  );
}

function BalanceForm({ loan, current, readOnly, onSave }) {
  const [open, setOpen] = useState(false);
  const [date, setDate] = useState(todayISO());
  const [amount, setAmount] = useState('');
  const [rate, setRate] = useState('');
  const [rateType, setRateType] = useState('daily');
  const entered = loan.balanceHistory || [];

  function start() {
    setDate(todayISO());
    setAmount(current ? String(Math.round(current.balance * 100) / 100) : '');
    setRate(loan.rate != null ? String(loan.rate) : '');
    setRateType(loan.rateType === 'apr' ? 'apr' : 'daily');
    setOpen(true);
  }

  function submit(e) {
    e.preventDefault();
    if (amount === '' || !(Number(amount) >= 0)) return;
    onSave({ date, amount: Number(amount), rate, rateType });
    setOpen(false);
  }

  if (!open) {
    return (
      <div className={styles.balanceActions}>
        <button type="button" className={styles.btnGhost} onClick={start} disabled={readOnly}>
          <span className="material-symbols-outlined" style={{ fontSize: 18 }}>edit_note</span>
          Update balance &amp; rate
        </button>
        {entered.length > 0 && (
          <div className={styles.enteredList}>
            {[...entered].reverse().map(e => (
              <span key={e.date} className={styles.enteredChip}>
                {money(Number(e.amount))} · {shortDate(e.date)}
                <button type="button" className={styles.chipX} aria-label={`Remove balance entered for ${longDate(e.date)}`}
                  title="Remove this balance" disabled={readOnly}
                  onClick={() => onSave({ date: e.date, amount: null })}>×</button>
              </span>
            ))}
          </div>
        )}
      </div>
    );
  }

  return (
    <form className={styles.balanceForm} onSubmit={submit} data-testid="balance-form">
      <label className={styles.field}>
        <span className={styles.fieldLabel}>Remaining balance</span>
        <input className={styles.input} type="number" min="0" step="0.01" value={amount} onChange={e => setAmount(e.target.value)} placeholder="0.00" required autoFocus />
      </label>
      <label className={styles.field}>
        <span className={styles.fieldLabel}>As of</span>
        <input className={styles.input} type="date" value={date} onChange={e => setDate(e.target.value)} required />
      </label>
      <label className={styles.field}>
        <span className={styles.fieldLabel}>Interest rate (%)</span>
        <input className={styles.input} type="number" min="0" step="0.0001" value={rate} onChange={e => setRate(e.target.value)} placeholder="1" />
      </label>
      <label className={styles.field}>
        <span className={styles.fieldLabel}>Rate basis</span>
        <select className={styles.input} value={rateType} onChange={e => setRateType(e.target.value)}>
          <option value="daily">Per day</option>
          <option value="apr">Annual (APR ÷ 365)</option>
        </select>
      </label>
      <div className={styles.balanceFormActions}>
        <button type="submit" className={styles.btnPrimary}>Save</button>
        <button type="button" className={styles.btnGhost} onClick={() => setOpen(false)}>Cancel</button>
      </div>
    </form>
  );
}

// ── Charts ────────────────────────────────────────────────────────────────
const W = 520, H = 220, M = { top: 16, right: 16, bottom: 28, left: 52 };
const PW = W - M.left - M.right, PH = H - M.top - M.bottom;

function useXScale(dates) {
  return useMemo(() => {
    const ds = dates.map(dayNum);
    const lo = Math.min(...ds), hi = Math.max(...ds);
    const span = hi - lo || 1;
    return iso => (dates.length < 2 || hi === lo ? PW / 2 : ((dayNum(iso) - lo) / span) * PW);
  }, [dates]);
}

function Axes({ ticks, y, dates, x }) {
  // First, last and (if room) middle date labels.
  const labelled = dates.length <= 3 ? dates : [dates[0], dates[Math.floor(dates.length / 2)], dates[dates.length - 1]];
  return (
    <g>
      {ticks.map(t => (
        <g key={t} transform={`translate(0,${y(t)})`}>
          <line x1={0} x2={PW} stroke="var(--viz-grid)" strokeWidth={1} />
          <text x={-8} dy="0.32em" textAnchor="end" className={styles.axisText}>{compact(t)}</text>
        </g>
      ))}
      {[...new Set(labelled)].map((d, i, arr) => (
        <text key={d} x={x(d)} y={PH + 18} className={styles.axisText}
          textAnchor={arr.length > 1 && i === 0 ? 'start' : arr.length > 1 && i === arr.length - 1 ? 'end' : 'middle'}>
          {shortDate(d)}
        </text>
      ))}
    </g>
  );
}

function Tooltip({ x, y, children }) {
  // x, y in plot coordinates; flip to the left past the middle.
  const left = ((M.left + x) / W) * 100;
  const top = ((M.top + y) / H) * 100;
  return (
    <div className={styles.vizTip} style={{ left: `${left}%`, top: `${top}%`, transform: `translate(${left > 60 ? 'calc(-100% - 10px)' : '10px'}, -50%)` }}>
      {children}
    </div>
  );
}

function BalanceChart({ points }) {
  const dates = useMemo(() => points.map(p => p.date), [points]);
  const x = useXScale(dates);
  const ticks = niceTicks(Math.max(...points.map(p => p.balance), 1));
  const yMax = ticks[ticks.length - 1];
  const y = v => PH - (v / yMax) * PH;
  const [hi, setHi] = useState(null);
  const path = points.map((p, i) => `${i ? 'L' : 'M'}${x(p.date)},${y(p.balance)}`).join('');
  const area = points.length > 1 ? `${path}L${x(points[points.length - 1].date)},${PH}L${x(points[0].date)},${PH}Z` : '';
  const p = hi != null ? points[hi] : null;

  return (
    <figure className={styles.chart} data-testid="balance-chart">
      <figcaption className={styles.chartTitle}>Balance over time</figcaption>
      <div className={styles.chartBox}>
        <svg viewBox={`0 0 ${W} ${H}`} className={styles.chartSvg} role="img"
          aria-label={`Loan balance from ${money(points[0]?.balance)} to ${money(points[points.length - 1]?.balance)}`}>
          <g transform={`translate(${M.left},${M.top})`}>
            <Axes ticks={ticks} y={y} dates={dates} x={x} />
            {area && <path d={area} fill="var(--viz-left)" opacity={0.08} />}
            <path d={path} fill="none" stroke="var(--viz-left)" strokeWidth={2} strokeLinejoin="round" strokeLinecap="round" />
            {p && <line x1={x(p.date)} x2={x(p.date)} y1={0} y2={PH} stroke="var(--viz-axis)" strokeDasharray="3 3" />}
            {points.map((pt, i) => (
              <circle key={pt.date} cx={x(pt.date)} cy={y(pt.balance)} r={hi === i ? 6 : 4.5}
                fill={pt.source === 'entered' ? 'var(--color-surface)' : 'var(--viz-left)'}
                stroke={pt.source === 'entered' ? 'var(--viz-left)' : 'var(--color-surface)'} strokeWidth={2} />
            ))}
            {/* Hit targets: a column per point, wider than the marker. */}
            {points.map((pt, i) => {
              const cx = x(pt.date);
              const prev = i ? (x(points[i - 1].date) + cx) / 2 : 0;
              const next = i < points.length - 1 ? (x(points[i + 1].date) + cx) / 2 : PW;
              return <rect key={pt.date} x={prev} y={0} width={Math.max(next - prev, 1)} height={PH} fill="transparent"
                onMouseEnter={() => setHi(i)} onMouseLeave={() => setHi(null)} />;
            })}
          </g>
        </svg>
        {p && (
          <Tooltip x={x(p.date)} y={y(p.balance)}>
            <div className={styles.vizTipTitle}>{longDate(p.date)}</div>
            <div><b>{money(p.balance)}</b></div>
            <div className={styles.vizTipSub}>{SOURCE_LABEL[p.source]}</div>
          </Tooltip>
        )}
      </div>
      <div className={styles.chartKey}>
        <span><svg width="12" height="12" aria-hidden="true"><circle cx="6" cy="6" r="4" fill="var(--viz-left)" /></svg> From loans, payments &amp; interest paid</span>
        <span><svg width="12" height="12" aria-hidden="true"><circle cx="6" cy="6" r="4" fill="var(--color-surface)" stroke="var(--viz-left)" strokeWidth="2" /></svg> Entered by you</span>
      </div>
    </figure>
  );
}

function InterestChart({ series }) {
  const dates = useMemo(() => series.map(s => s.date), [series]);
  const ticks = niceTicks(Math.max(...series.map(s => s.amount), 1));
  const yMax = ticks[ticks.length - 1];
  const y = v => PH - (v / yMax) * PH;
  const [hi, setHi] = useState(null);
  // Bars are evenly spaced by payment, not by date — each is one payment.
  const slot = series.length ? PW / series.length : PW;
  const bw = Math.min(36, Math.max(4, slot - 6));
  const cx = i => slot * i + slot / 2;
  const xByDate = iso => cx(dates.indexOf(iso));
  const s = hi != null ? series[hi] : null;
  const total = series.length ? series[series.length - 1].total : 0;

  return (
    <figure className={styles.chart} data-testid="interest-chart">
      <figcaption className={styles.chartTitle}>Interest paid · {money(total)} total</figcaption>
      <div className={styles.chartBox}>
        {series.length === 0 ? (
          <div className={styles.emptyRow}>No interest payments yet.</div>
        ) : (
          <svg viewBox={`0 0 ${W} ${H}`} className={styles.chartSvg} role="img"
            aria-label={`${series.length} interest payments totalling ${money(total)}`}>
            <g transform={`translate(${M.left},${M.top})`}>
              <Axes ticks={ticks} y={y} dates={dates} x={xByDate} />
              {series.map((d, i) => {
                const h = PH - y(d.amount);
                const r = Math.min(4, bw / 2, h);
                const x0 = cx(i) - bw / 2;
                // Rounded top, square base.
                const path = `M${x0},${PH}V${PH - h + r}Q${x0},${PH - h} ${x0 + r},${PH - h}H${x0 + bw - r}Q${x0 + bw},${PH - h} ${x0 + bw},${PH - h + r}V${PH}Z`;
                return <path key={d.date} d={path} fill="var(--viz-interest)" opacity={hi == null || hi === i ? 1 : 0.55} />;
              })}
              {series.map((d, i) => (
                <rect key={d.date} x={slot * i} y={0} width={slot} height={PH} fill="transparent"
                  onMouseEnter={() => setHi(i)} onMouseLeave={() => setHi(null)} />
              ))}
            </g>
          </svg>
        )}
        {s && (
          <Tooltip x={cx(hi)} y={y(s.amount)}>
            <div className={styles.vizTipTitle}>{longDate(s.date)}</div>
            <div><b>{money(s.amount)}</b></div>
            <div className={styles.vizTipSub}>{money(s.total)} paid to date</div>
          </Tooltip>
        )}
      </div>
    </figure>
  );
}
