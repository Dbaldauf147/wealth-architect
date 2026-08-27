import { useState, useMemo, useCallback } from 'react';
import { suggestCategories, LOW_CONFIDENCE } from '../lib/suggest';
import { getCategoryIcon, catColor, catBg } from '../lib/categories';
import { CategorySheet } from './CategorySheet';
import { fmt, fmtRelative } from './format';
import styles from './MobileApp.module.css';

/* Purchases the phone heard about before the sheet did.
 *
 * A bank alert lands seconds after the card is used, days before the row it
 * belongs to. Answering "what was that?" now — while you are still standing in
 * the shop and remember — is a different and far easier question than answering
 * it next week against a line reading "34N7THST FEES BROOKLYN NY".
 *
 * So this sits above the deck rather than inside it. The deck is the backlog;
 * this is the thing that just happened, and it is worth the interruption
 * exactly because it is fresh. Once answered, the choice waits for its
 * transaction and applies itself.
 */
export function AlertsStrip({ alerts, categoryOptions, usage, history, onCategorize, onDismiss }) {
  const [picking, setPicking] = useState(null);

  // Undecided first, because those are the ones asking something of you.
  const { asking, waiting } = useMemo(() => {
    const a = [];
    const w = [];
    for (const alert of alerts || []) {
      if (alert.dismissed || alert.appliedTo) continue;
      (alert.category ? w : a).push(alert);
    }
    return { asking: a, waiting: w };
  }, [alerts]);

  const choose = useCallback((category) => {
    if (picking) onCategorize(picking.id, category);
    setPicking(null);
  }, [picking, onCategorize]);

  if (!asking.length && !waiting.length) return null;

  return (
    <>
      {asking.map(alert => (
        <AlertCard
          key={alert.id}
          alert={alert}
          history={history}
          onPick={cat => onCategorize(alert.id, cat)}
          onMore={() => setPicking(alert)}
          onDismiss={() => onDismiss(alert.id)}
        />
      ))}

      {waiting.length > 0 && (
        <div className={styles.alertWaiting}>
          <span className="material-symbols-outlined" style={{ fontSize: 15 }}>schedule</span>
          {waiting.length} answered, waiting for the bank to post
          {waiting.length === 1 ? ' it' : ' them'}
        </div>
      )}

      {picking && (
        <CategorySheet
          title={picking.merchant || 'What was this?'}
          categories={categoryOptions}
          usage={usage}
          onPick={choose}
          onCreate={choose}
          onClose={() => setPicking(null)}
        />
      )}
    </>
  );
}

function AlertCard({ alert, history, onPick, onMore, onDismiss }) {
  // The merchant as the bank wrote it is all there is to go on — no category,
  // no account, no history of this exact string. Enough for the suggester,
  // which works off merchant words.
  const suggestions = useMemo(() => {
    const probe = {
      description: alert.merchant || alert.raw || '',
      fullDescription: alert.raw || '',
      amount: alert.refund ? alert.amount : -alert.amount,
      date: alert.date,
    };
    return suggestCategories(probe, history, { limit: 3 });
  }, [alert, history]);

  const confident = suggestions.filter(s => s.confidence >= LOW_CONFIDENCE);
  const shown = confident.length ? confident : suggestions.slice(0, 2);

  return (
    <div className={styles.alertCard}>
      <div className={styles.alertHead}>
        <span className={styles.alertBolt}>
          <span className="material-symbols-outlined" style={{ fontSize: 17 }}>bolt</span>
        </span>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div className={styles.alertMerchant}>
            {alert.merchant || 'Purchase'}
          </div>
          <div className={styles.alertMeta}>
            {fmtRelative(alert.receivedAt || alert.date)}
            {alert.card ? ` · card ${alert.card}` : ''}
            {alert.bank ? ` · ${alert.bank}` : ''}
          </div>
        </div>
        <div className={styles.alertAmount}>
          {alert.refund ? '+' : ''}{fmt(alert.refund ? alert.amount : -alert.amount)}
        </div>
      </div>

      {/* The bank's own words, for the times the merchant line is unhelpful. */}
      {alert.raw && alert.raw !== alert.merchant && (
        <div className={styles.alertRaw}>{alert.raw}</div>
      )}

      <div className={styles.alertActions}>
        {shown.map(s => (
          <button
            key={s.category}
            className={styles.alertChip}
            onClick={() => onPick(s.category)}
            style={{ background: catBg(s.category, 0.12), color: catColor(s.category) }}
          >
            <span className="material-symbols-outlined" style={{ fontSize: 15 }}>
              {getCategoryIcon(s.category)}
            </span>
            {s.category}
          </button>
        ))}
        <button className={styles.alertChipPlain} onClick={onMore}>
          <span className="material-symbols-outlined" style={{ fontSize: 15 }}>list</span>
          All
        </button>
        <button className={styles.alertChipPlain} onClick={onDismiss} aria-label="Ignore this alert">
          <span className="material-symbols-outlined" style={{ fontSize: 15 }}>close</span>
        </button>
      </div>
    </div>
  );
}
