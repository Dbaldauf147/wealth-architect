import { useMemo, useState } from 'react';
import { useData } from '../contexts/DataContext';
import { upcomingCardPayments } from '../lib/weeklySummary';

function fmt(n) {
  if (n == null) return '—';
  return new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', minimumFractionDigits: 0, maximumFractionDigits: 0 }).format(n);
}

const MONTH_SHORT = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

// Categories that must never roll into the Expenses bucket on the Cashflow page,
// even if they happen to have negative-signed transactions.
// (Transfer, Credit Card Payment(s), Investments, Retirement are already excluded
// elsewhere — see drilldownData / data aggregation — so they're not repeated here.)
const NON_EXPENSE_CATS = new Set([
  'paycheck',
  'income',
  'tax refund/payment',
]);

function csvEscape(v) {
  if (v == null) return '';
  const s = String(v);
  if (/[",\n\r]/.test(s)) return `"${s.replace(/"/g, '""')}"`;
  return s;
}

function downloadCsv(rows, headers, filename) {
  const lines = [headers.join(',')];
  for (const r of rows) lines.push(headers.map(h => csvEscape(r[h])).join(','));
  const blob = new Blob(['﻿' + lines.join('\r\n')], { type: 'text/csv;charset=utf-8;' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  setTimeout(() => URL.revokeObjectURL(url), 0);
}

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
  const [drilldown, setDrilldown] = useState(null); // { monthKey, kind: 'income'|'expenses' }
  const [expandedDrillCats, setExpandedDrillCats] = useState(new Set());
  const [expandedRevCats, setExpandedRevCats] = useState(new Set());
  const [view, setView] = useState('history'); // 'history' | 'projections'

  const data = useMemo(() => {
    if (!transactions) return { months: [], totalIncome: 0, totalExpenses: 0, net: 0, avgIncome: 0, avgExpenses: 0, qualifyingExpCats: new Set() };

    const buckets = {};
    // Per-category per-month signed sums for the expense calculation.
    // We mirror the Transactions page: a category counts as an expense category only
    // when its net across the visible months is negative; the per-month value is
    // |signed sum| so refunds reduce the displayed expense.
    const expSignedByCat = {}; // [categoryDisplayName] -> { [monthKey]: signedSum }
    for (const t of transactions) {
      if (!t.date || t.amount === 0) continue;
      const cat = (t.category || '').toLowerCase();
      const catKey = t.category || 'Uncategorized';
      if (cat === 'transfer' || cat === 'credit card payments' || cat === 'credit card payment') continue;
      const d = new Date(t.date);
      if (isNaN(d)) continue;
      const key = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
      if (!buckets[key]) buckets[key] = { income: 0, invested: 0, retirement: 0, incomeSubs: {} };
      if (cat === 'investments' || cat === 'retirement') {
        const amt = Math.abs(t.amount);
        buckets[key].invested += amt;
        const sub = (t.subcategory || '').toLowerCase();
        if (cat === 'retirement' || sub === 'retirement') {
          buckets[key].retirement += amt;
        }
        continue;
      }
      if (t.amount > 0) {
        buckets[key].income += t.amount;
        const subLabel = t.subcategory || t.category || 'Other';
        buckets[key].incomeSubs[subLabel] = (buckets[key].incomeSubs[subLabel] || 0) + t.amount;
      }
      // Track per-cat-per-month signed amounts for the expense calc, excluding income-side cats
      if (NON_EXPENSE_CATS.has(cat)) continue;
      if (!expSignedByCat[catKey]) expSignedByCat[catKey] = {};
      expSignedByCat[catKey][key] = (expSignedByCat[catKey][key] || 0) + t.amount;
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

    // Qualifying expense cats: those whose net across the visible range is negative,
    // plus 'Uncategorized' if it has any non-zero net.
    const qualifyingExpCats = new Set();
    for (const cat of Object.keys(expSignedByCat)) {
      let net = 0;
      for (const k of recentKeys) net += expSignedByCat[cat][k] || 0;
      if (net < 0 || (cat === 'Uncategorized' && net !== 0)) {
        qualifyingExpCats.add(cat);
      }
    }

    const months = recentKeys.map(key => {
      const [y, m] = key.split('-');
      const b = buckets[key] || { income: 0, invested: 0, retirement: 0, incomeSubs: {} };
      let expenses = 0;
      for (const cat of qualifyingExpCats) {
        expenses += Math.abs(expSignedByCat[cat]?.[key] || 0);
      }
      return {
        key,
        label: MONTH_SHORT[parseInt(m, 10) - 1],
        year: y,
        income: b.income,
        expenses,
        invested: b.invested,
        retirement: b.retirement,
        net: b.income - expenses,
        incomeSubs: b.incomeSubs,
      };
    });

    const totalIncome = months.reduce((s, m) => s + m.income, 0);
    const totalExpenses = months.reduce((s, m) => s + m.expenses, 0);
    const totalInvested = months.reduce((s, m) => s + m.invested, 0);
    const totalRetirement = months.reduce((s, m) => s + m.retirement, 0);
    const activeMonths = months.filter(m => m.income > 0 || m.expenses > 0).length || 1;

    return {
      months,
      totalIncome,
      totalExpenses,
      totalInvested,
      totalRetirement,
      net: totalIncome - totalExpenses,
      avgIncome: totalIncome / activeMonths,
      avgExpenses: totalExpenses / activeMonths,
      avgInvested: totalInvested / activeMonths,
      savingsRate: totalIncome > 0 ? (totalIncome - totalExpenses) / totalIncome : 0,
      qualifyingExpCats,
      expSignedByCat,
    };
  }, [transactions, monthCount]);

  /* Category breakdown for clicked cell — mirrors the table semantics:
     - kind='expenses': only categories qualifying as expenses (net-negative
       across the visible range), per-cat total uses |month-signed| so refunds
       reduce the displayed value. Refund txns are still shown in the list.
     - kind='income': positive-amount transactions in any non-special category. */
  const drilldownData = useMemo(() => {
    if (!drilldown || !transactions) return null;
    const { monthKey, kind } = drilldown;
    const byCat = {};
    for (const t of transactions) {
      if (!t.date || t.amount === 0) continue;
      const tCat = (t.category || '').toLowerCase();
      if (tCat === 'transfer' || tCat === 'credit card payments' || tCat === 'credit card payment') continue;
      if (tCat === 'investments' || tCat === 'retirement') continue;
      const d = new Date(t.date);
      if (isNaN(d)) continue;
      const k = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
      if (k !== monthKey) continue;
      if (kind === 'income' && t.amount <= 0) continue;
      if (kind === 'expenses') {
        if (NON_EXPENSE_CATS.has(tCat)) continue;
        const cat0 = t.category || 'Uncategorized';
        if (!data.qualifyingExpCats.has(cat0)) continue;
        // Note: positive amounts (refunds) in qualifying cats are intentionally NOT
        // skipped — they reduce the cat's net for the month.
      }
      const cat = t.category || 'Uncategorized';
      const sub = t.subcategory || '';
      if (!byCat[cat]) byCat[cat] = { signedTotal: 0, count: 0, subs: {}, txns: [] };
      byCat[cat].signedTotal += t.amount;
      byCat[cat].count += 1;
      byCat[cat].txns.push({
        description: t.description || t.fullDescription || 'Unknown',
        amount: Math.abs(t.amount),
        isRefund: kind === 'expenses' && t.amount > 0,
        date: t.date,
        sub,
      });
      if (sub) {
        byCat[cat].subs[sub] = (byCat[cat].subs[sub] || 0) + t.amount;
      }
    }

    // Merge categories whose name also appears as a subcategory in another
    // category — e.g. a "Paycheck" top-level transaction folds into the
    // "Income → Paycheck" subcategory bucket so it doesn't render twice.
    const subToParent = {};
    for (const [parent, v] of Object.entries(byCat)) {
      for (const sub of Object.keys(v.subs)) {
        const sk = sub.toLowerCase();
        if (sk && sk !== parent.toLowerCase() && !subToParent[sk]) {
          subToParent[sk] = parent;
        }
      }
    }
    for (const cat of Object.keys(byCat)) {
      const target = subToParent[cat.toLowerCase()];
      if (!target || target === cat) continue;
      const src = byCat[cat];
      const dst = byCat[target];
      dst.signedTotal += src.signedTotal;
      dst.count += src.count;
      dst.txns.push(...src.txns.map(t => ({ ...t, sub: t.sub || cat })));
      dst.subs[cat] = (dst.subs[cat] || 0) + src.signedTotal;
      delete byCat[cat];
    }

    // Display totals: |signed sum| for the cat and each sub.
    let total = 0;
    for (const v of Object.values(byCat)) {
      v.total = Math.abs(v.signedTotal);
      total += v.total;
    }

    const rows = Object.entries(byCat)
      .map(([name, v]) => ({
        name,
        total: v.total,
        count: v.count,
        pct: total > 0 ? v.total / total : 0,
        subs: Object.entries(v.subs).map(([n, a]) => ({ name: n, total: Math.abs(a) })).sort((a, b) => b.total - a.total),
        txns: v.txns.sort((a, b) => b.amount - a.amount),
      }))
      .sort((a, b) => b.total - a.total);
    return { rows, total, monthKey, kind };
  }, [drilldown, transactions, data.qualifyingExpCats]);

  const revenueBreakdown = useMemo(() => {
    if (!transactions) return null;
    const monthFilter = drilldown ? drilldown.monthKey : null;
    const bySub = {};
    let total = 0;
    for (const t of transactions) {
      if (!t.date || t.amount <= 0) continue;
      const cat = (t.category || '').toLowerCase();
      if (cat === 'transfer' || cat === 'credit card payments' || cat === 'credit card payment') continue;
      if (cat === 'investments' || cat === 'retirement') continue;
      const d = new Date(t.date);
      if (isNaN(d)) continue;
      const key = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
      if (monthFilter) {
        if (key !== monthFilter) continue;
      } else {
        const allKeys = data.months.map(m => m.key);
        if (!allKeys.includes(key)) continue;
      }
      const label = t.subcategory || t.category || 'Other';
      if (!bySub[label]) bySub[label] = { total: 0, count: 0, txns: [] };
      bySub[label].total += t.amount;
      bySub[label].count += 1;
      bySub[label].txns.push({ description: t.description || t.fullDescription || 'Unknown', amount: t.amount, date: t.date });
      total += t.amount;
    }
    const rows = Object.entries(bySub)
      .map(([name, v]) => ({
        name,
        total: v.total,
        count: v.count,
        pct: total > 0 ? v.total / total : 0,
        txns: v.txns.sort((a, b) => b.amount - a.amount),
      }))
      .sort((a, b) => b.total - a.total);
    return { rows, total, monthFilter };
  }, [transactions, data.months, drilldown]);

  /* This-month projection. MTD actuals + projected remainder, where the
     remainder is (daysRemaining / daysInMonth) × baseline. Baseline blends
     a 6-month trailing average (over completed months) with prior occurrences
     of the same calendar month, when history exists. */
  const thisMonthProjection = useMemo(() => {
    const today = new Date();
    const cy = today.getFullYear();
    const cm = today.getMonth() + 1;
    const currentKey = `${cy}-${String(cm).padStart(2, '0')}`;
    const daysInMonth = new Date(cy, cm, 0).getDate();
    const daysElapsed = Math.min(today.getDate(), daysInMonth);
    const daysRemaining = Math.max(0, daysInMonth - daysElapsed);
    const monthLabel = today.toLocaleDateString('en-US', { month: 'long', year: 'numeric' });

    const months = data.months || [];
    const currentBucket = months.find(m => m.key === currentKey);
    const mtdIncome = currentBucket?.income || 0;
    const mtdExpenses = currentBucket?.expenses || 0;

    const pastMonths = months.filter(m => m.key !== currentKey);
    if (pastMonths.length === 0) {
      return {
        currentKey, monthLabel,
        daysInMonth, daysElapsed, daysRemaining,
        mtdIncome, mtdExpenses,
        baselineIncome: 0, baselineExpenses: 0,
        remainingIncome: 0, remainingExpenses: 0,
        projectedIncome: mtdIncome, projectedExpenses: mtdExpenses,
        hasHistory: false,
      };
    }

    const tailLen = Math.min(6, pastMonths.length);
    const tail = pastMonths.slice(-tailLen);
    const tAvg = sel => tail.reduce((s, m) => s + sel(m), 0) / tail.length;
    const tIncome = tAvg(m => m.income);
    const tExpenses = tAvg(m => m.expenses);

    const seas = pastMonths.filter(m => parseInt(m.key.split('-')[1], 10) === cm);
    let baselineIncome, baselineExpenses;
    if (seas.length) {
      const sAvg = sel => seas.reduce((s, m) => s + sel(m), 0) / seas.length;
      baselineIncome = 0.5 * sAvg(m => m.income) + 0.5 * tIncome;
      baselineExpenses = 0.5 * sAvg(m => m.expenses) + 0.5 * tExpenses;
    } else {
      baselineIncome = tIncome;
      baselineExpenses = tExpenses;
    }

    const remainingFrac = daysInMonth > 0 ? daysRemaining / daysInMonth : 0;
    const remainingIncome = baselineIncome * remainingFrac;
    const remainingExpenses = baselineExpenses * remainingFrac;

    return {
      currentKey, monthLabel,
      daysInMonth, daysElapsed, daysRemaining,
      mtdIncome, mtdExpenses,
      baselineIncome, baselineExpenses,
      remainingIncome, remainingExpenses,
      projectedIncome: mtdIncome + remainingIncome,
      projectedExpenses: mtdExpenses + remainingExpenses,
      hasHistory: true,
    };
  }, [data.months]);

  /* Upcoming credit-card payments — uses the shared helper that infers cadence
     and average amount from each card's CC-payment transaction history. */
  const cardPayments = useMemo(
    () => upcomingCardPayments({ transactions: transactions || [] }),
    [transactions],
  );

  function exportMonthCsv(monthKey, kind) {
    if (!transactions || !monthKey) return;
    const [yy, mm] = monthKey.split('-');
    const rows = transactions
      .filter(t => {
        if (!t.date || t.amount === 0) return false;
        const d = new Date(t.date);
        if (isNaN(d)) return false;
        const k = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
        if (k !== monthKey) return false;
        const tCat = (t.category || '').toLowerCase();
        // Mirrors drilldownData's exclusion list so the export matches
        // what the user is looking at.
        if (tCat === 'transfer' || tCat === 'credit card payments' || tCat === 'credit card payment') return false;
        if (tCat === 'investments' || tCat === 'retirement') return false;
        if (kind === 'income' && t.amount <= 0) return false;
        if (kind === 'expenses') {
          if (NON_EXPENSE_CATS.has(tCat)) return false;
          const cat0 = t.category || 'Uncategorized';
          if (!data.qualifyingExpCats.has(cat0)) return false;
          // Include refunds (positive amounts) in qualifying cats — they net
          // against spending and reduce the displayed total.
        }
        return true;
      })
      .map(t => ({
        Date: t.date,
        Description: t.description || t.fullDescription || '',
        Category: t.category || '',
        Subcategory: t.subcategory || '',
        Amount: t.amount,
        Account: t.account || '',
        Institution: t.institution || '',
        Notes: t.notes || '',
      }))
      .sort((a, b) => String(b.Date || '').localeCompare(String(a.Date || '')));
    if (rows.length === 0) return;
    const monthName = MONTH_SHORT[parseInt(mm, 10) - 1].toLowerCase();
    const kindSuffix = kind === 'income' ? '-income' : kind === 'expenses' ? '-expenses' : '';
    downloadCsv(
      rows,
      ['Date', 'Description', 'Category', 'Subcategory', 'Amount', 'Account', 'Institution', 'Notes'],
      `cashflow-${monthName}-${yy}${kindSuffix}.csv`,
    );
  }

  if (loading) {
    return <div style={{ padding: 40, textAlign: 'center', color: 'var(--color-text-tertiary)' }}>Loading...</div>;
  }

  const incomeColor = '#16a34a';
  const expenseColor = '#dc2626';
  const investColor = '#7c3aed';
  const retireColor = '#2563eb';
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
  const minNet = Math.min(0, ...data.months.map(m => m.net));
  const raw = maxVal * 1.05;
  const mag = Math.pow(10, Math.floor(Math.log10(raw || 1)));
  const steps = [1, 1.2, 1.5, 2, 2.5, 3, 4, 5, 6, 8, 10];
  let niceMax = mag * 10;
  for (const s of steps) {
    if (mag * s >= raw) { niceMax = mag * s; break; }
  }
  if (niceMax === 0) niceMax = 1000;
  let niceMin = 0;
  if (minNet < 0) {
    const rawMin = Math.abs(minNet) * 1.05;
    const magMin = Math.pow(10, Math.floor(Math.log10(rawMin || 1)));
    niceMin = -magMin * 10;
    for (const s of steps) {
      if (magMin * s >= rawMin) { niceMin = -magMin * s; break; }
    }
  }
  const range = niceMax - niceMin;
  const ticks = [niceMax, niceMax * 0.75, niceMax * 0.5, niceMax * 0.25, 0];
  if (niceMin < 0) ticks.push(niceMin);

  const yPos = v => pad.top + innerH - ((v - niceMin) / range) * innerH;
  const slotW = data.months.length ? innerW / data.months.length : 0;
  const xCenter = mi => pad.left + (mi + 0.5) * slotW;
  const barW = Math.min(18, slotW * 0.35);

  const fmtAxis = t => {
    const sign = t < 0 ? '-' : '';
    const abs = Math.abs(t);
    return abs >= 1000 ? `${sign}$${(abs / 1000).toFixed(abs % 1000 === 0 ? 0 : 1)}k` : `${sign}$${abs}`;
  };

  const netPoints = data.months.map((m, i) => ({ x: xCenter(i), y: yPos(m.net) }));

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 24 }}>
      {/* Header + view tabs */}
      <div>
        <div style={{ display: 'flex', alignItems: 'flex-end', justifyContent: 'space-between', gap: 12, flexWrap: 'wrap' }}>
          <div>
            <div style={{ fontFamily: 'var(--font-headline)', fontSize: 24, fontWeight: 700, marginBottom: 4 }}>Cash Flow</div>
            <div style={{ fontSize: 13, color: 'var(--color-text-tertiary)' }}>
              {view === 'history'
                ? `Income vs. expenses across the last ${monthCount} months`
                : `${thisMonthProjection.monthLabel} projection and upcoming credit card payments`}
            </div>
          </div>
          <div style={{ display: 'inline-flex', gap: 2, background: 'var(--color-surface-alt)', padding: 2, borderRadius: 10 }}>
            {[{ key: 'history', label: 'History' }, { key: 'projections', label: 'Projections' }].map(t => (
              <button
                key={t.key}
                onClick={() => setView(t.key)}
                style={{
                  padding: '6px 14px',
                  border: 'none',
                  background: view === t.key ? 'var(--color-surface)' : 'transparent',
                  boxShadow: view === t.key ? 'var(--shadow-xs)' : 'none',
                  borderRadius: 8,
                  cursor: 'pointer',
                  fontSize: 12,
                  fontWeight: 600,
                  color: view === t.key ? 'var(--color-text-primary)' : 'var(--color-text-secondary)',
                }}
              >
                {t.label}
              </button>
            ))}
          </div>
        </div>
      </div>

      {view === 'history' && (<>
      {/* Stat Cards */}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: 16 }}>
        <StatCard label="Total Income" value={fmt(data.totalIncome)} color={incomeColor} icon="trending_up" />
        <StatCard label="Total Expenses" value={fmt(data.totalExpenses)} color={expenseColor} icon="trending_down" />
        <StatCard label="Net Cash Flow" value={`${data.net >= 0 ? '+' : ''}${fmt(data.net)}`} color={netColor} icon="payments" />
      </div>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: 16 }}>
        <StatCard label="Total Invested" value={fmt(data.totalInvested)} color={investColor} icon="show_chart" />
        <StatCard label="Retirement" value={fmt(data.totalRetirement)} color={retireColor} icon="elderly" />
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

          {/* Income & Expense bars — clickable to show category breakdown */}
          {data.months.map((m, mi) => {
            const cx = xCenter(mi);
            const incH = (m.income / range) * innerH;
            const expH = (m.expenses / range) * innerH;
            return (
              <g key={mi}>
                <rect x={cx - barW - 2} y={yPos(m.income)} width={barW} height={incH}
                  rx={3} fill={incomeColor} opacity={0.85}
                  style={{ cursor: m.income > 0 ? 'pointer' : 'default' }}
                  onClick={() => m.income > 0 && setDrilldown({ monthKey: m.key, kind: 'income' })}>
                  <title>{m.label} {m.year} Income: {fmt(m.income)} (click for categories)</title>
                </rect>
                <rect x={cx + 2} y={yPos(m.expenses)} width={barW} height={expH}
                  rx={3} fill={expenseColor} opacity={0.85}
                  style={{ cursor: m.expenses > 0 ? 'pointer' : 'default' }}
                  onClick={() => m.expenses > 0 && setDrilldown({ monthKey: m.key, kind: 'expenses' })}>
                  <title>{m.label} {m.year} Expenses: {fmt(m.expenses)} (click for categories)</title>
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
              <th style={{ textAlign: 'right', padding: '8px 12px', fontWeight: 600, color: 'var(--color-text-tertiary)' }}>Invested</th>
              <th style={{ textAlign: 'right', padding: '8px 12px', fontWeight: 600, color: 'var(--color-text-tertiary)' }}>Retirement</th>
              <th style={{ textAlign: 'right', padding: '8px 12px', fontWeight: 600, color: 'var(--color-text-tertiary)' }}>Net</th>
              <th style={{ textAlign: 'right', padding: '8px 12px', fontWeight: 600, color: 'var(--color-text-tertiary)' }}>Savings %</th>
            </tr>
          </thead>
          <tbody>
            {[...data.months].reverse().map(m => {
              const savings = m.income > 0 ? (m.income - m.expenses) / m.income : 0;
              const isActiveInc = drilldown && drilldown.monthKey === m.key && drilldown.kind === 'income';
              const isActiveExp = drilldown && drilldown.monthKey === m.key && drilldown.kind === 'expenses';
              return (
                <tr key={m.key} style={{ borderBottom: '1px solid var(--border-ghost)' }}>
                  <td style={{ padding: '10px 12px', fontWeight: 600 }}>{m.label} {m.year}</td>
                  <td
                    onClick={() => m.income > 0 && setDrilldown(isActiveInc ? null : { monthKey: m.key, kind: 'income' })}
                    style={{
                      padding: '10px 12px',
                      textAlign: 'right',
                      color: incomeColor,
                      fontFamily: 'var(--font-headline)',
                      fontWeight: 600,
                      cursor: m.income > 0 ? 'pointer' : 'default',
                      background: isActiveInc ? `${incomeColor}14` : undefined,
                      textDecoration: m.income > 0 ? 'underline dotted' : undefined,
                      textDecorationColor: `${incomeColor}66`,
                      textUnderlineOffset: 3,
                    }}
                    title={m.income > 0 ? 'Click to see categories' : undefined}
                  >
                    {m.income > 0 ? fmt(m.income) : '—'}
                  </td>
                  <td
                    onClick={() => m.expenses > 0 && setDrilldown(isActiveExp ? null : { monthKey: m.key, kind: 'expenses' })}
                    style={{
                      padding: '10px 12px',
                      textAlign: 'right',
                      color: expenseColor,
                      fontFamily: 'var(--font-headline)',
                      fontWeight: 600,
                      cursor: m.expenses > 0 ? 'pointer' : 'default',
                      background: isActiveExp ? `${expenseColor}14` : undefined,
                      textDecoration: m.expenses > 0 ? 'underline dotted' : undefined,
                      textDecorationColor: `${expenseColor}66`,
                      textUnderlineOffset: 3,
                    }}
                    title={m.expenses > 0 ? 'Click to see categories' : undefined}
                  >
                    {m.expenses > 0 ? fmt(m.expenses) : '—'}
                  </td>
                  <td style={{ padding: '10px 12px', textAlign: 'right', color: investColor, fontFamily: 'var(--font-headline)', fontWeight: 600 }}>
                    {m.invested > 0 ? fmt(m.invested) : '—'}
                  </td>
                  <td style={{ padding: '10px 12px', textAlign: 'right', color: retireColor, fontFamily: 'var(--font-headline)', fontWeight: 600 }}>
                    {m.retirement > 0 ? fmt(m.retirement) : '—'}
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

      {/* Revenue Breakdown by Source */}
      {revenueBreakdown && (revenueBreakdown.rows.length > 0 || revenueBreakdown.monthFilter) && (
        <div style={{ background: 'var(--color-surface)', border: `2px solid ${incomeColor}33`, borderRadius: 'var(--radius-xl)', padding: 20, boxShadow: 'var(--shadow-xs)' }}>
          <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: 12, marginBottom: 16 }}>
            <div>
              <div style={{ fontSize: 10, fontWeight: 700, letterSpacing: '0.12em', textTransform: 'uppercase', color: incomeColor }}>
                Revenue Breakdown by Source
                {revenueBreakdown.monthFilter && (() => {
                  const [fy, fm] = revenueBreakdown.monthFilter.split('-');
                  return ` · ${MONTH_SHORT[parseInt(fm, 10) - 1]} ${fy}`;
                })()}
              </div>
              <div style={{ fontFamily: 'var(--font-headline)', fontSize: 22, fontWeight: 700, color: incomeColor, marginTop: 4 }}>
                {fmt(revenueBreakdown.total)} total
              </div>
            </div>
            {revenueBreakdown.monthFilter && (
              <button
                onClick={() => setDrilldown(null)}
                style={{ display: 'inline-flex', alignItems: 'center', gap: 4, padding: '6px 10px', border: '1px solid var(--border-ghost)', background: 'var(--color-surface-alt)', borderRadius: 8, cursor: 'pointer', fontSize: 11, fontWeight: 600, color: 'var(--color-text-secondary)' }}
                title="Show all months"
              >
                <span className="material-symbols-outlined" style={{ fontSize: 14 }}>close</span>
                Clear month filter
              </button>
            )}
          </div>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
            {revenueBreakdown.rows.length === 0 && (
              <div style={{ textAlign: 'center', padding: 24, color: 'var(--color-text-tertiary)', fontSize: 13 }}>
                No revenue this month.
              </div>
            )}
            {revenueBreakdown.rows.map(r => {
              const isExpanded = expandedRevCats.has(r.name);
              return (
                <div key={r.name} style={{ border: '1px solid var(--border-ghost)', borderRadius: 8, padding: 12 }}>
                  <div
                    style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 6, cursor: 'pointer' }}
                    onClick={() => setExpandedRevCats(prev => {
                      const next = new Set(prev);
                      if (next.has(r.name)) next.delete(r.name); else next.add(r.name);
                      return next;
                    })}
                  >
                    <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                      <span className="material-symbols-outlined" style={{ fontSize: 16, color: 'var(--color-text-tertiary)', transition: 'transform 0.15s', transform: isExpanded ? 'rotate(90deg)' : 'rotate(0deg)' }}>
                        chevron_right
                      </span>
                      <span style={{ fontFamily: 'var(--font-headline)', fontSize: 14, fontWeight: 700 }}>{r.name}</span>
                      <span style={{ fontSize: 11, color: 'var(--color-text-tertiary)' }}>({r.count} txn{r.count !== 1 ? 's' : ''})</span>
                    </div>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                      <span style={{ fontFamily: 'var(--font-headline)', fontSize: 14, fontWeight: 700, color: incomeColor }}>{fmt(r.total)}</span>
                      <span style={{ fontSize: 11, fontWeight: 600, color: 'var(--color-text-tertiary)', minWidth: 36, textAlign: 'right' }}>{Math.round(r.pct * 100)}%</span>
                    </div>
                  </div>
                  <div style={{ height: 5, background: 'var(--color-surface-alt)', borderRadius: 3, overflow: 'hidden', marginBottom: isExpanded ? 10 : 0 }}>
                    <div style={{ height: '100%', width: `${r.pct * 100}%`, background: incomeColor, opacity: 0.85 }} />
                  </div>
                  {isExpanded && (
                    <div style={{ display: 'flex', flexDirection: 'column', gap: 2, paddingLeft: 12 }}>
                      {r.txns.map((tx, idx) => (
                        <div key={idx} style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', fontSize: 12, color: 'var(--color-text-secondary)', padding: '4px 0', borderBottom: idx < r.txns.length - 1 ? '1px solid var(--color-surface-alt, #f0f0f0)' : 'none' }}>
                          <div style={{ display: 'flex', flexDirection: 'column', gap: 1, minWidth: 0, flex: 1, marginRight: 12 }}>
                            <span style={{ fontWeight: 600, color: 'var(--color-text-primary)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{tx.description}</span>
                            <span style={{ fontSize: 10.5, color: 'var(--color-text-tertiary)' }}>{tx.date}</span>
                          </div>
                          <span style={{ fontFamily: 'var(--font-headline)', fontWeight: 600, whiteSpace: 'nowrap' }}>{fmt(tx.amount)}</span>
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        </div>
      )}

      {/* Drilldown panel */}
      {drilldownData && (() => {
        const [y, m] = drilldownData.monthKey.split('-');
        const monthName = MONTH_SHORT[parseInt(m, 10) - 1];
        const color = drilldownData.kind === 'income' ? incomeColor : expenseColor;
        const heading = drilldownData.kind === 'income' ? 'Income' : 'Expenses';
        return (
          <div style={{ background: 'var(--color-surface)', border: `2px solid ${color}33`, borderRadius: 'var(--radius-xl)', padding: 20, boxShadow: 'var(--shadow-xs)' }}>
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 16 }}>
              <div>
                <div style={{ fontSize: 10, fontWeight: 700, letterSpacing: '0.12em', textTransform: 'uppercase', color }}>
                  {heading} · {monthName} {y}
                </div>
                <div style={{ fontFamily: 'var(--font-headline)', fontSize: 22, fontWeight: 700, color, marginTop: 4 }}>
                  {fmt(drilldownData.total)} total
                </div>
              </div>
              <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                <button
                  onClick={() => exportMonthCsv(drilldownData.monthKey, drilldownData.kind)}
                  style={{ display: 'inline-flex', alignItems: 'center', gap: 6, padding: '8px 12px', border: '1px solid var(--border-ghost)', background: 'var(--color-surface-alt)', borderRadius: 8, cursor: 'pointer', fontSize: 12, fontWeight: 600, color: 'var(--color-text-secondary)' }}
                  title={`Export ${heading.toLowerCase()} for ${monthName} ${y} to CSV`}
                >
                  <span className="material-symbols-outlined" style={{ fontSize: 16 }}>download</span>
                  Export CSV
                </button>
                <button
                  onClick={() => setDrilldown(null)}
                  style={{ width: 32, height: 32, border: 'none', background: 'var(--color-surface-alt)', borderRadius: 8, cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center' }}
                  title="Close"
                >
                  <span className="material-symbols-outlined" style={{ fontSize: 18 }}>close</span>
                </button>
              </div>
            </div>
            {drilldownData.rows.length === 0 ? (
              <div style={{ textAlign: 'center', padding: 24, color: 'var(--color-text-tertiary)', fontSize: 13 }}>No transactions</div>
            ) : (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
                {drilldownData.rows.map(r => {
                  const isExpanded = expandedDrillCats.has(r.name);
                  return (
                  <div key={r.name} style={{ border: '1px solid var(--border-ghost)', borderRadius: 8, padding: 12 }}>
                    <div
                      style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 6, cursor: 'pointer' }}
                      onClick={() => setExpandedDrillCats(prev => {
                        const next = new Set(prev);
                        if (next.has(r.name)) next.delete(r.name); else next.add(r.name);
                        return next;
                      })}
                    >
                      <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                        <span className="material-symbols-outlined" style={{ fontSize: 16, color: 'var(--color-text-tertiary)', transition: 'transform 0.15s', transform: isExpanded ? 'rotate(90deg)' : 'rotate(0deg)' }}>
                          chevron_right
                        </span>
                        <span style={{ fontFamily: 'var(--font-headline)', fontSize: 14, fontWeight: 700 }}>{r.name}</span>
                        <span style={{ fontSize: 11, color: 'var(--color-text-tertiary)' }}>({r.count} txn{r.count !== 1 ? 's' : ''})</span>
                      </div>
                      <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                        <span style={{ fontFamily: 'var(--font-headline)', fontSize: 14, fontWeight: 700, color }}>{fmt(r.total)}</span>
                        <span style={{ fontSize: 11, fontWeight: 600, color: 'var(--color-text-tertiary)', minWidth: 36, textAlign: 'right' }}>{Math.round(r.pct * 100)}%</span>
                      </div>
                    </div>
                    <div style={{ height: 5, background: 'var(--color-surface-alt)', borderRadius: 3, overflow: 'hidden', marginBottom: (isExpanded || r.subs.length) ? 10 : 0 }}>
                      <div style={{ height: '100%', width: `${r.pct * 100}%`, background: color, opacity: 0.85 }} />
                    </div>
                    {!isExpanded && r.subs.length > 0 && (
                      <div style={{ display: 'flex', flexDirection: 'column', gap: 4, paddingLeft: 12 }}>
                        {r.subs.map(s => (
                          <div key={s.name} style={{ display: 'flex', justifyContent: 'space-between', fontSize: 12, color: 'var(--color-text-secondary)' }}>
                            <span>— {s.name}</span>
                            <span style={{ fontFamily: 'var(--font-headline)', fontWeight: 600 }}>{fmt(s.total)}</span>
                          </div>
                        ))}
                      </div>
                    )}
                    {isExpanded && (
                      <div style={{ display: 'flex', flexDirection: 'column', gap: 2, paddingLeft: 12 }}>
                        {r.txns.map((tx, idx) => (
                          <div key={idx} style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', fontSize: 12, color: 'var(--color-text-secondary)', padding: '4px 0', borderBottom: idx < r.txns.length - 1 ? '1px solid var(--color-surface-alt, #f0f0f0)' : 'none' }}>
                            <div style={{ display: 'flex', flexDirection: 'column', gap: 1, minWidth: 0, flex: 1, marginRight: 12 }}>
                              <span style={{ fontWeight: 600, color: 'var(--color-text-primary)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{tx.description}</span>
                              <span style={{ fontSize: 10.5, color: 'var(--color-text-tertiary)' }}>
                                {tx.date}{tx.sub ? ` · ${tx.sub}` : ''}
                              </span>
                            </div>
                            <span style={{ fontFamily: 'var(--font-headline)', fontWeight: 600, whiteSpace: 'nowrap' }}>{fmt(tx.amount)}</span>
                          </div>
                        ))}
                      </div>
                    )}
                  </div>
                  );
                })}
              </div>
            )}
          </div>
        );
      })()}
      </>)}

      {view === 'projections' && (() => {
        const p = thisMonthProjection;
        const projNet = p.projectedIncome - p.projectedExpenses;
        const mtdNet = p.mtdIncome - p.mtdExpenses;
        const remainingNet = p.remainingIncome - p.remainingExpenses;
        const projNetColor = projNet >= 0 ? incomeColor : expenseColor;
        const monthPct = p.daysInMonth > 0 ? Math.min(100, Math.round((p.daysElapsed / p.daysInMonth) * 100)) : 0;
        const today = new Date();
        const ccTotal = cardPayments.reduce((s, cp) => s + cp.avgAmount, 0);

        if (!p.hasHistory && p.mtdIncome === 0 && p.mtdExpenses === 0) {
          return (
            <div style={{ background: 'var(--color-surface)', border: 'var(--border-ghost)', borderRadius: 'var(--radius-xl)', padding: 40, boxShadow: 'var(--shadow-xs)', textAlign: 'center', color: 'var(--color-text-tertiary)', fontSize: 13 }}>
              Not enough history yet to project this month. Import a few months of transactions and check back.
            </div>
          );
        }

        return (
          <>
            {/* Month progress */}
            <div style={{ background: 'var(--color-surface)', border: 'var(--border-ghost)', borderRadius: 'var(--radius-xl)', padding: 20, boxShadow: 'var(--shadow-xs)' }}>
              <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 12, flexWrap: 'wrap', gap: 8 }}>
                <div style={{ fontSize: 10, fontWeight: 700, letterSpacing: '0.12em', textTransform: 'uppercase', color: 'var(--color-text-tertiary)' }}>
                  {p.monthLabel} progress
                </div>
                <div style={{ fontSize: 12, color: 'var(--color-text-secondary)' }}>
                  Day {p.daysElapsed} of {p.daysInMonth} · {p.daysRemaining} day{p.daysRemaining !== 1 ? 's' : ''} remaining
                </div>
              </div>
              <div style={{ height: 8, background: 'var(--color-surface-alt)', borderRadius: 4, overflow: 'hidden' }}>
                <div style={{ height: '100%', width: `${monthPct}%`, background: 'var(--color-text-primary)', opacity: 0.4 }} />
              </div>
            </div>

            {/* Stat cards */}
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: 16 }}>
              <StatCard label={`Projected Income (${p.monthLabel})`} value={fmt(p.projectedIncome)} color={incomeColor} icon="trending_up" />
              <StatCard label={`Projected Expenses (${p.monthLabel})`} value={fmt(p.projectedExpenses)} color={expenseColor} icon="trending_down" />
              <StatCard label="Projected Net" value={`${projNet >= 0 ? '+' : ''}${fmt(projNet)}`} color={projNetColor} icon="payments" />
            </div>

            {/* MTD vs remaining breakdown */}
            <div style={{ background: 'var(--color-surface)', border: 'var(--border-ghost)', borderRadius: 'var(--radius-xl)', padding: 20, boxShadow: 'var(--shadow-xs)' }}>
              <div style={{ fontSize: 10, fontWeight: 700, letterSpacing: '0.12em', textTransform: 'uppercase', color: 'var(--color-text-tertiary)', marginBottom: 12 }}>
                So far vs. projected remainder
              </div>
              <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
                <thead>
                  <tr style={{ borderBottom: '1px solid var(--border-ghost)' }}>
                    <th style={{ textAlign: 'left', padding: '8px 12px', fontWeight: 600, color: 'var(--color-text-tertiary)' }}></th>
                    <th style={{ textAlign: 'right', padding: '8px 12px', fontWeight: 600, color: 'var(--color-text-tertiary)' }}>So far ({p.daysElapsed}d)</th>
                    <th style={{ textAlign: 'right', padding: '8px 12px', fontWeight: 600, color: 'var(--color-text-tertiary)' }}>Projected remainder ({p.daysRemaining}d)</th>
                    <th style={{ textAlign: 'right', padding: '8px 12px', fontWeight: 600, color: 'var(--color-text-tertiary)' }}>Total</th>
                  </tr>
                </thead>
                <tbody>
                  <tr style={{ borderBottom: '1px solid var(--border-ghost)' }}>
                    <td style={{ padding: '10px 12px', fontWeight: 600 }}>Income</td>
                    <td style={{ padding: '10px 12px', textAlign: 'right', color: incomeColor, fontFamily: 'var(--font-headline)', fontWeight: 600 }}>{fmt(p.mtdIncome)}</td>
                    <td style={{ padding: '10px 12px', textAlign: 'right', color: incomeColor, fontFamily: 'var(--font-headline)', fontWeight: 600, opacity: 0.7 }}>{fmt(p.remainingIncome)}</td>
                    <td style={{ padding: '10px 12px', textAlign: 'right', color: incomeColor, fontFamily: 'var(--font-headline)', fontWeight: 700 }}>{fmt(p.projectedIncome)}</td>
                  </tr>
                  <tr style={{ borderBottom: '1px solid var(--border-ghost)' }}>
                    <td style={{ padding: '10px 12px', fontWeight: 600 }}>Expenses</td>
                    <td style={{ padding: '10px 12px', textAlign: 'right', color: expenseColor, fontFamily: 'var(--font-headline)', fontWeight: 600 }}>{fmt(p.mtdExpenses)}</td>
                    <td style={{ padding: '10px 12px', textAlign: 'right', color: expenseColor, fontFamily: 'var(--font-headline)', fontWeight: 600, opacity: 0.7 }}>{fmt(p.remainingExpenses)}</td>
                    <td style={{ padding: '10px 12px', textAlign: 'right', color: expenseColor, fontFamily: 'var(--font-headline)', fontWeight: 700 }}>{fmt(p.projectedExpenses)}</td>
                  </tr>
                  <tr>
                    <td style={{ padding: '10px 12px', fontWeight: 600 }}>Net</td>
                    <td style={{ padding: '10px 12px', textAlign: 'right', color: mtdNet >= 0 ? incomeColor : expenseColor, fontFamily: 'var(--font-headline)', fontWeight: 700 }}>{mtdNet >= 0 ? '+' : ''}{fmt(mtdNet)}</td>
                    <td style={{ padding: '10px 12px', textAlign: 'right', color: remainingNet >= 0 ? incomeColor : expenseColor, fontFamily: 'var(--font-headline)', fontWeight: 700, opacity: 0.7 }}>{remainingNet >= 0 ? '+' : ''}{fmt(remainingNet)}</td>
                    <td style={{ padding: '10px 12px', textAlign: 'right', color: projNetColor, fontFamily: 'var(--font-headline)', fontWeight: 700 }}>{projNet >= 0 ? '+' : ''}{fmt(projNet)}</td>
                  </tr>
                </tbody>
              </table>
              <div style={{ marginTop: 12, fontSize: 11, color: 'var(--color-text-tertiary)' }}>
                Projected remainder = (days remaining ÷ {p.daysInMonth}) × baseline. Baseline blends a 6-month trailing average with the same calendar month from prior history when available.
              </div>
            </div>

            {/* Upcoming credit card payments */}
            <div style={{ background: 'var(--color-surface)', border: 'var(--border-ghost)', borderRadius: 'var(--radius-xl)', padding: 20, boxShadow: 'var(--shadow-xs)' }}>
              <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 12, flexWrap: 'wrap', gap: 8 }}>
                <div style={{ fontSize: 10, fontWeight: 700, letterSpacing: '0.12em', textTransform: 'uppercase', color: 'var(--color-text-tertiary)' }}>
                  Upcoming Credit Card Payments
                </div>
                {cardPayments.length > 0 && (
                  <div style={{ fontSize: 13, fontWeight: 700, fontFamily: 'var(--font-headline)' }}>
                    {fmt(ccTotal)} <span style={{ fontSize: 11, fontWeight: 600, color: 'var(--color-text-tertiary)' }}>total expected</span>
                  </div>
                )}
              </div>
              {cardPayments.length === 0 ? (
                <div style={{ textAlign: 'center', padding: 24, color: 'var(--color-text-tertiary)', fontSize: 13 }}>
                  No credit card payment history detected yet. Once you have at least one Credit Card Payment transaction, projections will appear here.
                </div>
              ) : (
                <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
                  <thead>
                    <tr style={{ borderBottom: '1px solid var(--border-ghost)' }}>
                      <th style={{ textAlign: 'left', padding: '8px 12px', fontWeight: 600, color: 'var(--color-text-tertiary)' }}>Card</th>
                      <th style={{ textAlign: 'left', padding: '8px 12px', fontWeight: 600, color: 'var(--color-text-tertiary)' }}>Due</th>
                      <th style={{ textAlign: 'right', padding: '8px 12px', fontWeight: 600, color: 'var(--color-text-tertiary)' }}>Expected Amount</th>
                      <th style={{ textAlign: 'right', padding: '8px 12px', fontWeight: 600, color: 'var(--color-text-tertiary)' }}>Last Payment</th>
                    </tr>
                  </thead>
                  <tbody>
                    {cardPayments.map(cp => {
                      const due = new Date(cp.nextDate);
                      const daysUntil = Math.ceil((due - today) / 86400000);
                      const dueLabel = due.toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' });
                      const last = new Date(cp.lastDate);
                      const dueColor = daysUntil <= 0 ? expenseColor : daysUntil <= 7 ? '#e8a317' : 'var(--color-text-primary)';
                      return (
                        <tr key={cp.card} style={{ borderBottom: '1px solid var(--border-ghost)' }}>
                          <td style={{ padding: '10px 12px', fontWeight: 600 }}>{cp.card}</td>
                          <td style={{ padding: '10px 12px' }}>
                            <div style={{ fontWeight: 600, color: dueColor }}>{dueLabel}</div>
                            <div style={{ fontSize: 11, color: 'var(--color-text-tertiary)' }}>
                              {daysUntil <= 0 ? 'due today' : `in ${daysUntil} day${daysUntil === 1 ? '' : 's'}`}
                            </div>
                          </td>
                          <td style={{ padding: '10px 12px', textAlign: 'right', fontFamily: 'var(--font-headline)', fontWeight: 700 }}>
                            {fmt(cp.avgAmount)}
                          </td>
                          <td style={{ padding: '10px 12px', textAlign: 'right', color: 'var(--color-text-tertiary)', fontSize: 12 }}>
                            {fmt(cp.lastAmount)} on {last.toLocaleDateString('en-US', { month: 'short', day: 'numeric' })}
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              )}
              <div style={{ marginTop: 12, fontSize: 11, color: 'var(--color-text-tertiary)' }}>
                Estimated from each card's Credit Card Payment transaction history (cadence + average amount).
              </div>
            </div>
          </>
        );
      })()}
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
