import { useEffect, useMemo, useState } from 'react';
import { collection, doc, onSnapshot, setDoc } from 'firebase/firestore';
import { db } from '../firebase';
import { parseSplitwiseEmail, monthLabel } from '../lib/parseSplitwiseEmail';

/* Splitwise as its monthly "Your balance for <Month>" email tells it.

   One Firestore doc per month in `splitwiseMonthly`, written by the Gmail
   script (via api/amazon-email) or by pasting the email below. The email only
   carries the top balances and the four largest expenses, so this reports
   those and says how many friends were left out, rather than implying the
   list is complete. */

const PATH = 'splitwiseMonthly';

function fmt(n) {
  return new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', minimumFractionDigits: 2 }).format(Number(n) || 0);
}

function shortDate(iso) {
  const d = new Date(`${String(iso).slice(0, 10)}T00:00:00`);
  return Number.isNaN(d.getTime()) ? String(iso || '') : d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
}

const card = { background: 'var(--color-surface)', border: 'var(--border-ghost)', borderRadius: 'var(--radius-xl)', padding: 20, boxShadow: 'var(--shadow-xs)' };
const th = { padding: '8px 10px', textAlign: 'left', fontSize: 10.5, fontWeight: 700, letterSpacing: '0.06em', textTransform: 'uppercase', color: 'var(--color-text-tertiary)', borderBottom: '1px solid var(--border-ghost)', whiteSpace: 'nowrap' };
const td = { padding: '9px 10px', fontSize: 12.5, borderBottom: '1px solid var(--border-ghost)', verticalAlign: 'middle' };
const btn = { display: 'inline-flex', alignItems: 'center', gap: 6, padding: '8px 14px', background: 'var(--color-secondary)', color: '#fff', border: 'none', borderRadius: 8, fontSize: 13, fontWeight: 600, cursor: 'pointer' };

const signColor = n => (n > 0 ? '#16a34a' : n < 0 ? '#ba1a1a' : 'var(--color-text-tertiary)');
function balanceWords(n) {
  if (n == null) return '—';
  if (n === 0) return 'All settled up';
  return n > 0 ? `You are owed ${fmt(n)}` : `You owe ${fmt(-n)}`;
}

/** Real spending in a month's largest-expenses list — settle-ups move money
 *  between people but aren't anything bought. */
function monthTotals(m) {
  const real = (m.expenses || []).filter(e => !e.settlement);
  const sum = dir => real.filter(e => e.direction === dir).reduce((s, e) => s + (Number(e.amount) || 0), 0);
  const friends = m.friends || [];
  return {
    lent: sum('lent') + sum('paid'),
    borrowed: sum('borrowed'),
    owedToYou: friends.filter(f => f.amount > 0).reduce((s, f) => s + f.amount, 0),
    youOwe: friends.filter(f => f.amount < 0).reduce((s, f) => s - f.amount, 0),
  };
}

export function SplitwiseMonthly() {
  const [months, setMonths] = useState(null);
  const [error, setError] = useState('');
  const [selected, setSelected] = useState('');

  useEffect(() => onSnapshot(
    collection(db, PATH),
    snap => setMonths(snap.docs.map(d => ({ id: d.id, ...d.data() })).sort((a, b) => b.id.localeCompare(a.id))),
    err => { console.warn('splitwiseMonthly read failed:', err); setError('Could not read the saved Splitwise summaries.'); setMonths([]); },
  ), []);

  const current = useMemo(() => {
    if (!months || !months.length) return null;
    return months.find(m => m.id === selected) || months[0];
  }, [months, selected]);

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }} data-testid="splitwise-monthly">
      {months == null ? (
        <div style={{ ...card, color: 'var(--color-text-tertiary)' }}>Loading Splitwise summaries…</div>
      ) : !current ? (
        <div style={{ ...card, color: 'var(--color-text-tertiary)', fontSize: 13 }}>
          {error || 'No monthly Splitwise emails yet. Paste one below, or wait for the Gmail import to bring in the next one.'}
        </div>
      ) : (
        <MonthReport month={current} months={months} onSelect={setSelected} />
      )}

      {months && months.length > 1 && <History months={months} onSelect={setSelected} selected={current?.id} />}

      <PasteImport />
    </div>
  );
}

function MonthReport({ month, months, onSelect }) {
  const t = monthTotals(month);
  const friends = [...(month.friends || [])].sort((a, b) => Math.abs(b.amount) - Math.abs(a.amount));
  const max = Math.max(1, ...friends.map(f => Math.abs(f.amount)));

  return (
    <>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12, flexWrap: 'wrap' }}>
        <div>
          <div style={{ fontFamily: 'var(--font-headline)', fontSize: 18, fontWeight: 700 }}>{monthLabel(month.id)}</div>
          <div style={{ fontSize: 12, color: 'var(--color-text-tertiary)' }}>
            From Splitwise's monthly email · {month.source === 'paste' ? 'pasted in' : 'imported from Gmail'}
            {month.updatedAt ? ` ${new Date(month.updatedAt).toLocaleDateString('en-US', { month: 'short', day: 'numeric' })}` : ''}
          </div>
        </div>
        {months.length > 1 && (
          <select aria-label="Month" value={month.id} onChange={e => onSelect(e.target.value)}
            style={{ padding: '8px 10px', border: '1px solid var(--border-ghost)', borderRadius: 6, fontSize: 13, background: 'var(--color-surface)', color: 'var(--color-text-primary)' }}>
            {months.map(m => <option key={m.id} value={m.id}>{monthLabel(m.id)}</option>)}
          </select>
        )}
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr))', gap: 16 }}>
        <Stat label="Total balance" value={month.totalBalance == null ? '—' : fmt(Math.abs(month.totalBalance))}
          color={signColor(month.totalBalance)} sub={balanceWords(month.totalBalance)} />
        <Stat label="Owed to you" value={fmt(t.owedToYou)} color="#16a34a"
          sub={`${friends.filter(f => f.amount > 0).length} listed${month.moreFriends ? ', top balances only' : ''}`} />
        <Stat label="You owe" value={fmt(t.youOwe)} color="#ba1a1a" sub={`${friends.filter(f => f.amount < 0).length} listed`} />
        <Stat label="Lent / borrowed" value={`${fmt(t.lent)} / ${fmt(t.borrowed)}`} color="#0058be"
          sub="Others' share of bills you paid / your share of theirs · largest expenses, no settle-ups" />
      </div>

      <div style={card}>
        <div style={{ fontFamily: 'var(--font-headline)', fontSize: 16, fontWeight: 700, marginBottom: 12 }}>Balances</div>
        {friends.length === 0 ? (
          <div style={{ fontSize: 13, color: 'var(--color-text-tertiary)' }}>No balances listed in this email.</div>
        ) : (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
            {friends.map(f => (
              <div key={f.name} style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
                <div style={{ width: 150, fontSize: 13, fontWeight: 600, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{f.name}</div>
                <div style={{ flex: 1, height: 8, borderRadius: 4, background: 'var(--color-surface-alt)', overflow: 'hidden' }}>
                  <div style={{ height: '100%', width: `${Math.max(2, (Math.abs(f.amount) / max) * 100)}%`, background: signColor(f.amount), borderRadius: 4 }} />
                </div>
                <div style={{ width: 100, textAlign: 'right', fontSize: 13, fontWeight: 700, fontVariantNumeric: 'tabular-nums', color: signColor(f.amount) }}>
                  {f.amount < 0 ? '−' : ''}{fmt(Math.abs(f.amount))}
                </div>
                <div style={{ width: 70, fontSize: 11, color: 'var(--color-text-tertiary)' }}>{f.amount > 0 ? 'owes you' : 'you owe'}</div>
              </div>
            ))}
          </div>
        )}
        {month.moreFriends > 0 && (
          <div style={{ fontSize: 11.5, color: 'var(--color-text-tertiary)', marginTop: 10 }}>
            Plus {month.moreFriends} more friend{month.moreFriends === 1 ? '' : 's'} the email doesn't list. The total balance above includes them.
          </div>
        )}
      </div>

      <div style={card}>
        <div style={{ fontFamily: 'var(--font-headline)', fontSize: 16, fontWeight: 700, marginBottom: 2 }}>Largest expenses</div>
        <div style={{ fontSize: 12, color: 'var(--color-text-tertiary)', marginBottom: 12 }}>The ones Splitwise picked for the email, not every expense that month.</div>
        {(month.expenses || []).length === 0 ? (
          <div style={{ fontSize: 13, color: 'var(--color-text-tertiary)' }}>None listed.</div>
        ) : (
          <div style={{ overflowX: 'auto' }}>
            <table style={{ width: '100%', borderCollapse: 'collapse', minWidth: 480 }}>
              <thead>
                <tr>
                  <th style={th}>Date</th>
                  <th style={th}>Expense</th>
                  <th style={th}>You</th>
                  <th style={{ ...th, textAlign: 'right' }}>Amount</th>
                </tr>
              </thead>
              <tbody>
                {[...month.expenses].sort((a, b) => b.date.localeCompare(a.date) || b.amount - a.amount).map((e, i) => (
                  <tr key={i} style={{ opacity: e.settlement ? 0.6 : 1 }}>
                    <td style={{ ...td, whiteSpace: 'nowrap', color: 'var(--color-text-tertiary)' }}>{shortDate(e.date)}</td>
                    <td style={td}>
                      <div style={{ fontWeight: 600 }}>{e.description}</div>
                      {e.settlement && <div style={{ fontSize: 11, color: 'var(--color-text-tertiary)' }}>Settle-up, not spending</div>}
                    </td>
                    <td style={{ ...td, color: 'var(--color-text-secondary)' }}>{e.direction}</td>
                    <td style={{ ...td, textAlign: 'right', fontWeight: 700, fontVariantNumeric: 'tabular-nums', color: e.direction === 'borrowed' ? '#ba1a1a' : '#16a34a' }}>
                      {e.direction === 'borrowed' ? '−' : '+'}{fmt(e.amount)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </>
  );
}

function History({ months, onSelect, selected }) {
  return (
    <div style={card}>
      <div style={{ fontFamily: 'var(--font-headline)', fontSize: 16, fontWeight: 700, marginBottom: 12 }}>Month by month</div>
      <div style={{ overflowX: 'auto' }}>
        <table style={{ width: '100%', borderCollapse: 'collapse', minWidth: 480 }}>
          <thead>
            <tr>
              <th style={th}>Month</th>
              <th style={{ ...th, textAlign: 'right' }}>Total balance</th>
              <th style={{ ...th, textAlign: 'right' }}>Lent</th>
              <th style={{ ...th, textAlign: 'right' }}>Borrowed</th>
            </tr>
          </thead>
          <tbody>
            {months.map(m => {
              const t = monthTotals(m);
              return (
                <tr key={m.id} onClick={() => onSelect(m.id)} style={{ cursor: 'pointer', background: m.id === selected ? 'var(--color-surface-alt)' : 'transparent' }}>
                  <td style={{ ...td, fontWeight: 600 }}>{monthLabel(m.id)}</td>
                  <td style={{ ...td, textAlign: 'right', fontWeight: 700, fontVariantNumeric: 'tabular-nums', color: signColor(m.totalBalance) }}>
                    {m.totalBalance == null ? '—' : `${m.totalBalance < 0 ? '−' : '+'}${fmt(Math.abs(m.totalBalance))}`}
                  </td>
                  <td style={{ ...td, textAlign: 'right', fontVariantNumeric: 'tabular-nums' }}>{fmt(t.lent)}</td>
                  <td style={{ ...td, textAlign: 'right', fontVariantNumeric: 'tabular-nums' }}>{fmt(t.borrowed)}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      <div style={{ fontSize: 11, color: 'var(--color-text-tertiary)', marginTop: 10 }}>
        Lent is others' share of bills you paid; borrowed is your share of bills others paid. Both count only the largest expenses each email lists, with settle-ups left out.
      </div>
    </div>
  );
}

function PasteImport() {
  const [text, setText] = useState('');
  const [status, setStatus] = useState(null); // { ok, message }
  const [saving, setSaving] = useState(false);

  async function save() {
    const r = parseSplitwiseEmail({ subject: '', date: new Date().toISOString(), body: text });
    if (!r.ok) { setStatus({ ok: false, message: `Couldn't read that as a Splitwise monthly email (${r.reason}).` }); return; }
    setSaving(true);
    try {
      await setDoc(doc(db, PATH, r.summary.month), { ...r.summary, source: 'paste', updatedAt: new Date().toISOString() });
      setStatus({ ok: true, message: `Saved ${monthLabel(r.summary.month)}: ${r.summary.friends.length} balances, ${r.summary.expenses.length} expenses.` });
      setText('');
    } catch (err) {
      console.warn('splitwiseMonthly write failed:', err);
      setStatus({ ok: false, message: 'Read it, but could not save it. Check the connection and try again.' });
    } finally {
      setSaving(false);
    }
  }

  return (
    <div style={card}>
      <div style={{ fontFamily: 'var(--font-headline)', fontSize: 16, fontWeight: 700, marginBottom: 2 }}>Import a monthly email</div>
      <div style={{ fontSize: 12, color: 'var(--color-text-tertiary)', marginBottom: 10 }}>
        New ones come in from Gmail on their own. For an older one, open "Your balance for &lt;Month&gt;" from Splitwise, copy all of it, and paste it here. Pasting a month again replaces it.
      </div>
      <textarea
        aria-label="Splitwise email text"
        value={text}
        onChange={e => { setText(e.target.value); setStatus(null); }}
        placeholder={'Your balance for October\n…\nTotal balance\nyou are owed $54.00\n…'}
        rows={6}
        style={{ width: '100%', padding: 10, border: '1px solid var(--border-ghost)', borderRadius: 6, fontSize: 12.5, fontFamily: 'inherit', background: 'var(--color-surface)', color: 'var(--color-text-primary)', resize: 'vertical' }}
      />
      <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginTop: 10, flexWrap: 'wrap' }}>
        <button type="button" onClick={save} disabled={!text.trim() || saving} style={{ ...btn, opacity: !text.trim() || saving ? 0.5 : 1 }}>
          <span className="material-symbols-outlined" style={{ fontSize: 16 }}>upload</span>
          {saving ? 'Saving…' : 'Import'}
        </button>
        {status && (
          <span role="status" style={{ fontSize: 12.5, fontWeight: 600, color: status.ok ? '#16a34a' : '#ba1a1a' }}>{status.message}</span>
        )}
      </div>
    </div>
  );
}

function Stat({ label, value, color, sub }) {
  return (
    <div style={card}>
      <div style={{ fontSize: 11, fontWeight: 700, letterSpacing: '0.06em', textTransform: 'uppercase', color: 'var(--color-text-tertiary)' }}>{label}</div>
      <div style={{ fontFamily: 'var(--font-headline)', fontSize: 24, fontWeight: 800, marginTop: 6, color, fontVariantNumeric: 'tabular-nums' }}>{value}</div>
      {sub && <div style={{ fontSize: 11.5, color: 'var(--color-text-tertiary)', marginTop: 4 }}>{sub}</div>}
    </div>
  );
}

export default SplitwiseMonthly;
