import { useEffect, useRef, useState } from 'react';
import styles from './SurplusSplit.module.css';

/* Where each month's surplus went: invested, or kept as cash.

   surplus (income − spending) = invested + kept. A month you invested more
   than you saved shows kept below the line — cash went down while you got
   wealthier — which is the case a plain "did my cash grow?" view can't tell
   apart from overspending. The marker is what the cash position (cash minus
   card balances) actually did, when Balance History covers the month; the
   difference from "kept" is timing and the other reasons the cash report on
   Overshot walks through.

   Colours are categorical slots 7 (violet) and 3 (aqua) from the dataviz
   reference palette, validated as a pair; aqua sits under 3:1 on white, so
   the numbers are always one click away in the table view. */

const INVESTED = '#4a3aa7';
const KEPT = '#1baf7a';
const MONTH_SHORT = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const short = key => { const [y, m] = key.split('-'); return `${MONTH_SHORT[m - 1]} ${y.slice(2)}`; };
const money = n => new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 0 }).format(Math.abs(n));
const signed = n => (n < -0.5 ? '−' : n > 0.5 ? '+' : '') + money(n);
const axisLabel = n => (Math.abs(n) >= 1000 ? `${n < 0 ? '−' : ''}$${Math.round(Math.abs(n) / 100) / 10}k` : `${n < 0 ? '−' : ''}$${Math.abs(Math.round(n))}`);

function niceStep(span) {
  const raw = span / 4;
  const p = 10 ** Math.floor(Math.log10(raw || 1));
  return [1, 2, 2.5, 5, 10].map(s => s * p).find(s => s >= raw) || p * 10;
}

function useWidth(initial) {
  const ref = useRef(null);
  const [w, setW] = useState(initial);
  useEffect(() => {
    const el = ref.current;
    if (!el) return undefined;
    const apply = () => setW(Math.max(320, Math.round(el.clientWidth || initial)));
    apply();
    if (typeof ResizeObserver === 'undefined') return undefined;
    const ro = new ResizeObserver(apply);
    ro.observe(el);
    return () => ro.disconnect();
  }, [initial]);
  return [ref, w];
}

/**
 * @param months  [{ key, surplus, invested, kept, cashChange (number | null), partial? }], oldest first
 */
export function SurplusSplit({ months, title = 'Where the surplus went' }) {
  const [wrapRef, width] = useWidth(640);
  const [hover, setHover] = useState(null);
  if (!months?.length) return null;

  const sum = k => months.reduce((s, m) => s + (m[k] || 0), 0);
  const withCash = months.filter(m => m.cashChange != null);
  const totals = { surplus: sum('surplus'), invested: sum('invested'), kept: sum('kept'), cash: withCash.reduce((s, m) => s + m.cashChange, 0) };

  // Stack: invested from the baseline, kept on top of it (same sign) or on
  // the other side of the line (opposite sign).
  const bars = months.map(m => {
    const segs = [];
    let up = 0;
    let down = 0;
    for (const [id, v] of [['invested', m.invested || 0], ['kept', m.kept || 0]]) {
      if (v > 0) { segs.push({ id, from: up, to: up + v }); up += v; }
      else if (v < 0) { segs.push({ id, from: down + v, to: down }); down += v; }
    }
    return { ...m, segs, top: up, bottom: down };
  });
  const hi = Math.max(0, ...bars.map(b => b.top), ...withCash.map(m => m.cashChange));
  const lo = Math.min(0, ...bars.map(b => b.bottom), ...withCash.map(m => m.cashChange));
  const step = niceStep(hi - lo || 1);
  const top = Math.ceil(hi / step) * step || step;
  const bottom = Math.floor(lo / step) * step;
  const ticks = [];
  for (let v = bottom; v <= top + step / 2; v += step) ticks.push(v);

  const H = 240;
  const pad = { top: 10, right: 8, bottom: 26, left: width < 480 ? 44 : 56 };
  const innerW = width - pad.left - pad.right;
  const innerH = H - pad.top - pad.bottom;
  const y = v => pad.top + ((top - v) / (top - bottom)) * innerH;
  const slot = innerW / bars.length;
  const barW = Math.max(6, Math.min(28, slot * 0.55));
  const cx = i => pad.left + slot * (i + 0.5);
  const labelEvery = Math.max(1, Math.ceil(bars.length / Math.max(2, Math.floor(innerW / 48))));

  // Months the cash went down because the money went into investments.
  const investedNotKept = [...months].reverse().filter(m => !m.partial && m.invested > 0 && m.kept < 0).slice(0, 3);
  const tip = m => [
    `${short(m.key)}${m.partial ? ' (so far)' : ''}`,
    `Surplus ${signed(m.surplus)}`,
    `Invested ${signed(m.invested)}`,
    `Kept as cash ${signed(m.kept)}`,
    m.cashChange != null ? `Cash actually changed ${signed(m.cashChange)}` : null,
  ].filter(Boolean);

  return (
    <section className={styles.card} data-testid="surplus-split">
      <div className={styles.head}>
        <div>
          <h2 className={styles.title}>{title}</h2>
          <div className={styles.hint}>
            Each month’s surplus (income − spending) is either invested or kept as cash. Below the line is cash you
            drew down — often to invest, not to spend.
          </div>
        </div>
        <div className={styles.legend}>
          <span><i style={{ background: INVESTED }} />Invested</span>
          <span><i style={{ background: KEPT }} />Kept as cash</span>
          {withCash.length > 0 && <span><i className={styles.markerKey} />Cash actually changed</span>}
        </div>
      </div>

      <div className={styles.tiles}>
        <Tile label="Surplus" value={signed(totals.surplus)} />
        <Tile label="Invested" value={signed(totals.invested)} swatch={INVESTED} />
        <Tile label="Kept as cash" value={signed(totals.kept)} swatch={KEPT} />
        {withCash.length > 0 && <Tile label={`Cash actually changed${withCash.length < months.length ? ` (${withCash.length} mo)` : ''}`} value={signed(totals.cash)} />}
      </div>

      <div ref={wrapRef} className={styles.chartWrap}>
        <svg width="100%" height={H} viewBox={`0 0 ${width} ${H}`} role="img"
          aria-label={`${title}: surplus ${signed(totals.surplus)}, invested ${signed(totals.invested)}, kept as cash ${signed(totals.kept)}`}>
          {ticks.map(v => (
            <g key={v}>
              <line x1={pad.left} x2={width - pad.right} y1={y(v)} y2={y(v)} className={v === 0 ? styles.zero : styles.grid} />
              <text x={pad.left - 6} y={y(v) + 4} textAnchor="end" className={styles.axis}>{axisLabel(v)}</text>
            </g>
          ))}
          {bars.map((b, i) => (
            <g key={b.key} opacity={hover != null && hover !== i ? 0.45 : 1}>
              {b.segs.map(s => {
                const y0 = y(s.to);
                // 2px surface gap between stacked segments.
                const h = Math.max(0, y(s.from) - y0 - (b.segs.length > 1 ? 1 : 0));
                return <rect key={s.id} x={cx(i) - barW / 2} y={y0} width={barW} height={h} rx={3} fill={s.id === 'invested' ? INVESTED : KEPT} opacity={b.partial ? 0.55 : 1} />;
              })}
              {b.cashChange != null && (
                <line x1={cx(i) - barW / 2 - 4} x2={cx(i) + barW / 2 + 4} y1={y(b.cashChange)} y2={y(b.cashChange)} className={styles.marker} />
              )}
              {i % labelEvery === 0 && (
                <text x={cx(i)} y={H - 8} textAnchor="middle" className={styles.axis}>{short(b.key)}</text>
              )}
            </g>
          ))}
          {/* Hit targets wider than the marks, carrying the tooltip. */}
          {bars.map((b, i) => (
            <rect key={`hit-${b.key}`} x={pad.left + slot * i} y={pad.top} width={slot} height={innerH} fill="transparent"
              onMouseEnter={() => setHover(i)} onMouseLeave={() => setHover(null)}>
              <title>{tip(b).join('\n')}</title>
            </rect>
          ))}
        </svg>
        {hover != null && (
          <div className={styles.tooltip} style={{ left: Math.min(width - 190, Math.max(0, cx(hover) - 90)) }} role="status">
            {tip(bars[hover]).map((line, j) => <div key={j} className={j ? '' : styles.tooltipHead}>{line}</div>)}
          </div>
        )}
      </div>

      {investedNotKept.length > 0 && (
        <ul className={styles.callouts}>
          {investedNotKept.map(m => (
            <li key={m.key}>
              <strong>{short(m.key)}:</strong> cash went down {money(m.kept)}, but you invested {money(m.invested)} — the
              surplus was {signed(m.surplus)}{m.surplus >= 0 ? ', so you came out ahead' : ''}.
            </li>
          ))}
        </ul>
      )}

      <details className={styles.tableToggle}>
        <summary>Show as a table</summary>
        <div className={styles.tableWrap}>
          <table className={styles.table}>
            <thead><tr><th>Month</th><th>Surplus</th><th>Invested</th><th>Kept as cash</th>{withCash.length > 0 && <th>Cash actually changed</th>}</tr></thead>
            <tbody>
              {[...months].reverse().map(m => (
                <tr key={m.key}>
                  <td>{short(m.key)}{m.partial ? ' (so far)' : ''}</td>
                  <td>{signed(m.surplus)}</td>
                  <td>{signed(m.invested)}</td>
                  <td>{signed(m.kept)}</td>
                  {withCash.length > 0 && <td>{m.cashChange == null ? '—' : signed(m.cashChange)}</td>}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </details>
    </section>
  );
}

function Tile({ label, value, swatch }) {
  return (
    <div className={styles.tile}>
      <div className={styles.tileValue}>{value}</div>
      <div className={styles.tileLabel}>{swatch && <i style={{ background: swatch }} />}{label}</div>
    </div>
  );
}
