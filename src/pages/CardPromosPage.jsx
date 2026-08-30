import { useMemo, useState, useCallback } from 'react';
import { useData, useDataActions } from '../contexts/DataContext';
import {
  REWARD_CATEGORIES, CARD_KEYS, CARD_LABELS, CARD_COLORS, BOFA_CHOICE, POINT_VALUE_CENTS,
  detectCardKey, findSuboptimalCharges,
} from '../lib/cardRewards';
// These moved to a lib so the weekly email can report the same numbers this
// page shows. The page is no longer the only thing that knows what a promo is.
import {
  SEED_PROMOS, isPromoCompleted, promoHasAutoMatch, promoIsTracked, autoUsedForPromo,
  matchingTransactions, periodWindowStart,
} from '../lib/cardPromos';

function fmt(n) {
  if (n == null || n === '') return '—';
  return new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', minimumFractionDigits: 0, maximumFractionDigits: 0 }).format(n);
}

function todayISO() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

function parseISODate(s) {
  if (!s) return null;
  const d = new Date(String(s).slice(0, 10) + 'T00:00:00');
  return isNaN(d) ? null : d;
}

// The CSR sub-tab owns any promo whose card reads as a Sapphire Reserve, so a
// renamed/nicknamed card ("CSR", "Chase Sapphire Reserve …") still lands there.
function isSapphireCard(card) {
  const c = (card || '').toLowerCase();
  return c.includes('sapphire') || c.trim() === 'csr';
}

/* ── Reward optimization matrix: best card per spending category ──
   Static reference of effective cash-back / points rates across the user's
   cards, so the best card to swipe for each category is at a glance. */
const REWARD_MATRIX = [
  { cat: 'Amazon / Whole Foods / Amazon Fresh', best: 'Prime Visa', rate: '5%', runner: '—' },
  { cat: 'Dining / Restaurants', best: 'Sapphire Reserve', rate: '~4.5% (3X)', runner: 'BofA 3% if selected' },
  { cat: 'Gas / EV charging', best: 'BofA (if selected)', rate: '3%', runner: 'Prime Visa 2%' },
  { cat: 'Travel — booked via Chase Travel', best: 'Sapphire Reserve', rate: '~12% (8X)', runner: 'Prime Visa 5%' },
  { cat: 'Travel — booked direct (flights/hotels)', best: 'Sapphire Reserve', rate: '~6% (4X)', runner: 'BofA 3% if selected' },
  { cat: 'Transit / rideshare', best: 'Prime Visa', rate: '2%', runner: '—' },
  { cat: 'Groceries (supermarkets)', best: 'BofA', rate: '2%', runner: '—' },
  { cat: 'Wholesale clubs', best: 'BofA', rate: '2%', runner: '—' },
  { cat: 'Drugstores / pharmacies', best: 'BofA (if selected)', rate: '3%', runner: 'all others 1%' },
  { cat: 'Online shopping (non-Amazon)', best: 'BofA (if selected)', rate: '3%', runner: 'all others 1%' },
  { cat: 'Home improvement', best: 'BofA (if selected)', rate: '3%', runner: 'all others 1%' },
  { cat: 'Everything else', best: 'Sapphire Reserve', rate: '~1.5%', runner: 'Prime Visa / BofA 1%' },
];

function rewardCardColor(best) {
  const b = (best || '').toLowerCase();
  if (b.includes('prime')) return '#00a8e1';
  if (b.includes('sapphire')) return '#0058be';
  if (b.includes('bofa') || b.includes('bank of america')) return '#e31837';
  return '#475569';
}

// Per-card rate grid, derived from the shared rate table in lib/cardRewards so
// the grid and the suboptimal-charge flagging can't disagree. `best` is the
// column index of the winning card, used to highlight the cell.
const CARD_RATE_COLUMNS = CARD_KEYS.map(k => CARD_LABELS[k]);
const CARD_RATE_COLORS = CARD_KEYS.map(k => CARD_COLORS[k]);
const CARD_RATE_MATRIX = REWARD_CATEGORIES.map(c => {
  const rates = CARD_KEYS.map(k => c.display[k]);
  const effective = CARD_KEYS.map(k => c.rates[k]);
  return { cat: c.label, rates, effective, best: effective.indexOf(Math.max(...effective)) };
});



// Which rate profile each account uses. Only needed for accounts whose name
// doesn't already say which card it is (e.g. "CREDIT CARD (-1947)"). Values are
// a card key, or 'ignore' to leave an account out of the analysis entirely.


// Cents matter here — a single miss is often worth under a dollar.
function fmtCents(n) {
  if (n == null) return '—';
  return new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(n);
}

function shortDate(iso) {
  const d = new Date(iso);
  if (isNaN(d)) return iso;
  return `${d.getMonth() + 1}/${d.getDate()}/${String(d.getFullYear()).slice(-2)}`;
}

export function CardPromosPage() {
  const { transactions, accountNicknames, accountGroups, cardMap, cardPromos: promos, promoTags } = useData();
  const { setCardForAccount, setCardPromos, setPromoTagForTransactions, clearPromoTagsFor } = useDataActions();
  const displayName = (name) => (accountGroups && accountGroups[name]) || (accountNicknames && accountNicknames[name]) || name;
  // Keeps the updater-function call sites below working now that the list
  // lives in the provider, which takes a plain value.
  const setPromos = useCallback(
    (next) => setCardPromos(typeof next === 'function' ? next(promos) : next),
    [promos, setCardPromos],
  );
  const [editingId, setEditingId] = useState(null);
  const [editDraft, setEditDraft] = useState({});
  const [showSeedBtn, setShowSeedBtn] = useState(false);
  const [view, setView] = useState('csr'); // 'csr' | 'promos'
  // Which promo has its counted-transactions list open.
  const [expandedId, setExpandedId] = useState(null);

  // Charges in the last 30 days that would have earned more on another card.
  // An explicit mapping wins over guessing the card from the account name.
  const suboptimal = useMemo(() => {
    const resolve = name => (accountGroups && accountGroups[name]) || (accountNicknames && accountNicknames[name]) || name;
    return findSuboptimalCharges({
      transactions,
      cardKeyFor: account => cardMap[account] || detectCardKey(account, resolve(account)),
    });
  }, [transactions, cardMap, accountNicknames, accountGroups]);

  // Resolve "effective used" per promo, in priority order:
  //   1. manually marked complete this cycle → count the full value
  //   2. auto-tracked from transactions if a match field is set
  //   3. the manual "used" value the user typed
  const effectiveUsed = useMemo(() => {
    const map = new Map();
    for (const p of promos) {
      if (isPromoCompleted(p)) {
        map.set(p.id, Number(p.value) || 0);
        continue;
      }
      const auto = autoUsedForPromo(p, transactions, new Date(), promoTags);
      map.set(p.id, auto != null ? auto : (Number(p.used) || 0));
    }
    return map;
  }, [promos, transactions, promoTags]);

  // The transactions counted against each promo — its match rules plus anything
  // tagged by hand — so the page can show its work instead of a bare number.
  const promoMatches = useMemo(() => {
    const map = new Map();
    for (const p of promos) map.set(p.id, matchingTransactions(p, transactions, promoTags));
    return map;
  }, [promos, transactions, promoTags]);

  // Each sub-tab is a slice of the same promo list: CSR benefits vs. everything else.
  const csrCount = useMemo(() => promos.filter(p => isSapphireCard(p.card)).length, [promos]);
  const visiblePromos = useMemo(
    () => promos.filter(p => isSapphireCard(p.card) === (view === 'csr')),
    [promos, view]
  );

  const byCard = useMemo(() => {
    const groups = {};
    for (const p of visiblePromos) {
      if (!groups[p.card]) groups[p.card] = [];
      groups[p.card].push(p);
    }
    return Object.entries(groups).sort((a, b) => a[0].localeCompare(b[0]));
  }, [visiblePromos]);

  const totals = useMemo(() => {
    let totalValue = 0;
    let totalUsed = 0;
    for (const p of visiblePromos) {
      const value = Number(p.value) || 0;
      const used = effectiveUsed.get(p.id) || 0;
      totalValue += value;
      totalUsed += Math.min(used, value);
    }
    return {
      totalValue,
      totalUsed,
      remaining: totalValue - totalUsed,
      pct: totalValue > 0 ? totalUsed / totalValue : 0,
      doneCount: visiblePromos.filter(isPromoCompleted).length,
      count: visiblePromos.length,
    };
  }, [visiblePromos, effectiveUsed]);

  function addPromo() {
    const newPromo = {
      id: `promo-${Date.now()}`,
      // Prefill the card on the CSR tab so the new promo stays on the tab you added it from.
      card: view === 'csr' ? 'Chase Sapphire Reserve' : '',
      name: 'New Benefit',
      value: 0,
      used: 0,
      period: 'annual',
      notes: '',
      color: view === 'csr' ? '#0058be' : '#475569',
      renewsOn: '',
    };
    setPromos(prev => [newPromo, ...prev]);
    setEditingId(newPromo.id);
    setEditDraft(newPromo);
  }

  function startEdit(promo) {
    setEditingId(promo.id);
    setEditDraft(promo);
  }

  function saveEdit() {
    setPromos(prev => prev.map(p => p.id === editingId ? {
      ...editDraft,
      value: Number(editDraft.value) || 0,
      used: Number(editDraft.used) || 0,
    } : p));
    setEditingId(null);
    setEditDraft({});
  }

  function cancelEdit() {
    setEditingId(null);
    setEditDraft({});
  }

  function deletePromo(id) {
    if (!confirm('Delete this promo?')) return;
    setPromos(prev => prev.filter(p => p.id !== id));
    // Otherwise its tags outlive it, and a tag pointing at a promo that no
    // longer exists keeps those transactions out of every other promo's rules.
    clearPromoTagsFor(id);
  }

  // Manual completion log: stamps today's date, or clears it to reopen the promo.
  function toggleCompleted(promo) {
    const done = isPromoCompleted(promo);
    setPromos(prev => prev.map(p => p.id === promo.id ? { ...p, completedAt: done ? '' : todayISO() } : p));
  }

  function resetAllUsage() {
    if (!confirm('Reset all promos for a new cycle? This clears manual "used" amounts and un-marks anything logged as completed.')) return;
    setPromos(prev => prev.map(p => ({ ...p, used: 0, completedAt: '' })));
  }

  function restoreSeed() {
    if (!confirm('Replace your list with the default seed list? Your custom changes will be lost.')) return;
    setPromos(SEED_PROMOS);
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 24 }}>
      {/* Header + sub-tabs */}
      <div style={{ display: 'flex', alignItems: 'flex-end', justifyContent: 'space-between', gap: 16, flexWrap: 'wrap' }}>
        <div>
          <div style={{ fontFamily: 'var(--font-headline)', fontSize: 24, fontWeight: 700, marginBottom: 4 }}>Card Promotions</div>
          <div style={{ fontSize: 13, color: 'var(--color-text-tertiary)' }}>
            {view === 'csr'
              ? 'Statement credits and benefits included with your Chase Sapphire Reserve'
              : 'Track statement credits and benefits across your other credit cards'}
          </div>
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
          <div style={{ display: 'inline-flex', gap: 2, background: 'var(--color-surface-alt)', padding: 2, borderRadius: 10 }}>
            {[{ key: 'csr', label: 'Chase Sapphire Reserve' }, { key: 'promos', label: 'Card Promotions' }].map(t => (
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
          <button onClick={addPromo} style={btnPrimaryStyle}>
            <span className="material-symbols-outlined" style={{ fontSize: 16 }}>add</span>
            Add Promo
          </button>
          <button onClick={resetAllUsage} style={btnSecondaryStyle}>
            <span className="material-symbols-outlined" style={{ fontSize: 16 }}>refresh</span>
            Reset Usage
          </button>
          <div style={{ position: 'relative' }} onMouseEnter={() => setShowSeedBtn(true)} onMouseLeave={() => setShowSeedBtn(false)}>
            <button style={{ ...btnSecondaryStyle, padding: '8px 10px' }}>
              <span className="material-symbols-outlined" style={{ fontSize: 16 }}>more_vert</span>
            </button>
            {showSeedBtn && (
              <div style={{ position: 'absolute', top: '100%', right: 0, marginTop: 4, background: 'var(--color-surface)', border: 'var(--border-ghost)', borderRadius: 8, boxShadow: 'var(--shadow-sm)', zIndex: 10, minWidth: 180 }}>
                <button onClick={restoreSeed} style={{ ...btnMenuStyle, color: 'var(--color-text-primary)' }}>
                  Restore default list
                </button>
              </div>
            )}
          </div>
        </div>
      </div>

      {/* Totals */}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, minmax(0, 1fr))', gap: 16 }}>
        <StatCard label="Total Value" value={fmt(totals.totalValue)} color="#0058be" icon="redeem" />
        <StatCard label="Used" value={fmt(totals.totalUsed)} color="#16a34a" icon="check_circle" sub={`${Math.round(totals.pct * 100)}% of total`} />
        <StatCard label="Remaining" value={fmt(totals.remaining)} color="#e8a317" icon="schedule" sub="Still available this cycle" />
        <StatCard label="Completed" value={`${totals.doneCount} of ${totals.count}`} color="#7c3aed" icon="task_alt" sub="Manually logged this cycle" />
      </div>

      {/* Cross-card comparisons live on the general tab */}
      {view === 'promos' && (
        <SuboptimalCharges
          result={suboptimal}
          cardMap={cardMap}
          setCardForAccount={setCardForAccount}
          displayName={displayName}
        />
      )}
      {view === 'promos' && <CashBackSummary />}

      {/* Grouped by card */}
      {byCard.length === 0 && (
        <div style={{ background: 'var(--color-surface)', border: 'var(--border-ghost)', borderRadius: 'var(--radius-xl)', padding: 40, textAlign: 'center', color: 'var(--color-text-tertiary)' }}>
          {view === 'csr'
            ? 'No Chase Sapphire Reserve benefits yet. Click "Add Promo" to get started.'
            : csrCount > 0
              ? 'No promos on other cards yet. Click "Add Promo" to add one, or switch to the Chase Sapphire Reserve tab.'
              : 'No promos yet. Click "Add Promo" to get started.'}
        </div>
      )}

      {byCard.map(([cardName, cardPromos]) => {
        const cardColor = cardPromos[0]?.color || '#475569';
        const cardValue = cardPromos.reduce((s, p) => s + (Number(p.value) || 0), 0);
        const cardUsed = cardPromos.reduce((s, p) => s + Math.min(effectiveUsed.get(p.id) || 0, Number(p.value) || 0), 0);
        return (
          <div key={cardName} style={{ background: 'var(--color-surface)', border: 'var(--border-ghost)', borderRadius: 'var(--radius-xl)', padding: 20, boxShadow: 'var(--shadow-xs)' }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 16, borderBottom: '1px solid var(--border-ghost)', paddingBottom: 12 }}>
              <div style={{ width: 40, height: 40, borderRadius: 8, background: cardColor, display: 'flex', alignItems: 'center', justifyContent: 'center', color: '#fff' }}>
                <span className="material-symbols-outlined" style={{ fontSize: 22 }}>credit_card</span>
              </div>
              <div style={{ flex: 1 }}>
                <div style={{ fontFamily: 'var(--font-headline)', fontSize: 16, fontWeight: 700 }}>{displayName(cardName) || '(Unnamed card)'}</div>
                <div style={{ fontSize: 12, color: 'var(--color-text-tertiary)' }}>
                  {fmt(cardUsed)} used of {fmt(cardValue)} ({cardValue > 0 ? Math.round((cardUsed / cardValue) * 100) : 0}%)
                  {' · '}{cardPromos.filter(isPromoCompleted).length} of {cardPromos.length} logged complete
                </div>
              </div>
            </div>

            <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
              {cardPromos.map(p => {
                const isEditing = editingId === p.id;
                const usedNow = effectiveUsed.get(p.id) || 0;
                const isDone = isPromoCompleted(p);
                const isAuto = promoHasAutoMatch(p) && !isDone;
                const matches = promoMatches.get(p.id) || [];
                const taggedCount = matches.filter(m => m._tagged).length;
                const cycleStart = periodWindowStart(p.period);
                const isExpanded = expandedId === p.id;
                const pct = p.value > 0 ? Math.min(1, usedNow / Number(p.value)) : 0;
                const remaining = Math.max(0, (Number(p.value) || 0) - usedNow);

                if (isEditing) {
                  return (
                    <div key={p.id} style={{ border: `2px solid ${cardColor}`, borderRadius: 8, padding: 12, background: 'var(--color-surface-alt)' }}>
                      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8, marginBottom: 8 }}>
                        <LabeledInput label="Card" value={editDraft.card} onChange={v => setEditDraft({ ...editDraft, card: v })} />
                        <LabeledInput label="Name" value={editDraft.name} onChange={v => setEditDraft({ ...editDraft, name: v })} />
                      </div>
                      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(6, minmax(0, 1fr))', gap: 8, marginBottom: 8 }}>
                        <LabeledInput label="Total $" type="number" value={editDraft.value} onChange={v => setEditDraft({ ...editDraft, value: v })} />
                        <LabeledInput label="Used $ (manual)" type="number" value={editDraft.used} onChange={v => setEditDraft({ ...editDraft, used: v })} />
                        <LabeledInput label="Completed on" type="date" value={editDraft.completedAt} onChange={v => setEditDraft({ ...editDraft, completedAt: v })} />
                        <div>
                          <div style={labelStyle}>Period</div>
                          <select value={editDraft.period || 'annual'} onChange={e => setEditDraft({ ...editDraft, period: e.target.value })} style={inputStyle}>
                            <option value="annual">Annual</option>
                            <option value="monthly">Monthly</option>
                            <option value="quarterly">Quarterly</option>
                            <option value="one-time">One-time</option>
                          </select>
                        </div>
                        <LabeledInput label="Renews on" type="date" value={editDraft.renewsOn} onChange={v => setEditDraft({ ...editDraft, renewsOn: v })} />
                        <div>
                          <div style={labelStyle}>Color</div>
                          <input type="color" value={editDraft.color || '#475569'} onChange={e => setEditDraft({ ...editDraft, color: e.target.value })} style={{ ...inputStyle, padding: 2, height: 34 }} />
                        </div>
                      </div>
                      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: 8, marginBottom: 8 }}>
                        <LabeledInput label="Auto-track Subcategory" value={editDraft.matchSubcategory} onChange={v => setEditDraft({ ...editDraft, matchSubcategory: v })} />
                        <LabeledInput label="Or Category" value={editDraft.matchCategory} onChange={v => setEditDraft({ ...editDraft, matchCategory: v })} />
                        <LabeledInput label="Or Merchant contains" value={editDraft.matchDescription} onChange={v => setEditDraft({ ...editDraft, matchDescription: v })} />
                      </div>
                      <div style={{ fontSize: 11, color: 'var(--color-text-tertiary)', marginBottom: 8 }}>
                        Marking a promo complete (the checkbox on the row, or "Completed on" above) wins over everything below and counts the full value. Otherwise: if any match field is set — or any transaction is tagged to this promo from the Transactions page — "used" auto-sums the absolute value of those transactions in the current cycle (manual "Used $" is ignored). A hand-tag always wins over the match fields, including another promo's, so a charge only ever counts once. Sign doesn't matter — tag the original travel charge (negative) to track redeemable spend, or tag the statement credit (positive) to track actual redemption. Multiple match fields are OR'd. "Merchant contains" matches anywhere in the transaction's merchant text.
                      </div>
                      <LabeledInput label="Notes" value={editDraft.notes} onChange={v => setEditDraft({ ...editDraft, notes: v })} />
                      <div style={{ display: 'flex', gap: 8, marginTop: 10, justifyContent: 'flex-end' }}>
                        <button onClick={cancelEdit} style={btnSecondaryStyle}>Cancel</button>
                        <button onClick={saveEdit} style={btnPrimaryStyle}>Save</button>
                      </div>
                    </div>
                  );
                }

                return (
                  <div key={p.id} style={{
                    border: isDone ? '1px solid rgba(22,163,74,0.35)' : '1px solid var(--border-ghost)',
                    background: isDone ? 'rgba(22,163,74,0.04)' : 'transparent',
                    borderRadius: 8, padding: 14, display: 'flex', gap: 12, alignItems: 'flex-start',
                  }}>
                    {/* Manual completion checkbox */}
                    <button
                      onClick={() => toggleCompleted(p)}
                      title={isDone
                        ? `Marked complete${(() => { const d = parseISODate(p.completedAt); return d ? ` on ${d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })}` : ''; })()} — click to reopen`
                        : 'Mark this benefit as used/completed'}
                      style={{
                        flexShrink: 0, marginTop: 1, width: 22, height: 22, borderRadius: 6, cursor: 'pointer',
                        display: 'flex', alignItems: 'center', justifyContent: 'center',
                        border: isDone ? '1px solid #16a34a' : '1.5px solid var(--border-ghost)',
                        background: isDone ? '#16a34a' : 'var(--color-surface)',
                        color: isDone ? '#fff' : 'var(--color-text-tertiary)',
                        padding: 0,
                      }}
                    >
                      <span className="material-symbols-outlined" style={{ fontSize: 15, opacity: isDone ? 1 : 0.35 }}>check</span>
                    </button>
                    <div style={{ flex: 1, minWidth: 0 }}>
                      <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 4, flexWrap: 'wrap' }}>
                        <div style={{ fontFamily: 'var(--font-headline)', fontSize: 14, fontWeight: 700, textDecoration: isDone ? 'line-through' : 'none', textDecorationColor: 'rgba(22,163,74,0.5)' }}>{p.name}</div>
                        {isDone && (
                          <span style={{ display: 'inline-flex', alignItems: 'center', gap: 3, fontSize: 10, fontWeight: 700, padding: '2px 6px', borderRadius: 4, background: 'rgba(22,163,74,0.12)', color: '#16a34a', textTransform: 'uppercase', letterSpacing: '0.05em' }}>
                            <span className="material-symbols-outlined" style={{ fontSize: 12 }}>task_alt</span>
                            Completed
                          </span>
                        )}
                        <span style={{ fontSize: 10, fontWeight: 700, padding: '2px 6px', borderRadius: 4, background: 'var(--color-surface-alt)', color: 'var(--color-text-tertiary)', textTransform: 'uppercase', letterSpacing: '0.05em' }}>
                          {p.period}
                        </span>
                        {p.renewsOn && (() => {
                          const d = new Date(p.renewsOn + 'T00:00:00');
                          if (isNaN(d)) return null;
                          const today = new Date();
                          today.setHours(0, 0, 0, 0);
                          const days = Math.round((d - today) / 86400000);
                          const dateLabel = d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
                          const tip = days > 0
                            ? `Renews in ${days} day${days === 1 ? '' : 's'} (${dateLabel})`
                            : days === 0
                              ? `Renews today (${dateLabel})`
                              : `Renewal date passed ${-days} day${days === -1 ? '' : 's'} ago (${dateLabel})`;
                          return (
                            <span title={tip} style={{ display: 'inline-flex', alignItems: 'center', gap: 3, fontSize: 10, fontWeight: 700, padding: '2px 6px', borderRadius: 4, background: 'rgba(232, 163, 23, 0.12)', color: '#a36b00', textTransform: 'uppercase', letterSpacing: '0.05em' }}>
                              <span className="material-symbols-outlined" style={{ fontSize: 12 }}>event_repeat</span>
                              Renews {dateLabel}
                            </span>
                          );
                        })()}
                        {isAuto && (() => {
                          const parts = [];
                          if (p.matchSubcategory) parts.push(`subcategory “${p.matchSubcategory}”`);
                          if (p.matchCategory) parts.push(`category “${p.matchCategory}”`);
                          if (p.matchDescription) parts.push(`description contains “${p.matchDescription}”`);
                          return (
                            <span title={`Auto-tracked from ${parts.join(' OR ')}`}
                                  style={{ display: 'inline-flex', alignItems: 'center', gap: 3, fontSize: 10, fontWeight: 700, padding: '2px 6px', borderRadius: 4, background: 'rgba(0,88,190,0.08)', color: 'var(--color-secondary, #0058be)', textTransform: 'uppercase', letterSpacing: '0.05em' }}>
                              <span className="material-symbols-outlined" style={{ fontSize: 12 }}>autorenew</span>
                              Auto
                            </span>
                          );
                        })()}
                        {taggedCount > 0 && (
                          <span title={`${taggedCount} transaction${taggedCount === 1 ? '' : 's'} tagged to this benefit from the Transactions page`}
                                style={{ display: 'inline-flex', alignItems: 'center', gap: 3, fontSize: 10, fontWeight: 700, padding: '2px 6px', borderRadius: 4, background: 'rgba(124,58,237,0.1)', color: '#7c3aed', textTransform: 'uppercase', letterSpacing: '0.05em' }}>
                            <span className="material-symbols-outlined" style={{ fontSize: 12 }}>sell</span>
                            {taggedCount} tagged
                          </span>
                        )}
                      </div>
                      {p.notes && <div style={{ fontSize: 12, color: 'var(--color-text-tertiary)', marginBottom: 8, lineHeight: 1.4 }}>{p.notes}</div>}
                      <div style={{ height: 6, background: 'var(--color-surface-alt)', borderRadius: 3, overflow: 'hidden', marginBottom: 4 }}>
                        <div style={{ height: '100%', width: `${pct * 100}%`, background: pct >= 1 ? '#16a34a' : cardColor, transition: 'width 0.2s' }} />
                      </div>
                      <div style={{ fontSize: 11.5, color: 'var(--color-text-secondary)', fontVariantNumeric: 'tabular-nums' }}>
                        {isDone ? (
                          <span style={{ color: '#16a34a', fontWeight: 600 }}>
                            Logged as completed{(() => {
                              const d = parseISODate(p.completedAt);
                              return d ? ` on ${d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })}` : '';
                            })()} · {fmt(p.value)} counted
                          </span>
                        ) : (
                          <>{fmt(usedNow)} used · <strong style={{ color: remaining > 0 ? '#16a34a' : 'var(--color-text-tertiary)' }}>{fmt(remaining)} remaining</strong> of {fmt(p.value)}</>
                        )}
                      </div>
                      {matches.length > 0 && (
                        <>
                          <button
                            type="button"
                            onClick={() => setExpandedId(isExpanded ? null : p.id)}
                            style={{
                              marginTop: 6, padding: 0, border: 'none', background: 'transparent',
                              cursor: 'pointer', fontSize: 11.5, fontWeight: 600,
                              color: 'var(--color-secondary, #0058be)',
                              display: 'inline-flex', alignItems: 'center', gap: 3,
                            }}
                          >
                            <span className="material-symbols-outlined" style={{ fontSize: 14 }}>
                              {isExpanded ? 'expand_less' : 'expand_more'}
                            </span>
                            {matches.length} counted transaction{matches.length === 1 ? '' : 's'}
                          </button>
                          {isExpanded && (
                            <div style={{ marginTop: 6, border: '1px solid var(--border-ghost)', borderRadius: 6, overflow: 'hidden' }}>
                              {matches.slice(0, 40).map((m, mi) => {
                                // Only spend inside the current cycle feeds the "used"
                                // number above; older hits are shown dimmed so the list
                                // and the total can't look like they disagree.
                                const inCycle = cycleStart ? m._date >= cycleStart : true;
                                return (
                                  <div
                                    key={m.transactionId || mi}
                                    style={{
                                      display: 'flex', alignItems: 'center', gap: 8,
                                      padding: '6px 8px', fontSize: 11.5,
                                      borderTop: mi === 0 ? 'none' : '1px solid var(--border-ghost)',
                                      opacity: inCycle ? 1 : 0.5,
                                    }}
                                  >
                                    <span style={{ color: 'var(--color-text-tertiary)', fontVariantNumeric: 'tabular-nums', whiteSpace: 'nowrap' }}>
                                      {shortDate(m._date.toISOString())}
                                    </span>
                                    <span style={{ flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                                      {m.description || '(no description)'}
                                    </span>
                                    {m._tagged && (
                                      <span title="Tagged by hand" className="material-symbols-outlined" style={{ fontSize: 13, color: '#7c3aed' }}>sell</span>
                                    )}
                                    <span style={{ fontVariantNumeric: 'tabular-nums', fontWeight: 600, whiteSpace: 'nowrap' }}>
                                      {fmtCents(Math.abs(Number(m.amount) || 0))}
                                    </span>
                                    {m._tagged && (
                                      <button
                                        type="button"
                                        onClick={() => setPromoTagForTransactions(m.transactionId, null)}
                                        title="Remove this tag"
                                        style={{ border: 'none', background: 'transparent', cursor: 'pointer', color: 'var(--color-text-tertiary)', lineHeight: 0, padding: 0 }}
                                      >
                                        <span className="material-symbols-outlined" style={{ fontSize: 14 }}>close</span>
                                      </button>
                                    )}
                                  </div>
                                );
                              })}
                              {matches.length > 40 && (
                                <div style={{ padding: '6px 8px', fontSize: 11, color: 'var(--color-text-tertiary)', borderTop: '1px solid var(--border-ghost)' }}>
                                  + {matches.length - 40} more
                                </div>
                              )}
                            </div>
                          )}
                        </>
                      )}
                      {matches.length === 0 && !isDone && !promoIsTracked(p, promoTags) && (
                        <div style={{ marginTop: 6, fontSize: 11, color: 'var(--color-text-tertiary)' }}>
                          Tracked by hand. Tag transactions to it from the Transactions page, or set a match rule in Edit.
                        </div>
                      )}
                    </div>
                    <div style={{ display: 'flex', flexDirection: 'column', gap: 4, flexShrink: 0 }}>
                      <button onClick={() => startEdit(p)} style={iconBtnStyle} title="Edit">
                        <span className="material-symbols-outlined" style={{ fontSize: 16 }}>edit</span>
                      </button>
                      <button onClick={() => deletePromo(p.id)} style={{ ...iconBtnStyle, color: '#ba1a1a' }} title="Delete">
                        <span className="material-symbols-outlined" style={{ fontSize: 16 }}>delete</span>
                      </button>
                    </div>
                  </div>
                );
              })}
            </div>
          </div>
        );
      })}
    </div>
  );
}

/* Last-30-days charges where another card in the wallet pays more. "Missed" is
   the spend times the rate gap, i.e. what swiping the better card would have
   added — not a loss on the rewards already earned. */
function SuboptimalCharges({ result, cardMap, setCardForAccount, displayName }) {
  const [showAll, setShowAll] = useState(false);
  const { flagged, totalMissed, totalCharges, evaluatedCount, unknownAccounts, start, end } = result;
  const cardStyle = { background: 'var(--color-surface)', border: 'var(--border-ghost)', borderRadius: 'var(--radius-xl)', padding: 20, boxShadow: 'var(--shadow-xs)' };
  const th = { padding: '8px 10px', textAlign: 'left', fontSize: 10.5, fontWeight: 700, letterSpacing: '0.06em', textTransform: 'uppercase', color: 'var(--color-text-tertiary)', borderBottom: '1px solid var(--border-ghost)', whiteSpace: 'nowrap' };
  const td = { padding: '9px 10px', fontSize: 12.5, borderBottom: '1px solid var(--border-ghost)', verticalAlign: 'middle' };
  const windowLabel = `${shortDate(start.toISOString())} – ${shortDate(end.toISOString())}`;
  const LIMIT = 25;
  const rows = showAll ? flagged : flagged.slice(0, LIMIT);
  const flaggedSpend = flagged.reduce((s, f) => s + f.spend, 0);

  const cardPill = key => (
    <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6, whiteSpace: 'nowrap' }}>
      <span style={{ width: 8, height: 8, borderRadius: 2, background: CARD_COLORS[key], flexShrink: 0 }} />
      {CARD_LABELS[key]}
    </span>
  );

  return (
    <div style={cardStyle}>
      <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: 16, flexWrap: 'wrap', marginBottom: 14 }}>
        <div>
          <div style={{ fontFamily: 'var(--font-headline)', fontSize: 16, fontWeight: 700, marginBottom: 2 }}>
            Suboptimal Card Usage
          </div>
          <div style={{ fontSize: 12, color: 'var(--color-text-tertiary)' }}>
            Charges from the last 30 days ({windowLabel}) where another card would have paid more.
          </div>
        </div>
        {evaluatedCount > 0 && (
          <div style={{ textAlign: 'right' }}>
            <div style={{ fontFamily: 'var(--font-headline)', fontSize: 22, fontWeight: 700, color: flagged.length ? '#ba1a1a' : '#16a34a' }}>
              {fmtCents(totalMissed)}
            </div>
            <div style={{ fontSize: 11, color: 'var(--color-text-tertiary)' }}>
              left on the table · {flagged.length} of {evaluatedCount} charges
            </div>
          </div>
        )}
      </div>

      {evaluatedCount === 0 ? (
        <div style={{ fontSize: 12.5, color: 'var(--color-text-tertiary)', fontStyle: 'italic' }}>
          {unknownAccounts.length
            ? 'No card accounts are mapped to a rate profile yet — set them below and this fills in.'
            : 'No card charges in the last 30 days to evaluate.'}
        </div>
      ) : flagged.length === 0 ? (
        <div style={{ fontSize: 12.5, color: '#16a34a', fontWeight: 600 }}>
          Every one of the {evaluatedCount} charges in this window was on the best-paying card. Nice.
        </div>
      ) : (
        <>
          <div style={{ fontSize: 11.5, color: 'var(--color-text-tertiary)', marginBottom: 10 }}>
            {fmt(flaggedSpend)} of {fmt(totalCharges)} in card spend went to a second-best card.
          </div>
          <div style={{ overflowX: 'auto' }}>
            <table style={{ width: '100%', borderCollapse: 'collapse', minWidth: 720 }}>
              <thead>
                <tr>
                  <th style={{ ...th, width: 74 }}>Date</th>
                  <th style={th}>Merchant</th>
                  <th style={th}>Earns as</th>
                  <th style={th}>Card used</th>
                  <th style={th}>Should have used</th>
                  <th style={{ ...th, textAlign: 'right' }}>Amount</th>
                  <th style={{ ...th, textAlign: 'right' }}>Missed</th>
                </tr>
              </thead>
              <tbody>
                {rows.map(f => (
                  <tr key={f.id}>
                    <td style={{ ...td, color: 'var(--color-text-tertiary)', fontVariantNumeric: 'tabular-nums' }}>{shortDate(f.date)}</td>
                    <td style={{ ...td, fontWeight: 600 }} title={displayName(f.account) || f.account}>{f.description}</td>
                    <td style={{ ...td, color: 'var(--color-text-tertiary)' }}>{f.categoryLabel}</td>
                    <td style={td}>
                      {cardPill(f.usedKey)}
                      <span style={{ color: 'var(--color-text-tertiary)', marginLeft: 6, fontVariantNumeric: 'tabular-nums' }}>{f.usedRate}%</span>
                    </td>
                    <td style={{ ...td, fontWeight: 600 }}>
                      {cardPill(f.bestKey)}
                      <span style={{ color: '#16a34a', marginLeft: 6, fontWeight: 700, fontVariantNumeric: 'tabular-nums' }}>{f.bestRate}%</span>
                    </td>
                    <td style={{ ...td, textAlign: 'right', fontVariantNumeric: 'tabular-nums' }}>{fmt(f.spend)}</td>
                    <td style={{ ...td, textAlign: 'right', fontWeight: 700, color: '#ba1a1a', fontVariantNumeric: 'tabular-nums' }}>{fmtCents(f.missed)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {flagged.length > LIMIT && (
            <button onClick={() => setShowAll(v => !v)} style={{ ...btnSecondaryStyle, marginTop: 10 }}>
              {showAll ? 'Show top 25' : `Show all ${flagged.length}`}
            </button>
          )}
        </>
      )}

      {unknownAccounts.length > 0 && (
        <div style={{ marginTop: 16, paddingTop: 14, borderTop: '1px solid var(--border-ghost)' }}>
          <div style={{ fontSize: 11, fontWeight: 700, letterSpacing: '0.06em', textTransform: 'uppercase', color: 'var(--color-text-tertiary)', marginBottom: 4 }}>
            Unmapped card accounts
          </div>
          <div style={{ fontSize: 12, color: 'var(--color-text-tertiary)', marginBottom: 10 }}>
            These accounts had charges in the window but their name doesn't say which card they are, so they were skipped. Pick a rate profile to include them.
          </div>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
            {unknownAccounts.map(a => (
              <div key={a.account} style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
                <div style={{ fontSize: 12.5, fontWeight: 600, minWidth: 200 }}>{displayName(a.account) || a.account}</div>
                <div style={{ fontSize: 11.5, color: 'var(--color-text-tertiary)', minWidth: 150 }}>
                  {a.count} {a.count === 1 ? 'charge' : 'charges'} · {fmt(a.total)}
                </div>
                <select
                  value={cardMap[a.account] || ''}
                  onChange={e => setCardForAccount(a.account, e.target.value)}
                  style={{ ...inputStyle, width: 'auto', minWidth: 200 }}
                >
                  <option value="">Not set — skipped</option>
                  {CARD_KEYS.map(k => <option key={k} value={k}>{CARD_LABELS[k]}</option>)}
                  <option value="ignore">Ignore this account</option>
                </select>
              </div>
            ))}
          </div>
        </div>
      )}

      <div style={{ fontSize: 11, color: 'var(--color-text-tertiary)', marginTop: 14, lineHeight: 1.5 }}>
        Rates come from the table below, valuing Chase points at {POINT_VALUE_CENTS}¢ and assuming BofA's 3% choice category is {BOFA_CHOICE}.
        Transfers, card payments, rent, investments, and fees are excluded, as are misses worth under 25¢.
      </div>
    </div>
  );
}

function CashBackSummary() {
  const cardStyle = { background: 'var(--color-surface)', border: 'var(--border-ghost)', borderRadius: 'var(--radius-xl)', padding: 20, boxShadow: 'var(--shadow-xs)' };
  const th = { padding: '8px 10px', textAlign: 'left', fontSize: 10.5, fontWeight: 700, letterSpacing: '0.06em', textTransform: 'uppercase', color: 'var(--color-text-tertiary)', borderBottom: '1px solid var(--border-ghost)', whiteSpace: 'nowrap' };
  const td = { padding: '9px 10px', fontSize: 12.5, borderBottom: '1px solid var(--border-ghost)', verticalAlign: 'middle' };
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
      {/* Best card per category */}
      <div style={cardStyle}>
        <div style={{ fontFamily: 'var(--font-headline)', fontSize: 16, fontWeight: 700, marginBottom: 2 }}>Cash Back by Category</div>
        <div style={{ fontSize: 12, color: 'var(--color-text-tertiary)', marginBottom: 14 }}>The best card to use for each spending category, with effective rate and runner-up.</div>
        <div style={{ overflowX: 'auto' }}>
          <table style={{ width: '100%', borderCollapse: 'collapse', minWidth: 520 }}>
            <thead>
              <tr>
                <th style={th}>Spending Category</th>
                <th style={th}>🏆 Best Card</th>
                <th style={{ ...th, textAlign: 'right' }}>Effective Rate</th>
                <th style={th}>Runner-up</th>
              </tr>
            </thead>
            <tbody>
              {REWARD_MATRIX.map((r, i) => (
                <tr key={i}>
                  <td style={{ ...td, fontWeight: 600, color: 'var(--color-text-primary)' }}>{r.cat}</td>
                  <td style={td}>
                    <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
                      <span style={{ width: 8, height: 8, borderRadius: 2, background: rewardCardColor(r.best), flexShrink: 0 }} />
                      <span style={{ fontWeight: 600 }}>{r.best}</span>
                    </span>
                  </td>
                  <td style={{ ...td, textAlign: 'right', fontWeight: 700, color: '#16a34a', fontVariantNumeric: 'tabular-nums', whiteSpace: 'nowrap' }}>{r.rate}</td>
                  <td style={{ ...td, color: 'var(--color-text-tertiary)' }}>{r.runner}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>

      {/* Per-card rate grid */}
      <div style={cardStyle}>
        <div style={{ fontFamily: 'var(--font-headline)', fontSize: 16, fontWeight: 700, marginBottom: 2 }}>Rate by Card</div>
        <div style={{ fontSize: 12, color: 'var(--color-text-tertiary)', marginBottom: 14 }}>Every card's rate per category — the best in each row is highlighted in green.</div>
        <div style={{ overflowX: 'auto' }}>
          <table style={{ width: '100%', borderCollapse: 'collapse', minWidth: 580 }}>
            <thead>
              <tr>
                <th style={th}>Spending Category</th>
                {CARD_RATE_COLUMNS.map((c, i) => (
                  <th key={i} style={{ ...th, textAlign: 'right' }}>
                    <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6, justifyContent: 'flex-end' }}>
                      <span style={{ width: 8, height: 8, borderRadius: 2, background: CARD_RATE_COLORS[i] }} />{c}
                    </span>
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {CARD_RATE_MATRIX.map((r, i) => (
                <tr key={i}>
                  <td style={{ ...td, fontWeight: 600, color: 'var(--color-text-primary)' }}>{r.cat}</td>
                  {r.rates.map((rate, j) => {
                    const win = j === r.best;
                    return (
                      <td key={j} style={{
                        ...td, textAlign: 'right', whiteSpace: 'nowrap', fontVariantNumeric: 'tabular-nums',
                        fontWeight: win ? 700 : 500,
                        color: win ? '#16a34a' : 'var(--color-text-secondary)',
                        background: win ? 'rgba(22,163,74,0.07)' : 'transparent',
                      }}>
                        {rate}
                      </td>
                    );
                  })}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}

function StatCard({ label, value, color, icon, sub }) {
  return (
    <div style={{ background: 'var(--color-surface)', border: 'var(--border-ghost)', borderRadius: 'var(--radius-xl)', padding: 20, boxShadow: 'var(--shadow-xs)' }}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 12 }}>
        <div style={{ fontSize: 11.5, fontWeight: 600, color: 'var(--color-text-tertiary)', textTransform: 'uppercase', letterSpacing: '0.05em' }}>{label}</div>
        <div style={{ width: 28, height: 28, borderRadius: 8, background: `${color}1a`, display: 'flex', alignItems: 'center', justifyContent: 'center', color }}>
          <span className="material-symbols-outlined" style={{ fontSize: 16 }}>{icon}</span>
        </div>
      </div>
      <div style={{ fontFamily: 'var(--font-headline)', fontSize: 24, fontWeight: 700, color }}>{value}</div>
      {sub && <div style={{ fontSize: 11.5, color: 'var(--color-text-tertiary)', marginTop: 4 }}>{sub}</div>}
    </div>
  );
}

function LabeledInput({ label, value, onChange, type = 'text' }) {
  return (
    <div>
      <div style={labelStyle}>{label}</div>
      <input type={type} value={value ?? ''} onChange={e => onChange(e.target.value)} style={inputStyle} />
    </div>
  );
}

const labelStyle = { fontSize: 10, fontWeight: 700, letterSpacing: '0.05em', textTransform: 'uppercase', color: 'var(--color-text-tertiary)', marginBottom: 4 };
const inputStyle = { width: '100%', padding: '8px 10px', border: '1px solid var(--border-ghost)', borderRadius: 6, fontSize: 13, background: 'var(--color-surface)', color: 'var(--color-text-primary)' };
const btnPrimaryStyle = { display: 'flex', alignItems: 'center', gap: 6, padding: '8px 14px', background: 'var(--color-secondary)', color: '#fff', border: 'none', borderRadius: 8, fontSize: 13, fontWeight: 600, cursor: 'pointer' };
const btnSecondaryStyle = { display: 'flex', alignItems: 'center', gap: 6, padding: '8px 14px', background: 'var(--color-surface)', color: 'var(--color-text-primary)', border: 'var(--border-ghost)', borderRadius: 8, fontSize: 13, fontWeight: 600, cursor: 'pointer' };
const btnMenuStyle = { display: 'block', width: '100%', padding: '10px 14px', textAlign: 'left', background: 'transparent', border: 'none', fontSize: 13, cursor: 'pointer' };
const iconBtnStyle = { width: 28, height: 28, border: 'none', background: 'var(--color-surface-alt)', borderRadius: 6, cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center', color: 'var(--color-text-secondary)' };
