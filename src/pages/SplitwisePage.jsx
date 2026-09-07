import { useMemo, useState } from 'react';
import { useData, useDataActions } from '../contexts/DataContext';

/* What Splitwise knows, read from this account's side.

   Two questions, in the order they get asked: who is up on whom, and what were
   the charges. Everything numeric here comes from lib/splitwise — this file
   only decides how it looks. */

function fmt(n, currency = 'USD') {
  return new Intl.NumberFormat('en-US', {
    style: 'currency', currency, minimumFractionDigits: 2,
  }).format(Number(n) || 0);
}

function shortDate(value) {
  if (!value) return '';
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return '';
  return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
}

const card = {
  background: 'var(--color-surface)',
  border: 'var(--border-ghost)',
  borderRadius: 'var(--radius-xl)',
  padding: 20,
  boxShadow: 'var(--shadow-xs)',
};

const th = {
  padding: '8px 10px', textAlign: 'left', fontSize: 10.5, fontWeight: 700,
  letterSpacing: '0.06em', textTransform: 'uppercase', color: 'var(--color-text-tertiary)',
  borderBottom: '1px solid var(--border-ghost)', whiteSpace: 'nowrap',
};
const td = {
  padding: '9px 10px', fontSize: 12.5, borderBottom: '1px solid var(--border-ghost)',
  verticalAlign: 'middle',
};

function StatCard({ label, value, color, sub }) {
  return (
    <div style={card}>
      <div style={{ fontSize: 11, fontWeight: 700, letterSpacing: '0.06em', textTransform: 'uppercase', color: 'var(--color-text-tertiary)' }}>
        {label}
      </div>
      <div style={{ fontFamily: 'var(--font-headline)', fontSize: 26, fontWeight: 800, marginTop: 6, color, fontVariantNumeric: 'tabular-nums' }}>
        {value}
      </div>
      {sub && <div style={{ fontSize: 11.5, color: 'var(--color-text-tertiary)', marginTop: 4 }}>{sub}</div>}
    </div>
  );
}

export function SplitwisePage() {
  const { splitwise, splitwisePrefs } = useData();
  const { updateSplitwisePrefs } = useDataActions();
  const [showSettled, setShowSettled] = useState(false);
  const [onlyMine, setOnlyMine] = useState(false);

  const { balances, expenses, summary, user } = splitwise;
  const currency = balances.currency;

  const rows = useMemo(() => expenses.filter(e => {
    if (!showSettled && e.isSettlement) return false;
    if (onlyMine && e.youPaid <= 0) return false;
    return true;
  }), [expenses, showSettled, onlyMine]);

  const matched = useMemo(() => expenses.filter(e => e.match).length, [expenses]);
  const matchable = useMemo(
    () => expenses.filter(e => !e.isSettlement && e.youPaid > 0).length,
    [expenses],
  );

  if (splitwise.loading && !splitwise.connected) {
    return <div style={{ ...card, textAlign: 'center', color: 'var(--color-text-tertiary)', padding: 40 }}>Loading Splitwise…</div>;
  }

  if (!splitwise.connected || splitwise.error) {
    return (
      <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
        <div>
          <div style={{ fontFamily: 'var(--font-headline)', fontSize: 24, fontWeight: 700, marginBottom: 4 }}>Splitwise</div>
          <div style={{ fontSize: 13, color: 'var(--color-text-tertiary)' }}>
            What you have been charged with, and who is up on whom.
          </div>
        </div>
        <div style={{ ...card, borderColor: 'rgba(232,163,23,0.4)', background: 'rgba(232,163,23,0.06)' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, fontWeight: 700, fontSize: 14, marginBottom: 8 }}>
            <span className="material-symbols-outlined" style={{ fontSize: 19, color: '#a36b00' }}>link_off</span>
            Not connected
          </div>
          <div style={{ fontSize: 13, lineHeight: 1.6, color: 'var(--color-text-secondary)', maxWidth: '70ch' }}>
            {splitwise.error || 'Splitwise has not been connected yet.'}
            <br /><br />
            Get a personal API key at <strong>secure.splitwise.com/apps</strong> — register an app,
            then copy the API key it issues. Add it to the Vercel project as{' '}
            <code style={{ padding: '1px 5px', borderRadius: 4, background: 'var(--color-surface-alt)' }}>SPLITWISE_API_KEY</code>{' '}
            and redeploy. Nothing else needs configuring, and the key never reaches the browser —
            the page reads Splitwise through <code>/api/splitwise</code>.
          </div>
        </div>
      </div>
    );
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 20 }}>
      <div style={{ display: 'flex', alignItems: 'flex-end', justifyContent: 'space-between', gap: 16, flexWrap: 'wrap' }}>
        <div>
          <div style={{ fontFamily: 'var(--font-headline)', fontSize: 24, fontWeight: 700, marginBottom: 4 }}>Splitwise</div>
          <div style={{ fontSize: 13, color: 'var(--color-text-tertiary)' }}>
            {user ? `${user.first_name || 'You'} · ` : ''}
            last {splitwise.days} days
            {splitwise.asOf ? ` · as of ${new Date(splitwise.asOf).toLocaleTimeString()}` : ''}
          </div>
        </div>
        <label style={{ display: 'inline-flex', alignItems: 'center', gap: 8, fontSize: 12.5, cursor: 'pointer' }}>
          <input
            type="checkbox"
            checked={!!splitwisePrefs.inNetWorth}
            onChange={() => updateSplitwisePrefs({ inNetWorth: !splitwisePrefs.inNetWorth })}
          />
          Count the net balance in net worth
        </label>
      </div>

      {/* Who is up on whom */}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, minmax(0, 1fr))', gap: 16 }}>
        <StatCard
          label="Owed to you"
          value={fmt(balances.owedToYou, currency)}
          color="#16a34a"
          sub={`${balances.byPerson.filter(p => p.amount > 0).length} people`}
        />
        <StatCard
          label="You owe"
          value={fmt(balances.youOwe, currency)}
          color="#ba1a1a"
          sub={`${balances.byPerson.filter(p => p.amount < 0).length} people`}
        />
        <StatCard
          label="Net"
          value={fmt(balances.net, currency)}
          color={balances.net >= 0 ? '#16a34a' : '#ba1a1a'}
          sub={balances.net >= 0 ? 'In your favour' : 'Against you'}
        />
      </div>

      {balances.otherCurrencies.length > 0 && (
        <div style={{ ...card, padding: '12px 16px', fontSize: 12.5, color: 'var(--color-text-secondary)' }}>
          Also outstanding in other currencies, not included above:{' '}
          {balances.otherCurrencies.map(c => (
            <strong key={c.currency} style={{ marginRight: 10 }}>
              {c.currency} {fmt(c.owedToYou - c.youOwe, c.currency)}
            </strong>
          ))}
        </div>
      )}

      {/* Per person */}
      <div style={card}>
        <div style={{ fontFamily: 'var(--font-headline)', fontSize: 16, fontWeight: 700, marginBottom: 12 }}>
          By person
        </div>
        {balances.byPerson.length === 0 ? (
          <div style={{ fontSize: 13, color: 'var(--color-text-tertiary)' }}>Everyone is settled up.</div>
        ) : (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
            {balances.byPerson.map(p => {
              const max = Math.max(...balances.byPerson.map(x => Math.abs(x.amount)), 1);
              const owed = p.amount > 0;
              return (
                <div key={`${p.id}-${p.currency}`} style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
                  <div style={{ width: 150, fontSize: 13, fontWeight: 600, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                    {p.name}
                  </div>
                  <div style={{ flex: 1, height: 8, borderRadius: 4, background: 'var(--color-surface-alt)', overflow: 'hidden' }}>
                    <div style={{
                      height: '100%',
                      width: `${Math.max(2, (Math.abs(p.amount) / max) * 100)}%`,
                      background: owed ? '#16a34a' : '#ba1a1a',
                      borderRadius: 4,
                    }} />
                  </div>
                  <div style={{ width: 110, textAlign: 'right', fontSize: 13, fontWeight: 700, fontVariantNumeric: 'tabular-nums', color: owed ? '#16a34a' : '#ba1a1a' }}>
                    {owed ? '' : '−'}{fmt(Math.abs(p.amount), p.currency)}
                  </div>
                  <div style={{ width: 74, fontSize: 11, color: 'var(--color-text-tertiary)' }}>
                    {owed ? 'owes you' : 'you owe'}
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </div>

      {/* The charges */}
      <div style={card}>
        <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: 16, flexWrap: 'wrap', marginBottom: 12 }}>
          <div>
            <div style={{ fontFamily: 'var(--font-headline)', fontSize: 16, fontWeight: 700 }}>Charges</div>
            <div style={{ fontSize: 12, color: 'var(--color-text-tertiary)', marginTop: 2 }}>
              You fronted {fmt(summary.youPaid, currency)} across {summary.charges} charges;{' '}
              {fmt(summary.yourShare, currency)} of that was actually your share.
              {matchable > 0 && ` ${matched} of ${matchable} matched to a bank charge.`}
            </div>
          </div>
          <div style={{ display: 'flex', gap: 14, flexWrap: 'wrap' }}>
            <label style={{ display: 'inline-flex', alignItems: 'center', gap: 6, fontSize: 12, cursor: 'pointer' }}>
              <input type="checkbox" checked={onlyMine} onChange={() => setOnlyMine(v => !v)} />
              Only ones I paid for
            </label>
            <label style={{ display: 'inline-flex', alignItems: 'center', gap: 6, fontSize: 12, cursor: 'pointer' }}>
              <input type="checkbox" checked={showSettled} onChange={() => setShowSettled(v => !v)} />
              Include settle-ups
            </label>
          </div>
        </div>

        {rows.length === 0 ? (
          <div style={{ fontSize: 13, color: 'var(--color-text-tertiary)', padding: '20px 0' }}>
            No Splitwise charges in the last {splitwise.days} days.
          </div>
        ) : (
          <div style={{ overflowX: 'auto' }}>
            <table style={{ width: '100%', borderCollapse: 'collapse', minWidth: 760 }}>
              <thead>
                <tr>
                  <th style={th}>Date</th>
                  <th style={th}>Description</th>
                  <th style={th}>With</th>
                  <th style={{ ...th, textAlign: 'right' }}>Total</th>
                  <th style={{ ...th, textAlign: 'right' }}>You paid</th>
                  <th style={{ ...th, textAlign: 'right' }}>Your share</th>
                  <th style={{ ...th, textAlign: 'right' }}>Net</th>
                  <th style={th}>Bank charge</th>
                </tr>
              </thead>
              <tbody>
                {rows.map(e => (
                  <tr key={e.id}>
                    <td style={{ ...td, whiteSpace: 'nowrap', color: 'var(--color-text-tertiary)' }}>{shortDate(e.date)}</td>
                    <td style={td}>
                      <div style={{ fontWeight: 600 }}>{e.description}</div>
                      {(e.category || e.isSettlement) && (
                        <div style={{ fontSize: 11, color: 'var(--color-text-tertiary)', marginTop: 1 }}>
                          {e.isSettlement ? 'Settle-up payment' : e.category}
                        </div>
                      )}
                    </td>
                    <td style={{ ...td, fontSize: 12, color: 'var(--color-text-secondary)' }}>
                      {e.others.map(o => o.name).join(', ') || '—'}
                    </td>
                    <td style={{ ...td, textAlign: 'right', fontVariantNumeric: 'tabular-nums' }}>{fmt(e.cost, e.currency)}</td>
                    <td style={{ ...td, textAlign: 'right', fontVariantNumeric: 'tabular-nums' }}>{fmt(e.youPaid, e.currency)}</td>
                    <td style={{ ...td, textAlign: 'right', fontVariantNumeric: 'tabular-nums' }}>{fmt(e.yourShare, e.currency)}</td>
                    <td style={{
                      ...td, textAlign: 'right', fontWeight: 700, fontVariantNumeric: 'tabular-nums',
                      color: e.net > 0 ? '#16a34a' : e.net < 0 ? '#ba1a1a' : 'var(--color-text-tertiary)',
                    }}>
                      {e.net > 0 ? '+' : ''}{fmt(e.net, e.currency)}
                    </td>
                    <td style={{ ...td, fontSize: 11.5 }}>
                      {e.match ? (
                        <span
                          title={`${e.match.description} · ${e.match.account} · ${shortDate(e.match.date)}`}
                          style={{ display: 'inline-flex', alignItems: 'center', gap: 4, color: 'var(--color-text-secondary)' }}
                        >
                          <span className="material-symbols-outlined" style={{ fontSize: 14, color: e.match.exact ? '#16a34a' : '#e8a317' }}>
                            {e.match.exact ? 'link' : 'help'}
                          </span>
                          <span style={{ maxWidth: 150, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                            {e.match.description}
                          </span>
                        </span>
                      ) : (
                        <span style={{ color: 'var(--color-text-muted)' }}>
                          {e.isSettlement || e.youPaid <= 0 ? '—' : 'not found'}
                        </span>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}

        <div style={{ fontSize: 11, color: 'var(--color-text-tertiary)', marginTop: 12, lineHeight: 1.5, maxWidth: '80ch' }}>
          A bank charge is matched when its amount equals what you fronted, within five days.
          Only charges you paid for can match — if someone else paid, nothing left your account.
          {splitwisePrefs.inNetWorth && (
            <> The net balance is also counted on the Net Worth page; note that a charge you
            fronted is usually on a card statement too, so it shows up both as spend and as
            money owed back to you.</>
          )}
        </div>
      </div>
    </div>
  );
}

export default SplitwisePage;
