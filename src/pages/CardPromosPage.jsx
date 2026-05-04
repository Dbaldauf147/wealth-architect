import { useMemo, useState, useEffect } from 'react';
import { useData } from '../contexts/DataContext';

function fmt(n) {
  if (n == null || n === '') return '—';
  return new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', minimumFractionDigits: 0, maximumFractionDigits: 0 }).format(n);
}

function periodWindowStart(period) {
  // Returns the inclusive start date of the current cycle for the given period.
  const now = new Date();
  if (period === 'monthly') return new Date(now.getFullYear(), now.getMonth(), 1);
  if (period === 'quarterly') {
    const q = Math.floor(now.getMonth() / 3);
    return new Date(now.getFullYear(), q * 3, 1);
  }
  if (period === 'annual') return new Date(now.getFullYear(), 0, 1);
  return null; // one-time → no window
}

function normalizeDesc(s) {
  return (s || '').toLowerCase().trim().replace(/[\s\-–—]+/g, ' ');
}

function promoHasAutoMatch(p) {
  return !!((p.matchSubcategory || '').trim() || (p.matchCategory || '').trim() || (p.matchDescription || '').trim());
}

// OR semantics across the three match fields: a transaction qualifies if it matches
// ANY of the populated criteria. Description match uses the same bidirectional contains
// check used by the auto-categorization rules on the Transactions page.
function transactionMatchesPromo(t, promo) {
  const wantSub = (promo.matchSubcategory || '').trim().toLowerCase();
  const wantCat = (promo.matchCategory || '').trim().toLowerCase();
  const wantDesc = normalizeDesc(promo.matchDescription);
  if (!wantSub && !wantCat && !wantDesc) return false;
  if (wantSub && (t.subcategory || '').toLowerCase() === wantSub) return true;
  if (wantCat && (t.category || '').toLowerCase() === wantCat) return true;
  if (wantDesc) {
    const txnDesc = normalizeDesc(t.description);
    const txnFull = normalizeDesc(t.fullDescription);
    if (txnDesc && (txnDesc.includes(wantDesc) || wantDesc.includes(txnDesc))) return true;
    if (txnFull && txnFull.includes(wantDesc)) return true;
  }
  return false;
}

function autoUsedForPromo(promo, transactions) {
  if (!promoHasAutoMatch(promo)) return null;
  if (!transactions || transactions.length === 0) return 0;
  const start = periodWindowStart(promo.period);
  let sum = 0;
  for (const t of transactions) {
    const amt = Number(t.amount) || 0;
    if (amt === 0) continue;
    if (start) {
      const d = new Date(t.date);
      if (isNaN(d) || d < start) continue;
    }
    if (!transactionMatchesPromo(t, promo)) continue;
    // Sum absolute value so the rule works for either direction:
    // - tag the original travel CHARGE (negative) → tracks redeemable spend
    // - tag the statement CREDIT (positive)       → tracks actual redemption
    sum += Math.abs(amt);
  }
  return sum;
}

/* ── Seed data: Chase Sapphire Reserve benefits ── */
const SEED_PROMOS = [
  {
    id: 'seed-csr-travel',
    card: 'Chase Sapphire Reserve',
    name: '$300 Annual Travel Credit',
    value: 300,
    used: 0,
    period: 'annual',
    matchSubcategory: 'Travel Credit',
    notes: 'Auto-applied to anything Chase codes as travel — NYC MTA, Citi Bike, rideshare, tolls, parking, hotels, airlines.',
    color: '#0058be',
  },
  {
    id: 'seed-csr-lyft',
    card: 'Chase Sapphire Reserve',
    name: '$10 Monthly Lyft Credit',
    value: 10,
    used: 0,
    period: 'monthly',
    notes: 'Through March 2027. Activated in Lyft app with Chase card set as default.',
    color: '#0058be',
  },
  {
    id: 'seed-csr-doordash',
    card: 'Chase Sapphire Reserve',
    name: 'DoorDash DashPass',
    value: 120,
    used: 0,
    period: 'annual',
    notes: 'Free DashPass membership through 2027, plus monthly dining/grocery credits.',
    color: '#0058be',
  },
  {
    id: 'seed-csr-global-entry',
    card: 'Chase Sapphire Reserve',
    name: 'Global Entry / TSA PreCheck',
    value: 120,
    used: 0,
    period: 'annual',
    notes: 'Up to $120 statement credit every 4 years for application fee.',
    color: '#0058be',
  },
  {
    id: 'seed-csr-pp',
    card: 'Chase Sapphire Reserve',
    name: 'Priority Pass Select',
    value: 469,
    used: 0,
    period: 'annual',
    notes: 'Complimentary Priority Pass lounge access (1,300+ airport lounges worldwide).',
    color: '#0058be',
  },
];

const STORAGE_KEY = 'cardPromos';

function loadPromos() {
  try {
    const saved = localStorage.getItem(STORAGE_KEY);
    if (saved) return JSON.parse(saved);
  } catch {}
  return SEED_PROMOS;
}

function savePromos(promos) {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(promos));
}

export function CardPromosPage() {
  const { transactions } = useData();
  const [promos, setPromos] = useState(loadPromos);
  const [editingId, setEditingId] = useState(null);
  const [editDraft, setEditDraft] = useState({});
  const [showSeedBtn, setShowSeedBtn] = useState(false);

  useEffect(() => savePromos(promos), [promos]);

  // Resolve "effective used" per promo: auto-tracked from transactions if a match
  // field is set, otherwise the manual "used" value the user typed.
  const effectiveUsed = useMemo(() => {
    const map = new Map();
    for (const p of promos) {
      const auto = autoUsedForPromo(p, transactions);
      map.set(p.id, auto != null ? auto : (Number(p.used) || 0));
    }
    return map;
  }, [promos, transactions]);

  const byCard = useMemo(() => {
    const groups = {};
    for (const p of promos) {
      if (!groups[p.card]) groups[p.card] = [];
      groups[p.card].push(p);
    }
    return Object.entries(groups).sort((a, b) => a[0].localeCompare(b[0]));
  }, [promos]);

  const totals = useMemo(() => {
    let totalValue = 0;
    let totalUsed = 0;
    for (const p of promos) {
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
    };
  }, [promos, effectiveUsed]);

  function addPromo() {
    const newPromo = {
      id: `promo-${Date.now()}`,
      card: '',
      name: 'New Benefit',
      value: 0,
      used: 0,
      period: 'annual',
      notes: '',
      color: '#475569',
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
  }

  function resetAllUsage() {
    if (!confirm('Reset "used" amounts to $0 on all promos? (Useful at start of a new cycle.)')) return;
    setPromos(prev => prev.map(p => ({ ...p, used: 0 })));
  }

  function restoreSeed() {
    if (!confirm('Replace your list with the default seed list? Your custom changes will be lost.')) return;
    setPromos(SEED_PROMOS);
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 24 }}>
      {/* Header */}
      <div style={{ display: 'flex', alignItems: 'flex-end', justifyContent: 'space-between', gap: 16, flexWrap: 'wrap' }}>
        <div>
          <div style={{ fontFamily: 'var(--font-headline)', fontSize: 24, fontWeight: 700, marginBottom: 4 }}>Card Promotions</div>
          <div style={{ fontSize: 13, color: 'var(--color-text-tertiary)' }}>
            Track statement credits and benefits across your credit cards
          </div>
        </div>
        <div style={{ display: 'flex', gap: 8 }}>
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
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: 16 }}>
        <StatCard label="Total Value" value={fmt(totals.totalValue)} color="#0058be" icon="redeem" />
        <StatCard label="Used" value={fmt(totals.totalUsed)} color="#16a34a" icon="check_circle" sub={`${Math.round(totals.pct * 100)}% of total`} />
        <StatCard label="Remaining" value={fmt(totals.remaining)} color="#e8a317" icon="schedule" sub="Still available this cycle" />
      </div>

      {/* Grouped by card */}
      {byCard.length === 0 && (
        <div style={{ background: 'var(--color-surface)', border: 'var(--border-ghost)', borderRadius: 'var(--radius-xl)', padding: 40, textAlign: 'center', color: 'var(--color-text-tertiary)' }}>
          No promos yet. Click "Add Promo" to get started.
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
                <div style={{ fontFamily: 'var(--font-headline)', fontSize: 16, fontWeight: 700 }}>{cardName || '(Unnamed card)'}</div>
                <div style={{ fontSize: 12, color: 'var(--color-text-tertiary)' }}>
                  {fmt(cardUsed)} used of {fmt(cardValue)} ({cardValue > 0 ? Math.round((cardUsed / cardValue) * 100) : 0}%)
                </div>
              </div>
            </div>

            <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
              {cardPromos.map(p => {
                const isEditing = editingId === p.id;
                const usedNow = effectiveUsed.get(p.id) || 0;
                const isAuto = promoHasAutoMatch(p);
                const pct = p.value > 0 ? Math.min(1, usedNow / Number(p.value)) : 0;
                const remaining = Math.max(0, (Number(p.value) || 0) - usedNow);

                if (isEditing) {
                  return (
                    <div key={p.id} style={{ border: `2px solid ${cardColor}`, borderRadius: 8, padding: 12, background: 'var(--color-surface-alt)' }}>
                      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8, marginBottom: 8 }}>
                        <LabeledInput label="Card" value={editDraft.card} onChange={v => setEditDraft({ ...editDraft, card: v })} />
                        <LabeledInput label="Name" value={editDraft.name} onChange={v => setEditDraft({ ...editDraft, name: v })} />
                      </div>
                      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr 1fr 1fr', gap: 8, marginBottom: 8 }}>
                        <LabeledInput label="Total $" type="number" value={editDraft.value} onChange={v => setEditDraft({ ...editDraft, value: v })} />
                        <LabeledInput label="Used $ (manual)" type="number" value={editDraft.used} onChange={v => setEditDraft({ ...editDraft, used: v })} />
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
                        If any match field is set, "used" auto-sums the absolute value of matching transactions in the current cycle (manual "Used $" is ignored). Sign doesn't matter — tag the original travel charge (negative) to track redeemable spend, or tag the statement credit (positive) to track actual redemption. Multiple match fields are OR'd. "Merchant contains" matches anywhere in the transaction's merchant text.
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
                  <div key={p.id} style={{ border: '1px solid var(--border-ghost)', borderRadius: 8, padding: 14, display: 'flex', gap: 16, alignItems: 'flex-start' }}>
                    <div style={{ flex: 1, minWidth: 0 }}>
                      <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 4, flexWrap: 'wrap' }}>
                        <div style={{ fontFamily: 'var(--font-headline)', fontSize: 14, fontWeight: 700 }}>{p.name}</div>
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
                      </div>
                      {p.notes && <div style={{ fontSize: 12, color: 'var(--color-text-tertiary)', marginBottom: 8, lineHeight: 1.4 }}>{p.notes}</div>}
                      <div style={{ height: 6, background: 'var(--color-surface-alt)', borderRadius: 3, overflow: 'hidden', marginBottom: 4 }}>
                        <div style={{ height: '100%', width: `${pct * 100}%`, background: pct >= 1 ? '#16a34a' : cardColor, transition: 'width 0.2s' }} />
                      </div>
                      <div style={{ fontSize: 11.5, color: 'var(--color-text-secondary)', fontVariantNumeric: 'tabular-nums' }}>
                        {fmt(usedNow)} used · <strong style={{ color: remaining > 0 ? '#16a34a' : 'var(--color-text-tertiary)' }}>{fmt(remaining)} remaining</strong> of {fmt(p.value)}
                      </div>
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
