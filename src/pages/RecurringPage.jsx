import { Fragment, useMemo, useState } from 'react';
import { useData } from '../contexts/DataContext';
import styles from './RecurringPage.module.css';

function fmt(n) {
  return new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(Math.abs(n));
}

function fmtShort(n) {
  return new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', minimumFractionDigits: 0, maximumFractionDigits: 0 }).format(Math.abs(n));
}

var STATUS_KEY = 'wa-recurring-status';

function loadStatuses() {
  try { return JSON.parse(localStorage.getItem(STATUS_KEY) || '{}'); } catch { return {}; }
}

function saveStatuses(map) {
  localStorage.setItem(STATUS_KEY, JSON.stringify(map));
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

  var recurring = useMemo(function() {
    if (!transactions || transactions.length === 0) return [];

    // Group subscriptions by description
    var groups = {};
    for (var i = 0; i < transactions.length; i++) {
      var t = transactions[i];
      var sub = (t.subcategory || '').toLowerCase();
      if (sub !== 'subscriptions') continue;
      var desc = (t.description || '').trim();
      if (!desc) continue;
      var key = desc.toLowerCase();
      if (!groups[key]) {
        groups[key] = { description: desc, category: t.category || 'Uncategorized', months: {}, account: t.account || '', txns: [] };
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

      // Determine frequency
      var sortedTxns = g.txns.slice().sort(function(a, b) { return new Date(a.date) - new Date(b.date); });
      var frequency = 'monthly';
      if (sortedTxns.length >= 2) {
        var firstDate = new Date(sortedTxns[0].date);
        var lastDate = new Date(sortedTxns[sortedTxns.length - 1].date);
        var totalDays = (lastDate - firstDate) / (1000 * 60 * 60 * 24);
        var avgDaysBetween = totalDays / (sortedTxns.length - 1);
        if (avgDaysBetween > 180) frequency = 'annual';
        else if (avgDaysBetween > 60) frequency = 'quarterly';
      }

      var annualEstimate = frequency === 'annual' ? avgAmount : frequency === 'quarterly' ? avgAmount * 4 : avgAmount * 12;

      result.push({
        key: itemKey,
        description: g.description,
        category: g.category,
        account: g.account,
        avgAmount: avgAmount,
        totalAmount: totalAmt,
        occurrences: g.txns.length,
        monthCount: monthCount,
        frequency: frequency,
        isFixed: isFixed,
        minAmount: minAmount,
        maxAmount: maxAmount,
        annualEstimate: annualEstimate,
        txns: sortedTxns.reverse(),
      });
    }

    // Sort by average amount, largest first
    result.sort(function(a, b) { return b.avgAmount - a.avgAmount; });
    return result;
  }, [transactions]);

  var expandedIdx = useState(null);
  var expanded = expandedIdx[0];
  var setExpanded = expandedIdx[1];

  var totalMonthly = 0;
  var totalAnnual = 0;
  var keepMonthly = 0;
  var getRidMonthly = 0;
  var noMoreMonthly = 0;
  for (var i = 0; i < recurring.length; i++) {
    totalMonthly += recurring[i].avgAmount;
    totalAnnual += recurring[i].annualEstimate;
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
                <th>Payment</th>
                <th>Category</th>
                <th>Account</th>
                <th style={{ textAlign: 'center' }}>Frequency</th>
                <th style={{ textAlign: 'right' }}>Avg Amount</th>
                <th style={{ textAlign: 'right' }}>Annual Est.</th>
                <th style={{ textAlign: 'center' }}>Status</th>
              </tr>
            </thead>
            <tbody>
              {['monthly', 'quarterly', 'annual'].map(function(freq) {
                var items = recurring.filter(function(r) { return r.frequency === freq; });
                if (items.length === 0) return null;
                var freqLabel = freq === 'monthly' ? 'Monthly' : freq === 'quarterly' ? 'Quarterly' : 'Annual';
                var freqTotal = 0;
                for (var fi = 0; fi < items.length; fi++) freqTotal += items[fi].avgAmount;
                var freqAnnual = freq === 'annual' ? freqTotal : freq === 'quarterly' ? freqTotal * 4 : freqTotal * 12;
                return (
                  <Fragment key={freq}>
                    <tr className={styles.sectionHeaderRow}>
                      <td colSpan="5">
                        <span className={styles.sectionHeaderLabel}>{freqLabel}</span>
                        <span className={styles.sectionHeaderCount}>{items.length} payment{items.length !== 1 ? 's' : ''}</span>
                      </td>
                      <td style={{ textAlign: 'right' }}>
                        <span className={styles.sectionHeaderAmount}>{fmtShort(freqAnnual)}/yr</span>
                      </td>
                      <td></td>
                    </tr>
                    {items.map(function(r) {
                var i = recurring.indexOf(r);
                var isOpen = expanded === i;
                return (
                  <Fragment key={i}>
                    <tr style={{ cursor: 'pointer' }} onClick={function() { setExpanded(isOpen ? null : i); }}>
                      <td>
                        <div className={styles.paymentName}>
                          <span className={styles.expandArrow}>{isOpen ? '\u25BE' : '\u25B8'}</span>
                          {r.description}
                        </div>
                      </td>
                      <td>
                        <span className={styles.categoryBadge}>{r.category}</span>
                      </td>
                      <td className={styles.accountCell}>{r.account}</td>
                      <td style={{ textAlign: 'center' }}>
                        <span className={styles.freqBadge}>{r.monthCount} months</span>
                      </td>
                      <td style={{ textAlign: 'right' }}>
                        <div className={styles.amountMain}>{fmt(r.avgAmount)}</div>
                        {!r.isFixed && (
                          <div className={styles.amountRange}>{fmt(r.minAmount)} – {fmt(r.maxAmount)}</div>
                        )}
                      </td>
                      <td style={{ textAlign: 'right' }}>
                        <div className={styles.annualAmount}>{fmtShort(r.annualEstimate)}</div>
                      </td>
                      <td style={{ textAlign: 'center' }} onClick={function(e) { e.stopPropagation(); }}>
                        <div className={styles.statusBtns}>
                          <button className={statuses[r.key] === 'keep' ? styles.statusBtnKeepActive : styles.statusBtnKeep} onClick={function() { setStatus(r.key, 'keep'); }} title="Keep">Keep</button>
                          <button className={statuses[r.key] === 'nomore' ? styles.statusBtnNomoreActive : styles.statusBtnNomore} onClick={function() { setStatus(r.key, 'nomore'); }} title="No More">No More</button>
                          <button className={statuses[r.key] === 'getrid' ? styles.statusBtnGetridActive : styles.statusBtnGetrid} onClick={function() { setStatus(r.key, 'getrid'); }} title="Get Rid Of">Get Rid</button>
                        </div>
                      </td>
                    </tr>
                    {isOpen && r.txns.map(function(t, ti) {
                      return (
                        <tr key={'txn-' + ti} className={styles.txnDetailRow}>
                          <td colSpan="2" style={{ paddingLeft: 40 }}>
                            <span className={styles.txnDate}>{t.date}</span>
                          </td>
                          <td>{t.account}</td>
                          <td></td>
                          <td style={{ textAlign: 'right' }}>
                            <span className={styles.txnAmount}>{fmt(t.amount)}</span>
                          </td>
                          <td></td>
                          <td></td>
                        </tr>
                      );
                    })}
                  </Fragment>
                );
              })}
                  </Fragment>
                );
              })}
            </tbody>
            <tfoot>
              <tr>
                <td colSpan="4" style={{ fontWeight: 700 }}>Total</td>
                <td style={{ textAlign: 'right', fontWeight: 700 }}>{fmt(totalMonthly)}</td>
                <td style={{ textAlign: 'right', fontWeight: 700 }}>{fmtShort(totalAnnual)}</td>
                <td></td>
              </tr>
            </tfoot>
          </table>
        </div>
      )}
    </div>
  );
}

