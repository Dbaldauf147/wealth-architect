import { useMemo, useState, useEffect, useCallback, Fragment } from 'react';
import styles from './HomeBuyingPage.module.css';
import {
  amortize, extraPaymentSavings, monthlyHousingCost, affordablePrice,
  PMI_REQUEST_LTV, PMI_AUTO_LTV, DEFAULT_FRONT_END_DTI, DEFAULT_BACK_END_DTI,
} from '../lib/mortgage.js';
import {
  analyzeBuyVsRent, horizonSeries, DEFAULTS as BVR_DEFAULTS,
  STANDARD_DEDUCTION, SALT_CAP, INTEREST_DEBT_CAP, GAIN_EXCLUSION,
  FILING_STATUSES, TAX_YEAR,
} from '../lib/buyVsRent.js';

/* ──────────────────────────────────────────────────────────────
   Formatting
   ────────────────────────────────────────────────────────────── */

const usd = (n, digits = 0) => (n == null || !Number.isFinite(n))
  ? '—'
  : new Intl.NumberFormat('en-US', {
      style: 'currency', currency: 'USD',
      minimumFractionDigits: digits, maximumFractionDigits: digits,
    }).format(n);

// Compact form for axis labels, where $1,234,567 would collide with its neighbour.
const usdShort = (n) => {
  if (n == null || !Number.isFinite(n)) return '—';
  const a = Math.abs(n);
  if (a >= 1_000_000) return `$${(n / 1_000_000).toFixed(a >= 10_000_000 ? 0 : 1)}M`;
  if (a >= 1_000) return `$${(n / 1_000).toFixed(a >= 10_000 ? 0 : 1)}k`;
  return `$${Math.round(n)}`;
};

const pct = (n, digits = 1) => (n == null || !Number.isFinite(n)) ? '—' : `${(n * 100).toFixed(digits)}%`;

const monthsToTerm = (months) => {
  const y = Math.floor(months / 12);
  const m = Math.round(months % 12);
  if (y && m) return `${y} yr ${m} mo`;
  if (y) return `${y} yr`;
  return `${m} mo`;
};

const fmtMonthYear = (d) => d instanceof Date
  ? d.toLocaleDateString('en-US', { month: 'short', year: 'numeric' })
  : '—';

/* ──────────────────────────────────────────────────────────────
   Persistence — a calculator you have to retype is a calculator
   you use once.
   ────────────────────────────────────────────────────────────── */

const STORE_KEY = 'wa-home-buying';

const MORTGAGE_DEFAULTS = {
  price: 425000,
  downPct: 20,
  ratePct: 6.5,
  termYears: 30,
  propertyTaxPct: 1.1,
  homeInsuranceAnnual: 2300,
  hoaMonthly: 0,
  pmiAnnualPct: 0.5,
  maintenancePct: 1,
  extraMonthly: 0,
  lumpAmount: 0,
  lumpYear: 1,
};

const AFFORD_DEFAULTS = {
  annualIncome: 150000,
  monthlyDebts: 500,
  downPayment: 85000,
  ratePct: 6.5,
  termYears: 30,
  propertyTaxPct: 1.1,
  homeInsurancePct: 0.55,
  hoaMonthly: 0,
  pmiAnnualPct: 0.5,
  frontEndDti: DEFAULT_FRONT_END_DTI,
  backEndDti: DEFAULT_BACK_END_DTI,
};

function loadStored() {
  try {
    const raw = JSON.parse(localStorage.getItem(STORE_KEY) || '{}');
    return {
      mortgage: { ...MORTGAGE_DEFAULTS, ...(raw.mortgage || {}) },
      buyRent: { ...BVR_DEFAULTS, ...(raw.buyRent || {}) },
      afford: { ...AFFORD_DEFAULTS, ...(raw.afford || {}) },
    };
  } catch {
    return { mortgage: { ...MORTGAGE_DEFAULTS }, buyRent: { ...BVR_DEFAULTS }, afford: { ...AFFORD_DEFAULTS } };
  }
}

/* ──────────────────────────────────────────────────────────────
   Small form pieces
   ────────────────────────────────────────────────────────────── */

function Field({ label, value, onChange, prefix, suffix, step = 'any', min = 0, max, hint, type = 'number', children, wide }) {
  return (
    <label className={`${styles.field} ${wide ? styles.fieldWide : ''}`}>
      <span className={styles.fieldLabel}>{label}</span>
      {children ? children : (
        <span className={styles.inputWrap}>
          {prefix && <span className={styles.affix}>{prefix}</span>}
          <input
            className={`${styles.input} ${prefix ? styles.hasPrefix : ''} ${suffix ? styles.hasSuffix : ''}`}
            type={type}
            step={step}
            min={min}
            max={max}
            value={value}
            onChange={(e) => onChange(e.target.value)}
            onFocus={(e) => e.target.select()}
          />
          {suffix && <span className={`${styles.affix} ${styles.affixRight}`}>{suffix}</span>}
        </span>
      )}
      {hint && <span className={styles.fieldHint}>{hint}</span>}
    </label>
  );
}

function Section({ title, children, open = false, note }) {
  return (
    <details className={styles.section} open={open}>
      <summary className={styles.sectionSummary}>
        <span>{title}</span>
        <span className="material-symbols-outlined" style={{ fontSize: 18 }}>expand_more</span>
      </summary>
      {note && <p className={styles.sectionNote}>{note}</p>}
      <div className={styles.formGrid}>{children}</div>
    </details>
  );
}

function Row({ label, value, sub, tone, indent, strong }) {
  return (
    <div className={`${styles.row} ${indent ? styles.rowIndent : ''} ${strong ? styles.rowStrong : ''}`}>
      <div className={styles.rowLabel}>
        {label}
        {sub && <span className={styles.rowSub}>{sub}</span>}
      </div>
      <div className={`${styles.rowValue} ${tone === 'good' ? styles.good : tone === 'bad' ? styles.bad : ''}`}>{value}</div>
    </div>
  );
}

/* ──────────────────────────────────────────────────────────────
   Charts — hand-rolled SVG, same as the rest of the app. No chart
   library means no 200kB of bundle for four charts.
   ────────────────────────────────────────────────────────────── */

/** Axis ticks that land on round numbers, and the top of the scale to match. */
function niceScale(max, targetTicks = 5) {
  if (!(max > 0)) return { max: 1, ticks: [0, 1] };
  const raw = max / targetTicks;
  const mag = Math.pow(10, Math.floor(Math.log10(raw)));
  const norm = raw / mag;
  const step = (norm <= 1 ? 1 : norm <= 2 ? 2 : norm <= 2.5 ? 2.5 : norm <= 5 ? 5 : 10) * mag;
  const top = Math.ceil(max / step) * step;
  const ticks = [];
  for (let t = 0; t <= top + step / 2; t += step) ticks.push(t);
  return { max: top, ticks };
}

const COLORS = {
  pi: '#0058be',
  tax: '#e8a317',
  insurance: '#009668',
  hoa: '#7c3aed',
  pmi: '#ba1a1a',
  maintenance: '#64748b',
  buy: '#0058be',
  rent: '#e8a317',
  interest: '#ba1a1a',
  principal: '#009668',
};

/** Stacked horizontal bar: where the monthly payment goes. */
function StackBar({ parts, total }) {
  const shown = parts.filter(p => p.value > 0);
  if (!(total > 0)) return null;
  return (
    <div>
      <div className={styles.stackBar}>
        {shown.map(p => (
          <div
            key={p.key}
            className={styles.stackSeg}
            style={{ width: `${(p.value / total) * 100}%`, background: p.color }}
            title={`${p.label}: ${usd(p.value, 2)}`}
          />
        ))}
      </div>
      <div className={styles.legend}>
        {shown.map(p => (
          <div key={p.key} className={styles.legendItem}>
            <span className={styles.legendDot} style={{ background: p.color }} />
            <span className={styles.legendLabel}>{p.label}</span>
            <span className={styles.legendValue}>{usd(p.value, 0)}</span>
            <span className={styles.legendPct}>{pct(p.value / total, 0)}</span>
          </div>
        ))}
      </div>
    </div>
  );
}

/** Yearly stacked bars: interest vs. principal in each year of the loan. */
function SplitChart({ years }) {
  if (!years || years.length === 0) return null;
  const vw = 900, vh = 300, padL = 60, padR = 16, padT = 16, padB = 34;
  const plotW = vw - padL - padR, plotH = vh - padT - padB;
  const maxYear = Math.max(...years.map(y => y.interest + y.principal));
  const { max, ticks } = niceScale(maxYear);
  const bw = Math.min(28, plotW / years.length - 2);
  const step = plotW / years.length;
  const labelEvery = years.length > 20 ? 5 : years.length > 10 ? 2 : 1;

  return (
    <svg width="100%" viewBox={`0 0 ${vw} ${vh}`} className={styles.chartSvg} role="img"
      aria-label="Interest and principal paid in each year of the loan">
      {ticks.map(t => {
        const y = padT + plotH * (1 - t / max);
        return (
          <g key={t}>
            <line x1={padL} y1={y} x2={vw - padR} y2={y} stroke="#eef2f7" strokeWidth="1" />
            <text x={padL - 8} y={y + 4} textAnchor="end" fontSize="11" fill="#94a3b8">{usdShort(t)}</text>
          </g>
        );
      })}
      {years.map((yr, i) => {
        const x = padL + i * step + (step - bw) / 2;
        const hi = plotH * (yr.interest / max);
        const hp = plotH * (yr.principal / max);
        const yInt = padT + plotH - hi;
        const yPr = yInt - hp;
        return (
          <g key={yr.year}>
            <rect x={x} y={yInt} width={bw} height={hi} fill={COLORS.interest} opacity="0.85">
              <title>{`Year ${yr.year}: ${usd(yr.interest)} interest`}</title>
            </rect>
            <rect x={x} y={yPr} width={bw} height={hp} fill={COLORS.principal} opacity="0.85">
              <title>{`Year ${yr.year}: ${usd(yr.principal)} principal`}</title>
            </rect>
            {(yr.year === 1 || yr.year % labelEvery === 0) && (
              <text x={x + bw / 2} y={vh - 12} textAnchor="middle" fontSize="11" fill="#94a3b8">{yr.year}</text>
            )}
          </g>
        );
      })}
      <line x1={padL} y1={padT + plotH} x2={vw - padR} y2={padT + plotH} stroke="#cbd5e1" strokeWidth="1" />
    </svg>
  );
}

/** Remaining balance over the life of the loan. */
function BalanceChart({ years, principal }) {
  if (!years || years.length === 0) return null;
  const vw = 900, vh = 260, padL = 60, padR = 16, padT = 16, padB = 34;
  const plotW = vw - padL - padR, plotH = vh - padT - padB;
  const { max, ticks } = niceScale(principal);
  const pts = [{ year: 0, endBalance: principal }, ...years];
  const n = pts.length - 1;
  const x = (i) => padL + (n ? (i / n) * plotW : 0);
  const y = (v) => padT + plotH * (1 - v / max);
  const line = pts.map((p, i) => `${i === 0 ? 'M' : 'L'}${x(i).toFixed(1)},${y(p.endBalance).toFixed(1)}`).join(' ');
  const area = `${line} L${x(n).toFixed(1)},${(padT + plotH).toFixed(1)} L${x(0).toFixed(1)},${(padT + plotH).toFixed(1)} Z`;
  const labelEvery = n > 20 ? 5 : n > 10 ? 2 : 1;

  return (
    <svg width="100%" viewBox={`0 0 ${vw} ${vh}`} className={styles.chartSvg} role="img" aria-label="Remaining loan balance over time">
      {ticks.map(t => (
        <g key={t}>
          <line x1={padL} y1={y(t)} x2={vw - padR} y2={y(t)} stroke="#eef2f7" strokeWidth="1" />
          <text x={padL - 8} y={y(t) + 4} textAnchor="end" fontSize="11" fill="#94a3b8">{usdShort(t)}</text>
        </g>
      ))}
      <path d={area} fill={COLORS.pi} opacity="0.10" />
      <path d={line} fill="none" stroke={COLORS.pi} strokeWidth="2.5" />
      {pts.map((p, i) => (i > 0 && (i === n || i % labelEvery === 0)) ? (
        <text key={i} x={x(i)} y={vh - 12} textAnchor="middle" fontSize="11" fill="#94a3b8">{p.year}</text>
      ) : null)}
      <line x1={padL} y1={padT + plotH} x2={vw - padR} y2={padT + plotH} stroke="#cbd5e1" strokeWidth="1" />
    </svg>
  );
}

/**
 * Total cost of buying vs. renting at every horizon, with the crossover.
 * Each x position is its own comparison — "buy and sell after N years" — so
 * the crossing point is the answer to "how long do I need to stay".
 */
function CrossoverChart({ rows, crossover, highlightYear }) {
  if (!rows || rows.length === 0) return null;
  const vw = 900, vh = 320, padL = 62, padR = 18, padT = 18, padB = 40;
  const plotW = vw - padL - padR, plotH = vh - padT - padB;
  const maxV = Math.max(...rows.map(r => Math.max(r.buyTotal, r.rentTotal)));
  const { max, ticks } = niceScale(maxV);
  const n = rows.length - 1;
  const x = (i) => padL + (n ? (i / n) * plotW : 0);
  const y = (v) => padT + plotH * (1 - Math.max(0, v) / max);
  const path = (key) => rows.map((r, i) => `${i === 0 ? 'M' : 'L'}${x(i).toFixed(1)},${y(r[key]).toFixed(1)}`).join(' ');
  const labelEvery = rows.length > 20 ? 5 : 2;
  const crossIdx = crossover ? crossover - 1 : null;
  const hlIdx = highlightYear ? rows.findIndex(r => r.year === highlightYear) : -1;

  return (
    <div>
      <svg width="100%" viewBox={`0 0 ${vw} ${vh}`} className={styles.chartSvg} role="img"
        aria-label="Total cost of buying compared with renting, by how long you stay">
        {ticks.map(t => (
          <g key={t}>
            <line x1={padL} y1={y(t)} x2={vw - padR} y2={y(t)} stroke="#eef2f7" strokeWidth="1" />
            <text x={padL - 8} y={y(t) + 4} textAnchor="end" fontSize="11" fill="#94a3b8">{usdShort(t)}</text>
          </g>
        ))}
        {crossIdx != null && crossIdx >= 0 && (
          <g>
            <line x1={x(crossIdx)} y1={padT} x2={x(crossIdx)} y2={padT + plotH} stroke="#0f172a" strokeDasharray="5 4" strokeWidth="1.5" />
            <text x={x(crossIdx) + 6} y={padT + 12} fontSize="11.5" fontWeight="700" fill="#0f172a">
              buying pulls ahead — year {crossover}
            </text>
          </g>
        )}
        {hlIdx >= 0 && (
          <line x1={x(hlIdx)} y1={padT} x2={x(hlIdx)} y2={padT + plotH} stroke="#94a3b8" strokeDasharray="2 4" strokeWidth="1" />
        )}
        <path d={path('rentTotal')} fill="none" stroke={COLORS.rent} strokeWidth="2.5" />
        <path d={path('buyTotal')} fill="none" stroke={COLORS.buy} strokeWidth="2.5" />
        {hlIdx >= 0 && (
          <>
            <circle cx={x(hlIdx)} cy={y(rows[hlIdx].buyTotal)} r="4.5" fill={COLORS.buy} stroke="#fff" strokeWidth="1.5" />
            <circle cx={x(hlIdx)} cy={y(rows[hlIdx].rentTotal)} r="4.5" fill={COLORS.rent} stroke="#fff" strokeWidth="1.5" />
          </>
        )}
        {rows.map((r, i) => (i === 0 || r.year % labelEvery === 0) ? (
          <text key={r.year} x={x(i)} y={vh - 14} textAnchor="middle" fontSize="11" fill="#94a3b8">{r.year}</text>
        ) : null)}
        <text x={padL + plotW / 2} y={vh - 1} textAnchor="middle" fontSize="11" fill="#94a3b8">years in the home</text>
        <line x1={padL} y1={padT + plotH} x2={vw - padR} y2={padT + plotH} stroke="#cbd5e1" strokeWidth="1" />
      </svg>
      <div className={styles.legend}>
        <div className={styles.legendItem}>
          <span className={styles.legendDot} style={{ background: COLORS.buy }} />
          <span className={styles.legendLabel}>Total cost of buying</span>
        </div>
        <div className={styles.legendItem}>
          <span className={styles.legendDot} style={{ background: COLORS.rent }} />
          <span className={styles.legendLabel}>Total cost of renting</span>
        </div>
      </div>
    </div>
  );
}

/** How the break-even rent falls the longer you stay. */
function BreakEvenChart({ rows, highlightYear, actualRent }) {
  const pts = (rows || []).filter(r => Number.isFinite(r.breakEvenRent) && r.breakEvenRent > 0);
  if (pts.length < 2) return null;
  const vw = 900, vh = 240, padL = 62, padR = 18, padT = 18, padB = 38;
  const plotW = vw - padL - padR, plotH = vh - padT - padB;
  const maxV = Math.max(...pts.map(r => r.breakEvenRent), actualRent || 0);
  const { max, ticks } = niceScale(maxV);
  const n = pts.length - 1;
  const x = (i) => padL + (n ? (i / n) * plotW : 0);
  const y = (v) => padT + plotH * (1 - Math.max(0, v) / max);
  const line = pts.map((r, i) => `${i === 0 ? 'M' : 'L'}${x(i).toFixed(1)},${y(r.breakEvenRent).toFixed(1)}`).join(' ');
  const hlIdx = highlightYear ? pts.findIndex(r => r.year === highlightYear) : -1;
  const labelEvery = pts.length > 20 ? 5 : 2;

  return (
    <svg width="100%" viewBox={`0 0 ${vw} ${vh}`} className={styles.chartSvg} role="img"
      aria-label="Break-even rent by number of years in the home">
      {ticks.map(t => (
        <g key={t}>
          <line x1={padL} y1={y(t)} x2={vw - padR} y2={y(t)} stroke="#eef2f7" strokeWidth="1" />
          <text x={padL - 8} y={y(t) + 4} textAnchor="end" fontSize="11" fill="#94a3b8">{usdShort(t)}</text>
        </g>
      ))}
      {actualRent > 0 && actualRent <= max && (
        <g>
          <line x1={padL} y1={y(actualRent)} x2={vw - padR} y2={y(actualRent)} stroke={COLORS.rent} strokeDasharray="6 4" strokeWidth="2" />
          <text x={vw - padR} y={y(actualRent) - 6} textAnchor="end" fontSize="11" fontWeight="600" fill="#b8791a">
            your rent {usd(actualRent)}
          </text>
        </g>
      )}
      <path d={line} fill="none" stroke={COLORS.buy} strokeWidth="2.5" />
      {hlIdx >= 0 && <circle cx={x(hlIdx)} cy={y(pts[hlIdx].breakEvenRent)} r="4.5" fill={COLORS.buy} stroke="#fff" strokeWidth="1.5" />}
      {pts.map((r, i) => (i === 0 || r.year % labelEvery === 0) ? (
        <text key={r.year} x={x(i)} y={vh - 12} textAnchor="middle" fontSize="11" fill="#94a3b8">{r.year}</text>
      ) : null)}
      <line x1={padL} y1={padT + plotH} x2={vw - padR} y2={padT + plotH} stroke="#cbd5e1" strokeWidth="1" />
    </svg>
  );
}

/* ──────────────────────────────────────────────────────────────
   Tab 1 — Mortgage calculator
   ────────────────────────────────────────────────────────────── */

function MortgageTab({ v, set }) {
  const [openYear, setOpenYear] = useState(null);

  const price = Math.max(0, Number(v.price) || 0);
  const downPayment = price * Math.min(100, Math.max(0, Number(v.downPct) || 0)) / 100;

  const cost = useMemo(() => monthlyHousingCost({
    price,
    downPayment,
    annualRatePct: v.ratePct,
    termYears: v.termYears,
    propertyTaxPct: v.propertyTaxPct,
    homeInsuranceAnnual: v.homeInsuranceAnnual,
    hoaMonthly: v.hoaMonthly,
    pmiAnnualPct: v.pmiAnnualPct,
    maintenancePct: v.maintenancePct,
  }), [price, downPayment, v.ratePct, v.termYears, v.propertyTaxPct, v.homeInsuranceAnnual, v.hoaMonthly, v.pmiAnnualPct, v.maintenancePct]);

  const lumpSums = useMemo(() => (Number(v.lumpAmount) > 0
    ? [{ month: Math.max(1, Math.round((Number(v.lumpYear) || 1) * 12)), amount: Number(v.lumpAmount) }]
    : []), [v.lumpAmount, v.lumpYear]);

  const args = useMemo(() => ({
    principal: cost.loan,
    annualRatePct: v.ratePct,
    termYears: v.termYears,
    extraMonthly: v.extraMonthly,
    lumpSums,
    pmiAnnualPct: v.pmiAnnualPct,
    homeValue: price,
  }), [cost.loan, v.ratePct, v.termYears, v.extraMonthly, lumpSums, v.pmiAnnualPct, price]);

  const sched = useMemo(() => amortize(args), [args]);
  const savings = useMemo(() => extraPaymentSavings(args), [args]);

  const parts = [
    { key: 'pi', label: 'Principal & interest', value: cost.principalAndInterest, color: COLORS.pi },
    { key: 'tax', label: 'Property tax', value: cost.propertyTax, color: COLORS.tax },
    { key: 'ins', label: 'Home insurance', value: cost.insurance, color: COLORS.insurance },
    { key: 'hoa', label: 'HOA dues', value: cost.hoa, color: COLORS.hoa },
    { key: 'pmi', label: 'Mortgage insurance', value: cost.pmi, color: COLORS.pmi },
    { key: 'maint', label: 'Maintenance set-aside', value: cost.maintenance, color: COLORS.maintenance },
  ];

  return (
    <div className={styles.tabBody}>
      <div className={styles.splitLayout}>
        <div className={styles.inputColumn}>
          <div className={styles.card}>
            <div className={styles.cardTitle}>The loan</div>
            <div className={styles.formGrid}>
              <Field label="Home price" prefix="$" step="1000" value={v.price} onChange={val => set({ price: val })} />
              <Field label="Down payment" suffix="%" step="0.5" max={100} value={v.downPct} onChange={val => set({ downPct: val })}
                hint={usd(downPayment)} />
              <Field label="Interest rate" suffix="%" step="0.125" value={v.ratePct} onChange={val => set({ ratePct: val })} />
              <Field label="Term">
                <select className={styles.input} value={v.termYears} onChange={e => set({ termYears: Number(e.target.value) })}>
                  {[30, 25, 20, 15, 10].map(t => <option key={t} value={t}>{t} years</option>)}
                </select>
              </Field>
            </div>
          </div>

          <div className={styles.card}>
            <div className={styles.cardTitle}>The rest of the payment</div>
            <div className={styles.formGrid}>
              <Field label="Property tax" suffix="%/yr" step="0.05" value={v.propertyTaxPct} onChange={val => set({ propertyTaxPct: val })}
                hint={`${usd(price * (Number(v.propertyTaxPct) || 0) / 100)}/yr`} />
              <Field label="Home insurance" prefix="$" suffix="/yr" step="50" value={v.homeInsuranceAnnual} onChange={val => set({ homeInsuranceAnnual: val })} />
              <Field label="HOA dues" prefix="$" suffix="/mo" step="10" value={v.hoaMonthly} onChange={val => set({ hoaMonthly: val })} />
              <Field label="Mortgage insurance" suffix="%/yr" step="0.05" value={v.pmiAnnualPct} onChange={val => set({ pmiAnnualPct: val })}
                hint={cost.pmi > 0 ? 'charged below 20% down' : 'not charged at 20% down'} />
              <Field label="Maintenance" suffix="%/yr" step="0.1" value={v.maintenancePct} onChange={val => set({ maintenancePct: val })}
                hint="not in the payment, but it is a cost" />
            </div>
          </div>

          <div className={styles.card}>
            <div className={styles.cardTitle}>Paying it down faster</div>
            <div className={styles.formGrid}>
              <Field label="Extra each month" prefix="$" step="25" value={v.extraMonthly} onChange={val => set({ extraMonthly: val })} />
              <Field label="One-off payment" prefix="$" step="1000" value={v.lumpAmount} onChange={val => set({ lumpAmount: val })} />
              <Field label="…paid in year" step="1" min={1} max={Number(v.termYears) || 30} value={v.lumpYear} onChange={val => set({ lumpYear: val })} />
            </div>
          </div>

          <button className={styles.btnGhost} onClick={() => set({ ...MORTGAGE_DEFAULTS })}>
            <span className="material-symbols-outlined" style={{ fontSize: 17 }}>restart_alt</span>
            Reset to defaults
          </button>
        </div>

        <div className={styles.resultColumn}>
          <div className={styles.heroCard}>
            <div className={styles.heroLabel}>Monthly payment</div>
            <div className={styles.heroValue}>{usd(cost.piti, 0)}<span className={styles.heroUnit}>/mo</span></div>
            <div className={styles.heroMeta}>
              {usd(cost.principalAndInterest)} principal &amp; interest + {usd(cost.piti - cost.principalAndInterest)} tax, insurance{cost.hoa > 0 ? ', HOA' : ''}{cost.pmi > 0 ? ', PMI' : ''}
            </div>
            <div className={styles.heroSplit}>
              <div>
                <div className={styles.heroSplitLabel}>Loan amount</div>
                <div className={styles.heroSplitValue}>{usd(cost.loan)}</div>
              </div>
              <div>
                <div className={styles.heroSplitLabel}>Total interest</div>
                <div className={styles.heroSplitValue}>{usd(sched.totalInterest)}</div>
              </div>
              <div>
                <div className={styles.heroSplitLabel}>Paid off</div>
                <div className={styles.heroSplitValue}>{fmtMonthYear(sched.payoffDate)}</div>
              </div>
              <div>
                <div className={styles.heroSplitLabel}>With maintenance</div>
                <div className={styles.heroSplitValue}>{usd(cost.total)}/mo</div>
              </div>
            </div>
          </div>

          <div className={styles.card}>
            <div className={styles.cardTitle}>Where the monthly money goes</div>
            <StackBar parts={parts} total={cost.total} />
            <p className={styles.cardNote}>
              A lender qualifies you on {usd(cost.piti)} — principal, interest, tax, insurance and dues.
              The maintenance line is money you will spend on the house whether or not anyone bills you for it,
              so it belongs in the number you plan around: {usd(cost.total)} a month.
            </p>
          </div>

          {sched.pmiMonthly > 0 && (
            <div className={styles.calloutWarn}>
              <span className="material-symbols-outlined">shield</span>
              <div>
                <strong>{usd(sched.pmiMonthly)}/mo of mortgage insurance</strong>, {usd(sched.totalPmi)} in total.
                It stops around {sched.pmiEndsMonth ? fmtMonthYear(sched.rows[sched.pmiEndsMonth - 1]?.date) : 'the 80% mark'} —
                once the balance falls to {pct(PMI_REQUEST_LTV, 0)} of the purchase price you can ask the servicer to drop it,
                and they must drop it themselves at {pct(PMI_AUTO_LTV, 0)}. Asking is worth doing; nobody does it for you.
              </div>
            </div>
          )}

          {savings && savings.monthsSaved > 0 && (
            <div className={styles.calloutGood}>
              <span className="material-symbols-outlined">savings</span>
              <div>
                Paying extra saves <strong>{usd(savings.interestSaved)}</strong> of interest
                {savings.pmiSaved > 1 ? ` and ${usd(savings.pmiSaved)} of mortgage insurance` : ''} and
                clears the loan <strong>{monthsToTerm(savings.monthsSaved)}</strong> early,
                in {fmtMonthYear(savings.payoffDate)} instead of {fmtMonthYear(savings.without.payoffDate)}.
              </div>
            </div>
          )}

          <div className={styles.card}>
            <div className={styles.cardTitle}>Interest and principal, year by year</div>
            <SplitChart years={sched.years} />
            <div className={styles.legend}>
              <div className={styles.legendItem}>
                <span className={styles.legendDot} style={{ background: COLORS.principal }} />
                <span className={styles.legendLabel}>Principal</span>
              </div>
              <div className={styles.legendItem}>
                <span className={styles.legendDot} style={{ background: COLORS.interest }} />
                <span className={styles.legendLabel}>Interest</span>
              </div>
            </div>
            <p className={styles.cardNote}>
              The payment never changes but its contents do. In year one about
              {' '}{pct(sched.years[0] ? sched.years[0].interest / (sched.years[0].interest + sched.years[0].principal) : 0, 0)}
              {' '}of it is interest; the crossover to mostly-principal comes
              {' '}{(() => {
                const idx = sched.years.findIndex(y => y.principal > y.interest);
                return idx >= 0 ? `in year ${idx + 1}` : 'only near the end of the term';
              })()}.
            </p>
          </div>

          <div className={styles.card}>
            <div className={styles.cardTitle}>Balance remaining</div>
            <BalanceChart years={sched.years} principal={cost.loan} />
          </div>

          <div className={styles.card}>
            <div className={styles.cardTitle}>Amortization schedule</div>
            <div className={styles.tableScroll}>
              <table className={styles.table}>
                <thead>
                  <tr>
                    <th>Year</th>
                    <th className={styles.numCol}>Interest</th>
                    <th className={styles.numCol}>Principal</th>
                    {sched.totalPmi > 0 && <th className={styles.numCol}>PMI</th>}
                    <th className={styles.numCol}>Balance</th>
                    <th aria-label="Expand" />
                  </tr>
                </thead>
                <tbody>
                  {sched.years.map(yr => (
                    <Fragment key={yr.year}>
                      <tr className={styles.clickRow} onClick={() => setOpenYear(openYear === yr.year ? null : yr.year)}>
                        <td>{yr.year} <span className={styles.dim}>({fmtMonthYear(yr.endDate)})</span></td>
                        <td className={styles.numCol}>{usd(yr.interest)}</td>
                        <td className={styles.numCol}>{usd(yr.principal)}</td>
                        {sched.totalPmi > 0 && <td className={styles.numCol}>{yr.pmi > 0 ? usd(yr.pmi) : '—'}</td>}
                        <td className={styles.numCol}>{usd(yr.endBalance)}</td>
                        <td className={styles.actionCol}>
                          <span className="material-symbols-outlined" style={{ fontSize: 18, color: 'var(--color-text-tertiary)' }}>
                            {openYear === yr.year ? 'expand_less' : 'expand_more'}
                          </span>
                        </td>
                      </tr>
                      {openYear === yr.year && sched.rows
                        .filter(r => Math.ceil(r.month / 12) === yr.year)
                        .map(r => (
                          <tr key={r.month} className={styles.subRow}>
                            <td className={styles.subCell}>{fmtMonthYear(r.date)}</td>
                            <td className={styles.numCol}>{usd(r.interest, 2)}</td>
                            <td className={styles.numCol}>{usd(r.principal + r.extra, 2)}</td>
                            {sched.totalPmi > 0 && <td className={styles.numCol}>{r.pmi > 0 ? usd(r.pmi, 2) : '—'}</td>}
                            <td className={styles.numCol}>{usd(r.balance)}</td>
                            <td />
                          </tr>
                        ))}
                    </Fragment>
                  ))}
                </tbody>
                <tfoot>
                  <tr>
                    <td className={styles.totalLabel}>Total over {monthsToTerm(sched.months)}</td>
                    <td className={styles.numCol}><strong>{usd(sched.totalInterest)}</strong></td>
                    <td className={styles.numCol}><strong>{usd(cost.loan)}</strong></td>
                    {sched.totalPmi > 0 && <td className={styles.numCol}><strong>{usd(sched.totalPmi)}</strong></td>}
                    <td colSpan={2} />
                  </tr>
                </tfoot>
              </table>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

/* ──────────────────────────────────────────────────────────────
   Tab 2 — Buy vs. rent, on the NYT method
   ────────────────────────────────────────────────────────────── */

function BuyVsRentTab({ v, set }) {
  const result = useMemo(() => analyzeBuyVsRent(v), [v]);
  const series = useMemo(() => horizonSeries(v, 30), [v]);
  const { buy, rent, breakEvenRent } = result;

  const rentNow = Math.max(0, Number(v.monthlyRent) || 0);
  const buying = result.verdict === 'buy';
  const margin = Math.abs(result.difference);
  // Two paths within a couple of percent of each other are a tie in a model
  // with this many assumptions in it, and saying so is more useful than a
  // confident verdict resting on the third decimal of the growth rate.
  const tooClose = margin < Math.max(buy.total, rent.total) * 0.03;

  return (
    <div className={styles.tabBody}>
      <div className={styles.splitLayout}>
        <div className={styles.inputColumn}>
          <div className={styles.card}>
            <div className={styles.cardTitle}>The basics</div>
            <div className={styles.formGrid}>
              <Field label="Home price" prefix="$" step="5000" value={v.price} onChange={val => set({ price: val })} />
              <Field label="Comparable rent" prefix="$" suffix="/mo" step="50" value={v.monthlyRent} onChange={val => set({ monthlyRent: val })}
                hint="a place you'd actually be happy in" />
              <Field label="Years you'll stay" step="1" min={1} max={40} value={v.years} onChange={val => set({ years: val })} />
              <Field label="Mortgage rate" suffix="%" step="0.125" value={v.mortgageRatePct} onChange={val => set({ mortgageRatePct: val })} />
              <Field label="Down payment" suffix="%" step="1" max={100} value={v.downPct} onChange={val => set({ downPct: val })}
                hint={usd((Number(v.price) || 0) * (Number(v.downPct) || 0) / 100)} />
              <Field label="Term">
                <select className={styles.input} value={v.termYears} onChange={e => set({ termYears: Number(e.target.value) })}>
                  {[30, 25, 20, 15, 10].map(t => <option key={t} value={t}>{t} years</option>)}
                </select>
              </Field>
            </div>
          </div>

          <Section title="Growth and returns" note="The four rates that decide most of the answer. Nudge them and watch the verdict move — that fragility is the real finding.">
            <Field label="Home price growth" suffix="%/yr" step="0.25" value={v.homeGrowthPct} onChange={val => set({ homeGrowthPct: val })} />
            <Field label="Rent growth" suffix="%/yr" step="0.25" value={v.rentGrowthPct} onChange={val => set({ rentGrowthPct: val })} />
            <Field label="Investment return" suffix="%/yr" step="0.25" value={v.investmentReturnPct} onChange={val => set({ investmentReturnPct: val })}
              hint="what the down payment would have earned" />
            <Field label="Inflation" suffix="%/yr" step="0.25" value={v.inflationPct} onChange={val => set({ inflationPct: val })} />
          </Section>

          <Section title="Taxes" note={`Defaults are ${TAX_YEAR} federal figures. The mortgage-interest deduction only helps to the extent itemizing beats the standard deduction — for most buyers that is nothing at all.`}>
            <Field label="Filing status">
              <select className={styles.input} value={v.filingStatus}
                onChange={e => set({ filingStatus: e.target.value, standardDeduction: STANDARD_DEDUCTION[e.target.value] })}>
                {FILING_STATUSES.map(f => <option key={f.id} value={f.id}>{f.label}</option>)}
              </select>
            </Field>
            <Field label="Marginal tax rate" suffix="%" step="1" value={v.marginalTaxPct} onChange={val => set({ marginalTaxPct: val })} />
            <Field label="Standard deduction" prefix="$" step="50" value={v.standardDeduction} onChange={val => set({ standardDeduction: val })} />
            <Field label="Property tax" suffix="%/yr" step="0.05" value={v.propertyTaxPct} onChange={val => set({ propertyTaxPct: val })} />
            <Field label="Other state/local tax" prefix="$" suffix="/yr" step="500" value={v.otherSaltAnnual} onChange={val => set({ otherSaltAnnual: val })}
              hint="shares the SALT cap with property tax" />
            <Field label="SALT cap" prefix="$" step="1000" value={v.saltCap} onChange={val => set({ saltCap: val })}
              hint={`${usd(SALT_CAP)} for ${TAX_YEAR}; falls to $10,000 in 2030`} />
            <Field label="Other itemized deductions" prefix="$" suffix="/yr" step="500" value={v.otherItemizedAnnual} onChange={val => set({ otherItemizedAnnual: val })} />
            <Field label="Interest deduction debt cap" prefix="$" step="50000" value={v.interestDebtCap} onChange={val => set({ interestDebtCap: val })}
              hint={`${usd(INTEREST_DEBT_CAP)} on loans since Dec 2017`} />
            <Field label="Capital gains rate" suffix="%" step="1" value={v.capGainsRatePct} onChange={val => set({ capGainsRatePct: val })} />
            <Field label="Gain exclusion" wide>
              <label className={styles.checkRow}>
                <input type="checkbox" checked={!!v.applyGainExclusion} onChange={e => set({ applyGainExclusion: e.target.checked })} />
                <span>Exclude {usd(GAIN_EXCLUSION[v.filingStatus] ?? GAIN_EXCLUSION.single)} of gain on sale (main home, lived in 2 of the last 5 years)</span>
              </label>
            </Field>
          </Section>

          <Section title="Costs of owning" note="The line items that decide the answer as often as the interest rate does.">
            <Field label="Maintenance" suffix="%/yr" step="0.1" value={v.maintenancePct} onChange={val => set({ maintenancePct: val })}
              hint="1% of value a year is the usual rule" />
            <Field label="Home insurance" suffix="%/yr" step="0.05" value={v.homeInsurancePct} onChange={val => set({ homeInsurancePct: val })} />
            <Field label="HOA / common charges" prefix="$" suffix="/mo" step="25" value={v.hoaMonthly} onChange={val => set({ hoaMonthly: val })} />
            <Field label="…deductible share" suffix="%" step="5" max={100} value={v.hoaDeductiblePct} onChange={val => set({ hoaDeductiblePct: val })}
              hint="co-ops pass through interest and tax" />
            <Field label="Extra utilities vs. renting" prefix="$" suffix="/mo" step="25" value={v.extraUtilitiesMonthly} onChange={val => set({ extraUtilitiesMonthly: val })} />
            <Field label="Mortgage insurance" suffix="%/yr" step="0.05" value={v.pmiAnnualPct} onChange={val => set({ pmiAnnualPct: val })}
              hint="charged under 20% down" />
            <Field label="Closing costs to buy" suffix="%" step="0.25" value={v.buyClosingPct} onChange={val => set({ buyClosingPct: val })} />
            <Field label="Closing costs to sell" suffix="%" step="0.5" value={v.sellClosingPct} onChange={val => set({ sellClosingPct: val })}
              hint="agent commission plus transfer taxes" />
          </Section>

          <Section title="Costs of renting">
            <Field label="Renter's insurance" prefix="$" suffix="/mo" step="5" value={v.rentersInsuranceMonthly} onChange={val => set({ rentersInsuranceMonthly: val })} />
            <Field label="Security deposit" suffix="months" step="0.5" value={v.securityDepositMonths} onChange={val => set({ securityDepositMonths: val })} />
            <Field label="Broker's fee" suffix="% of a year's rent" step="1" value={v.brokerFeePct} onChange={val => set({ brokerFeePct: val })} />
          </Section>

          <button className={styles.btnGhost} onClick={() => set({ ...BVR_DEFAULTS })}>
            <span className="material-symbols-outlined" style={{ fontSize: 17 }}>restart_alt</span>
            Reset to defaults
          </button>
        </div>

        <div className={styles.resultColumn}>
          <div className={`${styles.verdictCard} ${buying ? styles.verdictBuy : styles.verdictRent}`}>
            <div className={styles.verdictKicker}>Over {result.years} year{result.years === 1 ? '' : 's'}, at {usd(rentNow)}/mo rent</div>
            <div className={styles.verdictHeadline}>
              {tooClose ? 'Too close to call' : buying ? 'Buying comes out ahead' : 'Renting comes out ahead'}
            </div>
            <div className={styles.verdictSub}>
              {tooClose
                ? `The two paths land within ${usd(margin)} of each other — inside the margin of error on assumptions like these.`
                : `by ${usd(margin)} in total cost.`}
            </div>
            <div className={styles.breakEven}>
              <div className={styles.breakEvenLabel}>Break-even rent</div>
              <div className={styles.breakEvenValue}>{usd(breakEvenRent)}<span className={styles.heroUnit}>/mo</span></div>
              <div className={styles.breakEvenNote}>
                If a comparable home rents for <strong>more</strong> than this, buying wins.
                For <strong>less</strong>, renting wins. You entered {usd(rentNow)}.
              </div>
            </div>
          </div>

          <div className={styles.statGrid}>
            <div className={styles.statCard}>
              <div className={styles.statLabel}>Total cost of buying</div>
              <div className={styles.statValue}>{usd(buy.total)}</div>
              <div className={styles.statSub}>{usd(buy.total / result.months)}/mo equivalent</div>
            </div>
            <div className={styles.statCard}>
              <div className={styles.statLabel}>Total cost of renting</div>
              <div className={styles.statValue}>{usd(rent.total)}</div>
              <div className={styles.statSub}>{usd(rent.total / result.months)}/mo equivalent</div>
            </div>
            <div className={styles.statCard}>
              <div className={styles.statLabel}>Break-even stay</div>
              <div className={styles.statValue}>{series.crossover ? `${series.crossover} yr` : '30+ yr'}</div>
              <div className={styles.statSub}>
                {series.crossover ? 'before this, renting is cheaper' : 'buying never catches up in 30 years'}
              </div>
            </div>
            <div className={styles.statCard}>
              <div className={styles.statLabel}>Cash needed at closing</div>
              <div className={styles.statValue}>{usd(buy.initial)}</div>
              <div className={styles.statSub}>{usd(buy.downPayment)} down + {usd(buy.buyClosing)} costs</div>
            </div>
          </div>

          <div className={styles.card}>
            <div className={styles.cardTitle}>How long you have to stay</div>
            <CrossoverChart rows={series.rows} crossover={series.crossover} highlightYear={result.years} />
            <p className={styles.cardNote}>
              Each point is its own comparison — buy now and sell after that many years, against renting for the same stretch.
              Buying starts far behind because {usd(buy.initial)} goes out the door on day one and
              {' '}{usd(buy.sellingCosts)} disappears at the sale; it catches up as the loan is paid down and the rent keeps climbing.
            </p>
          </div>

          <div className={styles.card}>
            <div className={styles.cardTitle}>Break-even rent by length of stay</div>
            <BreakEvenChart rows={series.rows} highlightYear={result.years} actualRent={rentNow} />
            <p className={styles.cardNote}>
              The longer you stay, the more rent you'd have to be paying for buying to be the mistake.
              Where the dashed line sits above the curve, buying wins.
            </p>
          </div>

          <div className={styles.twoUp}>
            <div className={styles.card}>
              <div className={styles.cardTitle}>Cost of buying, itemized</div>
              <Row label="Down payment" value={usd(buy.downPayment)} indent />
              <Row label="Closing costs to buy" value={usd(buy.buyClosing)} indent />
              <Row label="Initial costs" value={usd(buy.initial)} strong />
              <Row label="Mortgage payments" value={usd(buy.components.mortgage)} indent sub={`${usd(buy.monthlyPI)}/mo on a ${usd(buy.loan)} loan`} />
              <Row label="Property tax" value={usd(buy.components.propertyTax)} indent />
              <Row label="Maintenance" value={usd(buy.components.maintenance)} indent />
              <Row label="Home insurance" value={usd(buy.components.insurance)} indent />
              {buy.components.hoa > 0 && <Row label="HOA dues" value={usd(buy.components.hoa)} indent />}
              {buy.components.pmi > 0 && <Row label="Mortgage insurance" value={usd(buy.components.pmi)} indent />}
              {buy.components.utilities > 0 && <Row label="Extra utilities" value={usd(buy.components.utilities)} indent />}
              <Row label="Recurring costs" value={usd(buy.recurringGross)} strong />
              <Row label="Tax benefit of itemizing" value={`− ${usd(buy.taxBenefit)}`} tone={buy.taxBenefit > 0 ? 'good' : undefined}
                sub={buy.taxBenefit > 0 ? undefined : 'itemizing never beats the standard deduction here'} />
              <Row label="Opportunity cost" value={usd(buy.opportunity)}
                sub={`what all of it would have earned at ${Number(v.investmentReturnPct)}%`} />
              <Row label="Net proceeds from the sale" value={`− ${usd(buy.netProceeds)}`} tone="good"
                sub={`${usd(buy.saleValue)} sale − ${usd(buy.sellingCosts)} costs − ${usd(buy.payoff)} payoff${buy.capGainsTax > 0 ? ` − ${usd(buy.capGainsTax)} tax` : ''}`} />
              <Row label="Total cost of buying" value={usd(buy.total)} strong />
            </div>

            <div className={styles.card}>
              <div className={styles.cardTitle}>Cost of renting, itemized</div>
              <Row label="Security deposit" value={usd(rent.deposit)} indent />
              {rent.brokerFee > 0 && <Row label="Broker's fee" value={usd(rent.brokerFee)} indent />}
              <Row label="Initial costs" value={usd(rent.initial)} strong />
              <Row label="Rent" value={usd(rent.rentPaid)} indent
                sub={`${usd(rent.firstMonthRent)}/mo rising to ${usd(rent.lastMonthRent)}/mo`} />
              <Row label="Renter's insurance" value={usd(rent.insurancePaid)} indent />
              <Row label="Recurring costs" value={usd(rent.recurring)} strong />
              <Row label="Opportunity cost" value={usd(rent.opportunity)}
                sub="on the deposit and every rent cheque" />
              <Row label="Deposit returned" value={`− ${usd(rent.netProceeds)}`} tone="good" />
              <Row label="Total cost of renting" value={usd(rent.total)} strong />
              <p className={styles.cardNote}>
                Renting has no equity at the end, which is the argument people reach for first — but it also has no
                {' '}{usd(buy.sellingCosts)} of selling costs, no {usd(buy.components.maintenance)} of maintenance,
                and it never had {usd(buy.initial)} sitting in a house instead of the market.
              </p>
            </div>
          </div>

          <div className={styles.calloutInfo}>
            <span className="material-symbols-outlined">info</span>
            <div>
              Every figure above is in end-of-horizon dollars: costs are carried forward at the investment
              return rate rather than discounted back, which is what makes "opportunity cost" a line you can point at.
              The comparison between the two totals is unaffected by that choice — see the Method tab.
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

/* ──────────────────────────────────────────────────────────────
   Tab 3 — Affordability
   ────────────────────────────────────────────────────────────── */

function AffordabilityTab({ v, set }) {
  const res = useMemo(() => affordablePrice({
    annualIncome: v.annualIncome,
    monthlyDebts: v.monthlyDebts,
    downPayment: v.downPayment,
    annualRatePct: v.ratePct,
    termYears: v.termYears,
    propertyTaxPct: v.propertyTaxPct,
    homeInsurancePct: v.homeInsurancePct,
    hoaMonthly: v.hoaMonthly,
    pmiAnnualPct: v.pmiAnnualPct,
    frontEndDti: v.frontEndDti,
    backEndDti: v.backEndDti,
  }), [v]);

  const income = Math.max(0, Number(v.annualIncome) || 0);
  const cash = Math.max(0, Number(v.downPayment) || 0);
  const cost = res.cost;
  // What the same income buys at the stretched ratio lenders will actually
  // approve — shown as a boundary, not a target.
  const stretch = useMemo(() => affordablePrice({
    annualIncome: v.annualIncome, monthlyDebts: v.monthlyDebts, downPayment: v.downPayment,
    annualRatePct: v.ratePct, termYears: v.termYears, propertyTaxPct: v.propertyTaxPct,
    homeInsurancePct: v.homeInsurancePct, hoaMonthly: v.hoaMonthly, pmiAnnualPct: v.pmiAnnualPct,
    frontEndDti: 31, backEndDti: 43,
  }), [v]);

  const twentyPct = res.maxPrice > 0 ? cash / res.maxPrice : 0;

  return (
    <div className={styles.tabBody}>
      <div className={styles.splitLayout}>
        <div className={styles.inputColumn}>
          <div className={styles.card}>
            <div className={styles.cardTitle}>You</div>
            <div className={styles.formGrid}>
              <Field label="Household income" prefix="$" suffix="/yr" step="5000" value={v.annualIncome} onChange={val => set({ annualIncome: val })}
                hint="gross, before tax — the figure lenders use" />
              <Field label="Other monthly debts" prefix="$" suffix="/mo" step="50" value={v.monthlyDebts} onChange={val => set({ monthlyDebts: val })}
                hint="car, student loans, card minimums" />
              <Field label="Cash for down payment" prefix="$" step="5000" value={v.downPayment} onChange={val => set({ downPayment: val })}
                hint="keep closing costs and a reserve out of this" />
            </div>
          </div>

          <div className={styles.card}>
            <div className={styles.cardTitle}>The loan and the house</div>
            <div className={styles.formGrid}>
              <Field label="Interest rate" suffix="%" step="0.125" value={v.ratePct} onChange={val => set({ ratePct: val })} />
              <Field label="Term">
                <select className={styles.input} value={v.termYears} onChange={e => set({ termYears: Number(e.target.value) })}>
                  {[30, 25, 20, 15].map(t => <option key={t} value={t}>{t} years</option>)}
                </select>
              </Field>
              <Field label="Property tax" suffix="%/yr" step="0.05" value={v.propertyTaxPct} onChange={val => set({ propertyTaxPct: val })} />
              <Field label="Home insurance" suffix="%/yr" step="0.05" value={v.homeInsurancePct} onChange={val => set({ homeInsurancePct: val })} />
              <Field label="HOA dues" prefix="$" suffix="/mo" step="25" value={v.hoaMonthly} onChange={val => set({ hoaMonthly: val })} />
              <Field label="Mortgage insurance" suffix="%/yr" step="0.05" value={v.pmiAnnualPct} onChange={val => set({ pmiAnnualPct: val })} />
            </div>
          </div>

          <div className={styles.card}>
            <div className={styles.cardTitle}>Debt-to-income limits</div>
            <div className={styles.formGrid}>
              <Field label="Housing ratio" suffix="%" step="1" value={v.frontEndDti} onChange={val => set({ frontEndDti: val })}
                hint="housing ÷ gross income" />
              <Field label="Total debt ratio" suffix="%" step="1" value={v.backEndDti} onChange={val => set({ backEndDti: val })}
                hint="all debt ÷ gross income" />
            </div>
            <p className={styles.cardNote}>
              28/36 is the conservative rule and the one worth planning to. Lenders will approve
              31/43 and often more; that is the edge of what they will lend, not the edge of what you should borrow.
            </p>
          </div>

          <button className={styles.btnGhost} onClick={() => set({ ...AFFORD_DEFAULTS })}>
            <span className="material-symbols-outlined" style={{ fontSize: 17 }}>restart_alt</span>
            Reset to defaults
          </button>
        </div>

        <div className={styles.resultColumn}>
          <div className={styles.heroCard}>
            <div className={styles.heroLabel}>Comfortable price</div>
            <div className={styles.heroValue}>{usd(Math.round(res.maxPrice / 1000) * 1000)}</div>
            <div className={styles.heroMeta}>
              at {Number(v.frontEndDti)}/{Number(v.backEndDti)} with {usd(cash)} down — a {usd(res.budget)} monthly housing budget,
              limited by your {res.limitedBy}
            </div>
            <div className={styles.heroSplit}>
              <div>
                <div className={styles.heroSplitLabel}>Loan</div>
                <div className={styles.heroSplitValue}>{usd(cost?.loan)}</div>
              </div>
              <div>
                <div className={styles.heroSplitLabel}>Down payment</div>
                <div className={styles.heroSplitValue}>{pct(twentyPct, 0)}</div>
              </div>
              <div>
                <div className={styles.heroSplitLabel}>Monthly (PITI)</div>
                <div className={styles.heroSplitValue}>{usd(cost?.piti)}</div>
              </div>
              <div>
                <div className={styles.heroSplitLabel}>Lender's maximum</div>
                <div className={styles.heroSplitValue}>{usd(Math.round(stretch.maxPrice / 1000) * 1000)}</div>
              </div>
            </div>
          </div>

          <div className={styles.statGrid}>
            <div className={styles.statCard}>
              <div className={styles.statLabel}>Housing budget</div>
              <div className={styles.statValue}>{usd(res.frontCap)}</div>
              <div className={styles.statSub}>{Number(v.frontEndDti)}% of {usd(income / 12)}/mo</div>
            </div>
            <div className={styles.statCard}>
              <div className={styles.statLabel}>After other debts</div>
              <div className={styles.statValue}>{usd(res.backCap)}</div>
              <div className={styles.statSub}>{Number(v.backEndDti)}% of income − {usd(Number(v.monthlyDebts) || 0)} debts</div>
            </div>
            <div className={`${styles.statCard} ${twentyPct < 0.2 ? styles.statWarn : styles.statGood}`}>
              <div className={styles.statLabel}>Down payment</div>
              <div className={styles.statValue}>{pct(twentyPct, 0)}</div>
              <div className={styles.statSub}>
                {twentyPct < 0.2 ? `${usd(res.maxPrice * 0.2 - cash)} short of 20% — PMI applies` : 'clears 20% — no PMI'}
              </div>
            </div>
            <div className={styles.statCard}>
              <div className={styles.statLabel}>Cash to close</div>
              <div className={styles.statValue}>{usd(cash + res.maxPrice * 0.02)}</div>
              <div className={styles.statSub}>down payment + ~2% closing costs</div>
            </div>
          </div>

          {cost && (
            <div className={styles.card}>
              <div className={styles.cardTitle}>What the monthly budget buys</div>
              <StackBar
                parts={[
                  { key: 'pi', label: 'Principal & interest', value: cost.principalAndInterest, color: COLORS.pi },
                  { key: 'tax', label: 'Property tax', value: cost.propertyTax, color: COLORS.tax },
                  { key: 'ins', label: 'Home insurance', value: cost.insurance, color: COLORS.insurance },
                  { key: 'hoa', label: 'HOA dues', value: cost.hoa, color: COLORS.hoa },
                  { key: 'pmi', label: 'Mortgage insurance', value: cost.pmi, color: COLORS.pmi },
                ]}
                total={cost.piti}
              />
              <p className={styles.cardNote}>
                Only {pct(cost.principalAndInterest / cost.piti, 0)} of the payment is the loan.
                Raising the down payment to 20% would drop {usd(cost.pmi)} of mortgage insurance
                {cost.pmi > 0 ? ' straight off the monthly figure' : ''}.
              </p>
            </div>
          )}

          <div className={styles.calloutInfo}>
            <span className="material-symbols-outlined">info</span>
            <div>
              This is what a lender's arithmetic says you can carry. It knows your gross income and your
              debts and nothing else — not childcare, not the 401(k) you're funding, not that the property
              tax on the house you want is double the rate you typed. Treat the comfortable price as a
              ceiling, and run it through the Buy vs. Rent tab before deciding it's a good idea.
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

/* ──────────────────────────────────────────────────────────────
   Tab 4 — Method
   ────────────────────────────────────────────────────────────── */

function MethodTab() {
  return (
    <div className={styles.tabBody}>
      <div className={styles.prose}>
        <h2>Where this comes from</h2>
        <p>
          The Buy vs. Rent tab follows the method of the New York Times Upshot's
          rent-or-buy calculator, which is the most careful public version of this comparison.
          These are the ideas worth stealing from it, and what each one changes.
        </p>

        <h3>1. Compare total cost over a horizon, not monthly payments</h3>
        <p>
          "My mortgage would be $2,400 and rent is $2,600" is not a comparison. Part of a mortgage
          payment is savings, not cost; and rent is not the whole cost of renting either. This model
          picks a number of years, runs both paths month by month to that date, <em>sells the house</em>,
          and totals what each one really cost. Change the horizon and the answer can flip — which
          is the point.
        </p>

        <h3>2. Opportunity cost is a line item, on both sides</h3>
        <p>
          A down payment isn't spent, it's tied up. Money in a house is money not in the market.
          Every dollar either path pays out is compounded forward at the investment return rate to
          the end of the horizon, and the difference between that and the raw sum is shown as
          <strong> opportunity cost</strong>. Renting gets the same treatment on its deposit and
          broker fee, so neither side is flattered by the accounting.
        </p>
        <p className={styles.aside}>
          A consequence people find surprising: raising the assumed investment return makes
          <em> buying</em> look worse, because the down payment you didn't invest is the largest
          single sum in the model. Two points on that rate move the verdict more than half a point
          on the mortgage rate.
        </p>

        <h3>3. The tax benefit is only what beats the standard deduction</h3>
        <p>
          This is the single correction that most calculators get wrong. A renter takes the standard
          deduction for free — {usd(STANDARD_DEDUCTION.married)} filing jointly in {TAX_YEAR}. An owner who itemizes
          only gains from the amount by which itemizing <em>exceeds</em> that. Crediting the full
          mortgage interest deduction, as most tools do, overstates buying by thousands a year.
        </p>
        <ul>
          <li>Mortgage interest is deductible on the first {usd(INTEREST_DEBT_CAP)} of acquisition debt (loans since December 2017). Above that, only the corresponding share of interest counts.</li>
          <li>Property tax is deductible only inside the SALT cap — {usd(SALT_CAP)} for {TAX_YEAR}, shared with state income tax, and scheduled to fall back to $10,000 in 2030.</li>
          <li>The benefit is <code>max(0, itemized − standard) × your marginal rate</code>, settled once a year.</li>
          <li>With 20% down on a median-priced home at today's rates, that benefit is frequently <strong>zero</strong>. The model will show it as zero rather than pretending.</li>
        </ul>

        <h3>4. Solve for the break-even rent</h3>
        <p>
          The useful output isn't a total, it's a threshold: <em>buying wins if a comparable home rents
          for more than $X a month</em>. That's a number you can check against listings. Rent enters
          the model linearly — the rent itself, the deposit and the broker's fee all scale with it —
          so the break-even is solved exactly rather than searched for.
        </p>

        <h3>5. Price the unglamorous costs</h3>
        <p>
          Maintenance at about 1% of value a year, homeowner's insurance, HOA dues, the extra utilities
          on a place bigger than your rental, ~2% in closing costs going in and 5–6% in agent
          commission and transfer taxes coming out. These decide the answer as often as the interest
          rate does, and they are exactly what gets left out. The 6% on the way out is why buying and
          selling inside three years so rarely works.
        </p>

        <h2>What the model does that the NYT version doesn't</h2>
        <ul>
          <li><strong>Monthly, not annual, steps.</strong> The mortgage is amortized month by month, so the balance at any horizon is the real one.</li>
          <li><strong>PMI.</strong> Below 20% down, mortgage insurance is charged until the balance falls to {pct(PMI_REQUEST_LTV, 0)} of the purchase price, and the total shows up as its own line.</li>
          <li><strong>Capital gains on sale.</strong> The Section 121 exclusion — {usd(GAIN_EXCLUSION.single)} single, {usd(GAIN_EXCLUSION.married)} joint — is applied, and any gain above it is taxed.</li>
          <li><strong>A break-even curve, not a single year.</strong> The comparison is re-run at every horizon from 1 to 30 years, which is what produces the crossover chart.</li>
        </ul>

        <h2>Assumptions worth knowing about</h2>
        <ul>
          <li><strong>Property tax tracks market value.</strong> California's Proposition 13, Florida's Save Our Homes and similar caps hold assessments below market. In those states the model overstates the tax bill in later years.</li>
          <li><strong>Growth rates are smooth.</strong> Homes don't appreciate 3% every year; they go sideways for six and jump 20% in one. A smooth rate gets the average right and the risk wrong, and the risk is the part that matters if you might have to sell early.</li>
          <li><strong>Maintenance and insurance are a percentage of current value.</strong> Both really track replacement cost, which drifts from market value — particularly in places where the land is most of the price.</li>
          <li><strong>The tax refund arrives at year end.</strong> In reality it arrives the following spring, or shows up in withholding through the year. A few months of interest on it is noise here.</li>
          <li><strong>Cost basis is the purchase price.</strong> Capitalizable closing costs and improvements would raise it and cut the tax on sale, so the gains figure errs high.</li>
          <li><strong>No refinancing, no ARM, no rate change.</strong> One fixed rate for the whole term.</li>
          <li><strong>Totals are in end-of-horizon dollars</strong> — carried forward at the investment return rate rather than discounted back. Discounting instead would divide both totals by the same factor: the comparison, the break-even rent and the crossover year are all unchanged.</li>
        </ul>

        <h2>What no calculator can price</h2>
        <p>
          That you can paint the walls. That the landlord can sell out from under you.
          That a job offer two states away costs a renter one month's notice and an owner 6% plus
          a season of showings. That a paid-off house at 70 is a different retirement.
          These decide plenty of moves, and they belong in the decision even though they're not in the total.
        </p>
      </div>
    </div>
  );
}

/* ──────────────────────────────────────────────────────────────
   Page
   ────────────────────────────────────────────────────────────── */

const TABS = [
  { id: 'mortgage', label: 'Mortgage', icon: 'calculate' },
  { id: 'buyrent', label: 'Buy vs. Rent', icon: 'balance' },
  { id: 'afford', label: 'Affordability', icon: 'account_balance_wallet' },
  { id: 'method', label: 'Method', icon: 'menu_book' },
];

export function HomeBuyingPage() {
  const [tab, setTab] = useState('mortgage');
  const [state, setState] = useState(loadStored);

  useEffect(() => {
    try { localStorage.setItem(STORE_KEY, JSON.stringify(state)); } catch { /* quota — the calculator still works */ }
  }, [state]);

  const setMortgage = useCallback((patch) => setState(s => ({ ...s, mortgage: { ...s.mortgage, ...patch } })), []);
  const setBuyRent = useCallback((patch) => setState(s => ({ ...s, buyRent: { ...s.buyRent, ...patch } })), []);
  const setAfford = useCallback((patch) => setState(s => ({ ...s, afford: { ...s.afford, ...patch } })), []);

  return (
    <div className={styles.page}>
      <header className={styles.pageHeader}>
        <div>
          <h1 className={styles.pageTitle}>Buying a Home</h1>
          <p className={styles.pageSubtitle}>
            What the payment really is, and whether the whole thing beats renting.
          </p>
        </div>
      </header>

      <nav className={styles.tabBar}>
        {TABS.map(t => (
          <button
            key={t.id}
            className={`${styles.tab} ${tab === t.id ? styles.tabActive : ''}`}
            onClick={() => setTab(t.id)}
          >
            <span className="material-symbols-outlined" style={{ fontSize: 18 }}>{t.icon}</span>
            {t.label}
          </button>
        ))}
      </nav>

      {tab === 'mortgage' && <MortgageTab v={state.mortgage} set={setMortgage} />}
      {tab === 'buyrent' && <BuyVsRentTab v={state.buyRent} set={setBuyRent} />}
      {tab === 'afford' && <AffordabilityTab v={state.afford} set={setAfford} />}
      {tab === 'method' && <MethodTab />}
    </div>
  );
}

export default HomeBuyingPage;
