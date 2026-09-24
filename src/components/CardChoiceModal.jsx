import { useEffect } from 'react';
import {
  CARD_LABELS, CARD_COLORS, BOFA_CHOICE, POINT_VALUE_CENTS, explainCardChoice,
} from '../lib/cardRewards';

/* "Was this the right card?" — opened by double-clicking a transaction. The
   reasoning comes from explainCardChoice, the same function behind the
   Suboptimal Card Usage table, so the two never disagree. */

function money(n) {
  return new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(n || 0);
}

function longDate(s) {
  const d = new Date(s);
  if (!s || isNaN(d)) return s || '';
  return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
}

// Mirrors findSuboptimalCharges' default: smaller gaps aren't flagged.
const MIN_FLAGGED = 0.25;

function CardName({ k }) {
  return (
    <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6, whiteSpace: 'nowrap' }}>
      <span style={{ width: 8, height: 8, borderRadius: 2, background: CARD_COLORS[k], flexShrink: 0 }} />
      {CARD_LABELS[k]}
    </span>
  );
}

function verdictBanner(x) {
  const used = x.usedKey && CARD_LABELS[x.usedKey];
  switch (x.verdict) {
    case 'best': {
      const tiedWith = x.ranking.filter(r => r.best && r.key !== x.usedKey);
      return {
        tone: 'good', icon: 'check_circle',
        title: 'Right card',
        body: tiedWith.length
          ? `${used} ties for the best rate on ${x.categoryLabel} (${x.usedRate}% back) — no other card would have earned more.`
          : `${used} pays the most on ${x.categoryLabel}: ${x.usedRate}% back vs. ${x.ranking[1].rate}% on the next-best card.`,
      };
    }
    case 'suboptimal':
      return {
        tone: 'bad', icon: 'error',
        title: 'Not the best card',
        body: `${CARD_LABELS[x.bestKey]} pays ${x.bestRate}% on ${x.categoryLabel}, vs. ${x.usedRate}% on ${used}. Swiping it would have earned ${money(x.missed)} more.`
          + (x.missed < MIN_FLAGGED ? ' That\'s under 25¢, so it isn\'t listed in Suboptimal Card Usage.' : ''),
      };
    case 'unknownCard':
      return {
        tone: 'neutral', icon: 'help',
        title: 'Card not identified',
        body: 'This account isn\'t mapped to one of your cards, so there\'s no verdict. Map it under "Unmapped card accounts" on the Card Promotions tab. Here\'s what each card would have earned:',
      };
    case 'ignored':
      return {
        tone: 'neutral', icon: 'visibility_off',
        title: 'Account ignored',
        body: 'This account is set to "Ignore" on the Card Promotions tab, so its charges aren\'t scored. For reference, here\'s what each card would have earned:',
      };
    case 'excluded':
      return {
        tone: 'neutral', icon: 'block',
        title: 'Not a rewards decision',
        body: `This looks like ${x.excludedReason}, which isn't something you'd choose a card for — so it isn't scored.`,
      };
    default:
      return {
        tone: 'neutral', icon: 'south_west',
        title: 'Not a charge',
        body: 'This is money coming in (a refund, credit or deposit), so there was no card to choose.',
      };
  }
}

const TONES = {
  good: { fg: '#16a34a', bg: 'rgba(22, 163, 74, 0.08)' },
  bad: { fg: '#ba1a1a', bg: 'rgba(186, 26, 26, 0.07)' },
  neutral: { fg: 'var(--color-text-secondary)', bg: 'var(--color-surface-alt)' },
};

/**
 * @param txn         the transaction
 * @param usedKey     card key the account maps to, null if unmapped, or 'ignore'
 * @param accountName how to show the account (nickname/group already resolved)
 * @param onClose
 */
export default function CardChoiceModal({ txn, usedKey, accountName, onClose }) {
  useEffect(() => {
    const onKey = e => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  if (!txn) return null;
  const x = explainCardChoice(txn, usedKey);
  const banner = verdictBanner(x);
  const tone = TONES[banner.tone];
  const showRanking = x.verdict !== 'excluded' && x.verdict !== 'notACharge';

  const th = { padding: '7px 10px', textAlign: 'left', fontSize: 10.5, fontWeight: 700, letterSpacing: '0.06em', textTransform: 'uppercase', color: 'var(--color-text-tertiary)', borderBottom: '1px solid var(--border-ghost)', whiteSpace: 'nowrap' };
  const td = { padding: '8px 10px', fontSize: 12.5, borderBottom: '1px solid var(--border-ghost)', verticalAlign: 'middle' };

  return (
    <div
      onMouseDown={e => { if (e.target === e.currentTarget) onClose(); }}
      style={{ position: 'fixed', inset: 0, background: 'rgba(15, 23, 42, 0.45)', zIndex: 1000, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 16 }}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="card-choice-title"
        data-testid="card-choice-modal"
        style={{ background: 'var(--color-surface)', borderRadius: 'var(--radius-xl)', boxShadow: 'var(--shadow-lg)', width: 'min(560px, 100%)', maxHeight: 'calc(100vh - 32px)', overflowY: 'auto', padding: 20 }}
      >
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: 12, marginBottom: 14 }}>
          <div style={{ minWidth: 0 }}>
            <div style={{ fontSize: 11, fontWeight: 700, letterSpacing: '0.06em', textTransform: 'uppercase', color: 'var(--color-text-tertiary)', marginBottom: 2 }}>
              Was this the right card?
            </div>
            <div id="card-choice-title" style={{ fontFamily: 'var(--font-headline)', fontSize: 17, fontWeight: 700, overflowWrap: 'anywhere' }}>
              {txn.description || '(no merchant)'}
            </div>
            <div style={{ fontSize: 12, color: 'var(--color-text-tertiary)', marginTop: 2 }}>
              {longDate(txn.date)} · {money(x.spend)} · {accountName || txn.account || 'Unknown account'}
            </div>
          </div>
          <button
            onClick={onClose}
            aria-label="Close"
            style={{ background: 'none', border: 'none', cursor: 'pointer', color: 'var(--color-text-tertiary)', padding: 4, lineHeight: 0 }}
          >
            <span className="material-symbols-outlined">close</span>
          </button>
        </div>

        <div data-testid="card-choice-verdict" style={{ display: 'flex', gap: 10, background: tone.bg, borderRadius: 'var(--radius-lg)', padding: '10px 12px', marginBottom: 16 }}>
          <span className="material-symbols-outlined" style={{ color: tone.fg, fontSize: 20 }}>{banner.icon}</span>
          <div>
            <div style={{ fontWeight: 700, color: tone.fg, fontSize: 13.5, marginBottom: 2 }}>{banner.title}</div>
            <div style={{ fontSize: 12.5, lineHeight: 1.5 }}>{banner.body}</div>
          </div>
        </div>

        {showRanking && (
          <>
            <div style={{ fontSize: 12.5, marginBottom: 10, lineHeight: 1.5 }}>
              <strong>Why it earns as {x.categoryLabel}:</strong>{' '}
              {x.matched
                ? <>the merchant / category text contains “<span style={{ fontWeight: 600 }}>{x.matched}</span>”.</>
                : <>nothing matched a bonus category, so every card pays its base rate.</>}
            </div>
            <table style={{ width: '100%', borderCollapse: 'collapse' }}>
              <thead>
                <tr>
                  <th style={th}>Card</th>
                  <th style={th}>Earn rate</th>
                  <th style={{ ...th, textAlign: 'right' }}>Effective</th>
                  <th style={{ ...th, textAlign: 'right' }}>On this charge</th>
                </tr>
              </thead>
              <tbody>
                {x.ranking.map(r => {
                  const isUsed = r.key === x.usedKey;
                  return (
                    <tr key={r.key} style={{ background: isUsed ? 'var(--color-surface-alt)' : undefined }}>
                      <td style={{ ...td, fontWeight: isUsed || r.best ? 600 : 400 }}>
                        <CardName k={r.key} />
                        {isUsed && <span style={{ marginLeft: 6, fontSize: 10.5, fontWeight: 700, color: 'var(--color-text-tertiary)', textTransform: 'uppercase', letterSpacing: '0.04em' }}>used</span>}
                        {r.best && <span style={{ marginLeft: 6, fontSize: 10.5, fontWeight: 700, color: '#16a34a', textTransform: 'uppercase', letterSpacing: '0.04em' }}>best</span>}
                      </td>
                      <td style={{ ...td, color: 'var(--color-text-secondary)' }}>{r.display}</td>
                      <td style={{ ...td, textAlign: 'right', fontVariantNumeric: 'tabular-nums', fontWeight: r.best ? 700 : 400, color: r.best ? '#16a34a' : undefined }}>{r.rate}%</td>
                      <td style={{ ...td, textAlign: 'right', fontVariantNumeric: 'tabular-nums' }}>{money(r.earned)}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </>
        )}

        <div style={{ fontSize: 11, color: 'var(--color-text-tertiary)', marginTop: 14, lineHeight: 1.5 }}>
          Effective rates value Chase points at {POINT_VALUE_CENTS}¢ and assume BofA's 3% choice category is {BOFA_CHOICE} — the same rate table as Card Promotions.
        </div>
      </div>
    </div>
  );
}
