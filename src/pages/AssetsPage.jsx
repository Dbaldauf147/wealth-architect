import { useState } from 'react';
import { useData } from '../contexts/DataContext';
import styles from './AssetsPage.module.css';

function fmt(n) {
  if (n == null) return '—';
  return new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', minimumFractionDigits: 0, maximumFractionDigits: 0 }).format(n);
}

const HIDDEN_KEY = 'wa-hidden-accounts';
const CUSTOM_ASSETS_KEY = 'wa-custom-assets';
const CUSTOM_LIABILITIES_KEY = 'wa-custom-liabilities';

function loadJSON(key, fallback) {
  try { return JSON.parse(localStorage.getItem(key)) || fallback; } catch { return fallback; }
}
function saveJSON(key, val) { localStorage.setItem(key, JSON.stringify(val)); }

export function AssetsPage() {
  const { balances, loading, accountNicknames, setAccountNickname } = useData();
  const nicknames = accountNicknames || {};
  const [hidden, setHidden] = useState(() => loadJSON(HIDDEN_KEY, []));
  const [customAssets, setCustomAssets] = useState(() => loadJSON(CUSTOM_ASSETS_KEY, []));
  const [customLiabilities, setCustomLiabilities] = useState(() => loadJSON(CUSTOM_LIABILITIES_KEY, []));
  const [showHidden, setShowHidden] = useState(false);
  const [addingAsset, setAddingAsset] = useState(false);
  const [addingLiability, setAddingLiability] = useState(false);
  const [newName, setNewName] = useState('');
  const [newBalance, setNewBalance] = useState('');
  const [editingKey, setEditingKey] = useState(null);
  const [editValue, setEditValue] = useState('');

  const hiddenSet = new Set(hidden);

  function toggleHide(name) {
    const next = hiddenSet.has(name) ? hidden.filter(n => n !== name) : [...hidden, name];
    setHidden(next);
    saveJSON(HIDDEN_KEY, next);
  }

  function addCustomAsset() {
    const name = newName.trim();
    if (!name) return;
    const bal = parseFloat(newBalance.replace(/[$,]/g, '')) || 0;
    const next = [...customAssets, { name, balance: bal, updated: 'Manual', custom: true }];
    setCustomAssets(next);
    saveJSON(CUSTOM_ASSETS_KEY, next);
    setNewName(''); setNewBalance(''); setAddingAsset(false);
  }

  function addCustomLiability() {
    const name = newName.trim();
    if (!name) return;
    const bal = parseFloat(newBalance.replace(/[$,]/g, '')) || 0;
    const next = [...customLiabilities, { name, balance: bal, updated: 'Manual', custom: true }];
    setCustomLiabilities(next);
    saveJSON(CUSTOM_LIABILITIES_KEY, next);
    setNewName(''); setNewBalance(''); setAddingLiability(false);
  }

  function removeCustom(name, type) {
    if (type === 'asset') {
      const next = customAssets.filter(a => a.name !== name);
      setCustomAssets(next);
      saveJSON(CUSTOM_ASSETS_KEY, next);
    } else {
      const next = customLiabilities.filter(a => a.name !== name);
      setCustomLiabilities(next);
      saveJSON(CUSTOM_LIABILITIES_KEY, next);
    }
  }

  function startRename(originalName) {
    setEditingKey(originalName);
    setEditValue(nicknames[originalName] || originalName);
  }

  function saveRename() {
    if (!editingKey) return;
    const val = editValue.trim();
    setAccountNickname(editingKey, val && val !== editingKey ? val : null);
    setEditingKey(null);
    setEditValue('');
  }

  function cancelRename() {
    setEditingKey(null);
    setEditValue('');
  }

  function displayName(originalName) {
    return nicknames[originalName] || originalName;
  }

  if (loading) {
    return (
      <div className={styles.page}>
        <div className={styles.loadingWrapper}>
          <div>
            <span className={`material-symbols-outlined ${styles.loadingIcon}`}>progress_activity</span>
            <div className={styles.loadingText}>Loading balance sheet...</div>
          </div>
        </div>
      </div>
    );
  }

  if (!balances) {
    return (
      <div className={styles.page}>
        <div className={styles.emptyState}>
          <span className={`material-symbols-outlined ${styles.emptyIcon}`}>account_balance</span>
          <p>No balance data available. Connect your sheets to get started.</p>
        </div>
      </div>
    );
  }

  const allAssets = [...(balances.assets || []), ...customAssets].sort((a, b) => (b.balance || 0) - (a.balance || 0));
  const allLiabilities = [...(balances.liabilities || []), ...customLiabilities].sort((a, b) => (b.balance || 0) - (a.balance || 0));
  const assets = showHidden ? allAssets : allAssets.filter(a => !hiddenSet.has(a.name));
  const liabilities = showHidden ? allLiabilities : allLiabilities.filter(a => !hiddenSet.has(a.name));
  const hiddenCount = allAssets.filter(a => hiddenSet.has(a.name)).length + allLiabilities.filter(a => hiddenSet.has(a.name)).length;

  const netWorth = balances.netWorth ?? 0;
  const totalAssets = balances.totalAssets ?? 0;
  const totalLiabilities = balances.totalLiabilities ?? 0;

  const totalAbs = Math.abs(totalAssets) + Math.abs(totalLiabilities);
  const assetsPct = totalAbs > 0 ? (Math.abs(totalAssets) / totalAbs) * 100 : 50;
  const liabilitiesPct = totalAbs > 0 ? (Math.abs(totalLiabilities) / totalAbs) * 100 : 50;

  const debtToAsset = totalAssets > 0 ? Math.abs(totalLiabilities) / totalAssets : 0;
  const totalAccounts = assets.length + liabilities.length;

  const today = new Date().toLocaleDateString('en-US', { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' });

  return (
    <div className={styles.page}>
      {/* Page Header */}
      <div className={styles.pageHeader}>
        <div>
          <h1 className={styles.pageTitle}>Assets & Liabilities</h1>
          <div className={styles.pageSubtitle}>{today}</div>
        </div>
      </div>

      {/* Net Worth Hero */}
      <div className={styles.heroCard}>
        <div className={styles.heroLabel}>Net Worth</div>
        <div className={styles.heroValue}>{fmt(netWorth)}</div>

        <div className={styles.heroColumns}>
          <div className={styles.heroStat}>
            <div className={styles.heroStatLabel}>Total Assets</div>
            <div className={`${styles.heroStatValue} ${styles.heroStatAssets}`}>{fmt(totalAssets)}</div>
          </div>
          <div className={styles.heroStat}>
            <div className={styles.heroStatLabel}>Total Liabilities</div>
            <div className={`${styles.heroStatValue} ${styles.heroStatLiabilities}`}>{fmt(totalLiabilities)}</div>
          </div>
        </div>

        <div className={styles.barWrapper}>
          <div className={styles.barTrack}>
            <div className={styles.barAssets} style={{ width: `${assetsPct}%` }} />
            <div className={styles.barLiabilities} style={{ width: `${liabilitiesPct}%` }} />
          </div>
          <div className={styles.barLegend}>
            <span>
              <span className={styles.barLegendDot} style={{ background: '#34d399' }} />
              Assets {assetsPct.toFixed(1)}%
            </span>
            <span>
              <span className={styles.barLegendDot} style={{ background: '#f87171' }} />
              Liabilities {liabilitiesPct.toFixed(1)}%
            </span>
          </div>
        </div>
      </div>

      {/* Hidden toggle */}
      {hiddenCount > 0 && (
        <button className={styles.showHiddenBtn} onClick={() => setShowHidden(p => !p)}>
          <span className="material-symbols-outlined" style={{ fontSize: 16 }}>{showHidden ? 'visibility_off' : 'visibility'}</span>
          {showHidden ? 'Hide' : 'Show'} {hiddenCount} hidden account{hiddenCount !== 1 ? 's' : ''}
        </button>
      )}

      {/* Assets & Liabilities Side by Side */}
      <div className={styles.columnsGrid}>
        {/* Assets Column */}
        <div className={styles.section}>
          <div className={styles.sectionHeader}>
            <div className={styles.sectionTitle}>
              <span className="material-symbols-outlined" style={{ fontSize: 18, color: '#34d399' }}>trending_up</span>
              Assets
            </div>
            <div className={styles.sectionActions}>
              <div className={`${styles.sectionTotal} ${styles.balancePositive}`}>{fmt(totalAssets)}</div>
              <button className={styles.addBtn} onClick={() => { setAddingAsset(true); setAddingLiability(false); setNewName(''); setNewBalance(''); }}>
                <span className="material-symbols-outlined" style={{ fontSize: 16 }}>add</span>
              </button>
            </div>
          </div>

          <div className={styles.tableCard}>
            <div className={styles.tableHeader}>
              <div className={styles.tableHeaderCell}>Account</div>
              <div className={styles.tableHeaderCell}>Updated</div>
              <div className={styles.tableHeaderCell}>Balance</div>
            </div>

            {assets.length === 0 && (
              <div className={styles.emptyState}>
                <p>No asset accounts found.</p>
              </div>
            )}

            {assets.map((item, i) => (
              <div className={styles.tableRow} key={`asset-${i}`}>
                <div>
                  {editingKey === item.name ? (
                    <div className={styles.renameRow}>
                      <input
                        className={styles.renameInput}
                        value={editValue}
                        onChange={e => setEditValue(e.target.value)}
                        onKeyDown={e => { if (e.key === 'Enter') saveRename(); if (e.key === 'Escape') cancelRename(); }}
                        autoFocus
                      />
                      <button className={styles.renameSave} onClick={saveRename}>
                        <span className="material-symbols-outlined" style={{ fontSize: 16 }}>check</span>
                      </button>
                      <button className={styles.renameCancel} onClick={cancelRename}>
                        <span className="material-symbols-outlined" style={{ fontSize: 16 }}>close</span>
                      </button>
                    </div>
                  ) : (
                    <div className={styles.accountNameRow}>
                      <span className={styles.accountName}>{displayName(item.name)}</span>
                      <button className={styles.renameBtn} onClick={() => startRename(item.name)} title="Rename account">
                        <span className="material-symbols-outlined" style={{ fontSize: 14 }}>edit</span>
                      </button>
                      <button className={styles.hideBtn} onClick={() => toggleHide(item.name)} title={hiddenSet.has(item.name) ? 'Unhide' : 'Hide'}>
                        <span className="material-symbols-outlined" style={{ fontSize: 14 }}>{hiddenSet.has(item.name) ? 'visibility' : 'visibility_off'}</span>
                      </button>
                      {item.custom && (
                        <button className={styles.deleteBtn} onClick={() => removeCustom(item.name, 'asset')} title="Remove">
                          <span className="material-symbols-outlined" style={{ fontSize: 14 }}>delete</span>
                        </button>
                      )}
                    </div>
                  )}
                  {nicknames[item.name] && <div className={styles.originalName}>{item.name}</div>}
                </div>
                <div className={styles.updated}>{item.updated}</div>
                <div className={`${styles.balance} ${(item.balance || 0) >= 0 ? styles.balancePositive : styles.balanceNegative}`}>
                  {fmt(item.balance)}
                </div>
              </div>
            ))}
          </div>

          {addingAsset && (
            <div className={styles.addForm}>
              <input className={styles.addInput} placeholder="Account name" value={newName} onChange={e => setNewName(e.target.value)} autoFocus />
              <input className={styles.addInput} placeholder="$0" value={newBalance} onChange={e => setNewBalance(e.target.value)} style={{ width: 100 }} />
              <button className={styles.renameSave} onClick={addCustomAsset}><span className="material-symbols-outlined" style={{ fontSize: 16 }}>check</span></button>
              <button className={styles.renameCancel} onClick={() => setAddingAsset(false)}><span className="material-symbols-outlined" style={{ fontSize: 16 }}>close</span></button>
            </div>
          )}
        </div>

        {/* Liabilities Column */}
        <div className={styles.section}>
          <div className={styles.sectionHeader}>
            <div className={styles.sectionTitle}>
              <span className="material-symbols-outlined" style={{ fontSize: 18, color: '#f87171' }}>trending_down</span>
              Liabilities
            </div>
            <div className={styles.sectionActions}>
              <div className={`${styles.sectionTotal} ${styles.balanceNegative}`}>{fmt(totalLiabilities)}</div>
              <button className={styles.addBtn} onClick={() => { setAddingLiability(true); setAddingAsset(false); setNewName(''); setNewBalance(''); }}>
                <span className="material-symbols-outlined" style={{ fontSize: 16 }}>add</span>
              </button>
            </div>
          </div>

          <div className={styles.tableCard}>
            <div className={styles.tableHeader}>
              <div className={styles.tableHeaderCell}>Account</div>
              <div className={styles.tableHeaderCell}>Updated</div>
              <div className={styles.tableHeaderCell}>Balance</div>
            </div>

            {liabilities.length === 0 && (
              <div className={styles.emptyState}>
                <p>No liability accounts found.</p>
              </div>
            )}

            {liabilities.map((item, i) => (
              <div className={styles.tableRow} key={`liability-${i}`}>
                <div>
                  {editingKey === item.name ? (
                    <div className={styles.renameRow}>
                      <input
                        className={styles.renameInput}
                        value={editValue}
                        onChange={e => setEditValue(e.target.value)}
                        onKeyDown={e => { if (e.key === 'Enter') saveRename(); if (e.key === 'Escape') cancelRename(); }}
                        autoFocus
                      />
                      <button className={styles.renameSave} onClick={saveRename}>
                        <span className="material-symbols-outlined" style={{ fontSize: 16 }}>check</span>
                      </button>
                      <button className={styles.renameCancel} onClick={cancelRename}>
                        <span className="material-symbols-outlined" style={{ fontSize: 16 }}>close</span>
                      </button>
                    </div>
                  ) : (
                    <div className={styles.accountNameRow}>
                      <span className={styles.accountName}>{displayName(item.name)}</span>
                      <button className={styles.renameBtn} onClick={() => startRename(item.name)} title="Rename account">
                        <span className="material-symbols-outlined" style={{ fontSize: 14 }}>edit</span>
                      </button>
                      <button className={styles.hideBtn} onClick={() => toggleHide(item.name)} title={hiddenSet.has(item.name) ? 'Unhide' : 'Hide'}>
                        <span className="material-symbols-outlined" style={{ fontSize: 14 }}>{hiddenSet.has(item.name) ? 'visibility' : 'visibility_off'}</span>
                      </button>
                      {item.custom && (
                        <button className={styles.deleteBtn} onClick={() => removeCustom(item.name, 'liability')} title="Remove">
                          <span className="material-symbols-outlined" style={{ fontSize: 14 }}>delete</span>
                        </button>
                      )}
                    </div>
                  )}
                  {nicknames[item.name] && <div className={styles.originalName}>{item.name}</div>}
                </div>
                <div className={styles.updated}>{item.updated}</div>
                <div className={`${styles.balance} ${styles.balanceNegative}`}>
                  {fmt(item.balance)}
                </div>
              </div>
            ))}
          </div>

          {addingLiability && (
            <div className={styles.addForm}>
              <input className={styles.addInput} placeholder="Account name" value={newName} onChange={e => setNewName(e.target.value)} autoFocus />
              <input className={styles.addInput} placeholder="$0" value={newBalance} onChange={e => setNewBalance(e.target.value)} style={{ width: 100 }} />
              <button className={styles.renameSave} onClick={addCustomLiability}><span className="material-symbols-outlined" style={{ fontSize: 16 }}>check</span></button>
              <button className={styles.renameCancel} onClick={() => setAddingLiability(false)}><span className="material-symbols-outlined" style={{ fontSize: 16 }}>close</span></button>
            </div>
          )}
        </div>
      </div>

      {/* Summary Footer */}
      <div className={styles.summaryFooter}>
        <div className={styles.summaryItem}>
          <div className={styles.summaryLabel}>Debt-to-Asset Ratio</div>
          <div className={styles.summaryValue}>{(debtToAsset * 100).toFixed(1)}%</div>
        </div>
        <div className={styles.summaryItem}>
          <div className={styles.summaryLabel}>Total Accounts</div>
          <div className={styles.summaryValue}>{totalAccounts}</div>
        </div>
        <div className={styles.summaryItem}>
          <div className={styles.summaryLabel}>Net Worth</div>
          <div className={styles.summaryValue}>{fmt(netWorth)}</div>
        </div>
      </div>
    </div>
  );
}

export default AssetsPage;
