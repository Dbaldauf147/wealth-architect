const API_KEY = 'AIzaSyAEwH8sUimujARd4c1gAv_9bhhfNN9dVI4';
const SHEET_ID = '1G9dU4_Lt0vVHeH3UzwDUUc-fFs6rAy7d9THKYtOebCY';

async function fetchSheet(tabName, range) {
  const url = `https://sheets.googleapis.com/v4/spreadsheets/${SHEET_ID}/values/${encodeURIComponent(tabName)}!${range}?key=${API_KEY}`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Sheets API error: ${res.status}`);
  const data = await res.json();
  return data.values || [];
}

// Parse Transactions tab — headers in row 1 starting at column B
export async function fetchTransactions() {
  const rows = await fetchSheet('Transactions', 'B1:O10000');
  if (rows.length < 2) return [];
  const headers = rows[0]; // Date, Description, Category, Amount, Account, Account #, Institution, Month, Week, Transaction ID, Account ID, Check Number, Full Description, Date Added
  return rows.slice(1).map(row => {
    const obj = {};
    headers.forEach((h, i) => {
      obj[h] = row[i] || '';
    });
    return {
      date: obj['Date'] || '',
      description: obj['Description'] || '',
      category: obj['Category'] || '',
      amount: parseFloat((obj['Amount'] || '0').replace(/[$,]/g, '')) || 0,
      account: obj['Account'] || '',
      accountNum: obj['Account #'] || '',
      institution: obj['Institution'] || '',
      month: obj['Month'] || '',
      week: obj['Week'] || '',
      transactionId: obj['Transaction ID'] || '',
      fullDescription: obj['Full Description'] || '',
      dateAdded: obj['Date Added'] || '',
    };
  }).filter(t => t.date && t.description); // filter out empty rows
}

// Parse Balances tab — freeform Tiller layout
export async function fetchBalances() {
  const rows = await fetchSheet('Balances', 'A1:H50');

  let netWorth = 0;
  let totalAssets = 0;
  let totalLiabilities = 0;
  const assets = [];
  const liabilities = [];
  let section = null; // 'assets-header' or 'assets-items' or 'liabilities'

  for (const row of rows) {
    const a = (row[0] || '').trim();
    const b = (row[1] || '').trim();
    const c = (row[2] || '').trim();
    const e = (row[4] || '').trim();
    const f = (row[5] || '').trim();
    const g = (row[6] || '').trim();

    // Net worth row
    if (a === 'NET WORTH') {
      netWorth = parseMoney(c);
      continue;
    }

    // Assets / Liabilities totals row
    if (a === 'ASSETS') {
      totalAssets = parseMoney(c);
      totalLiabilities = parseMoney(g);
      continue;
    }

    // Section headers
    if (a === 'UNGROUPED ASSET') {
      section = 'assets';
      continue;
    }

    // Parse asset rows (left side: cols A, B, C)
    // Parse liability rows (right side: cols E, F, G)
    if (section === 'assets') {
      // Asset row
      if (a && b && c) {
        const balance = parseMoney(c);
        assets.push({
          name: a,
          updated: b,
          balance,
        });
      }
      // Liability row (same rows, right side)
      if (e && f) {
        const balance = parseMoney(g);
        liabilities.push({
          name: e,
          updated: f,
          balance,
        });
      }
    }
  }

  return { netWorth, totalAssets, totalLiabilities, assets, liabilities };
}

function parseMoney(str) {
  if (!str) return 0;
  const cleaned = str.replace(/[$,]/g, '');
  return parseFloat(cleaned) || 0;
}

// Derived analytics
export function computeAnalytics(transactions) {
  const byCategory = {};
  const byAccount = {};
  const byMonth = {};
  let totalIncome = 0;
  let totalExpenses = 0;

  for (const t of transactions) {
    // Category breakdown
    const cat = t.category || 'Uncategorized';
    if (!byCategory[cat]) byCategory[cat] = { total: 0, count: 0 };
    byCategory[cat].total += t.amount;
    byCategory[cat].count += 1;

    // Account breakdown
    const acct = t.account || 'Unknown';
    if (!byAccount[acct]) byAccount[acct] = { total: 0, count: 0 };
    byAccount[acct].total += t.amount;
    byAccount[acct].count += 1;

    // Monthly breakdown
    const month = t.month || 'Unknown';
    if (!byMonth[month]) byMonth[month] = { income: 0, expenses: 0 };
    if (t.amount > 0) {
      byMonth[month].income += t.amount;
      totalIncome += t.amount;
    } else {
      byMonth[month].expenses += Math.abs(t.amount);
      totalExpenses += Math.abs(t.amount);
    }
  }

  // Sort categories by absolute total
  const categoryList = Object.entries(byCategory)
    .map(([name, data]) => ({ name, ...data, absTotal: Math.abs(data.total) }))
    .sort((a, b) => b.absTotal - a.absTotal);

  // Sort accounts by absolute total
  const accountList = Object.entries(byAccount)
    .map(([name, data]) => ({ name, ...data, absTotal: Math.abs(data.total) }))
    .sort((a, b) => b.absTotal - a.absTotal);

  // Unique account names for filters
  const accountNames = [...new Set(transactions.map(t => t.account).filter(Boolean))].sort();

  return {
    byCategory: categoryList,
    byAccount: accountList,
    byMonth,
    accountNames,
    totalIncome,
    totalExpenses,
    cashFlow: totalIncome - totalExpenses,
    transactionCount: transactions.length,
  };
}
