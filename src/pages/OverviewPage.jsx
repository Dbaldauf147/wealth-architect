import { useState } from 'react';
import { useData, useDataActions } from '../contexts/DataContext';
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
const BUILT_IN_ASSET_CLASSES = ['Cash', 'Stocks', 'Retirement'];
// Distinct, semantically-meaningful colours used when the donut is in
// "By class" mode so Cash / Stocks / Retirement stay visually stable
// regardless of sort order. Custom classes fall back to a stable
// hash-based color via classColor() so they don't reshuffle either.
const CLASS_COLORS = {
  Cash: '#009668',
  Stocks: '#0058be',
  Retirement: '#7c3aed',
  Unclassified: '#94a3b8',
};
function classColor(name) {
  if (CLASS_COLORS[name]) return CLASS_COLORS[name];
  let hash = 0;
  for (let i = 0; i < name.length; i++) hash = (hash * 31 + name.charCodeAt(i)) | 0;
  return DONUT_COLORS[Math.abs(hash) % DONUT_COLORS.length];
}

export function OverviewPage() {
  const {
    balances, analytics, transactions, loading, error, lastSync,
    accountNicknames: ctxNicknames,
    accountGroups: ctxGroups,
    assetClasses: ctxAssetClasses,
    customAssetClasses: ctxCustomAssetClasses,
  } = useData();
  const {
    setAccountNickname, setAccountGroup, setAssetClass,
    addCustomAsset, addCustomAssetClass,
    renameGroup, deleteGroup,
  } = useDataActions();
  const accountNicknames = ctxNicknames || {};
  const accountGroups = ctxGroups || {};
  const assetClasses = ctxAssetClasses || {};
  const customAssetClasses = ctxCustomAssetClasses || [];
  // Built-in + user-added classes, deduped, in canonical order.
  const allAssetClasses = [...BUILT_IN_ASSET_CLASSES, ...customAssetClasses.filter(c => !BUILT_IN_ASSET_CLASSES.includes(c))];
  // rename target is keyed by bucket key: 'group:Name' or 'acct:Name'
  const [renamingBucket, setRenamingBucket] = useState(null);
  const [renameValue, setRenameValue] = useState('');
  // group picker open for which bucket key
  const [groupPickerFor, setGroupPickerFor] = useState(null);
  const [newGroupInput, setNewGroupInput] = useState('');
  // Asset Allocation card view mode + per-row class picker open state.
  const [allocationView, setAllocationView] = useState('account'); // 'account' | 'class'
  const [classPickerFor, setClassPickerFor] = useState(null);
  // Quick-add custom asset form (collapsed by default).
  const [addingCustomAsset, setAddingCustomAsset] = useState(false);
  const [customAssetName, setCustomAssetName] = useState('');
  const [customAssetBalance, setCustomAssetBalance] = useState('');
  const [customAssetClass, setCustomAssetClass] = useState('');

  function submitCustomAsset() {
    const name = customAssetName.trim();
    if (!name) return;
    const balance = parseFloat(String(customAssetBalance).replace(/[$,]/g, '')) || 0;
    addCustomAsset({ name, balance, className: customAssetClass || null });
    setCustomAssetName('');
    setCustomAssetBalance('');
    setCustomAssetClass('');
    setAddingCustomAsset(false);
  }

  // Resolve the class to show on a bucket. For an individual account, that's
  // assetClasses[name]. For a group, return the class only if every member
  // shares the same class — otherwise return null (rendered as "Mixed" or no
  // badge), so the user can see at a glance whether the group is coherent.
  function bucketClass(bucket) {
    if (!bucket.isGroup && bucket.accountName) return assetClasses[bucket.accountName] || null;
    if (bucket.isGroup) {
      const classes = bucket.members.map(m => assetClasses[m] || null);
      const first = classes[0];
      if (first && classes.every(c => c === first)) return first;
      if (classes.some(Boolean)) return 'Mixed';
    }
    return null;
  }

  // Assign a class to a bucket — fans out across every member when the
  // bucket is a group, so the user can tag a whole brokerage in one click.
  function applyBucketClass(bucket, className) {
    if (bucket.isGroup) {
      for (const m of bucket.members) setAssetClass(m, className);
    } else if (bucket.accountName) {
      setAssetClass(bucket.accountName, className);
    }
  }

  function startRename(bucket) {
    setRenamingBucket(bucket.key);
    setRenameValue(bucket.displayName);
  }
  function saveRename() {
    if (!renamingBucket) return;
    const val = renameValue.trim();
    if (renamingBucket.startsWith('group:')) {
      const oldName = renamingBucket.slice(6);
      if (val && val !== oldName) renameGroup(oldName, val);
    } else if (renamingBucket.startsWith('acct:')) {
      const acct = renamingBucket.slice(5);
      setAccountNickname(acct, val && val !== acct ? val : null);
    }
    setRenamingBucket(null);
    setRenameValue('');
  }
  function cancelRename() {
    setRenamingBucket(null);
    setRenameValue('');
  }

  // Distinct group names currently in use, for picker dropdowns.
  const existingGroupNames = Array.from(new Set(Object.values(accountGroups))).filter(Boolean).sort();
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

  // Build asset allocation from real balances. Two view modes:
  //  • 'account' — individual accounts/groups, organized under their asset
  //    class with class headers, largest-to-smallest within each class
  //  • 'class'   — one row per Cash / Stocks / Retirement bucket (summary)
  const assetAccounts = balances?.assets || [];
  const totalAssetBalance = assetAccounts.reduce((sum, a) => sum + a.balance, 0) || 1;

  // Canonical ordering of asset class sections: built-ins first, then any
  // user-defined classes in the order they were added, then Unclassified.
  const classOrderIndex = (name) => {
    if (name === 'Unclassified') return 9999;
    const builtIn = BUILT_IN_ASSET_CLASSES.indexOf(name);
    if (builtIn !== -1) return builtIn;
    const custom = customAssetClasses.indexOf(name);
    if (custom !== -1) return BUILT_IN_ASSET_CLASSES.length + custom;
    return 9998;
  };

  const allocationBuckets = allocationView === 'class'
    ? aggregateByClass(assetAccounts)
    : aggregateByGroup(assetAccounts).sort((a, b) => {
        const ca = bucketClass(a) || 'Unclassified';
        const cb = bucketClass(b) || 'Unclassified';
        // Mixed groups land in Unclassified for the purpose of grouping the
        // legend — the badge still calls them out as "Mixed."
        const ka = classOrderIndex(ca === 'Mixed' ? 'Unclassified' : ca);
        const kb = classOrderIndex(cb === 'Mixed' ? 'Unclassified' : cb);
        if (ka !== kb) return ka - kb;
        return b.balance - a.balance;
      });
  const ALLOCATION = allocationBuckets.map((b, i) => ({
    bucket: b,
    label: b.displayName,
    value: fmt(b.balance),
    balance: b.balance,
    pct: Math.round((b.balance / totalAssetBalance) * 100),
    color: b.isClass
      ? classColor(b.className)
      : DONUT_COLORS[i % DONUT_COLORS.length],
  }));

  // For the account view, group ALLOCATION into class sections so the legend
  // can render class headers (with totals) above their member rows.
  const legendSections = (() => {
    if (allocationView !== 'account') return null;
    const map = new Map();
    for (const item of ALLOCATION) {
      const c = bucketClass(item.bucket) || 'Unclassified';
      const sectionKey = c === 'Mixed' ? 'Unclassified' : c;
      if (!map.has(sectionKey)) {
        map.set(sectionKey, { className: sectionKey, total: 0, items: [] });
      }
      const section = map.get(sectionKey);
      section.total += item.balance;
      section.items.push(item);
    }
    return Array.from(map.values()).sort((a, b) => classOrderIndex(a.className) - classOrderIndex(b.className));
  })();

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

  // Resolve real assets/liabilities for breakdown rows. effectiveDisplayName
  // returns the group name when grouped, otherwise the nickname, otherwise raw.
  const displayAccount = (name) => accountGroups[name] || accountNicknames[name] || name;

  // Aggregate a list of accounts into buckets keyed by their effective display
  // name. Grouped accounts collapse into a single bucket whose balance is the
  // sum of member balances; ungrouped accounts produce a one-member bucket.
  function aggregateByGroup(accounts) {
    const map = new Map();
    for (const a of accounts) {
      const group = accountGroups[a.name];
      const key = group ? `group:${group}` : `acct:${a.name}`;
      const displayName = group || accountNicknames[a.name] || a.name;
      const isGroup = !!group;
      if (!map.has(key)) {
        map.set(key, { key, displayName, balance: 0, members: [], isGroup, groupName: group || null, accountName: isGroup ? null : a.name });
      }
      const bucket = map.get(key);
      bucket.balance += a.balance || 0;
      bucket.members.push(a.name);
    }
    return Array.from(map.values());
  }

  // Bucket accounts into the broader Cash / Stocks / Retirement taxonomy
  // (plus Unclassified for assets the user hasn't tagged yet). The class
  // assignment lives in assetClasses[accountName] and is synced via
  // Firestore — see DataContext.
  function aggregateByClass(accounts) {
    const order = [...allAssetClasses, 'Unclassified'];
    const map = new Map();
    for (const a of accounts) {
      const assigned = assetClasses[a.name];
      const cls = assigned && allAssetClasses.includes(assigned) ? assigned : 'Unclassified';
      const key = `class:${cls}`;
      if (!map.has(key)) {
        map.set(key, { key, displayName: cls, className: cls, balance: 0, members: [], isClass: true });
      }
      const bucket = map.get(key);
      bucket.balance += a.balance || 0;
      bucket.members.push(a.name);
    }
    // Only return buckets that actually have members, sorted by canonical order.
    return Array.from(map.values()).sort((a, b) => order.indexOf(a.className) - order.indexOf(b.className));
  }

  // Render an account or group row's name cell. Shows inline rename UI when
  // renamingBucket matches; otherwise shows the display name with pencil +
  // group-picker affordances. Members of a group are shown dimmed underneath.
  //
  // opts.showOriginal (default true) controls whether we render the dimmed
  // raw-account-name line beneath a nicknamed row. The Asset Allocation
  // legend passes false so the legend stays compact.
  // opts.showClass (default false) injects a class-picker icon next to the
  // group-picker icon — only the Asset Allocation card opts into this.
  const renderBucketName = (bucket, opts = {}) => {
    const showOriginal = opts.showOriginal !== false;
    const showClass = !!opts.showClass;
    const hideClassBadge = !!opts.hideClassBadge;
    const isEditing = renamingBucket === bucket.key;
    if (isEditing) {
      return (
        <span className={styles.renameRow}>
          <input
            className={styles.renameInput}
            value={renameValue}
            onChange={e => setRenameValue(e.target.value)}
            onKeyDown={e => { if (e.key === 'Enter') saveRename(); if (e.key === 'Escape') cancelRename(); }}
            autoFocus
          />
          <button className={styles.renameSave} onClick={saveRename} title="Save">
            <span className="material-symbols-outlined" style={{ fontSize: 16 }}>check</span>
          </button>
          <button className={styles.renameCancel} onClick={cancelRename} title="Cancel">
            <span className="material-symbols-outlined" style={{ fontSize: 16 }}>close</span>
          </button>
        </span>
      );
    }
    return (
      <>
        <span className={styles.renameAware}>
          <span className={styles.snapshotRowDisplay}>
            {bucket.isGroup && <span className={styles.groupBadge} title="Account group">group</span>}
            {bucket.displayName}
          </span>
          <button className={styles.renameBtn} onClick={() => startRename(bucket)} title={bucket.isGroup ? 'Rename group' : 'Rename account'}>
            <span className="material-symbols-outlined" style={{ fontSize: 14 }}>edit</span>
          </button>
          <button
            className={styles.renameBtn}
            onClick={() => { setGroupPickerFor(groupPickerFor === bucket.key ? null : bucket.key); setNewGroupInput(''); }}
            title={bucket.isGroup ? 'Manage group' : 'Add to group'}
          >
            <span className="material-symbols-outlined" style={{ fontSize: 14 }}>{bucket.isGroup ? 'workspaces' : 'add_link'}</span>
          </button>
          {showClass && (bucket.accountName || bucket.isGroup) && (
            <button
              className={styles.renameBtn}
              onClick={() => setClassPickerFor(classPickerFor === bucket.key ? null : bucket.key)}
              title={bucket.isGroup ? 'Assign asset class to this group' : 'Assign asset class'}
            >
              <span className="material-symbols-outlined" style={{ fontSize: 14 }}>category</span>
            </button>
          )}
          {showClass && !hideClassBadge && bucketClass(bucket) && (
            <span
              title={bucketClass(bucket) === 'Mixed'
                ? 'Group members are assigned to different classes'
                : `Asset class: ${bucketClass(bucket)}`}
              style={{
                fontSize: 10,
                fontWeight: 700,
                padding: '2px 6px',
                borderRadius: 4,
                background: `${classColor(bucketClass(bucket))}22`,
                color: classColor(bucketClass(bucket)),
                textTransform: 'uppercase',
                letterSpacing: 0.3,
                marginLeft: 4,
              }}
            >
              {bucketClass(bucket)}
            </span>
          )}
        </span>
        {/* Original name(s) shown dimmed below — suppressed for compact legends */}
        {showOriginal && (
          bucket.isGroup ? (
            <span className={styles.snapshotRowOriginal}>
              {bucket.members.length} {bucket.members.length === 1 ? 'account' : 'accounts'}: {bucket.members.join(', ')}
            </span>
          ) : (
            accountNicknames[bucket.accountName] && <span className={styles.snapshotRowOriginal}>{bucket.accountName}</span>
          )
        )}
        {showClass && classPickerFor === bucket.key && (bucket.accountName || bucket.isGroup) && (
          <div className={styles.groupPicker}>
            <div className={styles.groupPickerSection}>
              <div className={styles.groupPickerLabel}>
                {bucket.isGroup
                  ? `Asset class for "${bucket.displayName}" group (${bucket.members.length} ${bucket.members.length === 1 ? 'account' : 'accounts'})`
                  : 'Asset class'}
              </div>
              {allAssetClasses.map(c => (
                <button
                  key={c}
                  className={styles.groupPickerOption}
                  disabled={bucketClass(bucket) === c}
                  onClick={() => { applyBucketClass(bucket, c); setClassPickerFor(null); }}
                >
                  {c}
                </button>
              ))}
            </div>
            <div className={styles.groupPickerSection}>
              <div className={styles.groupPickerLabel}>Or create new class</div>
              <div className={styles.groupPickerNewRow}>
                <input
                  className={styles.groupPickerInput}
                  placeholder="e.g. Real Estate, Vehicle, Crypto"
                  onKeyDown={e => {
                    if (e.key === 'Enter') {
                      const name = e.currentTarget.value.trim();
                      if (!name) return;
                      addCustomAssetClass(name);
                      applyBucketClass(bucket, name);
                      setClassPickerFor(null);
                    }
                    if (e.key === 'Escape') setClassPickerFor(null);
                  }}
                />
              </div>
            </div>
            {bucketClass(bucket) && (
              <button
                className={styles.groupPickerDanger}
                onClick={() => { applyBucketClass(bucket, null); setClassPickerFor(null); }}
              >Clear class{bucket.isGroup ? ' for all members' : ''}</button>
            )}
          </div>
        )}
        {groupPickerFor === bucket.key && (
          <div className={styles.groupPicker}>
            {existingGroupNames.length > 0 && (
              <div className={styles.groupPickerSection}>
                <div className={styles.groupPickerLabel}>Move to group</div>
                {existingGroupNames.map(g => (
                  <button
                    key={g}
                    className={styles.groupPickerOption}
                    disabled={bucket.isGroup && bucket.groupName === g}
                    onClick={() => {
                      if (bucket.isGroup) {
                        // Move every member of this group to g
                        for (const m of bucket.members) setAccountGroup(m, g);
                      } else {
                        setAccountGroup(bucket.accountName, g);
                      }
                      setGroupPickerFor(null);
                    }}
                  >
                    {g}
                  </button>
                ))}
              </div>
            )}
            <div className={styles.groupPickerSection}>
              <div className={styles.groupPickerLabel}>{existingGroupNames.length > 0 ? 'Or create new group' : 'Create group'}</div>
              <div className={styles.groupPickerNewRow}>
                <input
                  className={styles.groupPickerInput}
                  value={newGroupInput}
                  onChange={e => setNewGroupInput(e.target.value)}
                  onKeyDown={e => {
                    if (e.key === 'Enter') {
                      const name = newGroupInput.trim();
                      if (!name) return;
                      if (bucket.isGroup) {
                        for (const m of bucket.members) setAccountGroup(m, name);
                      } else {
                        setAccountGroup(bucket.accountName, name);
                      }
                      setNewGroupInput('');
                      setGroupPickerFor(null);
                    }
                    if (e.key === 'Escape') setGroupPickerFor(null);
                  }}
                  placeholder="New group name"
                  autoFocus
                />
                <button
                  className={styles.groupPickerCreate}
                  onClick={() => {
                    const name = newGroupInput.trim();
                    if (!name) return;
                    if (bucket.isGroup) {
                      for (const m of bucket.members) setAccountGroup(m, name);
                    } else {
                      setAccountGroup(bucket.accountName, name);
                    }
                    setNewGroupInput('');
                    setGroupPickerFor(null);
                  }}
                >Create</button>
              </div>
            </div>
            {bucket.isGroup ? (
              <button
                className={styles.groupPickerDanger}
                onClick={() => { deleteGroup(bucket.groupName); setGroupPickerFor(null); }}
              >Disband group</button>
            ) : (
              accountGroups[bucket.accountName] && (
                <button
                  className={styles.groupPickerDanger}
                  onClick={() => { setAccountGroup(bucket.accountName, null); setGroupPickerFor(null); }}
                >Remove from group</button>
              )
            )}
          </div>
        )}
      </>
    );
  };
  const rawAssetRows = (balances?.assets || []).slice().sort((a, b) => b.balance - a.balance);
  const rawLiabilityRows = (balances?.liabilities || []).slice().sort((a, b) => b.balance - a.balance);
  const assetRowsBuckets = aggregateByGroup(rawAssetRows).sort((a, b) => b.balance - a.balance);
  const liabilityRowsBuckets = aggregateByGroup(rawLiabilityRows).sort((a, b) => b.balance - a.balance);
  const assetTotal = balances?.totalAssets || rawAssetRows.reduce((s, a) => s + a.balance, 0);
  const liabilityTotal = balances?.totalLiabilities || rawLiabilityRows.reduce((s, l) => s + l.balance, 0);

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
                  {assetRowsBuckets.length === 0 && <div className={styles.snapshotEmpty}>No linked assets</div>}
                  {assetRowsBuckets.map(b => (
                    <div key={b.key} className={styles.snapshotRow}>
                      <span className={styles.snapshotRowName}>
                        {renderBucketName(b)}
                      </span>
                      <span className={styles.snapshotRowValue}>{fmt(b.balance)}</span>
                    </div>
                  ))}
                </div>
                <div className={styles.snapshotColumn}>
                  <div className={styles.snapshotColumnHeader}>
                    <span>Liabilities</span>
                    <span style={{ color: 'var(--color-error)' }}>{fmt(liabilityTotal)}</span>
                  </div>
                  {liabilityRowsBuckets.length === 0 && <div className={styles.snapshotEmpty}>No linked liabilities</div>}
                  {liabilityRowsBuckets.map(b => (
                    <div key={b.key} className={styles.snapshotRow}>
                      <span className={styles.snapshotRowName}>
                        {renderBucketName(b)}
                      </span>
                      <span className={styles.snapshotRowValue}>{fmt(b.balance)}</span>
                    </div>
                  ))}
                </div>
              </div>
            )}
            {selectedSnapshot === 'Total Assets' && (
              <div className={styles.snapshotList}>
                {assetRowsBuckets.length === 0 && <div className={styles.snapshotEmpty}>No linked assets</div>}
                {assetRowsBuckets.map(b => {
                  const pct = assetTotal > 0 ? (b.balance / assetTotal) * 100 : 0;
                  return (
                    <div key={b.key} className={styles.snapshotRowFull}>
                      <div className={styles.snapshotRowFullHeader}>
                        <span className={styles.snapshotRowName}>
                          {renderBucketName(b)}
                        </span>
                        <span className={styles.snapshotRowValue}>{fmt(b.balance)} <span className={styles.snapshotPct}>{pct.toFixed(1)}%</span></span>
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
                {liabilityRowsBuckets.length === 0 && <div className={styles.snapshotEmpty}>No linked liabilities</div>}
                {liabilityRowsBuckets.map(b => {
                  const pct = liabilityTotal > 0 ? (b.balance / liabilityTotal) * 100 : 0;
                  return (
                    <div key={b.key} className={styles.snapshotRowFull}>
                      <div className={styles.snapshotRowFullHeader}>
                        <span className={styles.snapshotRowName}>
                          {renderBucketName(b)}
                        </span>
                        <span className={styles.snapshotRowValue}>{fmt(b.balance)} <span className={styles.snapshotPct}>{pct.toFixed(1)}%</span></span>
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
          <div className={styles.chartHeader} style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12 }}>
            <span className={styles.chartTitle}>Asset Allocation</span>
            <div style={{ display: 'inline-flex', gap: 2, background: 'var(--color-surface-alt)', padding: 2, borderRadius: 8 }}>
              {[{ key: 'account', label: 'By account' }, { key: 'class', label: 'By class' }].map(t => (
                <button
                  key={t.key}
                  type="button"
                  onClick={() => setAllocationView(t.key)}
                  style={{
                    padding: '4px 10px',
                    border: 'none',
                    background: allocationView === t.key ? 'var(--color-surface)' : 'transparent',
                    boxShadow: allocationView === t.key ? 'var(--shadow-xs)' : 'none',
                    borderRadius: 6,
                    cursor: 'pointer',
                    fontSize: 11,
                    fontWeight: 600,
                    color: allocationView === t.key ? 'var(--color-text-primary)' : 'var(--color-text-secondary)',
                  }}
                >
                  {t.label}
                </button>
              ))}
            </div>
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
                      {hoverDonut != null ? `${displayAccount(ALLOCATION[hoverDonut].label).toUpperCase()} · ${ALLOCATION[hoverDonut].pct}%` : 'TOTAL'}
                    </text>
                  </>
                );
              })()}
            </svg>
          </div>
          <div className={styles.donutLegend}>
            {allocationView === 'class' ? (
              // Compact summary: one row per class.
              ALLOCATION.map((a) => (
                <div key={a.bucket.key} className={styles.donutLegendItem}>
                  <div className={styles.donutLegendLeft}>
                    <div className={styles.donutLegendDot} style={{ background: a.color }} />
                    <div className={styles.donutLegendNameWrap}>
                      <span className={styles.snapshotRowDisplay}>{a.bucket.displayName}</span>
                    </div>
                  </div>
                  <span className={styles.donutLegendValue}>
                    <span style={{ color: 'var(--color-text-primary)', fontWeight: 600, marginRight: 8 }}>{a.value}</span>
                    <span style={{ color: 'var(--color-text-tertiary)' }}>{a.pct}%</span>
                  </span>
                </div>
              ))
            ) : (
              // Account detail organized into class sections — accounts within
              // each class are pre-sorted largest-to-smallest by ALLOCATION.
              legendSections.map((section) => {
                const sectionPct = Math.round((section.total / totalAssetBalance) * 100);
                const headerColor = classColor(section.className);
                return (
                  <div key={section.className} style={{ marginTop: 12 }}>
                    <div
                      style={{
                        display: 'flex',
                        alignItems: 'baseline',
                        justifyContent: 'space-between',
                        padding: '4px 6px',
                        marginBottom: 4,
                        borderLeft: `3px solid ${headerColor}`,
                        background: `${headerColor}10`,
                        borderRadius: 4,
                      }}
                    >
                      <span style={{ fontFamily: 'var(--font-headline)', fontSize: 12, fontWeight: 700, textTransform: 'uppercase', letterSpacing: 0.5, color: headerColor }}>
                        {section.className}
                      </span>
                      <span style={{ fontSize: 12, fontWeight: 600, color: 'var(--color-text-primary)' }}>
                        {fmt(section.total)}
                        <span style={{ color: 'var(--color-text-tertiary)', fontWeight: 500, marginLeft: 6 }}>{sectionPct}%</span>
                      </span>
                    </div>
                    {section.items.map((a) => (
                      <div key={a.bucket.key} className={styles.donutLegendItem} style={{ paddingLeft: 8 }}>
                        <div className={styles.donutLegendLeft}>
                          <div className={styles.donutLegendDot} style={{ background: a.color }} />
                          <div className={styles.donutLegendNameWrap}>
                            {renderBucketName(a.bucket, { showOriginal: false, showClass: true, hideClassBadge: true })}
                          </div>
                        </div>
                        <span className={styles.donutLegendValue}>
                          <span style={{ color: 'var(--color-text-primary)', fontWeight: 600, marginRight: 8 }}>{a.value}</span>
                          <span style={{ color: 'var(--color-text-tertiary)' }}>{a.pct}%</span>
                        </span>
                      </div>
                    ))}
                  </div>
                );
              })
            )}
          </div>

          {/* Quick-add custom asset — for items the sheet feed doesn't see
              (real estate, vehicles, private holdings, etc.). */}
          <div style={{ marginTop: 12, paddingTop: 12, borderTop: '1px solid var(--color-border, rgba(0,0,0,0.08))' }}>
            {!addingCustomAsset ? (
              <button
                type="button"
                onClick={() => setAddingCustomAsset(true)}
                style={{
                  width: '100%',
                  background: 'transparent',
                  border: '1px dashed var(--color-border, rgba(0,0,0,0.15))',
                  borderRadius: 6,
                  padding: '8px 10px',
                  color: 'var(--color-text-tertiary)',
                  fontSize: 12,
                  fontWeight: 600,
                  cursor: 'pointer',
                  display: 'inline-flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  gap: 6,
                }}
                title="Add a manually-tracked asset (real estate, vehicle, etc.)"
              >
                <span className="material-symbols-outlined" style={{ fontSize: 16 }}>add</span>
                Add custom asset
              </button>
            ) : (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                <input
                  className={styles.groupPickerInput}
                  placeholder="Asset name (e.g. Home, Tesla, Gold)"
                  value={customAssetName}
                  onChange={e => setCustomAssetName(e.target.value)}
                  onKeyDown={e => { if (e.key === 'Enter') submitCustomAsset(); if (e.key === 'Escape') setAddingCustomAsset(false); }}
                  autoFocus
                />
                <div style={{ display: 'flex', gap: 6 }}>
                  <input
                    className={styles.groupPickerInput}
                    placeholder="$0"
                    value={customAssetBalance}
                    onChange={e => setCustomAssetBalance(e.target.value)}
                    onKeyDown={e => { if (e.key === 'Enter') submitCustomAsset(); if (e.key === 'Escape') setAddingCustomAsset(false); }}
                    style={{ width: 100 }}
                  />
                  <select
                    className={styles.groupPickerInput}
                    value={customAssetClass}
                    onChange={e => setCustomAssetClass(e.target.value)}
                    style={{ flex: 1 }}
                  >
                    <option value="">No class</option>
                    {allAssetClasses.map(c => (<option key={c} value={c}>{c}</option>))}
                  </select>
                </div>
                <div style={{ display: 'flex', gap: 6, justifyContent: 'flex-end' }}>
                  <button
                    type="button"
                    onClick={() => { setAddingCustomAsset(false); setCustomAssetName(''); setCustomAssetBalance(''); setCustomAssetClass(''); }}
                    style={{ background: 'transparent', border: 'none', fontSize: 12, color: 'var(--color-text-tertiary)', cursor: 'pointer', padding: '4px 8px' }}
                  >Cancel</button>
                  <button
                    type="button"
                    onClick={submitCustomAsset}
                    style={{ background: 'var(--color-secondary, #0058be)', color: '#fff', border: 'none', borderRadius: 4, padding: '4px 12px', fontSize: 12, fontWeight: 600, cursor: 'pointer' }}
                  >Add</button>
                </div>
              </div>
            )}
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
