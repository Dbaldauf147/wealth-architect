import { useState, useMemo } from 'react';

const PERIOD_LABELS = { weekly: '/ week', monthly: '/ month', annual: '/ year' };

function getDateRange(period) {
  const now = new Date();
  if (period === 'weekly') {
    const day = now.getDay();
    const start = new Date(now);
    start.setDate(now.getDate() - day);
    start.setHours(0, 0, 0, 0);
    return { start, end: now };
  }
  if (period === 'annual') {
    return { start: new Date(now.getFullYear(), 0, 1), end: now };
  }
  return { start: new Date(now.getFullYear(), now.getMonth(), 1), end: now };
}

export function BudgetCard({ budget, onUpdate, onDelete, onAddSub, onUpdateSub, onDeleteSub, transactions, selectedMonth, styles }) {
  const [editing, setEditing] = useState(false);
  const [showTxns, setShowTxns] = useState(false);
  const [name, setName] = useState(budget.name);
  const [limit, setLimit] = useState(budget.monthlyLimit);
  const [icon, setIcon] = useState(budget.icon);
  const [color, setColor] = useState(budget.color);
  const [period, setPeriod] = useState(budget.period || 'monthly');
  const [confirmDelete, setConfirmDelete] = useState(false);

  const [addingSub, setAddingSub] = useState(false);
  const [subName, setSubName] = useState('');
  const [subLimit, setSubLimit] = useState('');
  const [editingSubId, setEditingSubId] = useState(null);
  const [editSubName, setEditSubName] = useState('');
  const [editSubLimit, setEditSubLimit] = useState('');

  var budgetPeriod = budget.period || 'monthly';

  var spent = useMemo(function() {
    if (!transactions) return 0;
    if (selectedMonth) {
      var total = 0;
      for (var i = 0; i < transactions.length; i++) {
        var t = transactions[i];
        if (t.amount < 0 && t.month === selectedMonth && (t.category || '').toLowerCase() === budget.name.toLowerCase()) {
          total += Math.abs(t.amount);
        }
      }
      return total;
    }
    var range = getDateRange(budgetPeriod);
    var sum = 0;
    for (var j = 0; j < transactions.length; j++) {
      var tx = transactions[j];
      if (tx.amount >= 0) continue;
      if ((tx.category || '').toLowerCase() !== budget.name.toLowerCase()) continue;
      var d = new Date(tx.date);
      if (d >= range.start && d <= range.end) sum += Math.abs(tx.amount);
    }
    return sum;
  }, [transactions, budgetPeriod, budget.name, selectedMonth]);

  var budgetTxns = useMemo(function() {
    if (!transactions) return [];
    var result = [];
    for (var i = 0; i < transactions.length; i++) {
      var t = transactions[i];
      if (t.amount >= 0) continue;
      if ((t.category || '').toLowerCase() !== budget.name.toLowerCase()) continue;
      if (selectedMonth) {
        if (t.month === selectedMonth) result.push(t);
      } else {
        var range = getDateRange(budgetPeriod);
        var d = new Date(t.date);
        if (d >= range.start && d <= range.end) result.push(t);
      }
    }
    result.sort(function(a, b) { return new Date(b.date) - new Date(a.date); });
    return result;
  }, [transactions, budget.name, budgetPeriod, selectedMonth]);

  var pct = budget.monthlyLimit > 0 ? Math.round((spent / budget.monthlyLimit) * 100) : 0;
  var barPct = Math.min(100, pct);
  var overAmount = spent - (budget.monthlyLimit || 0);
  var barColor = pct >= 90 ? '#ba1a1a' : pct >= 70 ? '#e8a317' : (budget.color || '#0058be');

  var subs = budget.subBudgets || [];

  function handleSave() {
    onUpdate(budget.id, { name: name, monthlyLimit: Number(limit) || 0, icon: icon, color: color, period: period });
    setEditing(false);
  }

  function handleCancel() {
    setName(budget.name);
    setLimit(budget.monthlyLimit);
    setIcon(budget.icon);
    setColor(budget.color);
    setPeriod(budget.period || 'monthly');
    setEditing(false);
    setConfirmDelete(false);
  }

  function handleAddSub() {
    if (!subName.trim()) return;
    onAddSub(budget.id, { name: subName.trim(), monthlyLimit: Number(subLimit) || 0 });
    setSubName('');
    setSubLimit('');
    setAddingSub(false);
  }

  function handleSaveSub(subId) {
    onUpdateSub(budget.id, subId, { name: editSubName, monthlyLimit: Number(editSubLimit) || 0 });
    setEditingSubId(null);
  }

  return (
    <div>
      <div className={(styles.budgetCard || '') + (editing ? ' ' + (styles.budgetCardEditing || '') : '')}>
        <div className={styles.budgetRow}>
          <div className={styles.budgetIconWrap} style={{ background: (color || '#0058be') + '14', color: color || '#0058be' }}>
            <span className="material-symbols-outlined">{icon || 'savings'}</span>
          </div>

          {editing ? (
            <div style={{ display: 'flex', alignItems: 'center', gap: 6, flex: 1, flexWrap: 'wrap' }}>
              <input className={styles.budgetInput} value={name} onChange={function(e) { setName(e.target.value); }} placeholder="Name" style={{ width: 140 }} />
              <span style={{ fontSize: 13, color: '#999' }}>$</span>
              <input className={styles.budgetInput} type="number" value={limit} onChange={function(e) { setLimit(e.target.value); }} placeholder="Limit" style={{ width: 80 }} />
              <select className={styles.budgetInput} value={period} onChange={function(e) { setPeriod(e.target.value); }} style={{ width: 90 }}>
                <option value="weekly">Weekly</option>
                <option value="monthly">Monthly</option>
                <option value="annual">Annual</option>
              </select>
              <input className={styles.budgetInput} value={icon} onChange={function(e) { setIcon(e.target.value); }} placeholder="Icon" style={{ width: 80 }} />
              <input type="color" value={color || '#0058be'} onChange={function(e) { setColor(e.target.value); }} style={{ width: 28, height: 28, border: 'none', padding: 0, cursor: 'pointer' }} />
              <button className={styles.budgetSaveBtn} onClick={handleSave}>Save</button>
              <button className={styles.budgetCancelBtn} onClick={handleCancel}>Cancel</button>
              <button className={styles.budgetDeleteBtn} onClick={function() { setConfirmDelete(true); }}>
                <span className="material-symbols-outlined" style={{ fontSize: 14 }}>delete</span>
              </button>
            </div>
          ) : (
            <React_Fragment>
              <div style={{ flex: 1, minWidth: 0, cursor: 'pointer' }} onClick={function() { setShowTxns(!showTxns); }}>
                <div className={styles.budgetName}>
                  {budget.name}
                  {budgetTxns.length > 0 && (
                    <span style={{ marginLeft: 6, fontSize: 11, color: '#999', fontWeight: 400 }}>
                      {budgetTxns.length} txn{budgetTxns.length !== 1 ? 's' : ''} {showTxns ? '\u25BE' : '\u25B8'}
                    </span>
                  )}
                </div>
                {budget.monthlyLimit > 0 && (
                  <div className={styles.progressRow}>
                    <div className={styles.progressBar}>
                      <div className={styles.progressFill} style={{ width: barPct + '%', background: barColor }} />
                    </div>
                    <span className={styles.progressLabel} style={{ color: barColor }}>{pct}%</span>
                    {pct > 100 && (
                      <span className={styles.overBudget}>+${Math.round(overAmount).toLocaleString()} over</span>
                    )}
                  </div>
                )}
              </div>
              <div className={styles.spentInfo}>
                <div className={styles.budgetLimitValue}>${Math.round(spent).toLocaleString()}</div>
                <div className={styles.budgetLimitLabel}>of ${(budget.monthlyLimit || 0).toLocaleString()} {PERIOD_LABELS[budgetPeriod]}</div>
              </div>
              <button className={styles.budgetEditBtn} onClick={function() { setEditing(true); }} title="Edit">
                <span className="material-symbols-outlined" style={{ fontSize: 16 }}>edit</span>
              </button>
              <button className={styles.budgetEditBtn} onClick={function() { setAddingSub(true); }} title="Add Sub-Budget">
                <span className="material-symbols-outlined" style={{ fontSize: 16 }}>add</span>
              </button>
            </React_Fragment>
          )}
        </div>

        {confirmDelete && (
          <div className={styles.budgetConfirm}>
            <span>Delete &quot;{budget.name}&quot; and all sub-budgets?</span>
            <button className={styles.budgetDeleteConfirmBtn} onClick={function() { onDelete(budget.id); setConfirmDelete(false); }}>Yes, delete</button>
            <button className={styles.budgetCancelBtn} onClick={function() { setConfirmDelete(false); }}>Cancel</button>
          </div>
        )}

        {showTxns && budgetTxns.length > 0 && (
          <div className={styles.txnList}>
            <table className={styles.txnTable}>
              <thead>
                <tr><th>Date</th><th>Description</th><th>Account</th><th style={{ textAlign: 'right' }}>Amount</th></tr>
              </thead>
              <tbody>
                {budgetTxns.map(function(t, i) {
                  return (
                    <tr key={t.transactionId || i}>
                      <td>{t.date}</td>
                      <td>{t.description}</td>
                      <td>{t.account}</td>
                      <td style={{ textAlign: 'right', fontWeight: 600 }}>${Math.abs(t.amount).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {subs.map(function(sub) {
        return (
          <div key={sub.id} className={styles.subBudgetCard}>
            <div className={styles.budgetRow}>
              <div className={styles.subBudgetConnector} style={{ borderColor: (color || '#0058be') + '40' }} />
              {editingSubId === sub.id ? (
                <div style={{ display: 'flex', alignItems: 'center', gap: 6, flex: 1 }}>
                  <input className={styles.subInput} value={editSubName} onChange={function(e) { setEditSubName(e.target.value); }} style={{ flex: 1 }} />
                  <span style={{ fontSize: 12, color: '#999' }}>$</span>
                  <input className={styles.subInput} type="number" value={editSubLimit} onChange={function(e) { setEditSubLimit(e.target.value); }} style={{ width: 70 }} />
                  <button className={styles.subIconBtn} onClick={function() { handleSaveSub(sub.id); }}><span className="material-symbols-outlined" style={{ fontSize: 14 }}>check</span></button>
                  <button className={styles.subIconBtn} onClick={function() { setEditingSubId(null); }}><span className="material-symbols-outlined" style={{ fontSize: 14 }}>close</span></button>
                </div>
              ) : (
                <React_Fragment>
                  <div style={{ flex: 1, minWidth: 0 }}><div className={styles.subBudgetName}>{sub.name}</div></div>
                  <div className={styles.subBudgetLimitValue}>${(sub.monthlyLimit || 0).toLocaleString()}</div>
                  <div className={styles.budgetLimitLabel}>/ month</div>
                  <button className={styles.budgetEditBtn} onClick={function() { setEditingSubId(sub.id); setEditSubName(sub.name); setEditSubLimit(sub.monthlyLimit); }}><span className="material-symbols-outlined" style={{ fontSize: 14 }}>edit</span></button>
                  <button className={styles.budgetEditBtn} onClick={function() { onDeleteSub(budget.id, sub.id); }}><span className="material-symbols-outlined" style={{ fontSize: 14 }}>close</span></button>
                </React_Fragment>
              )}
            </div>
          </div>
        );
      })}

      {addingSub && (
        <div className={styles.subBudgetCard}>
          <div className={styles.budgetRow}>
            <div className={styles.subBudgetConnector} style={{ borderColor: (color || '#0058be') + '40' }} />
            <div style={{ display: 'flex', alignItems: 'center', gap: 6, flex: 1 }}>
              <input className={styles.subInput} value={subName} onChange={function(e) { setSubName(e.target.value); }} placeholder="Sub-budget name" autoFocus style={{ flex: 1 }} />
              <span style={{ fontSize: 12, color: '#999' }}>$</span>
              <input className={styles.subInput} type="number" value={subLimit} onChange={function(e) { setSubLimit(e.target.value); }} placeholder="Limit" style={{ width: 70 }} />
              <button className={styles.subIconBtn} onClick={handleAddSub}><span className="material-symbols-outlined" style={{ fontSize: 14 }}>check</span></button>
              <button className={styles.subIconBtn} onClick={function() { setAddingSub(false); setSubName(''); setSubLimit(''); }}><span className="material-symbols-outlined" style={{ fontSize: 14 }}>close</span></button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

// Avoid JSX fragment syntax that may cause bundler issues
function React_Fragment(props) { return props.children; }
