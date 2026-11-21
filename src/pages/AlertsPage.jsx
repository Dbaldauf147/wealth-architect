import { useMemo } from 'react';
import { useHsa } from '../hooks/useHsa';
import { hsaAlerts } from '../lib/hsa';
import { CARDS_VIEW_KEY } from '../lib/cardsView';

/* Everything that needs attention, in one place. The sidebar's red number on
   Alerts is the length of this list (useNavBadges computes it the same way).
   Today it holds the HSA check: either of the last two full months with no
   HSA activity pasted in. */

const card = { background: 'var(--color-surface)', border: '1px solid var(--border-ghost)', borderRadius: 12, padding: 16 };

function openCardsTab(tab) {
  try { sessionStorage.setItem(CARDS_VIEW_KEY, tab); } catch { /* lands on the default tab */ }
  window.location.hash = 'cards';
}

export function AlertsPage() {
  const { rows } = useHsa();
  const alerts = useMemo(() => hsaAlerts(rows, new Date()), [rows]);

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 16, padding: '24px 0' }}>
      <div>
        <div style={{ fontFamily: 'var(--font-headline)', fontSize: 24, fontWeight: 700, marginBottom: 4 }}>Alerts</div>
        <div style={{ fontSize: 13, color: 'var(--color-text-tertiary)' }}>Things that need your attention</div>
      </div>
      {alerts.length === 0 ? (
        <div style={{ ...card, display: 'flex', alignItems: 'center', gap: 10, color: 'var(--color-text-secondary)', fontSize: 13 }}>
          <span className="material-symbols-outlined" style={{ color: '#16a34a' }}>check_circle</span>
          No alerts — everything is up to date.
        </div>
      ) : alerts.map(a => (
        <div key={a.id} data-testid="alert" style={{ ...card, display: 'flex', alignItems: 'flex-start', gap: 12, borderLeft: '3px solid #ba1a1a' }}>
          <span className="material-symbols-outlined" style={{ color: '#ba1a1a' }}>error</span>
          <div style={{ flex: 1 }}>
            <div style={{ fontWeight: 700, fontSize: 14, marginBottom: 4 }}>{a.title}</div>
            <div style={{ fontSize: 13, color: 'var(--color-text-secondary)' }}>{a.detail}</div>
          </div>
          {a.source === 'hsa' && (
            <button
              type="button"
              onClick={() => openCardsTab('hsa')}
              style={{ padding: '6px 12px', border: '1px solid var(--border-ghost)', borderRadius: 8, background: 'var(--color-surface)', cursor: 'pointer', fontSize: 12, fontWeight: 600, color: 'var(--color-text-primary)', whiteSpace: 'nowrap' }}
            >
              Go to HSA
            </button>
          )}
        </div>
      ))}
    </div>
  );
}
