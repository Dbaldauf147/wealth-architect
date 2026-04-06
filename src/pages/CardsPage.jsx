import styles from './CardsPage.module.css';

const YIELD_DATA = [
  { card: 'Amex Gold', yield: 3.8, color: '#e8a317' },
  { card: 'CSP', yield: 2.9, color: '#0058be' },
  { card: 'Amex Plat', yield: 2.4, color: '#475569' },
  { card: 'Venture X', yield: 2.1, color: '#ba1a1a' },
  { card: 'Citi Double', yield: 2.0, color: '#009668' },
];

const CARDS_MATRIX = [
  {
    name: 'Amex Gold Card',
    issuer: 'American Express',
    stripe: '#e8a317',
    fee: '$250',
    accelerators: ['4x Dining', '4x Groceries', '3x Flights'],
    status: 'active',
  },
  {
    name: 'Chase Sapphire Preferred',
    issuer: 'Chase',
    stripe: '#0058be',
    fee: '$95',
    accelerators: ['3x Dining', '3x Travel', '2x Streaming'],
    status: 'active',
  },
  {
    name: 'Amex Platinum',
    issuer: 'American Express',
    stripe: '#94a3b8',
    fee: '$695',
    accelerators: ['5x Flights', '5x Hotels', 'Lounge Access'],
    status: 'active',
  },
  {
    name: 'Capital One Venture X',
    issuer: 'Capital One',
    stripe: '#ba1a1a',
    fee: '$395',
    accelerators: ['10x Hotels', '5x Flights', '2x All'],
    status: 'sock',
  },
  {
    name: 'Citi Double Cash',
    issuer: 'Citibank',
    stripe: '#009668',
    fee: '$0',
    accelerators: ['2x All Purchases'],
    status: 'active',
  },
];

const BENEFITS = [
  { label: 'Uber Credits', used: '$15', total: '$15', pct: 100, color: '#0058be' },
  { label: 'Dining Credit', used: '$8.40', total: '$10', pct: 84, color: '#009668' },
  { label: 'Entertainment', used: '$10', total: '$20', pct: 50, color: '#e8a317' },
  { label: 'Airline Incidentals', used: '$0', total: '$200', pct: 0, color: '#94a3b8' },
  { label: 'Saks Credit', used: '$50', total: '$100', pct: 50, color: '#7c3aed' },
];

const CARD_PERF = [
  { label: 'Total Annual Spend', value: '$84,200', pct: 70, color: '#0058be' },
  { label: 'Rewards Earned YTD', value: '$3,210', pct: 55, color: '#009668' },
  { label: 'Net Reward Rate', value: '3.8%', pct: 76, color: '#e8a317' },
  { label: 'Fee Breakeven', value: '142%', pct: 100, color: '#009668' },
];

export function CardsPage() {
  const maxYield = Math.max(...YIELD_DATA.map((d) => d.yield));

  return (
    <div className={styles.page}>
      {/* Optimization Alert Hero */}
      <div className={styles.hero}>
        <div className={styles.heroIcon}>
          <span className="material-symbols-outlined">auto_awesome</span>
        </div>
        <div className={styles.heroContent}>
          <div className={styles.heroLabel}>Optimization Alert</div>
          <div className={styles.heroTitle}>
            Switch grocery spend to Amex Gold for an extra $42/mo in rewards
          </div>
          <div className={styles.heroSubtitle}>
            Based on your last 90 days of grocery transactions averaging $1,050/mo
          </div>
        </div>
        <button className={styles.heroAction}>View Analysis</button>
      </div>

      {/* Reward Yield Chart */}
      <div className={styles.chartCard}>
        <div className={styles.chartHeader}>
          <div>
            <div className={styles.chartTitle}>Reward Yield by Card</div>
            <div className={styles.chartSubtitle}>Effective reward rate based on trailing 90-day spend</div>
          </div>
        </div>
        <div className={styles.barChart}>
          {YIELD_DATA.map((d) => (
            <div key={d.card} className={styles.barGroup}>
              <div className={styles.barValue}>{d.yield}%</div>
              <div
                className={styles.bar}
                style={{
                  height: `${(d.yield / maxYield) * 100}%`,
                  background: d.color,
                }}
              />
              <div className={styles.barLabel}>{d.card}</div>
            </div>
          ))}
        </div>
      </div>

      {/* Active Portfolio Matrix */}
      <div className={styles.matrixCard}>
        <div className={styles.matrixTitle}>Active Portfolio Matrix</div>
        <table className={styles.matrixTable}>
          <thead>
            <tr>
              <th>Card</th>
              <th>Annual Fee</th>
              <th>Accelerators</th>
              <th>Status</th>
            </tr>
          </thead>
          <tbody>
            {CARDS_MATRIX.map((c, i) => (
              <tr key={i}>
                <td>
                  <div className={styles.cardIdent}>
                    <div className={styles.cardStripe} style={{ background: c.stripe }} />
                    <div>
                      <div className={styles.cardName}>{c.name}</div>
                      <div className={styles.cardIssuer}>{c.issuer}</div>
                    </div>
                  </div>
                </td>
                <td className={styles.cardFee}>{c.fee}</td>
                <td>
                  <div className={styles.accelerators}>
                    {c.accelerators.map((a, j) => (
                      <span key={j} className={styles.accelBadge}>{a}</span>
                    ))}
                  </div>
                </td>
                <td>
                  <span
                    className={`${styles.statusBadge} ${
                      c.status === 'active' ? styles.statusActive : styles.statusSock
                    }`}
                  >
                    {c.status === 'sock' ? 'Sock Drawer' : 'Active'}
                  </span>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {/* Card Performance + Benefit Utilization */}
      <div className={styles.perfGrid}>
        <div className={styles.perfCard}>
          <div className={styles.perfTitle}>Card Performance</div>
          {CARD_PERF.map((p, i) => (
            <div key={i} className={styles.perfItem}>
              <div className={styles.perfHeader}>
                <span className={styles.perfLabel}>{p.label}</span>
                <span className={styles.perfValue}>{p.value}</span>
              </div>
              <div className={styles.perfBar}>
                <div
                  className={styles.perfFill}
                  style={{ width: `${p.pct}%`, background: p.color }}
                />
              </div>
            </div>
          ))}
        </div>

        <div className={styles.perfCard}>
          <div className={styles.perfTitle}>Benefit Utilization</div>
          {BENEFITS.map((b, i) => (
            <div key={i} className={styles.perfItem}>
              <div className={styles.perfHeader}>
                <span className={styles.perfLabel}>{b.label}</span>
                <span className={styles.perfValue}>{b.used} / {b.total}</span>
              </div>
              <div className={styles.perfBar}>
                <div
                  className={styles.perfFill}
                  style={{ width: `${b.pct}%`, background: b.color }}
                />
              </div>
            </div>
          ))}
        </div>
      </div>

      {/* Elite Status + Referrals */}
      <div className={styles.bottomRow}>
        <div className={styles.infoCard}>
          <div className={styles.infoHeader}>
            <div className={styles.infoIcon} style={{ background: 'rgba(232,163,23,0.08)', color: '#e8a317' }}>
              <span className="material-symbols-outlined">military_tech</span>
            </div>
            <div className={styles.infoTitle}>Elite Status Tracker</div>
          </div>
          <div className={styles.infoRow}>
            <span className={styles.infoLabel}>Marriott Bonvoy</span>
            <span className={styles.infoValueGold}>Gold Elite</span>
          </div>
          <div className={styles.infoRow}>
            <span className={styles.infoLabel}>Hilton Honors</span>
            <span className={styles.infoValueGold}>Diamond</span>
          </div>
          <div className={styles.infoRow}>
            <span className={styles.infoLabel}>Delta SkyMiles</span>
            <span className={styles.infoValueGold}>Gold Medallion</span>
          </div>
          <div className={styles.infoRow}>
            <span className={styles.infoLabel}>Hertz Rental</span>
            <span className={styles.infoValue}>President's Circle</span>
          </div>
          <div className={styles.infoRow}>
            <span className={styles.infoLabel}>Clear Plus</span>
            <span className={styles.infoValueGreen}>Included</span>
          </div>
        </div>

        <div className={styles.infoCard}>
          <div className={styles.infoHeader}>
            <div className={styles.infoIcon} style={{ background: 'rgba(0,88,190,0.08)', color: '#0058be' }}>
              <span className="material-symbols-outlined">share</span>
            </div>
            <div className={styles.infoTitle}>Referral Tracker</div>
          </div>
          <div className={styles.infoRow}>
            <span className={styles.infoLabel}>Amex Gold Referrals</span>
            <span className={styles.infoValue}>3 / 5 used</span>
          </div>
          <div className={styles.infoRow}>
            <span className={styles.infoLabel}>Referral Bonus Earned</span>
            <span className={styles.infoValueGreen}>45,000 MR pts</span>
          </div>
          <div className={styles.infoRow}>
            <span className={styles.infoLabel}>CSP Referrals</span>
            <span className={styles.infoValue}>1 / 5 used</span>
          </div>
          <div className={styles.infoRow}>
            <span className={styles.infoLabel}>Referral Bonus Earned</span>
            <span className={styles.infoValueGreen}>15,000 UR pts</span>
          </div>
          <div className={styles.infoRow}>
            <span className={styles.infoLabel}>Est. Cash Value</span>
            <span className={styles.infoValue}>$1,080</span>
          </div>
        </div>
      </div>
    </div>
  );
}
