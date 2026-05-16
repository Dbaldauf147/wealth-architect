import { Fragment, useMemo, useState } from 'react';
import { useData } from '../contexts/DataContext';
import { buildCardSchedule } from '../lib/cardSchedule';
import styles from './CardsPage.module.css';

function fmt(n) {
  if (n == null) return '—';
  return new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', minimumFractionDigits: 0, maximumFractionDigits: 0 }).format(n);
}

function fmtDate(d) {
  if (!d) return '—';
  return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
}

const CARD_COLORS = [
  '#0058be', '#e8a317', '#009668', '#ba1a1a', '#7c3aed',
  '#475569', '#0891b2', '#c026d3', '#ea580c', '#059669',
];

export function CardsPage() {
  const { transactions, balances, loading } = useData();
  const [view, setView] = useState('optimizer');
  const [expanded, setExpanded] = useState(() => new Set());

  // Derive credit card accounts from liabilities
  const creditCards = useMemo(() => {
    if (!balances?.liabilities) return [];
    return balances.liabilities.map((l, i) => ({
      name: l.name,
      balance: l.balance,
      updated: l.updated,
      color: CARD_COLORS[i % CARD_COLORS.length],
    }));
  }, [balances]);

  // Build a set of credit card account names for filtering transactions
  const cardNames = useMemo(() => new Set(creditCards.map(c => c.name)), [creditCards]);

  // Transactions that belong to credit card accounts
  const cardTransactions = useMemo(() => {
    if (!transactions?.length || !cardNames.size) return [];
    return transactions.filter(t => cardNames.has(t.account));
  }, [transactions, cardNames]);

  // Spending by card account (only expenses, i.e. negative amounts)
  const spendByCard = useMemo(() => {
    const map = {};
    for (const t of cardTransactions) {
      if (t.amount >= 0) continue; // skip income/credits
      const acct = t.account;
      if (!map[acct]) map[acct] = 0;
      map[acct] += Math.abs(t.amount);
    }
    return Object.entries(map)
      .map(([name, total]) => ({ name, total }))
      .sort((a, b) => b.total - a.total);
  }, [cardTransactions]);

  // Spending by category across all credit cards
  const spendByCategory = useMemo(() => {
    const map = {};
    for (const t of cardTransactions) {
      if (t.amount >= 0) continue;
      const cat = t.category || 'Uncategorized';
      if (!map[cat]) map[cat] = 0;
      map[cat] += Math.abs(t.amount);
    }
    return Object.entries(map)
      .map(([name, total]) => ({ name, total }))
      .sort((a, b) => b.total - a.total);
  }, [cardTransactions]);

  // Category spending per card
  const categoryPerCard = useMemo(() => {
    const map = {}; // { cardName: { category: amount } }
    for (const t of cardTransactions) {
      if (t.amount >= 0) continue;
      const acct = t.account;
      const cat = t.category || 'Uncategorized';
      if (!map[acct]) map[acct] = {};
      if (!map[acct][cat]) map[acct][cat] = 0;
      map[acct][cat] += Math.abs(t.amount);
    }
    return map;
  }, [cardTransactions]);

  // Optimization alert: find top spending category and suggest the best card
  const optimization = useMemo(() => {
    if (!spendByCategory.length || !creditCards.length) return null;
    const topCat = spendByCategory[0];
    let bestCard = null;
    let bestAmount = 0;
    for (const card of creditCards) {
      const cardCats = categoryPerCard[card.name];
      const amt = cardCats?.[topCat.name] || 0;
      if (amt > bestAmount) {
        bestAmount = amt;
        bestCard = card.name;
      }
    }
    let worstCard = null;
    let worstAmount = Infinity;
    for (const card of creditCards) {
      const cardCats = categoryPerCard[card.name];
      const amt = cardCats?.[topCat.name] || 0;
      if (amt > 0 && amt < worstAmount) {
        worstAmount = amt;
        worstCard = card.name;
      }
    }
    return {
      category: topCat.name,
      monthlySpend: topCat.total,
      bestCard,
      worstCard,
    };
  }, [spendByCategory, creditCards, categoryPerCard]);

  // ── Schedule view data ────────────────────────────────────────────────────
  const schedule = useMemo(
    () => buildCardSchedule({ cards: creditCards, transactions: transactions || [] }),
    [creditCards, transactions],
  );

  // Sort schedule rows by next-payment-date asc (no-payment-history rows last).
  const sortedSchedule = useMemo(() => {
    return [...schedule].sort((a, b) => {
      if (!a.nextPaymentDate && !b.nextPaymentDate) return 0;
      if (!a.nextPaymentDate) return 1;
      if (!b.nextPaymentDate) return -1;
      return a.nextPaymentDate - b.nextPaymentDate;
    });
  }, [schedule]);

  // 60-day timeline: payment dots + week markers
  const timeline = useMemo(() => {
    const days = 60;
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    const endMs = today.getTime() + days * 86400000;
    const dots = [];
    for (const s of schedule) {
      if (!s.nextPaymentDate) continue;
      const ms = s.nextPaymentDate.getTime();
      if (ms < today.getTime() || ms > endMs) continue;
      const pct = ((ms - today.getTime()) / (days * 86400000)) * 100;
      dots.push({
        card: s.card,
        color: s.color,
        date: s.nextPaymentDate,
        amount: s.estimatedNextAmount,
        pct,
      });
    }
    // Stagger dots vertically when two are within ~5% of each other.
    dots.sort((a, b) => a.pct - b.pct);
    let lastPct = -100;
    let row = 0;
    for (const d of dots) {
      if (d.pct - lastPct < 5) row = (row + 1) % 3;
      else row = 0;
      d.row = row;
      lastPct = d.pct;
    }
    const weekMarks = [];
    for (let d = 0; d <= days; d += 7) {
      const t = new Date(today.getTime() + d * 86400000);
      weekMarks.push({
        label: t.toLocaleDateString('en-US', { month: 'short', day: 'numeric' }),
        pct: (d / days) * 100,
      });
    }
    return { dots, weekMarks };
  }, [schedule]);

  function toggleExpand(cardName) {
    setExpanded(prev => {
      const next = new Set(prev);
      if (next.has(cardName)) next.delete(cardName);
      else next.add(cardName);
      return next;
    });
  }

  // Total spend across all cards
  const totalCardSpend = useMemo(() => {
    return spendByCard.reduce((sum, c) => sum + c.total, 0);
  }, [spendByCard]);

  // Loading state
  if (loading) {
    return (
      <div className={styles.page} style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', minHeight: '60vh' }}>
        <div style={{ textAlign: 'center' }}>
          <span className="material-symbols-outlined" style={{ fontSize: 48, animation: 'spin 1s linear infinite', display: 'block', marginBottom: 16, color: 'var(--color-text-tertiary)' }}>progress_activity</span>
          <div style={{ color: 'var(--color-text-secondary)', fontFamily: 'var(--font-body)', fontSize: 14 }}>Loading your card data...</div>
        </div>
      </div>
    );
  }

  // Chart data: spending by card
  const yieldData = spendByCard.map((d, i) => {
    const card = creditCards.find(c => c.name === d.name);
    return {
      card: d.name.length > 18 ? d.name.slice(0, 16) + '...' : d.name,
      amount: d.total,
      color: card?.color || CARD_COLORS[i % CARD_COLORS.length],
    };
  });
  const maxSpend = Math.max(...yieldData.map(d => d.amount), 1);

  return (
    <div className={styles.page}>
      {/* Header + sub-tabs */}
      <div>
        <div style={{ display: 'flex', alignItems: 'flex-end', justifyContent: 'space-between', gap: 12, flexWrap: 'wrap' }}>
          <div>
            <div style={{ fontFamily: 'var(--font-headline)', fontSize: 24, fontWeight: 700, marginBottom: 4 }}>Cards</div>
            <div style={{ fontSize: 13, color: 'var(--color-text-tertiary)' }}>
              {view === 'optimizer'
                ? 'Spending breakdown, portfolio matrix, and reward optimization'
                : 'Projected payment dates and the charges feeding each one'}
            </div>
          </div>
          <div style={{ display: 'inline-flex', gap: 2, background: 'var(--color-surface-alt)', padding: 2, borderRadius: 10 }}>
            {[{ key: 'optimizer', label: 'Optimizer' }, { key: 'schedule', label: 'Schedule' }].map(t => (
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

      {view === 'optimizer' && (<>
      {/* Optimization Alert Hero */}
      <div className={styles.hero}>
        <div className={styles.heroIcon}>
          <span className="material-symbols-outlined">auto_awesome</span>
        </div>
        <div className={styles.heroContent}>
          <div className={styles.heroLabel}>Optimization Alert</div>
          <div className={styles.heroTitle}>
            {optimization
              ? `Consolidate "${optimization.category}" spending to ${optimization.bestCard} for maximum rewards`
              : 'Connect credit card accounts to see optimization tips'}
          </div>
          <div className={styles.heroSubtitle}>
            {optimization
              ? `Your top category is ${optimization.category} with ${fmt(optimization.monthlySpend)} in total card spend`
              : 'No credit card transaction data available yet'}
          </div>
        </div>
        <button className={styles.heroAction}>View Analysis</button>
      </div>

      {/* Reward Yield Chart — Spending by Card */}
      <div className={styles.chartCard}>
        <div className={styles.chartHeader}>
          <div>
            <div className={styles.chartTitle}>Spending by Card</div>
            <div className={styles.chartSubtitle}>Total spend across all credit card accounts</div>
          </div>
        </div>
        <div className={styles.barChart}>
          {yieldData.length > 0 ? yieldData.map((d) => (
            <div key={d.card} className={styles.barGroup}>
              <div className={styles.barValue}>{fmt(d.amount)}</div>
              <div
                className={styles.bar}
                style={{
                  height: `${(d.amount / maxSpend) * 100}%`,
                  background: d.color,
                }}
              />
              <div className={styles.barLabel}>{d.card}</div>
            </div>
          )) : (
            <div style={{ width: '100%', textAlign: 'center', color: 'var(--color-text-tertiary)', fontSize: 13, paddingBottom: 16 }}>
              No credit card transactions found
            </div>
          )}
        </div>
      </div>

      {/* Active Portfolio Matrix — from liabilities */}
      <div className={styles.matrixCard}>
        <div className={styles.matrixTitle}>Card Portfolio</div>
        <table className={styles.matrixTable}>
          <thead>
            <tr>
              <th>Card</th>
              <th>Balance</th>
              <th>Top Categories</th>
              <th>Last Updated</th>
            </tr>
          </thead>
          <tbody>
            {creditCards.length > 0 ? creditCards.map((c, i) => {
              const cats = categoryPerCard[c.name] || {};
              const topCats = Object.entries(cats)
                .sort((a, b) => b[1] - a[1])
                .slice(0, 3);
              return (
                <tr key={i}>
                  <td>
                    <div className={styles.cardIdent}>
                      <div className={styles.cardStripe} style={{ background: c.color }} />
                      <div>
                        <div className={styles.cardName}>{c.name}</div>
                      </div>
                    </div>
                  </td>
                  <td className={styles.cardFee}>{fmt(c.balance)}</td>
                  <td>
                    <div className={styles.accelerators}>
                      {topCats.length > 0 ? topCats.map(([cat, amt], j) => (
                        <span key={j} className={styles.accelBadge}>{cat} {fmt(amt)}</span>
                      )) : (
                        <span className={styles.accelBadge}>No spend</span>
                      )}
                    </div>
                  </td>
                  <td>
                    <span className={styles.statusBadge + ' ' + styles.statusActive}>
                      {c.updated || 'N/A'}
                    </span>
                  </td>
                </tr>
              );
            }) : (
              <tr>
                <td colSpan={4} style={{ textAlign: 'center', color: 'var(--color-text-tertiary)' }}>
                  No credit card accounts found in liabilities
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>

      {/* Card Utilization + Category Breakdown */}
      <div className={styles.perfGrid}>
        <div className={styles.perfCard}>
          <div className={styles.perfTitle}>Card Utilization</div>
          {creditCards.length > 0 ? creditCards.map((c, i) => {
            const spend = spendByCard.find(s => s.name === c.name)?.total || 0;
            const maxBal = Math.max(...creditCards.map(cc => Math.abs(cc.balance)), 1);
            const pct = Math.min(100, (Math.abs(c.balance) / maxBal) * 100);
            return (
              <div key={i} className={styles.perfItem}>
                <div className={styles.perfHeader}>
                  <span className={styles.perfLabel}>{c.name}</span>
                  <span className={styles.perfValue}>{fmt(c.balance)}</span>
                </div>
                <div className={styles.perfBar}>
                  <div
                    className={styles.perfFill}
                    style={{ width: `${pct}%`, background: c.color }}
                  />
                </div>
              </div>
            );
          }) : (
            <div style={{ color: 'var(--color-text-tertiary)', fontSize: 13 }}>No card data available</div>
          )}
        </div>

        <div className={styles.perfCard}>
          <div className={styles.perfTitle}>Top Spending Categories</div>
          {spendByCategory.length > 0 ? spendByCategory.slice(0, 6).map((cat, i) => {
            const maxCat = spendByCategory[0].total || 1;
            const pct = (cat.total / maxCat) * 100;
            return (
              <div key={i} className={styles.perfItem}>
                <div className={styles.perfHeader}>
                  <span className={styles.perfLabel}>{cat.name}</span>
                  <span className={styles.perfValue}>{fmt(cat.total)}</span>
                </div>
                <div className={styles.perfBar}>
                  <div
                    className={styles.perfFill}
                    style={{ width: `${pct}%`, background: CARD_COLORS[i % CARD_COLORS.length] }}
                  />
                </div>
              </div>
            );
          }) : (
            <div style={{ color: 'var(--color-text-tertiary)', fontSize: 13 }}>No category data available</div>
          )}
        </div>
      </div>

      {/* Category Spending per Card */}
      <div className={styles.bottomRow}>
        {creditCards.slice(0, 2).map((card, idx) => {
          const cats = categoryPerCard[card.name] || {};
          const sorted = Object.entries(cats)
            .sort((a, b) => b[1] - a[1])
            .slice(0, 5);
          const maxAmt = sorted.length > 0 ? sorted[0][1] : 1;
          return (
            <div key={idx} className={styles.infoCard}>
              <div className={styles.infoHeader}>
                <div className={styles.infoIcon} style={{ background: `${card.color}14`, color: card.color }}>
                  <span className="material-symbols-outlined">credit_card</span>
                </div>
                <div className={styles.infoTitle}>{card.name}</div>
              </div>
              {sorted.length > 0 ? sorted.map(([cat, amt], j) => (
                <div key={j} className={styles.perfItem}>
                  <div className={styles.perfHeader}>
                    <span className={styles.perfLabel}>{cat}</span>
                    <span className={styles.perfValue}>{fmt(amt)}</span>
                  </div>
                  <div className={styles.perfBar}>
                    <div
                      className={styles.perfFill}
                      style={{ width: `${(amt / maxAmt) * 100}%`, background: card.color }}
                    />
                  </div>
                </div>
              )) : (
                <div className={styles.infoRow}>
                  <span className={styles.infoLabel}>No transactions found</span>
                </div>
              )}
            </div>
          );
        })}
        {creditCards.length > 2 && creditCards.slice(2).map((card, idx) => {
          const cats = categoryPerCard[card.name] || {};
          const sorted = Object.entries(cats)
            .sort((a, b) => b[1] - a[1])
            .slice(0, 5);
          const maxAmt = sorted.length > 0 ? sorted[0][1] : 1;
          return (
            <div key={idx + 2} className={styles.infoCard}>
              <div className={styles.infoHeader}>
                <div className={styles.infoIcon} style={{ background: `${card.color}14`, color: card.color }}>
                  <span className="material-symbols-outlined">credit_card</span>
                </div>
                <div className={styles.infoTitle}>{card.name}</div>
              </div>
              {sorted.length > 0 ? sorted.map(([cat, amt], j) => (
                <div key={j} className={styles.perfItem}>
                  <div className={styles.perfHeader}>
                    <span className={styles.perfLabel}>{cat}</span>
                    <span className={styles.perfValue}>{fmt(amt)}</span>
                  </div>
                  <div className={styles.perfBar}>
                    <div
                      className={styles.perfFill}
                      style={{ width: `${(amt / maxAmt) * 100}%`, background: card.color }}
                    />
                  </div>
                </div>
              )) : (
                <div className={styles.infoRow}>
                  <span className={styles.infoLabel}>No transactions found</span>
                </div>
              )}
            </div>
          );
        })}
      </div>
      </>)}

      {view === 'schedule' && (<>
      {/* Timeline strip — next 60 days */}
      <div className={styles.chartCard}>
        <div className={styles.chartHeader}>
          <div>
            <div className={styles.chartTitle}>Upcoming Payments — Next 60 Days</div>
            <div className={styles.chartSubtitle}>Projected from each card's historical payment cadence</div>
          </div>
        </div>
        <div className={styles.timeline}>
          {timeline.weekMarks.map((w, i) => (
            <div key={i} className={styles.weekMark} style={{ left: `${w.pct}%` }}>
              <div className={styles.weekTick} />
              <div className={styles.weekLabel}>{w.label}</div>
            </div>
          ))}
          {timeline.dots.length === 0 ? (
            <div className={styles.timelineEmpty}>
              No projected payments fall within the next 60 days.
            </div>
          ) : timeline.dots.map((d, i) => (
            <div
              key={i}
              className={styles.paymentDot}
              style={{ left: `${d.pct}%`, top: `${20 + (d.row || 0) * 28}px`, background: d.color }}
              title={`${d.card} — ${fmt(d.amount)} on ${fmtDate(d.date)}`}
            >
              <div className={styles.paymentDotInfo}>
                <div className={styles.paymentDotAmount}>{fmt(d.amount)}</div>
                <div className={styles.paymentDotCard}>{d.card}</div>
              </div>
            </div>
          ))}
        </div>
      </div>

      {/* Per-card schedule table */}
      <div className={styles.matrixCard}>
        <div className={styles.matrixTitle}>Card Payment Schedule</div>
        <table className={styles.matrixTable}>
          <thead>
            <tr>
              <th>Card</th>
              <th>Last Payment</th>
              <th>Next (est.)</th>
              <th>In</th>
              <th>Charges</th>
              <th>Est. Next Payment</th>
              <th style={{ width: 32 }}></th>
            </tr>
          </thead>
          <tbody>
            {sortedSchedule.length === 0 ? (
              <tr>
                <td colSpan={7} style={{ textAlign: 'center', color: 'var(--color-text-tertiary)' }}>
                  No credit card accounts found in liabilities
                </td>
              </tr>
            ) : sortedSchedule.map((s) => {
              const isOpen = expanded.has(s.card);
              return (
                <Fragment key={s.card}>
                  <tr className={styles.scheduleRow} onClick={() => toggleExpand(s.card)}>
                    <td>
                      <div className={styles.cardIdent}>
                        <div className={styles.cardStripe} style={{ background: s.color }} />
                        <div className={styles.cardName}>{s.card}</div>
                      </div>
                    </td>
                    <td>
                      {s.lastPayment ? (
                        <span>
                          <span style={{ color: 'var(--color-text-secondary)' }}>{fmtDate(s.lastPayment.date)}</span>
                          <span style={{ marginLeft: 8, fontWeight: 600 }}>{fmt(s.lastPayment.amount)}</span>
                        </span>
                      ) : '—'}
                    </td>
                    <td>{s.nextPaymentDate ? fmtDate(s.nextPaymentDate) : '—'}</td>
                    <td style={{ color: 'var(--color-text-secondary)' }}>
                      {s.daysUntilNext != null ? `${s.daysUntilNext}d` : '—'}
                    </td>
                    <td style={{ color: 'var(--color-text-secondary)' }}>
                      {s.chargesSinceLast.length}
                    </td>
                    <td className={styles.cardFee}>{fmt(s.estimatedNextAmount)}</td>
                    <td style={{ textAlign: 'right' }}>
                      <span className="material-symbols-outlined" style={{ fontSize: 18, color: 'var(--color-text-tertiary)' }}>
                        {isOpen ? 'expand_less' : 'expand_more'}
                      </span>
                    </td>
                  </tr>
                  {isOpen && (
                    <tr>
                      <td colSpan={7} className={styles.expandedCell}>
                        {s.chargesSinceLast.length === 0 ? (
                          <div className={styles.emptyDrill}>
                            {s.lastPayment
                              ? `No charges since ${fmtDate(s.lastPayment.date)}.`
                              : 'No payment history on this card yet — record a payment to start projecting.'}
                          </div>
                        ) : (
                          (() => {
                            // Compute running total in chronological order, render newest first.
                            const oldestFirst = [...s.chargesSinceLast].reverse();
                            let total = 0;
                            const withRunning = oldestFirst.map(t => {
                              total += -t.amount;
                              return { ...t, runningTotal: total };
                            }).reverse();
                            return (
                              <table className={styles.drillTable}>
                                <thead>
                                  <tr>
                                    <th>Date</th>
                                    <th>Description</th>
                                    <th>Category</th>
                                    <th style={{ textAlign: 'right' }}>Amount</th>
                                    <th style={{ textAlign: 'right' }}>Running Total</th>
                                  </tr>
                                </thead>
                                <tbody>
                                  {withRunning.map((t, j) => (
                                    <tr key={j}>
                                      <td>{fmtDate(t._date)}</td>
                                      <td>{t.description}</td>
                                      <td style={{ color: 'var(--color-text-secondary)' }}>{t.category || '—'}</td>
                                      <td style={{ textAlign: 'right', color: t.amount < 0 ? 'var(--color-text-primary)' : 'var(--color-success)' }}>
                                        {fmt(t.amount)}
                                      </td>
                                      <td style={{ textAlign: 'right', fontWeight: 600 }}>{fmt(t.runningTotal)}</td>
                                    </tr>
                                  ))}
                                </tbody>
                              </table>
                            );
                          })()
                        )}
                      </td>
                    </tr>
                  )}
                </Fragment>
              );
            })}
          </tbody>
        </table>
      </div>
      </>)}
    </div>
  );
}
