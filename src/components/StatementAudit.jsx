import { useRef, useState } from 'react';
import styles from './StatementAudit.module.css';

/* A card statement dropped on its row in the Card Payment Schedule, and the
   report of what didn't tie out between it and the tracker.

   Nothing here is saved: the statement is read in the browser, compared, and
   gone on reload. It never leaves the machine and never touches the synced
   config. */

const money = n => new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' }).format(Math.abs(n));
const whole = n => new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 0 }).format(Math.abs(n));
const mdy = d => (d ? d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' }) : '—');
const md = d => (d ? d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' }) : '—');

// Charges read the way the statement prints them; credits are marked.
function Amount({ value }) {
  if (value > 0) return <span className={styles.credit}>+{money(value)}</span>;
  return <span>{money(value)}</span>;
}

const REASON_LABELS = {
  otherCard: 'Wrong card',
  otherCycle: 'Wrong cycle',
  afterClose: 'Posted after close',
  beforeOpen: 'Previous statement',
  amount: 'Amount differs',
  duplicate: 'Duplicate',
  fee: 'Issuer fee',
  notTracked: 'Not in tracker',
  notBilled: 'Not billed',
  dated: 'Date off',
};
const REASON_TONE = {
  otherCard: 'bad', otherCycle: 'warn', afterClose: 'warn', beforeOpen: 'warn', amount: 'warn',
  duplicate: 'bad', fee: 'warn', notTracked: 'bad', notBilled: 'bad', dated: 'ok',
};

/** The table cell: a drop target until a statement is read, then the verdict. */
export function StatementCell({ entry, result, open, onFile, onToggle }) {
  const inputRef = useRef(null);
  const [dragging, setDragging] = useState(false);
  const stop = e => e.stopPropagation();
  const take = f => { if (f) onFile(f); };

  const pick = (
    <input
      ref={inputRef}
      type="file"
      accept=".pdf,.csv,application/pdf,text/csv"
      className={styles.fileInput}
      onClick={stop}
      onChange={e => { take(e.target.files?.[0]); e.target.value = ''; }}
      data-testid="statement-file"
    />
  );
  const dropProps = {
    onClick: e => { stop(e); inputRef.current?.click(); },
    onDragOver: e => { e.preventDefault(); e.stopPropagation(); setDragging(true); },
    onDragLeave: () => setDragging(false),
    onDrop: e => { e.preventDefault(); e.stopPropagation(); setDragging(false); take(e.dataTransfer.files?.[0]); },
  };

  if (entry?.busy) {
    return <div className={styles.cellBusy}><span className="material-symbols-outlined">hourglass_top</span>Reading…</div>;
  }
  if (!entry?.parsed || !result) {
    return (
      <div
        role="button"
        tabIndex={0}
        className={`${styles.cellDrop} ${dragging ? styles.cellDropActive : ''} ${entry?.error ? styles.cellDropError : ''}`}
        title={entry?.error || 'Drop this card\'s statement (PDF or CSV) here, or click to choose it'}
        {...dropProps}
      >
        {pick}
        <span className="material-symbols-outlined" style={{ fontSize: 15 }}>{entry?.error ? 'error' : 'upload_file'}</span>
        {entry?.error ? 'Couldn\'t read' : 'Drop statement'}
      </div>
    );
  }

  const n = result.findings.filter(f => f.kind !== 'dated').length;
  const gap = -result.audit.totals.difference;
  return (
    <div {...dropProps} onClick={stop} className={dragging ? styles.cellDropActive : undefined}>
      {pick}
      <button
        type="button"
        className={`${styles.cellVerdict} ${n ? styles.cellVerdictWarn : styles.cellVerdictOk}`}
        onClick={e => { stop(e); onToggle(); }}
        title={`${entry.fileName} — click to ${open ? 'hide' : 'show'} the report. Drop another file here to replace it.`}
        data-testid="statement-verdict"
      >
        <span className="material-symbols-outlined" style={{ fontSize: 14 }}>{n ? 'report' : 'verified'}</span>
        {n ? `${n} misallocated` : 'Ties out'}
      </button>
      {Math.abs(gap) >= 0.005 && (
        <div className={styles.cellNote} title="Statement charges minus what the tracker has on this card for the same period">
          billed {whole(gap)} {gap > 0 ? 'more' : 'less'}
        </div>
      )}
    </div>
  );
}

/** The expanded row under a card: every line that didn't tie out, and why. */
export function StatementAuditReport({ cardLabel, entry, result, payment, privacyMode, onPeriod, onClear }) {
  const { parsed, fileName } = entry;
  const { audit, findings, check, period, wrongCard } = result;
  const t = audit.totals;
  const issues = findings.filter(f => f.kind !== 'dated');
  const dated = findings.filter(f => f.kind === 'dated');
  const counts = {};
  for (const f of issues) counts[f.kind] = (counts[f.kind] || 0) + 1;

  return (
    <div className={styles.report} data-testid="statement-report">
      <div className={styles.reportHead}>
        <div>
          <div className={styles.reportTitle}>Statement audit · {cardLabel}</div>
          <div className={styles.fileName}>
            <span className="material-symbols-outlined">description</span>
            {fileName}
            <span className={styles.muted}>· {parsed.lines.length} lines read</span>
          </div>
        </div>
        <div className={styles.reportControls}>
          <label className={styles.field}>
            <span>Period from</span>
            <input type="date" value={entry.from} onChange={e => onPeriod(e.target.value, entry.to)} />
          </label>
          <label className={styles.field}>
            <span>to</span>
            <input type="date" value={entry.to} onChange={e => onPeriod(entry.from, e.target.value)} />
          </label>
          <button type="button" className={styles.linkBtn} onClick={onClear}>Remove statement</button>
        </div>
      </div>

      {privacyMode && (
        <div className={styles.notice}>
          Demo mode is on, so the tracker's amounts are scrambled and won't line up with a real statement. Turn it off to audit.
        </div>
      )}
      {wrongCard && (
        <div className={styles.notice}>
          This statement is for the card ending {parsed.last4}, which looks like <b>{wrongCard}</b> rather than this card.
        </div>
      )}

      <div className={styles.parseNotes}>
        {parsed.period
          ? <span>Billing period read from the statement: {mdy(parsed.period.start)} – {mdy(parsed.period.end)}.</span>
          : <span>The file has no billing period, so the period comes from its dates and the card's closing day — adjust it to the statement's cycle if that's wrong.</span>}
        {check?.ok === true && <span className={styles.okText}> Lines read add up to the statement's own totals.</span>}
        {check?.ok === false && (
          <span className={styles.warnText}> The lines read don't add up to the statement's printed totals, so some lines may not have been recognised.</span>
        )}
      </div>

      <div className={styles.figures}>
        <Figure label="Statement charges" value={money(t.statementCharges)} />
        <Figure label="Tracker, same period" value={money(t.expectedCharges)} />
        <Figure
          label={t.difference === 0 ? 'Balanced' : t.difference < 0 ? 'Billed more than tracked' : 'Billed less than tracked'}
          value={money(t.difference)}
          tone={Math.abs(t.difference) < 0.005 ? 'ok' : 'warn'}
        />
        {payment && (
          <Figure
            label="This statement's payment"
            value={payment.actual != null ? whole(payment.actual) : '—'}
            sub={payment.expected != null ? `Expected ${whole(payment.expected)} · paid ${md(payment.date)}` : `paid ${md(payment.date)}`}
          />
        )}
      </div>

      {issues.length === 0 ? (
        <div className={styles.allClear}>
          <span className="material-symbols-outlined">verified</span>
          Every line on the statement matches a tracked charge on this card, and nothing tracked for this period is missing from it.
        </div>
      ) : (
        <>
          <div className={styles.chips}>
            {Object.entries(counts).map(([k, n]) => (
              <span key={k} className={`${styles.chip} ${styles[`chip_${REASON_TONE[k]}`]}`}>{n} · {REASON_LABELS[k]}</span>
            ))}
          </div>
          <div className={styles.tableWrap}>
            <table className={styles.table}>
              <thead>
                <tr>
                  <th>Date</th>
                  <th>Charge</th>
                  <th>What went wrong</th>
                  <th>Why</th>
                  <th className={styles.num} title="This charge's share of the gap: positive when the statement billed more than the tracker had">Effect</th>
                </tr>
              </thead>
              <tbody>
                {issues.map((f, i) => (
                  <tr key={i} data-kind={f.kind}>
                    <td className={styles.nowrap}>{md(f.date)}</td>
                    <td>
                      {f.description}
                      <div className={styles.muted}>
                        {f.statement && f.ledger ? 'on statement and in tracker' : f.statement ? 'on statement' : 'in tracker'} · <Amount value={f.amount} />
                      </div>
                    </td>
                    <td><span className={`${styles.chip} ${styles[`chip_${REASON_TONE[f.kind]}`]}`}>{REASON_LABELS[f.kind]}</span></td>
                    <td className={styles.why}>{f.reason}</td>
                    <td className={`${styles.num} ${f.billedMore > 0 ? styles.badText : f.billedMore < 0 ? styles.okText : ''}`}>
                      {f.billedMore > 0 ? '+' : f.billedMore < 0 ? '−' : ''}{money(f.billedMore)}
                    </td>
                  </tr>
                ))}
              </tbody>
              <tfoot>
                <tr>
                  <td colSpan={4}>Explains the gap of</td>
                  <td className={styles.num}>{-t.difference > 0 ? '+' : -t.difference < 0 ? '−' : ''}{money(t.difference)}</td>
                </tr>
              </tfoot>
            </table>
          </div>
        </>
      )}

      {(dated.length > 0 || audit.matched.length > 0) && (
        <details className={styles.matched}>
          <summary>
            Matched ({audit.matched.length + dated.length})
            <span className={styles.muted}> — on both sides for the same amount{dated.length ? `; ${dated.length} with dates further apart than usual` : ''}</span>
          </summary>
          <div className={styles.tableWrap}>
            <table className={styles.table}>
              <thead><tr><th>Statement date</th><th>On statement</th><th>In tracker</th><th className={styles.num}>Amount</th></tr></thead>
              <tbody>
                {dated.map((f, i) => (
                  <tr key={`d${i}`}>
                    <td>{md(f.date)}<div className={styles.warnText}>tracker: {f.ledger.date}</div></td>
                    <td>{f.description}</td>
                    <td>{f.ledger.description}</td>
                    <td className={styles.num}><Amount value={f.amount} /></td>
                  </tr>
                ))}
                {audit.matched.map((m, i) => (
                  <tr key={i}>
                    <td>{md(m.statement.date)}{m.dayGap > 0 && <div className={styles.muted}>tracker: {m.ledger.date}</div>}</td>
                    <td>{m.statement.description}</td>
                    <td>{m.ledger.description}</td>
                    <td className={styles.num}><Amount value={m.statement.amount} /></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </details>
      )}
      <div className={styles.footNote}>
        Read in your browser and not saved — it's gone on reload. Period: {mdy(period.start)} – {mdy(period.end)}.
      </div>
    </div>
  );
}

function Figure({ label, value, sub, tone }) {
  return (
    <div className={styles.figure}>
      <div className={`${styles.figureValue} ${tone === 'warn' ? styles.warnText : tone === 'ok' ? styles.okText : ''}`}>{value}</div>
      <div className={styles.figureLabel}>{label}</div>
      {sub && <div className={styles.muted}>{sub}</div>}
    </div>
  );
}
