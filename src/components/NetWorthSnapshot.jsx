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
  monthLabelShort,
  pctChange,
} from '../lib/netWorthSnapshot';
import styles from './NetWorthSnapshot.module.css';

function fmt(n) {
  if (n == null || !Number.isFinite(n)) return '—';
  return new Intl.NumberFormat('en-US', {
    style: 'currency', currency: 'USD', minimumFractionDigits: 0, maximumFractionDigits: 0,
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

// Ids only have to be unique within the list, so derive one from what's
// already there rather than reaching for a clock or a random source — both
// are impure, and this runs inside a component.
function nextEarmarkId(list) {
  let max = 0;
  for (const e of list) {
    const n = parseInt(String(e?.id ?? '').replace(/\D/g, ''), 10);
    if (Number.isFinite(n) && n > max) max = n;
  }
  return `e${max + 1}`;
}

// How many months the breakdown covers, counting back from the month on the
// right. Rolling: with the default "through" month the window always ends at
// the most recent data.
const SPAN_OPTIONS = [
  { id: 3, label: '3M' },
  { id: 6, label: '6M' },
  { id: 12, label: '12M' },
  { id: 0, label: 'All' },
];
const DEFAULT_SPAN = 6;

// Shared empty literals. A fresh `[]`/`{}` per render is a new identity, which
// both defeats the memos below and reads to the compiler as something that
// might be mutated later.
const NO_EARMARKS = [];

// Each month column either holds that month's balance, or what changed since
// the month before it.
const MODE_OPTIONS = [
  { id: 'balance', label: 'Balances' },
  { id: 'change', label: 'Monthly change' },
];

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

  const [endMonth, setEndMonth] = useState(null);
  const [span, setSpan] = useState(DEFAULT_SPAN);
  const [mode, setMode] = useState('balance');
  const [editingEarmark, setEditingEarmark] = useState(null);
  const [earmarkName, setEarmarkName] = useState('');
  const [earmarkAmount, setEarmarkAmount] = useState('');
  const [showAllAccounts, setShowAllAccounts] = useState(false);

  // Memoized so a missing map doesn't hand the memos below a fresh `{}` on
  // every render and re-run every derivation.
  const nicknames = useMemo(() => accountNicknames || {}, [accountNicknames]);
  const overrides = useMemo(() => netWorthCategories || {}, [netWorthCategories]);
  const liquidOverrides = useMemo(() => netWorthLiquidCategories || {}, [netWorthLiquidCategories]);
  const saleTaxRate = Number.isFinite(netWorthPrefs?.saleTaxRate)
    ? netWorthPrefs.saleTaxRate
    : DEFAULT_SALE_TAX_RATE;
  const earmarks = Array.isArray(netWorthPrefs?.earmarks) ? netWorthPrefs.earmarks : NO_EARMARKS;

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
  // one, otherwise the guess from its asset class and name. Uncached on
  // purpose — the guess is two regex tests on a short string, and a cache that
  // fills during render is a mutation the render is not allowed to make.
  const classify = useMemo(() => (name) => {
    const meta = accountMeta.get(name) || { name, side: 'asset', custom: false };
    const assetClass = (assetClasses || {})[name];
    const category = overrides[name] || guessCategory(meta, assetClass);
    const liquidCategory = category === CATEGORY_LIQUID
      ? (liquidOverrides[name] || guessLiquidCategory(meta, assetClass, category))
      : null;
    return { category, liquidCategory };
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

  // The rolling window and its roll-ups, derived in one pass. Ends at the
  // chosen month — or, by default, at the most recent month with data, so the
  // view rolls forward on its own as the sheet fills in. `span` 0 means every
  // month there is. `precedingMonth` is the month just outside the window on
  // the left, kept only so the leftmost column can still show a
  // month-over-month change.
  const model = useMemo(() => {
    const keys = months.map(m => m.key);
    const chosen = endMonth ? keys.indexOf(endMonth) : -1;
    const end = chosen === -1 ? months.length - 1 : chosen;
    const start = span > 0 ? Math.max(0, end - span + 1) : 0;
    const windowMonths = months.slice(start, end + 1);
    const precedingMonth = start > 0 ? months[start - 1] : null;
    return {
      keys,
      endKey: keys[end] || null,
      windowMonths,
      precedingMonth,
      summaries: windowMonths.map(m => summarizeMonth(m.balances, classify, saleTaxRate)),
      precedingSummary: precedingMonth
        ? summarizeMonth(precedingMonth.balances, classify, saleTaxRate)
        : null,
    };
  }, [months, endMonth, span, classify, saleTaxRate]);

  const { keys: monthKeys, windowMonths, precedingMonth, summaries, precedingSummary } = model;
  const latestMonth = windowMonths[windowMonths.length - 1] || null;
  const latestSummary = summaries[summaries.length - 1] || summarizeMonth(null, classify, saleTaxRate);
  const firstSummary = summaries[0] || null;

  // One row per account that held a balance anywhere in the window, with a
  // value per month (null where the account didn't exist yet). Sorted by the
  // biggest mover across the window, so the reason the total moved is on top.
  const accountRows = useMemo(() => {
    if (!windowMonths.length) return [];
    const names = new Set();
    for (const m of windowMonths) for (const name of m.balances.keys()) names.add(name);

    const rows = [];
    for (const name of names) {
      const values = windowMonths.map(m => (m.balances.has(name) ? m.balances.get(name) : null));
      const before = precedingMonth?.balances.has(name) ? precedingMonth.balances.get(name) : null;
      const first = values[0];
      const last = values[values.length - 1];
      const change = first == null || last == null ? null : last - first;
      const { category, liquidCategory } = classify(name);
      rows.push({
        name,
        display: nicknames[name] || name,
        values,
        before,
        first,
        last,
        change,
        pct: first == null || last == null ? null : pctChange(last, first),
        category,
        liquidCategory,
        // Whether the newest month in the window is a fresh number or the last
        // one this account posted, carried forward.
        reported: !!latestMonth
          && (latestMonth.reported.has(name) || !!accountMeta.get(name)?.custom),
      });
    }
    rows.sort((a, b) =>
      Math.abs(b.change ?? 0) - Math.abs(a.change ?? 0)
      || Math.abs(b.last ?? 0) - Math.abs(a.last ?? 0));
    return rows;
  }, [windowMonths, precedingMonth, latestMonth, classify, nicknames, accountMeta]);

  const visibleRows = showAllAccounts
    ? accountRows
    : accountRows.filter(r => r.category !== CATEGORY_EXCLUDED);
  const excludedCount = accountRows.filter(r => r.category === CATEGORY_EXCLUDED).length;

  // Column totals for the account table's footer, in the same shape as a row
  // so the two render through the same code.
  const columnTotals = (() => {
    const values = windowMonths.map((_, i) =>
      visibleRows.reduce((s, r) => s + (r.values[i] ?? 0), 0));
    const before = visibleRows.reduce((s, r) => s + (r.before ?? 0), 0);
    const first = values[0] ?? null;
    const last = values[values.length - 1] ?? null;
    return { values, before, change: first == null || last == null ? null : last - first };
  })();

  const earmarkTotal = earmarks.reduce((s, e) => s + (Number(e.amount) || 0), 0);
  const investableAfterEarmarks = latestSummary.investable - earmarkTotal;

  const ratePct = (saleTaxRate * 100).toFixed(saleTaxRate * 100 % 1 === 0 ? 0 : 1);
  const spanLabel = windowMonths.length > 1
    ? `${windowMonths.length}-mo change`
    : 'Change';

  function commitEarmark() {
    const name = earmarkName.trim();
    if (!name) { cancelEarmark(); return; }
    const amount = parseAmount(earmarkAmount);
    const next = editingEarmark === 'new'
      ? [...earmarks, { id: nextEarmarkId(earmarks), name, amount }]
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

  // A month column's contents: the balance itself, or the step from the
  // previous column. `prior` is the value in the column to the left — or, for
  // the leftmost, the month just before the window.
  function cellFor(values, i, before) {
    const value = values[i];
    if (mode === 'balance') {
      return { text: value == null ? '—' : fmt(value), cls: '' };
    }
    const prior = i > 0 ? values[i - 1] : before;
    if (value == null || prior == null) return { text: '—', cls: styles.dim };
    return { text: fmtSigned(value - prior), cls: changeClass(value - prior) };
  }

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
      {/* Window + display controls */}
      <div className={styles.monthBar}>
        <div className={styles.control}>
          <span className={styles.controlLabel}>Months shown</span>
          <div className={styles.pillGroup}>
            {SPAN_OPTIONS.map(o => (
              <button
                key={o.id}
                type="button"
                className={`${styles.pill} ${span === o.id ? styles.pillActive : ''}`}
                onClick={() => setSpan(o.id)}
              >
                {o.label}
              </button>
            ))}
          </div>
        </div>

        <label className={styles.control}>
          <span className={styles.controlLabel}>Through</span>
          <select
            className={styles.select}
            value={model.endKey || ''}
            onChange={e => setEndMonth(e.target.value)}
          >
            {[...monthKeys].reverse().map(k => (
              <option key={k} value={k}>{monthLabel(k)}</option>
            ))}
          </select>
        </label>

        <div className={styles.control}>
          <span className={styles.controlLabel}>Show</span>
          <div className={styles.pillGroup}>
            {MODE_OPTIONS.map(o => (
              <button
                key={o.id}
                type="button"
                className={`${styles.pill} ${mode === o.id ? styles.pillActive : ''}`}
                onClick={() => setMode(o.id)}
              >
                {o.label}
              </button>
            ))}
          </div>
        </div>

        <label className={styles.taxPick} title={`Applied to the "${TAXED_LIQUID_CATEGORY}" bucket only — the part you'd actually sell.`}>
          <span className={styles.controlLabel}>Tax on sale</span>
          <div className={styles.taxInputWrap}>
            <input
              className={styles.taxInput}
              type="number"
              min="0"
              max="60"
              step="0.5"
              value={ratePct}
              onChange={e => {
                const pct = parseFloat(e.target.value);
                updateNetWorthPrefs({ saleTaxRate: Number.isFinite(pct) ? Math.max(0, Math.min(pct, 60)) / 100 : 0 });
              }}
            />
            <span className={styles.taxSuffix}>%</span>
          </div>
        </label>
      </div>

      {/* Month-by-month summary */}
      <div className={styles.card}>
        <div className={styles.tableScroll}>
          <table className={styles.summaryTable}>
            <thead>
              <tr>
                <th />
                {windowMonths.map(m => (
                  <th key={m.key} className={styles.num}>{monthLabelShort(m.key)}</th>
                ))}
                <th className={`${styles.num} ${styles.changeCol}`}>{spanLabel}</th>
                <th className={`${styles.num} ${styles.changeCol}`}>%</th>
              </tr>
            </thead>
            <tbody>
              {SUMMARY_ROWS.map(row => {
                const values = summaries.map(s => s[row.key]);
                const before = precedingSummary ? precedingSummary[row.key] : null;
                const now = latestSummary[row.key];
                const then = firstSummary ? firstSummary[row.key] : null;
                const delta = then == null ? null : now - then;
                const cls = [
                  row.memo ? styles.memoRow : '',
                  row.total ? styles.totalRow : '',
                  row.below ? styles.belowRow : '',
                  row.strong ? styles.strongRow : '',
                ].filter(Boolean).join(' ');
                return (
                  <tr key={row.key} className={cls}>
                    <td className={styles.rowLabel}>{row.label}</td>
                    {values.map((v, i) => {
                      const cell = cellFor(values, i, before);
                      const isLast = i === values.length - 1;
                      return (
                        <td key={i} className={`${styles.num} ${cell.cls} ${isLast ? styles.latestCol : ''}`}>
                          {cell.text}
                        </td>
                      );
                    })}
                    <td className={`${styles.num} ${styles.changeCol} ${changeClass(delta, row.invert)}`}>
                      {fmtSigned(delta)}
                    </td>
                    <td className={`${styles.num} ${styles.changeCol} ${changeClass(delta, row.invert)}`}>
                      {then == null ? '—' : fmtPct(pctChange(now, then))}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
        <div className={styles.footnote}>
          {windowMonths.length > 1
            ? `${monthLabel(windowMonths[0].key)} through ${monthLabel(latestMonth.key)}. `
            : `${monthLabel(latestMonth?.key)}. `}
          Total is Retirement + Liquid Assets. Stocks Less Tax takes {ratePct}% off
          the {TAXED_LIQUID_CATEGORY} bucket ({fmt(latestSummary.saleTax)} in the latest month); the rest of
          Stocks is assumed held, so no tax comes off it.
        </div>
      </div>

      {/* Where the latest month leaves you */}
      <div className={styles.sideGrid}>
        <div className={styles.card}>
          <div className={styles.cardTitle}>Investable · {monthLabel(latestMonth?.key)}</div>
          <table className={styles.miniTable}>
            <tbody>
              <tr>
                <td>Stocks <span className={styles.dim}>(less tax)</span></td>
                <td className={styles.num}>{fmt(latestSummary.stocksLessTax)}</td>
              </tr>
              <tr>
                <td>Cash</td>
                <td className={styles.num}>{fmt(latestSummary.cash)}</td>
              </tr>
              <tr className={styles.miniTotal}>
                <td>Total</td>
                <td className={styles.num}>{fmt(latestSummary.investable)}</td>
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
                  <tr key={e.id}><td colSpan={2}>{renderEarmarkForm()}</td></tr>
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

      {/* Account detail, month by month */}
      <div className={styles.card}>
        <div className={styles.cardTitleRow}>
          <div className={styles.cardTitle}>Accounts</div>
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
                <th>Category</th>
                <th>Liquid category</th>
                {windowMonths.map(m => (
                  <th key={m.key} className={styles.num}>{monthLabelShort(m.key)}</th>
                ))}
                <th className={`${styles.num} ${styles.changeCol}`}>{spanLabel}</th>
                <th className={`${styles.num} ${styles.changeCol}`}>%</th>
              </tr>
            </thead>
            <tbody>
              {visibleRows.map(r => (
                <tr key={r.name} className={r.category === CATEGORY_EXCLUDED ? styles.excludedRow : ''}>
                  <td>
                    <span className={styles.accountName}>{r.display}</span>
                    {!r.reported && (
                      <span className={styles.staleTag} title="No new balance posted in the latest month — carried forward from the last snapshot.">
                        carried forward
                      </span>
                    )}
                    {r.first == null && (
                      <span className={styles.newTag} title="Not present at the start of this window, so there is nothing to change against.">
                        new
                      </span>
                    )}
                  </td>
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
                  {r.values.map((v, i) => {
                    const cell = cellFor(r.values, i, r.before);
                    const isLast = i === r.values.length - 1;
                    return (
                      <td key={i} className={`${styles.num} ${cell.cls} ${isLast ? styles.latestCol : ''}`}>
                        {cell.text}
                      </td>
                    );
                  })}
                  <td className={`${styles.num} ${styles.changeCol} ${changeClass(r.change)}`}>{fmtSigned(r.change)}</td>
                  <td className={`${styles.num} ${styles.changeCol} ${changeClass(r.change)}`}>{fmtPct(r.pct)}</td>
                </tr>
              ))}
            </tbody>
            <tfoot>
              <tr>
                <td>Total shown</td>
                <td colSpan={2} />
                {columnTotals.values.map((v, i) => {
                  const cell = cellFor(columnTotals.values, i, columnTotals.before);
                  const isLast = i === columnTotals.values.length - 1;
                  return (
                    <td key={i} className={`${styles.num} ${cell.cls} ${isLast ? styles.latestCol : ''}`}>
                      {cell.text}
                    </td>
                  );
                })}
                <td className={`${styles.num} ${styles.changeCol} ${changeClass(columnTotals.change)}`}>
                  {fmtSigned(columnTotals.change)}
                </td>
                <td className={styles.changeCol} />
              </tr>
            </tfoot>
          </table>
        </div>
        <div className={styles.footnote}>
          Categories start as a guess from each account&apos;s asset class and name — change one and it sticks,
          and syncs to your other devices. A month with no new snapshot carries the last balance the account
          posted; a dash means it wasn&apos;t there yet.
        </div>
      </div>
    </div>
  );
}

export default NetWorthSnapshot;
