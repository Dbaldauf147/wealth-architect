import { useMemo, useState } from 'react';
import { useData, useDataActions } from '../contexts/DataContext';
import {
  ACCOUNT_CATEGORIES,
  LIQUID_CATEGORIES,
  CATEGORY_LIQUID,
  CATEGORY_EXCLUDED,
  TAXED_LIQUID_CATEGORY,
  DEFAULT_SALE_TAX_RATE,
  buildMonthlyBalances,
  summarizeMonth,
  guessCategory,
  guessLiquidCategory,
  monthLabel,
  pctChange,
} from '../lib/netWorthSnapshot';
import styles from './NetWorthSnapshot.module.css';

function fmt(n) {
  if (n == null || !Number.isFinite(n)) return '—';
  return new Intl.NumberFormat('en-US', {
    style: 'currency', currency: 'USD', minimumFractionDigits: 0, maximumFractionDigits: 0,
  }).format(n);
}

function fmtCents(n) {
  if (n == null || !Number.isFinite(n)) return '—';
  return new Intl.NumberFormat('en-US', {
    style: 'currency', currency: 'USD', minimumFractionDigits: 2, maximumFractionDigits: 2,
  }).format(n);
}

function fmtSigned(n) {
  if (n == null || !Number.isFinite(n)) return '—';
  if (Math.round(n) === 0) return '$0';
  const sign = n > 0 ? '+' : '−';
  return sign + fmt(Math.abs(n));
}

function fmtPct(n) {
  if (n == null || !Number.isFinite(n)) return '—';
  const sign = n > 0 ? '+' : n < 0 ? '−' : '';
  return sign + Math.abs(n * 100).toFixed(1) + '%';
}

// Green for the direction you want. On the Liabilities line that's down, so
// the row carries `invert` and a growing balance reads red.
function changeClass(n, invert = false) {
  if (!Number.isFinite(n) || Math.round(n) === 0) return styles.flat;
  return (n > 0) !== invert ? styles.up : styles.down;
}

function parseAmount(text) {
  const n = parseFloat(String(text).replace(/[$,\s]/g, ''));
  return Number.isFinite(n) ? n : 0;
}

// Summary lines, in the order the spreadsheet reads them. `memo` rows are the
// breakdown of Liquid Assets rather than additions to the total, so they are
// indented and rendered quieter.
const SUMMARY_ROWS = [
  { key: 'retirement', label: 'Retirement' },
  { key: 'liquidAssets', label: 'Liquid Assets' },
  { key: 'stocks', label: 'Stocks', memo: true },
  { key: 'stocksLessTax', label: 'Stocks Less Tax', memo: true },
  { key: 'cash', label: 'Cash', memo: true },
  { key: 'investable', label: 'Investable $', memo: true, strong: true },
  { key: 'total', label: 'Total', total: true },
  { key: 'nonLiquid', label: 'Non Liquid Assets', below: true },
  { key: 'liabilities', label: 'Liabilities', below: true, invert: true },
  { key: 'netWorth', label: 'Net Worth', below: true, strong: true },
];

export function NetWorthSnapshot() {
  const {
    balances, balanceHistory, assetClasses, accountNicknames,
    netWorthCategories, netWorthLiquidCategories, netWorthPrefs,
  } = useData();
  const { setNetWorthCategory, setNetWorthLiquidCategory, updateNetWorthPrefs } = useDataActions();

  const [thisMonth, setThisMonth] = useState(null);
  const [lastMonth, setLastMonth] = useState(null);
  const [editingEarmark, setEditingEarmark] = useState(null);
  const [earmarkName, setEarmarkName] = useState('');
  const [earmarkAmount, setEarmarkAmount] = useState('');
  const [showAllAccounts, setShowAllAccounts] = useState(false);

  // Memoized so a missing map doesn't hand the memos below a fresh `{}` on
  // every render and re-run every derivation.
  const nicknames = useMemo(() => accountNicknames || {}, [accountNicknames]);
  const overrides = useMemo(() => netWorthCategories || {}, [netWorthCategories]);
  const liquidOverrides = useMemo(() => netWorthLiquidCategories || {}, [netWorthLiquidCategories]);
  const prefs = netWorthPrefs || {};
  const saleTaxRate = Number.isFinite(prefs.saleTaxRate) ? prefs.saleTaxRate : DEFAULT_SALE_TAX_RATE;
  const earmarks = Array.isArray(prefs.earmarks) ? prefs.earmarks : [];

  // Everything we know about each account name: which side of the balance
  // sheet it sits on, and whether the user typed it in by hand. History-only
  // accounts (closed since, or renamed) aren't in `balances`, so they fall
  // through to the asset default.
  const accountMeta = useMemo(() => {
    const meta = new Map();
    for (const a of balances?.assets || []) {
      if (a?.name) meta.set(a.name, { name: a.name, side: 'asset', custom: !!a.custom, balance: a.balance || 0 });
    }
    for (const l of balances?.liabilities || []) {
      if (l?.name) meta.set(l.name, { name: l.name, side: 'liability', custom: !!l.custom, balance: l.balance || 0 });
    }
    return meta;
  }, [balances]);

  // Resolve an account's two labels: the user's explicit choice when there is
  // one, otherwise the guess from its asset class and name.
  const classify = useMemo(() => {
    const cache = new Map();
    return (name) => {
      if (cache.has(name)) return cache.get(name);
      const meta = accountMeta.get(name) || { name, side: 'asset', custom: false };
      const assetClass = (assetClasses || {})[name];
      const category = overrides[name] || guessCategory(meta, assetClass);
      const liquidCategory = category === CATEGORY_LIQUID
        ? (liquidOverrides[name] || guessLiquidCategory(meta, assetClass, category))
        : null;
      const out = { category, liquidCategory, explicitCategory: !!overrides[name] };
      cache.set(name, out);
      return out;
    };
  }, [accountMeta, assetClasses, overrides, liquidOverrides]);

  // Balance History collapsed to one forward-filled balance per account per
  // month, with the hand-entered customs folded into every month — they have
  // no history of their own, so their current value is the only value we have.
  const months = useMemo(() => {
    const base = buildMonthlyBalances(balanceHistory);
    const customs = [...accountMeta.values()].filter(m => m.custom);
    if (!customs.length) return base;
    return base.map(m => {
      const merged = new Map(m.balances);
      for (const c of customs) merged.set(c.name, c.balance);
      return { ...m, balances: merged };
    });
  }, [balanceHistory, accountMeta]);

  const monthKeys = useMemo(() => months.map(m => m.key), [months]);

  // Default to the two most recent months. Held in state so the user's pick
  // survives a data refresh, but re-derived whenever the pick isn't available.
  const currentKey = thisMonth && monthKeys.includes(thisMonth)
    ? thisMonth
    : monthKeys[monthKeys.length - 1] || null;
  const currentIdx = monthKeys.indexOf(currentKey);
  const priorKey = lastMonth && monthKeys.includes(lastMonth) && lastMonth !== currentKey
    ? lastMonth
    : (currentIdx > 0 ? monthKeys[currentIdx - 1] : null);

  const currentMonth = months.find(m => m.key === currentKey) || null;
  const priorMonth = months.find(m => m.key === priorKey) || null;

  const currentSummary = useMemo(
    () => summarizeMonth(currentMonth?.balances, classify, saleTaxRate),
    [currentMonth, classify, saleTaxRate],
  );
  const priorSummary = useMemo(
    () => (priorMonth ? summarizeMonth(priorMonth.balances, classify, saleTaxRate) : null),
    [priorMonth, classify, saleTaxRate],
  );

  // One row per account holding a balance in the selected month, sorted by
  // the biggest mover so the reason the total changed is at the top.
  const accountRows = useMemo(() => {
    if (!currentMonth) return [];
    const rows = [];
    for (const [name, balance] of currentMonth.balances) {
      const { category, liquidCategory } = classify(name);
      const prior = priorMonth?.balances.has(name) ? priorMonth.balances.get(name) : null;
      const change = prior == null ? null : balance - prior;
      rows.push({
        name,
        display: nicknames[name] || name,
        balance,
        category,
        liquidCategory,
        prior,
        inPreviousMonth: prior != null,
        reported: currentMonth.reported.has(name) || !!accountMeta.get(name)?.custom,
        change,
        pct: prior == null ? null : pctChange(balance, prior),
      });
    }
    rows.sort((a, b) => Math.abs(b.change ?? 0) - Math.abs(a.change ?? 0) || Math.abs(b.balance) - Math.abs(a.balance));
    return rows;
  }, [currentMonth, priorMonth, classify, nicknames, accountMeta]);

  const visibleRows = showAllAccounts
    ? accountRows
    : accountRows.filter(r => r.category !== CATEGORY_EXCLUDED);
  const excludedCount = accountRows.length - accountRows.filter(r => r.category !== CATEGORY_EXCLUDED).length;

  const earmarkTotal = earmarks.reduce((s, e) => s + (Number(e.amount) || 0), 0);
  const investableAfterEarmarks = currentSummary.investable - earmarkTotal;

  function commitEarmark() {
    const name = earmarkName.trim();
    if (!name) { cancelEarmark(); return; }
    const amount = parseAmount(earmarkAmount);
    const next = editingEarmark === 'new'
      ? [...earmarks, { id: `${Date.now().toString(36)}`, name, amount }]
      : earmarks.map(e => (e.id === editingEarmark ? { ...e, name, amount } : e));
    updateNetWorthPrefs({ earmarks: next });
    cancelEarmark();
  }

  function cancelEarmark() {
    setEditingEarmark(null);
    setEarmarkName('');
    setEarmarkAmount('');
  }

  function startEarmark(entry) {
    setEditingEarmark(entry ? entry.id : 'new');
    setEarmarkName(entry ? entry.name : '');
    setEarmarkAmount(entry ? String(entry.amount ?? '') : '');
  }

  function removeEarmark(id) {
    updateNetWorthPrefs({ earmarks: earmarks.filter(e => e.id !== id) });
  }

  if (!months.length) {
    return (
      <div className={styles.empty}>
        No monthly balances yet. The snapshot reads the "Balance History" tab of
        your Tiller sheet — once it has a couple of months in it, this view fills in.
      </div>
    );
  }

  return (
    <div className={styles.wrap}>
      {/* Month pickers */}
      <div className={styles.monthBar}>
        <label className={styles.monthPick}>
          <span className={styles.monthPickLabel}>This month</span>
          <select
            className={styles.select}
            value={currentKey || ''}
            onChange={e => setThisMonth(e.target.value)}
          >
            {[...monthKeys].reverse().map(k => (
              <option key={k} value={k}>{monthLabel(k)}</option>
            ))}
          </select>
        </label>
        <span className={`material-symbols-outlined ${styles.vs}`}>compare_arrows</span>
        <label className={styles.monthPick}>
          <span className={styles.monthPickLabel}>Compared with</span>
          <select
            className={styles.select}
            value={priorKey || ''}
            onChange={e => setLastMonth(e.target.value)}
          >
            {monthKeys.length < 2 && <option value="">No earlier month</option>}
            {[...monthKeys].reverse().filter(k => k !== currentKey).map(k => (
              <option key={k} value={k}>{monthLabel(k)}</option>
            ))}
          </select>
        </label>

        <label className={styles.taxPick} title={`Applied to the "${TAXED_LIQUID_CATEGORY}" bucket only — the part you'd actually sell.`}>
          <span className={styles.monthPickLabel}>Tax on sale</span>
          <div className={styles.taxInputWrap}>
            <input
              className={styles.taxInput}
              type="number"
              min="0"
              max="60"
              step="0.5"
              value={(saleTaxRate * 100).toFixed(saleTaxRate * 100 % 1 === 0 ? 0 : 1)}
              onChange={e => {
                const pct = parseFloat(e.target.value);
                updateNetWorthPrefs({ saleTaxRate: Number.isFinite(pct) ? Math.max(0, Math.min(pct, 60)) / 100 : 0 });
              }}
            />
            <span className={styles.taxSuffix}>%</span>
          </div>
        </label>
      </div>

      <div className={styles.topGrid}>
        {/* Summary table */}
        <div className={styles.card}>
          <table className={styles.summaryTable}>
            <thead>
              <tr>
                <th />
                <th className={styles.num}>{monthLabel(currentKey)}</th>
                <th className={styles.num}>{priorKey ? monthLabel(priorKey) : '—'}</th>
                <th className={styles.num}>Change</th>
                <th className={styles.num}>%</th>
              </tr>
            </thead>
            <tbody>
              {SUMMARY_ROWS.map(row => {
                const now = currentSummary[row.key];
                const before = priorSummary ? priorSummary[row.key] : null;
                const delta = before == null ? null : now - before;
                const cls = [
                  row.memo ? styles.memoRow : '',
                  row.total ? styles.totalRow : '',
                  row.below ? styles.belowRow : '',
                  row.strong ? styles.strongRow : '',
                ].filter(Boolean).join(' ');
                return (
                  <tr key={row.key} className={cls}>
                    <td className={styles.rowLabel}>{row.label}</td>
                    <td className={styles.num}>{fmt(now)}</td>
                    <td className={`${styles.num} ${styles.dim}`}>{before == null ? '—' : fmt(before)}</td>
                    <td className={`${styles.num} ${changeClass(delta, row.invert)}`}>{fmtSigned(delta)}</td>
                    <td className={`${styles.num} ${changeClass(delta, row.invert)}`}>
                      {before == null ? '—' : fmtPct(pctChange(now, before))}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
          <div className={styles.footnote}>
            Total is Retirement + Liquid Assets. Stocks Less Tax takes {(saleTaxRate * 100).toFixed(saleTaxRate * 100 % 1 === 0 ? 0 : 1)}%
            off the {TAXED_LIQUID_CATEGORY} bucket ({fmt(currentSummary.saleTax)} this month); the rest of
            Stocks is assumed held, so no tax comes off it.
          </div>
        </div>

        {/* Side cards */}
        <div className={styles.sideCol}>
          <div className={styles.card}>
            <div className={styles.cardTitle}>Investable today</div>
            <table className={styles.miniTable}>
              <tbody>
                <tr>
                  <td>Stocks <span className={styles.dim}>(less tax)</span></td>
                  <td className={styles.num}>{fmt(currentSummary.stocksLessTax)}</td>
                </tr>
                <tr>
                  <td>Cash</td>
                  <td className={styles.num}>{fmt(currentSummary.cash)}</td>
                </tr>
                <tr className={styles.miniTotal}>
                  <td>Total</td>
                  <td className={styles.num}>{fmt(currentSummary.investable)}</td>
                </tr>
              </tbody>
            </table>
          </div>

          <div className={styles.card}>
            <div className={styles.cardTitleRow}>
              <div className={styles.cardTitle}>Earmarked</div>
              <button type="button" className={styles.iconBtn} onClick={() => startEarmark(null)} title="Add an earmark">
                <span className="material-symbols-outlined" style={{ fontSize: 16 }}>add</span>
              </button>
            </div>
            <table className={styles.miniTable}>
              <tbody>
                {earmarks.length === 0 && editingEarmark !== 'new' && (
                  <tr><td colSpan={2} className={styles.dim}>Nothing set aside yet.</td></tr>
                )}
                {earmarks.map(e => (
                  editingEarmark === e.id ? (
                    <tr key={e.id}>
                      <td colSpan={2}>{renderEarmarkForm()}</td>
                    </tr>
                  ) : (
                    <tr key={e.id} className={styles.earmarkRow}>
                      <td>
                        <span>{e.name}</span>
                        <span className={styles.earmarkActions}>
                          <button type="button" className={styles.iconBtn} onClick={() => startEarmark(e)} title="Edit">
                            <span className="material-symbols-outlined" style={{ fontSize: 14 }}>edit</span>
                          </button>
                          <button type="button" className={styles.iconBtn} onClick={() => removeEarmark(e.id)} title="Remove">
                            <span className="material-symbols-outlined" style={{ fontSize: 14 }}>delete</span>
                          </button>
                        </span>
                      </td>
                      <td className={styles.num}>{fmt(Number(e.amount) || 0)}</td>
                    </tr>
                  )
                ))}
                {editingEarmark === 'new' && (
                  <tr><td colSpan={2}>{renderEarmarkForm()}</td></tr>
                )}
                {earmarks.length > 0 && (
                  <tr className={styles.miniTotal}>
                    <td>Total</td>
                    <td className={styles.num}>{fmt(earmarkTotal)}</td>
                  </tr>
                )}
              </tbody>
            </table>
            {earmarks.length > 0 && (
              <div className={styles.leftover}>
                <span>Investable after earmarks</span>
                <span className={`${styles.num} ${investableAfterEarmarks < 0 ? styles.down : ''}`}>
                  {fmt(investableAfterEarmarks)}
                </span>
              </div>
            )}
          </div>
        </div>
      </div>

      {/* Account detail */}
      <div className={styles.card}>
        <div className={styles.cardTitleRow}>
          <div className={styles.cardTitle}>
            Accounts · {monthLabel(currentKey)}
          </div>
          {excludedCount > 0 && (
            <button type="button" className={styles.linkBtn} onClick={() => setShowAllAccounts(p => !p)}>
              {showAllAccounts ? 'Hide' : 'Show'} {excludedCount} excluded
            </button>
          )}
        </div>
        <div className={styles.tableScroll}>
          <table className={styles.accountTable}>
            <thead>
              <tr>
                <th>Account</th>
                <th className={styles.num}>Balance</th>
                <th>Category</th>
                <th>Liquid category</th>
                <th className={styles.center}>In {priorKey ? monthLabel(priorKey) : 'prior month'}?</th>
                <th className={styles.num}>Change</th>
                <th className={styles.num}>% Change</th>
              </tr>
            </thead>
            <tbody>
              {visibleRows.map(r => (
                <tr key={r.name} className={r.category === CATEGORY_EXCLUDED ? styles.excludedRow : ''}>
                  <td>
                    <span className={styles.accountName}>{r.display}</span>
                    {!r.reported && (
                      <span className={styles.staleTag} title="No new balance posted this month — carried forward from the last snapshot.">
                        carried forward
                      </span>
                    )}
                  </td>
                  <td className={styles.num}>{fmtCents(r.balance)}</td>
                  <td>
                    <select
                      className={styles.cellSelect}
                      value={r.category}
                      onChange={e => setNetWorthCategory(r.name, e.target.value)}
                    >
                      {ACCOUNT_CATEGORIES.map(c => <option key={c} value={c}>{c}</option>)}
                    </select>
                  </td>
                  <td>
                    {r.category === CATEGORY_LIQUID ? (
                      <select
                        className={styles.cellSelect}
                        value={r.liquidCategory || ''}
                        onChange={e => setNetWorthLiquidCategory(r.name, e.target.value)}
                      >
                        {LIQUID_CATEGORIES.map(c => <option key={c} value={c}>{c}</option>)}
                      </select>
                    ) : (
                      <span className={styles.dim}>—</span>
                    )}
                  </td>
                  <td className={styles.center}>
                    {r.inPreviousMonth
                      ? <span className={styles.yes}>Yes</span>
                      : <span className={styles.no} title="New since the comparison month, so there is nothing to change against.">New</span>}
                  </td>
                  <td className={`${styles.num} ${changeClass(r.change)}`}>{r.change == null ? '—' : fmtSigned(r.change)}</td>
                  <td className={`${styles.num} ${changeClass(r.change)}`}>{fmtPct(r.pct)}</td>
                </tr>
              ))}
            </tbody>
            <tfoot>
              <tr>
                <td>Total shown</td>
                <td className={styles.num}>
                  {fmt(visibleRows.reduce((s, r) => s + r.balance, 0))}
                </td>
                <td colSpan={3} />
                <td className={`${styles.num} ${changeClass(visibleRows.reduce((s, r) => s + (r.change || 0), 0))}`}>
                  {fmtSigned(visibleRows.reduce((s, r) => s + (r.change || 0), 0))}
                </td>
                <td />
              </tr>
            </tfoot>
          </table>
        </div>
        <div className={styles.footnote}>
          Categories start as a guess from each account&apos;s asset class and name — change one and it sticks,
          and syncs to your other devices. Balances with no new snapshot this month carry forward from the
          last one they posted.
        </div>
      </div>
    </div>
  );

  function renderEarmarkForm() {
    return (
      <div className={styles.earmarkForm}>
        <input
          className={styles.earmarkInput}
          placeholder="Wedding"
          value={earmarkName}
          onChange={e => setEarmarkName(e.target.value)}
          onKeyDown={e => { if (e.key === 'Enter') commitEarmark(); if (e.key === 'Escape') cancelEarmark(); }}
          autoFocus
        />
        <input
          className={`${styles.earmarkInput} ${styles.earmarkAmount}`}
          placeholder="$0"
          value={earmarkAmount}
          onChange={e => setEarmarkAmount(e.target.value)}
          onKeyDown={e => { if (e.key === 'Enter') commitEarmark(); if (e.key === 'Escape') cancelEarmark(); }}
        />
        <button type="button" className={styles.iconBtn} onClick={commitEarmark} title="Save">
          <span className="material-symbols-outlined" style={{ fontSize: 16 }}>check</span>
        </button>
        <button type="button" className={styles.iconBtn} onClick={cancelEarmark} title="Cancel">
          <span className="material-symbols-outlined" style={{ fontSize: 16 }}>close</span>
        </button>
      </div>
    );
  }
}

export default NetWorthSnapshot;
