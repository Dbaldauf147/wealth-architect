import { useState, useEffect, useMemo, useCallback } from 'react';
import { useData, useDataActions } from '../contexts/DataContext';
import { reviewStats } from '../lib/reviewQueue';
import { ReviewTab } from './ReviewTab';
import { RecentTab } from './RecentTab';
import { InsightsTab } from './InsightsTab';
import { SearchTab } from './SearchTab';
import { SplitsTab } from './SplitsTab';
import { RulesTab } from './RulesTab';
import { applyBadge, clearBadge, badgeBlocker, requestBadgePermission } from './appBadge';
import styles from './MobileApp.module.css';

const TABS = [
  { id: 'review', label: 'Review', icon: 'inbox' },
  { id: 'recent', label: 'Filed', icon: 'history' },
  { id: 'search', label: 'Search', icon: 'query_stats' },
  { id: 'splits', label: 'Splits', icon: 'call_split' },
  { id: 'insights', label: 'Month', icon: 'donut_small' },
];

// Rules is reachable from the header rather than the tab bar: it is a screen
// you visit to correct something, not one you move between while working.
const ALL_VIEWS = [...TABS.map(t => t.id), 'rules'];

const SORT_KEY = 'mobileReviewSort';
const ASK_SUB_KEY = 'mobileAskSubcategory';
const BADGE_KEY = 'mobileHomeBadge';
const BADGE_ASKED_KEY = 'mobileHomeBadgeAsked';

function readHashTab() {
  const hash = window.location.hash.replace(/^#/, '');
  const [, tab] = hash.split('/');
  return ALL_VIEWS.includes(tab) ? tab : 'review';
}

/* The mobile categorizer.

   A separate shell rather than a responsive squeeze of the desktop app: the
   desktop page is a spreadsheet, and the useful thing to do on a phone is not
   "the spreadsheet, smaller" but one decision at a time. It reads and writes
   through the same DataProvider, so a category assigned here is the same
   category the Transactions table, the budgets, and the weekly email see. */
export function MobileApp() {
  const [tab, setTab] = useState(readHashTab);
  const [sort, setSort] = useState(() => {
    try { return localStorage.getItem(SORT_KEY) || 'impact'; } catch { return 'impact'; }
  });
  const [askSub, setAskSub] = useState(() => {
    try { return localStorage.getItem(ASK_SUB_KEY) !== '0'; } catch { return true; }
  });
  // Off until asked for. Switching it on needs a permission prompt, and a
  // prompt nobody asked for is the fastest way to get notifications denied for
  // good — iOS gives you one refusal and then only Settings can undo it.
  const [badgeOn, setBadgeOn] = useState(() => {
    try { return localStorage.getItem(BADGE_KEY) === '1'; } catch { return false; }
  });
  const [badgeAsked, setBadgeAsked] = useState(() => {
    try { return localStorage.getItem(BADGE_ASKED_KEY) === '1'; } catch { return true; }
  });
  const [installEvent, setInstallEvent] = useState(null);
  const { transactions, loading, syncing, error, lastSync } = useData();
  const { refresh } = useDataActions();

  // Safe-area insets only resolve when the viewport opts into the notch with
  // viewport-fit=cover, and setting that globally would let the desktop layout
  // slide under it. Scoped to this shell's lifetime instead. The theme colour
  // rides along so the status bar matches this screen's white header.
  useEffect(() => {
    const viewport = document.querySelector('meta[name="viewport"]');
    const theme = document.querySelector('meta[name="theme-color"]');
    const prevViewport = viewport?.getAttribute('content');
    const prevTheme = theme?.getAttribute('content');
    if (viewport && prevViewport && !prevViewport.includes('viewport-fit')) {
      viewport.setAttribute('content', `${prevViewport}, viewport-fit=cover`);
    }
    theme?.setAttribute('content', '#ffffff');
    return () => {
      if (viewport && prevViewport) viewport.setAttribute('content', prevViewport);
      if (theme && prevTheme) theme.setAttribute('content', prevTheme);
    };
  }, []);

  useEffect(() => {
    const onHash = () => setTab(readHashTab());
    window.addEventListener('hashchange', onHash);
    return () => window.removeEventListener('hashchange', onHash);
  }, []);

  const go = useCallback((id) => {
    window.location.hash = `m/${id}`;
    setTab(id);
  }, []);

  const changeSort = useCallback((next) => {
    setSort(next);
    try { localStorage.setItem(SORT_KEY, next); } catch { /* private mode */ }
  }, []);

  const changeAskSub = useCallback((next) => {
    setAskSub(next);
    try { localStorage.setItem(ASK_SUB_KEY, next ? '1' : '0'); } catch { /* private mode */ }
  }, []);

  /* Turn the home screen count on, which means asking for the permission it is
     drawn under. Has to run off a tap: iOS ignores an unprompted request, and
     spends the one refusal you get if it decides you were being pushy. */
  const enableBadge = useCallback(async () => {
    setBadgeAsked(true);
    try { localStorage.setItem(BADGE_ASKED_KEY, '1'); } catch { /* private mode */ }
    const result = await requestBadgePermission();
    const on = result === 'granted';
    setBadgeOn(on);
    try { localStorage.setItem(BADGE_KEY, on ? '1' : '0'); } catch { /* private mode */ }
    return result;
  }, []);

  const changeBadge = useCallback(async (next) => {
    if (next) return enableBadge();
    setBadgeOn(false);
    try { localStorage.setItem(BADGE_KEY, '0'); } catch { /* private mode */ }
    clearBadge();
    return 'off';
  }, [enableBadge]);

  const dismissBadgeOffer = useCallback(() => {
    setBadgeAsked(true);
    try { localStorage.setItem(BADGE_ASKED_KEY, '1'); } catch { /* private mode */ }
  }, []);

  // Chrome/Edge fire this when the app is installable; iOS Safari never does,
  // and there the user installs from the share sheet, so the prompt is simply
  // absent rather than broken.
  useEffect(() => {
    const onPrompt = (e) => { e.preventDefault(); setInstallEvent(e); };
    window.addEventListener('beforeinstallprompt', onPrompt);
    const onInstalled = () => setInstallEvent(null);
    window.addEventListener('appinstalled', onInstalled);
    return () => {
      window.removeEventListener('beforeinstallprompt', onPrompt);
      window.removeEventListener('appinstalled', onInstalled);
    };
  }, []);

  /* What is actually left to file.

     Only transactions carrying an ID, because the whole config layer is keyed
     by one and the review deck drops the rest — counting them gives a number
     no amount of work can bring down. That was survivable when this only fed
     the tab badge, which disagreed with the deck's own progress strip; it is
     not survivable on a home screen icon, where the red dot would never clear. */
  const pending = useMemo(
    () => reviewStats((transactions || []).filter(t => t.transactionId)).count,
    [transactions],
  );
  const busy = loading || syncing;

  /* Write the backlog onto the icon whenever it moves.

     iOS has no periodic background sync, so this is the only moment the count
     can be written: while the app is open. It then holds that value on the
     icon until the app is next opened — which is what makes it a reminder,
     and also why filing on the desktop site leaves it briefly stale. */
  useEffect(() => {
    if (!badgeOn) return;
    applyBadge(pending);
  }, [badgeOn, pending]);

  // Worth offering only when it would do something: an installed app, a
  // permission still unasked, and a backlog to actually count.
  const offerBadge = !badgeAsked && !badgeOn && pending > 0 && badgeBlocker() === null;

  return (
    <div className={styles.app}>
      <header className={styles.header}>
        <div className={styles.brand}>
          <span className={styles.brandMark}>W</span>
          {tab === 'rules' ? 'Rules' : tab === 'search' ? 'Search' : 'Categorize'}
        </div>
        <div className={styles.headerSpacer} />
        <button
          className={styles.iconBtn}
          onClick={refresh}
          disabled={busy}
          aria-label="Sync now"
          title={lastSync ? `Last synced ${new Date(lastSync).toLocaleTimeString()}` : 'Sync now'}
        >
          <span className={`material-symbols-outlined ${busy ? styles.spin : ''}`}>
            {busy ? 'progress_activity' : 'sync'}
          </span>
        </button>
        <button
          className={styles.iconBtn}
          onClick={() => go(tab === 'rules' ? 'review' : 'rules')}
          aria-label={tab === 'rules' ? 'Back to reviewing' : 'Rules'}
          title={tab === 'rules' ? 'Back to reviewing' : 'Rules'}
          style={tab === 'rules' ? { color: 'var(--color-secondary)' } : undefined}
        >
          <span className="material-symbols-outlined">{tab === 'rules' ? 'close' : 'rule'}</span>
        </button>
        <button
          className={styles.iconBtn}
          onClick={() => { window.location.hash = 'transactions'; }}
          aria-label="Open the full app"
          title="Open the full app"
        >
          <span className="material-symbols-outlined">open_in_full</span>
        </button>
      </header>

      <div className={styles.body}>
        {installEvent && (
          <div className={styles.install}>
            <span className="material-symbols-outlined" style={{ fontSize: 19 }}>install_mobile</span>
            Add to your home screen
            <button
              className={styles.installBtn}
              onClick={async () => {
                installEvent.prompt();
                await installEvent.userChoice;
                setInstallEvent(null);
              }}
            >
              Install
            </button>
          </div>
        )}

        {offerBadge && (
          <div className={styles.install}>
            <span className="material-symbols-outlined" style={{ fontSize: 19 }}>notifications_active</span>
            Show {pending} on the app icon
            <button className={styles.installBtn} onClick={enableBadge}>
              Turn on
            </button>
            <button
              className={styles.iconBtn}
              style={{ width: 28, height: 28 }}
              onClick={dismissBadgeOffer}
              aria-label="Not now"
            >
              <span className="material-symbols-outlined" style={{ fontSize: 18 }}>close</span>
            </button>
          </div>
        )}

        {error && (
          <div className={styles.install} style={{ background: 'rgba(186,26,26,0.08)', color: 'var(--color-error)' }}>
            <span className="material-symbols-outlined" style={{ fontSize: 19 }}>cloud_off</span>
            {String(error)}
          </div>
        )}

        {loading && !transactions?.length ? (
          <div className={styles.empty}>
            <span className={`material-symbols-outlined ${styles.emptyIcon} ${styles.spin}`} style={{ color: 'var(--color-text-muted)' }}>
              progress_activity
            </span>
            <div className={styles.emptyText}>Loading your transactions…</div>
          </div>
        ) : (
          <>
            {tab === 'review' && <ReviewTab sort={sort} onSortChange={changeSort} askSub={askSub} />}
            {tab === 'recent' && <RecentTab />}
            {tab === 'search' && <SearchTab />}
            {tab === 'splits' && <SplitsTab />}
            {tab === 'insights' && <InsightsTab onGoReview={() => go('review')} />}
            {tab === 'rules' && (
              <RulesTab
                askSub={askSub}
                onAskSubChange={changeAskSub}
                badgeOn={badgeOn}
                onBadgeChange={changeBadge}
              />
            )}
          </>
        )}
      </div>

      <nav className={styles.tabbar}>
        {TABS.map(t => (
          <button
            key={t.id}
            className={`${styles.tab} ${tab === t.id ? styles.tabActive : ''}`}
            onClick={() => go(t.id)}
          >
            <span className="material-symbols-outlined">{t.icon}</span>
            {t.id === 'review' && pending > 0 && (
              <span className={styles.tabBadge}>{pending > 99 ? '99+' : pending}</span>
            )}
            {t.label}
          </button>
        ))}
      </nav>
    </div>
  );
}

export default MobileApp;
