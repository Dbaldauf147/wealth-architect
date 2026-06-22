import { useMemo, useState } from 'react';
import { useData, useDataActions } from '../contexts/DataContext';
import styles from './ShortTermLoanPage.module.css';

// Currency with cents — interest amounts are small, so cents matter.
function fmt(n) {
  if (n == null || !Number.isFinite(n)) return '—';
  return new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(n);
}

const todayISO = () => new Date().toISOString().slice(0, 10);

// Parse a 'YYYY-MM-DD' string as a *local* midnight Date so day math doesn't
// drift across time zones.
function parseLocalDate(iso) {
  if (!iso) return null;
  const [y, m, d] = iso.split('-').map(Number);
  if (!y || !m || !d) return null;
  const dt = new Date(y, m - 1, d);
  return isNaN(dt) ? null : dt;
}

function daysBetween(startISO, endDate) {
  const start = parseLocalDate(startISO);
  if (!start) return 0;
  const end = new Date(endDate.getFullYear(), endDate.getMonth(), endDate.getDate());
  return Math.max(0, Math.round((end - start) / 86400000));
}

function fmtDate(iso) {
  const d = parseLocalDate(iso);
  return d ? d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' }) : iso;
}

// Daily interest in dollars from the loan's terms.
function dailyInterestOf(loan) {
  if (!loan) return 0;
  const principal = Number(loan.principal) || 0;
  const ratePct = Number(loan.rate) || 0;
  const dailyRate = loan.rateType === 'apr' ? ratePct / 100 / 365 : ratePct / 100;
  return principal * dailyRate;
}

export function ShortTermLoanPage() {
  const { shortTermLoan } = useData();
  const { saveLoanDetails, clearLoan, addLoanPayment, removeLoanPayment } = useDataActions();

  const loan = shortTermLoan || null;
  const [editing, setEditing] = useState(false);

  // Loan-details form state
  const [form, setForm] = useState(() => ({
    name: '', lender: '', principal: '', rate: '', rateType: 'daily', startDate: todayISO(), note: '',
  }));

  // Payment-entry form state
  const [payDate, setPayDate] = useState(todayISO());
  const [payAmount, setPayAmount] = useState('');
  const [payNote, setPayNote] = useState('');

  function openEditor() {
    if (loan) {
      setForm({
        name: loan.name || '',
        lender: loan.lender || '',
        principal: loan.principal != null ? String(loan.principal) : '',
        rate: loan.rate != null ? String(loan.rate) : '',
        rateType: loan.rateType === 'apr' ? 'apr' : 'daily',
        startDate: loan.startDate || todayISO(),
        note: loan.note || '',
      });
    } else {
      setForm({ name: '', lender: '', principal: '', rate: '', rateType: 'daily', startDate: todayISO(), note: '' });
    }
    setEditing(true);
  }

  function submitLoan(e) {
    e.preventDefault();
    if (!(Number(form.principal) > 0)) return;
    saveLoanDetails({
      name: form.name.trim(),
      lender: form.lender.trim(),
      principal: form.principal,
      rate: form.rate,
      rateType: form.rateType,
      startDate: form.startDate || todayISO(),
      note: form.note.trim(),
    });
    setEditing(false);
  }

  function submitPayment(e) {
    e.preventDefault();
    if (!(Number(payAmount) > 0)) return;
    addLoanPayment({ date: payDate || todayISO(), amount: payAmount, note: payNote });
    setPayAmount('');
    setPayNote('');
    setPayDate(todayISO());
  }

  function handleClear() {
    if (window.confirm('Remove this loan and its entire payment log? This cannot be undone.')) {
      clearLoan();
      setEditing(false);
    }
  }

  const stats = useMemo(() => {
    if (!loan) return null;
    const daily = dailyInterestOf(loan);
    const days = daysBetween(loan.startDate, new Date());
    const accrued = daily * days;
    const payments = Array.isArray(loan.payments) ? loan.payments : [];
    const paid = payments.reduce((s, p) => s + (Number(p.amount) || 0), 0);
    const outstanding = accrued - paid;
    const effDailyRate = (Number(loan.principal) || 0) > 0 ? daily / (Number(loan.principal) || 1) : 0;
    return { daily, days, accrued, paid, outstanding, effDailyRate };
  }, [loan]);

  const sortedPayments = useMemo(() => {
    const payments = (loan && Array.isArray(loan.payments)) ? loan.payments : [];
    return [...payments].sort((a, b) => (b.date || '').localeCompare(a.date || '') || (b.id || '').localeCompare(a.id || ''));
  }, [loan]);

  // ── Empty state / editor ───────────────────────────────────────────────
  if (!loan || editing) {
    return (
      <div className={styles.page}>
        <header className={styles.pageHeader}>
          <div>
            <h1 className={styles.pageTitle}>Short-Term Loan</h1>
            <p className={styles.pageSubtitle}>Track daily interest on a short-term loan.</p>
          </div>
        </header>

        <form className={styles.card} onSubmit={submitLoan}>
          <div className={styles.cardTitle}>{loan ? 'Edit loan' : 'Set up your loan'}</div>
          <div className={styles.formGrid}>
            <label className={styles.field}>
              <span className={styles.fieldLabel}>Name <span className={styles.optional}>(optional)</span></span>
              <input className={styles.input} value={form.name} onChange={e => setForm(f => ({ ...f, name: e.target.value }))} placeholder="e.g. Bridge loan" />
            </label>
            <label className={styles.field}>
              <span className={styles.fieldLabel}>Lender <span className={styles.optional}>(optional)</span></span>
              <input className={styles.input} value={form.lender} onChange={e => setForm(f => ({ ...f, lender: e.target.value }))} placeholder="e.g. ABC Capital" />
            </label>
            <label className={styles.field}>
              <span className={styles.fieldLabel}>Principal</span>
              <input className={styles.input} type="number" min="0" step="0.01" value={form.principal} onChange={e => setForm(f => ({ ...f, principal: e.target.value }))} placeholder="10000" required />
            </label>
            <label className={styles.field}>
              <span className={styles.fieldLabel}>Interest rate (%)</span>
              <input className={styles.input} type="number" min="0" step="0.0001" value={form.rate} onChange={e => setForm(f => ({ ...f, rate: e.target.value }))} placeholder="1" required />
            </label>
            <label className={styles.field}>
              <span className={styles.fieldLabel}>Rate basis</span>
              <select className={styles.input} value={form.rateType} onChange={e => setForm(f => ({ ...f, rateType: e.target.value }))}>
                <option value="daily">Per day</option>
                <option value="apr">Annual (APR ÷ 365)</option>
              </select>
            </label>
            <label className={styles.field}>
              <span className={styles.fieldLabel}>Start date</span>
              <input className={styles.input} type="date" value={form.startDate} onChange={e => setForm(f => ({ ...f, startDate: e.target.value }))} required />
            </label>
            <label className={`${styles.field} ${styles.fieldWide}`}>
              <span className={styles.fieldLabel}>Note <span className={styles.optional}>(optional)</span></span>
              <input className={styles.input} value={form.note} onChange={e => setForm(f => ({ ...f, note: e.target.value }))} placeholder="Terms, due date, etc." />
            </label>
          </div>
          {Number(form.principal) > 0 && Number(form.rate) > 0 && (
            <div className={styles.formHint}>
              Daily interest ≈ <strong>{fmt(dailyInterestOf({ principal: form.principal, rate: form.rate, rateType: form.rateType }))}</strong>
              {form.rateType === 'apr' ? ' (APR ÷ 365)' : ' per day'}
            </div>
          )}
          <div className={styles.formActions}>
            <button type="submit" className={styles.btnPrimary}>{loan ? 'Save changes' : 'Save loan'}</button>
            {loan && <button type="button" className={styles.btnGhost} onClick={() => setEditing(false)}>Cancel</button>}
            {loan && <button type="button" className={styles.btnDanger} onClick={handleClear}>Remove loan</button>}
          </div>
        </form>
      </div>
    );
  }

  // ── Active loan view ────────────────────────────────────────────────────
  const behind = stats.outstanding > 0.005;
  const settled = Math.abs(stats.outstanding) <= 0.005;

  return (
    <div className={styles.page}>
      <header className={styles.pageHeader}>
        <div>
          <h1 className={styles.pageTitle}>Short-Term Loan</h1>
          <p className={styles.pageSubtitle}>
            {loan.name || 'Loan'}{loan.lender ? ` · ${loan.lender}` : ''} · started {fmtDate(loan.startDate)}
          </p>
        </div>
        <button className={styles.btnGhost} onClick={openEditor}>
          <span className="material-symbols-outlined" style={{ fontSize: 18 }}>edit</span>
          Edit loan
        </button>
      </header>

      {/* Headline: daily interest */}
      <div className={styles.heroCard}>
        <div className={styles.heroLabel}>Daily interest</div>
        <div className={styles.heroValue}>{fmt(stats.daily)}<span className={styles.heroUnit}>/day</span></div>
        <div className={styles.heroMeta}>
          {fmt(loan.principal)} principal · {(stats.effDailyRate * 100).toFixed(4)}% per day
          {loan.rateType === 'apr' ? ` (${Number(loan.rate)}% APR)` : ''}
        </div>
      </div>

      {/* Stats grid */}
      <div className={styles.statGrid}>
        <div className={styles.statCard}>
          <div className={styles.statLabel}>Days elapsed</div>
          <div className={styles.statValue}>{stats.days}</div>
          <div className={styles.statSub}>since {fmtDate(loan.startDate)}</div>
        </div>
        <div className={styles.statCard}>
          <div className={styles.statLabel}>Interest accrued</div>
          <div className={styles.statValue}>{fmt(stats.accrued)}</div>
          <div className={styles.statSub}>{fmt(stats.daily)} × {stats.days} days</div>
        </div>
        <div className={styles.statCard}>
          <div className={styles.statLabel}>Interest paid</div>
          <div className={styles.statValue}>{fmt(stats.paid)}</div>
          <div className={styles.statSub}>{sortedPayments.length} payment{sortedPayments.length === 1 ? '' : 's'}</div>
        </div>
        <div className={`${styles.statCard} ${behind ? styles.statBad : settled ? styles.statGood : styles.statGood}`}>
          <div className={styles.statLabel}>{behind ? 'Outstanding interest' : settled ? 'All caught up' : 'Overpaid'}</div>
          <div className={styles.statValue}>{fmt(Math.abs(stats.outstanding))}</div>
          <div className={styles.statSub}>{behind ? 'accrued not yet paid' : settled ? 'paid = accrued' : 'paid beyond accrued'}</div>
        </div>
      </div>

      {loan.note && <div className={styles.noteBar}>{loan.note}</div>}

      {/* Log a payment */}
      <form className={styles.card} onSubmit={submitPayment}>
        <div className={styles.cardTitle}>Log an interest payment</div>
        <div className={styles.payRow}>
          <label className={styles.field}>
            <span className={styles.fieldLabel}>Date</span>
            <input className={styles.input} type="date" value={payDate} onChange={e => setPayDate(e.target.value)} required />
          </label>
          <label className={styles.field}>
            <span className={styles.fieldLabel}>Amount</span>
            <input className={styles.input} type="number" min="0" step="0.01" value={payAmount} onChange={e => setPayAmount(e.target.value)} placeholder="0.00" required />
          </label>
          <label className={`${styles.field} ${styles.fieldWide}`}>
            <span className={styles.fieldLabel}>Note <span className={styles.optional}>(optional)</span></span>
            <input className={styles.input} value={payNote} onChange={e => setPayNote(e.target.value)} placeholder="e.g. ACH transfer" />
          </label>
          <button type="submit" className={styles.btnPrimary}>Add payment</button>
        </div>
      </form>

      {/* Payment log */}
      <div className={styles.card}>
        <div className={styles.cardTitle}>Payment log</div>
        {sortedPayments.length === 0 ? (
          <div className={styles.emptyRow}>No payments logged yet.</div>
        ) : (
          <table className={styles.table}>
            <thead>
              <tr>
                <th>Date</th>
                <th className={styles.numCol}>Amount</th>
                <th>Note</th>
                <th aria-label="Actions" />
              </tr>
            </thead>
            <tbody>
              {sortedPayments.map(p => (
                <tr key={p.id}>
                  <td>{fmtDate(p.date)}</td>
                  <td className={styles.numCol}>{fmt(Number(p.amount) || 0)}</td>
                  <td className={styles.noteCell}>{p.note || '—'}</td>
                  <td className={styles.actionCol}>
                    <button className={styles.iconBtn} title="Delete payment" aria-label="Delete payment" onClick={() => removeLoanPayment(p.id)}>
                      <span className="material-symbols-outlined" style={{ fontSize: 18 }}>delete</span>
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
            <tfoot>
              <tr>
                <td className={styles.totalLabel}>Total paid</td>
                <td className={styles.numCol}><strong>{fmt(stats.paid)}</strong></td>
                <td colSpan={2} />
              </tr>
            </tfoot>
          </table>
        )}
      </div>
    </div>
  );
}

export default ShortTermLoanPage;
