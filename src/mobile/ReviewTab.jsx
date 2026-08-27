import { useState, useMemo, useRef, useCallback, useEffect } from 'react';
import { useData, useDataActions } from '../contexts/DataContext';
import { ruleMatches } from '../lib/categorize';
import {
  buildHistoryIndex, suggestCategories, ruleDescriptionFor, LOW_CONFIDENCE,
} from '../lib/suggest';
import { buildReviewQueue, reviewStats, SORTS } from '../lib/reviewQueue';
import { ALL_CATEGORIES, getCategoryIcon, catColor, catBg, SUBCATEGORIES } from '../lib/categories';
import { CategorySheet, SubcategorySheet } from './CategorySheet';
import { AlertsStrip } from './AlertsStrip';
import { fmt, fmtCompact, fmtRelative } from './format';
import styles from './MobileApp.module.css';

// How far a card has to travel before the swipe counts, and how long the undo
// offer stays up.
const SWIPE_THRESHOLD = 96;
const UNDO_MS = 7000;

export function ReviewTab({ sort, onSortChange, askSub }) {
  const {
    transactions, categoryRules, customCategories, hiddenCategories,
    categoryColors, splitTags, spendAlerts,
  } = useData();
  const {
    updateTransactionCategory, updateTransactionSubcategory, bulkUpdateCategoryByIds,
    addCategoryRule, removeCategoryRule, addSubcategoryRule, addCustomCategory,
    getMatchCount, tagForSplit, untagSplit, categorizeAlert, dismissAlert,
  } = useDataActions();

  const [skipped, setSkipped] = useState(() => new Set());
  // Both remember toggles start off. A rule is a standing instruction that goes
  // on filing transactions long after this card is gone, so it should be a thing
  // you reach for — not the thing that happens when you file an expense without
  // reading the checkbox. Held as the card key it was ticked for rather than a
  // bare boolean, so moving to the next card puts it back down on its own.
  const [rememberFor, setRememberFor] = useState(null);
  const [rememberSub, setRememberSub] = useState(false);
  const [catSheet, setCatSheet] = useState(false);
  const [subSheet, setSubSheet] = useState(null); // { category, ids }
  const [undo, setUndo] = useState(null);
  const [splitBusy, setSplitBusy] = useState(false);
  const [splitResult, setSplitResult] = useState(null);
  const [drag, setDrag] = useState(0);
  const [dragging, setDragging] = useState(false);
  const dragStart = useRef(null);
  const undoTimer = useRef(null);

  // A transaction with no id can't have an override written against it — the
  // whole config layer is keyed by transaction id — so it would sit at the top
  // of the deck forever, un-clearable. Keep it out and say so instead.
  const { actionable, unkeyedCount } = useMemo(() => {
    let unkeyed = 0;
    const list = [];
    for (const t of transactions || []) {
      if (t.transactionId) list.push(t);
      else if (!t.category || t.category === 'Uncategorized') unkeyed += 1;
    }
    return { actionable: list, unkeyedCount: unkeyed };
  }, [transactions]);

  const queue = useMemo(
    () => buildReviewQueue(actionable, { sort, groupByMerchant: true, skipped }),
    [actionable, sort, skipped],
  );
  const stats = useMemo(() => reviewStats(actionable), [actionable]);
  const history = useMemo(() => buildHistoryIndex(actionable), [actionable]);

  const usage = useMemo(() => {
    const counts = {};
    for (const t of actionable) {
      const c = t.category;
      if (c && c !== 'Uncategorized') counts[c] = (counts[c] || 0) + 1;
    }
    return counts;
  }, [actionable]);

  const subsInUse = useMemo(() => {
    const byCat = new Map();
    for (const t of actionable) {
      if (!t.category || !t.subcategory) continue;
      let set = byCat.get(t.category);
      if (!set) byCat.set(t.category, (set = new Set()));
      set.add(t.subcategory);
    }
    return byCat;
  }, [actionable]);

  const categoryOptions = useMemo(() => {
    const set = new Set([...ALL_CATEGORIES, ...(customCategories || []), ...Object.keys(usage)]);
    for (const hidden of hiddenCategories || []) set.delete(hidden);
    return [...set];
  }, [customCategories, hiddenCategories, usage]);

  const item = queue[0] || null;
  const txn = item?.txn || null;
  const remember = !!item && rememberFor === item.key;

  const suggestions = useMemo(() => {
    if (!txn) return [];
    const matching = (categoryRules || []).filter(r => ruleMatches(r, txn));
    return suggestCategories(txn, history, { rules: matching, limit: 3 });
  }, [txn, history, categoryRules]);

  const ruleText = useMemo(
    () => (txn ? ruleDescriptionFor(txn.description || txn.fullDescription || '') : ''),
    [txn],
  );
  const ruleReach = useMemo(
    () => (ruleText ? getMatchCount(ruleText) : 0),
    [ruleText, getMatchCount],
  );

  useEffect(() => () => clearTimeout(undoTimer.current), []);

  const showUndo = useCallback((payload) => {
    clearTimeout(undoTimer.current);
    setUndo(payload);
    undoTimer.current = setTimeout(() => setUndo(null), UNDO_MS);
  }, []);

  /* Commit a category to every transaction behind the current card. */
  const assign = useCallback((category, options) => {
    if (!item || !category) return;
    const withRule = options?.remember ?? false;
    const ids = item.members.map(m => m.transactionId).filter(Boolean);
    if (!ids.length) return;

    if (!categoryOptions.includes(category)) addCustomCategory(category);

    if (ids.length > 1) bulkUpdateCategoryByIds(ids, category);
    else updateTransactionCategory(ids[0], null, category);

    let ruleSaved = null;
    if (withRule && ruleText) {
      addCategoryRule(ruleText, null, category);
      ruleSaved = { description: ruleText, category };
    }

    setSkipped(prev => {
      if (!ids.some(id => prev.has(id))) return prev;
      const next = new Set(prev);
      for (const id of ids) next.delete(id);
      return next;
    });

    const hasSubs = (SUBCATEGORIES[category] || []).length > 0;
    showUndo({
      ids,
      category,
      ruleSaved,
      label: `${item.groupSize > 1 ? `${item.groupSize} transactions` : (txn.description || 'Transaction')} → ${category}`,
      // Offer the subcategory step only where there is one to pick.
      subOptions: hasSubs,
    });
    // The detail question is asked here, on the card just filed, rather than
    // being buried behind a button on a toast that disappears in seven
    // seconds. Skipping is one tap, and turning the prompt off entirely is a
    // switch on the Rules screen for anyone clearing a big backlog.
    if (hasSubs && askSub) {
      setRememberSub(false);
      setSubSheet({ category, ids, merchant: ruleText, offerRule: true });
    }
    setDrag(0);
  }, [item, txn, ruleText, askSub, categoryOptions, addCustomCategory, bulkUpdateCategoryByIds,
      updateTransactionCategory, addCategoryRule, showUndo]);

  /* Undo writes 'Uncategorized' rather than deleting the override. Deletions
     of a config key don't reliably survive the union-merge a fresh device does
     on first sync, but a written value does — so this is the version of undo
     that still holds tomorrow. */
  const undoLast = useCallback(() => {
    if (!undo) return;
    clearTimeout(undoTimer.current);
    bulkUpdateCategoryByIds(undo.ids, 'Uncategorized');
    if (undo.ruleSaved) {
      const idx = (categoryRules || []).findIndex(
        r => r.description === undo.ruleSaved.description && r.category === undo.ruleSaved.category,
      );
      if (idx !== -1) removeCategoryRule(idx);
    }
    setUndo(null);
  }, [undo, categoryRules, bulkUpdateCategoryByIds, removeCategoryRule]);

  /* Commit a subcategory to the transactions just filed, and optionally
     remember it as a rule the same way a category can be remembered. */
  const applySubcategory = useCallback((sub) => {
    if (!subSheet) return;
    for (const id of subSheet.ids) updateTransactionSubcategory(id, sub);
    if (subSheet.offerRule && subSheet.merchant && rememberSub) {
      addSubcategoryRule(subSheet.merchant, null, sub);
    }
    setSubSheet(null);
  }, [subSheet, rememberSub, updateTransactionSubcategory, addSubcategoryRule]);

  /* Flag this charge as one other people owe a share of, and hand it to
     Rally. The tag sticks even if the hand-off fails; the Splits tab is
     where an unsent one gets retried. */
  const doSplit = useCallback(async () => {
    if (!txn || splitBusy) return;
    setSplitBusy(true);
    const res = await tagForSplit(txn, {});
    setSplitBusy(false);
    setSplitResult(res.ok
      ? { ok: true, message: 'Sent to Rally to split' }
      : { ok: false, message: res.error || 'Tagged, but not sent yet' });
    setTimeout(() => setSplitResult(null), 5000);
  }, [txn, splitBusy, tagForSplit]);

  const skip = useCallback(() => {
    if (!item) return;
    setSkipped(prev => {
      const next = new Set(prev);
      for (const m of item.members) if (m.transactionId) next.add(m.transactionId);
      return next;
    });
    setDrag(0);
  }, [item]);

  const top = suggestions[0];
  const canSwipeAccept = !!top && top.confidence >= LOW_CONFIDENCE;

  // ── Swipe ────────────────────────────────────────────
  const onPointerDown = (e) => {
    if (e.pointerType === 'mouse' && e.button !== 0) return;
    dragStart.current = e.clientX;
    setDragging(true);
    e.currentTarget.setPointerCapture?.(e.pointerId);
  };
  const onPointerMove = (e) => {
    if (dragStart.current == null) return;
    setDrag(e.clientX - dragStart.current);
  };
  const onPointerUp = () => {
    if (dragStart.current == null) return;
    dragStart.current = null;
    setDragging(false);
    if (drag >= SWIPE_THRESHOLD && canSwipeAccept) assign(top.category, { remember });
    else if (drag <= -SWIPE_THRESHOLD) skip();
    else setDrag(0);
  };

  const catColorFor = useCallback(
    (name) => (categoryColors && categoryColors[name]) || catColor(name),
    [categoryColors],
  );

  // ── Empty states ─────────────────────────────────────
  if (!item) {
    const everythingDone = stats.count === 0;
    return (
      <>
        <AlertsStrip
          alerts={spendAlerts}
          categoryOptions={categoryOptions}
          usage={usage}
          history={history}
          onCategorize={categorizeAlert}
          onDismiss={dismissAlert}
        />
        <ProgressStrip stats={stats} sort={sort} onSortChange={onSortChange} />
        <div className={styles.empty}>
          <span className={`material-symbols-outlined ${styles.emptyIcon}`}>
            {everythingDone ? 'task_alt' : 'inbox'}
          </span>
          <div className={styles.emptyTitle}>
            {everythingDone ? 'Everything is categorized' : 'Nothing left in this pass'}
          </div>
          <div className={styles.emptyText}>
            {everythingDone
              ? 'New transactions land here as they sync in from your sheet.'
              : `You skipped ${skipped.size} transaction${skipped.size === 1 ? '' : 's'}. Bring them back when you're ready to decide.`}
          </div>
          {skipped.size > 0 && (
            <button
              className={styles.actionBtn}
              style={{ marginTop: 20, maxWidth: 240, marginInline: 'auto' }}
              onClick={() => setSkipped(new Set())}
            >
              <span className="material-symbols-outlined" style={{ fontSize: 18 }}>undo</span>
              Bring back skipped
            </button>
          )}
          {unkeyedCount > 0 && (
            <div className={styles.emptyText} style={{ marginTop: 20, fontSize: 12 }}>
              {unkeyedCount} transaction{unkeyedCount === 1 ? ' has' : 's have'} no transaction ID in the
              sheet and can’t be categorized from any device.
            </div>
          )}
        </div>
        {undo && <UndoToast undo={undo} onUndo={undoLast} onDismiss={() => setUndo(null)} onSub={() => setSubSheet({ category: undo.category, ids: undo.ids })} />}
        {subSheet && (
          <SubcategorySheet
            category={subSheet.category}
            extra={[...(subsInUse.get(subSheet.category) || [])]}
            onPick={applySubcategory}
            onSkip={() => setSubSheet(null)}
            onClose={() => setSubSheet(null)}
          />
        )}
      </>
    );
  }

  // ── The deck ─────────────────────────────────────────
  // A grouped card is worth what the whole group is worth — that is the number
  // the decision is actually about.
  const splitTag = splitTags?.[txn.transactionId];
  const isSplit = !!splitTag;
  const cardAmount = item.groupTotal;
  const income = cardAmount > 0;
  const accepting = drag >= SWIPE_THRESHOLD && canSwipeAccept;
  const skipping = drag <= -SWIPE_THRESHOLD;

  return (
    <>
      <AlertsStrip
        alerts={spendAlerts}
        categoryOptions={categoryOptions}
        usage={usage}
        history={history}
        onCategorize={categorizeAlert}
        onDismiss={dismissAlert}
      />
      <ProgressStrip stats={stats} sort={sort} onSortChange={onSortChange} />

      <div className={styles.deck}>
        {queue.length > 1 && <div className={styles.cardBehind} aria-hidden="true" />}
        <div
          className={styles.card}
          style={{
            transform: `translateX(${drag}px) rotate(${drag / 28}deg)`,
            transition: dragging ? 'none' : 'transform var(--transition-base)',
          }}
          onPointerDown={onPointerDown}
          onPointerMove={onPointerMove}
          onPointerUp={onPointerUp}
          onPointerCancel={onPointerUp}
        >
          <div className={styles.cardHead}>
            <span
              className={styles.cardIcon}
              style={{ background: catBg(txn.category || 'Uncategorized', 0.1), color: catColorFor(txn.category || 'Uncategorized') }}
            >
              <span className="material-symbols-outlined">{getCategoryIcon(txn.category)}</span>
            </span>
            <div style={{ flex: 1, minWidth: 0 }}>
              <div className={styles.cardMerchant}>{txn.description || 'Unnamed transaction'}</div>
              <div className={styles.cardSub}>
                {fmtRelative(txn.date)}
                {txn.account ? ` · ${txn.account}` : ''}
              </div>
            </div>
          </div>

          <div className={`${styles.cardAmount} ${income ? styles.amountIn : styles.amountOut}`}>
            {income ? '+' : ''}{fmt(cardAmount)}
          </div>

          {isSplit && (
            <div className={styles.groupNote} style={{ background: 'rgba(217,70,239,0.1)', color: '#a21caf' }}>
              <span className="material-symbols-outlined">call_split</span>
              {splitTag?.error ? 'Tagged to split — not sent to Rally yet' : 'Splitting in Rally'}
            </div>
          )}

          {item.groupSize > 1 && (
            <div className={styles.groupNote}>
              <span className="material-symbols-outlined">layers</span>
              {item.groupSize} charges from here — one tap files them all
            </div>
          )}

          {txn.fullDescription && txn.fullDescription !== txn.description && (
            <div className={styles.fullDesc}>{txn.fullDescription}</div>
          )}

          {/* Only offered when swiping right would actually file something —
              with no confident suggestion, promising a category the release
              won't apply is worse than no affordance at all. */}
          {canSwipeAccept && (
            <div
              className={`${styles.swipeHint} ${styles.hintAccept}`}
              style={{ opacity: accepting ? 1 : Math.max(0, Math.min(1, drag / SWIPE_THRESHOLD)) }}
            >
              <span className="material-symbols-outlined" style={{ fontSize: 16 }}>check</span>
              {top.category}
            </div>
          )}
          <div
            className={`${styles.swipeHint} ${styles.hintSkip}`}
            style={{ opacity: skipping ? 1 : Math.max(0, Math.min(1, -drag / SWIPE_THRESHOLD)) }}
          >
            Skip
            <span className="material-symbols-outlined" style={{ fontSize: 16 }}>redo</span>
          </div>
        </div>
      </div>

      <div className={styles.sectionLabel}>
        {suggestions.length === 0
          ? 'No match in your history'
          : top.confidence >= LOW_CONFIDENCE ? 'Suggested' : 'Your most-used'}
      </div>

      <div className={styles.suggestList}>
        {suggestions.map((s, i) => (
          <button
            key={s.category}
            className={`${styles.suggest} ${i === 0 && s.confidence >= LOW_CONFIDENCE ? styles.suggestPrimary : ''}`}
            onClick={() => assign(s.category, { remember })}
          >
            <span className={styles.suggestIcon} style={{ background: catBg(s.category, 0.12), color: catColorFor(s.category) }}>
              <span className="material-symbols-outlined">{getCategoryIcon(s.category)}</span>
            </span>
            <span className={styles.suggestText}>
              <span className={styles.suggestName}>{s.category}</span>
              <span className={styles.suggestWhy}>{s.reason}</span>
            </span>
            {s.confidence >= LOW_CONFIDENCE && (
              <span className={styles.confidence}>{Math.round(s.confidence * 100)}%</span>
            )}
          </button>
        ))}
      </div>

      {ruleText && (
        <label className={styles.rememberRow}>
          <input type="checkbox" checked={remember} onChange={(e) => setRememberFor(e.target.checked ? item.key : null)} />
          <span>
            Remember <strong>“{ruleText}”</strong>
            {ruleReach > 1 ? ` — a rule covering ${ruleReach} transactions, now and later` : ' as a rule for next time'}
          </span>
        </label>
      )}

      <div className={styles.actions}>
        <button className={styles.actionBtn} onClick={skip}>
          <span className="material-symbols-outlined" style={{ fontSize: 19 }}>redo</span>
          Skip
        </button>
        <button
          className={`${styles.actionBtn} ${isSplit ? styles.actionSplitOn : ''}`}
          onClick={isSplit ? () => untagSplit(txn.transactionId) : doSplit}
          disabled={splitBusy || txn.amount > 0}
          title={txn.amount > 0 ? 'Only a charge can be split' : 'Someone owes me part of this'}
        >
          <span className="material-symbols-outlined" style={{ fontSize: 19 }}>
            {splitBusy ? 'progress_activity' : isSplit ? 'group' : 'call_split'}
          </span>
          {isSplit ? 'Splitting' : 'Split'}
        </button>
        <button className={`${styles.actionBtn} ${styles.actionPrimary}`} onClick={() => setCatSheet(true)}>
          <span className="material-symbols-outlined" style={{ fontSize: 19 }}>list</span>
          All
        </button>
      </div>

      {splitResult && (
        <div
          className={styles.splitNote}
          style={splitResult.ok ? undefined : { background: 'rgba(232,163,23,0.12)', color: '#8a6100' }}
        >
          <span className="material-symbols-outlined" style={{ fontSize: 17 }}>
            {splitResult.ok ? 'check_circle' : 'schedule_send'}
          </span>
          {splitResult.message}
        </div>
      )}

      {undo && (
        <UndoToast
          undo={undo}
          onUndo={undoLast}
          onDismiss={() => setUndo(null)}
          onSub={() => setSubSheet({ category: undo.category, ids: undo.ids })}
        />
      )}

      {catSheet && (
      <CategorySheet
        categories={categoryOptions}
        usage={usage}
        active={txn.category}
        onPick={(cat) => { setCatSheet(false); assign(cat, { remember }); }}
        onCreate={(name) => { setCatSheet(false); assign(name, { remember }); }}
        onClose={() => setCatSheet(false)}
      />
      )}

      {subSheet && (
        <SubcategorySheet
          category={subSheet.category}
          extra={[...(subsInUse.get(subSheet.category) || [])]}
          onPick={applySubcategory}
          onSkip={() => setSubSheet(null)}
          onClose={() => setSubSheet(null)}
          footer={subSheet.offerRule && subSheet.merchant ? (
            <label className={styles.rememberRow} style={{ margin: '0 var(--space-4) var(--space-3)' }}>
              <input type="checkbox" checked={rememberSub} onChange={(e) => setRememberSub(e.target.checked)} />
              <span>Remember this detail for <strong>“{subSheet.merchant}”</strong></span>
            </label>
          ) : null}
        />
      )}
    </>
  );
}

function ProgressStrip({ stats, sort, onSortChange }) {
  const order = ['impact', 'newest', 'oldest'];
  const next = () => onSortChange(order[(order.indexOf(sort) + 1) % order.length]);
  return (
    <div className={styles.progress}>
      <div className={styles.progressTop}>
        <div className={styles.progressCount}>
          {stats.count === 0 ? 'All clear' : `${stats.count} to categorize`}
        </div>
        <button
          className={styles.progressAmount}
          onClick={next}
          style={{ border: 'none', background: 'none', fontFamily: 'inherit', cursor: 'pointer', padding: 0 }}
        >
          {SORTS[sort]?.label} ⇅
        </button>
      </div>
      <div className={styles.progressTrack}>
        <div className={styles.progressFill} style={{ width: `${Math.round(stats.percentDone * 100)}%` }} />
      </div>
      <div className={styles.progressAmount} style={{ marginTop: 6 }}>
        {stats.count > 0
          ? `${fmtCompact(stats.amount)} unaccounted for · ${Math.round(stats.percentDone * 100)}% done`
          : `${stats.categorized.toLocaleString()} transactions filed`}
      </div>
    </div>
  );
}

function UndoToast({ undo, onUndo, onDismiss, onSub }) {
  return (
    <div className={styles.toast}>
      <span className="material-symbols-outlined" style={{ fontSize: 18, color: '#4ade80' }}>check_circle</span>
      <span className={styles.toastText}>{undo.label}</span>
      {undo.subOptions && (
        <button className={styles.toastBtn} onClick={onSub}>Detail</button>
      )}
      <button className={styles.toastBtn} onClick={onUndo}>Undo</button>
      <button className={styles.toastBtn} style={{ color: '#94a3b8' }} onClick={onDismiss} aria-label="Dismiss">✕</button>
    </div>
  );
}
