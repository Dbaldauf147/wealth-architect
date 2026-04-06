import { useState, useEffect } from 'react';
import styles from './App.module.css';
import { OverviewPage } from './pages/OverviewPage';
import { TransactionsPage } from './pages/TransactionsPage';
import { BudgetsPage } from './pages/BudgetsPage';
import { CardsPage } from './pages/CardsPage';
import { AssetsPage } from './pages/AssetsPage';
import { SettingsPage } from './pages/SettingsPage';
import { useData } from './contexts/DataContext';

const NAV_ITEMS = [
  { id: 'overview', label: 'Overview', icon: 'dashboard' },
  { id: 'transactions', label: 'Transactions', icon: 'receipt_long' },
  { id: 'budgets', label: 'Budgets', icon: 'savings' },
  { id: 'assets', label: 'Assets & Liabilities', icon: 'account_balance' },
  { id: 'cards', label: 'Cards Optimizer', icon: 'credit_card' },
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
  const { refresh, loading, lastSync } = useData();

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
      case 'budgets': return <BudgetsPage />;
      case 'assets': return <AssetsPage />;
      case 'cards': return <CardsPage />;
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
          <button className={styles.syncButton} onClick={refresh} disabled={loading}>
            <span className="material-symbols-outlined" style={{ fontSize: 15 }}>{loading ? 'hourglass_empty' : 'sync'}</span>
            {loading ? 'Syncing...' : 'Force Sync Sheets'}
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
          {renderPage()}
        </main>
      </div>

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
