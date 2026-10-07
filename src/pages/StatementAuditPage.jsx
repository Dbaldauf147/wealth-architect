import { useMemo, useRef, useState } from 'react';
import { useData } from '../contexts/DataContext';
import {
  parseStatementCsv, parseStatementText, checkAgainstSummary,
  auditStatement, periodOfLines, accountForLast4, parseDate,
} from '../lib/statementAudit';
import styles from './StatementAuditPage.module.css';

/* Upload a card statement, see it beside what the sheet says should be on it.

   Nothing here is saved: the statement is read in the browser, compared, and
   gone on reload. It never leaves the machine and never touches the synced
   config. */

const money = n => new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' }).format(Math.abs(n));
// Charges read the way the statement prints them; credits are marked.
function Amount({ value }) {
  if (value > 0) return <span className={styles.credit}>+{money(value)}</span>;
  return <span>{money(value)}</span>;
}
const mdy = d => (d ? d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' }) : '—');
const iso = d => (d ? `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}` : '');
const ledgerDay = t => parseDate(t.date) || new Date(t.date);
const isCardPayment = t => /^credit card payments?$/i.test(t.category || '');

export function StatementAuditPage() {
  const { transactions, accountNicknames, accountNumbers, statementCloseDays, privacyMode, loading } = useData();
  const [file, setFile] = useState(null);       // { name }
  const [parsed, setParsed] = useState(null);   // parser output
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [chosenAccount, setAccount] = useState(''); // '' = follow the statement
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const [dragging, setDragging] = useState(false);
  const inputRef = useRef(null);

  // Card accounts first (anything paid by a card payment, named like a card,
  // or given a closing day), most recently used first; the rest after.
  const accounts = useMemo(() => {
    const last = new Map();
    const card = new Set(Object.keys(statementCloseDays || {}));
    for (const t of transactions || []) {
      const a = (t.account || '').trim();
      if (!a) continue;
      const d = ledgerDay(t);
      if (!isNaN(d) && (!last.has(a) || d > last.get(a))) last.set(a, d);
      if (isCardPayment(t) || /credit|card|rewards/i.test(a)) card.add(a);
    }
    return [...last.keys()].sort((a, b) =>
      (card.has(b) - card.has(a)) || (last.get(b) - last.get(a)));
  }, [transactions, statementCloseDays]);

  const label = a => {
    const nick = accountNicknames?.[a];
    const num = String(accountNumbers?.[a] || '').slice(-4);
    const base = nick && nick !== a ? `${nick} (${a})` : a;
    return num && !base.includes(num) ? `${base} …${num}` : base;
  };

  async function readFile(f) {
    if (!f) return;
    setError('');
    setBusy(true);
    setParsed(null);
    setFile({ name: f.name });
    try {
      let result;
      if (/\.pdf$/i.test(f.name) || f.type === 'application/pdf') {
        const { pdfToText } = await import('../lib/pdfText');
        result = parseStatementText(await pdfToText(await f.arrayBuffer()));
      } else {
        result = parseStatementCsv(await f.text());
      }
      if (!result.lines.length) {
        setError(result.warnings[0] || 'No transactions could be read from this file.');
        return;
      }
      const period = result.period || periodOfLines(result.lines);
      setParsed(result);
      setFrom(iso(period.start));
      setTo(iso(period.end));
      setAccount('');
    } catch (err) {
      console.error('Statement read failed:', err);
      setError(/password/i.test(err?.name || err?.message || '')
        ? 'This PDF is password-protected. Download an unlocked copy from your card issuer and try again.'
        : `Couldn't read this file: ${err?.message || err}`);
    } finally {
      setBusy(false);
    }
  }

  // Derived rather than set on upload: a statement dropped before the sheet has
  // loaded still lands on its card once the transactions arrive.
  const detectedAccount = parsed ? accountForLast4(parsed.last4, accounts, accountNumbers || {}) : null;
  const account = (chosenAccount && accounts.includes(chosenAccount) ? chosenAccount : '') || detectedAccount || accounts[0] || '';

  const period = useMemo(() => {
    const start = parseDate(from);
    const end = parseDate(to);
    return start && end && start <= end ? { start, end } : null;
  }, [from, to]);

  const audit = useMemo(() => {
    if (!parsed || !period || !account) return null;
    const mine = (transactions || []).filter(t => (t.account || '').trim() === account);
    return auditStatement({ statementLines: parsed.lines, transactions: mine, period });
  }, [parsed, period, account, transactions]);

  const check = useMemo(() => (parsed ? checkAgainstSummary(parsed.lines, parsed.summary) : null), [parsed]);

  function reset() {
    setFile(null); setParsed(null); setError(''); setAccount(''); setFrom(''); setTo('');
    if (inputRef.current) inputRef.current.value = '';
  }

  return (
    <div className={styles.page}>
      <div className={styles.hero}>
        <div className={styles.heroLabel}>Cards</div>
        <h1 className={styles.heroTitle}>Statement Audit</h1>
        <p className={styles.heroSubtitle}>
          Upload a credit card statement (PDF or CSV). Every line on it is checked against the charges
          your tracker has for that card over the same period, so anything billed that you don't recognise,
          anything you expected that wasn't billed, and any charge that came through for a different amount stands out.
        </p>
        {audit && (
          <div className={styles.heroStats}>
            <Stat value={money(audit.totals.statementCharges)} label="Charged on statement" />
            <Stat value={money(audit.totals.expectedCharges)} label="Expected from tracker" />
            <Stat
              value={money(audit.totals.difference)}
              label={audit.totals.difference === 0 ? 'Balanced' : audit.totals.difference < 0 ? 'Billed more than expected' : 'Billed less than expected'}
              tone={audit.totals.difference === 0 ? 'ok' : 'warn'}
            />
          </div>
        )}
      </div>

      {privacyMode && (
        <div className={styles.notice}>
          Demo mode is on, so the tracker's amounts on this page are scrambled and won't line up with a real statement.
          Turn demo mode off to run an audit.
        </div>
      )}

      {!parsed ? (
        <label
          className={`${styles.drop} ${dragging ? styles.dropActive : ''}`}
          onDragOver={e => { e.preventDefault(); setDragging(true); }}
          onDragLeave={() => setDragging(false)}
          onDrop={e => { e.preventDefault(); setDragging(false); readFile(e.dataTransfer.files?.[0]); }}
        >
          <input
            ref={inputRef}
            type="file"
            accept=".pdf,.csv,application/pdf,text/csv"
            className={styles.fileInput}
            onChange={e => readFile(e.target.files?.[0])}
            data-testid="statement-file"
          />
          <span className="material-symbols-outlined" style={{ fontSize: 36 }}>{busy ? 'hourglass_top' : 'upload_file'}</span>
          <div className={styles.dropTitle}>{busy ? `Reading ${file?.name}…` : 'Drop a statement here, or click to choose'}</div>
          <div className={styles.dropHint}>
            PDF statements and CSV activity downloads both work. The file is read in your browser and isn't uploaded or saved.
          </div>
          {loading && <div className={styles.dropHint}>Transactions are still loading…</div>}
        </label>
      ) : (
        <div className={styles.controls}>
          <div className={styles.fileName}>
            <span className="material-symbols-outlined">description</span>
            <span>{file?.name}</span>
            <span className={styles.muted}>· {parsed.lines.length} lines read</span>
            <button type="button" className={styles.linkBtn} onClick={reset}>Choose another file</button>
          </div>
          <div className={styles.controlRow}>
            <label className={styles.field}>
              <span>Card</span>
              <select value={account} onChange={e => setAccount(e.target.value)} data-testid="audit-account">
                {accounts.map(a => <option key={a} value={a}>{label(a)}</option>)}
              </select>
            </label>
            <label className={styles.field}>
              <span>Period from</span>
              <input type="date" value={from} onChange={e => setFrom(e.target.value)} />
            </label>
            <label className={styles.field}>
              <span>to</span>
              <input type="date" value={to} onChange={e => setTo(e.target.value)} />
            </label>
          </div>
          <div className={styles.parseNotes}>
            {parsed.period
              ? <span>Billing period read from the statement: {mdy(parsed.period.start)} – {mdy(parsed.period.end)}.</span>
              : <span>The file has no billing period, so the period is the span of its transactions — adjust it to the statement's cycle if needed.</span>}
            {parsed.last4 && accounts.length > 0 && <span> Card ending {parsed.last4}{detectedAccount ? '' : ' — no tracked account matches it, so pick the card above'}.</span>}
            {check?.ok === true && <span className={styles.okText}> Lines read add up to the statement's own totals.</span>}
            {check?.ok === false && (
              <span className={styles.warnText}>
                {' '}The lines read don't add up to the statement's printed totals
                {check.printedCharges != null && ` (charges ${money(check.charged)} read vs ${money(check.printedCharges)} printed`}
                {check.printedCredits != null && `${check.printedCharges != null ? ', ' : ' ('}credits ${money(check.credited)} vs ${money(check.printedCredits)}`}
                ) — some lines may not have been recognised.
              </span>
            )}
          </div>
        </div>
      )}

      {error && <div className={styles.error} role="alert">{error}</div>}
      {parsed && !period && <div className={styles.error}>Pick a valid period: the start has to be on or before the end.</div>}

      {audit && (
        <>
          <div className={styles.tiles}>
            <Tile n={audit.differs.length} label="Different amount" tone="warn" />
            <Tile n={audit.missing.length} label="On statement, not tracked" tone="bad" />
            <Tile n={audit.unexpected.length} label="Tracked, not on statement" tone="warn" />
            <Tile n={audit.matched.length} label="Matched" tone="ok" />
          </div>

          {audit.differs.length + audit.missing.length + audit.unexpected.length === 0 && (
            <div className={styles.allClear}>
              <span className="material-symbols-outlined">verified</span>
              Every line on the statement matches a tracked transaction, and nothing tracked for this period is missing from it.
            </div>
          )}

          {audit.differs.length > 0 && (
            <Section title="Charged a different amount" hint="Same merchant within a few days, but the amounts differ — a tip added later, a currency conversion, or a partial refund.">
              <table className={styles.table}>
                <thead><tr><th>Date</th><th>On statement</th><th>In tracker</th><th className={styles.num}>Statement</th><th className={styles.num}>Tracker</th><th className={styles.num}>Difference</th></tr></thead>
                <tbody>
                  {audit.differs.map((m, i) => (
                    <tr key={i}>
                      <td>{mdy(m.statement.date)}</td>
                      <td>{m.statement.description}</td>
                      <td>{m.ledger.description}<div className={styles.muted}>{m.ledger.date}</div></td>
                      <td className={styles.num}><Amount value={m.statement.amount} /></td>
                      <td className={styles.num}><Amount value={m.ledger.amount} /></td>
                      <td className={`${styles.num} ${styles.warnText}`}>{m.delta < 0 ? 'charged ' : 'credited '}{money(m.delta)} more</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </Section>
          )}

          {audit.missing.length > 0 && (
            <Section title="On the statement, not in your tracker" hint="Billed by the issuer with no matching transaction in the sheet. Either the sync missed it or it's a charge you didn't expect.">
              <table className={styles.table}>
                <thead><tr><th>Date</th><th>Description</th><th className={styles.num}>Amount</th></tr></thead>
                <tbody>
                  {audit.missing.map((s, i) => (
                    <tr key={i}>
                      <td>{mdy(s.date)}</td>
                      <td>{s.description}</td>
                      <td className={styles.num}><Amount value={s.amount} /></td>
                    </tr>
                  ))}
                </tbody>
                <tfoot><tr><td colSpan={2}>Total</td><td className={styles.num}><Amount value={audit.missing.reduce((s, l) => s + l.amount, 0)} /></td></tr></tfoot>
              </table>
            </Section>
          )}

          {audit.unexpected.length > 0 && (
            <Section title="In your tracker, not on the statement" hint="The sheet has these on this card in this period, but the statement doesn't. Often a charge that posted after the close and lands on the next statement — or one that was reversed.">
              <table className={styles.table}>
                <thead><tr><th>Date</th><th>Description</th><th>Category</th><th className={styles.num}>Amount</th></tr></thead>
                <tbody>
                  {audit.unexpected.map((t, i) => (
                    <tr key={t.transactionId || i}>
                      <td>{mdy(ledgerDay(t))}</td>
                      <td>{t.description}</td>
                      <td className={styles.muted}>{t.category || '—'}</td>
                      <td className={styles.num}><Amount value={Number(t.amount)} /></td>
                    </tr>
                  ))}
                </tbody>
                <tfoot><tr><td colSpan={3}>Total</td><td className={styles.num}><Amount value={audit.unexpected.reduce((s, t) => s + Number(t.amount), 0)} /></td></tr></tfoot>
              </table>
            </Section>
          )}

          {audit.matched.length > 0 && (
            <details className={styles.section}>
              <summary className={styles.sectionSummary}>
                <span className={styles.sectionTitle}>Matched ({audit.matched.length})</span>
                <span className={styles.muted}> — same amount within 4 days</span>
              </summary>
              <table className={styles.table}>
                <thead><tr><th>Statement date</th><th>On statement</th><th>In tracker</th><th className={styles.num}>Amount</th></tr></thead>
                <tbody>
                  {audit.matched.map((m, i) => (
                    <tr key={i}>
                      <td>{mdy(m.statement.date)}{m.dayGap > 0 && <div className={styles.muted}>tracker: {m.ledger.date}</div>}</td>
                      <td>{m.statement.description}</td>
                      <td>{m.ledger.description}</td>
                      <td className={styles.num}><Amount value={m.statement.amount} /></td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </details>
          )}
        </>
      )}
    </div>
  );
}

function Stat({ value, label, tone }) {
  return (
    <div>
      <div className={`${styles.heroStatValue} ${tone === 'warn' ? styles.heroWarn : ''}`}>{value}</div>
      <div className={styles.heroStatLabel}>{label}</div>
    </div>
  );
}

function Tile({ n, label, tone }) {
  return (
    <div className={`${styles.tile} ${n > 0 ? styles[`tile_${tone}`] : ''}`} data-testid={`tile-${label}`}>
      <div className={styles.tileValue}>{n}</div>
      <div className={styles.tileLabel}>{label}</div>
    </div>
  );
}

function Section({ title, hint, children }) {
  return (
    <section className={styles.section}>
      <div className={styles.sectionTitle}>{title}</div>
      <div className={styles.sectionHint}>{hint}</div>
      <div className={styles.tableWrap}>{children}</div>
    </section>
  );
}
