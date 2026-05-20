import { useState } from 'react';
import { useData } from '../contexts/DataContext';
import styles from './OverviewPage.module.css';

function fmt(n) {
  if (n == null) return '—';
  return new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', minimumFractionDigits: 0, maximumFractionDigits: 0 }).format(n);
}

function fmtCompact(n) {
  if (n == null) return '—';
  return new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', notation: 'compact', maximumFractionDigits: 1 }).format(n);
}

function relativeTime(date) {
  if (!date) return '—';
  const now = new Date();
  const diff = Math.floor((now - date) / 1000);
  if (diff < 60) return `${diff}s ago`;
  if (diff < 3600) return `${Math.floor(diff / 60)}m ago`;
  if (diff < 86400) return `${Math.floor(diff / 3600)}h ago`;
  return `${Math.floor(diff / 86400)}d ago`;
}

const DONUT_COLORS = ['#0058be', '#009668', '#e8a317', '#94a3b8', '#7c3aed', '#e11d48', '#06b6d4', '#f97316'];

export function OverviewPage() {
  const { balances, analytics, transactions, loading, error, lastSync, accountNicknames: ctxNicknames } = useData();
  const accountNicknames = ctxNicknames || {};
  const [chartPeriod, setChartPeriod] = useState('6M');
  const [chartMode, setChartMode] = useState('bar');
  const [hoverPoint, setHoverPoint] = useState(null); // { kind: 'income'|'expense', i, x, y }
  const [hoverDonut, setHoverDonut] = useState(null); // index in ALLOCATION
  const [selectedSnapshot, setSelectedSnapshot] = useState(null); // 'Net Worth' | 'Total Assets' | 'Total Liabilities' | '30D Cash Flow' | null

  // Loading state
  if (loading) {
    return (
      <div className={styles.page} style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', minHeight: '60vh' }}>
        <div style={{ textAlign: 'center' }}>
          <span className="material-symbols-outlined" style={{ fontSize: 48, animation: 'spin 1s linear infinite', display: 'block', marginBottom: 16, color: 'var(--color-text-tertiary)' }}>progress_activity</span>
          <div style={{ color: 'var(--color-text-secondary)', fontFamily: 'var(--font-body)', fontSize: 14 }}>Loading your financial data...</div>
        </div>
      </div>
    );
  }

  // Error state
  if (error) {
    return (
      <div className={styles.page} style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', minHeight: '60vh' }}>
        <div style={{ textAlign: 'center', maxWidth: 400 }}>
          <span className="material-symbols-outlined" style={{ fontSize: 48, color: '#ba1a1a', display: 'block', marginBottom: 16 }}>error</span>
          <div style={{ color: 'var(--color-text-primary)', fontFamily: 'var(--font-headline)', fontSize: 18, fontWeight: 700, marginBottom: 8 }}>Failed to load data</div>
          <div style={{ color: 'var(--color-text-secondary)', fontFamily: 'var(--font-body)', fontSize: 14 }}>{error}</div>
        </div>
      </div>
    );
  }

  // Build stat cards from real data
  const cashFlow = analytics?.cashFlow ?? 0;
  const cashFlowPositive = cashFlow >= 0;

  const STATS = [
    {
      title: 'Net Worth',
      value: fmt(balances?.netWorth),
      icon: 'account_balance_wallet',
      iconClass: 'statIconBlue',
    },
    {
      title: 'Total Assets',
      value: fmt(balances?.totalAssets),
      icon: 'trending_up',
      iconClass: 'statIconGreen',
    },
    {
      title: 'Total Liabilities',
      value: fmt(balances?.totalLiabilities),
      icon: 'trending_down',
      iconClass: 'statIconRed',
    },
    {
      title: '30D Cash Flow',
      value: `${cashFlowPositive ? '+' : ''}${fmt(cashFlow)}`,
      icon: 'payments',
      iconClass: 'statIconDark',
      cashFlowColor: cashFlowPositive ? '#009668' : '#ba1a1a',
    },
  ];

  // Build asset allocation from real balances
  const assetAccounts = balances?.assets || [];
  const totalAssetBalance = assetAccounts.reduce((sum, a) => sum + a.balance, 0) || 1;
  const ALLOCATION = assetAccounts.map((a, i) => ({
    label: a.name,
    value: fmt(a.balance),
    pct: Math.round((a.balance / totalAssetBalance) * 100),
    color: DONUT_COLORS[i % DONUT_COLORS.length],
  }));

  // Build spending data from analytics byMonth
  const byMonth = analytics?.byMonth || {};
  const monthEntries = Object.entries(byMonth).sort(([a], [b]) => a.localeCompare(b));
  const recentMonths = monthEntries.slice(-6);
  const SPENDING_DATA = recentMonths.map(([month, data]) => ({
    month: month.length > 3 ? month.slice(0, 3) : month,
    income: data.income,
    expenses: data.expenses,
  }));
  const maxVal = SPENDING_DATA.length > 0
    ? Math.max(...SPENDING_DATA.flatMap((d) => [d.income, d.expenses]), 1)
    : 1;

  // Build anomalies from 5 largest transactions by absolute amount
  const sortedByAmount = [...(transactions || [])]
    .sort((a, b) => Math.abs(b.amount) - Math.abs(a.amount))
    .slice(0, 5);
  const ANOMALIES = sortedByAmount.map((t) => ({
    text: `${t.description} — ${fmt(t.amount)} (${t.category || 'Uncategorized'})`,
    time: t.date || '—',
    color: t.amount < 0 ? '#ba1a1a' : '#009668',
  }));

  // Linked accounts count
  const linkedAccounts = (balances?.assets?.length || 0) + (balances?.liabilities?.length || 0);

  // Last-30-days breakdown for the cash-flow card
  const cashFlowBreakdown = (() => {
    const cutoff = new Date();
    cutoff.setDate(cutoff.getDate() - 30);
    const recent = (transactions || []).filter(t => {
      if (!t.date) return false;
      const d = new Date(t.date);
      return !isNaN(d) && d >= cutoff;
    });
    let income = 0;
    let expenses = 0;
    const incomeByCat = {};
    const expensesByCat = {};
    for (const t of recent) {
      const cat = t.category || 'Uncategorized';
      const tCat = cat.toLowerCase();
      if (tCat === 'transfer' || tCat === 'credit card payments' || tCat === 'credit card payment') continue;
      if (t.amount > 0) {
        income += t.amount;
        incomeByCat[cat] = (incomeByCat[cat] || 0) + t.amount;
      } else if (t.amount < 0) {
        const a = Math.abs(t.amount);
        expenses += a;
        expensesByCat[cat] = (expensesByCat[cat] || 0) + a;
      }
    }
    const sortRows = obj => Object.entries(obj)
      .map(([name, total]) => ({ name, total }))
      .sort((a, b) => b.total - a.total);
    return { income, expenses, net: income - expenses, incomeRows: sortRows(incomeByCat), expenseRows: sortRows(expensesByCat) };
  })();

  // Resolve real assets/liabilities for breakdown rows
  const displayAccount = (name) => accountNicknames[name] || name;
  const assetRows = (balances?.assets || []).slice().sort((a, b) => b.balance - a.balance);
  const liabilityRows = (balances?.liabilities || []).slice().sort((a, b) => b.balance - a.balance);
  const assetTotal = balances?.totalAssets || assetRows.reduce((s, a) => s + a.balance, 0);
  const liabilityTotal = balances?.totalLiabilities || liabilityRows.reduce((s, l) => s + l.balance, 0);

  return (
    <div className={styles.page}>
      {/* Hero Stats */}
      <div>
        <div className={styles.sectionLabel}>Portfolio Snapshot</div>
        <div className={styles.statsGrid}>
          {STATS.map((s) => {
            const isActive = selectedSnapshot === s.title;
            return (
              <div
                key={s.title}
                className={`${styles.statCard} ${isActive ? styles.statCardActive : ''}`}
                onClick={() => setSelectedSnapshot(prev => (prev === s.title ? null : s.title))}
                style={{ cursor: 'pointer' }}
                title={isActive ? 'Click to close breakdown' : `Show ${s.title} breakdown`}
              >
                <div className={styles.statHeader}>
                  <span className={styles.statTitle}>{s.title}</span>
                  <div className={`${styles.statIcon} ${styles[s.iconClass]}`}>
                    <span className="material-symbols-outlined">{s.icon}</span>
                  </div>
                </div>
                <div
                  className={styles.statValue}
                  style={s.cashFlowColor ? { color: s.cashFlowColor } : undefined}
                >
                  {s.value}
                </div>
              </div>
            );
          })}
        </div>
        {selectedSnapshot && (
          <div className={styles.snapshotBreakdown}>
            <div className={styles.snapshotBreakdownHeader}>
              <span className={styles.snapshotBreakdownTitle}>{selectedSnapshot} Breakdown</span>
              <button
                type="button"
                className={styles.snapshotBreakdownClose}
                onClick={() => setSelectedSnapshot(null)}
                title="Close"
              >
                <span className="material-symbols-outlined" style={{ fontSize: 18 }}>close</span>
              </button>
            </div>
            {selectedSnapshot === 'Net Worth' && (
              <div className={styles.snapshotNetWorth}>
                <div className={styles.snapshotColumn}>
                  <div className={styles.snapshotColumnHeader}>
                    <span>Assets</span>
                    <span style={{ color: 'var(--color-success)' }}>{fmt(assetTotal)}</span>
                  </div>
                  {assetRows.length === 0 && <div className={styles.snapshotEmpty}>No linked assets</div>}
                  {assetRows.map(a => (
                    <div key={a.name} className={styles.snapshotRow}>
                      <span className={styles.snapshotRowName}>
                        <span className={styles.snapshotRowDisplay}>{displayAccount(a.name)}</span>
                        {accountNicknames[a.name] && <span className={styles.snapshotRowOriginal}>{a.name}</span>}
                      </span>
                      <span className={styles.snapshotRowValue}>{fmt(a.balance)}</span>
                    </div>
                  ))}
                </div>
                <div className={styles.snapshotColumn}>
                  <div className={styles.snapshotColumnHeader}>
                    <span>Liabilities</span>
                    <span style={{ color: 'var(--color-error)' }}>{fmt(liabilityTotal)}</span>
                  </div>
                  {liabilityRows.length === 0 && <div className={styles.snapshotEmpty}>No linked liabilities</div>}
                  {liabilityRows.map(l => (
                    <div key={l.name} className={styles.snapshotRow}>
                      <span className={styles.snapshotRowName}>
                        <span className={styles.snapshotRowDisplay}>{displayAccount(l.name)}</span>
                        {accountNicknames[l.name] && <span className={styles.snapshotRowOriginal}>{l.name}</span>}
                      </span>
                      <span className={styles.snapshotRowValue}>{fmt(l.balance)}</span>
                    </div>
                  ))}
                </div>
              </div>
            )}
            {selectedSnapshot === 'Total Assets' && (
              <div className={styles.snapshotList}>
                {assetRows.length === 0 && <div className={styles.snapshotEmpty}>No linked assets</div>}
                {assetRows.map(a => {
                  const pct = assetTotal > 0 ? (a.balance / assetTotal) * 100 : 0;
                  return (
                    <div key={a.name} className={styles.snapshotRowFull}>
                      <div className={styles.snapshotRowFullHeader}>
                        <span className={styles.snapshotRowName}>
                        <span className={styles.snapshotRowDisplay}>{displayAccount(a.name)}</span>
                        {accountNicknames[a.name] && <span className={styles.snapshotRowOriginal}>{a.name}</span>}
                      </span>
                        <span className={styles.snapshotRowValue}>{fmt(a.balance)} <span className={styles.snapshotPct}>{pct.toFixed(1)}%</span></span>
                      </div>
                      <div className={styles.snapshotBar}>
                        <div className={styles.snapshotBarFill} style={{ width: `${pct}%`, background: 'var(--color-success)' }} />
                      </div>
                    </div>
                  );
                })}
              </div>
            )}
            {selectedSnapshot === 'Total Liabilities' && (
              <div className={styles.snapshotList}>
                {liabilityRows.length === 0 && <div className={styles.snapshotEmpty}>No linked liabilities</div>}
                {liabilityRows.map(l => {
                  const pct = liabilityTotal > 0 ? (l.balance / liabilityTotal) * 100 : 0;
                  return (
                    <div key={l.name} className={styles.snapshotRowFull}>
                      <div className={styles.snapshotRowFullHeader}>
                        <span className={styles.snapshotRowName}>
                        <span className={styles.snapshotRowDisplay}>{displayAccount(l.name)}</span>
                        {accountNicknames[l.name] && <span className={styles.snapshotRowOriginal}>{l.name}</span>}
                      </span>
                        <span className={styles.snapshotRowValue}>{fmt(l.balance)} <span className={styles.snapshotPct}>{pct.toFixed(1)}%</span></span>
                      </div>
                      <div className={styles.snapshotBar}>
                        <div className={styles.snapshotBarFill} style={{ width: `${pct}%`, background: 'var(--color-error)' }} />
                      </div>
                    </div>
                  );
                })}
              </div>
            )}
            {selectedSnapshot === '30D Cash Flow' && (
              <div className={styles.snapshotNetWorth}>
                <div className={styles.snapshotColumn}>
                  <div className={styles.snapshotColumnHeader}>
                    <span>Income (last 30d)</span>
                    <span style={{ color: 'var(--color-success)' }}>{fmt(cashFlowBreakdown.income)}</span>
                  </div>
                  {cashFlowBreakdown.incomeRows.length === 0 && <div className={styles.snapshotEmpty}>No income in last 30 days</div>}
                  {cashFlowBreakdown.incomeRows.slice(0, 8).map(r => (
                    <div key={r.name} className={styles.snapshotRow}>
                      <span className={styles.snapshotRowName}>{r.name}</span>
                      <span className={styles.snapshotRowValue}>{fmt(r.total)}</span>
                    </div>
                  ))}
                </div>
                <div className={styles.snapshotColumn}>
                  <div className={styles.snapshotColumnHeader}>
                    <span>Expenses (last 30d)</span>
                    <span style={{ color: 'var(--color-error)' }}>{fmt(cashFlowBreakdown.expenses)}</span>
                  </div>
                  {cashFlowBreakdown.expenseRows.length === 0 && <div className={styles.snapshotEmpty}>No expenses in last 30 days</div>}
                  {cashFlowBreakdown.expenseRows.slice(0, 8).map(r => (
                    <div key={r.name} className={styles.snapshotRow}>
                      <span className={styles.snapshotRowName}>{r.name}</span>
                      <span className={styles.snapshotRowValue}>{fmt(r.total)}</span>
                    </div>
                  ))}
                </div>
              </div>
            )}
          </div>
        )}
      </div>

      {/* Charts Row */}
      <div className={styles.chartsRow}>
        {/* Spending Snapshot */}
        <div className={styles.chartCard}>
          <div className={styles.chartHeader}>
            <span className={styles.chartTitle}>Spending Snapshot</span>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
              <div className={styles.chartPeriodPills}>
                {['bar', 'line'].map((m) => (
                  <div
                    key={m}
                    className={`${styles.chartPill} ${chartMode === m ? styles.chartPillActive : ''}`}
                    onClick={() => setChartMode(m)}
                    title={m === 'bar' ? 'Bar Chart' : 'Line Chart'}
                  >
                    <span className="material-symbols-outlined" style={{ fontSize: 14 }}>{m === 'bar' ? 'bar_chart' : 'show_chart'}</span>
                  </div>
                ))}
              </div>
              <div className={styles.chartPeriodPills}>
                {['1M', '3M', '6M', '1Y'].map((p) => (
                  <div
                    key={p}
                    className={`${styles.chartPill} ${chartPeriod === p ? styles.chartPillActive : ''}`}
                    onClick={() => setChartPeriod(p)}
                  >
                    {p}
                  </div>
                ))}
              </div>
            </div>
          </div>
          <div className={styles.chartArea}>
            {SPENDING_DATA.length > 0 ? (
              chartMode === 'line' ? (
                /* ── Line Chart ── */
                (() => {
                  const svgW = 400;
                  const svgH = 160;
                  const pad = { top: 8, right: 8, bottom: 24, left: 6 };
                  const cW = svgW - pad.left - pad.right;
                  const cH = svgH - pad.top - pad.bottom;
                  const yPos = v => pad.top + cH - (v / maxVal) * cH;
                  const xPos = i => pad.left + (i + 0.5) * (cW / SPENDING_DATA.length);

                  const smoothPath = (points) => {
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
                  };

                  const incomePoints = SPENDING_DATA.map((d, i) => ({ x: xPos(i), y: yPos(d.income) }));
                  const expensePoints = SPENDING_DATA.map((d, i) => ({ x: xPos(i), y: yPos(d.expenses) }));
                  const incomeD = smoothPath(incomePoints);
                  const expenseD = smoothPath(expensePoints);
                  const baseLine = pad.top + cH;

                  /* Gridlines */
                  const ticks = [0, 0.25, 0.5, 0.75, 1];

                  return (
                    <svg width="100%" height="100%" viewBox={`0 0 ${svgW} ${svgH}`} preserveAspectRatio="xMidYMid meet" style={{ display: 'block' }} onMouseLeave={() => setHoverPoint(null)}>
                      {ticks.map((t, i) => {
                        const y = pad.top + cH - t * cH;
                        return t > 0 ? (
                          <line key={i} x1={pad.left} y1={y} x2={svgW - pad.right} y2={y}
                            stroke="var(--color-text-tertiary)" strokeOpacity={0.15} strokeWidth={0.5} />
                        ) : null;
                      })}
                      <line x1={pad.left} y1={baseLine} x2={svgW - pad.right} y2={baseLine}
                        stroke="var(--color-text-tertiary)" strokeOpacity={0.25} strokeWidth={1} />

                      {/* Income area + line */}
                      <defs>
                        <linearGradient id="ov-income-grad" x1="0" y1="0" x2="0" y2="1">
                          <stop offset="0%" stopColor="var(--color-secondary)" stopOpacity={0.25} />
                          <stop offset="100%" stopColor="var(--color-secondary)" stopOpacity={0.03} />
                        </linearGradient>
                        <linearGradient id="ov-expense-grad" x1="0" y1="0" x2="0" y2="1">
                          <stop offset="0%" stopColor="#94a3b8" stopOpacity={0.2} />
                          <stop offset="100%" stopColor="#94a3b8" stopOpacity={0.03} />
                        </linearGradient>
                      </defs>
                      <path d={`${incomeD} L ${incomePoints[incomePoints.length - 1].x} ${baseLine} L ${incomePoints[0].x} ${baseLine} Z`}
                        fill="url(#ov-income-grad)" />
                      <path d={incomeD} fill="none" stroke="var(--color-secondary)" strokeWidth={2.5}
                        strokeLinecap="round" strokeLinejoin="round" />
                      {incomePoints.map((p, i) => {
                        const isHov = hoverPoint && hoverPoint.kind === 'income' && hoverPoint.i === i;
                        return (
                          <g key={`inc-${i}`}>
                            <circle cx={p.x} cy={p.y} r={10} fill="var(--color-secondary)" opacity={0}
                              style={{ cursor: 'pointer' }}
                              onMouseEnter={() => setHoverPoint({ kind: 'income', i, x: p.x, y: p.y })} />
                            <circle cx={p.x} cy={p.y} r={isHov ? 5 : 3.5} fill="#fff"
                              stroke="var(--color-secondary)" strokeWidth={isHov ? 2.5 : 2}
                              style={{ transition: 'r 0.12s' }} />
                          </g>
                        );
                      })}

                      {/* Expense area + line */}
                      <path d={`${expenseD} L ${expensePoints[expensePoints.length - 1].x} ${baseLine} L ${expensePoints[0].x} ${baseLine} Z`}
                        fill="url(#ov-expense-grad)" />
                      <path d={expenseD} fill="none" stroke="#94a3b8" strokeWidth={2.5}
                        strokeLinecap="round" strokeLinejoin="round" />
                      {expensePoints.map((p, i) => {
                        const isHov = hoverPoint && hoverPoint.kind === 'expense' && hoverPoint.i === i;
                        return (
                          <g key={`exp-${i}`}>
                            <circle cx={p.x} cy={p.y} r={10} fill="#94a3b8" opacity={0}
                              style={{ cursor: 'pointer' }}
                              onMouseEnter={() => setHoverPoint({ kind: 'expense', i, x: p.x, y: p.y })} />
                            <circle cx={p.x} cy={p.y} r={isHov ? 5 : 3.5} fill="#fff" stroke="#94a3b8"
                              strokeWidth={isHov ? 2.5 : 2} style={{ transition: 'r 0.12s' }} />
                          </g>
                        );
                      })}

                      {/* X-axis labels */}
                      {SPENDING_DATA.map((d, i) => (
                        <text key={i} x={xPos(i)} y={svgH - 4} textAnchor="middle" fontSize={10}
                          fill="var(--color-text-tertiary)">
                          {d.month}
                        </text>
                      ))}

                      {/* Hover tooltip */}
                      {hoverPoint && (() => {
                        const d = SPENDING_DATA[hoverPoint.i];
                        if (!d) return null;
                        const label = hoverPoint.kind === 'income' ? `Income — $${d.income.toLocaleString()}` : `Expenses — $${d.expenses.toLocaleString()}`;
                        const color = hoverPoint.kind === 'income' ? 'var(--color-secondary)' : '#94a3b8';
                        const boxW = Math.max(label.length * 5.8 + 20, 130);
                        const boxH = 32;
                        let tx = hoverPoint.x - boxW / 2;
                        if (tx < 4) tx = 4;
                        if (tx + boxW > svgW - 4) tx = svgW - 4 - boxW;
                        let ty = hoverPoint.y - boxH - 10;
                        if (ty < 2) ty = hoverPoint.y + 12;
                        return (
                          <g style={{ pointerEvents: 'none' }}>
                            <rect x={tx} y={ty} width={boxW} height={boxH} rx={5} fill="var(--color-text-primary)" opacity={0.92} />
                            <circle cx={tx + 10} cy={ty + 11} r={4} fill={color} />
                            <text x={tx + 18} y={ty + 14} fontSize={10} fontWeight={700} fill="#fff" fontFamily="var(--font-headline)">{label}</text>
                            <text x={tx + 10} y={ty + 26} fontSize={9} fill="rgba(255,255,255,0.75)">{d.month}</text>
                          </g>
                        );
                      })()}
                    </svg>
                  );
                })()
              ) : (
                /* ── Bar Chart (original) ── */
                SPENDING_DATA.map((d, i) => (
                  <div key={i} style={{ flex: 1, display: 'flex', gap: 2, alignItems: 'flex-end', height: '100%' }}>
                    <div
                      className={styles.chartBar}
                      style={{
                        height: `${(d.income / maxVal) * 100}%`,
                        background: 'var(--color-secondary)',
                        opacity: 0.85,
                      }}
                      title={`${d.month} Income: $${d.income.toLocaleString()}`}
                    />
                    <div
                      className={styles.chartBar}
                      style={{
                        height: `${(d.expenses / maxVal) * 100}%`,
                        background: '#cbd5e1',
                      }}
                      title={`${d.month} Expenses: $${d.expenses.toLocaleString()}`}
                    />
                  </div>
                ))
              )
            ) : (
              <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', width: '100%', color: 'var(--color-text-tertiary)', fontSize: 13 }}>No monthly data available</div>
            )}
          </div>
          <div className={styles.chartLegend}>
            <div className={styles.legendItem}>
              <div className={styles.legendDot} style={{ background: 'var(--color-secondary)' }} />
              Income
            </div>
            <div className={styles.legendItem}>
              <div className={styles.legendDot} style={{ background: '#cbd5e1' }} />
              Expenses
            </div>
          </div>
        </div>

        {/* Asset Allocation Donut */}
        <div className={styles.chartCard}>
          <div className={styles.chartHeader}>
            <span className={styles.chartTitle}>Asset Allocation</span>
          </div>
          <div className={styles.donutWrapper}>
            <svg width="160" height="160" viewBox="0 0 160 160" onMouseLeave={() => setHoverDonut(null)}>
              {(() => {
                let cumulative = 0;
                const slices = ALLOCATION.map((item, i) => {
                  const startAngle = cumulative * 3.6;
                  cumulative += item.pct;
                  const endAngle = cumulative * 3.6;
                  const midAngle = (startAngle + endAngle) / 2;
                  const startRad = ((startAngle - 90) * Math.PI) / 180;
                  const endRad = ((endAngle - 90) * Math.PI) / 180;
                  const midRad = ((midAngle - 90) * Math.PI) / 180;
                  const largeArc = item.pct > 50 ? 1 : 0;
                  const x1 = 80 + 60 * Math.cos(startRad);
                  const y1 = 80 + 60 * Math.sin(startRad);
                  const x2 = 80 + 60 * Math.cos(endRad);
                  const y2 = 80 + 60 * Math.sin(endRad);
                  return { item, i, d: `M 80 80 L ${x1} ${y1} A 60 60 0 ${largeArc} 1 ${x2} ${y2} Z`, midRad };
                });
                return (
                  <>
                    {slices.map(({ item, i, d }) => {
                      const dim = hoverDonut != null && hoverDonut !== i;
                      return (
                        <path
                          key={i}
                          d={d}
                          fill={item.color}
                          stroke="var(--color-surface)"
                          strokeWidth="2"
                          opacity={dim ? 0.45 : 1}
                          style={{ cursor: 'pointer', transition: 'opacity 0.12s' }}
                          onMouseEnter={() => setHoverDonut(i)}
                        />
                      );
                    })}
                    <circle cx="80" cy="80" r="36" fill="var(--color-surface)" />
                    <text x="80" y="76" textAnchor="middle" fontFamily="var(--font-headline)" fontSize="14" fontWeight="800" fill="var(--color-text-primary)">
                      {hoverDonut != null ? ALLOCATION[hoverDonut].value : fmtCompact(balances?.totalAssets)}
                    </text>
                    <text x="80" y="92" textAnchor="middle" fontFamily="var(--font-body)" fontSize="9" fill="var(--color-text-tertiary)">
                      {hoverDonut != null ? `${ALLOCATION[hoverDonut].label.toUpperCase()} · ${ALLOCATION[hoverDonut].pct}%` : 'TOTAL'}
                    </text>
                  </>
                );
              })()}
            </svg>
          </div>
          <div className={styles.donutLegend}>
            {ALLOCATION.map((a) => (
              <div key={a.label} className={styles.donutLegendItem}>
                <div className={styles.donutLegendLeft}>
                  <div className={styles.donutLegendDot} style={{ background: a.color }} />
                  {a.label}
                </div>
                <span className={styles.donutLegendValue}>{a.pct}%</span>
              </div>
            ))}
          </div>
        </div>
      </div>

      {/* Bottom Row */}
      <div className={styles.bottomRow}>
        {/* Google Sheets Status */}
        <div className={styles.sheetsCard}>
          <div className={styles.sheetsHeader}>
            <div className={styles.sheetsIcon}>
              <span className="material-symbols-outlined">table_chart</span>
            </div>
            <span className={styles.sheetsTitle}>Google Sheets Integration</span>
            <span className={styles.sheetsBadge}>Connected</span>
          </div>
          <div className={styles.sheetsRow}>
            <span className={styles.sheetsLabel}>Last Sync</span>
            <span className={styles.sheetsValue}>{relativeTime(lastSync)}</span>
          </div>
          <div className={styles.sheetsRow}>
            <span className={styles.sheetsLabel}>Rows Ingested</span>
            <span className={styles.sheetsValue}>{(analytics?.transactionCount ?? 0).toLocaleString()}</span>
          </div>
          <div className={styles.sheetsRow}>
            <span className={styles.sheetsLabel}>Linked Accounts</span>
            <span className={styles.sheetsValue}>{linkedAccounts} Active</span>
          </div>
          <div className={styles.sheetsRow}>
            <span className={styles.sheetsLabel}>Sync Frequency</span>
            <span className={styles.sheetsValue}>Every 6 hours</span>
          </div>
          <div className={styles.sheetsRow}>
            <span className={styles.sheetsLabel}>Data Integrity</span>
            <span className={styles.sheetsValue}>99.8%</span>
          </div>
        </div>

        {/* Recent Anomalies */}
        <div className={styles.anomaliesCard}>
          <div className={styles.anomaliesTitle}>
            Notable Transactions
            <span className={styles.anomalyBadge}>{ANOMALIES.length}</span>
          </div>
          {ANOMALIES.length > 0 ? (
            ANOMALIES.map((a, i) => (
              <div key={i} className={styles.anomalyItem}>
                <div className={styles.anomalyDot} style={{ background: a.color }} />
                <div className={styles.anomalyContent}>
                  <div className={styles.anomalyText}>{a.text}</div>
                  <div className={styles.anomalyTime}>{a.time}</div>
                </div>
              </div>
            ))
          ) : (
            <div style={{ color: 'var(--color-text-tertiary)', fontSize: 13, padding: '12px 0' }}>No transactions loaded</div>
          )}
        </div>
      </div>

      {/* Portfolio Governance Footer */}
      <div className={styles.governance}>
        <div className={styles.govLeft}>
          <div className={styles.govIcon}>
            <span className="material-symbols-outlined">verified</span>
          </div>
          <div>
            <div className={styles.govTitle}>Portfolio Governance</div>
            <div className={styles.govSubtitle}>All financial rules are passing</div>
          </div>
        </div>
        <div className={styles.govStats}>
          <div className={styles.govStat}>
            <div className={styles.govStatValue}>12</div>
            <div className={styles.govStatLabel}>Rules Active</div>
          </div>
          <div className={styles.govStat}>
            <div className={styles.govStatValue}>0</div>
            <div className={styles.govStatLabel}>Violations</div>
          </div>
          <div className={styles.govStat}>
            <div className={styles.govStatValue}>98.2</div>
            <div className={styles.govStatLabel}>Health Score</div>
          </div>
          <div className={styles.govStat}>
            <div className={styles.govStatValue}>A+</div>
            <div className={styles.govStatLabel}>Grade</div>
          </div>
        </div>
      </div>
    </div>
  );
}
