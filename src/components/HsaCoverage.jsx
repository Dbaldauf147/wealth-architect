import { useMemo, useState } from 'react';
import { normalizePlan, planBreakpoints, planCost, planProgress } from '../lib/hsa';

/* The health plan behind the HSA, in-network: how a year's medical bills
   split between you and insurance through the deductible, coinsurance and
   out-of-pocket-max phases — explained in words, drawn as a chart, and placed
   against what's been spent from the HSA this year. */

const fmt = (n) => new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 0 }).format(n || 0);
const pct = (n) => `${Math.round(n * 100)}%`;

const YOU = '#eb6834';
const INS = '#2a78d6';
const PHASE_BG = { deductible: 'rgba(235,104,52,0.07)', coinsurance: 'rgba(120,120,120,0.05)', covered: 'rgba(42,120,214,0.08)' };

const card = { background: 'var(--color-surface)', border: '1px solid var(--border-ghost)', borderRadius: 12, padding: 16 };
const h = { fontFamily: 'var(--font-headline)', fontSize: 16, fontWeight: 700 };
const muted = { fontSize: 12, color: 'var(--color-text-tertiary)' };
const input = { width: 90, padding: '4px 6px', marginLeft: 4, fontSize: 12.5, fontVariantNumeric: 'tabular-nums' };

function niceMax(v) {
  const step = v > 20000 ? 5000 : v > 8000 ? 2000 : 1000;
  return Math.ceil(v / step) * step;
}

export default function HsaCoverage({ plan: rawPlan, spent, year, save }) {
  const plan = normalizePlan(rawPlan);
  const { deductible, coinsurance, oopMax } = plan;
  const { oopAt } = planBreakpoints(plan);
  const [override, setOverride] = useState(null);
  const paid = override ?? spent;
  const progress = planProgress(paid, plan);
  const [bill, setBill] = useState(1000);
  const before = planCost(progress.bills, plan);
  const after = planCost(progress.bills + (Number(bill) || 0), plan);
  const billYou = Math.round((after.you - before.you) * 100) / 100;

  function setPlan(key, value) {
    save({ plan: { ...plan, [key]: value } });
  }

  const youShare = 1 - coinsurance;
  const phaseLabel = {
    deductible: 'still in the deductible',
    coinsurance: 'past the deductible, in coinsurance',
    covered: 'at the out-of-pocket max — fully covered',
  }[progress.phase];

  return (
    <div style={card} data-testid="hsa-coverage">
      <div style={{ display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', gap: 12, flexWrap: 'wrap', marginBottom: 4 }}>
        <div style={h}>Insurance coverage (in-network)</div>
        <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap', fontSize: 12, color: 'var(--color-text-secondary)' }}>
          <label>Deductible<input aria-label="Deductible" type="number" min="0" step="50" value={deductible} onChange={e => setPlan('deductible', Number(e.target.value))} style={input} /></label>
          <label>Insurance pays<input aria-label="Insurance pays percent" type="number" min="0" max="100" step="5" value={Math.round(coinsurance * 100)} onChange={e => setPlan('coinsurance', Number(e.target.value) / 100)} style={{ ...input, width: 56 }} />%</label>
          <label>Out-of-pocket max<input aria-label="Out-of-pocket max" type="number" min="0" step="50" value={oopMax} onChange={e => setPlan('oopMax', Number(e.target.value))} style={input} /></label>
        </div>
      </div>
      <div style={{ ...muted, marginBottom: 14 }}>How a year of medical bills splits between you and insurance. Resets every January 1.</div>

      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(200px, 1fr))', gap: 10, marginBottom: 16 }}>
        <Phase n={1} color={YOU} title={`Deductible: first ${fmt(deductible)}`}
          body={`You pay 100% of in-network bills until you've paid ${fmt(deductible)}. Insurance pays nothing yet (preventive care is usually free regardless).`} />
        <Phase n={2} color={`linear-gradient(90deg, ${YOU} ${pct(youShare)}, ${INS} ${pct(youShare)})`} title={`Coinsurance: you ${pct(youShare)}, insurance ${pct(coinsurance)}`}
          body={`After the deductible, each bill is split — you pay ${pct(youShare)}, insurance ${pct(coinsurance)}. Your share keeps counting toward ${fmt(oopMax)}. That takes ${fmt(oopAt)} of total bills.`} />
        <Phase n={3} color={INS} title={`Out-of-pocket max: ${fmt(oopMax)}`}
          body={`Once you've paid ${fmt(oopMax)} in a year (deductible + coinsurance), insurance pays 100% of in-network care for the rest of the year.`} />
      </div>

      <CoverageChart plan={plan} oopAt={oopAt} progress={progress} />

      <div style={{ marginTop: 18, display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(280px, 1fr))', gap: 16 }}>
        <div>
          <div style={{ fontWeight: 700, fontSize: 13.5, marginBottom: 6 }}>Your {year} so far</div>
          <Meter paid={progress.paid} deductible={deductible} oopMax={oopMax} />
          <div style={{ fontSize: 12.5, color: 'var(--color-text-secondary)', marginTop: 8, lineHeight: 1.5 }}>
            You've paid <b>{fmt(progress.paid)}</b> — {phaseLabel}.{' '}
            {progress.deductibleLeft > 0 && <>{fmt(progress.deductibleLeft)} left on the deductible. </>}
            {progress.oopLeft > 0 ? <>{fmt(progress.oopLeft)} more until insurance covers 100%.</> : <>Insurance pays everything in-network for the rest of {year}.</>}
          </div>
          <label style={{ ...muted, display: 'block', marginTop: 8 }}>
            Out-of-pocket so far
            <input aria-label="Out-of-pocket so far" type="number" min="0" step="10" value={Math.round(paid * 100) / 100} onChange={e => setOverride(Number(e.target.value))} style={input} />
            {override == null
              ? <> — from HSA spending in {year}; adjust if some of that wasn't in-network medical care, or you paid some by other means.</>
              : <> — <button type="button" onClick={() => setOverride(null)} style={{ border: 'none', background: 'none', color: 'var(--color-primary, #1d4ed8)', cursor: 'pointer', padding: 0, fontSize: 12 }}>use HSA spending ({fmt(spent)})</button></>}
          </label>
        </div>
        <div>
          <div style={{ fontWeight: 700, fontSize: 13.5, marginBottom: 6 }}>What would a bill cost you now?</div>
          <label style={{ fontSize: 12.5, color: 'var(--color-text-secondary)' }}>
            A bill of $<input aria-label="Bill amount" type="number" min="0" step="100" value={bill} onChange={e => setBill(e.target.value)} style={input} />
          </label>
          <div data-testid="hsa-bill-split" style={{ fontSize: 12.5, color: 'var(--color-text-secondary)', marginTop: 8, lineHeight: 1.5 }}>
            You'd pay <b style={{ color: 'var(--color-text-primary)' }}>{fmt(billYou)}</b>, insurance <b style={{ color: 'var(--color-text-primary)' }}>{fmt((Number(bill) || 0) - billYou)}</b>, given what you've already paid this year.
          </div>
          <SplitBar you={billYou} total={Number(bill) || 0} />
        </div>
      </div>
    </div>
  );
}

function Phase({ n, color, title, body }) {
  return (
    <div style={{ border: '1px solid var(--border-ghost)', borderRadius: 10, padding: '10px 12px' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, fontWeight: 700, fontSize: 13 }}>
        <span style={{ width: 20, height: 20, borderRadius: 10, background: color, color: '#fff', fontSize: 11, display: 'inline-flex', alignItems: 'center', justifyContent: 'center', flex: 'none' }}>{n}</span>
        {title}
      </div>
      <div style={{ fontSize: 12, color: 'var(--color-text-secondary)', marginTop: 6, lineHeight: 1.45 }}>{body}</div>
    </div>
  );
}

/* Stacked area: x is total in-network bills for the year, the orange band is
   what you pay and the blue band above it is what insurance pays, so the top
   edge is the full bill. */
function CoverageChart({ plan, oopAt, progress }) {
  const [hover, setHover] = useState(null);
  const W = 640, H = 290, L = 56, R = 16, T = 30, B = 40;
  const xMax = niceMax(Math.max(oopAt * 1.25, plan.deductible * 3, 1000));
  const x = (v) => L + (v / xMax) * (W - L - R);
  const y = (v) => H - B - (v / xMax) * (H - T - B);

  const pts = useMemo(() => [0, plan.deductible, oopAt, xMax].filter((v, i, a) => i === 0 || v > a[i - 1]).map(b => ({ b, you: planCost(b, plan).you })), [plan, oopAt, xMax]);
  const youPath = `M${x(0)},${y(0)} ` + pts.map(p => `L${x(p.b)},${y(p.you)}`).join(' ') + ` L${x(xMax)},${y(0)} Z`;
  const insPath = `M${x(0)},${y(0)} ` + pts.map(p => `L${x(p.b)},${y(p.b)}`).join(' ') + ' ' + [...pts].reverse().map(p => `L${x(p.b)},${y(p.you)}`).join(' ') + ' Z';
  const youLine = pts.map((p, i) => `${i ? 'L' : 'M'}${x(p.b)},${y(p.you)}`).join(' ');
  const ticks = Array.from({ length: 5 }, (_, i) => (xMax / 4) * i);
  const k = (v) => (v >= 1000 ? `$${Math.round(v / 100) / 10}k`.replace('.0k', 'k') : `$${v}`);

  const bands = [
    { phase: 'deductible', from: 0, to: plan.deductible, label: 'You pay 100%' },
    { phase: 'coinsurance', from: plan.deductible, to: oopAt, label: `You ${pct(1 - plan.coinsurance)} · Insurance ${pct(plan.coinsurance)}` },
    { phase: 'covered', from: oopAt, to: xMax, label: 'Insurance 100%' },
  ].filter(b => b.to > b.from);

  function onMove(e) {
    const svg = e.currentTarget;
    const r = svg.getBoundingClientRect();
    const px = ((e.clientX - r.left) / r.width) * W;
    const b = Math.max(0, Math.min(xMax, ((px - L) / (W - L - R)) * xMax));
    setHover(planCost(Math.round(b / 50) * 50, plan));
  }

  const here = planCost(progress.bills, plan);
  return (
    <div style={{ position: 'relative' }}>
      <div style={{ display: 'flex', gap: 14, fontSize: 12, color: 'var(--color-text-secondary)', marginBottom: 4 }}>
        <span><Swatch c={YOU} />You pay</span>
        <span><Swatch c={INS} />Insurance pays</span>
      </div>
      <svg viewBox={`0 0 ${W} ${H}`} role="img" aria-label={`Chart: you pay the first ${fmt(plan.deductible)} of bills, then ${pct(1 - plan.coinsurance)} until you've paid ${fmt(plan.oopMax)} at ${fmt(oopAt)} of bills; insurance pays the rest.`}
        style={{ width: '100%', height: 'auto', display: 'block', touchAction: 'none' }} onPointerMove={onMove} onPointerLeave={() => setHover(null)}>
        {bands.map(b => (
          <g key={b.phase}>
            <rect x={x(b.from)} y={T} width={x(b.to) - x(b.from)} height={H - T - B} fill={PHASE_BG[b.phase]} />
            <text x={(x(b.from) + x(b.to)) / 2} y={T - 10} textAnchor="middle" fontSize="11" fontWeight="600" fill="var(--color-text-secondary)">{b.label}</text>
          </g>
        ))}
        {ticks.map(t => (
          <g key={t}>
            <line x1={L} x2={W - R} y1={y(t)} y2={y(t)} stroke="var(--border-ghost, #e5e5e5)" />
            <text x={L - 6} y={y(t) + 4} textAnchor="end" fontSize="10.5" fill="var(--color-text-tertiary)">{k(t)}</text>
            <text x={x(t)} y={H - B + 16} textAnchor="middle" fontSize="10.5" fill="var(--color-text-tertiary)">{k(t)}</text>
          </g>
        ))}
        <text x={(L + W - R) / 2} y={H - 6} textAnchor="middle" fontSize="11" fill="var(--color-text-secondary)">Total in-network medical bills this year</text>
        <path d={insPath} fill={INS} fillOpacity="0.85" />
        <path d={youPath} fill={YOU} fillOpacity="0.9" />
        <path d={youLine} fill="none" stroke="var(--color-surface, #fff)" strokeWidth="2" />
        {[plan.deductible, oopAt].filter(v => v > 0 && v < xMax).map(v => (
          <line key={v} x1={x(v)} x2={x(v)} y1={T} y2={H - B} stroke="var(--color-text-tertiary)" strokeDasharray="3 3" />
        ))}
        {plan.deductible > 0 && plan.deductible < oopAt && (
          <text x={x(plan.deductible) + 5} y={T + 14} fontSize="11" fontWeight="700" fill="var(--color-text-primary)">Deductible met ({fmt(plan.deductible)} paid)</text>
        )}
        <text x={x(oopAt) - 5} y={T + 30} textAnchor="end" fontSize="11" fontWeight="700" fill="var(--color-text-primary)">Max reached: {fmt(plan.oopMax)} paid at {fmt(oopAt)} of bills</text>
        <g data-testid="hsa-you-are-here">
          <circle cx={x(here.bills)} cy={y(here.you)} r="6" fill="var(--color-text-primary, #111)" stroke="var(--color-surface, #fff)" strokeWidth="2" />
          <text x={x(here.bills)} y={y(here.you) + 20} textAnchor={here.bills / xMax < 0.1 ? 'start' : 'middle'} fontSize="11" fontWeight="700" fill="var(--color-text-primary)">You · {fmt(here.you)}</text>
        </g>
        {hover && (
          <g pointerEvents="none">
            <line x1={x(hover.bills)} x2={x(hover.bills)} y1={T} y2={H - B} stroke="var(--color-text-primary)" strokeOpacity="0.4" />
            <circle cx={x(hover.bills)} cy={y(hover.you)} r="4" fill={YOU} stroke="#fff" strokeWidth="2" />
            <circle cx={x(hover.bills)} cy={y(hover.bills)} r="4" fill={INS} stroke="#fff" strokeWidth="2" />
          </g>
        )}
      </svg>
      {hover && (
        <div role="tooltip" style={{
          position: 'absolute', top: 24, pointerEvents: 'none',
          ...(x(hover.bills) / W < 0.5 ? { left: `calc(${(x(hover.bills) / W) * 100}% + 10px)` } : { right: `calc(${100 - (x(hover.bills) / W) * 100}% + 10px)` }),
          background: 'var(--color-surface)', border: '1px solid var(--border-ghost)', borderRadius: 8, padding: '6px 10px', fontSize: 12, boxShadow: '0 4px 12px rgba(0,0,0,0.08)', whiteSpace: 'nowrap',
        }}>
          <div style={{ fontWeight: 700 }}>{fmt(hover.bills)} in bills</div>
          <div><Swatch c={YOU} />You {fmt(hover.you)}</div>
          <div><Swatch c={INS} />Insurance {fmt(hover.insurance)}</div>
        </div>
      )}
    </div>
  );
}

function Swatch({ c }) {
  return <span style={{ display: 'inline-block', width: 10, height: 10, borderRadius: 2, background: c, marginRight: 5, verticalAlign: -1 }} />;
}

/* 0 → out-of-pocket max, with the deductible marked; filled to what's paid. */
function Meter({ paid, deductible, oopMax }) {
  const w = (v) => `${oopMax ? Math.min(100, (v / oopMax) * 100) : 0}%`;
  return (
    <div data-testid="hsa-oop-meter">
      <div style={{ position: 'relative', height: 14, borderRadius: 7, background: 'var(--color-surface-alt, #f1f1f1)', overflow: 'hidden' }}>
        <div style={{ position: 'absolute', inset: 0, width: w(paid), background: paid >= oopMax ? INS : YOU }} />
        <div style={{ position: 'absolute', top: 0, bottom: 0, left: w(deductible), width: 2, background: 'var(--color-surface, #fff)' }} />
      </div>
      <div style={{ position: 'relative', height: 16, fontSize: 11, color: 'var(--color-text-tertiary)', marginTop: 3 }}>
        <span style={{ position: 'absolute', left: 0 }}>$0</span>
        {deductible > 0 && deductible < oopMax && <span style={{ position: 'absolute', left: w(deductible), transform: 'translateX(-50%)' }}>Deductible {fmt(deductible)}</span>}
        <span style={{ position: 'absolute', right: 0 }}>Max {fmt(oopMax)}</span>
      </div>
    </div>
  );
}

function SplitBar({ you, total }) {
  if (!total) return null;
  const p = Math.min(100, (you / total) * 100);
  return (
    <div style={{ display: 'flex', gap: 2, height: 12, marginTop: 8 }}>
      {p > 0 && <div style={{ width: `${p}%`, background: YOU, borderRadius: p < 100 ? '4px 0 0 4px' : 4 }} />}
      {p < 100 && <div style={{ flex: 1, background: INS, borderRadius: p > 0 ? '0 4px 4px 0' : 4 }} />}
    </div>
  );
}
