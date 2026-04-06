import { useData } from '../contexts/DataContext';
import styles from './BudgetsPage.module.css';

function fmt(n) {
  if (n == null) return '—';
  return new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', minimumFractionDigits: 0, maximumFractionDigits: 0 }).format(n);
}

const GOALS = [
  { name: 'Emergency Fund', target: '$25,000', saved: '$20,000', pct: 80, color: '#0058be' },
  { name: 'Down Payment', target: '$80,000', saved: '$48,000', pct: 60, color: '#009668' },
  { name: 'Luxury Travel', target: '$12,000', saved: '$3,000', pct: 25, color: '#7c3aed' },
];

const LIMITS = [
  {
    name: 'Dining Out',
    icon: 'restaurant',
    iconBg: 'rgba(186,26,26,0.08)',
    iconColor: '#ba1a1a',
    spent: '$1,240',
    budget: '$1,500',
    pct: 83,
    barColor: '#e8a317',
    status: 'warning',
  },
  {
    name: 'Groceries',
    icon: 'shopping_cart',
    iconBg: 'rgba(0,88,190,0.08)',
    iconColor: '#0058be',
    spent: '$680',
    budget: '$1,200',
    pct: 57,
    barColor: '#0058be',
    status: 'stable',
  },
  {
    name: 'Entertainment',
    icon: 'theaters',
    iconBg: 'rgba(0,150,104,0.08)',
    iconColor: '#009668',
    spent: '$220',
    budget: '$800',
    pct: 28,
    barColor: '#009668',
    status: 'healthy',
  },
];

const VARIANCE = [
  { category: 'Dining Out', budget: '$1,500', actual: '$1,240', variance: '-$260', pctVar: '-17%', direction: 'down' },
  { category: 'Groceries', budget: '$1,200', actual: '$680', variance: '-$520', pctVar: '-43%', direction: 'down' },
  { category: 'Travel', budget: '$800', actual: '$648', variance: '-$152', pctVar: '-19%', direction: 'down' },
  { category: 'Subscriptions', budget: '$300', actual: '$320', variance: '+$20', pctVar: '+7%', direction: 'up' },
  { category: 'Auto & Transport', budget: '$400', actual: '$210', variance: '-$190', pctVar: '-48%', direction: 'down' },
  { category: 'Shopping', budget: '$500', actual: '$512', variance: '+$12', pctVar: '+2%', direction: 'up' },
];

function ProgressRing({ pct, color, size = 110, stroke = 8 }) {
  const radius = (size - stroke) / 2;
  const circ = 2 * Math.PI * radius;
  const offset = circ - (pct / 100) * circ;

  return (
    <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`}>
      <circle
        cx={size / 2}
        cy={size / 2}
        r={radius}
        fill="none"
        stroke="var(--color-surface-alt)"
        strokeWidth={stroke}
      />
      <circle
        cx={size / 2}
        cy={size / 2}
        r={radius}
        fill="none"
        stroke={color}
        strokeWidth={stroke}
        strokeDasharray={circ}
        strokeDashoffset={offset}
        strokeLinecap="round"
        transform={`rotate(-90 ${size / 2} ${size / 2})`}
        style={{ transition: 'stroke-dashoffset 0.6s ease' }}
      />
      <text
        x={size / 2}
        y={size / 2 - 4}
        textAnchor="middle"
        fontFamily="var(--font-headline)"
        fontSize="22"
        fontWeight="800"
        fill="var(--color-text-primary)"
      >
        {pct}%
      </text>
      <text
        x={size / 2}
        y={size / 2 + 14}
        textAnchor="middle"
        fontFamily="var(--font-body)"
        fontSize="9"
        fill="var(--color-text-tertiary)"
      >
        COMPLETE
      </text>
    </svg>
  );
}

export function BudgetsPage() {
  const { analytics, balances, loading } = useData();
  const totalExpenses = analytics?.totalExpenses || 0;
  const totalIncome = analytics?.totalIncome || 0;
  const cashFlow = analytics?.cashFlow || 0;

  return (
    <div className={styles.page}>
      {/* Dynamic Allocation Hero */}
      <div className={styles.hero}>
        <div className={styles.heroLabel}>Dynamic Allocation</div>
        <div className={styles.heroTitle}>Monthly Budget Performance</div>
        <div className={styles.heroSubtitle}>
          {cashFlow >= 0 ? 'You are currently under budget. Keep up the discipline.' : 'Spending exceeds income this period. Review categories below.'}
        </div>
        <div className={styles.heroStats}>
          <div className={styles.heroStat}>
            <div className={`${styles.heroStatValue} ${cashFlow >= 0 ? styles.heroStatValueGreen : ''}`}>{fmt(cashFlow)}</div>
            <div className={styles.heroStatLabel}>{cashFlow >= 0 ? 'Surplus' : 'Deficit'}</div>
          </div>
          <div className={styles.heroStat}>
            <div className={styles.heroStatValue}>{fmt(totalIncome)}</div>
            <div className={styles.heroStatLabel}>Total Income</div>
          </div>
          <div className={styles.heroStat}>
            <div className={styles.heroStatValue}>{fmt(totalExpenses)}</div>
            <div className={styles.heroStatLabel}>Spent to Date</div>
          </div>
          <div className={styles.heroStat}>
            <div className={styles.heroStatValue}>{analytics?.transactionCount || 0}</div>
            <div className={styles.heroStatLabel}>Days Left</div>
          </div>
        </div>
      </div>

      {/* Savings Goals */}
      <div>
        <div className={styles.sectionLabel}>Savings Goals</div>
        <div className={styles.goalsGrid}>
          {GOALS.map((g) => (
            <div key={g.name} className={styles.goalCard}>
              <div className={styles.goalRingWrapper}>
                <ProgressRing pct={g.pct} color={g.color} />
              </div>
              <div className={styles.goalName}>{g.name}</div>
              <div className={styles.goalTarget}>Target: {g.target}</div>
              <div className={styles.goalSaved}>Saved: {g.saved}</div>
            </div>
          ))}
        </div>
      </div>

      {/* Spending Limits */}
      <div>
        <div className={styles.sectionLabel}>Spending Limits</div>
        <div className={styles.limitsGrid}>
          {LIMITS.map((l) => (
            <div key={l.name} className={styles.limitCard}>
              <div className={styles.limitHeader}>
                <div className={styles.limitIcon} style={{ background: l.iconBg, color: l.iconColor }}>
                  <span className="material-symbols-outlined">{l.icon}</span>
                </div>
                <span
                  className={`${styles.limitBadge} ${
                    l.status === 'warning'
                      ? styles.badgeWarning
                      : l.status === 'stable'
                      ? styles.badgeStable
                      : styles.badgeHealthy
                  }`}
                >
                  {l.status}
                </span>
              </div>
              <div className={styles.limitName}>{l.name}</div>
              <div className={styles.limitSpent}>
                <span className={styles.limitSpentValue}>{l.spent}</span>
                <span className={styles.limitSpentOf}>of {l.budget}</span>
              </div>
              <div className={styles.limitBar}>
                <div
                  className={styles.limitFill}
                  style={{ width: `${l.pct}%`, background: l.barColor }}
                />
              </div>
              <div className={styles.limitPct}>{l.pct}% used</div>
            </div>
          ))}
        </div>
      </div>

      {/* Historical Variance */}
      <div className={styles.varianceCard}>
        <div className={styles.varianceTitle}>Historical Variance</div>
        <table className={styles.varianceTable}>
          <thead>
            <tr>
              <th>Category</th>
              <th>Budget</th>
              <th>Actual</th>
              <th>Variance</th>
              <th>% Var</th>
            </tr>
          </thead>
          <tbody>
            {VARIANCE.map((v, i) => (
              <tr key={i}>
                <td style={{ fontWeight: 600 }}>{v.category}</td>
                <td>{v.budget}</td>
                <td>{v.actual}</td>
                <td className={v.direction === 'up' ? styles.varianceUp : styles.varianceDown}>
                  {v.variance}
                </td>
                <td className={v.direction === 'up' ? styles.varianceUp : styles.varianceDown}>
                  {v.pctVar}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
