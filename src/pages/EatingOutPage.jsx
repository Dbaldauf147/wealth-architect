import { useCallback, useEffect, useMemo, useState } from 'react';
import { useData, useDataActions } from '../contexts/DataContext';
import { txnKey } from '../lib/statementWindows';
import { merchantKey, suggestPlace, isEatingOutCharge, isoDay } from '../lib/placeMatch';
import styles from './EatingOutPage.module.css';

/* Eating out, matched to the places in Prep Day.

   Prep Day keeps the list of restaurants; this page pulls it (through
   api/prepday), lines your restaurant charges up against it, and each match
   you confirm goes back to Prep Day as a visit — date, amount, merchant — so
   the spot there shows when you went and what you spent.

   What's been matched is kept in the synced config (placeLinks: charge → spot,
   placeRules: merchant → spot), so it's the same on every device and the next
   charge from a merchant you've matched is suggested without guessing. */

const money = n => new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' }).format(Math.abs(n));
const RANGES = [
  { id: '1', label: '1 mo', months: 1 },
  { id: '3', label: '3 mo', months: 3 },
  { id: '6', label: '6 mo', months: 6 },
  { id: '12', label: '1 yr', months: 12 },
  { id: 'all', label: 'All time', months: null },
];
const VIEWS = [
  { id: 'todo', label: 'To match' },
  { id: 'done', label: 'Matched' },
  { id: 'all', label: 'All' },
];

export function EatingOutPage() {
  const { transactions, placeLinks, placeRules, privacyMode, loading } = useData();
  const { updatePlaceLinks, updatePlaceRules } = useDataActions();

  const [places, setPlaces] = useState(null);     // null = not loaded yet
  const [remoteVisits, setRemoteVisits] = useState({});
  const [loadError, setLoadError] = useState('');
  const [range, setRange] = useState('3');
  const [view, setView] = useState('todo');
  const [allCategories, setAllCategories] = useState(false);
  const [remember, setRemember] = useState(true);
  const [busy, setBusy] = useState(() => new Set()); // keys with a request in flight
  const [rowErrors, setRowErrors] = useState({});
  const [picking, setPicking] = useState({});      // key → text typed in the picker

  const loadPlaces = useCallback(async () => {
    setLoadError('');
    try {
      const res = await fetch('/api/prepday', { cache: 'no-store' });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || `Prep Day answered ${res.status}`);
      setPlaces([...(data.places || [])].sort((a, b) => a.name.localeCompare(b.name)));
      setRemoteVisits(data.visits || {});
    } catch (err) {
      setLoadError(err.message || String(err));
      setPlaces(prev => prev || []);
    }
  }, []);
  useEffect(() => { if (!privacyMode) loadPlaces(); }, [loadPlaces, privacyMode]);

  const placeById = useMemo(() => new Map((places || []).map(p => [p.id, p])), [places]);
  const placeByName = useMemo(() => new Map((places || []).map(p => [p.name.toLowerCase(), p])), [places]);

  const rows = useMemo(() => {
    const months = RANGES.find(r => r.id === range)?.months;
    const since = months ? new Date(new Date().getFullYear(), new Date().getMonth() - months, new Date().getDate()) : null;
    const out = [];
    for (const t of transactions || []) {
      if (Number(t.amount) >= 0) continue;
      if (!allCategories && !isEatingOutCharge(t)) continue;
      const date = isoDay(t.date);
      if (!date) continue;
      if (since && new Date(`${date}T00:00:00`) < since) continue;
      const key = txnKey(t);
      const link = placeLinks?.[key] || null;
      out.push({
        t, key, date, link,
        suggestion: link || !places?.length ? null : suggestPlace(t.description, places, placeRules || {}),
      });
    }
    return out.sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : 0));
  }, [transactions, range, allCategories, placeLinks, placeRules, places]);

  const shown = rows.filter(r => (view === 'todo' ? !r.link : view === 'done' ? r.link && !r.link.ignored : true));
  const todo = rows.filter(r => !r.link);
  const remembered = todo.filter(r => r.suggestion?.via === 'rule');
  // Matched here but missing in Prep Day — a send that failed half-way, or a
  // visit deleted there. Offered for resending rather than silently dropped.
  const missingThere = places && !loadError
    ? rows.filter(r => r.link && !r.link.ignored && !remoteVisits[r.key] && placeById.has(r.link.placeId))
    : [];

  const byPlace = useMemo(() => {
    const m = new Map();
    for (const r of rows) {
      if (!r.link || r.link.ignored) continue;
      const s = m.get(r.link.placeId) || { name: placeById.get(r.link.placeId)?.name || r.link.placeName, count: 0, total: 0, last: '' };
      s.count += 1;
      s.total += Math.abs(Number(r.t.amount));
      if (r.date > s.last) s.last = r.date;
      m.set(r.link.placeId, s);
    }
    return [...m.values()].sort((a, b) => b.total - a.total);
  }, [rows, placeById]);

  const setBusyKeys = (keys, on) => setBusy(prev => {
    const next = new Set(prev);
    for (const k of keys) { if (on) next.add(k); else next.delete(k); }
    return next;
  });

  /* Send ops to Prep Day; on success, record links (and rules) here. */
  async function send(items) {
    // items: [{ row, place }] to log, or [{ row, remove: true }]
    const keys = items.map(i => i.row.key);
    setBusyKeys(keys, true);
    setRowErrors(prev => { const n = { ...prev }; for (const k of keys) delete n[k]; return n; });
    try {
      const ops = items.map(({ row, place, remove }) => (remove
        ? { op: 'remove', externalId: row.key }
        : { op: 'add', externalId: row.key, placeId: place.id, date: row.date, amount: Math.abs(Number(row.t.amount)), merchant: row.t.description }));
      const res = await fetch('/api/prepday', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ops }) });
      const data = await res.json().catch(() => ({}));
      if (!Array.isArray(data.results)) throw new Error(data.error || `Prep Day answered ${res.status}`);
      const okKeys = new Set(data.results.filter(r => r.ok).map(r => r.externalId));
      const links = {};
      const rules = {};
      const errs = {};
      for (const { row, place, remove } of items) {
        if (!okKeys.has(row.key)) { errs[row.key] = data.results.find(r => r.externalId === row.key)?.error || 'Not logged'; continue; }
        links[row.key] = remove ? null : { placeId: place.id, placeName: place.name, sentAt: new Date().toISOString() };
        const mk = merchantKey(row.t.description);
        if (!remove && remember && mk) rules[mk] = { placeId: place.id, placeName: place.name };
      }
      updatePlaceLinks(links);
      if (Object.keys(rules).length) updatePlaceRules(rules);
      setRowErrors(prev => ({ ...prev, ...errs }));
      setRemoteVisits(prev => {
        const next = { ...prev };
        for (const { row, place, remove } of items) {
          if (!okKeys.has(row.key)) continue;
          if (remove) delete next[row.key]; else next[row.key] = { placeId: place.id, date: row.date };
        }
        return next;
      });
    } catch (err) {
      setRowErrors(prev => ({ ...prev, ...Object.fromEntries(keys.map(k => [k, err.message || String(err)])) }));
    } finally {
      setBusyKeys(keys, false);
    }
  }

  function ignore(row, on) {
    updatePlaceLinks({ [row.key]: on ? { ignored: true } : null });
  }

  function pickFor(row, text) {
    setPicking(prev => ({ ...prev, [row.key]: text }));
    const place = placeByName.get(text.trim().toLowerCase());
    if (place) {
      setPicking(prev => { const n = { ...prev }; delete n[row.key]; return n; });
      send([{ row, place }]);
    }
  }

  if (privacyMode) {
    return (
      <div className={styles.page}>
        <Hero />
        <div className={styles.notice}>Demo mode is on. This page shows real restaurant names from Prep Day, so it's hidden until demo mode is off.</div>
      </div>
    );
  }

  const notConnected = /not connected/i.test(loadError);

  return (
    <div className={styles.page}>
      <Hero stats={places && !loadError ? { places: places.length, todo: todo.length, matched: rows.length - todo.length } : null} />

      {loadError && (
        <div className={notConnected ? styles.notice : styles.error} role="alert">
          {notConnected
            ? <>Prep Day isn't connected yet. The secret that links the two apps hasn't been set (<code>PREPDAY_SYNC_SECRET</code> here, <code>WEALTH_SYNC_SECRET</code> on Prep Day).</>
            : <>Couldn't load your places from Prep Day: {loadError}</>}
          {' '}<button type="button" className={styles.linkBtn} onClick={loadPlaces}>Try again</button>
        </div>
      )}

      <div className={styles.controls}>
        <div className={styles.pills}>
          {VIEWS.map(v => (
            <button key={v.id} type="button" className={`${styles.pill} ${view === v.id ? styles.pillActive : ''}`} onClick={() => setView(v.id)}>
              {v.label}{v.id === 'todo' ? ` (${todo.length})` : ''}
            </button>
          ))}
        </div>
        <div className={styles.pills}>
          {RANGES.map(r => (
            <button key={r.id} type="button" className={`${styles.pill} ${range === r.id ? styles.pillActive : ''}`} onClick={() => setRange(r.id)}>{r.label}</button>
          ))}
        </div>
        <label className={styles.check}>
          <input type="checkbox" checked={allCategories} onChange={e => setAllCategories(e.target.checked)} />
          All categories
        </label>
        <label className={styles.check} title="When you match a charge, also match future charges from the same merchant to that place">
          <input type="checkbox" checked={remember} onChange={e => setRemember(e.target.checked)} />
          Remember merchants
        </label>
      </div>

      {(remembered.length > 0 || missingThere.length > 0) && (
        <div className={styles.bulk}>
          {remembered.length > 0 && (
            <button type="button" className={styles.primaryBtn} disabled={busy.size > 0}
              onClick={() => send(remembered.map(r => ({ row: r, place: r.suggestion.place })))}>
              Log {remembered.length} from remembered merchants
            </button>
          )}
          {missingThere.length > 0 && (
            <button type="button" className={styles.secondaryBtn} disabled={busy.size > 0}
              onClick={() => send(missingThere.map(r => ({ row: r, place: placeById.get(r.link.placeId) })))}>
              Resend {missingThere.length} missing from Prep Day
            </button>
          )}
        </div>
      )}

      <datalist id="prepday-places">
        {(places || []).map(p => <option key={p.id} value={p.name}>{[p.locations?.[0], p.cuisines?.[0]].filter(Boolean).join(' · ')}</option>)}
      </datalist>

      <div className={styles.card}>
        {loading ? <div className={styles.empty}>Loading transactions…</div>
          : shown.length === 0 ? (
            <div className={styles.empty}>
              {view === 'todo' ? 'Every eating-out charge in this range is matched.' : 'Nothing here for this range.'}
            </div>
          ) : (
            <div className={styles.tableWrap}>
              <table className={styles.table}>
                <thead>
                  <tr><th>Date</th><th>Charge</th><th className={styles.num}>Amount</th><th>Place in Prep Day</th><th /></tr>
                </thead>
                <tbody>
                  {shown.map(row => {
                    const isBusy = busy.has(row.key);
                    const err = rowErrors[row.key];
                    const linkedPlace = row.link && !row.link.ignored ? (placeById.get(row.link.placeId) || { name: row.link.placeName }) : null;
                    return (
                      <tr key={row.key} className={row.link?.ignored ? styles.rowIgnored : ''} data-testid="eo-row">
                        <td className={styles.nowrap}>{new Date(`${row.date}T12:00:00`).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })}</td>
                        <td>
                          {row.t.description}
                          <div className={styles.muted}>{row.t.category || 'Uncategorized'}{row.t.account ? ` · ${row.t.account}` : ''}</div>
                        </td>
                        <td className={styles.num}>{money(row.t.amount)}</td>
                        <td className={styles.placeCell}>
                          {linkedPlace ? (
                            <span className={styles.linked}>
                              <span className="material-symbols-outlined">check_circle</span>
                              {linkedPlace.name}
                              {places && !loadError && !remoteVisits[row.key] && <span className={styles.warnText}> · not in Prep Day</span>}
                            </span>
                          ) : row.link?.ignored ? (
                            <span className={styles.muted}>Ignored — not a place you track</span>
                          ) : (
                            <div className={styles.pickRow}>
                              {row.suggestion && (
                                <button type="button" className={styles.suggest} disabled={isBusy}
                                  title={row.suggestion.via === 'rule' ? 'You matched this merchant before' : 'Closest name in Prep Day'}
                                  onClick={() => send([{ row, place: row.suggestion.place }])}>
                                  <span className="material-symbols-outlined">{row.suggestion.via === 'rule' ? 'history' : 'auto_awesome'}</span>
                                  {row.suggestion.place.name}
                                </button>
                              )}
                              <input
                                className={styles.picker}
                                list="prepday-places"
                                placeholder={places?.length ? (row.suggestion ? 'or pick another…' : 'Pick a place…') : 'No places loaded'}
                                disabled={isBusy || !places?.length}
                                value={picking[row.key] || ''}
                                onChange={e => pickFor(row, e.target.value)}
                                aria-label={`Place for ${row.t.description}`}
                              />
                            </div>
                          )}
                          {isBusy && <div className={styles.muted}>Sending to Prep Day…</div>}
                          {err && <div className={styles.errText}>{err}</div>}
                        </td>
                        <td className={styles.actions}>
                          {linkedPlace && (
                            <button type="button" className={styles.linkBtn} disabled={isBusy} onClick={() => send([{ row, remove: true }])}
                              title="Take this visit back out of Prep Day">Unlink</button>
                          )}
                          {!row.link && (
                            <button type="button" className={styles.linkBtnMuted} onClick={() => ignore(row, true)} title="Not a place you track — hide it from To match">Ignore</button>
                          )}
                          {row.link?.ignored && (
                            <button type="button" className={styles.linkBtn} onClick={() => ignore(row, false)}>Undo</button>
                          )}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
      </div>

      {byPlace.length > 0 && (
        <div className={styles.card}>
          <div className={styles.cardTitle}>Spend by place</div>
          <div className={styles.muted}>Matched charges in this range.</div>
          <div className={styles.tableWrap}>
            <table className={styles.table}>
              <thead><tr><th>Place</th><th className={styles.num}>Visits</th><th className={styles.num}>Spent</th><th className={styles.num}>Average</th><th>Last</th></tr></thead>
              <tbody>
                {byPlace.map(p => (
                  <tr key={p.name}>
                    <td>{p.name}</td>
                    <td className={styles.num}>{p.count}</td>
                    <td className={styles.num}>{money(p.total)}</td>
                    <td className={styles.num}>{money(p.total / p.count)}</td>
                    <td className={styles.nowrap}>{new Date(`${p.last}T12:00:00`).toLocaleDateString('en-US', { month: 'short', day: 'numeric' })}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </div>
  );
}

function Hero({ stats }) {
  return (
    <div className={styles.hero}>
      <div className={styles.heroLabel}>Prep Day</div>
      <h1 className={styles.heroTitle}>Eating Out</h1>
      <p className={styles.heroSubtitle}>
        Match your restaurant charges to the places in Prep Day. Each match is sent back to Prep Day as a visit,
        with the date and what you spent, so the place there shows when you last went.
      </p>
      {stats && (
        <div className={styles.heroStats}>
          <div><div className={styles.heroStatValue}>{stats.todo}</div><div className={styles.heroStatLabel}>To match</div></div>
          <div><div className={styles.heroStatValue}>{stats.matched}</div><div className={styles.heroStatLabel}>Matched or ignored</div></div>
          <div><div className={styles.heroStatValue}>{stats.places}</div><div className={styles.heroStatLabel}>Places in Prep Day</div></div>
        </div>
      )}
    </div>
  );
}
