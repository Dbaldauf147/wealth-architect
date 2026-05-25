import { useState, useEffect, useCallback, lazy, Suspense, Component } from 'react';
import styles from './App.module.css';

function UpdatePill() {
  const [updateAvailable, setUpdateAvailable] = useState(false);

  useEffect(() => {
    const currentVersion = typeof __BUILD_VERSION__ !== 'undefined' ? __BUILD_VERSION__ : null;
    if (!currentVersion) return;

    const check = async () => {
      try {
        const res = await fetch('/version.json?t=' + Date.now(), { cache: 'no-store' });
        if (!res.ok) return;
        const data = await res.json();
        if (data.version && data.version !== currentVersion) {
          setUpdateAvailable(true);
        }
      } catch {}
    };

    const interval = setInterval(check, 60_000);
    // First check after 30s to avoid startup noise
    const timeout = setTimeout(check, 30_000);
    return () => { clearInterval(interval); clearTimeout(timeout); };
  }, []);

  if (!updateAvailable) return null;

  return (
    <div
      onClick={() => window.location.reload()}
      style={{
        position: 'fixed',
        bottom: 80,
        left: '50%',
        transform: 'translateX(-50%)',
        zIndex: 9999,
        display: 'flex',
        alignItems: 'center',
        gap: 8,
        padding: '10px 20px',
        background: 'var(--color-secondary, #0058be)',
        color: '#fff',
        borderRadius: 999,
        boxShadow: '0 4px 20px rgba(0,0,0,0.25)',
        cursor: 'pointer',
        fontSize: 13,
        fontWeight: 600,
        fontFamily: 'var(--font-body)',
        animation: 'slideUp 0.3s ease-out',
      }}
    >
      <span className="material-symbols-outlined" style={{ fontSize: 18 }}>update</span>
      New update available — click to refresh
    </div>
  );
}
import { useData, useDataActions } from './contexts/DataContext';

// Pages are loaded on demand so the initial bundle doesn't include every
// page upfront. React.lazy expects a default export, so we adapt the named
// exports from each page module.
const OverviewPage = lazy(() => import('./pages/OverviewPage').then(m => ({ default: m.OverviewPage })));
const TransactionsPage = lazy(() => import('./pages/TransactionsPage').then(m => ({ default: m.TransactionsPage })));
const CardsPage = lazy(() => import('./pages/CardsPage').then(m => ({ default: m.CardsPage })));
const AssetsPage = lazy(() => import('./pages/AssetsPage').then(m => ({ default: m.AssetsPage })));
const SettingsPage = lazy(() => import('./pages/SettingsPage').then(m => ({ default: m.SettingsPage })));
const BudgetsPage = lazy(() => import('./pages/BudgetsPage').then(m => ({ default: m.BudgetsPage })));
const RecurringPage = lazy(() => import('./pages/RecurringPage').then(m => ({ default: m.RecurringPage })));
const CashFlowPage = lazy(() => import('./pages/CashFlowPage').then(m => ({ default: m.CashFlowPage })));
const CardPromosPage = lazy(() => import('./pages/CardPromosPage').then(m => ({ default: m.CardPromosPage })));
const TrendsPage = lazy(() => import('./pages/TrendsPage').then(m => ({ default: m.TrendsPage })));

// Stale tabs after a deploy can throw ChunkLoadError when trying to fetch
// a page chunk that no longer exists at the cached hash. Reload once to
// pick up the fresh asset manifest; if it errors again we show a fallback.
class PageBoundary extends Component {
  constructor(props) {
    super(props);
    this.state = { errored: false };
  }
  static getDerivedStateFromError() {
    return { errored: true };
  }
  componentDidCatch(error) {
    const msg = (error && (error.message || '')) + ' ' + (error && error.name || '');
    const isChunk = /chunk|importing|dynamically imported module|failed to fetch/i.test(msg);
    if (isChunk && !sessionStorage.getItem('chunkReloaded')) {
      sessionStorage.setItem('chunkReloaded', '1');
      window.location.reload();
    }
  }
  render() {
    if (this.state.errored) {
      return (
        <div style={{ padding: 40, textAlign: 'center', color: 'var(--color-text-tertiary)' }}>
          <p>Something went wrong loading this page.</p>
          <button onClick={() => { sessionStorage.removeItem('chunkReloaded'); window.location.reload(); }}>
            Reload
          </button>
        </div>
      );
    }
    return this.props.children;
  }
}

function PageFallback() {
  return <div style={{ padding: 40, color: 'var(--color-text-tertiary)' }}>Loading…</div>;
}

const NAV_ITEMS = [
  { id: 'overview', label: 'Overview', icon: 'dashboard' },
  { id: 'transactions', label: 'Transactions', icon: 'receipt_long' },
  { id: 'cashflow', label: 'Cash Flow', icon: 'payments' },
  { id: 'trends', label: 'Spending Trends', icon: 'trending_up' },
  { id: 'budgets', label: 'Budgets', icon: 'savings' },
  { id: 'recurring', label: 'Recurring', icon: 'autorenew' },
  { id: 'assets', label: 'Assets & Liabilities', icon: 'account_balance' },
  { id: 'cards', label: 'Cards Overview', icon: 'credit_card' },
  { id: 'promos', label: 'Card Promotions', icon: 'redeem' },
];

const BOTTOM_NAV = [
  { id: 'overview', label: 'Overview', icon: 'dashboard' },
  { id: 'transactions', label: 'Txns', icon: 'receipt_long' },
  { id: 'budgets', label: 'Budgets', icon: 'savings' },
  { id: 'cards', label: 'Cards', icon: 'credit_card' },
  { id: 'settings', label: 'Settings', icon: 'settings' },
];

function getHashView() {
  const hash = window.location.hash.replace('#', '');
  return hash || 'overview';
}

export function App() {
  const [view, setView] = useState(getHashView);
  const [mobileOpen, setMobileOpen] = useState(false);
  const [headerTab, setHeaderTab] = useState('portfolio');
  const { loading, syncing, lastSync } = useData();
  const { refresh } = useDataActions();
  const busy = loading || syncing;

  useEffect(() => {
    const onHash = () => setView(getHashView());
    window.addEventListener('hashchange', onHash);
    return () => window.removeEventListener('hashchange', onHash);
  }, []);

  function navigate(id) {
    window.location.hash = id;
    setView(id);
    setMobileOpen(false);
  }

  function renderPage() {
    switch (view) {
      case 'transactions': return <TransactionsPage />;
      case 'cashflow': return <CashFlowPage />;
      case 'trends': return <TrendsPage />;
      case 'budgets': return <BudgetsPage />;
      case 'recurring': return <RecurringPage />;
      case 'assets': return <AssetsPage />;
      case 'cards': return <CardsPage />;
      case 'promos': return <CardPromosPage />;
      case 'settings': return <SettingsPage />;
      default: return <OverviewPage />;
    }
  }

  return (
    <div className={styles.layout}>
      {/* Sidebar Overlay (mobile) */}
      {mobileOpen && (
        <div className={styles.sidebarOverlay} onClick={() => setMobileOpen(false)} />
      )}

      {/* Sidebar */}
      <aside className={`${styles.sidebar} ${mobileOpen ? styles.sidebarOpen : ''}`}>
        <div className={styles.sidebarLogo}>
          <div className={styles.logoIcon}>W</div>
          <span className={styles.logoText}>Wealth Architect</span>
        </div>

        <nav className={styles.sidebarNav}>
          {NAV_ITEMS.map((item) => (
            <div
              key={item.id}
              className={`${styles.navItem} ${view === item.id ? styles.navItemActive : ''}`}
              onClick={() => navigate(item.id)}
            >
              <span className="material-symbols-outlined">{item.icon}</span>
              {item.label}
            </div>
          ))}
        </nav>

        <div className={styles.sidebarBottom}>
          <div className={styles.sidebarBottomItem} onClick={() => {}}>
            <span className="material-symbols-outlined">table_chart</span>
            Connect Sheets
          </div>
          <div className={styles.sidebarBottomItem} onClick={() => navigate('settings')}>
            <span className="material-symbols-outlined">settings</span>
            Settings
          </div>
          <button className={styles.syncButton} onClick={refresh} disabled={busy}>
            <span className="material-symbols-outlined" style={{ fontSize: 15 }}>{busy ? 'hourglass_empty' : 'sync'}</span>
            {busy ? 'Syncing...' : 'Force Sync Sheets'}
          </button>
        </div>

        <div className={styles.sidebarProfile}>
          <div className={styles.profileAvatar}>DB</div>
          <div className={styles.profileInfo}>
            <div className={styles.profileName}>Dan Baldauf</div>
            <div className={styles.profileEmail}>dan@wealtharchitect.io</div>
          </div>
        </div>
      </aside>

      {/* Main Area */}
      <div className={styles.main}>
        {/* Top Header */}
        <header className={styles.header}>
          <button className={styles.mobileMenuBtn} onClick={() => setMobileOpen(true)}>
            <span className="material-symbols-outlined">menu</span>
          </button>

          <span className={styles.headerBrand}>Executive Precision</span>

          <div className={styles.headerLinks}>
            {['portfolio', 'analytic', 'history'].map((tab) => (
              <div
                key={tab}
                className={`${styles.headerLink} ${headerTab === tab ? styles.headerLinkActive : ''}`}
                onClick={() => setHeaderTab(tab)}
              >
                {tab.charAt(0).toUpperCase() + tab.slice(1)}
              </div>
            ))}
          </div>

          <div className={styles.headerSpacer} />

          <div className={styles.searchBox}>
            <span className="material-symbols-outlined">search</span>
            <input
              className={styles.searchInput}
              type="text"
              placeholder="Search transactions..."
            />
          </div>

          <button className={styles.newEntryBtn}>
            <span className="material-symbols-outlined">add</span>
            <span>New Manual Entry</span>
          </button>

          <div className={styles.headerIcons}>
            <div className={styles.headerIconBtn}>
              <span className="material-symbols-outlined">notifications</span>
              <div className={styles.notifDot} />
            </div>
            <div className={styles.headerIconBtn}>
              <span className="material-symbols-outlined">sync</span>
            </div>
          </div>

          <div className={styles.headerAvatar}>DB</div>
        </header>

        {/* Page Content */}
        <main className={styles.content}>
          <PageBoundary>
            <Suspense fallback={<PageFallback />}>
              {renderPage()}
            </Suspense>
          </PageBoundary>
        </main>
      </div>

      <UpdatePill />

      {/* Mobile Bottom Nav */}
      <nav className={styles.bottomNav}>
        {BOTTOM_NAV.map((item) => (
          <div
            key={item.id}
            className={`${styles.bottomNavItem} ${view === item.id ? styles.bottomNavItemActive : ''}`}
            onClick={() => navigate(item.id)}
          >
            <span className="material-symbols-outlined">{item.icon}</span>
            {item.label}
          </div>
        ))}
      </nav>
    </div>
  );
}

/* Placeholder pages for routes not yet built */
function SettingsPlaceholder() {
  return (
    <div style={{ padding: 40, textAlign: 'center', color: 'var(--color-text-tertiary)' }}>
      <span className="material-symbols-outlined" style={{ fontSize: 48, marginBottom: 16, display: 'block' }}>settings</span>
      <h2 style={{ fontFamily: 'var(--font-headline)', marginBottom: 8 }}>Settings</h2>
      <p>Configuration panel coming soon.</p>
    </div>
  );
}

export default App;
