import { useState, useMemo } from 'react';
import { useData } from '../contexts/DataContext';
import { useBudgets } from '../hooks/useBudgets';
import { BudgetCard } from '../components/BudgetCard';
import BudgetChart from '../components/BudgetChart';
import styles from './BudgetsPage.module.css';

const CATEGORY_ICONS = {
  'food & drink': 'restaurant',
  'shopping': 'shopping_bag',
  'travel': 'flight',
  'entertainment': 'movie',
  'bills & utilities': 'receipt',
  'housing': 'home',
  'transportation': 'directions_car',
  'health & wellness': 'health_and_safety',
  'income': 'payments',
  'transfer': 'swap_horiz',
  'education': 'school',
  'personal care': 'self_improvement',
  'gifts & donations': 'redeem',
  'investments': 'trending_up',
  'fees & charges': 'receipt_long',
  'dining out': 'restaurant',
  'restaurants': 'restaurant',
  'groceries': 'shopping_cart',
  'gas': 'local_gas_station',
  'utilities': 'bolt',
  'rent': 'home',
  'mortgage': 'home',
  'insurance': 'shield',
  'healthcare': 'favorite',
  'subscriptions': 'subscriptions',
  'clothing': 'checkroom',
  'electronics': 'devices',
  'fitness': 'fitness_center',
};

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

const CATEGORY_COLORS = [
  '#0058be', '#009668', '#7c3aed', '#ba1a1a', '#e8a317',
  '#0891b2', '#dc2626', '#16a34a', '#9333ea', '#ea580c',
  '#2563eb', '#65a30d', '#c026d3', '#0d9488', '#d97706',
];

function fmt(n) {
  if (n == null) return '—';
  return new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', minimumFractionDigits: 0, maximumFractionDigits: 0 }).format(n);
}

// Inline mini line chart with a shaded ±25% normal-range band and dashed avg line.
function RangeSparkline({ series, low, high, avg }) {
  const w = 180;
  const h = 56;
  const padX = 4;
  const padY = 4;
  if (!series || series.length === 0) return null;
  const allVals = [...series.map(s => s.value), high, avg, low].filter(v => v > 0);
  const max = allVals.length ? Math.max(...allVals) * 1.15 : 1;
  const min = 0;
  const range = max - min || 1;
  const yPos = v => padY + (h - 2 * padY) * (1 - (v - min) / range);
  const xStep = (w - 2 * padX) / Math.max(series.length - 1, 1);
  const xPos = i => padX + i * xStep;
  const path = series.map((s, i) => `${i === 0 ? 'M' : 'L'} ${xPos(i)} ${yPos(s.value)}`).join(' ');
  const yHigh = yPos(high);
  const yLow = yPos(low);
  const yAvg = yPos(avg);
  return (
    <svg width={w} height={h} style={{ display: 'block' }}>
      {/* Normal range band */}
      {avg > 0 && (
        <rect x={padX} y={yHigh} width={w - 2 * padX} height={Math.max(yLow - yHigh, 1)}
          fill="#16a34a" opacity={0.12} rx={2} />
      )}
      {/* Average line */}
      {avg > 0 && (
        <line x1={padX} y1={yAvg} x2={w - padX} y2={yAvg}
          stroke="#16a34a" strokeWidth={1} strokeDasharray="3 3" opacity={0.7} />
      )}
      {/* Spend line */}
      <path d={path} fill="none" stroke="var(--color-text-secondary)" strokeWidth={1.6}
        strokeLinecap="round" strokeLinejoin="round" />
      {/* Dots — current month gets accented */}
      {series.map((s, i) => {
        const above = avg > 0 && s.value > high;
        const below = avg > 0 && s.value < low && s.value > 0;
        const dotColor = s.isCurrent ? (above ? '#ba1a1a' : below ? '#e8a317' : '#16a34a') : 'var(--color-text-secondary)';
        return (
          <circle key={i} cx={xPos(i)} cy={yPos(s.value)}
            r={s.isCurrent ? 3.5 : 2.5} fill={dotColor}>
            <title>{`${s.label}: $${Math.round(s.value).toLocaleString()}`}</title>
          </circle>
        );
      })}
    </svg>
  );
}

export function BudgetsPage() {
  const { analytics, transactions } = useData();
  const { budgets, loading, addBudget, updateBudget, deleteBudget, addSubBudget, updateSubBudget, deleteSubBudget } = useBudgets();
  const totalExpenses = analytics?.totalExpenses || 0;
  const totalIncome = analytics?.totalIncome || 0;
  const cashFlow = analytics?.cashFlow || 0;

  // Suggest budgets based on spending
  const [showSuggestions, setShowSuggestions] = useState(false);
  const suggestions = useMemo(() => {
    if (!transactions || transactions.length === 0) return [];
    // Group expenses by category and month
    const categoryMonths = {};
    for (const t of transactions) {
      if (t.amount >= 0) continue; // skip income
      const cat = t.category || 'Uncategorized';
      if (cat === 'Transfer' || cat === 'Credit Card Payment') continue;
      const month = t.month || 'Unknown';
      if (!categoryMonths[cat]) categoryMonths[cat] = {};
      if (!categoryMonths[cat][month]) categoryMonths[cat][month] = 0;
      categoryMonths[cat][month] += Math.abs(t.amount);
    }
    // Calculate average monthly spend per category
    const existingNames = new Set(budgets.map(b => b.name.toLowerCase()));
    return Object.entries(categoryMonths)
      .map(([name, months]) => {
        const monthValues = Object.values(months);
        const avg = monthValues.reduce((s, v) => s + v, 0) / monthValues.length;
        const max = Math.max(...monthValues);
        // Suggest 10% above average, rounded to nearest $50
        const suggested = Math.ceil((avg * 1.1) / 50) * 50;
        return { name, avgSpend: Math.round(avg), maxSpend: Math.round(max), suggested, months: monthValues.length };
      })
      .filter(s => s.avgSpend >= 20) // skip tiny categories
      .filter(s => !existingNames.has(s.name.toLowerCase())) // skip already-created budgets
      .sort((a, b) => b.avgSpend - a.avgSpend);
  }, [transactions, budgets]);

  function handleAddSuggestion(s) {
    const iconKey = s.name.toLowerCase();
    const icon = CATEGORY_ICONS[iconKey] || 'savings';
    const colorIdx = budgets.length % CATEGORY_COLORS.length;
    const subs = (SUBCATEGORIES[s.name] || []).map(name => ({ name, monthlyLimit: 0 }));
    addBudget({ name: s.name, monthlyLimit: s.suggested, icon, color: CATEGORY_COLORS[colorIdx], subBudgets: subs });
  }

  function handleAddAllSuggestions() {
    suggestions.forEach((s, i) => {
      const iconKey = s.name.toLowerCase();
      const icon = CATEGORY_ICONS[iconKey] || 'savings';
      const colorIdx = (budgets.length + i) % CATEGORY_COLORS.length;
      const subs = (SUBCATEGORIES[s.name] || []).map(name => ({ name, monthlyLimit: 0 }));
      addBudget({ name: s.name, monthlyLimit: s.suggested, icon, color: CATEGORY_COLORS[colorIdx], subBudgets: subs });
    });
    setShowSuggestions(false);
  }

  // Chart state
  const [chartCategory, setChartCategory] = useState('all');
  const [chartMonths, setChartMonths] = useState(6);
  const [chartMode, setChartMode] = useState('bar'); // 'bar' or 'pct'
  const [selectedMonth, setSelectedMonth] = useState(null); // null = current period, or a month key like "4/1/26"

  const chartData = useMemo(() => {
    if (!transactions || transactions.length === 0 || budgets.length === 0) return [];
    const budgetNames = budgets.map(b => b.name.toLowerCase());
    const budgetLimitMap = {};
    for (const b of budgets) budgetLimitMap[b.name.toLowerCase()] = b.monthlyLimit || 0;

    // Group spending by month
    const monthMap = {};
    for (const t of transactions) {
      if (t.amount >= 0) continue;
      const cat = (t.category || '').toLowerCase();
      if (chartCategory !== 'all' && cat !== chartCategory.toLowerCase()) continue;
      if (chartCategory === 'all' && !budgetNames.includes(cat)) continue;
      const month = t.month || 'Unknown';
      if (!monthMap[month]) monthMap[month] = 0;
      monthMap[month] += Math.abs(t.amount);
    }

    // Get budget limit for selected view
    const budgetLine = chartCategory === 'all'
      ? budgets.reduce((s, b) => s + (b.monthlyLimit || 0), 0)
      : budgetLimitMap[chartCategory.toLowerCase()] || 0;

    // Sort months and take last N
    const sorted = Object.entries(monthMap)
      .map(([month, spent]) => {
        // Parse month key like "4/1/26" to a sortable date
        const parts = month.split('/');
        const sortKey = parts.length === 3 ? `20${parts[2]}-${parts[0].padStart(2, '0')}` : month;
        const label = parts.length === 3
          ? new Date(2000 + parseInt(parts[2]), parseInt(parts[0]) - 1).toLocaleString('en-US', { month: 'short', year: '2-digit' })
          : month;
        return { month, label, sortKey, spent: Math.round(spent), budget: budgetLine };
      })
      .sort((a, b) => a.sortKey.localeCompare(b.sortKey))
      .slice(-chartMonths);

    return sorted;
  }, [transactions, budgets, chartCategory, chartMonths]);

  // Line chart: % of budget per category per month
  const pctChartData = useMemo(() => {
    if (!transactions || transactions.length === 0 || budgets.length === 0) return [];
    const budgetMap = {};
    for (const b of budgets) budgetMap[b.name.toLowerCase()] = b;

    // Group spending by month+category
    const monthCatMap = {};
    for (const t of transactions) {
      if (t.amount >= 0) continue;
      const cat = (t.category || '').toLowerCase();
      if (!budgetMap[cat]) continue;
      const month = t.month || 'Unknown';
      if (!monthCatMap[month]) monthCatMap[month] = {};
      if (!monthCatMap[month][cat]) monthCatMap[month][cat] = 0;
      monthCatMap[month][cat] += Math.abs(t.amount);
    }

    // Build chart rows
    const months = Object.keys(monthCatMap).map(month => {
      const parts = month.split('/');
      const sortKey = parts.length === 3 ? `20${parts[2]}-${parts[0].padStart(2, '0')}` : month;
      const label = parts.length === 3
        ? new Date(2000 + parseInt(parts[2]), parseInt(parts[0]) - 1).toLocaleString('en-US', { month: 'short', year: '2-digit' })
        : month;
      const row = { month, label, sortKey };
      for (const b of budgets) {
        const spent = monthCatMap[month][b.name.toLowerCase()] || 0;
        row[b.name] = b.monthlyLimit > 0 ? Math.round((spent / b.monthlyLimit) * 100) : 0;
      }
      return row;
    }).sort((a, b) => a.sortKey.localeCompare(b.sortKey)).slice(-chartMonths);

    return months;
  }, [transactions, budgets, chartMonths]);

  // ──────────────────────────────────────────────
  // Normal Range Tracker — 3-month subcategory avg ± 25%
  // ──────────────────────────────────────────────
  const RANGE_KEY = 'wa-budget-range-cats';
  const [rangeCats, setRangeCats] = useState(() => {
    try { return new Set(JSON.parse(localStorage.getItem(RANGE_KEY) || '[]')); }
    catch { return new Set(); }
  });
  function toggleRangeCat(cat) {
    setRangeCats(prev => {
      const next = new Set(prev);
      if (next.has(cat)) next.delete(cat); else next.add(cat);
      localStorage.setItem(RANGE_KEY, JSON.stringify([...next]));
      return next;
    });
  }

  // All categories available from the data, sorted
  const allCategoriesForRange = useMemo(() => {
    const set = new Set();
    for (const t of (transactions || [])) {
      if ((t.category || '') === 'Income') continue;
      if (t.category) set.add(t.category);
    }
    return [...set].sort();
  }, [transactions]);

  // Compute per-subcategory range data for the selected categories
  const rangeData = useMemo(() => {
    if (rangeCats.size === 0 || !transactions || transactions.length === 0) return [];
    const now = new Date();
    const currentKey = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;
    // 3 prior complete months for the baseline
    const baselineKeys = [];
    for (let i = 1; i <= 3; i++) {
      const d = new Date(now.getFullYear(), now.getMonth() - i, 1);
      baselineKeys.push(`${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`);
    }
    // 6-month chart series: 5 prior + current
    const chartKeys = [];
    for (let i = 5; i >= 0; i--) {
      const d = new Date(now.getFullYear(), now.getMonth() - i, 1);
      chartKeys.push({
        key: `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`,
        label: d.toLocaleString('en-US', { month: 'short' }),
        isCurrent: i === 0,
      });
    }
    // Aggregate (category, subcategory, monthKey) AND (category, monthKey) → spend (expense-only)
    const byCatSubMonth = new Map();
    const byCatMonth = new Map();
    for (const t of transactions) {
      if (!t.category || !rangeCats.has(t.category)) continue;
      const amt = Number(t.amount) || 0;
      if (amt >= 0) continue;
      if (!t.date) continue;
      const d = new Date(t.date);
      if (isNaN(d)) continue;
      const monthKey = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
      const sub = t.subcategory || 'Uncategorized';
      if (!byCatSubMonth.has(t.category)) byCatSubMonth.set(t.category, new Map());
      const subMap = byCatSubMonth.get(t.category);
      if (!subMap.has(sub)) subMap.set(sub, new Map());
      const monthMap = subMap.get(sub);
      monthMap.set(monthKey, (monthMap.get(monthKey) || 0) + Math.abs(amt));
      if (!byCatMonth.has(t.category)) byCatMonth.set(t.category, new Map());
      const catMonthMap = byCatMonth.get(t.category);
      catMonthMap.set(monthKey, (catMonthMap.get(monthKey) || 0) + Math.abs(amt));
    }
    function statusFor(avg, current, low, high) {
      if (avg === 0) return 'no-data';
      if (current === 0) return 'no-spend';
      if (current > high) return 'over';
      if (current < low) return 'under';
      return 'normal';
    }
    function bandsFor(monthMap) {
      const baselineVals = baselineKeys.map(k => monthMap.get(k) || 0);
      const present = baselineVals.filter(v => v > 0);
      const avg = present.length > 0 ? present.reduce((s, v) => s + v, 0) / present.length : 0;
      const low = avg * 0.75;
      const high = avg * 1.25;
      const current = monthMap.get(currentKey) || 0;
      const series = chartKeys.map(k => ({ ...k, value: monthMap.get(k.key) || 0 }));
      return { avg, low, high, current, baselineMonths: present.length, status: statusFor(avg, current, low, high), series };
    }
    const result = [];
    for (const [cat, subMap] of byCatSubMonth) {
      // Category-level rollup row
      const catBands = bandsFor(byCatMonth.get(cat));
      const subs = [];
      for (const [sub, monthMap] of subMap) {
        subs.push({ sub, ...bandsFor(monthMap) });
      }
      subs.sort((a, b) => b.avg - a.avg);
      result.push({ cat, catBands, subs });
    }
    result.sort((a, b) => a.cat.localeCompare(b.cat));
    return result;
  }, [rangeCats, transactions]);

  // New budget form
  const [adding, setAdding] = useState(false);
  const [newName, setNewName] = useState('');
  const [newLimit, setNewLimit] = useState('');
  const [newIcon, setNewIcon] = useState('savings');
  const [newColor, setNewColor] = useState('#0058be');
  const [newPeriod, setNewPeriod] = useState('monthly');

  function handleAdd() {
    if (!newName.trim()) return;
    addBudget({ name: newName.trim(), monthlyLimit: Number(newLimit) || 0, icon: newIcon, color: newColor, period: newPeriod });
    setNewName('');
    setNewLimit('');
    setNewIcon('savings');
    setNewColor('#0058be');
    setNewPeriod('monthly');
    setAdding(false);
  }

  return (
    <div className={styles.page}>
      {/* Dynamic Allocation Hero */}
      <div className={styles.hero}>
        <div className={styles.heroLabel}>Dynamic Allocation</div>
        <div className={styles.heroTitle}>Monthly Budget Performance</div>
        <div className={styles.heroSubtitle}>
          {cashFlow >= 0 ? 'You are currently under budget. Keep up the discipline.' : 'Spending exceeds income this period. Review categories below.'}
        </div>
        <div className={styles.heroStats}>
          <div className={styles.heroStat}>
            <div className={`${styles.heroStatValue} ${cashFlow >= 0 ? styles.heroStatValueGreen : ''}`}>{fmt(cashFlow)}</div>
            <div className={styles.heroStatLabel}>{cashFlow >= 0 ? 'Surplus' : 'Deficit'}</div>
          </div>
          <div className={styles.heroStat}>
            <div className={styles.heroStatValue}>{fmt(totalIncome)}</div>
            <div className={styles.heroStatLabel}>Total Income</div>
          </div>
          <div className={styles.heroStat}>
            <div className={styles.heroStatValue}>{fmt(totalExpenses)}</div>
            <div className={styles.heroStatLabel}>Spent to Date</div>
          </div>
          <div className={styles.heroStat}>
            <div className={styles.heroStatValue}>{budgets.length}</div>
            <div className={styles.heroStatLabel}>Budgets</div>
          </div>
        </div>
      </div>

      {/* Suggest Budgets */}
      <div>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 12 }}>
          <div className={styles.sectionLabel} style={{ marginBottom: 0 }}>
            {showSuggestions ? 'Suggested Budgets' : ''}
          </div>
          <button className={styles.suggestBtn} onClick={() => setShowSuggestions(p => !p)}>
            <span className="material-symbols-outlined" style={{ fontSize: 16 }}>auto_awesome</span>
            {showSuggestions ? 'Hide Suggestions' : `Suggest Budgets${suggestions.length > 0 ? ` (${suggestions.length})` : ''}`}
          </button>
        </div>
        {showSuggestions && (
          <>
            {suggestions.length > 0 ? (
              <>
                <div className={styles.suggestInfo}>Based on your spending history across {suggestions[0]?.months || 0}+ months</div>
                <div className={styles.suggestGrid}>
                  {suggestions.map(s => (
                    <div key={s.name} className={styles.suggestCard}>
                      <div className={styles.suggestCardHeader}>
                        <div className={styles.budgetIconWrap} style={{ background: 'rgba(0,88,190,0.08)', color: '#0058be' }}>
                          <span className="material-symbols-outlined">{CATEGORY_ICONS[s.name.toLowerCase()] || 'savings'}</span>
                        </div>
                        <button className={styles.suggestAddBtn} onClick={() => handleAddSuggestion(s)} title="Add this budget">
                          <span className="material-symbols-outlined" style={{ fontSize: 16 }}>add</span>
                        </button>
                      </div>
                      <div className={styles.budgetName}>{s.name}</div>
                      <div className={styles.suggestStats}>
                        <div><span className={styles.suggestStatLabel}>Avg/mo:</span> ${s.avgSpend.toLocaleString()}</div>
                        <div><span className={styles.suggestStatLabel}>Peak:</span> ${s.maxSpend.toLocaleString()}</div>
                        <div><span className={styles.suggestStatLabel}>Suggested:</span> <strong>${s.suggested.toLocaleString()}</strong></div>
                      </div>
                    </div>
                  ))}
                </div>
                <button className={styles.suggestAllBtn} onClick={handleAddAllSuggestions}>
                  <span className="material-symbols-outlined" style={{ fontSize: 16 }}>playlist_add</span>
                  Add All {suggestions.length} Budgets
                </button>
              </>
            ) : (
              <div style={{ fontSize: 13, color: 'var(--color-text-tertiary)', padding: '12px 0' }}>
                {!transactions || transactions.length === 0
                  ? 'No transaction data loaded. Check that your spreadsheet is connected.'
                  : budgets.length > 0
                    ? 'All spending categories already have budgets.'
                    : 'No categorized expenses found in your transactions. Categorize your transactions to get budget suggestions.'}
              </div>
            )}
          </>
        )}
      </div>

      {/* Unbudgeted / Uncategorized Summary */}
      {analytics?.byCategory && budgets.length > 0 && (() => {
        const budgetNames = new Set(budgets.map(b => b.name.toLowerCase()));
        let uncategorized = 0;
        let unbudgeted = 0;
        const unbudgetedCats = [];
        for (const cat of analytics.byCategory) {
          if (cat.total >= 0) continue; // skip income
          const spent = Math.abs(cat.total);
          if (!cat.name || cat.name === 'Uncategorized') {
            uncategorized += spent;
          } else if (!budgetNames.has(cat.name.toLowerCase())) {
            unbudgeted += spent;
            unbudgetedCats.push({ name: cat.name, spent });
          }
        }
        if (uncategorized === 0 && unbudgeted === 0) return null;
        return (
          <div className={styles.unbudgetedBar}>
            {uncategorized > 0 && (
              <div className={styles.unbudgetedItem}>
                <span className="material-symbols-outlined" style={{ fontSize: 16, color: 'var(--color-warning)' }}>warning</span>
                <span><strong>${Math.round(uncategorized).toLocaleString()}</strong> uncategorized spending</span>
              </div>
            )}
            {unbudgeted > 0 && (
              <div className={styles.unbudgetedItem}>
                <span className="material-symbols-outlined" style={{ fontSize: 16, color: 'var(--color-error)' }}>account_balance_wallet</span>
                <span><strong>${Math.round(unbudgeted).toLocaleString()}</strong> in {unbudgetedCats.length} categories without budgets</span>
                <span style={{ fontSize: 11, color: 'var(--color-text-tertiary)' }}>({unbudgetedCats.map(c => c.name).join(', ')})</span>
              </div>
            )}
          </div>
        );
      })()}

      {/* Historical Chart */}
      {budgets.length > 0 && (
        <div className={styles.chartCard}>
          <div className={styles.chartHeader}>
            <div className={styles.chartTitle}>Budget vs Actual</div>
            <div className={styles.chartControls}>
              <div className={styles.chartToggle}>
                <button className={`${styles.chartToggleBtn} ${chartMode === 'bar' ? styles.chartToggleBtnActive : ''}`} onClick={() => setChartMode('bar')}>$ Amount</button>
                <button className={`${styles.chartToggleBtn} ${chartMode === 'pct' ? styles.chartToggleBtnActive : ''}`} onClick={() => setChartMode('pct')}>% of Budget</button>
              </div>
              {chartMode === 'bar' && (
                <select className={styles.chartSelect} value={chartCategory} onChange={e => setChartCategory(e.target.value)}>
                  <option value="all">All Budgets</option>
                  {budgets.map(b => <option key={b.id} value={b.name}>{b.name}</option>)}
                </select>
              )}
              <select className={styles.chartSelect} value={chartMonths} onChange={e => setChartMonths(Number(e.target.value))}>
                <option value={3}>3 months</option>
                <option value={6}>6 months</option>
                <option value={12}>12 months</option>
              </select>
            </div>
          </div>

          <BudgetChart
            chartMode={chartMode}
            chartData={chartData}
            pctChartData={pctChartData}
            budgets={budgets}
            categoryColors={CATEGORY_COLORS}
            onBarClick={(month) => setSelectedMonth(prev => prev === month ? null : month)}
          />
          {/* Month pills */}
          {chartData.length > 0 && (
            <div className={styles.monthPills}>
              <button
                className={`${styles.monthPill} ${!selectedMonth ? styles.monthPillActive : ''}`}
                onClick={() => setSelectedMonth(null)}
              >
                Current
              </button>
              {chartData.map(d => (
                <button
                  key={d.month}
                  className={`${styles.monthPill} ${selectedMonth === d.month ? styles.monthPillActive : ''}`}
                  onClick={() => setSelectedMonth(prev => prev === d.month ? null : d.month)}
                >
                  {d.label}
                </button>
              ))}
            </div>
          )}
        </div>
      )}

      {/* Normal Range Tracker */}
      <div className={styles.chartCard}>
        <div className={styles.chartHeader}>
          <div className={styles.chartTitle}>Normal Range Tracker</div>
          <div style={{ fontSize: 11, color: 'var(--color-text-tertiary)' }}>
            3-month average · ±25% normal band · this month vs band
          </div>
        </div>
        <div style={{ marginBottom: 12, display: 'flex', flexWrap: 'wrap', gap: 6 }}>
          {allCategoriesForRange.length === 0 ? (
            <div style={{ fontSize: 12, color: 'var(--color-text-tertiary)' }}>No categories in your data yet.</div>
          ) : (
            allCategoriesForRange.map(cat => {
              const on = rangeCats.has(cat);
              return (
                <button
                  key={cat}
                  type="button"
                  onClick={() => toggleRangeCat(cat)}
                  style={{
                    padding: '4px 10px',
                    borderRadius: 999,
                    fontSize: 11.5,
                    fontWeight: 600,
                    border: '1px solid',
                    borderColor: on ? 'var(--color-secondary, #0058be)' : 'var(--border-ghost)',
                    background: on ? 'rgba(0,88,190,0.08)' : 'var(--color-surface)',
                    color: on ? 'var(--color-secondary, #0058be)' : 'var(--color-text-tertiary)',
                    cursor: 'pointer',
                  }}
                >
                  {cat}
                </button>
              );
            })
          )}
        </div>
        {rangeCats.size === 0 ? (
          <div style={{ fontSize: 12, color: 'var(--color-text-tertiary)', padding: '8px 0' }}>
            Pick one or more categories above to see their subcategories' normal spending range.
          </div>
        ) : rangeData.length === 0 ? (
          <div style={{ fontSize: 12, color: 'var(--color-text-tertiary)', padding: '8px 0' }}>
            No expense data in the selected categories.
          </div>
        ) : (() => {
          // Flatten across selected categories. Both the category-level rollup AND its
          // subcategories appear as independent rows, each bucketed by its own status.
          const flat = [];
          for (const { cat, catBands, subs } of rangeData) {
            flat.push({ kind: 'category', cat, sub: cat, ...catBands });
            for (const s of subs) flat.push({ kind: 'sub', cat, ...s });
          }
          const buckets = [
            { key: 'over',     label: 'Above Range',  bg: 'rgba(186,26,26,0.06)',  fg: '#ba1a1a', icon: 'trending_up',   blurb: 'Spending more than the normal band' },
            { key: 'normal',   label: 'On Track',     bg: 'rgba(0,150,104,0.06)',  fg: '#16a34a', icon: 'check_circle',  blurb: 'Within the ±25% normal range' },
            { key: 'under',    label: 'Under Range',  bg: 'rgba(232,163,23,0.06)', fg: '#e8a317', icon: 'trending_down', blurb: 'Spending less than the normal band' },
            { key: 'no-spend', label: 'No Spend Yet', bg: 'var(--color-surface-alt)', fg: 'var(--color-text-tertiary)', icon: 'pause_circle',  blurb: 'Has a baseline but nothing this month yet' },
            { key: 'no-data',  label: 'No Baseline',  bg: 'var(--color-surface-alt)', fg: 'var(--color-text-tertiary)', icon: 'help',          blurb: 'Not enough prior-month history to compare' },
          ];
          // Sort within each bucket: categories first, then subcategories, biggest movers first.
          // Always show the four primary buckets (over / normal / under / no-data), even when
          // empty, so the user sees the structure. Hide 'no-spend' unless it has rows.
          const ALWAYS_SHOW = new Set(['over', 'normal', 'under', 'no-data']);
          const grouped = buckets.map(b => ({
            ...b,
            items: flat.filter(f => f.status === b.key).sort((a, c) => {
              if (a.kind !== c.kind) return a.kind === 'category' ? -1 : 1;
              return Math.abs(c.current - c.avg) - Math.abs(a.current - a.avg);
            }),
          })).filter(b => ALWAYS_SHOW.has(b.key) || b.items.length > 0);

          return (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
              {grouped.map(b => (
                <div key={b.key} style={{ border: `1px solid ${b.fg === 'var(--color-text-tertiary)' ? 'var(--border-ghost)' : b.fg + '33'}`, borderRadius: 10, overflow: 'hidden' }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '10px 14px', background: b.bg, borderBottom: '1px solid var(--border-ghost)' }}>
                    <span className="material-symbols-outlined" style={{ fontSize: 16, color: b.fg }}>{b.icon}</span>
                    <span style={{ fontFamily: 'var(--font-headline)', fontSize: 13, fontWeight: 700, color: b.fg }}>{b.label}</span>
                    <span style={{ fontSize: 11, fontWeight: 700, padding: '1px 7px', borderRadius: 999, background: 'rgba(255,255,255,0.6)', color: b.fg }}>{b.items.length}</span>
                    <span style={{ fontSize: 11, color: 'var(--color-text-tertiary)', marginLeft: 'auto' }}>{b.blurb}</span>
                  </div>
                  {b.items.length === 0 ? (
                    <div style={{ padding: '14px', fontSize: 12, color: 'var(--color-text-tertiary)', fontStyle: 'italic', textAlign: 'center' }}>
                      No subcategories in this bucket right now.
                    </div>
                  ) : (
                  <div style={{ overflowX: 'auto' }}>
                    <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12 }}>
                      <thead>
                        <tr style={{ color: 'var(--color-text-tertiary)', textAlign: 'left' }}>
                          <th style={{ padding: '6px 14px', fontWeight: 600 }}>Subcategory</th>
                          <th style={{ padding: '6px 8px', fontWeight: 600, textAlign: 'right' }}>3mo Avg</th>
                          <th style={{ padding: '6px 8px', fontWeight: 600, textAlign: 'right' }}>Normal Range</th>
                          <th style={{ padding: '6px 8px', fontWeight: 600, textAlign: 'right' }}>This Month</th>
                          <th style={{ padding: '6px 8px', fontWeight: 600, textAlign: 'right' }}>Δ vs Avg</th>
                          <th style={{ padding: '6px 8px', fontWeight: 600 }}>6-mo Trend</th>
                        </tr>
                      </thead>
                      <tbody>
                        {b.items.map(({ kind, sub, cat, avg, low, high, current, baselineMonths, status, series }) => {
                          const delta = current - avg;
                          const deltaPct = avg > 0 ? (delta / avg) * 100 : 0;
                          const deltaColor = status === 'over' ? '#ba1a1a' : status === 'under' ? '#e8a317' : 'var(--color-text-tertiary)';
                          const isCat = kind === 'category';
                          return (
                            <tr key={`${kind}|${cat}|${sub}`} style={{ borderTop: '1px solid var(--border-ghost)', background: isCat ? 'rgba(0,0,0,0.015)' : undefined }}>
                              <td style={{ padding: '8px 14px', fontWeight: isCat ? 800 : 600 }}>
                                <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                                  {isCat && (
                                    <span title="Category total — sum of all subcategories"
                                          style={{ fontSize: 9, fontWeight: 800, padding: '1px 5px', borderRadius: 3, background: 'var(--color-secondary, #0058be)', color: '#fff', textTransform: 'uppercase', letterSpacing: '0.04em' }}>
                                      Cat
                                    </span>
                                  )}
                                  <span>{sub}</span>
                                  {baselineMonths < 3 && baselineMonths > 0 && (
                                    <span style={{ fontSize: 10, color: 'var(--color-text-tertiary)' }}>({baselineMonths}mo)</span>
                                  )}
                                </div>
                                {!isCat && (
                                  <div style={{ fontSize: 10.5, fontWeight: 500, color: 'var(--color-text-tertiary)', marginTop: 1 }}>{cat}</div>
                                )}
                              </td>
                              <td style={{ padding: '8px', textAlign: 'right', fontVariantNumeric: 'tabular-nums' }}>
                                {avg > 0 ? fmt(avg) : '—'}
                              </td>
                              <td style={{ padding: '8px', textAlign: 'right', fontVariantNumeric: 'tabular-nums', color: 'var(--color-text-tertiary)' }}>
                                {avg > 0 ? `${fmt(low)} – ${fmt(high)}` : '—'}
                              </td>
                              <td style={{ padding: '8px', textAlign: 'right', fontVariantNumeric: 'tabular-nums', fontWeight: 700,
                                           color: status === 'over' ? '#ba1a1a' : status === 'under' ? '#e8a317' : 'var(--color-text-primary)' }}>
                                {fmt(current)}
                              </td>
                              <td style={{ padding: '8px', textAlign: 'right', fontVariantNumeric: 'tabular-nums', color: deltaColor, fontWeight: 700 }}>
                                {avg > 0
                                  ? `${delta >= 0 ? '+' : '−'}${fmt(Math.abs(delta))} (${delta >= 0 ? '+' : '−'}${Math.abs(Math.round(deltaPct))}%)`
                                  : '—'}
                              </td>
                              <td style={{ padding: '8px' }}>
                                <RangeSparkline series={series} low={low} high={high} avg={avg} />
                              </td>
                            </tr>
                          );
                        })}
                      </tbody>
                    </table>
                  </div>
                  )}
                </div>
              ))}
            </div>
          );
        })()}
      </div>

      {/* Budgets */}
      <div>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 12 }}>
          <div className={styles.sectionLabel} style={{ marginBottom: 0 }}>
            Budgets
            {selectedMonth && (() => {
              const parts = selectedMonth.split('/');
              const label = parts.length === 3
                ? new Date(2000 + parseInt(parts[2]), parseInt(parts[0]) - 1).toLocaleString('en-US', { month: 'long', year: 'numeric' })
                : selectedMonth;
              return <span style={{ fontWeight: 400, textTransform: 'none', letterSpacing: 0, marginLeft: 8, fontSize: 11, color: 'var(--color-secondary)' }}>— {label}</span>;
            })()}
          </div>
          {adding ? (
            <div style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
              <input className={styles.budgetInput} value={newName} onChange={e => setNewName(e.target.value)} placeholder="Name" autoFocus style={{ width: 140 }} />
              <span style={{ fontSize: 13, color: 'var(--color-text-tertiary)' }}>$</span>
              <input className={styles.budgetInput} type="number" value={newLimit} onChange={e => setNewLimit(e.target.value)} placeholder="Limit" style={{ width: 80 }} />
              <select className={styles.budgetInput} value={newPeriod} onChange={e => setNewPeriod(e.target.value)} style={{ width: 90 }}>
                <option value="weekly">Weekly</option>
                <option value="monthly">Monthly</option>
                <option value="annual">Annual</option>
              </select>
              <input className={styles.budgetInput} value={newIcon} onChange={e => setNewIcon(e.target.value)} placeholder="Icon" style={{ width: 80 }} />
              <input type="color" value={newColor} onChange={e => setNewColor(e.target.value)} style={{ width: 28, height: 28, border: 'none', padding: 0, cursor: 'pointer' }} />
              <button className={styles.budgetSaveBtn} onClick={handleAdd}>Create</button>
              <button className={styles.budgetCancelBtn} onClick={() => setAdding(false)}>Cancel</button>
            </div>
          ) : (
            <button className={styles.suggestBtn} onClick={() => setAdding(true)}>
              <span className="material-symbols-outlined" style={{ fontSize: 16 }}>add</span>
              Add Budget
            </button>
          )}
        </div>
        {loading ? (
          <div style={{ color: 'var(--color-text-tertiary)', fontSize: 13 }}>Loading budgets...</div>
        ) : budgets.length === 0 ? (
          <div style={{ color: 'var(--color-text-tertiary)', fontSize: 13, padding: '20px 0' }}>No budgets yet. Add one or use Suggest Budgets above.</div>
        ) : (
          <div className={styles.budgetsList}>
            {[...budgets].sort((a, b) => (b.monthlyLimit || 0) - (a.monthlyLimit || 0)).map(b => (
              <BudgetCard
                key={b.id}
                budget={b}
                onUpdate={updateBudget}
                onDelete={deleteBudget}
                onAddSub={addSubBudget}
                onUpdateSub={updateSubBudget}
                onDeleteSub={deleteSubBudget}
                transactions={transactions}
                selectedMonth={selectedMonth}
                styles={styles}
              />
            ))}
          </div>
        )}
      </div>

    </div>
  );
}
