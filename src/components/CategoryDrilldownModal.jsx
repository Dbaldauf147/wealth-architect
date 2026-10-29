import { useEffect, useMemo, useRef, useState } from 'react';
import { categoryDrilldown } from '../lib/categoryDrilldown';
import { monthLabel, monthLabelShort } from '../lib/netWorthSnapshot';
import styles from './CategoryDrilldownModal.module.css';

/* Spending Trends: click a category for its own history — monthly spend as
   bars, its share of all spending as a line on the right axis — and, below,
   the places that drove it each month. The numbers come from
   categoryDrilldown, which counts spending exactly as the Trends table does. */

// Categorical slots 1–2 of the app's dataviz palette.
const BAR = '#2a78d6';
const LINE = '#eb6834';
const CHART_H = 240;

const money = n => new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 0 }).format(n || 0);
const pct = n => `${Math.round((n || 0) * 1000) / 10}%`;
const axisMoney = n => (n >= 1000 ? `$${Math.round(n / 100) / 10}k` : `$${Math.round(n)}`);

function niceMax(v) {
  if (v <= 0) return 1;
  const p = 10 ** Math.floor(Math.log10(v));
  return [1, 1.25, 1.5, 2, 2.5, 3, 4, 5, 6, 8, 10].map(s => s * p).find(s => s >= v);
}

// Starts at the minimum and grows to the container, as the page's charts do.
function useMeasuredWidth() {
  const ref = useRef(null);
  const [width, setWidth] = useState(320);
  useEffect(() => {
    const el = ref.current;
    if (!el) return undefined;
    const apply = () => setWidth(Math.max(300, Math.round(el.clientWidth || 300)));
    apply();
    if (typeof ResizeObserver === 'undefined') return undefined;
    const ro = new ResizeObserver(apply);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  return [ref, width];
}

function Chart({ months, nowKey, onPick }) {
  const [ref, width] = useMeasuredWidth();
  const [hover, setHover] = useState(null);
  const pad = { top: 14, right: 44, bottom: 26, left: 48 };
  const innerW = width - pad.left - pad.right;
  const innerH = CHART_H - pad.top - pad.bottom;
  const max = niceMax(Math.max(...months.map(m => m.amount), 1));
  const shareMax = niceMax(Math.max(...months.map(m => m.share), 0.01) * 100) / 100;
  const step = innerW / months.length;
  const barW = Math.max(4, Math.min(30, step * 0.6));
  const y = v => pad.top + innerH - (v / max) * innerH;
  const yShare = v => pad.top + innerH - (v / shareMax) * innerH;
  const cx = i => pad.left + step * i + step / 2;
  const labelEvery = Math.ceil(months.length / Math.max(1, Math.floor(innerW / 48)));
  const linePts = months.map((m, i) => `${cx(i)},${yShare(m.share)}`).join(' ');

  return (
    <div ref={ref} className={styles.chartWrap}>
      <svg width={width} height={CHART_H} role="img" aria-label="Monthly spend in this category, with its share of all spending">
        {[0, 0.25, 0.5, 0.75, 1].map(f => (
          <g key={f}>
            <line x1={pad.left} x2={width - pad.right} y1={y(f * max)} y2={y(f * max)} stroke="var(--color-surface-alt)" />
            <text x={pad.left - 8} y={y(f * max) + 4} textAnchor="end" className={styles.axis}>{axisMoney(f * max)}</text>
            <text x={width - pad.right + 8} y={yShare(f * shareMax) + 4} textAnchor="start" className={styles.axis} fill={LINE}>{pct(f * shareMax)}</text>
          </g>
        ))}
        {months.map((m, i) => {
          const top = y(m.amount);
          const h = y(0) - top;
          const r = Math.min(4, barW / 2, h);
          const x0 = cx(i) - barW / 2;
          return h > 0 ? (
            <path
              key={m.key}
              data-month={m.key}
              d={`M${x0},${y(0)} V${top + r} Q${x0},${top} ${x0 + r},${top} H${x0 + barW - r} Q${x0 + barW},${top} ${x0 + barW},${top + r} V${y(0)} Z`}
              fill={BAR}
              fillOpacity={m.key === nowKey ? 0.5 : hover == null || hover === i ? 1 : 0.55}
            />
          ) : null;
        })}
        <polyline points={linePts} fill="none" stroke={LINE} strokeWidth={2} strokeLinejoin="round" />
        {months.map((m, i) => (
          <circle key={m.key} cx={cx(i)} cy={yShare(m.share)} r={hover === i ? 4 : 2.5} fill={LINE} stroke="var(--color-surface)" strokeWidth={1} />
        ))}
        <line x1={pad.left} x2={width - pad.right} y1={y(0)} y2={y(0)} stroke="var(--color-text-muted)" />
        {months.map((m, i) => (i % labelEvery === 0 || i === months.length - 1) && (
          <text key={m.key} x={cx(i)} y={CHART_H - 8} textAnchor="middle" className={styles.axis}>
            {monthLabelShort(m.key)}{m.key === nowKey ? '*' : ''}
          </text>
        ))}
        {months.map((m, i) => (
          <rect
            key={m.key}
            x={pad.left + step * i}
            y={pad.top}
            width={step}
            height={innerH}
            fill="transparent"
            style={{ cursor: m.amount ? 'pointer' : 'default' }}
            onMouseEnter={() => setHover(i)}
            onMouseLeave={() => setHover(null)}
            onClick={() => m.amount && onPick(m.key)}
          />
        ))}
      </svg>
      {hover != null && (() => {
        const m = months[hover];
        const left = Math.min(width - 210, Math.max(0, cx(hover) - 105));
        return (
          <div className={styles.tooltip} style={{ left }} data-testid="drilldown-tooltip">
            <div className={styles.tooltipTitle}>{monthLabel(m.key)}{m.key === nowKey ? ' (so far)' : ''}</div>
            <div><i style={{ background: BAR }} />Spent<b>{money(m.amount)}</b></div>
            <div><i style={{ background: LINE }} />Share of spending<b>{pct(m.share)}</b></div>
            <div className={styles.muted}>of {money(m.total)} total{m.places[0] ? ` · top: ${m.places[0].name}` : ''}</div>
          </div>
        );
      })()}
      {months.some(m => m.key === nowKey) && <div className={styles.foot}>* month in progress · click a bar to jump to that month</div>}
    </div>
  );
}

/**
 * @param category      the category to show
 * @param transactions  the ledger
 * @param months        YYYY-MM keys, oldest first (the page's chart window)
 * @param onClose
 */
export function CategoryDrilldownModal({ category, transactions, months, onClose }) {
  const reportRef = useRef(null);
  useEffect(() => {
    const onKey = e => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  const d = useMemo(() => categoryDrilldown({ transactions, category, months }), [transactions, category, months]);
  const now = new Date();
  const nowKey = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;
  const complete = d.months.filter(m => m.key !== nowKey);
  const latest = complete[complete.length - 1] || null;
  const newestFirst = [...d.months].reverse().filter(m => m.amount > 0);
  const quiet = d.months.length - d.months.filter(m => m.amount > 0).length;

  function jumpTo(key) {
    reportRef.current?.querySelector(`[data-month="${key}"]`)?.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }

  return (
    <div className={styles.overlay} onMouseDown={e => { if (e.target === e.currentTarget) onClose(); }}>
      <div className={styles.dialog} role="dialog" aria-modal="true" aria-labelledby="drilldown-title" data-testid="category-drilldown">
        <div className={styles.head}>
          <div>
            <div className={styles.eyebrow}>Spending Trends</div>
            <h2 id="drilldown-title" className={styles.title}>{category}</h2>
            <div className={styles.sub}>
              {monthLabel(months[0])} – {monthLabel(months[months.length - 1])}
              {' · '}{money(d.avg)}/mo on average, {pct(d.avgShare)} of all spending
              {latest && <> · {monthLabel(latest.key)}: {money(latest.amount)} ({pct(latest.share)})</>}
            </div>
          </div>
          <button type="button" className={styles.close} onClick={onClose} aria-label="Close">
            <span className="material-symbols-outlined">close</span>
          </button>
        </div>

        <div className={styles.legend}>
          <span><i style={{ background: BAR }} />Spent per month</span>
          <span><i className={styles.legendLine} style={{ background: LINE }} />% of all spending (right axis)</span>
        </div>
        <Chart months={d.months} nowKey={nowKey} onPick={jumpTo} />

        {d.places.length > 0 && (
          <div className={styles.overall}>
            <div className={styles.sectionTitle}>Biggest places over the whole window</div>
            <div className={styles.chips}>
              {d.places.slice(0, 6).map(p => (
                <span key={p.key} className={styles.chip}>{p.name} <b>{money(p.amount)}</b> <span className={styles.muted}>{pct(p.share)}</span></span>
              ))}
            </div>
          </div>
        )}

        <div className={styles.sectionTitle}>Top places each month</div>
        <div className={styles.report} ref={reportRef} data-testid="drilldown-report">
          {newestFirst.map(m => (
            <div key={m.key} className={styles.month} data-month={m.key}>
              <div className={styles.monthHead}>
                <span className={styles.monthName}>{monthLabel(m.key)}{m.key === nowKey ? ' (so far)' : ''}</span>
                <span className={styles.muted}>{money(m.amount)} · {pct(m.share)} of spending · {m.count} charge{m.count === 1 ? '' : 's'}</span>
              </div>
              <table className={styles.table}>
                <tbody>
                  {m.places.map(p => {
                    const delta = p.amount - p.prev;
                    return (
                      <tr key={p.key}>
                        <td className={styles.place}>{p.name}<span className={styles.muted}> · {p.count}×</span></td>
                        <td className={styles.shareCell}>
                          <div className={styles.shareBar}><div style={{ width: `${Math.max(2, p.share * 100)}%` }} /></div>
                          <span>{Math.round(p.share * 100)}%</span>
                        </td>
                        <td className={styles.num}>{money(p.amount)}</td>
                        <td className={`${styles.num} ${styles.delta} ${delta > 0.5 ? styles.up : delta < -0.5 ? styles.down : ''}`}>
                          {p.prev === 0 ? 'new' : `${delta >= 0 ? '+' : '−'}${money(Math.abs(delta))}`}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
              {m.more > 0 && <div className={styles.more}>and {m.more} more place{m.more === 1 ? '' : 's'}</div>}
            </div>
          ))}
          {!newestFirst.length && <div className={styles.muted}>Nothing spent in {category} in this window.</div>}
          {quiet > 0 && newestFirst.length > 0 && <div className={styles.more}>{quiet} month{quiet === 1 ? '' : 's'} with nothing in {category} not shown.</div>}
        </div>
        <div className={styles.foot}>The last column is the change from that place’s spend the month before.</div>
      </div>
    </div>
  );
}
