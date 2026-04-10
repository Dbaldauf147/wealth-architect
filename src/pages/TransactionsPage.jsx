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

function PieChart({ entries, total, size = 160 }) {
  if (!entries.length || total === 0) return null;
  const cx = size / 2;
  const cy = size / 2;
  const r = size / 2 - 4;
  const inner = r * 0.55;
  let currentAngle = -Math.PI / 2;
  const slices = entries.map(e => {
    const pct = e.value / total;
    const angle = pct * Math.PI * 2;
    const startAngle = currentAngle;
    const endAngle = currentAngle + angle;
    currentAngle = endAngle;
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
    return { d, color: catColor(e.name), name: e.name, pct };
  });
  return (
    <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`}>
      {slices.map((s, i) => (
        <path key={i} d={s.d} fill={s.color}>
          <title>{s.name}: {Math.round(s.pct * 100)}%</title>
        </path>
      ))}
    </svg>
  );
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
  const { transactions, analytics, loading, updateTransactionCategory, updateTransactionSubcategory, bulkUpdateCategoryByIds, addCategoryRule, customCategories, addCustomCategory, getMatchCount, toggleHideTransaction, hiddenTransactions, hiddenCount } = useData();
  const [editingSubId, setEditingSubId] = useState(null);
  const [subSearchText, setSubSearchText] = useState('');
  const subDropdownRef = useRef(null);
  const [activeAccount, setActiveAccount] = useState('all');
  const [searchQuery, setSearchQuery] = useState('');
  const [page, setPage] = useState(0);
  const [editingId, setEditingId] = useState(null);
  const [newCategoryText, setNewCategoryText] = useState('');
  const [showHidden, setShowHidden] = useState(false);
  const [sortCol, setSortCol] = useState('date');
  const [sortDir, setSortDir] = useState('desc');
  const [pendingRule, setPendingRule] = useState(null);
  const [selectedIds, setSelectedIds] = useState(new Set());
  const [bulkCategoryOpen, setBulkCategoryOpen] = useState(false);
  const [bulkCategorySearch, setBulkCategorySearch] = useState('');
  const [bulkSubOpen, setBulkSubOpen] = useState(false);
  const [bulkSubSearch, setBulkSubSearch] = useState('');
  const bulkSubRef = useRef(null);
  const [savedToast, setSavedToast] = useState(false);
  const [includedCategories, setIncludedCategories] = useState(new Set());
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

  /* All categories from data + defaults + custom */
  const categoryOptions = useMemo(() => {
    const fromData = (transactions || []).map(t => t.category).filter(Boolean);
    return [...new Set([...ALL_CATEGORIES, ...fromData, ...customCategories])].sort();
  }, [transactions, customCategories]);

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
        case 'subcategory': cmp = (a.subcategory || '').localeCompare(b.subcategory || ''); break;
        case 'institution': cmp = (a.institution || '').localeCompare(b.institution || ''); break;
        default: cmp = 0;
      }
      return sortDir === 'asc' ? cmp : -cmp;
    });
    return sorted;
  }, [transactions, activeAccount, searchQuery, includedCategories, sortCol, sortDir]);

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

  /* Pie chart data — categories, or subcategories if only 1 category filtered */
  const pieData = useMemo(() => {
    const source = filtered.filter(t => t.amount < 0);
    const visibleCats = [...new Set(source.map(t => t.category || 'Uncategorized'))];
    const drillDown = visibleCats.length === 1;
    const groups = {};
    for (const t of source) {
      const key = drillDown
        ? (t.subcategory || 'Uncategorized')
        : (t.category || 'Uncategorized');
      if (!groups[key]) groups[key] = 0;
      groups[key] += Math.abs(t.amount);
    }
    const entries = Object.entries(groups)
      .map(([name, value]) => ({ name, value }))
      .sort((a, b) => b.value - a.value);
    const total = entries.reduce((s, e) => s + e.value, 0);
    return { entries, total, drillDown, parent: drillDown ? visibleCats[0] : null };
  }, [filtered]);

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
          </div>
          <div className={styles.bucketItems}>
            {activeCategories.filter(c => !organizedCategories.has(c)).map(cat => {
              const color = catColor(cat);
              const bg = catBg(cat);
              return (
                <div
                  key={cat}
                  className={styles.bucketChip}
                  draggable
                  onDragStart={() => setDraggedCategory(cat)}
                  onDragEnd={() => setDraggedCategory(null)}
                  style={{ background: bg, color, borderColor: color + '30' }}
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
          </div>
          <div className={styles.bucketItems}>
            {activeCategories.filter(c => organizedCategories.has(c)).map(cat => {
              const color = catColor(cat);
              const bg = catBg(cat);
              return (
                <div
                  key={cat}
                  className={styles.bucketChip}
                  draggable
                  onDragStart={() => setDraggedCategory(cat)}
                  onDragEnd={() => setDraggedCategory(null)}
                  style={{ background: bg, color, borderColor: color + '30' }}
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

      {/* Category Filters */}
      <div className={styles.categoryFilterBar}>
        <span className={styles.categoryFilterLabel}>Categories:</span>
        <button
          className={`${styles.categoryFilterBox} ${includedCategories.size === activeCategories.length ? styles.categoryFilterSelectAll : ''}`}
          onClick={() => {
            if (includedCategories.size === activeCategories.length) {
              setIncludedCategories(new Set());
            } else {
              setIncludedCategories(new Set(activeCategories));
            }
            setPage(0);
          }}
          type="button"
        >
          <span className="material-symbols-outlined" style={{ fontSize: 14 }}>
            {includedCategories.size === activeCategories.length ? 'check_box' : includedCategories.size > 0 ? 'indeterminate_check_box' : 'check_box_outline_blank'}
          </span>
          Select All
        </button>
        {activeCategories.map(cat => {
          const included = includedCategories.has(cat);
          const color = catColor(cat);
          const bg = catBg(cat);
          return (
            <button
              key={cat}
              className={`${styles.categoryFilterBox} ${!included ? styles.categoryFilterExcluded : ''}`}
              style={included ? { background: bg, color, borderColor: color + '30' } : {}}
              onClick={() => toggleCategoryFilter(cat)}
              type="button"
            >
              <span className="material-symbols-outlined" style={{ fontSize: 14 }}>
                {included ? 'check_box' : 'check_box_outline_blank'}
              </span>
              {cat}
            </button>
          );
        })}
        {includedCategories.size > 0 && (
          <button className={styles.categoryFilterClear} onClick={clearCategoryFilters} type="button">
            Clear filters
          </button>
        )}
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
                <div
                  key={sub}
                  className={styles.categoryOption}
                  onClick={() => handleBulkSubcategory(sub)}
                >
                  {sub}
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
                  { key: 'category', label: 'Category' },
                  { key: 'subcategory', label: 'Subcategory' },
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
                          {t.category && (
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
                    <td style={{ position: 'relative' }}>
                      {(() => {
                        const subKey = t.transactionId || i;
                        const subs = SUBCATEGORIES[t.category] || [];
                        const allSubs = [...new Set([...subs, ...(transactions || []).filter(tx => tx.category === t.category && tx.subcategory).map(tx => tx.subcategory)])].sort();
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
                                      updateTransactionSubcategory(t.transactionId, subSearchText.trim());
                                      flashSaved();
                                      setEditingSubId(null);
                                      setSubSearchText('');
                                    }
                                  }}
                                  autoFocus
                                />
                                {t.subcategory && (
                                  <div
                                    className={styles.categoryOption}
                                    style={{ color: '#ba1a1a' }}
                                    onClick={() => {
                                      updateTransactionSubcategory(t.transactionId, '');
                                      flashSaved();
                                      setEditingSubId(null);
                                      setSubSearchText('');
                                    }}
                                  >
                                    <span className="material-symbols-outlined" style={{ fontSize: 14 }}>close</span>
                                    Clear subcategory
                                  </div>
                                )}
                                {subSearchText.trim() && !allSubs.some(s => s.toLowerCase() === subSearchText.trim().toLowerCase()) && (
                                  <div
                                    className={styles.categoryOption}
                                    style={{ color: '#0058be', fontWeight: 600 }}
                                    onClick={() => {
                                      updateTransactionSubcategory(t.transactionId, subSearchText.trim());
                                      flashSaved();
                                      setEditingSubId(null);
                                      setSubSearchText('');
                                    }}
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
                                    onClick={() => {
                                      updateTransactionSubcategory(t.transactionId, sub);
                                      flashSaved();
                                      setEditingSubId(null);
                                      setSubSearchText('');
                                    }}
                                  >
                                    {sub}
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
              <div className={styles.sectionLabel}>
                {pieData.drillDown ? `${pieData.parent} — Subcategories` : 'Category Breakdown'}
              </div>
              <div className={styles.pieChartWrap}>
                <PieChart entries={pieData.entries} total={pieData.total} size={160} />
                <div className={styles.pieCenter}>
                  <div className={styles.pieCenterValue}>{fmt(pieData.total)}</div>
                  <div className={styles.pieCenterLabel}>total</div>
                </div>
              </div>
              <div className={styles.pieLegend}>
                {pieData.entries.slice(0, 8).map(e => (
                  <div key={e.name} className={styles.pieLegendItem}>
                    <span className={styles.pieLegendDot} style={{ background: catColor(e.name) }} />
                    <span className={styles.pieLegendName}>{e.name}</span>
                    <span className={styles.pieLegendPct}>{Math.round((e.value / pieData.total) * 100)}%</span>
                  </div>
                ))}
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

      {/* Saved toast */}
      <div className={`${styles.savedToast} ${savedToast ? styles.savedToastVisible : ''}`}>
        <span className="material-symbols-outlined" style={{ fontSize: 16 }}>check_circle</span>
        Saved!
      </div>
    </div>
  );
}
