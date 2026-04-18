import { useState, useMemo, useRef, useEffect } from 'react';
import { useData } from '../contexts/DataContext';
import styles from './TransactionsPage.module.css';

const PAGE_SIZE = 50;

const CATEGORY_ICONS = {
  'Food & Drink': 'restaurant',
  'Shopping': 'shopping_bag',
  'Travel': 'flight',
  'Entertainment': 'movie',
  'Bills & Utilities': 'receipt',
  'Housing': 'home',
  'Transportation': 'directions_car',
  'Health & Wellness': 'health_and_safety',
  'Income': 'payments',
  'Transfer': 'swap_horiz',
};

function getCategoryIcon(cat) {
  return CATEGORY_ICONS[cat] || 'receipt_long';
}

function fmt(n) {
  return new Intl.NumberFormat('en-US', {
    style: 'currency',
    currency: 'USD',
    minimumFractionDigits: 2,
  }).format(n);
}

/* Deterministic colour from category name */
const PALETTE = [
  '#ba1a1a', '#009668', '#0058be', '#7c3aed', '#e8a317',
  '#475569', '#d946ef', '#0891b2', '#dc2626', '#16a34a',
  '#9333ea', '#ea580c', '#2563eb', '#c026d3', '#059669',
];

function catColor(name) {
  let hash = 0;
  for (let i = 0; i < name.length; i++) hash = name.charCodeAt(i) + ((hash << 5) - hash);
  return PALETTE[Math.abs(hash) % PALETTE.length];
}

function catBg(name) {
  const c = catColor(name);
  // convert hex to rgba 0.08
  const r = parseInt(c.slice(1, 3), 16);
  const g = parseInt(c.slice(3, 5), 16);
  const b = parseInt(c.slice(5, 7), 16);
  return `rgba(${r},${g},${b},0.08)`;
}

/* Well-spaced palette for pie slices — rotates hues widely so adjacent slices always differ */
const PIE_PALETTE = [
  '#0058be', '#ea580c', '#16a34a', '#d946ef', '#e8a317',
  '#0891b2', '#dc2626', '#7c3aed', '#65a30d', '#db2777',
  '#2563eb', '#f59e0b', '#059669', '#9333ea', '#b91c1c',
  '#0d9488', '#c026d3', '#84cc16', '#6366f1', '#f97316',
];

function pieColor(index) {
  return PIE_PALETTE[index % PIE_PALETTE.length];
}

const CHART_MODES = [
  { key: 'stacked', label: 'Stacked', icon: 'stacked_bar_chart' },
  { key: 'grouped', label: 'Grouped', icon: 'bar_chart' },
  { key: 'line', label: 'Line', icon: 'show_chart' },
  { key: 'area', label: 'Area', icon: 'area_chart' },
];

/* Smooth curve helper — monotone cubic spline for natural-looking lines */
function smoothPath(points) {
  if (points.length < 2) return '';
  if (points.length === 2) return `M ${points[0].x} ${points[0].y} L ${points[1].x} ${points[1].y}`;
  let d = `M ${points[0].x} ${points[0].y}`;
  for (let i = 0; i < points.length - 1; i++) {
    const p0 = points[Math.max(i - 1, 0)];
    const p1 = points[i];
    const p2 = points[i + 1];
    const p3 = points[Math.min(i + 2, points.length - 1)];
    const cp1x = p1.x + (p2.x - p0.x) / 6;
    const cp1y = p1.y + (p2.y - p0.y) / 6;
    const cp2x = p2.x - (p3.x - p1.x) / 6;
    const cp2y = p2.y - (p3.y - p1.y) / 6;
    d += ` C ${cp1x} ${cp1y}, ${cp2x} ${cp2y}, ${p2.x} ${p2.y}`;
  }
  return d;
}

function SpendingChart({ months, topCategories, maxTotal, width = 900, height = 280, mode = 'stacked', onMonthClick, selectedMonth }) {
  const [hoverIdx, setHoverIdx] = useState(null);
  const [hoverSeg, setHoverSeg] = useState(null); // { mi, ci, x, y }
  if (!months.length) return null;
  const pad = { top: 16, right: 12, bottom: 40, left: 50 };
  const chartW = width - pad.left - pad.right;
  const chartH = height - pad.top - pad.bottom;

  /* Compute per-category max for grouped mode */
  let yMax = maxTotal;
  if (mode === 'grouped') {
    let catMax = 0;
    for (const m of months) {
      for (const cat of topCategories) {
        if ((m.byCategory[cat] || 0) > catMax) catMax = m.byCategory[cat];
      }
    }
    yMax = catMax;
  }

  /* Auto-zoom: snap to nearest "nice" ceiling with 5% headroom */
  const raw = yMax * 1.05;
  const mag = Math.pow(10, Math.floor(Math.log10(raw || 1)));
  const steps = [1, 1.2, 1.5, 2, 2.5, 3, 4, 5, 6, 8, 10];
  let niceMax = mag * 10;
  for (const s of steps) {
    if (mag * s >= raw) { niceMax = mag * s; break; }
  }
  if (niceMax === 0) niceMax = 1000;
  const ticks = [0, niceMax * 0.25, niceMax * 0.5, niceMax * 0.75, niceMax];

  /* Shared helpers */
  const yPos = v => pad.top + chartH - (v / niceMax) * chartH;
  const slotW = chartW / months.length;
  const xCenter = mi => pad.left + (mi + 0.5) * slotW;

  /* Format y-axis values */
  const fmtAxis = t => {
    if (t === 0) return '$0';
    if (t >= 1000) return `$${(t / 1000).toFixed(t % 1000 === 0 ? 0 : 1)}k`;
    return `$${t}`;
  };

  /* Alternating column bands for visual rhythm */
  const bands = months.map((_, mi) => {
    if (mi % 2 === 0) return null;
    const x = pad.left + mi * slotW;
    return <rect key={`band-${mi}`} x={x} y={pad.top} width={slotW} height={chartH} fill="var(--color-text-tertiary)" opacity={0.03} />;
  });

  /* Gridlines + Y-axis */
  const grid = ticks.map((t, i) => {
    const y = yPos(t);
    return (
      <g key={i}>
        {t > 0 && (
          <line x1={pad.left} y1={y} x2={width - pad.right} y2={y}
            stroke="var(--color-text-tertiary)" strokeOpacity={0.25}
            strokeWidth={1} />
        )}
        <text x={pad.left - 8} y={y + 4} textAnchor="end" fontSize={10}
          fontWeight={t === 0 ? 600 : 400} fill="var(--color-text-tertiary)" fontFamily="var(--font-headline)">
          {fmtAxis(t)}
        </text>
      </g>
    );
  });

  /* Baseline axis */
  const baseline = (
    <line x1={pad.left} y1={yPos(0)} x2={width - pad.right} y2={yPos(0)}
      stroke="var(--color-text-tertiary)" strokeOpacity={0.3} strokeWidth={1} />
  );

  /* X-axis labels + interactive hover/click zones */
  const xLabels = months.map((m, mi) => {
    const showYear = mi === 0 || m.year !== months[mi - 1].year;
    const isHovered = hoverIdx === mi;
    const isSelected = selectedMonth === m.key;
    const monthTotal = topCategories.reduce((s, cat) => s + (m.byCategory[cat] || 0), 0);
    return (
      <g key={mi}>
        {/* Invisible click/hover zone covering the full column */}
        <rect
          x={pad.left + mi * slotW} y={pad.top} width={slotW} height={chartH}
          fill={isSelected ? 'var(--color-secondary)' : isHovered ? 'var(--color-text-primary)' : 'transparent'}
          opacity={isSelected ? 0.08 : isHovered ? 0.04 : 0}
          style={{ cursor: 'pointer' }}
          onMouseEnter={() => setHoverIdx(mi)}
          onMouseLeave={() => setHoverIdx(null)}
          onClick={() => onMonthClick && onMonthClick(m.key)}
        />
        {/* Hover tooltip */}
        {isHovered && (
          <g>
            <line x1={xCenter(mi)} y1={pad.top} x2={xCenter(mi)} y2={pad.top + chartH}
              stroke="var(--color-text-tertiary)" strokeOpacity={0.3} strokeWidth={1} strokeDasharray="4 3" />
            <rect x={xCenter(mi) - 52} y={pad.top - 2} width={104} height={20} rx={4}
              fill="var(--color-text-primary)" opacity={0.85} />
            <text x={xCenter(mi)} y={pad.top + 12} textAnchor="middle"
              fontSize={10} fontWeight={700} fill="#fff" fontFamily="var(--font-headline)">
              {monthTotal >= 1000 ? `$${(monthTotal / 1000).toFixed(1)}k` : `$${Math.round(monthTotal)}`} — {m.label} {m.year}
            </text>
          </g>
        )}
        {/* Month label */}
        <text x={xCenter(mi)} y={height - (showYear ? 18 : 8)} textAnchor="middle"
          fontSize={11} fontWeight={isSelected ? 700 : 400}
          fill={isSelected ? 'var(--color-secondary)' : 'var(--color-text-secondary)'}
          fontFamily="var(--font-headline)"
          style={{ cursor: 'pointer' }}
          onMouseEnter={() => setHoverIdx(mi)}
          onMouseLeave={() => setHoverIdx(null)}
          onClick={() => onMonthClick && onMonthClick(m.key)}>
          {m.label}
        </text>
        {showYear && (
          <text x={xCenter(mi)} y={height - 4} textAnchor="middle"
            fontSize={10} fontWeight={700} fill="var(--color-text-tertiary)">
            {m.year}
          </text>
        )}
      </g>
    );
  });

  const svgProps = {
    width: '100%',
    height,
    viewBox: `0 0 ${width} ${height}`,
    preserveAspectRatio: 'xMidYMid meet',
    style: { display: 'block' },
    onMouseLeave: () => setHoverSeg(null),
  };

  /* Custom segment tooltip — category + amount + month */
  function renderSegTooltip() {
    if (!hoverSeg) return null;
    const { mi, ci, x, y } = hoverSeg;
    const m = months[mi];
    const cat = topCategories[ci];
    const val = (m && cat) ? (m.byCategory[cat] || 0) : 0;
    const label = `${cat} — ${fmt(val)}`;
    const sub = m ? `${m.label} ${m.year}` : '';
    const boxW = Math.max(110, label.length * 6.2, sub.length * 6.2);
    const boxH = 38;
    // Clamp within chart bounds so tooltip never leaks outside
    let tx = x - boxW / 2;
    if (tx < 4) tx = 4;
    if (tx + boxW > width - 4) tx = width - 4 - boxW;
    let ty = y - boxH - 10;
    if (ty < 2) ty = y + 12;
    return (
      <g style={{ pointerEvents: 'none' }}>
        <rect x={tx} y={ty} width={boxW} height={boxH} rx={6}
          fill="var(--color-text-primary)" opacity={0.92} />
        <circle cx={tx + 10} cy={ty + 13} r={4} fill={pieColor(ci)} />
        <text x={tx + 18} y={ty + 16} fontSize={10.5} fontWeight={700} fill="#fff" fontFamily="var(--font-headline)">
          {label}
        </text>
        <text x={tx + 10} y={ty + 30} fontSize={9.5} fill="rgba(255,255,255,0.7)">
          {sub}
        </text>
      </g>
    );
  }

  /* ── Stacked bars ── */
  if (mode === 'stacked') {
    const barW = Math.min(44, slotW * 0.65);
    return (
      <svg {...svgProps}>
        {bands}{grid}{baseline}
        {months.map((m, mi) => {
          const cx = xCenter(mi);
          let yOffset = 0;
          const totalVal = topCategories.reduce((s, cat) => s + (m.byCategory[cat] || 0), 0);
          return (
            <g key={mi} className="chart-bar-group" style={{ transition: 'opacity 0.15s' }}>
              {topCategories.map((cat, ci) => {
                const val = m.byCategory[cat] || 0;
                const barH = (val / niceMax) * chartH;
                const y = pad.top + chartH - yOffset - barH;
                yOffset += barH;
                const isTop = ci === topCategories.length - 1 || topCategories.slice(ci + 1).every(c => (m.byCategory[c] || 0) === 0);
                const isHovered = hoverSeg && hoverSeg.mi === mi && hoverSeg.ci === ci;
                return (
                  <rect key={ci} x={cx - barW / 2} y={y} width={barW} height={Math.max(barH, 0)}
                    rx={isTop ? 4 : 0} fill={pieColor(ci)}
                    opacity={hoverSeg && !isHovered ? 0.5 : 0.95}
                    style={{ cursor: 'pointer', transition: 'opacity 0.12s' }}
                    onMouseEnter={() => setHoverSeg({ mi, ci, x: cx, y: y + barH / 2 })}
                  />
                );
              })}
              {/* Total label above bar */}
              {totalVal > 0 && (
                <text x={cx} y={pad.top + chartH - yOffset - 6} textAnchor="middle"
                  fontSize={8} fontWeight={600} fill="var(--color-text-tertiary)" fontFamily="var(--font-headline)">
                  {totalVal >= 1000 ? `$${(totalVal / 1000).toFixed(1)}k` : `$${Math.round(totalVal)}`}
                </text>
              )}
            </g>
          );
        })}
        {xLabels}
        {renderSegTooltip()}
      </svg>
    );
  }

  /* ── Grouped bars ── */
  if (mode === 'grouped') {
    const n = topCategories.length;
    const groupW = slotW * 0.8;
    const singleW = groupW / n;
    return (
      <svg {...svgProps}>
        {bands}{grid}{baseline}
        {months.map((m, mi) => {
          const cx = xCenter(mi);
          const groupStart = cx - groupW / 2;
          return (
            <g key={mi}>
              {topCategories.map((cat, ci) => {
                const val = m.byCategory[cat] || 0;
                const barH = (val / niceMax) * chartH;
                const bx = groupStart + ci * singleW + 0.5;
                const by = yPos(val);
                const isHovered = hoverSeg && hoverSeg.mi === mi && hoverSeg.ci === ci;
                return (
                  <rect key={ci} x={bx} y={by}
                    width={Math.max(singleW - 1, 2)} height={Math.max(barH, 0)}
                    rx={3} fill={pieColor(ci)}
                    opacity={hoverSeg && !isHovered ? 0.5 : 0.95}
                    style={{ cursor: 'pointer', transition: 'opacity 0.12s' }}
                    onMouseEnter={() => setHoverSeg({ mi, ci, x: bx + singleW / 2, y: by })}
                  />
                );
              })}
            </g>
          );
        })}
        {xLabels}
        {renderSegTooltip()}
      </svg>
    );
  }

  /* ── Line chart ── */
  if (mode === 'line') {
    return (
      <svg {...svgProps}>
        {bands}{grid}{baseline}
        {topCategories.map((cat, ci) => {
          const points = months.map((m, mi) => ({ x: xCenter(mi), y: yPos(m.byCategory[cat] || 0) }));
          const d = smoothPath(points);
          const dim = hoverSeg && hoverSeg.ci !== ci;
          return (
            <g key={ci} opacity={dim ? 0.3 : 1} style={{ transition: 'opacity 0.12s' }}>
              <path d={d} fill="none" stroke={pieColor(ci)} strokeWidth={2.5}
                strokeLinecap="round" strokeLinejoin="round" opacity={0.85} />
              {points.map((p, pi) => {
                const isHovered = hoverSeg && hoverSeg.mi === pi && hoverSeg.ci === ci;
                return (
                  <g key={pi}>
                    <circle cx={p.x} cy={p.y} r={10} fill={pieColor(ci)} opacity={0}
                      style={{ cursor: 'pointer' }}
                      onMouseEnter={() => setHoverSeg({ mi: pi, ci, x: p.x, y: p.y })}
                    />
                    <circle cx={p.x} cy={p.y} r={isHovered ? 5.5 : 4}
                      fill="#fff" stroke={pieColor(ci)} strokeWidth={isHovered ? 2.5 : 2}
                      style={{ transition: 'r 0.12s' }}
                    />
                  </g>
                );
              })}
            </g>
          );
        })}
        {xLabels}
        {renderSegTooltip()}
      </svg>
    );
  }

  /* ── Area chart ── */
  if (mode === 'area') {
    const base = pad.top + chartH;
    return (
      <svg {...svgProps}>
        {bands}{grid}{baseline}
        {[...topCategories].reverse().map((cat, ri) => {
          const ci = topCategories.length - 1 - ri;
          const points = months.map((m, mi) => ({ x: xCenter(mi), y: yPos(m.byCategory[cat] || 0) }));
          const lineD = smoothPath(points);
          const areaD = `${lineD} L ${points[points.length - 1].x} ${base} L ${points[0].x} ${base} Z`;
          const dim = hoverSeg && hoverSeg.ci !== ci;
          return (
            <g key={ci} opacity={dim ? 0.25 : 1} style={{ transition: 'opacity 0.12s' }}>
              <defs>
                <linearGradient id={`area-grad-${ci}`} x1="0" y1="0" x2="0" y2="1">
                  <stop offset="0%" stopColor={pieColor(ci)} stopOpacity={0.35} />
                  <stop offset="100%" stopColor={pieColor(ci)} stopOpacity={0.05} />
                </linearGradient>
              </defs>
              <path d={areaD} fill={`url(#area-grad-${ci})`} />
              <path d={lineD} fill="none" stroke={pieColor(ci)} strokeWidth={2.5}
                strokeLinecap="round" strokeLinejoin="round" opacity={0.85} />
              {points.map((p, pi) => {
                const isHovered = hoverSeg && hoverSeg.mi === pi && hoverSeg.ci === ci;
                return (
                  <g key={pi}>
                    <circle cx={p.x} cy={p.y} r={10} fill={pieColor(ci)} opacity={0}
                      style={{ cursor: 'pointer' }}
                      onMouseEnter={() => setHoverSeg({ mi: pi, ci, x: p.x, y: p.y })}
                    />
                    {isHovered && (
                      <circle cx={p.x} cy={p.y} r={5} fill="#fff" stroke={pieColor(ci)} strokeWidth={2.5} />
                    )}
                  </g>
                );
              })}
            </g>
          );
        })}
        {xLabels}
        {renderSegTooltip()}
      </svg>
    );
  }

  return null;
}

function PieChart({ entries, total, size = 160, onSliceClick, highlightedNames }) {
  const [hoverIdx, setHoverIdx] = useState(null);
  if (!entries.length || total === 0) return null;
  const cx = size / 2;
  const cy = size / 2;
  const r = size / 2 - 4;
  const inner = r * 0.55;
  let currentAngle = -Math.PI / 2;
  const slices = entries.map((e, i) => {
    const pct = e.value / total;
    const angle = pct * Math.PI * 2;
    const startAngle = currentAngle;
    const endAngle = currentAngle + angle;
    currentAngle = endAngle;
    const midAngle = (startAngle + endAngle) / 2;
    const x1 = cx + r * Math.cos(startAngle);
    const y1 = cy + r * Math.sin(startAngle);
    const x2 = cx + r * Math.cos(endAngle);
    const y2 = cy + r * Math.sin(endAngle);
    const xi1 = cx + inner * Math.cos(startAngle);
    const yi1 = cy + inner * Math.sin(startAngle);
    const xi2 = cx + inner * Math.cos(endAngle);
    const yi2 = cy + inner * Math.sin(endAngle);
    const largeArc = angle > Math.PI ? 1 : 0;
    const d = `M ${x1} ${y1} A ${r} ${r} 0 ${largeArc} 1 ${x2} ${y2} L ${xi2} ${yi2} A ${inner} ${inner} 0 ${largeArc} 0 ${xi1} ${yi1} Z`;
    return { d, color: pieColor(i), name: e.name, pct, value: e.value, midAngle };
  });
  const hovered = hoverIdx != null ? slices[hoverIdx] : null;
  return (
    <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`} onMouseLeave={() => setHoverIdx(null)}>
      {slices.map((s, i) => {
        const isHighlighted = highlightedNames && highlightedNames.has(s.name);
        const filterDim = highlightedNames && highlightedNames.size > 0 && !isHighlighted;
        const hoverDim = hoverIdx != null && hoverIdx !== i;
        const opacity = filterDim ? 0.3 : hoverDim ? 0.5 : 1;
        return (
          <path
            key={i}
            d={s.d}
            fill={s.color}
            stroke="#fff"
            strokeWidth="1.5"
            opacity={opacity}
            style={{ cursor: onSliceClick ? 'pointer' : 'default', transition: 'opacity 0.15s' }}
            onMouseEnter={() => setHoverIdx(i)}
            onClick={() => onSliceClick && onSliceClick(s.name)}
          />
        );
      })}
      {hovered && (() => {
        const tx = cx + (inner + (r - inner) / 2) * Math.cos(hovered.midAngle);
        const ty = cy + (inner + (r - inner) / 2) * Math.sin(hovered.midAngle);
        const label = `${hovered.name}`;
        const valTxt = `${fmt(hovered.value)} · ${Math.round(hovered.pct * 100)}%`;
        const boxW = Math.max(label.length, valTxt.length) * 5.5 + 16;
        const boxH = 34;
        let bx = tx - boxW / 2;
        let by = ty - boxH - 6;
        if (bx < 2) bx = 2;
        if (bx + boxW > size - 2) bx = size - 2 - boxW;
        if (by < 2) by = ty + 6;
        return (
          <g style={{ pointerEvents: 'none' }}>
            <rect x={bx} y={by} width={boxW} height={boxH} rx={5}
              fill="var(--color-text-primary)" opacity={0.92} />
            <text x={bx + boxW / 2} y={by + 14} textAnchor="middle"
              fontSize={10} fontWeight={700} fill="#fff" fontFamily="var(--font-headline)">{label}</text>
            <text x={bx + boxW / 2} y={by + 27} textAnchor="middle"
              fontSize={9} fill="rgba(255,255,255,0.85)">{valTxt}</text>
          </g>
        );
      })()}
    </svg>
  );
}

function formatDate(dateStr) {
  if (!dateStr) return '';
  const d = new Date(dateStr);
  if (isNaN(d)) return dateStr;
  return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
}

/* Coerce any date string into YYYY-MM-DD for <input type="date"> */
function toIsoDate(dateStr) {
  if (!dateStr) return '';
  // Already in ISO form
  if (/^\d{4}-\d{2}-\d{2}/.test(dateStr)) return dateStr.slice(0, 10);
  const d = new Date(dateStr);
  if (isNaN(d)) return '';
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

/* Build a simple recurring-transaction list from raw transactions */
function findRecurring(transactions) {
  // Group by normalised description
  const groups = {};
  for (const t of transactions) {
    if (t.amount >= 0) continue; // only expenses
    const key = t.description.toLowerCase().trim();
    if (!key) continue;
    if (!groups[key]) groups[key] = { description: t.description, category: t.category, total: 0, count: 0 };
    groups[key].total += Math.abs(t.amount);
    groups[key].count += 1;
  }
  return Object.values(groups)
    .filter(g => g.count >= 2)
    .sort((a, b) => b.total - a.total)
    .slice(0, 5)
    .map(g => ({
      name: g.description,
      freq: `${g.count}x`,
      amount: fmt(g.total / g.count),
      icon: getCategoryIcon(g.category),
    }));
}

const ALL_CATEGORIES = [
  'Food & Drink', 'Shopping', 'Travel', 'Entertainment', 'Bills & Utilities',
  'Housing', 'Transportation', 'Health & Wellness', 'Income', 'Transfer',
  'Education', 'Personal Care', 'Gifts & Donations', 'Investments', 'Fees & Charges',
  'Uncategorized',
];

const SUBCATEGORIES = {
  'Food & Drink': ['Restaurants', 'Groceries', 'Coffee', 'Fast Food', 'Alcohol & Bars', 'Delivery'],
  'Shopping': ['Clothing', 'Electronics', 'Home Goods', 'Online Shopping', 'Sporting Goods', 'Books'],
  'Travel': ['Flights', 'Hotels', 'Car Rental', 'Vacation', 'Luggage & Travel Gear'],
  'Entertainment': ['Streaming', 'Movies & TV', 'Music', 'Games', 'Events & Concerts', 'Sports'],
  'Bills & Utilities': ['Electric', 'Gas', 'Water', 'Internet', 'Phone', 'Subscriptions', 'Insurance'],
  'Housing': ['Rent', 'Mortgage', 'Property Tax', 'HOA', 'Maintenance & Repairs', 'Furniture'],
  'Transportation': ['Gas & Fuel', 'Parking', 'Tolls', 'Public Transit', 'Ride Share', 'Car Payment', 'Car Insurance', 'Auto Maintenance'],
  'Health & Wellness': ['Doctor', 'Pharmacy', 'Gym & Fitness', 'Mental Health', 'Dental', 'Vision'],
  'Income': ['Salary', 'Freelance', 'Interest', 'Dividends', 'Refund', 'Bonus', 'Other Income'],
  'Transfer': ['Account Transfer', 'Credit Card Payment', 'Loan Payment', 'Investment Transfer'],
  'Education': ['Tuition', 'Books & Supplies', 'Courses', 'Student Loans'],
  'Personal Care': ['Haircut', 'Skincare', 'Spa', 'Cosmetics'],
  'Gifts & Donations': ['Gifts', 'Charity', 'Religious'],
  'Investments': ['Stocks', 'Crypto', 'Real Estate', 'Retirement'],
  'Fees & Charges': ['Bank Fees', 'ATM Fees', 'Late Fees', 'Service Charges', 'Interest Charges'],
};

export function TransactionsPage() {
  const { transactions, analytics, loading, updateTransactionCategory, updateTransactionSubcategory, updateTransactionDate, bulkUpdateCategoryByIds, addCategoryRule, removeCategoryRule, addSubcategoryRule, removeSubcategoryRule, categoryRules, subcategoryRules, customCategories, addCustomCategory, hiddenCategories, renameCategory, removeCategory, unhideCategory, transactionNotes, updateTransactionNote, getMatchCount, toggleHideTransaction, hiddenTransactions, hiddenCount } = useData();
  const [editingSubId, setEditingSubId] = useState(null);
  const [subSearchText, setSubSearchText] = useState('');
  const subDropdownRef = useRef(null);
  const [activeAccount, setActiveAccount] = useState('all');
  const [searchQuery, setSearchQuery] = useState('');
  const [page, setPage] = useState(0);
  const [editingId, setEditingId] = useState(null);
  const [newCategoryText, setNewCategoryText] = useState('');
  const [manageCategoriesMode, setManageCategoriesMode] = useState(false);
  const [showHiddenCategories, setShowHiddenCategories] = useState(false);
  const [renamingCategory, setRenamingCategory] = useState(null);
  const [renameText, setRenameText] = useState('');
  const [showHidden, setShowHidden] = useState(false);
  const [sortCol, setSortCol] = useState('date');
  const [sortDir, setSortDir] = useState('desc');
  const [pendingRule, setPendingRule] = useState(null);
  const [pendingSubRule, setPendingSubRule] = useState(null);
  const [selectedIds, setSelectedIds] = useState(new Set());
  const [bulkCategoryOpen, setBulkCategoryOpen] = useState(false);
  const [bulkCategorySearch, setBulkCategorySearch] = useState('');
  const [bulkSubOpen, setBulkSubOpen] = useState(false);
  const [bulkSubSearch, setBulkSubSearch] = useState('');
  const bulkSubRef = useRef(null);
  const [savedToast, setSavedToast] = useState(false);
  const [includedCategories, setIncludedCategories] = useState(new Set());
  const [includedSubcategories, setIncludedSubcategories] = useState(new Set());
  const [chartMode, setChartMode] = useState('stacked');
  const [chartMonthCount, setChartMonthCount] = useState(13);
  const [selectedMonth, setSelectedMonth] = useState(null);
  const [columnWidths, setColumnWidths] = useState(() => {
    try { return JSON.parse(localStorage.getItem('txnColumnWidths') || '{}'); }
    catch { return {}; }
  });
  const [columnFilters, setColumnFilters] = useState({
    merchant: '',
    description: '',
    category: '',
    subcategory: '',
    amount: '',
    date: '',
    notes: '',
    institution: '',
    account: '',
  });
  const resizingColRef = useRef(null);
  const [showAccounts, setShowAccounts] = useState(() => {
    try { return JSON.parse(localStorage.getItem('showAccounts') ?? 'true'); }
    catch { return true; }
  });
  const [organizedCategories, setOrganizedCategories] = useState(() => {
    try { return new Set(JSON.parse(localStorage.getItem('organizedCategories') || '[]')); }
    catch { return new Set(); }
  });
  const [draggedCategory, setDraggedCategory] = useState(null);
  const [dragOverBucket, setDragOverBucket] = useState(null);
  const dropdownRef = useRef(null);
  const confirmRef = useRef(null);
  const bulkDropdownRef = useRef(null);
  const savedTimer = useRef(null);

  /* ── Memos (ordered by dependency) ── */

  /* All categories from data + defaults + custom (excludes hidden) */
  const categoryOptions = useMemo(() => {
    const fromData = (transactions || []).map(t => t.category).filter(Boolean);
    const all = [...new Set([...ALL_CATEGORIES, ...fromData, ...customCategories])];
    return all.filter(c => !hiddenCategories.has(c)).sort();
  }, [transactions, customCategories, hiddenCategories]);

  /* Hidden category list (for restore in manage mode) */
  const hiddenCategoryList = useMemo(
    () => [...hiddenCategories].sort(),
    [hiddenCategories],
  );

  /* Account pill list */
  const accountNames = useMemo(
    () => analytics?.accountNames || [],
    [analytics],
  );

  /* Unique categories in current data for filter boxes */
  const activeCategories = useMemo(() => {
    const cats = (transactions || []).map(t => t.category || 'Uncategorized');
    return [...new Set(cats)].sort();
  }, [transactions]);

  /* Filtered + sorted transactions */
  const filtered = useMemo(() => {
    let list = transactions || [];
    if (activeAccount !== 'all') {
      list = list.filter(t => t.account === activeAccount);
    }
    if (includedCategories.size > 0) {
      list = list.filter(t => includedCategories.has(t.category || 'Uncategorized'));
    }
    if (includedSubcategories.size > 0) {
      list = list.filter(t => includedSubcategories.has(t.subcategory || 'Uncategorized'));
    }
    if (selectedMonth) {
      list = list.filter(t => {
        if (!t.date) return false;
        const d = new Date(t.date);
        if (isNaN(d)) return false;
        const key = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
        return key === selectedMonth;
      });
    }
    if (searchQuery.trim()) {
      const q = searchQuery.toLowerCase();
      list = list.filter(
        t =>
          (t.description || '').toLowerCase().includes(q) ||
          (t.category || '').toLowerCase().includes(q) ||
          (t.account || '').toLowerCase().includes(q) ||
          (t.institution || '').toLowerCase().includes(q) ||
          (t.fullDescription || '').toLowerCase().includes(q) ||
          String(t.amount).includes(q) ||
          formatDate(t.date).toLowerCase().includes(q),
      );
    }
    // Per-column filters
    const cf = columnFilters;
    const anyCol = Object.values(cf).some(v => v && String(v).trim());
    if (anyCol) {
      const matchText = (val, q) => !q || (String(val || '').toLowerCase().includes(String(q).toLowerCase()));
      const matchAmount = (amt, q) => {
        if (!q || !String(q).trim()) return true;
        const raw = String(q).trim();
        const num = parseFloat(raw.replace(/[$,\s]/g, ''));
        if (!isNaN(num)) {
          if (raw.startsWith('>')) return amt > num;
          if (raw.startsWith('<')) return amt < num;
          return Math.abs(Math.abs(amt) - Math.abs(num)) < 0.005;
        }
        return String(amt).includes(raw);
      };
      list = list.filter(t =>
        matchText(t.description, cf.merchant) &&
        matchText(t.fullDescription || t.description, cf.description) &&
        matchText(t.category || 'Uncategorized', cf.category) &&
        matchText(t.subcategory, cf.subcategory) &&
        matchAmount(t.amount, cf.amount) &&
        (cf.date ? formatDate(t.date).toLowerCase().includes(cf.date.toLowerCase()) || String(t.date || '').includes(cf.date) : true) &&
        matchText(transactionNotes[t.transactionId] || '', cf.notes) &&
        matchText(t.institution, cf.institution) &&
        matchText(t.account, cf.account)
      );
    }
    const sorted = [...list].sort((a, b) => {
      let cmp = 0;
      switch (sortCol) {
        case 'merchant': cmp = (a.description || '').localeCompare(b.description || ''); break;
        case 'description': cmp = (a.fullDescription || '').localeCompare(b.fullDescription || ''); break;
        case 'category': cmp = (a.category || '').localeCompare(b.category || ''); break;
        case 'amount': cmp = a.amount - b.amount; break;
        case 'date': cmp = new Date(a.date || 0) - new Date(b.date || 0); break;
        case 'account': cmp = (a.account || '').localeCompare(b.account || ''); break;
        case 'subcategory': cmp = (a.subcategory || '').localeCompare(b.subcategory || ''); break;
        case 'institution': cmp = (a.institution || '').localeCompare(b.institution || ''); break;
        default: cmp = 0;
      }
      return sortDir === 'asc' ? cmp : -cmp;
    });
    return sorted;
  }, [transactions, activeAccount, searchQuery, includedCategories, includedSubcategories, selectedMonth, columnFilters, sortCol, sortDir, transactionNotes]);

  const paginated = useMemo(
    () => filtered.slice(0, (page + 1) * PAGE_SIZE),
    [filtered, page],
  );

  const hasMore = paginated.length < filtered.length;

  /* Category allocation — top 8 expense categories */
  const categoryAlloc = useMemo(() => {
    if (!analytics?.byCategory) return [];
    const expenseCats = analytics.byCategory.filter(c => c.total < 0);
    const maxAbs = expenseCats.length ? expenseCats[0].absTotal : 1;
    return expenseCats.slice(0, 8).map(c => ({
      label: c.name,
      amount: fmt(c.absTotal),
      pct: Math.round((c.absTotal / (analytics.totalExpenses || 1)) * 100),
      color: catColor(c.name),
    }));
  }, [analytics]);

  /* Recurring commitments */
  const recurring = useMemo(
    () => findRecurring(transactions || []),
    [transactions],
  );

  /* Bar chart data — by category (or subcategory when single category filtered) over time */
  const barChartData = useMemo(() => {
    const source = filtered.filter(t => t.date && t.amount !== 0);
    if (!source.length) return { months: [], topCategories: [], maxTotal: 0, drillDown: false, parent: null, visibleKeys: new Set() };

    // Detect single-category drill-down (same logic as pie chart)
    const visibleCats = [...new Set(source.map(t => t.category || 'Uncategorized'))];
    const drillDown = visibleCats.length === 1;

    // Aggregate by month + (category or subcategory).
    // Sum signed amounts so refunds/reimbursements net against expenses,
    // then take the absolute value for display magnitude.
    const signedBuckets = {};
    const signedTotals = {};
    for (const t of source) {
      const d = new Date(t.date);
      if (isNaN(d)) continue;
      const key = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
      const group = drillDown
        ? (t.subcategory || 'Uncategorized')
        : (t.category || 'Uncategorized');
      if (!signedBuckets[key]) signedBuckets[key] = {};
      signedBuckets[key][group] = (signedBuckets[key][group] || 0) + t.amount;
      signedTotals[group] = (signedTotals[group] || 0) + t.amount;
    }
    // Convert to absolute magnitudes for bar heights
    const buckets = {};
    const catTotals = {};
    for (const k of Object.keys(signedBuckets)) {
      buckets[k] = {};
      for (const g of Object.keys(signedBuckets[k])) {
        buckets[k][g] = Math.abs(signedBuckets[k][g]);
      }
    }
    for (const g of Object.keys(signedTotals)) {
      catTotals[g] = Math.abs(signedTotals[g]);
    }

    // Top 6 groups by total spend
    const topCategories = Object.entries(catTotals)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 6)
      .map(([name]) => name);

    // Build continuous month range (fill gaps where no data exists)
    const sortedKeys = Object.keys(buckets).sort();
    const MONTH_SHORT = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

    // Generate all months between first and last data point
    const allKeys = [];
    if (sortedKeys.length > 0) {
      const [startY, startM] = sortedKeys[0].split('-').map(Number);
      const [endY, endM] = sortedKeys[sortedKeys.length - 1].split('-').map(Number);
      let cy = startY, cm = startM;
      while (cy < endY || (cy === endY && cm <= endM)) {
        allKeys.push(`${cy}-${String(cm).padStart(2, '0')}`);
        cm++;
        if (cm > 12) { cm = 1; cy++; }
      }
    }

    const recentKeys = allKeys.slice(-chartMonthCount);
    let maxTotal = 0;
    const months = recentKeys.map(key => {
      const [y, m] = key.split('-');
      const byCategory = {};
      let monthTotal = 0;
      for (const cat of topCategories) {
        const val = (buckets[key] && buckets[key][cat]) || 0;
        byCategory[cat] = val;
        monthTotal += val;
      }
      if (monthTotal > maxTotal) maxTotal = monthTotal;
      return { key, label: MONTH_SHORT[parseInt(m, 10) - 1], year: y, byCategory };
    });

    return { months, topCategories, maxTotal, drillDown, parent: drillDown ? visibleCats[0] : null, totalMonths: allKeys.length, visibleKeys: new Set(recentKeys) };
  }, [filtered, chartMonthCount]);

  /* Pie chart data — scoped to the same months visible in the spending chart */
  const pieData = useMemo(() => {
    const chartKeys = barChartData.visibleKeys;
    // Only expenses in the category breakdown — ignore income entirely.
    // Refunds/reimbursements (positive) against an expense category still net.
    const source = filtered.filter(t => {
      if (t.amount === 0 || !t.date) return false;
      if ((t.category || '') === 'Income') return false;
      if (!chartKeys || chartKeys.size === 0) return true;
      const d = new Date(t.date);
      if (isNaN(d)) return false;
      const key = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
      return chartKeys.has(key);
    });
    const visibleCats = [...new Set(source.map(t => t.category || 'Uncategorized'))];
    const drillDown = visibleCats.length === 1;
    // Sum signed amounts per category, then keep only categories whose net is a true expense (negative overall)
    const signed = {};
    for (const t of source) {
      const key = drillDown
        ? (t.subcategory || 'Uncategorized')
        : (t.category || 'Uncategorized');
      signed[key] = (signed[key] || 0) + t.amount;
    }
    const entries = Object.entries(signed)
      // Include any category that's a net expense; always show Uncategorized if present
      .filter(([name, v]) => v < 0 || (name === 'Uncategorized' && v !== 0))
      .map(([name, v]) => ({ name, value: Math.abs(v) }))
      .sort((a, b) => b.value - a.value);
    const total = entries.reduce((s, e) => s + e.value, 0);
    return { entries, total, drillDown, parent: drillDown ? visibleCats[0] : null };
  }, [filtered, barChartData.visibleKeys]);

  /* All subcategories available for selected transactions */
  const bulkSubOptions = useMemo(() => {
    const selected = filtered.filter(t => selectedIds.has(t.transactionId));
    const cats = [...new Set(selected.map(t => t.category).filter(Boolean))];
    const subs = new Set();
    for (const cat of cats) {
      for (const s of (SUBCATEGORIES[cat] || [])) subs.add(s);
    }
    for (const t of (transactions || [])) {
      if (t.subcategory) subs.add(t.subcategory);
    }
    return [...subs].sort();
  }, [selectedIds, filtered, transactions]);

  /* ── Effects ── */

  /* Clear selection when search changes */
  useEffect(() => { setSelectedIds(new Set()); }, [searchQuery, activeAccount]);

  /* Close subcategory dropdown on outside click */
  useEffect(() => {
    function handleClick(e) {
      if (subDropdownRef.current && !subDropdownRef.current.contains(e.target)) {
        setEditingSubId(null);
        setSubSearchText('');
      }
    }
    if (editingSubId !== null) document.addEventListener('mousedown', handleClick);
    return () => document.removeEventListener('mousedown', handleClick);
  }, [editingSubId]);

  /* Close dropdown / confirm on outside click */
  useEffect(() => {
    function handleClick(e) {
      if (confirmRef.current && confirmRef.current.contains(e.target)) return;
      if (dropdownRef.current && !dropdownRef.current.contains(e.target)) {
        setEditingId(null);
        setManageCategoriesMode(false);
        setRenamingCategory(null);
        setRenameText('');
        setShowHiddenCategories(false);
      }
    }
    if (editingId !== null) document.addEventListener('mousedown', handleClick);
    return () => document.removeEventListener('mousedown', handleClick);
  }, [editingId]);

  useEffect(() => {
    function handleClick(e) {
      if (confirmRef.current && !confirmRef.current.contains(e.target)) {
        setPendingRule(null);
      }
    }
    if (pendingRule) document.addEventListener('mousedown', handleClick);
    return () => document.removeEventListener('mousedown', handleClick);
  }, [pendingRule]);

  /* Close bulk dropdowns on outside click */
  useEffect(() => {
    function handleClick(e) {
      if (bulkDropdownRef.current && !bulkDropdownRef.current.contains(e.target)) {
        setBulkCategoryOpen(false);
        setBulkCategorySearch('');
      }
      if (bulkSubRef.current && !bulkSubRef.current.contains(e.target)) {
        setBulkSubOpen(false);
        setBulkSubSearch('');
      }
    }
    if (bulkCategoryOpen || bulkSubOpen) document.addEventListener('mousedown', handleClick);
    return () => document.removeEventListener('mousedown', handleClick);
  }, [bulkCategoryOpen, bulkSubOpen]);

  /* ── Handler functions ── */

  function flashSaved() {
    setSavedToast(true);
    clearTimeout(savedTimer.current);
    savedTimer.current = setTimeout(() => setSavedToast(false), 1500);
  }

  function handleSort(col) {
    if (sortCol === col) {
      setSortDir(d => d === 'asc' ? 'desc' : 'asc');
    } else {
      setSortCol(col);
      setSortDir(col === 'date' ? 'desc' : 'asc');
    }
    setPage(0);
  }

  function toggleSelect(id) {
    setSelectedIds(prev => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  }

  function toggleSelectAll() {
    const filteredIds = filtered.filter(t => t.transactionId).map(t => t.transactionId);
    if (selectedIds.size === filteredIds.length) {
      setSelectedIds(new Set());
    } else {
      setSelectedIds(new Set(filteredIds));
    }
  }

  function toggleCategoryFilter(cat) {
    setIncludedCategories(prev => {
      const next = new Set(prev);
      if (next.has(cat)) next.delete(cat); else next.add(cat);
      return next;
    });
    setPage(0);
  }

  function clearCategoryFilters() {
    setIncludedCategories(new Set());
    setPage(0);
  }

  function handleDropCategory(bucket) {
    if (!draggedCategory) return;
    setOrganizedCategories(prev => {
      const next = new Set(prev);
      if (bucket === 'organized') next.add(draggedCategory);
      else next.delete(draggedCategory);
      localStorage.setItem('organizedCategories', JSON.stringify([...next]));
      return next;
    });
    setDraggedCategory(null);
    setDragOverBucket(null);
    flashSaved();
  }

  function findMatchingRules(t) {
    const norm = s => (s || '').toLowerCase().trim().replace(/[\s\-–—]+/g, ' ');
    const desc = norm(t.description);
    const full = norm(t.fullDescription);
    const catRule = categoryRules.find(r => {
      const rd = norm(r.description);
      if (!rd) return false;
      if (desc && (desc.includes(rd) || rd.includes(desc))) return true;
      if (full && full.includes(rd)) return true;
      return false;
    });
    const subRule = subcategoryRules.find(r => {
      const rd = norm(r.description);
      if (!rd) return false;
      if (desc && (desc.includes(rd) || rd.includes(desc))) return true;
      if (full && full.includes(rd)) return true;
      return false;
    });
    return { catRule: catRule || null, subRule: subRule || null };
  }

  function handleCategorySelect(t, i, newCategory) {
    if (newCategory === t.category) {
      setEditingId(null);
      setNewCategoryText('');
      return;
    }
    if (!ALL_CATEGORIES.includes(newCategory)) addCustomCategory(newCategory);
    const matchCount = getMatchCount(t.description, t.amount);
    if (matchCount > 1) {
      setPendingRule({
        transactionId: t.transactionId,
        index: i,
        description: t.description,
        amount: t.amount,
        newCategory,
        matchCount,
      });
      setEditingId(null);
      setNewCategoryText('');
    } else {
      updateTransactionCategory(t.transactionId, i, newCategory);
      flashSaved();
      setEditingId(null);
      setNewCategoryText('');
    }
  }

  function startResizeColumn(e, key, currentWidth) {
    e.preventDefault();
    e.stopPropagation();
    resizingColRef.current = {
      key,
      startX: e.clientX,
      startWidth: currentWidth,
    };
    const onMove = moveEvent => {
      if (!resizingColRef.current) return;
      const { key: k, startX, startWidth } = resizingColRef.current;
      const newWidth = Math.max(60, startWidth + (moveEvent.clientX - startX));
      setColumnWidths(prev => ({ ...prev, [k]: newWidth }));
    };
    const onUp = () => {
      if (resizingColRef.current) {
        setColumnWidths(prev => {
          localStorage.setItem('txnColumnWidths', JSON.stringify(prev));
          return prev;
        });
      }
      resizingColRef.current = null;
      document.removeEventListener('mousemove', onMove);
      document.removeEventListener('mouseup', onUp);
      document.body.style.cursor = '';
      document.body.style.userSelect = '';
    };
    document.addEventListener('mousemove', onMove);
    document.addEventListener('mouseup', onUp);
    document.body.style.cursor = 'col-resize';
    document.body.style.userSelect = 'none';
  }

  function handleSubcategorySelect(t, newSub) {
    if (newSub === t.subcategory) {
      setEditingSubId(null);
      setSubSearchText('');
      return;
    }
    const matchCount = getMatchCount(t.description);
    if (newSub && matchCount > 1) {
      // Show confirmation dialog like categories — apply to just this one, or all + rule
      updateTransactionSubcategory(t.transactionId, newSub);
      flashSaved();
      setEditingSubId(null);
      setSubSearchText('');
      setPendingSubRule({
        transactionId: t.transactionId,
        description: t.description,
        newSubcategory: newSub,
        matchCount,
      });
    } else {
      updateTransactionSubcategory(t.transactionId, newSub);
      flashSaved();
      setEditingSubId(null);
      setSubSearchText('');
    }
  }

  function handleBulkCategory(cat) {
    if (!ALL_CATEGORIES.includes(cat)) addCustomCategory(cat);
    bulkUpdateCategoryByIds([...selectedIds], cat);
    flashSaved();
    setBulkCategoryOpen(false);
    setBulkCategorySearch('');
  }

  function handleBulkCategoryAndRule(cat) {
    if (!ALL_CATEGORIES.includes(cat)) addCustomCategory(cat);
    const selected = filtered.filter(t => selectedIds.has(t.transactionId));
    const seen = new Set();
    for (const t of selected) {
      const key = `${t.description.toLowerCase().trim()}|${Math.abs(t.amount)}`;
      if (!seen.has(key)) {
        seen.add(key);
        addCategoryRule(t.description, t.amount, cat);
      }
    }
    flashSaved();
    setSelectedIds(new Set());
    setBulkCategoryOpen(false);
    setBulkCategorySearch('');
  }

  function handleBulkSubcategory(sub) {
    const ids = [...selectedIds];
    ids.forEach(id => updateTransactionSubcategory(id, sub));
    flashSaved();
    setBulkSubOpen(false);
    setBulkSubSearch('');
  }

  function handleBulkSubcategoryAndRule(sub) {
    const selected = filtered.filter(t => selectedIds.has(t.transactionId));
    const seen = new Set();
    for (const t of selected) {
      const key = t.description.toLowerCase().trim();
      if (!seen.has(key)) {
        seen.add(key);
        addSubcategoryRule(t.description, sub);
      }
    }
    flashSaved();
    setSelectedIds(new Set());
    setBulkSubOpen(false);
    setBulkSubSearch('');
  }

  /* Loading state */
  if (loading) {
    return (
      <div className={styles.page} style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', minHeight: '60vh' }}>
        <div style={{ textAlign: 'center', opacity: 0.6 }}>
          <span className="material-symbols-outlined" style={{ fontSize: 40, marginBottom: 12, display: 'block' }}>hourglass_empty</span>
          Loading transactions...
        </div>
      </div>
    );
  }

  return (
    <div className={styles.page}>
      {/* Header */}
      <div className={styles.pageHeader}>
        <div>
          <div className={styles.pageTitle}>Transactions</div>
          <div className={styles.pageSubtitle}>
            {filtered.length} transaction{filtered.length !== 1 ? 's' : ''} across {accountNames.length} account{accountNames.length !== 1 ? 's' : ''}
          </div>
        </div>
        <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
          <button
            className={styles.exportBtn}
            onClick={() => {
              const next = !showAccounts;
              setShowAccounts(next);
              localStorage.setItem('showAccounts', JSON.stringify(next));
              if (!next) setActiveAccount('all');
            }}
          >
            <span className="material-symbols-outlined">{showAccounts ? 'visibility' : 'visibility_off'}</span>
            {showAccounts ? 'Hide' : 'Show'} Accounts
          </button>
          <button className={styles.exportBtn}>
            <span className="material-symbols-outlined">download</span>
            Export CSV
          </button>
        </div>
      </div>

      {/* Filter Bar */}
      {showAccounts && (
        <div className={styles.filterBar}>
          <div
            className={`${styles.filterPill} ${activeAccount === 'all' ? styles.filterPillActive : ''}`}
            onClick={() => { setActiveAccount('all'); setPage(0); }}
          >
            All Accounts
          </div>
          {accountNames.map(acc => (
            <div
              key={acc}
              className={`${styles.filterPill} ${activeAccount === acc ? styles.filterPillActive : ''}`}
              onClick={() => { setActiveAccount(acc); setPage(0); }}
            >
              {acc}
            </div>
          ))}
        </div>
      )}

      {/* Category Review Buckets */}
      <div className={styles.bucketGrid}>
        <div
          className={`${styles.bucket} ${dragOverBucket === 'review' ? styles.bucketActive : ''}`}
          onDragOver={e => { e.preventDefault(); setDragOverBucket('review'); }}
          onDragLeave={() => setDragOverBucket(null)}
          onDrop={() => handleDropCategory('review')}
        >
          <div className={styles.bucketHeader}>
            <span className="material-symbols-outlined" style={{ fontSize: 16, color: '#e8a317' }}>pending</span>
            <span className={styles.bucketTitle}>Needs Review</span>
            <span className={styles.bucketCount}>{activeCategories.filter(c => !organizedCategories.has(c)).length}</span>
            {(() => {
              const bucketCats = activeCategories.filter(c => !organizedCategories.has(c));
              const allSelected = bucketCats.length > 0 && bucketCats.every(c => includedCategories.has(c));
              return (
                <button
                  className={styles.categoryFilterClear}
                  style={{ marginLeft: 'auto', padding: 0, fontSize: 9 }}
                  onClick={() => {
                    setIncludedCategories(prev => {
                      const next = new Set(prev);
                      if (allSelected) {
                        for (const c of bucketCats) next.delete(c);
                      } else {
                        for (const c of bucketCats) next.add(c);
                      }
                      return next;
                    });
                    setPage(0);
                  }}
                  type="button"
                >
                  {allSelected ? 'Deselect All' : 'Select All'}
                </button>
              );
            })()}
          </div>
          <div className={styles.bucketItems}>
            {activeCategories.filter(c => !organizedCategories.has(c)).map(cat => {
              const color = catColor(cat);
              const bg = catBg(cat);
              const selected = includedCategories.has(cat);
              return (
                <div
                  key={cat}
                  className={styles.bucketChip}
                  draggable
                  onDragStart={() => setDraggedCategory(cat)}
                  onDragEnd={() => setDraggedCategory(null)}
                  onClick={() => { toggleCategoryFilter(cat); setPage(0); }}
                  style={{
                    background: selected ? bg : 'var(--color-surface-alt)',
                    color: selected ? color : 'var(--color-text-tertiary)',
                    borderColor: selected ? color + '30' : 'transparent',
                    opacity: selected ? 1 : 0.5,
                    cursor: 'pointer',
                  }}
                >
                  <span className="material-symbols-outlined" style={{ fontSize: 13 }}>{getCategoryIcon(cat)}</span>
                  {cat}
                </div>
              );
            })}
            {activeCategories.filter(c => !organizedCategories.has(c)).length === 0 && (
              <span className={styles.bucketEmpty}>All categories organized! Drop here to move back.</span>
            )}
          </div>
        </div>
        <div
          className={`${styles.bucket} ${dragOverBucket === 'organized' ? styles.bucketActive : ''}`}
          onDragOver={e => { e.preventDefault(); setDragOverBucket('organized'); }}
          onDragLeave={() => setDragOverBucket(null)}
          onDrop={() => handleDropCategory('organized')}
        >
          <div className={styles.bucketHeader}>
            <span className="material-symbols-outlined" style={{ fontSize: 16, color: '#16a34a' }}>check_circle</span>
            <span className={styles.bucketTitle}>Organized</span>
            <span className={styles.bucketCount}>{activeCategories.filter(c => organizedCategories.has(c)).length}</span>
            {(() => {
              const bucketCats = activeCategories.filter(c => organizedCategories.has(c));
              const allSelected = bucketCats.length > 0 && bucketCats.every(c => includedCategories.has(c));
              return (
                <button
                  className={styles.categoryFilterClear}
                  style={{ marginLeft: 'auto', padding: 0, fontSize: 9 }}
                  onClick={() => {
                    setIncludedCategories(prev => {
                      const next = new Set(prev);
                      if (allSelected) {
                        for (const c of bucketCats) next.delete(c);
                      } else {
                        for (const c of bucketCats) next.add(c);
                      }
                      return next;
                    });
                    setPage(0);
                  }}
                  type="button"
                >
                  {allSelected ? 'Deselect All' : 'Select All'}
                </button>
              );
            })()}
          </div>
          <div className={styles.bucketItems}>
            {activeCategories.filter(c => organizedCategories.has(c)).map(cat => {
              const color = catColor(cat);
              const bg = catBg(cat);
              const selected = includedCategories.has(cat);
              return (
                <div
                  key={cat}
                  className={styles.bucketChip}
                  draggable
                  onDragStart={() => setDraggedCategory(cat)}
                  onDragEnd={() => setDraggedCategory(null)}
                  onClick={() => { toggleCategoryFilter(cat); setPage(0); }}
                  style={{
                    background: selected ? bg : 'var(--color-surface-alt)',
                    color: selected ? color : 'var(--color-text-tertiary)',
                    borderColor: selected ? color + '30' : 'transparent',
                    opacity: selected ? 1 : 0.5,
                    cursor: 'pointer',
                  }}
                >
                  <span className="material-symbols-outlined" style={{ fontSize: 13 }}>{getCategoryIcon(cat)}</span>
                  {cat}
                </div>
              );
            })}
            {activeCategories.filter(c => organizedCategories.has(c)).length === 0 && (
              <span className={styles.bucketEmpty}>Drag categories here when they're organized</span>
            )}
          </div>
        </div>
      </div>

      {/* Search */}
      <div style={{ marginBottom: 16 }}>
        <input
          type="text"
          placeholder="Search transactions..."
          value={searchQuery}
          onChange={e => { setSearchQuery(e.target.value); setPage(0); }}
          style={{
            width: '100%',
            maxWidth: 400,
            padding: '10px 14px',
            borderRadius: 10,
            border: '1px solid var(--border, #e2e2e2)',
            background: 'var(--surface, #fff)',
            fontSize: 14,
            outline: 'none',
          }}
        />
      </div>

      {/* Bulk action bar */}
      {selectedIds.size > 0 && (
        <div className={styles.bulkBar} style={{ position: 'relative' }}>
          <span className={styles.bulkCount}>{selectedIds.size} selected</span>
          <button
            className={styles.bulkBtn}
            onClick={() => setBulkCategoryOpen(!bulkCategoryOpen)}
          >
            <span className="material-symbols-outlined" style={{ fontSize: 16 }}>category</span>
            Recategorize
          </button>
          <button
            className={styles.bulkBtn}
            onClick={() => { setBulkSubOpen(!bulkSubOpen); setBulkCategoryOpen(false); }}
          >
            <span className="material-symbols-outlined" style={{ fontSize: 16 }}>label</span>
            Set Subcategory
          </button>
          <button
            className={styles.bulkBtn}
            onClick={() => {
              selectedIds.forEach(id => toggleHideTransaction(id));
              setSelectedIds(new Set());
              flashSaved();
            }}
          >
            <span className="material-symbols-outlined" style={{ fontSize: 16 }}>visibility_off</span>
            Hide selected
          </button>
          <button
            className={styles.bulkBtnGhost}
            onClick={() => setSelectedIds(new Set())}
          >
            Clear
          </button>
          {bulkCategoryOpen && (
            <div className={styles.bulkCategoryDropdown} ref={bulkDropdownRef}>
              <input
                className={styles.categorySearch}
                type="text"
                placeholder="Search or type new..."
                value={bulkCategorySearch}
                onChange={e => setBulkCategorySearch(e.target.value)}
                onKeyDown={e => {
                  if (e.key === 'Enter' && bulkCategorySearch.trim()) {
                    handleBulkCategory(bulkCategorySearch.trim());
                  }
                }}
                autoFocus
              />
              {bulkCategorySearch.trim() && !categoryOptions.some(c => c.toLowerCase() === bulkCategorySearch.trim().toLowerCase()) && (
                <div
                  className={styles.categoryOption}
                  style={{ color: '#0058be', fontWeight: 600 }}
                  onClick={() => handleBulkCategory(bulkCategorySearch.trim())}
                >
                  <span className="material-symbols-outlined" style={{ fontSize: 14 }}>add</span>
                  Create "{bulkCategorySearch.trim()}"
                </div>
              )}
              {categoryOptions
                .filter(cat => !bulkCategorySearch || cat.toLowerCase().includes(bulkCategorySearch.toLowerCase()))
                .map(cat => (
                <div key={cat} className={styles.categoryOption}>
                  <span
                    style={{ display: 'flex', alignItems: 'center', gap: 8, flex: 1 }}
                    onClick={() => handleBulkCategory(cat)}
                  >
                    <span className="material-symbols-outlined" style={{ fontSize: 14, color: catColor(cat) }}>
                      {getCategoryIcon(cat)}
                    </span>
                    {cat}
                  </span>
                  <button
                    className={styles.ruleSmallBtn}
                    title="Apply + create auto-rule"
                    onClick={() => handleBulkCategoryAndRule(cat)}
                  >
                    <span className="material-symbols-outlined" style={{ fontSize: 13 }}>auto_fix_high</span>
                    + Rule
                  </button>
                </div>
              ))}
            </div>
          )}
          {bulkSubOpen && (
            <div className={styles.bulkCategoryDropdown} ref={bulkSubRef}>
              <input
                className={styles.categorySearch}
                type="text"
                placeholder="Search or type new subcategory..."
                value={bulkSubSearch}
                onChange={e => setBulkSubSearch(e.target.value)}
                onKeyDown={e => {
                  if (e.key === 'Enter' && bulkSubSearch.trim()) {
                    handleBulkSubcategory(bulkSubSearch.trim());
                  }
                }}
                autoFocus
              />
              <div
                className={styles.categoryOption}
                style={{ color: '#ba1a1a' }}
                onClick={() => handleBulkSubcategory('')}
              >
                <span className="material-symbols-outlined" style={{ fontSize: 14 }}>close</span>
                Clear subcategory
              </div>
              {bulkSubSearch.trim() && !bulkSubOptions.some(s => s.toLowerCase() === bulkSubSearch.trim().toLowerCase()) && (
                <div
                  className={styles.categoryOption}
                  style={{ color: '#0058be', fontWeight: 600 }}
                  onClick={() => handleBulkSubcategory(bulkSubSearch.trim())}
                >
                  <span className="material-symbols-outlined" style={{ fontSize: 14 }}>add</span>
                  Create "{bulkSubSearch.trim()}"
                </div>
              )}
              {bulkSubOptions
                .filter(s => !bulkSubSearch || s.toLowerCase().includes(bulkSubSearch.toLowerCase()))
                .map(sub => (
                <div key={sub} className={styles.categoryOption}>
                  <span
                    style={{ display: 'flex', alignItems: 'center', gap: 8, flex: 1 }}
                    onClick={() => handleBulkSubcategory(sub)}
                  >
                    {sub}
                  </span>
                  <button
                    className={styles.ruleSmallBtn}
                    title="Apply + create auto-rule"
                    onClick={() => handleBulkSubcategoryAndRule(sub)}
                  >
                    <span className="material-symbols-outlined" style={{ fontSize: 13 }}>auto_fix_high</span>
                    + Rule
                  </button>
                </div>
              ))}
            </div>
          )}
        </div>
      )}

      {/* Hidden transactions toggle */}
      {hiddenCount > 0 && (
        <div>
          <button
            className={styles.hiddenToggle}
            onClick={() => setShowHidden(!showHidden)}
          >
            <span className="material-symbols-outlined" style={{ fontSize: 16 }}>
              {showHidden ? 'visibility' : 'visibility_off'}
            </span>
            {hiddenCount} hidden transaction{hiddenCount !== 1 ? 's' : ''}
            <span className="material-symbols-outlined" style={{ fontSize: 14 }}>
              {showHidden ? 'expand_less' : 'expand_more'}
            </span>
          </button>
          {showHidden && (
            <div className={styles.hiddenPanel}>
              {hiddenTransactions.map((t, i) => (
                <div key={t.transactionId || i} className={styles.hiddenRow}>
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <span className={styles.merchantName}>{t.description}</span>
                    <span style={{ margin: '0 8px', color: 'var(--color-text-tertiary)' }}>&middot;</span>
                    <span className={styles.dateCell}>{formatDate(t.date)}</span>
                    <span style={{ margin: '0 8px', color: 'var(--color-text-tertiary)' }}>&middot;</span>
                    <span className={t.amount >= 0 ? styles.amountCredit : styles.amountDebit}>
                      {t.amount >= 0 ? '+' : ''}{fmt(t.amount)}
                    </span>
                  </div>
                  <button
                    className={styles.unhideBtn}
                    onClick={() => { toggleHideTransaction(t.transactionId); flashSaved(); }}
                  >
                    <span className="material-symbols-outlined" style={{ fontSize: 14 }}>visibility</span>
                    Unhide
                  </button>
                </div>
              ))}
            </div>
          )}
        </div>
      )}

      {/* Spending Over Time Chart */}
      {barChartData.months.length > 0 && (
        <div className={styles.barCard}>
          <div className={styles.barCardHeader}>
            <div className={styles.sectionLabel} style={{ marginBottom: 0, display: 'flex', alignItems: 'center', gap: 8 }}>
              <span>{barChartData.drillDown ? `${barChartData.parent} — Subcategories Over Time` : 'Spending Over Time'}</span>
              {selectedMonth && (
                <button
                  className={styles.categoryFilterClear}
                  style={{ padding: '2px 8px', fontSize: 10 }}
                  onClick={() => { setSelectedMonth(null); setPage(0); }}
                  type="button"
                >
                  {(() => {
                    const [y, m] = selectedMonth.split('-');
                    const MONTH_SHORT = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
                    return `${MONTH_SHORT[parseInt(m, 10) - 1]} ${y}`;
                  })()} ✕
                </button>
              )}
            </div>
            <div className={styles.barCardHeaderRight}>
              <div className={styles.monthControl}>
                <button
                  className={styles.monthBtn}
                  onClick={() => setChartMonthCount(c => Math.max(1, c - 1))}
                  disabled={chartMonthCount <= 1}
                >
                  <span className="material-symbols-outlined" style={{ fontSize: 16 }}>remove</span>
                </button>
                <span className={styles.monthLabel}>{chartMonthCount}mo</span>
                <button
                  className={styles.monthBtn}
                  onClick={() => setChartMonthCount(c => Math.min(barChartData.totalMonths || 24, c + 1))}
                  disabled={chartMonthCount >= (barChartData.totalMonths || 24)}
                >
                  <span className="material-symbols-outlined" style={{ fontSize: 16 }}>add</span>
                </button>
              </div>
              <div className={styles.barLegend}>
                {barChartData.topCategories.map((cat, i) => {
                  const active = includedCategories.size === 0 || includedCategories.has(cat);
                  return (
                    <div
                      key={cat}
                      className={styles.barLegendItem}
                      onClick={() => { toggleCategoryFilter(cat); setPage(0); }}
                      style={{ cursor: 'pointer', opacity: active ? 1 : 0.4 }}
                    >
                      <span className={styles.barLegendDot} style={{ background: pieColor(i) }} />
                      <span className={styles.barLegendName}>{cat}</span>
                    </div>
                  );
                })}
                {includedCategories.size > 0 && (
                  <button
                    className={styles.categoryFilterClear}
                    style={{ padding: 0, fontSize: 10, marginLeft: 4 }}
                    onClick={() => { clearCategoryFilters(); setPage(0); }}
                    type="button"
                  >
                    Clear
                  </button>
                )}
              </div>
              <div className={styles.chartModeGroup}>
                {CHART_MODES.map(m => (
                  <button
                    key={m.key}
                    className={`${styles.chartModeBtn} ${chartMode === m.key ? styles.chartModeBtnActive : ''}`}
                    onClick={() => setChartMode(m.key)}
                    title={m.label}
                  >
                    <span className="material-symbols-outlined" style={{ fontSize: 16 }}>{m.icon}</span>
                  </button>
                ))}
              </div>
            </div>
          </div>
          <SpendingChart
            months={barChartData.months}
            topCategories={barChartData.topCategories}
            maxTotal={barChartData.maxTotal}
            width={960}
            height={300}
            mode={chartMode}
            selectedMonth={selectedMonth}
            onMonthClick={key => {
              setSelectedMonth(prev => prev === key ? null : key);
              setPage(0);
            }}
          />
        </div>
      )}

      {/* Main Grid */}
      <div className={styles.mainGrid}>
        {/* Table */}
        <div className={styles.tableCard}>
          <table className={styles.table}>
            <thead>
              <tr>
                <th style={{ width: 36 }}>
                  <input
                    type="checkbox"
                    className={styles.checkbox}
                    checked={filtered.length > 0 && selectedIds.size === filtered.filter(t => t.transactionId).length}
                    onChange={toggleSelectAll}
                  />
                </th>
                {[
                  { key: 'merchant', label: 'Merchant' },
                  { key: 'description', label: 'Description' },
                  { key: 'category', label: 'Category' },
                  { key: 'subcategory', label: 'Subcategory' },
                  { key: 'amount', label: 'Amount' },
                  { key: 'date', label: 'Date' },
                  { key: 'notes', label: 'Notes' },
                  { key: 'institution', label: 'Institution' },
                  { key: 'account', label: 'Account' },
                ].map(col => {
                  const w = columnWidths[col.key];
                  return (
                    <th key={col.key} style={{
                      width: w ? w : undefined,
                      minWidth: w ? w : undefined,
                      maxWidth: w ? w : undefined,
                      position: 'relative',
                    }}>
                      <button
                        className={styles.sortableHeader}
                        onClick={() => handleSort(col.key)}
                        type="button"
                      >
                        {col.label}
                        <span className="material-symbols-outlined" style={{
                          fontSize: 14,
                          opacity: sortCol === col.key ? 1 : 0,
                          transition: 'opacity 0.15s',
                        }}>
                          {sortDir === 'asc' ? 'arrow_upward' : 'arrow_downward'}
                        </span>
                      </button>
                      <span
                        onMouseDown={e => startResizeColumn(e, col.key, w || e.currentTarget.parentElement.offsetWidth)}
                        style={{
                          position: 'absolute',
                          top: 0,
                          right: 0,
                          width: 6,
                          height: '100%',
                          cursor: 'col-resize',
                          userSelect: 'none',
                          zIndex: 2,
                        }}
                        title="Drag to resize"
                      />
                    </th>
                  );
                })}
                <th style={{ width: 40 }}></th>
              </tr>
              <tr className={styles.filterRow}>
                <th></th>
                {[
                  { key: 'merchant', placeholder: 'Filter merchant' },
                  { key: 'description', placeholder: 'Filter description' },
                  { key: 'category', placeholder: 'Filter category' },
                  { key: 'subcategory', placeholder: 'Filter sub' },
                  { key: 'amount', placeholder: '$, >100, <50' },
                  { key: 'date', placeholder: 'yyyy or mon' },
                  { key: 'notes', placeholder: 'Filter notes' },
                  { key: 'institution', placeholder: 'Filter institution' },
                  { key: 'account', placeholder: 'Filter account' },
                ].map(col => (
                  <th key={col.key} style={{ padding: '4px 8px', background: 'var(--color-surface)' }}>
                    <input
                      type="text"
                      value={columnFilters[col.key] || ''}
                      onChange={e => {
                        const v = e.target.value;
                        setColumnFilters(prev => ({ ...prev, [col.key]: v }));
                        setPage(0);
                      }}
                      placeholder={col.placeholder}
                      style={{
                        width: '100%',
                        padding: '4px 8px',
                        fontSize: 11,
                        border: '1px solid var(--border-ghost)',
                        borderRadius: 4,
                        background: 'var(--color-surface-alt)',
                        color: 'var(--color-text-primary)',
                        fontWeight: 400,
                        textTransform: 'none',
                        letterSpacing: 'normal',
                      }}
                    />
                  </th>
                ))}
                <th style={{ padding: '4px 8px', background: 'var(--color-surface)' }}>
                  {Object.values(columnFilters).some(v => v) && (
                    <button
                      onClick={() => {
                        setColumnFilters({ merchant: '', description: '', category: '', subcategory: '', amount: '', date: '', institution: '', account: '' });
                        setPage(0);
                      }}
                      title="Clear all column filters"
                      style={{ width: 24, height: 24, border: 'none', background: 'var(--color-surface-alt)', borderRadius: 4, cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center', color: 'var(--color-text-secondary)' }}
                    >
                      <span className="material-symbols-outlined" style={{ fontSize: 14 }}>filter_alt_off</span>
                    </button>
                  )}
                </th>
              </tr>
            </thead>
            <tbody>
              {paginated.map((t, i) => {
                const icon = getCategoryIcon(t.category);
                const color = catColor(t.category || 'Uncategorized');
                const bg = catBg(t.category || 'Uncategorized');
                const { catRule: rowCatRule, subRule: rowSubRule } = findMatchingRules(t);
                const rowCatRuleIdx = rowCatRule ? categoryRules.indexOf(rowCatRule) : -1;
                const rowSubRuleIdx = rowSubRule ? subcategoryRules.indexOf(rowSubRule) : -1;
                return (
                  <tr key={t.transactionId || i} className={selectedIds.has(t.transactionId) ? styles.selectedRow : ''}>
                    <td>
                      <input
                        type="checkbox"
                        className={styles.checkbox}
                        checked={selectedIds.has(t.transactionId)}
                        onChange={() => toggleSelect(t.transactionId)}
                      />
                    </td>
                    <td>
                      <div className={styles.merchantCell}>
                        <div
                          className={styles.merchantIcon}
                          style={{ background: bg, color }}
                        >
                          <span className="material-symbols-outlined">{icon}</span>
                        </div>
                        <div style={{ flex: 1, minWidth: 0 }}>
                          <div className={styles.merchantName}>{t.description}</div>
                          <div className={styles.merchantSub}>
                            {t.fullDescription && t.fullDescription !== t.description
                              ? t.fullDescription.slice(0, 60)
                              : t.category}
                          </div>
                          {(rowCatRule || rowSubRule) && (
                            <div style={{ display: 'flex', flexWrap: 'wrap', gap: 4, marginTop: 3 }}>
                              {rowCatRule && (
                                <span style={{
                                  display: 'inline-flex', alignItems: 'center', gap: 4,
                                  fontSize: 10, padding: '1px 6px', borderRadius: 4,
                                  background: 'rgba(0, 88, 190, 0.08)', color: 'var(--color-secondary, #0058be)',
                                  fontWeight: 600,
                                }}>
                                  <span className="material-symbols-outlined" style={{ fontSize: 11 }}>auto_fix_high</span>
                                  Category: {rowCatRule.category}
                                  <button
                                    type="button"
                                    title="Remove category rule"
                                    onClick={e => { e.stopPropagation(); removeCategoryRule(rowCatRuleIdx); flashSaved(); }}
                                    style={{ background: 'none', border: 'none', cursor: 'pointer', padding: 0, color: '#ba1a1a', display: 'flex', marginLeft: 2 }}
                                  >
                                    <span className="material-symbols-outlined" style={{ fontSize: 10 }}>close</span>
                                  </button>
                                </span>
                              )}
                              {rowSubRule && (
                                <span style={{
                                  display: 'inline-flex', alignItems: 'center', gap: 4,
                                  fontSize: 10, padding: '1px 6px', borderRadius: 4,
                                  background: 'rgba(124, 58, 237, 0.08)', color: '#7c3aed',
                                  fontWeight: 600,
                                }}>
                                  <span className="material-symbols-outlined" style={{ fontSize: 11 }}>auto_fix_high</span>
                                  Sub: {rowSubRule.subcategory}
                                  <button
                                    type="button"
                                    title="Remove subcategory rule"
                                    onClick={e => { e.stopPropagation(); removeSubcategoryRule(rowSubRuleIdx); flashSaved(); }}
                                    style={{ background: 'none', border: 'none', cursor: 'pointer', padding: 0, color: '#ba1a1a', display: 'flex', marginLeft: 2 }}
                                  >
                                    <span className="material-symbols-outlined" style={{ fontSize: 10 }}>close</span>
                                  </button>
                                </span>
                              )}
                            </div>
                          )}
                        </div>
                      </div>
                    </td>
                    <td className={styles.institutionCell} title={t.fullDescription || t.description}>
                      {t.fullDescription || t.description}
                    </td>
                    <td style={{ position: 'relative', overflow: 'visible' }}>
                      <span
                        className={styles.categoryBadge}
                        style={{ background: bg, color, cursor: 'pointer' }}
                        title="Click to change category"
                        onClick={() => setEditingId(editingId === (t.transactionId || i) ? null : (t.transactionId || i))}
                      >
                        {t.category || 'Uncategorized'}
                        <span className="material-symbols-outlined" style={{ fontSize: 12, marginLeft: 2 }}>edit</span>
                      </span>
                      {editingId === (t.transactionId || i) && (() => {
                        const { catRule, subRule } = findMatchingRules(t);
                        const catRuleIdx = catRule ? categoryRules.indexOf(catRule) : -1;
                        return (
                        <div className={styles.categoryDropdown} ref={dropdownRef}>
                          <div style={{ display: 'flex', alignItems: 'center', borderBottom: 'var(--border-ghost)' }}>
                            <input
                              className={styles.categorySearch}
                              type="text"
                              placeholder={manageCategoriesMode ? 'Manage categories' : 'Search or type new...'}
                              value={newCategoryText}
                              onChange={e => setNewCategoryText(e.target.value)}
                              onKeyDown={e => {
                                if (e.key === 'Enter' && newCategoryText.trim() && !manageCategoriesMode) {
                                  handleCategorySelect(t, i, newCategoryText.trim());
                                }
                              }}
                              disabled={manageCategoriesMode}
                              style={{ borderBottom: 'none', flex: 1 }}
                              autoFocus
                            />
                            <button
                              type="button"
                              title={manageCategoriesMode ? 'Done' : 'Manage categories'}
                              onClick={() => {
                                setManageCategoriesMode(v => !v);
                                setRenamingCategory(null);
                                setRenameText('');
                                setShowHiddenCategories(false);
                              }}
                              style={{
                                background: 'none',
                                border: 'none',
                                cursor: 'pointer',
                                padding: '6px 10px',
                                color: manageCategoriesMode ? 'var(--color-secondary, #0058be)' : 'var(--color-text-tertiary)',
                                display: 'flex',
                                alignItems: 'center',
                              }}
                            >
                              <span className="material-symbols-outlined" style={{ fontSize: 16 }}>
                                {manageCategoriesMode ? 'check' : 'settings'}
                              </span>
                            </button>
                          </div>
                          {!manageCategoriesMode && catRule && (
                            <div style={{
                              display: 'flex', alignItems: 'center', justifyContent: 'space-between',
                              padding: '6px 12px',
                              fontSize: 11.5,
                              background: 'rgba(0, 88, 190, 0.06)',
                              borderBottom: 'var(--border-ghost)',
                              color: 'var(--color-secondary, #0058be)',
                            }}>
                              <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                                <span className="material-symbols-outlined" style={{ fontSize: 14 }}>auto_fix_high</span>
                                <span>Rule: <strong>"{catRule.description}"</strong> → {catRule.category}</span>
                              </div>
                              <button
                                type="button"
                                title="Remove rule"
                                onClick={() => { removeCategoryRule(catRuleIdx); flashSaved(); }}
                                style={{ background: 'none', border: 'none', cursor: 'pointer', padding: 2, color: '#ba1a1a', display: 'flex' }}
                              >
                                <span className="material-symbols-outlined" style={{ fontSize: 14 }}>close</span>
                              </button>
                            </div>
                          )}
                          {!manageCategoriesMode && t.category && (
                            <div
                              className={styles.categoryOption}
                              style={{ color: '#ba1a1a' }}
                              onClick={() => {
                                updateTransactionCategory(t.transactionId, i, '');
                                flashSaved();
                                setEditingId(null);
                                setNewCategoryText('');
                              }}
                            >
                              <span className="material-symbols-outlined" style={{ fontSize: 14 }}>close</span>
                              Clear category
                            </div>
                          )}
                          {!manageCategoriesMode && newCategoryText.trim() && !categoryOptions.some(c => c.toLowerCase() === newCategoryText.trim().toLowerCase()) && (
                            <div
                              className={styles.categoryOption}
                              style={{ color: '#0058be', fontWeight: 600 }}
                              onClick={() => handleCategorySelect(t, i, newCategoryText.trim())}
                            >
                              <span className="material-symbols-outlined" style={{ fontSize: 14 }}>add</span>
                              Create "{newCategoryText.trim()}"
                            </div>
                          )}
                          {categoryOptions
                            .filter(cat => manageCategoriesMode || !newCategoryText || cat.toLowerCase().includes(newCategoryText.toLowerCase()))
                            .map(cat => (
                            <div
                              key={cat}
                              className={`${styles.categoryOption} ${cat === t.category && !manageCategoriesMode ? styles.categoryOptionActive : ''}`}
                              onClick={() => {
                                if (manageCategoriesMode) return;
                                handleCategorySelect(t, i, cat);
                              }}
                              style={manageCategoriesMode ? { cursor: 'default' } : undefined}
                            >
                              <span className="material-symbols-outlined" style={{ fontSize: 14, color: catColor(cat) }}>
                                {getCategoryIcon(cat)}
                              </span>
                              {renamingCategory === cat ? (
                                <input
                                  type="text"
                                  value={renameText}
                                  autoFocus
                                  onChange={e => setRenameText(e.target.value)}
                                  onClick={e => e.stopPropagation()}
                                  onKeyDown={e => {
                                    if (e.key === 'Enter') {
                                      const newName = renameText.trim();
                                      if (newName && newName !== cat) renameCategory(cat, newName);
                                      setRenamingCategory(null);
                                      setRenameText('');
                                    } else if (e.key === 'Escape') {
                                      setRenamingCategory(null);
                                      setRenameText('');
                                    }
                                  }}
                                  onBlur={() => {
                                    const newName = renameText.trim();
                                    if (newName && newName !== cat) renameCategory(cat, newName);
                                    setRenamingCategory(null);
                                    setRenameText('');
                                  }}
                                  style={{
                                    flex: 1,
                                    border: '1px solid var(--color-secondary, #0058be)',
                                    borderRadius: 4,
                                    padding: '2px 6px',
                                    fontSize: 12.5,
                                    fontFamily: 'var(--font-body)',
                                    outline: 'none',
                                  }}
                                />
                              ) : (
                                <span style={{ flex: 1 }}>{cat}</span>
                              )}
                              {manageCategoriesMode && renamingCategory !== cat && (
                                <>
                                  <button
                                    type="button"
                                    title="Rename"
                                    onClick={e => {
                                      e.stopPropagation();
                                      setRenamingCategory(cat);
                                      setRenameText(cat);
                                    }}
                                    style={{ background: 'none', border: 'none', cursor: 'pointer', padding: 2, color: 'var(--color-text-tertiary)', display: 'flex' }}
                                  >
                                    <span className="material-symbols-outlined" style={{ fontSize: 14 }}>edit</span>
                                  </button>
                                  <button
                                    type="button"
                                    title="Remove"
                                    onClick={e => {
                                      e.stopPropagation();
                                      const count = (transactions || []).filter(tx => (tx.category || '') === cat).length;
                                      const msg = count > 0
                                        ? `Remove "${cat}"? ${count} transaction${count === 1 ? '' : 's'} will be set to Uncategorized.`
                                        : `Remove "${cat}"?`;
                                      if (window.confirm(msg)) removeCategory(cat, '');
                                    }}
                                    style={{ background: 'none', border: 'none', cursor: 'pointer', padding: 2, color: '#ba1a1a', display: 'flex' }}
                                  >
                                    <span className="material-symbols-outlined" style={{ fontSize: 14 }}>delete</span>
                                  </button>
                                </>
                              )}
                            </div>
                          ))}
                          {manageCategoriesMode && hiddenCategoryList.length > 0 && (
                            <>
                              <div
                                onClick={() => setShowHiddenCategories(v => !v)}
                                style={{
                                  display: 'flex', alignItems: 'center', gap: 6,
                                  padding: '8px 12px',
                                  fontSize: 11.5,
                                  color: 'var(--color-text-tertiary)',
                                  cursor: 'pointer',
                                  borderTop: 'var(--border-ghost)',
                                  textTransform: 'uppercase',
                                  letterSpacing: 0.5,
                                }}
                              >
                                <span className="material-symbols-outlined" style={{ fontSize: 14 }}>
                                  {showHiddenCategories ? 'expand_less' : 'expand_more'}
                                </span>
                                Hidden ({hiddenCategoryList.length})
                              </div>
                              {showHiddenCategories && hiddenCategoryList.map(cat => (
                                <div key={`hidden-${cat}`} className={styles.categoryOption} style={{ opacity: 0.7, cursor: 'default' }}>
                                  <span className="material-symbols-outlined" style={{ fontSize: 14, color: catColor(cat) }}>
                                    {getCategoryIcon(cat)}
                                  </span>
                                  <span style={{ flex: 1, textDecoration: 'line-through' }}>{cat}</span>
                                  <button
                                    type="button"
                                    title="Restore"
                                    onClick={e => { e.stopPropagation(); unhideCategory(cat); }}
                                    style={{ background: 'none', border: 'none', cursor: 'pointer', padding: 2, color: 'var(--color-secondary, #0058be)', display: 'flex' }}
                                  >
                                    <span className="material-symbols-outlined" style={{ fontSize: 14 }}>undo</span>
                                  </button>
                                </div>
                              ))}
                            </>
                          )}
                        </div>
                        );
                      })()}
                    </td>
                    <td style={{ position: 'relative', overflow: 'visible' }}>
                      {(() => {
                        const subKey = t.transactionId || i;
                        const subs = SUBCATEGORIES[t.category] || [];
                        const allSubs = [...new Set([...subs, ...(transactions || []).filter(tx => tx.category === t.category && tx.subcategory).map(tx => tx.subcategory)])].sort();
                        const { subRule } = findMatchingRules(t);
                        const subRuleIdx = subRule ? subcategoryRules.indexOf(subRule) : -1;
                        return (
                          <>
                            <span
                              className={styles.subcategoryBadge}
                              onClick={() => { setEditingSubId(editingSubId === subKey ? null : subKey); setSubSearchText(''); }}
                              title="Click to set subcategory"
                            >
                              {t.subcategory || '—'}
                              <span className="material-symbols-outlined" style={{ fontSize: 11, marginLeft: 2 }}>edit</span>
                            </span>
                            {editingSubId === subKey && (
                              <div className={styles.categoryDropdown} ref={subDropdownRef}>
                                <input
                                  className={styles.categorySearch}
                                  type="text"
                                  placeholder="Search or type new..."
                                  value={subSearchText}
                                  onChange={e => setSubSearchText(e.target.value)}
                                  onKeyDown={e => {
                                    if (e.key === 'Enter' && subSearchText.trim()) {
                                      handleSubcategorySelect(t, subSearchText.trim());
                                    }
                                  }}
                                  autoFocus
                                />
                                {subRule && (
                                  <div style={{
                                    display: 'flex', alignItems: 'center', justifyContent: 'space-between',
                                    padding: '6px 12px',
                                    fontSize: 11.5,
                                    background: 'rgba(0, 88, 190, 0.06)',
                                    borderBottom: 'var(--border-ghost)',
                                    color: 'var(--color-secondary, #0058be)',
                                  }}>
                                    <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                                      <span className="material-symbols-outlined" style={{ fontSize: 14 }}>auto_fix_high</span>
                                      <span>Rule: <strong>"{subRule.description}"</strong> → {subRule.subcategory}</span>
                                    </div>
                                    <button
                                      type="button"
                                      title="Remove rule"
                                      onClick={() => { removeSubcategoryRule(subRuleIdx); flashSaved(); }}
                                      style={{ background: 'none', border: 'none', cursor: 'pointer', padding: 2, color: '#ba1a1a', display: 'flex' }}
                                    >
                                      <span className="material-symbols-outlined" style={{ fontSize: 14 }}>close</span>
                                    </button>
                                  </div>
                                )}
                                {t.subcategory && (
                                  <div
                                    className={styles.categoryOption}
                                    style={{ color: '#ba1a1a' }}
                                    onClick={() => handleSubcategorySelect(t, '')}
                                  >
                                    <span className="material-symbols-outlined" style={{ fontSize: 14 }}>close</span>
                                    Clear subcategory
                                  </div>
                                )}
                                {subSearchText.trim() && !allSubs.some(s => s.toLowerCase() === subSearchText.trim().toLowerCase()) && (
                                  <div
                                    className={styles.categoryOption}
                                    style={{ color: '#0058be', fontWeight: 600 }}
                                    onClick={() => handleSubcategorySelect(t, subSearchText.trim())}
                                  >
                                    <span className="material-symbols-outlined" style={{ fontSize: 14 }}>add</span>
                                    Create "{subSearchText.trim()}"
                                  </div>
                                )}
                                {allSubs
                                  .filter(s => !subSearchText || s.toLowerCase().includes(subSearchText.toLowerCase()))
                                  .map(sub => (
                                  <div
                                    key={sub}
                                    className={`${styles.categoryOption} ${sub === t.subcategory ? styles.categoryOptionActive : ''}`}
                                  >
                                    <span
                                      style={{ flex: 1, cursor: 'pointer' }}
                                      onClick={() => handleSubcategorySelect(t, sub)}
                                    >
                                      {sub}
                                    </span>
                                    <button
                                      className={styles.ruleSmallBtn}
                                      title="Apply to all matching + create rule"
                                      onClick={e => {
                                        e.stopPropagation();
                                        addSubcategoryRule(t.description, sub);
                                        flashSaved();
                                        setEditingSubId(null);
                                        setSubSearchText('');
                                      }}
                                    >
                                      <span className="material-symbols-outlined" style={{ fontSize: 13 }}>auto_fix_high</span>
                                      + Rule
                                    </button>
                                  </div>
                                ))}
                              </div>
                            )}
                          </>
                        );
                      })()}
                    </td>
                    <td>
                      <span className={t.amount >= 0 ? styles.amountCredit : styles.amountDebit}>
                        {t.amount >= 0 ? '+' : ''}{fmt(t.amount)}
                      </span>
                    </td>
                    <td className={styles.dateCell}>
                      <input
                        type="date"
                        value={toIsoDate(t.date)}
                        onChange={e => {
                          const fallbackKey = `${t.date || ''}|${(t.description || '').trim()}|${t.amount}`;
                          updateTransactionDate(t.transactionId, e.target.value, fallbackKey);
                          flashSaved();
                        }}
                        style={{
                          border: 'none',
                          background: 'transparent',
                          font: 'inherit',
                          color: 'inherit',
                          padding: 0,
                          cursor: 'pointer',
                          width: '100%',
                          colorScheme: 'light',
                        }}
                        title={`Click to edit date (current: ${formatDate(t.date)})`}
                      />
                    </td>
                    <td>
                      <input
                        type="text"
                        className={styles.noteInput}
                        value={transactionNotes[t.transactionId] || ''}
                        placeholder="Add note..."
                        onChange={e => updateTransactionNote(t.transactionId, e.target.value)}
                      />
                    </td>
                    <td className={styles.institutionCell}>{t.institution}</td>
                    <td>
                      <div className={styles.accountCell}>
                        <div className={styles.accountDot} style={{ background: catColor(t.account || 'Unknown') }} />
                        {t.account}
                      </div>
                    </td>
                    <td>
                      <button
                        className={styles.hideBtn}
                        title="Hide from reporting"
                        onClick={() => { toggleHideTransaction(t.transactionId); flashSaved(); }}
                      >
                        <span className="material-symbols-outlined" style={{ fontSize: 16 }}>visibility_off</span>
                      </button>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>

          {/* Load more */}
          {hasMore && (
            <div style={{ textAlign: 'center', padding: '20px 0' }}>
              <button
                onClick={() => setPage(p => p + 1)}
                style={{
                  padding: '10px 28px',
                  borderRadius: 10,
                  border: '1px solid var(--border, #e2e2e2)',
                  background: 'var(--surface, #fff)',
                  cursor: 'pointer',
                  fontSize: 14,
                  fontWeight: 500,
                }}
              >
                Load more ({filtered.length - paginated.length} remaining)
              </button>
            </div>
          )}
        </div>

        {/* Side Column */}
        <div className={styles.sideColumn}>
          {/* Pie Chart */}
          {pieData.entries.length > 0 && (
            <div className={styles.pieCard}>
              <div className={styles.sectionLabel} style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                <span>{pieData.drillDown ? `${pieData.parent} — Subcategories` : 'Category Breakdown'}</span>
                {((pieData.drillDown && includedSubcategories.size > 0) || (!pieData.drillDown && includedCategories.size > 0)) && (
                  <button
                    className={styles.categoryFilterClear}
                    style={{ padding: 0, fontSize: 10 }}
                    onClick={() => {
                      if (pieData.drillDown) setIncludedSubcategories(new Set());
                      else setIncludedCategories(new Set());
                      setPage(0);
                    }}
                  >
                    Clear
                  </button>
                )}
              </div>
              <div className={styles.pieChartWrap}>
                <PieChart
                  entries={pieData.entries}
                  total={pieData.total}
                  size={160}
                  highlightedNames={pieData.drillDown ? includedSubcategories : includedCategories}
                  onSliceClick={name => {
                    if (pieData.drillDown) {
                      setIncludedSubcategories(prev => {
                        const next = new Set(prev);
                        if (next.has(name)) next.delete(name); else next.add(name);
                        return next;
                      });
                    } else {
                      // Clear subcategory filter when toggling categories — avoids stale filter mismatches
                      setIncludedSubcategories(new Set());
                      setIncludedCategories(prev => {
                        const next = new Set(prev);
                        if (next.has(name)) next.delete(name); else next.add(name);
                        return next;
                      });
                    }
                    setPage(0);
                  }}
                />
                <div className={styles.pieCenter}>
                  <div className={styles.pieCenterValue}>{fmt(pieData.total)}</div>
                  <div className={styles.pieCenterLabel}>total</div>
                </div>
              </div>
              <div className={styles.pieLegend}>
                {pieData.entries.slice(0, 8).map((e, i) => {
                  const highlightSet = pieData.drillDown ? includedSubcategories : includedCategories;
                  const isActive = highlightSet.has(e.name);
                  const dimmed = highlightSet.size > 0 && !isActive;
                  return (
                    <div
                      key={e.name}
                      className={styles.pieLegendItem}
                      style={{ cursor: 'pointer', opacity: dimmed ? 0.5 : 1, fontWeight: isActive ? 700 : undefined }}
                      onClick={() => {
                        if (pieData.drillDown) {
                          setIncludedSubcategories(prev => {
                            const next = new Set(prev);
                            if (next.has(e.name)) next.delete(e.name); else next.add(e.name);
                            return next;
                          });
                        } else {
                          setIncludedSubcategories(new Set());
                          setIncludedCategories(prev => {
                            const next = new Set(prev);
                            if (next.has(e.name)) next.delete(e.name); else next.add(e.name);
                            return next;
                          });
                        }
                        setPage(0);
                      }}
                    >
                      <span className={styles.pieLegendDot} style={{ background: pieColor(i) }} />
                      <span className={styles.pieLegendName}>{e.name}</span>
                      <span className={styles.pieLegendPct}>{Math.round((e.value / pieData.total) * 100)}%</span>
                    </div>
                  );
                })}
              </div>
            </div>
          )}

          {/* Recurring Commitments */}
          <div className={styles.recurringCard}>
            <div className={styles.sectionLabel}>Recurring Commitments</div>
            {recurring.length === 0 && (
              <div style={{ opacity: 0.5, fontSize: 13, padding: '8px 0' }}>No recurring transactions detected</div>
            )}
            {recurring.map((r, i) => (
              <div key={i} className={styles.recurringItem}>
                <div className={styles.recurringLeft}>
                  <div className={styles.recurringIcon}>
                    <span className="material-symbols-outlined">{r.icon}</span>
                  </div>
                  <div>
                    <div className={styles.recurringName}>{r.name}</div>
                    <div className={styles.recurringFreq}>{r.freq}</div>
                  </div>
                </div>
                <span className={styles.recurringAmount}>{r.amount}</span>
              </div>
            ))}
          </div>

          {/* Category Allocation */}
          <div className={styles.allocCard}>
            <div className={styles.sectionLabel}>Category Allocation</div>
            {categoryAlloc.map((c, i) => (
              <div key={i} className={styles.allocItem}>
                <div className={styles.allocHeader}>
                  <span className={styles.allocLabel}>{c.label}</span>
                  <span className={styles.allocValue}>{c.amount}</span>
                </div>
                <div className={styles.allocBar}>
                  <div
                    className={styles.allocFill}
                    style={{ width: `${c.pct}%`, background: c.color }}
                  />
                </div>
              </div>
            ))}
          </div>

          {/* Executive Summary */}
          <div className={styles.summaryCard}>
            <div className={styles.summaryLabel}>Executive Summary</div>
            <div className={styles.summaryTitle}>
              {analytics
                ? `${fmt(analytics.totalExpenses)} spent across ${analytics.transactionCount} transactions`
                : 'Calculating...'}
            </div>
            <div className={styles.summaryText}>
              {analytics
                ? `Total income: ${fmt(analytics.totalIncome)}. Cash flow: ${fmt(analytics.cashFlow)}. ${categoryAlloc.length ? `Top category: ${categoryAlloc[0]?.label} (${categoryAlloc[0]?.pct}% of spend).` : ''}`
                : 'Loading summary data...'}
            </div>
          </div>
        </div>
      </div>

      {/* Bulk category rule confirmation */}
      {pendingRule && (
        <div className={styles.ruleOverlay}>
          <div className={styles.ruleDialog} ref={confirmRef}>
            <div className={styles.ruleDialogIcon}>
              <span className="material-symbols-outlined" style={{ fontSize: 24 }}>category</span>
            </div>
            <div className={styles.ruleDialogTitle}>
              Recategorize as "{pendingRule.newCategory}"
            </div>
            <div className={styles.ruleDialogDesc}>
              There {pendingRule.matchCount === 1 ? 'is' : 'are'} <strong>{pendingRule.matchCount}</strong> transaction{pendingRule.matchCount !== 1 ? 's' : ''} from <strong>{pendingRule.description}</strong> at <strong>{fmt(Math.abs(pendingRule.amount))}</strong>.
            </div>
            <div className={styles.ruleDialogActions}>
              <button
                className={styles.ruleBtn}
                onClick={() => {
                  updateTransactionCategory(pendingRule.transactionId, pendingRule.index, pendingRule.newCategory);
                  flashSaved();
                  setPendingRule(null);
                }}
              >
                Just this one
              </button>
              <button
                className={styles.ruleBtnPrimary}
                onClick={() => {
                  addCategoryRule(pendingRule.description, pendingRule.amount, pendingRule.newCategory);
                  flashSaved();
                  setPendingRule(null);
                }}
              >
                <span className="material-symbols-outlined" style={{ fontSize: 16 }}>auto_fix_high</span>
                Apply to all {pendingRule.matchCount} + create rule
              </button>
            </div>
            <div className={styles.ruleDialogHint}>
              Rules auto-categorize matching charges on future syncs
            </div>
          </div>
        </div>
      )}

      {/* Subcategory rule confirmation */}
      {pendingSubRule && (
        <div className={styles.ruleOverlay}>
          <div className={styles.ruleDialog}>
            <div className={styles.ruleDialogIcon}>
              <span className="material-symbols-outlined" style={{ fontSize: 24 }}>bookmark</span>
            </div>
            <div className={styles.ruleDialogTitle}>
              Set subcategory to "{pendingSubRule.newSubcategory}"
            </div>
            <div className={styles.ruleDialogDesc}>
              There are <strong>{pendingSubRule.matchCount}</strong> transactions from <strong>{pendingSubRule.description}</strong>. Apply this subcategory to all of them?
            </div>
            <div className={styles.ruleDialogActions}>
              <button
                className={styles.ruleBtn}
                onClick={() => setPendingSubRule(null)}
              >
                Just this one
              </button>
              <button
                className={styles.ruleBtnPrimary}
                onClick={() => {
                  addSubcategoryRule(pendingSubRule.description, pendingSubRule.newSubcategory);
                  flashSaved();
                  setPendingSubRule(null);
                }}
              >
                <span className="material-symbols-outlined" style={{ fontSize: 16 }}>auto_fix_high</span>
                Apply to all {pendingSubRule.matchCount} + create rule
              </button>
            </div>
            <div className={styles.ruleDialogHint}>
              Rules auto-tag matching charges on future syncs
            </div>
          </div>
        </div>
      )}

      {/* Saved toast */}
      <div className={`${styles.savedToast} ${savedToast ? styles.savedToastVisible : ''}`}>
        <span className="material-symbols-outlined" style={{ fontSize: 16 }}>check_circle</span>
        Saved!
      </div>
    </div>
  );
}
