import { useMemo, useState } from 'react';
import { loanLedger, interestPaidSeries, linkedLoanTransactions } from '../lib/loanInterest';
import styles from './ShortTermLoanPage.module.css';

/* "Loans & payments": every amount borrowed — the original loan and any new
   loans taken out since — and every payment toward the balance, with what
   was owed after each. Interest payments stay on the overview's log.
   Transactions subcategorized "Loan Taken" or "Loan Payment" show up here on
   their own (see linkedLoanTransactions) and can be unlinked. */

const money = n => new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(n || 0);
function longDate(iso) {
  const [y, m, d] = (iso || '').split('-').map(Number);
  return y && m && d ? new Date(y, m - 1, d).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' }) : (iso || '—');
}
const todayISO = () => {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
};

const TYPE = {
  loan: { label: 'New loan', icon: 'add_card' },
  payment: { label: 'Payment', icon: 'payments' },
};

export function LoanLedger({ loan, transactions, readOnly, onAdd, onRemove, onUnlink, onEditLoan }) {
  const { rows, borrowed, repaid, owed } = useMemo(() => loanLedger(loan), [loan]);
  const linked = useMemo(() => linkedLoanTransactions({ transactions, loan }), [transactions, loan]);
  const linkedCount = rows.filter(r => r.linked).length;
  const [showUnlinked, setShowUnlinked] = useState(false);
  const interestPaid = useMemo(() => interestPaidSeries(loan).reduce((s, d) => s + d.amount, 0), [loan]);
  const newLoans = rows.filter(r => r.type === 'loan' && !r.original).length;
  const payments = rows.filter(r => r.type === 'payment').length;

  const [type, setType] = useState('payment');
  const [date, setDate] = useState(todayISO());
  const [amount, setAmount] = useState('');
  const [label, setLabel] = useState('');
  const [note, setNote] = useState('');

  function submit(e) {
    e.preventDefault();
    if (!(Number(amount) > 0)) return;
    onAdd({ type, date: date || todayISO(), amount, label, note });
    setAmount(''); setLabel(''); setNote(''); setDate(todayISO());
  }

  const newestFirst = [...rows].reverse();

  return (
    <>
      <div className={styles.statGrid}>
        <div className={styles.statCard}>
          <div className={styles.statLabel}>Total borrowed</div>
          <div className={styles.statValue}>{money(borrowed)}</div>
          <div className={styles.statSub}>original{newLoans ? ` + ${newLoans} new loan${newLoans === 1 ? '' : 's'}` : ' loan'}</div>
        </div>
        <div className={styles.statCard}>
          <div className={styles.statLabel}>Paid toward loan</div>
          <div className={styles.statValue}>{money(repaid)}</div>
          <div className={styles.statSub}>{payments} payment{payments === 1 ? '' : 's'}</div>
        </div>
        <div className={styles.statCard}>
          <div className={styles.statLabel}>Still owed</div>
          <div className={styles.statValue}>{money(owed)}</div>
          <div className={styles.statSub}>borrowed − paid</div>
        </div>
        <div className={styles.statCard}>
          <div className={styles.statLabel}>Interest paid</div>
          <div className={styles.statValue}>{money(interestPaid)}</div>
          <div className={styles.statSub}>on top of the above</div>
        </div>
      </div>

      <form className={styles.card} onSubmit={submit} data-testid="ledger-form">
        <div className={styles.cardTitle}>Add a loan or payment</div>
        <div className={styles.typeToggle} role="radiogroup" aria-label="Entry type">
          {Object.entries(TYPE).map(([id, t]) => (
            <button key={id} type="button" role="radio" aria-checked={type === id}
              className={`${styles.typeOption} ${type === id ? styles.typeOptionActive : ''}`} onClick={() => setType(id)}>
              <span className="material-symbols-outlined" style={{ fontSize: 17 }}>{t.icon}</span>
              {id === 'loan' ? 'New loan taken out' : 'Payment toward loan'}
            </button>
          ))}
        </div>
        <div className={styles.ledgerFormGrid}>
          <label className={styles.field}>
            <span className={styles.fieldLabel}>Date</span>
            <input className={styles.input} type="date" value={date} onChange={e => setDate(e.target.value)} required />
          </label>
          <label className={styles.field}>
            <span className={styles.fieldLabel}>Amount</span>
            <input className={styles.input} type="number" min="0" step="0.01" value={amount} onChange={e => setAmount(e.target.value)} placeholder="0.00" required />
          </label>
          <label className={styles.field}>
            <span className={styles.fieldLabel}>{type === 'loan' ? 'Loan / lender' : 'Paid from'} <span className={styles.optional}>(optional)</span></span>
            <input className={styles.input} value={label} onChange={e => setLabel(e.target.value)} placeholder={type === 'loan' ? 'e.g. Second draw' : 'e.g. Checking'} />
          </label>
          <label className={styles.field}>
            <span className={styles.fieldLabel}>Note <span className={styles.optional}>(optional)</span></span>
            <input className={styles.input} value={note} onChange={e => setNote(e.target.value)} placeholder="Terms, reference, etc." />
          </label>
          <button type="submit" className={styles.btnPrimary} disabled={readOnly}>
            {type === 'loan' ? 'Add loan' : 'Add payment'}
          </button>
        </div>
      </form>

      <div className={styles.card} data-testid="ledger-table">
        <div className={styles.cardTitle} style={{ marginBottom: 4 }}>Loans &amp; payments</div>
        <div className={styles.queueSub} data-testid="ledger-link-note">
          Transactions subcategorized <b>Loan Taken</b> or <b>Loan Payment</b> are added here automatically
          {linkedCount ? ` — ${linkedCount} linked` : ''}{linked.original ? ', plus the one behind the original loan' : ''}.
          {linked.earlierCount > 0 && ` ${linked.earlierCount} dated before ${longDate(loan.startDate)} ${linked.earlierCount === 1 ? "isn't" : "aren't"} counted.`}
        </div>
        {rows.length === 0 ? (
          <div className={styles.emptyRow}>Nothing here yet — add the loans you&apos;ve taken out and what you&apos;ve paid toward them.</div>
        ) : (
          <div className={styles.tableScroll}>
            <table className={styles.table}>
              <thead>
                <tr>
                  <th>Date</th>
                  <th>Type</th>
                  <th>Description</th>
                  <th className={styles.numCol}>Amount</th>
                  <th className={styles.numCol}>Owed after</th>
                  <th aria-label="Actions" />
                </tr>
              </thead>
              <tbody>
                {newestFirst.map(r => (
                  <tr key={r.id}>
                    <td className={styles.nowrap}>{longDate(r.date)}</td>
                    <td>
                      <span className={`${styles.typeChip} ${r.type === 'loan' ? styles.typeChipLoan : styles.typeChipPayment}`}>
                        <span className="material-symbols-outlined" style={{ fontSize: 15 }}>{TYPE[r.type].icon}</span>
                        {r.original ? 'Original loan' : TYPE[r.type].label}
                      </span>
                    </td>
                    <td className={styles.noteCell}>
                      {(r.linked || (r.original && linked.original)) && (
                        <span className="material-symbols-outlined" title="Linked from a transaction by its subcategory"
                          style={{ fontSize: 15, verticalAlign: -3, marginRight: 4, color: 'var(--color-text-tertiary)' }}>link</span>
                      )}
                      {[r.original ? (loan.lender || r.label) : r.label, r.note].filter(Boolean).join(' · ') || '—'}
                    </td>
                    <td className={styles.numCol}>{r.type === 'loan' ? '+' : '−'}{money(r.amount)}</td>
                    <td className={styles.numCol}>{money(r.balance)}</td>
                    <td className={styles.actionCol}>
                      {r.original ? (
                        <button className={styles.iconBtn} title="Edit the original loan" aria-label="Edit the original loan" onClick={onEditLoan}>
                          <span className="material-symbols-outlined" style={{ fontSize: 18 }}>edit</span>
                        </button>
                      ) : r.linked ? (
                        <button className={styles.iconBtn} title="Unlink this transaction from the loan" aria-label={`Unlink ${r.note || TYPE[r.type].label.toLowerCase()} on ${longDate(r.date)}`}
                          disabled={readOnly} onClick={() => onUnlink([r.transactionId], true)}>
                          <span className="material-symbols-outlined" style={{ fontSize: 18 }}>link_off</span>
                        </button>
                      ) : (
                        <button className={styles.iconBtn} title="Delete" aria-label={`Delete ${TYPE[r.type].label.toLowerCase()} on ${longDate(r.date)}`}
                          disabled={readOnly} onClick={() => onRemove(r.id)}>
                          <span className="material-symbols-outlined" style={{ fontSize: 18 }}>delete</span>
                        </button>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
              <tfoot>
                <tr>
                  <td className={styles.totalLabel} colSpan={3}>Borrowed {money(borrowed)} · paid {money(repaid)}</td>
                  <td className={styles.numCol} />
                  <td className={styles.numCol}><strong>{money(owed)}</strong></td>
                  <td />
                </tr>
              </tfoot>
            </table>
          </div>
        )}

        {linked.unlinked.length > 0 && (
          <div className={styles.ignoredBlock} data-testid="ledger-unlinked">
            <button type="button" className={styles.linkBtn} onClick={() => setShowUnlinked(v => !v)}>
              <span className="material-symbols-outlined" style={{ fontSize: 17 }}>{showUnlinked ? 'expand_less' : 'expand_more'}</span>
              Unlinked ({linked.unlinked.length})
            </button>
            {showUnlinked && (
              <div className={styles.tableScroll}>
                <table className={styles.table}>
                  <tbody>
                    {linked.unlinked.map(r => (
                      <tr key={r.id} className={styles.ignoredRow}>
                        <td className={styles.nowrap}>{longDate(r.date)}</td>
                        <td>{TYPE[r.type].label}</td>
                        <td>{r.note || '—'}</td>
                        <td className={styles.noteCell}>{r.label || '—'}</td>
                        <td className={styles.numCol}>{money(r.amount)}</td>
                        <td className={styles.rowActions}>
                          <button type="button" className={styles.linkBtn} disabled={readOnly} onClick={() => onUnlink([r.transactionId], false)}>Link again</button>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </div>
        )}
      </div>
    </>
  );
}
