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

function formatDate(dateStr) {
  if (!dateStr) return '';
  const d = new Date(dateStr);
  if (isNaN(d)) return dateStr;
  return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
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
];

export function TransactionsPage() {
  const { transactions, analytics, loading, updateTransactionCategory, addCategoryRule, getMatchCount, toggleHideTransaction, hiddenTransactions, hiddenCount } = useData();
  const [activeAccount, setActiveAccount] = useState('all');
  const [searchQuery, setSearchQuery] = useState('');
  const [page, setPage] = useState(0);
  const [editingId, setEditingId] = useState(null);
  const [newCategoryText, setNewCategoryText] = useState('');
  const [showHidden, setShowHidden] = useState(false);
  const [sortCol, setSortCol] = useState('date');
  const [sortDir, setSortDir] = useState('desc');
  const [pendingRule, setPendingRule] = useState(null); // { transactionId, index, description, amount, newCategory, matchCount }
  const dropdownRef = useRef(null);
  const confirmRef = useRef(null);

  function handleSort(col) {
    console.log('SORT CLICKED:', col, 'current:', sortCol, sortDir);
    if (sortCol === col) {
      setSortDir(d => d === 'asc' ? 'desc' : 'asc');
    } else {
      setSortCol(col);
      setSortDir(col === 'date' ? 'desc' : 'asc');
    }
    setPage(0);
  }

  /* Close dropdown / confirm on outside click */
  useEffect(() => {
    function handleClick(e) {
      if (confirmRef.current && confirmRef.current.contains(e.target)) return;
      if (dropdownRef.current && !dropdownRef.current.contains(e.target)) {
        setEditingId(null);
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

  function handleCategorySelect(t, i, newCategory) {
    if (newCategory === t.category) {
      setEditingId(null);
      setNewCategoryText('');
      return;
    }
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
      setEditingId(null);
      setNewCategoryText('');
    }
  }

  /* All categories from data + defaults */
  const categoryOptions = useMemo(() => {
    const fromData = (transactions || []).map(t => t.category).filter(Boolean);
    return [...new Set([...ALL_CATEGORIES, ...fromData])].sort();
  }, [transactions]);

  /* Account pill list */
  const accountNames = useMemo(
    () => analytics?.accountNames || [],
    [analytics],
  );

  /* Filtered + sorted transactions */
  const filtered = useMemo(() => {
    let list = transactions || [];
    if (activeAccount !== 'all') {
      list = list.filter(t => t.account === activeAccount);
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
    const sorted = [...list].sort((a, b) => {
      let cmp = 0;
      switch (sortCol) {
        case 'merchant': cmp = (a.description || '').localeCompare(b.description || ''); break;
        case 'category': cmp = (a.category || '').localeCompare(b.category || ''); break;
        case 'amount': cmp = a.amount - b.amount; break;
        case 'date': cmp = new Date(a.date || 0) - new Date(b.date || 0); break;
        case 'account': cmp = (a.account || '').localeCompare(b.account || ''); break;
        case 'institution': cmp = (a.institution || '').localeCompare(b.institution || ''); break;
        default: cmp = 0;
      }
      return sortDir === 'asc' ? cmp : -cmp;
    });
    return sorted;
  }, [transactions, activeAccount, searchQuery, sortCol, sortDir]);

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
        <button className={styles.exportBtn}>
          <span className="material-symbols-outlined">download</span>
          Export CSV
        </button>
      </div>

      {/* Filter Bar */}
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
                    onClick={() => toggleHideTransaction(t.transactionId)}
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

      {/* Main Grid */}
      <div className={styles.mainGrid}>
        {/* Table */}
        <div className={styles.tableCard}>
          <table className={styles.table}>
            <thead>
              <tr>
                {[
                  { key: 'merchant', label: 'Merchant' },
                  { key: 'category', label: 'Category' },
                  { key: 'amount', label: 'Amount' },
                  { key: 'date', label: 'Date' },
                  { key: 'account', label: 'Account' },
                  { key: 'institution', label: 'Institution' },
                ].map(col => (
                  <th key={col.key}>
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
                  </th>
                ))}
                <th style={{ width: 40 }}></th>
              </tr>
            </thead>
            <tbody>
              {paginated.map((t, i) => {
                const icon = getCategoryIcon(t.category);
                const color = catColor(t.category || 'Uncategorized');
                const bg = catBg(t.category || 'Uncategorized');
                return (
                  <tr key={t.transactionId || i}>
                    <td>
                      <div className={styles.merchantCell}>
                        <div
                          className={styles.merchantIcon}
                          style={{ background: bg, color }}
                        >
                          <span className="material-symbols-outlined">{icon}</span>
                        </div>
                        <div>
                          <div className={styles.merchantName}>{t.description}</div>
                          <div className={styles.merchantSub}>
                            {t.fullDescription && t.fullDescription !== t.description
                              ? t.fullDescription.slice(0, 60)
                              : t.category}
                          </div>
                        </div>
                      </div>
                    </td>
                    <td style={{ position: 'relative' }}>
                      <span
                        className={styles.categoryBadge}
                        style={{ background: bg, color, cursor: 'pointer' }}
                        title="Click to change category"
                        onClick={() => setEditingId(editingId === (t.transactionId || i) ? null : (t.transactionId || i))}
                      >
                        {t.category || 'Uncategorized'}
                        <span className="material-symbols-outlined" style={{ fontSize: 12, marginLeft: 2 }}>edit</span>
                      </span>
                      {editingId === (t.transactionId || i) && (
                        <div className={styles.categoryDropdown} ref={dropdownRef}>
                          <input
                            className={styles.categorySearch}
                            type="text"
                            placeholder="Search or type new..."
                            value={newCategoryText}
                            onChange={e => setNewCategoryText(e.target.value)}
                            onKeyDown={e => {
                              if (e.key === 'Enter' && newCategoryText.trim()) {
                                handleCategorySelect(t, i, newCategoryText.trim());
                              }
                            }}
                            autoFocus
                          />
                          {newCategoryText.trim() && !categoryOptions.some(c => c.toLowerCase() === newCategoryText.trim().toLowerCase()) && (
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
                            .filter(cat => !newCategoryText || cat.toLowerCase().includes(newCategoryText.toLowerCase()))
                            .map(cat => (
                            <div
                              key={cat}
                              className={`${styles.categoryOption} ${cat === t.category ? styles.categoryOptionActive : ''}`}
                              onClick={() => handleCategorySelect(t, i, cat)}
                            >
                              <span className="material-symbols-outlined" style={{ fontSize: 14, color: catColor(cat) }}>
                                {getCategoryIcon(cat)}
                              </span>
                              {cat}
                            </div>
                          ))}
                        </div>
                      )}
                    </td>
                    <td>
                      <span className={t.amount >= 0 ? styles.amountCredit : styles.amountDebit}>
                        {t.amount >= 0 ? '+' : ''}{fmt(t.amount)}
                      </span>
                    </td>
                    <td className={styles.dateCell}>{formatDate(t.date)}</td>
                    <td>
                      <div className={styles.accountCell}>
                        <div className={styles.accountDot} style={{ background: catColor(t.account || 'Unknown') }} />
                        {t.account}
                      </div>
                    </td>
                    <td className={styles.institutionCell}>{t.institution}</td>
                    <td>
                      <button
                        className={styles.hideBtn}
                        title="Hide from reporting"
                        onClick={() => toggleHideTransaction(t.transactionId)}
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
                  setPendingRule(null);
                }}
              >
                Just this one
              </button>
              <button
                className={styles.ruleBtnPrimary}
                onClick={() => {
                  addCategoryRule(pendingRule.description, pendingRule.amount, pendingRule.newCategory);
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
    </div>
  );
}
