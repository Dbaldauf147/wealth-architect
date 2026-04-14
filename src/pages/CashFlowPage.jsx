import { useMemo, useState } from 'react';
import { useData } from '../contexts/DataContext';

function fmt(n) {
  if (n == null) return '—';
  return new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', minimumFractionDigits: 0, maximumFractionDigits: 0 }).format(n);
}

const MONTH_SHORT = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

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

export function CashFlowPage() {
  const { transactions, loading } = useData();
  const [monthCount, setMonthCount] = useState(13);

  const data = useMemo(() => {
    if (!transactions) return { months: [], totalIncome: 0, totalExpenses: 0, net: 0, avgIncome: 0, avgExpenses: 0 };

    const buckets = {};
    for (const t of transactions) {
      if (!t.date || t.amount === 0) continue;
      const d = new Date(t.date);
      if (isNaN(d)) continue;
      const key = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
      if (!buckets[key]) buckets[key] = { income: 0, expenses: 0 };
      if (t.amount > 0) buckets[key].income += t.amount;
      else buckets[key].expenses += Math.abs(t.amount);
    }

    const sortedKeys = Object.keys(buckets).sort();
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

    const recentKeys = allKeys.slice(-monthCount);
    const months = recentKeys.map(key => {
      const [y, m] = key.split('-');
      const b = buckets[key] || { income: 0, expenses: 0 };
      return {
        key,
        label: MONTH_SHORT[parseInt(m, 10) - 1],
        year: y,
        income: b.income,
        expenses: b.expenses,
        net: b.income - b.expenses,
      };
    });

    const totalIncome = months.reduce((s, m) => s + m.income, 0);
    const totalExpenses = months.reduce((s, m) => s + m.expenses, 0);
    const activeMonths = months.filter(m => m.income > 0 || m.expenses > 0).length || 1;

    return {
      months,
      totalIncome,
      totalExpenses,
      net: totalIncome - totalExpenses,
      avgIncome: totalIncome / activeMonths,
      avgExpenses: totalExpenses / activeMonths,
      savingsRate: totalIncome > 0 ? (totalIncome - totalExpenses) / totalIncome : 0,
    };
  }, [transactions, monthCount]);

  if (loading) {
    return <div style={{ padding: 40, textAlign: 'center', color: 'var(--color-text-tertiary)' }}>Loading...</div>;
  }

  const incomeColor = '#16a34a';
  const expenseColor = '#dc2626';
  const netColor = data.net >= 0 ? incomeColor : expenseColor;

  // Chart dimensions
  const chartW = 960;
  const chartH = 340;
  const pad = { top: 16, right: 16, bottom: 48, left: 60 };
  const innerW = chartW - pad.left - pad.right;
  const innerH = chartH - pad.top - pad.bottom;
  const maxVal = Math.max(
    ...data.months.map(m => Math.max(m.income, m.expenses)),
    1
  );
  const raw = maxVal * 1.05;
  const mag = Math.pow(10, Math.floor(Math.log10(raw || 1)));
  const steps = [1, 1.2, 1.5, 2, 2.5, 3, 4, 5, 6, 8, 10];
  let niceMax = mag * 10;
  for (const s of steps) {
    if (mag * s >= raw) { niceMax = mag * s; break; }
  }
  if (niceMax === 0) niceMax = 1000;
  const ticks = [0, niceMax * 0.25, niceMax * 0.5, niceMax * 0.75, niceMax];

  const yPos = v => pad.top + innerH - (v / niceMax) * innerH;
  const slotW = data.months.length ? innerW / data.months.length : 0;
  const xCenter = mi => pad.left + (mi + 0.5) * slotW;
  const barW = Math.min(18, slotW * 0.35);

  const fmtAxis = t => t >= 1000 ? `$${(t / 1000).toFixed(t % 1000 === 0 ? 0 : 1)}k` : `$${t}`;

  const netPoints = data.months.map((m, i) => ({ x: xCenter(i), y: yPos(Math.abs(m.net)) }));

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 24 }}>
      {/* Header */}
      <div>
        <div style={{ fontFamily: 'var(--font-headline)', fontSize: 24, fontWeight: 700, marginBottom: 4 }}>Cash Flow</div>
        <div style={{ fontSize: 13, color: 'var(--color-text-tertiary)' }}>
          Income vs. expenses across the last {monthCount} months
        </div>
      </div>

      {/* Stat Cards */}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: 16 }}>
        <StatCard label="Total Income" value={fmt(data.totalIncome)} color={incomeColor} icon="trending_up" />
        <StatCard label="Total Expenses" value={fmt(data.totalExpenses)} color={expenseColor} icon="trending_down" />
        <StatCard label="Net Cash Flow" value={`${data.net >= 0 ? '+' : ''}${fmt(data.net)}`} color={netColor} icon="payments" />
        <StatCard
          label="Savings Rate"
          value={`${Math.round(data.savingsRate * 100)}%`}
          color={data.savingsRate >= 0.2 ? incomeColor : data.savingsRate >= 0 ? '#e8a317' : expenseColor}
          icon="savings"
        />
      </div>

      {/* Averages */}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(2, 1fr)', gap: 16 }}>
        <StatCard label="Avg Monthly Income" value={fmt(data.avgIncome)} color={incomeColor} icon="calendar_month" />
        <StatCard label="Avg Monthly Expenses" value={fmt(data.avgExpenses)} color={expenseColor} icon="calendar_month" />
      </div>

      {/* Chart */}
      <div style={{ background: 'var(--color-surface)', border: 'var(--border-ghost)', borderRadius: 'var(--radius-xl)', padding: 20, boxShadow: 'var(--shadow-xs)' }}>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 16 }}>
          <div style={{ fontSize: 10, fontWeight: 700, letterSpacing: '0.12em', textTransform: 'uppercase', color: 'var(--color-text-tertiary)' }}>
            Income vs Expenses Over Time
          </div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 2, background: 'var(--color-surface-alt)', borderRadius: 8, padding: 2 }}>
            <button
              onClick={() => setMonthCount(c => Math.max(1, c - 1))}
              disabled={monthCount <= 1}
              style={{ width: 24, height: 24, border: 'none', background: 'transparent', cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center' }}
            >
              <span className="material-symbols-outlined" style={{ fontSize: 16 }}>remove</span>
            </button>
            <span style={{ fontSize: 11, fontWeight: 700, minWidth: 32, textAlign: 'center' }}>{monthCount}mo</span>
            <button
              onClick={() => setMonthCount(c => Math.min(36, c + 1))}
              style={{ width: 24, height: 24, border: 'none', background: 'transparent', cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center' }}
            >
              <span className="material-symbols-outlined" style={{ fontSize: 16 }}>add</span>
            </button>
          </div>
        </div>

        <svg width="100%" height={chartH} viewBox={`0 0 ${chartW} ${chartH}`} preserveAspectRatio="xMidYMid meet" style={{ display: 'block' }}>
          {/* Gridlines */}
          {ticks.map((t, i) => {
            const y = yPos(t);
            return (
              <g key={i}>
                {t > 0 && (
                  <line x1={pad.left} y1={y} x2={chartW - pad.right} y2={y}
                    stroke="var(--color-text-tertiary)" strokeOpacity={0.25} strokeWidth={1} />
                )}
                <text x={pad.left - 8} y={y + 4} textAnchor="end" fontSize={11} fill="var(--color-text-tertiary)" fontFamily="var(--font-headline)">
                  {fmtAxis(t)}
                </text>
              </g>
            );
          })}

          {/* Baseline */}
          <line x1={pad.left} y1={yPos(0)} x2={chartW - pad.right} y2={yPos(0)}
            stroke="var(--color-text-tertiary)" strokeOpacity={0.3} strokeWidth={1} />

          {/* Income & Expense bars */}
          {data.months.map((m, mi) => {
            const cx = xCenter(mi);
            const incH = (m.income / niceMax) * innerH;
            const expH = (m.expenses / niceMax) * innerH;
            return (
              <g key={mi}>
                <rect x={cx - barW - 2} y={yPos(m.income)} width={barW} height={incH}
                  rx={3} fill={incomeColor} opacity={0.85}>
                  <title>{m.label} {m.year} Income: {fmt(m.income)}</title>
                </rect>
                <rect x={cx + 2} y={yPos(m.expenses)} width={barW} height={expH}
                  rx={3} fill={expenseColor} opacity={0.85}>
                  <title>{m.label} {m.year} Expenses: {fmt(m.expenses)}</title>
                </rect>
              </g>
            );
          })}

          {/* Net cash flow line */}
          {data.months.length >= 2 && (
            <>
              <path d={smoothPath(netPoints)} fill="none" stroke="var(--color-text-primary)" strokeWidth={2}
                strokeLinecap="round" strokeLinejoin="round" strokeDasharray="5 3" opacity={0.4} />
              {data.months.map((m, i) => (
                <circle key={i} cx={netPoints[i].x} cy={netPoints[i].y} r={3.5}
                  fill="#fff" stroke="var(--color-text-primary)" strokeWidth={1.5}>
                  <title>{m.label} {m.year} Net: {m.net >= 0 ? '+' : ''}{fmt(m.net)}</title>
                </circle>
              ))}
            </>
          )}

          {/* X-axis labels */}
          {data.months.map((m, mi) => {
            const showYear = mi === 0 || m.year !== data.months[mi - 1].year;
            return (
              <g key={mi}>
                <text x={xCenter(mi)} y={chartH - (showYear ? 22 : 12)} textAnchor="middle"
                  fontSize={11} fill="var(--color-text-secondary)" fontFamily="var(--font-headline)">
                  {m.label}
                </text>
                {showYear && (
                  <text x={xCenter(mi)} y={chartH - 6} textAnchor="middle" fontSize={10} fontWeight={700} fill="var(--color-text-tertiary)">
                    {m.year}
                  </text>
                )}
              </g>
            );
          })}
        </svg>

        {/* Legend */}
        <div style={{ display: 'flex', gap: 16, marginTop: 12, fontSize: 12 }}>
          <LegendItem color={incomeColor} label="Income" />
          <LegendItem color={expenseColor} label="Expenses" />
          <LegendItem color="var(--color-text-primary)" label="Net (dashed)" dashed />
        </div>
      </div>

      {/* Monthly breakdown table */}
      <div style={{ background: 'var(--color-surface)', border: 'var(--border-ghost)', borderRadius: 'var(--radius-xl)', padding: 20, boxShadow: 'var(--shadow-xs)' }}>
        <div style={{ fontSize: 10, fontWeight: 700, letterSpacing: '0.12em', textTransform: 'uppercase', color: 'var(--color-text-tertiary)', marginBottom: 12 }}>
          Monthly Breakdown
        </div>
        <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
          <thead>
            <tr style={{ borderBottom: '1px solid var(--border-ghost)' }}>
              <th style={{ textAlign: 'left', padding: '8px 12px', fontWeight: 600, color: 'var(--color-text-tertiary)' }}>Month</th>
              <th style={{ textAlign: 'right', padding: '8px 12px', fontWeight: 600, color: 'var(--color-text-tertiary)' }}>Income</th>
              <th style={{ textAlign: 'right', padding: '8px 12px', fontWeight: 600, color: 'var(--color-text-tertiary)' }}>Expenses</th>
              <th style={{ textAlign: 'right', padding: '8px 12px', fontWeight: 600, color: 'var(--color-text-tertiary)' }}>Net</th>
              <th style={{ textAlign: 'right', padding: '8px 12px', fontWeight: 600, color: 'var(--color-text-tertiary)' }}>Savings %</th>
            </tr>
          </thead>
          <tbody>
            {[...data.months].reverse().map(m => {
              const savings = m.income > 0 ? (m.income - m.expenses) / m.income : 0;
              return (
                <tr key={m.key} style={{ borderBottom: '1px solid var(--border-ghost)' }}>
                  <td style={{ padding: '10px 12px', fontWeight: 600 }}>{m.label} {m.year}</td>
                  <td style={{ padding: '10px 12px', textAlign: 'right', color: incomeColor, fontFamily: 'var(--font-headline)', fontWeight: 600 }}>
                    {m.income > 0 ? fmt(m.income) : '—'}
                  </td>
                  <td style={{ padding: '10px 12px', textAlign: 'right', color: expenseColor, fontFamily: 'var(--font-headline)', fontWeight: 600 }}>
                    {m.expenses > 0 ? fmt(m.expenses) : '—'}
                  </td>
                  <td style={{ padding: '10px 12px', textAlign: 'right', color: m.net >= 0 ? incomeColor : expenseColor, fontFamily: 'var(--font-headline)', fontWeight: 700 }}>
                    {m.net >= 0 ? '+' : ''}{fmt(m.net)}
                  </td>
                  <td style={{ padding: '10px 12px', textAlign: 'right', fontWeight: 600, color: m.income === 0 ? 'var(--color-text-tertiary)' : savings >= 0.2 ? incomeColor : savings >= 0 ? '#e8a317' : expenseColor }}>
                    {m.income > 0 ? `${Math.round(savings * 100)}%` : '—'}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function StatCard({ label, value, color, icon }) {
  return (
    <div style={{ background: 'var(--color-surface)', border: 'var(--border-ghost)', borderRadius: 'var(--radius-xl)', padding: 20, boxShadow: 'var(--shadow-xs)' }}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 12 }}>
        <div style={{ fontSize: 11.5, fontWeight: 600, color: 'var(--color-text-tertiary)', textTransform: 'uppercase', letterSpacing: '0.05em' }}>{label}</div>
        <div style={{ width: 28, height: 28, borderRadius: 8, background: `${color}1a`, display: 'flex', alignItems: 'center', justifyContent: 'center', color }}>
          <span className="material-symbols-outlined" style={{ fontSize: 16 }}>{icon}</span>
        </div>
      </div>
      <div style={{ fontFamily: 'var(--font-headline)', fontSize: 24, fontWeight: 700, color }}>{value}</div>
    </div>
  );
}

function LegendItem({ color, label, dashed }) {
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 6, color: 'var(--color-text-secondary)' }}>
      <span style={{
        display: 'inline-block',
        width: 14,
        height: 3,
        background: dashed ? 'transparent' : color,
        borderTop: dashed ? `2px dashed ${color}` : 'none',
        borderRadius: 2,
      }} />
      {label}
    </div>
  );
}
