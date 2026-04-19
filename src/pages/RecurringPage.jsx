import { Fragment, useMemo, useState } from 'react';
import { useData } from '../contexts/DataContext';
import styles from './RecurringPage.module.css';

function fmt(n) {
  return new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(Math.abs(n));
}

function fmtShort(n) {
  return new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', minimumFractionDigits: 0, maximumFractionDigits: 0 }).format(Math.abs(n));
}

function fmtDate(s) {
  if (!s) return '—';
  var d = new Date(s);
  if (isNaN(d)) return s;
  return (d.getMonth() + 1) + '/' + d.getDate() + '/' + d.getFullYear();
}

var STATUS_KEY = 'wa-recurring-status';
var SUBCAT_STATUS_KEY = 'wa-recurring-subcat-status';
var FREQ_OVERRIDE_KEY = 'wa-recurring-freq-override';

function loadStatuses() {
  try { return JSON.parse(localStorage.getItem(STATUS_KEY) || '{}'); } catch { return {}; }
}

function saveStatuses(map) {
  localStorage.setItem(STATUS_KEY, JSON.stringify(map));
}

function loadSubcatStatuses() {
  try { return JSON.parse(localStorage.getItem(SUBCAT_STATUS_KEY) || '{}'); } catch { return {}; }
}

function saveSubcatStatuses(map) {
  localStorage.setItem(SUBCAT_STATUS_KEY, JSON.stringify(map));
}

function loadFreqOverrides() {
  try { return JSON.parse(localStorage.getItem(FREQ_OVERRIDE_KEY) || '{}'); } catch { return {}; }
}

function saveFreqOverrides(map) {
  localStorage.setItem(FREQ_OVERRIDE_KEY, JSON.stringify(map));
}

export function RecurringPage() {
  var data = useData();
  var transactions = data.transactions;
  var loading = data.loading;
  var statusState = useState(loadStatuses);
  var statuses = statusState[0];
  var setStatuses = statusState[1];

  function setStatus(key, status) {
    setStatuses(function(prev) {
      var next = Object.assign({}, prev);
      if (next[key] === status) { delete next[key]; } // toggle off
      else { next[key] = status; }
      saveStatuses(next);
      return next;
    });
  }

  var subcatStatusState = useState(loadSubcatStatuses);
  var subcatStatuses = subcatStatusState[0];
  var setSubcatStatuses = subcatStatusState[1];

  var freqOverrideState = useState(loadFreqOverrides);
  var freqOverrides = freqOverrideState[0];
  var setFreqOverrides = freqOverrideState[1];

  function cycleFrequency(itemKey) {
    // Cycle: auto -> monthly -> quarterly -> annual -> auto
    var order = [undefined, 'monthly', 'quarterly', 'annual'];
    setFreqOverrides(function(prev) {
      var next = Object.assign({}, prev);
      var current = next[itemKey];
      var idx = order.indexOf(current);
      var nextVal = order[(idx + 1) % order.length];
      if (nextVal === undefined) delete next[itemKey];
      else next[itemKey] = nextVal;
      saveFreqOverrides(next);
      return next;
    });
  }

  function toggleSubcatStatus(name) {
    setSubcatStatuses(function(prev) {
      var next = Object.assign({}, prev);
      if (next[name] === 'cancelled') delete next[name]; // back to active (default)
      else next[name] = 'cancelled';
      saveSubcatStatuses(next);
      return next;
    });
  }

  var recurring = useMemo(function() {
    if (!transactions || transactions.length === 0) return [];

    // Group subscriptions by description
    var groups = {};
    for (var i = 0; i < transactions.length; i++) {
      var t = transactions[i];
      var cat = (t.category || '').toLowerCase();
      var sub = (t.subcategory || '').toLowerCase();
      if (sub !== 'subscriptions' && cat !== 'subscriptions') continue;
      var desc = (t.description || '').trim();
      if (!desc) continue;
      var key = desc.toLowerCase();
      if (!groups[key]) {
        groups[key] = { description: desc, category: t.category || 'Uncategorized', subcategory: t.subcategory || '', months: {}, account: t.account || '', txns: [] };
      }
      groups[key].txns.push({ date: t.date, amount: t.amount, account: t.account, description: t.description });
      var month = t.month || 'Unknown';
      groups[key].months[month] = (groups[key].months[month] || 0) + 1;
    }

    var result = [];
    var entries = Object.values(groups);
    for (var j = 0; j < entries.length; j++) {
      var g = entries[j];
      var monthCount = Object.keys(g.months).length;
      var amounts = g.txns.map(function(tx) { return Math.abs(tx.amount); });
      var totalAmt = amounts.reduce(function(s, a) { return s + a; }, 0);
      var avgAmount = totalAmt / amounts.length;
      var minAmount = Math.min.apply(null, amounts);
      var maxAmount = Math.max.apply(null, amounts);
      var isFixed = minAmount === maxAmount;

      var itemKey = g.description.toLowerCase();

      // Determine frequency (auto-detected from transaction spacing)
      var sortedTxns = g.txns.slice().sort(function(a, b) { return new Date(a.date) - new Date(b.date); });
      var autoFreq = 'monthly';
      if (sortedTxns.length >= 2) {
        var firstDate = new Date(sortedTxns[0].date);
        var lastDate = new Date(sortedTxns[sortedTxns.length - 1].date);
        var totalDays = (lastDate - firstDate) / (1000 * 60 * 60 * 24);
        var avgDaysBetween = totalDays / (sortedTxns.length - 1);
        if (avgDaysBetween > 180) autoFreq = 'annual';
        else if (avgDaysBetween > 60) autoFreq = 'quarterly';
      }
      // Allow per-item user override (annual fees with one charge can't be auto-detected)
      var overrideFreq = freqOverrides[itemKey];
      var frequency = overrideFreq || autoFreq;
      var freqOverridden = !!overrideFreq;

      var annualEstimate = frequency === 'annual' ? avgAmount : frequency === 'quarterly' ? avgAmount * 4 : avgAmount * 12;

      // Next expected payment = most recent charge + frequency interval
      var mostRecentDate = new Date(sortedTxns[sortedTxns.length - 1].date);
      var nextDate = new Date(mostRecentDate);
      if (frequency === 'annual') nextDate.setFullYear(nextDate.getFullYear() + 1);
      else if (frequency === 'quarterly') nextDate.setMonth(nextDate.getMonth() + 3);
      else nextDate.setMonth(nextDate.getMonth() + 1);
      var ny = nextDate.getFullYear();
      var nm = String(nextDate.getMonth() + 1).padStart(2, '0');
      var nd = String(nextDate.getDate()).padStart(2, '0');
      var nextExpected = ny + '-' + nm + '-' + nd;

      result.push({
        key: itemKey,
        description: g.description,
        category: g.category,
        subcategory: g.subcategory,
        account: g.account,
        avgAmount: avgAmount,
        totalAmount: totalAmt,
        occurrences: g.txns.length,
        monthCount: monthCount,
        frequency: frequency,
        freqOverridden: freqOverridden,
        isFixed: isFixed,
        minAmount: minAmount,
        maxAmount: maxAmount,
        annualEstimate: annualEstimate,
        nextExpected: nextExpected,
        txns: sortedTxns.reverse(),
      });
    }

    // Sort by average amount, largest first
    result.sort(function(a, b) { return b.avgAmount - a.avgAmount; });
    return result;
  }, [transactions, freqOverrides]);

  var expandedSub = useState(null);
  var expandedSubVal = expandedSub[0];
  var setExpandedSub = expandedSub[1];

  var bucketSortState = useState({ col: 'totalSpent', dir: 'desc' });
  var bucketSort = bucketSortState[0];
  var setBucketSort = bucketSortState[1];

  var itemSortState = useState({ col: 'date', dir: 'desc' });
  var itemSort = itemSortState[0];
  var setItemSort = itemSortState[1];

  function toggleSort(setCur, col, defaultDir) {
    setCur(function(prev) {
      if (prev.col === col) return { col: col, dir: prev.dir === 'asc' ? 'desc' : 'asc' };
      return { col: col, dir: defaultDir || 'desc' };
    });
  }

  /* Group recurring items into subcategory buckets */
  var subBuckets = useMemo(function() {
    var buckets = {};
    for (var i = 0; i < recurring.length; i++) {
      var r = recurring[i];
      var sub = r.subcategory || r.category || 'Other';
      if (!buckets[sub]) buckets[sub] = { name: sub, items: [], totalMonthly: 0, totalAnnual: 0, totalSpent: 0, lastChargedTs: 0, nextExpected: '', freqCounts: { monthly: 0, quarterly: 0, annual: 0 } };
      buckets[sub].items.push(r);
      buckets[sub].totalMonthly += r.avgAmount;
      buckets[sub].totalAnnual += r.annualEstimate;
      buckets[sub].totalSpent += r.totalAmount;
      if (r.frequency) buckets[sub].freqCounts[r.frequency] = (buckets[sub].freqCounts[r.frequency] || 0) + 1;
      // Last Charged: most recent date across all items in the bucket
      if (r.txns.length > 0) {
        var lastTs = new Date(r.txns[0].date).getTime();
        if (!isNaN(lastTs) && lastTs > buckets[sub].lastChargedTs) {
          buckets[sub].lastChargedTs = lastTs;
          buckets[sub].lastCharged = r.txns[0].date;
        }
      }
      // Next Expected: earliest upcoming next-expected date in the bucket
      if (r.nextExpected) {
        if (!buckets[sub].nextExpected || r.nextExpected < buckets[sub].nextExpected) {
          buckets[sub].nextExpected = r.nextExpected;
        }
      }
    }
    var list = Object.values(buckets);
    // Compute a single frequency per bucket: dominant if all items agree, else 'mixed'.
    for (var k = 0; k < list.length; k++) {
      var b = list[k];
      var freqs = Object.keys(b.freqCounts).filter(function(f) { return b.freqCounts[f] > 0; });
      if (freqs.length === 0) b.frequency = '';
      else if (freqs.length === 1) b.frequency = freqs[0];
      else b.frequency = 'mixed';
    }
    var dir = bucketSort.dir === 'asc' ? 1 : -1;
    list.sort(function(a, b) {
      // Cancelled buckets always sink to the bottom regardless of column sort.
      var aCancelled = subcatStatuses[a.name] === 'cancelled' ? 1 : 0;
      var bCancelled = subcatStatuses[b.name] === 'cancelled' ? 1 : 0;
      if (aCancelled !== bCancelled) return aCancelled - bCancelled;
      var col = bucketSort.col;
      if (col === 'name') return a.name.localeCompare(b.name) * dir;
      if (col === 'items') return (a.items.length - b.items.length) * dir;
      if (col === 'totalMonthly') return (a.totalMonthly - b.totalMonthly) * dir;
      if (col === 'lastCharged') return ((a.lastChargedTs || 0) - (b.lastChargedTs || 0)) * dir;
      if (col === 'nextExpected') return (a.nextExpected || '').localeCompare(b.nextExpected || '') * dir;
      if (col === 'frequency') return (a.frequency || '').localeCompare(b.frequency || '') * dir;
      return (a.totalSpent - b.totalSpent) * dir;
    });
    return list;
  }, [recurring, bucketSort, subcatStatuses]);

  function sortItems(items) {
    var dir = itemSort.dir === 'asc' ? 1 : -1;
    var col = itemSort.col;
    return items.slice().sort(function(a, b) {
      // Cancelled items always fall to the bottom within the bucket.
      var aCancelled = statuses[a.key] === 'cancelled' ? 1 : 0;
      var bCancelled = statuses[b.key] === 'cancelled' ? 1 : 0;
      if (aCancelled !== bCancelled) return aCancelled - bCancelled;
      if (col === 'description') return a.description.localeCompare(b.description) * dir;
      if (col === 'account') return (a.account || '').localeCompare(b.account || '') * dir;
      if (col === 'frequency') return a.frequency.localeCompare(b.frequency) * dir;
      if (col === 'avgAmount') return (a.avgAmount - b.avgAmount) * dir;
      if (col === 'totalAmount') return (a.totalAmount - b.totalAmount) * dir;
      if (col === 'occurrences') return (a.occurrences - b.occurrences) * dir;
      if (col === 'nextExpected') return a.nextExpected.localeCompare(b.nextExpected) * dir;
      var aDate = a.txns.length > 0 ? new Date(a.txns[0].date).getTime() : 0;
      var bDate = b.txns.length > 0 ? new Date(b.txns[0].date).getTime() : 0;
      return (aDate - bDate) * dir;
    });
  }

  function sortArrow(state, key) {
    return (
      <span className={styles.sortArrow} style={{ opacity: state.col === key ? 1 : 0 }}>
        {state.dir === 'asc' ? '\u25B2' : '\u25BC'}
      </span>
    );
  }

  var totalMonthly = 0;
  var totalAnnual = 0;
  var totalSpentAll = 0;
  var keepMonthly = 0;
  var getRidMonthly = 0;
  var noMoreMonthly = 0;
  for (var i = 0; i < recurring.length; i++) {
    totalMonthly += recurring[i].avgAmount;
    totalAnnual += recurring[i].annualEstimate;
    totalSpentAll += recurring[i].totalAmount;
    var st = statuses[recurring[i].key];
    if (st === 'keep') keepMonthly += recurring[i].avgAmount;
    else if (st === 'getrid') getRidMonthly += recurring[i].avgAmount;
    else if (st === 'nomore') noMoreMonthly += recurring[i].avgAmount;
  }

  return (
    <div className={styles.page}>
      {/* Hero */}
      <div className={styles.hero}>
        <div className={styles.heroLabel}>Recurring Payments</div>
        <div className={styles.heroTitle}>Subscriptions & Regular Charges</div>
        <div className={styles.heroSubtitle}>Payments that appear in 2 or more months, sorted by amount.</div>
        <div className={styles.heroStats}>
          <div className={styles.heroStat}>
            <div className={styles.heroStatValue}>{recurring.length}</div>
            <div className={styles.heroStatLabel}>Recurring Items</div>
          </div>
          <div className={styles.heroStat}>
            <div className={styles.heroStatValue}>{fmtShort(totalMonthly)}</div>
            <div className={styles.heroStatLabel}>Avg Monthly</div>
          </div>
          <div className={styles.heroStat}>
            <div className={styles.heroStatValue}>{fmtShort(totalAnnual)}</div>
            <div className={styles.heroStatLabel}>Annual Estimate</div>
          </div>
          {getRidMonthly > 0 && (
            <div className={styles.heroStat}>
              <div className={styles.heroStatValue} style={{ color: '#4ade80' }}>{fmtShort(getRidMonthly * 12)}</div>
              <div className={styles.heroStatLabel}>Potential Savings</div>
            </div>
          )}
        </div>
      </div>

      {/* Table */}
      {loading ? (
        <div style={{ color: '#999', fontSize: 13, padding: 20 }}>Loading transactions...</div>
      ) : recurring.length === 0 ? (
        <div style={{ color: '#999', fontSize: 13, padding: 20 }}>No recurring payments detected. Need at least 2 months of transaction data.</div>
      ) : (
        <div className={styles.tableCard}>
          <table className={styles.table}>
            <thead>
              <tr>
                <th className={styles.sortableTh} onClick={function() { toggleSort(setBucketSort, 'name', 'asc'); }}>
                  Subcategory{sortArrow(bucketSort, 'name')}
                </th>
                <th className={styles.sortableTh} style={{ textAlign: 'center' }} onClick={function() { toggleSort(setBucketSort, 'items', 'desc'); }}>
                  Items{sortArrow(bucketSort, 'items')}
                </th>
                <th className={styles.sortableTh} style={{ textAlign: 'center' }} onClick={function() { toggleSort(setBucketSort, 'frequency', 'asc'); }}>
                  Frequency{sortArrow(bucketSort, 'frequency')}
                </th>
                <th className={styles.sortableTh} onClick={function() { toggleSort(setBucketSort, 'lastCharged', 'desc'); }}>
                  Last Charged{sortArrow(bucketSort, 'lastCharged')}
                </th>
                <th className={styles.sortableTh} onClick={function() { toggleSort(setBucketSort, 'nextExpected', 'asc'); }}>
                  Next Expected{sortArrow(bucketSort, 'nextExpected')}
                </th>
                <th className={styles.sortableTh} style={{ textAlign: 'right' }} onClick={function() { toggleSort(setBucketSort, 'totalMonthly', 'desc'); }}>
                  Avg Monthly{sortArrow(bucketSort, 'totalMonthly')}
                </th>
                <th className={styles.sortableTh} style={{ textAlign: 'right' }} onClick={function() { toggleSort(setBucketSort, 'totalSpent', 'desc'); }}>
                  Total Spent{sortArrow(bucketSort, 'totalSpent')}
                </th>
                <th style={{ textAlign: 'center' }}>Status</th>
              </tr>
            </thead>
            <tbody>
              {subBuckets.map(function(bucket) {
                var isOpen = expandedSubVal === bucket.name;
                var sortedItems = sortItems(bucket.items);
                var subStatus = subcatStatuses[bucket.name];
                var isCancelled = subStatus === 'cancelled';
                return (
                  <Fragment key={bucket.name}>
                    <tr style={{ cursor: 'pointer', opacity: isCancelled ? 0.5 : 1 }} onClick={function() { setExpandedSub(isOpen ? null : bucket.name); }}>
                      <td>
                        <div className={styles.paymentName} style={{ textDecoration: isCancelled ? 'line-through' : 'none' }}>
                          <span className={styles.expandArrow}>{isOpen ? '\u25BE' : '\u25B8'}</span>
                          <span className={styles.categoryBadge}>{bucket.name}</span>
                        </div>
                      </td>
                      <td style={{ textAlign: 'center' }}>
                        <span className={styles.freqBadge}>{bucket.items.length}</span>
                      </td>
                      <td style={{ textAlign: 'center' }}>
                        {bucket.frequency ? (
                          <span className={styles.freqBadge}>
                            {bucket.frequency === 'mixed' ? 'Mixed' : bucket.frequency.charAt(0).toUpperCase() + bucket.frequency.slice(1)}
                          </span>
                        ) : '—'}
                      </td>
                      <td className={styles.accountCell}>{bucket.lastCharged ? fmtDate(bucket.lastCharged) : '—'}</td>
                      <td className={styles.accountCell}>{bucket.nextExpected ? fmtDate(bucket.nextExpected) : '—'}</td>
                      <td style={{ textAlign: 'right' }}>
                        <div className={styles.amountMain}>{fmt(bucket.totalMonthly)}</div>
                      </td>
                      <td style={{ textAlign: 'right' }}>
                        <div className={styles.amountMain}>{fmt(bucket.totalSpent)}</div>
                      </td>
                      <td style={{ textAlign: 'center' }} onClick={function(e) { e.stopPropagation(); }}>
                        <button
                          type="button"
                          onClick={function() { toggleSubcatStatus(bucket.name); }}
                          className={isCancelled ? styles.statusBtnGetridActive : styles.statusBtnKeepActive}
                          style={{ padding: '3px 9px', fontSize: 10, fontWeight: 700, borderRadius: 'var(--radius-sm)', cursor: 'pointer' }}
                          title={isCancelled ? 'Marked as cancelled. Click to mark active.' : 'Active. Click to mark cancelled.'}
                        >
                          {isCancelled ? 'Cancelled' : 'Active'}
                        </button>
                      </td>
                    </tr>
                    {isOpen && (
                      <tr>
                        <td colSpan="8" style={{ padding: 0 }}>
                          <table className={styles.table} style={{ margin: 0 }}>
                            <thead>
                              <tr style={{ background: 'var(--color-surface-alt, #f8f8f8)' }}>
                                <th className={styles.sortableTh} style={{ paddingLeft: 32 }} onClick={function(e) { e.stopPropagation(); toggleSort(setItemSort, 'description', 'asc'); }}>
                                  Payment{sortArrow(itemSort, 'description')}
                                </th>
                                <th className={styles.sortableTh} onClick={function(e) { e.stopPropagation(); toggleSort(setItemSort, 'account', 'asc'); }}>
                                  Account{sortArrow(itemSort, 'account')}
                                </th>
                                <th className={styles.sortableTh} style={{ textAlign: 'center' }} onClick={function(e) { e.stopPropagation(); toggleSort(setItemSort, 'frequency', 'asc'); }}>
                                  Frequency{sortArrow(itemSort, 'frequency')}
                                </th>
                                <th className={styles.sortableTh} style={{ textAlign: 'center' }} onClick={function(e) { e.stopPropagation(); toggleSort(setItemSort, 'occurrences', 'desc'); }}>
                                  Charges{sortArrow(itemSort, 'occurrences')}
                                </th>
                                <th className={styles.sortableTh} style={{ textAlign: 'right' }} onClick={function(e) { e.stopPropagation(); toggleSort(setItemSort, 'avgAmount', 'desc'); }}>
                                  Avg Amount{sortArrow(itemSort, 'avgAmount')}
                                </th>
                                <th className={styles.sortableTh} style={{ textAlign: 'right' }} onClick={function(e) { e.stopPropagation(); toggleSort(setItemSort, 'totalAmount', 'desc'); }}>
                                  Total Spent{sortArrow(itemSort, 'totalAmount')}
                                </th>
                                <th style={{ textAlign: 'center' }}>Status</th>
                              </tr>
                            </thead>
                            <tbody>
                              {sortedItems.map(function(r) {
                                var freqLabel = r.frequency === 'annual' ? 'Annual' : r.frequency === 'quarterly' ? 'Quarterly' : 'Monthly';
                                var itemCancelled = statuses[r.key] === 'cancelled';
                                return (
                                  <tr key={r.key} style={{ opacity: itemCancelled ? 0.5 : 1 }}>
                                    <td style={{ paddingLeft: 32 }}>
                                      <div className={styles.paymentName} style={{ textDecoration: itemCancelled ? 'line-through' : 'none' }}>{r.description}</div>
                                    </td>
                                    <td className={styles.accountCell}>{r.account}</td>
                                    <td style={{ textAlign: 'center' }} onClick={function(e) { e.stopPropagation(); }}>
                                      <button
                                        type="button"
                                        onClick={function() { cycleFrequency(r.key); }}
                                        title={r.freqOverridden
                                          ? 'Manual override: ' + freqLabel + '. Click to cycle (Monthly → Quarterly → Annual → Auto).'
                                          : 'Auto-detected: ' + freqLabel + '. Click to override.'}
                                        className={styles.freqBadge}
                                        style={{ border: r.freqOverridden ? '1px solid var(--color-secondary, #0058be)' : 'none', cursor: 'pointer', padding: '2px 8px' }}
                                      >
                                        {freqLabel}{r.freqOverridden ? '*' : ''}
                                      </button>
                                    </td>
                                    <td style={{ textAlign: 'center' }}>
                                      <span className={styles.freqBadge}>{r.occurrences}</span>
                                    </td>
                                    <td style={{ textAlign: 'right' }}>
                                      <div className={styles.amountMain}>{fmt(r.avgAmount)}</div>
                                      {!r.isFixed && (
                                        <div className={styles.amountRange}>{fmt(r.minAmount)} – {fmt(r.maxAmount)}</div>
                                      )}
                                    </td>
                                    <td style={{ textAlign: 'right' }}>
                                      <div className={styles.amountMain}>{fmt(r.totalAmount)}</div>
                                    </td>
                                    <td style={{ textAlign: 'center' }} onClick={function(e) { e.stopPropagation(); }}>
                                      <div className={styles.statusBtns}>
                                        <button className={statuses[r.key] === 'keep' ? styles.statusBtnKeepActive : styles.statusBtnKeep} onClick={function() { setStatus(r.key, 'keep'); }} title="Keep">Keep</button>
                                        <button className={statuses[r.key] === 'nomore' ? styles.statusBtnNomoreActive : styles.statusBtnNomore} onClick={function() { setStatus(r.key, 'nomore'); }} title="No More">No More</button>
                                        <button className={statuses[r.key] === 'getrid' ? styles.statusBtnGetridActive : styles.statusBtnGetrid} onClick={function() { setStatus(r.key, 'getrid'); }} title="Get Rid Of">Get Rid</button>
                                        <button className={statuses[r.key] === 'cancelled' ? styles.statusBtnCancelledActive : styles.statusBtnCancelled} onClick={function() { setStatus(r.key, 'cancelled'); }} title="Already cancelled">Cancelled</button>
                                      </div>
                                    </td>
                                  </tr>
                                );
                              })}
                            </tbody>
                          </table>
                        </td>
                      </tr>
                    )}
                  </Fragment>
                );
              })}
            </tbody>
            <tfoot>
              <tr>
                <td colSpan="5" style={{ fontWeight: 700 }}>Total</td>
                <td style={{ textAlign: 'right', fontWeight: 700 }}>{fmt(totalMonthly)}</td>
                <td style={{ textAlign: 'right', fontWeight: 700 }}>{fmt(totalSpentAll)}</td>
                <td />
              </tr>
            </tfoot>
          </table>
        </div>
      )}
    </div>
  );
}

