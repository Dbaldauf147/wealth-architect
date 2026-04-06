import { useState } from 'react';
import styles from './TransactionsPage.module.css';

const ACCOUNTS = ['All Accounts', 'Amex Gold', 'Chase Checking', 'Wealthfront'];

const TRANSACTIONS = [
  {
    merchant: 'Whole Foods Market',
    sub: 'Grocery — Organic',
    icon: 'shopping_cart',
    iconBg: 'rgba(0,150,104,0.08)',
    iconColor: '#009668',
    category: 'Groceries',
    catBg: 'rgba(0,150,104,0.08)',
    catColor: '#009668',
    amount: -187.42,
    date: 'Apr 4, 2026',
    account: 'Amex Gold',
    accountColor: '#e8a317',
  },
  {
    merchant: 'Tesla Supercharger',
    sub: 'EV Charging',
    icon: 'ev_station',
    iconBg: 'rgba(0,88,190,0.08)',
    iconColor: '#0058be',
    category: 'Auto',
    catBg: 'rgba(0,88,190,0.08)',
    catColor: '#0058be',
    amount: -32.18,
    date: 'Apr 3, 2026',
    account: 'Chase Checking',
    accountColor: '#0058be',
  },
  {
    merchant: 'Employer Direct Deposit',
    sub: 'Payroll — Bi-weekly',
    icon: 'payments',
    iconBg: 'rgba(0,150,104,0.08)',
    iconColor: '#009668',
    category: 'Income',
    catBg: 'rgba(0,150,104,0.08)',
    catColor: '#009668',
    amount: 4100.0,
    date: 'Apr 1, 2026',
    account: 'Chase Checking',
    accountColor: '#0058be',
  },
  {
    merchant: 'Nobu Restaurant',
    sub: 'Fine Dining',
    icon: 'restaurant',
    iconBg: 'rgba(186,26,26,0.08)',
    iconColor: '#ba1a1a',
    category: 'Dining Out',
    catBg: 'rgba(186,26,26,0.08)',
    catColor: '#ba1a1a',
    amount: -284.5,
    date: 'Mar 31, 2026',
    account: 'Amex Gold',
    accountColor: '#e8a317',
  },
  {
    merchant: 'Wealthfront Transfer',
    sub: 'Auto-invest',
    icon: 'savings',
    iconBg: 'rgba(124,58,237,0.08)',
    iconColor: '#7c3aed',
    category: 'Investing',
    catBg: 'rgba(124,58,237,0.08)',
    catColor: '#7c3aed',
    amount: -500.0,
    date: 'Mar 30, 2026',
    account: 'Wealthfront',
    accountColor: '#7c3aed',
  },
  {
    merchant: 'Apple One Subscription',
    sub: 'Family Plan',
    icon: 'subscriptions',
    iconBg: 'rgba(0,0,0,0.06)',
    iconColor: '#475569',
    category: 'Subscriptions',
    catBg: 'rgba(0,0,0,0.06)',
    catColor: '#475569',
    amount: -32.95,
    date: 'Mar 29, 2026',
    account: 'Amex Gold',
    accountColor: '#e8a317',
  },
  {
    merchant: 'United Airlines',
    sub: 'Round trip SFO ↔ JFK',
    icon: 'flight',
    iconBg: 'rgba(0,88,190,0.08)',
    iconColor: '#0058be',
    category: 'Travel',
    catBg: 'rgba(0,88,190,0.08)',
    catColor: '#0058be',
    amount: -648.0,
    date: 'Mar 28, 2026',
    account: 'Amex Gold',
    accountColor: '#e8a317',
  },
  {
    merchant: 'Vanguard Dividend',
    sub: 'VTSAX Q1 Distribution',
    icon: 'trending_up',
    iconBg: 'rgba(0,150,104,0.08)',
    iconColor: '#009668',
    category: 'Income',
    catBg: 'rgba(0,150,104,0.08)',
    catColor: '#009668',
    amount: 312.78,
    date: 'Mar 27, 2026',
    account: 'Wealthfront',
    accountColor: '#7c3aed',
  },
];

const RECURRING = [
  { name: 'Spotify Premium', freq: 'Monthly', amount: '$12.99', icon: 'music_note' },
  { name: 'Gym Membership', freq: 'Monthly', amount: '$89.00', icon: 'fitness_center' },
  { name: 'iCloud+ Storage', freq: 'Monthly', amount: '$9.99', icon: 'cloud' },
  { name: 'NYT Digital', freq: 'Monthly', amount: '$17.00', icon: 'newspaper' },
  { name: 'Auto Insurance', freq: 'Monthly', amount: '$142.00', icon: 'directions_car' },
];

const CATEGORIES = [
  { label: 'Dining Out', amount: '$1,240', pct: 72, color: '#ba1a1a' },
  { label: 'Groceries', amount: '$680', pct: 55, color: '#009668' },
  { label: 'Travel', amount: '$648', pct: 43, color: '#0058be' },
  { label: 'Subscriptions', amount: '$320', pct: 28, color: '#475569' },
  { label: 'Auto', amount: '$210', pct: 18, color: '#e8a317' },
];

export function TransactionsPage() {
  const [activeFilter, setActiveFilter] = useState('All Accounts');

  const filtered = activeFilter === 'All Accounts'
    ? TRANSACTIONS
    : TRANSACTIONS.filter((t) => t.account === activeFilter);

  return (
    <div className={styles.page}>
      {/* Header */}
      <div className={styles.pageHeader}>
        <div>
          <div className={styles.pageTitle}>Transactions</div>
          <div className={styles.pageSubtitle}>
            {TRANSACTIONS.length} transactions across {ACCOUNTS.length - 1} accounts
          </div>
        </div>
        <button className={styles.exportBtn}>
          <span className="material-symbols-outlined">download</span>
          Export CSV
        </button>
      </div>

      {/* Filter Bar */}
      <div className={styles.filterBar}>
        {ACCOUNTS.map((acc) => (
          <div
            key={acc}
            className={`${styles.filterPill} ${activeFilter === acc ? styles.filterPillActive : ''}`}
            onClick={() => setActiveFilter(acc)}
          >
            {acc}
          </div>
        ))}
      </div>

      {/* Main Grid */}
      <div className={styles.mainGrid}>
        {/* Table */}
        <div className={styles.tableCard}>
          <table className={styles.table}>
            <thead>
              <tr>
                <th>Merchant</th>
                <th>Category</th>
                <th>Amount</th>
                <th>Date</th>
                <th>Account</th>
              </tr>
            </thead>
            <tbody>
              {filtered.map((t, i) => (
                <tr key={i}>
                  <td>
                    <div className={styles.merchantCell}>
                      <div
                        className={styles.merchantIcon}
                        style={{ background: t.iconBg, color: t.iconColor }}
                      >
                        <span className="material-symbols-outlined">{t.icon}</span>
                      </div>
                      <div>
                        <div className={styles.merchantName}>{t.merchant}</div>
                        <div className={styles.merchantSub}>{t.sub}</div>
                      </div>
                    </div>
                  </td>
                  <td>
                    <span
                      className={styles.categoryBadge}
                      style={{ background: t.catBg, color: t.catColor }}
                    >
                      {t.category}
                    </span>
                  </td>
                  <td>
                    <span className={t.amount >= 0 ? styles.amountCredit : styles.amountDebit}>
                      {t.amount >= 0 ? '+' : ''}{t.amount < 0 ? '-' : ''}${Math.abs(t.amount).toLocaleString(undefined, { minimumFractionDigits: 2 })}
                    </span>
                  </td>
                  <td className={styles.dateCell}>{t.date}</td>
                  <td>
                    <div className={styles.accountCell}>
                      <div className={styles.accountDot} style={{ background: t.accountColor }} />
                      {t.account}
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>

        {/* Side Column */}
        <div className={styles.sideColumn}>
          {/* Recurring Commitments */}
          <div className={styles.recurringCard}>
            <div className={styles.sectionLabel}>Recurring Commitments</div>
            {RECURRING.map((r, i) => (
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
            {CATEGORIES.map((c, i) => (
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
            <div className={styles.summaryTitle}>Spending is 8% below monthly target</div>
            <div className={styles.summaryText}>
              Dining and travel categories drove 62% of discretionary spend this period.
              Recurring commitments total $271.98/mo. No anomalies in the last 48 hours.
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
