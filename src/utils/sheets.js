const API_KEY = import.meta.env.VITE_SHEETS_API_KEY;
const SHEET_ID = import.meta.env.VITE_SHEETS_SHEET_ID;

async function fetchSheet(tabName, range) {
  if (!API_KEY || !SHEET_ID) {
    throw new Error('Missing VITE_SHEETS_API_KEY or VITE_SHEETS_SHEET_ID — set them in .env (and in Vercel env vars for deployments).');
  }
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
// Data is offset: col A is empty, real data starts at col B
// So in the array: index 0=A(empty), 1=B, 2=C, 3=D, 4=E(empty), 5=F, 6=G, 7=H
export async function fetchBalances() {
  const rows = await fetchSheet('Balances', 'A1:H50');

  let netWorth = 0;
  let totalAssets = 0;
  let totalLiabilities = 0;
  const assets = [];
  const liabilities = [];
  let section = null;

  for (const row of rows) {
    // Col B=1, C=2, D=3, F=5, G=6, H=7
    const colB = (row[1] || '').trim();
    const colC = (row[2] || '').trim();
    const colD = (row[3] || '').trim();
    const colF = (row[5] || '').trim();
    const colG = (row[6] || '').trim();
    const colH = (row[7] || '').trim();

    // Net worth row: B="NET WORTH", H="$887,682"
    if (colB === 'NET WORTH') {
      netWorth = parseMoney(colH);
      continue;
    }

    // Assets / Liabilities totals row: B="ASSETS", D="$898,830", F="LIABILITIES", H="$11,148"
    if (colB === 'ASSETS') {
      totalAssets = parseMoney(colD);
      totalLiabilities = parseMoney(colH);
      continue;
    }

    // Section header: B="UNGROUPED ASSET"
    if (colB === 'UNGROUPED ASSET') {
      section = 'assets';
      continue;
    }

    // Asset rows (left): B=name, C=updated, D=balance
    // Liability rows (right): F=name, G=updated, H=balance
    if (section === 'assets') {
      if (colB && colC && colD) {
        const balance = parseMoney(colD);
        assets.push({
          name: colB,
          updated: colC,
          balance,
        });
      }
      if (colF && colG) {
        const balance = parseMoney(colH);
        liabilities.push({
          name: colF,
          updated: colG,
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

// Parse Tiller's "Balance History" tab. Standard columns:
// Date | Time | Account | Account # | Account ID | Institution | Account Type
// | Account Status | Class | Balance | ...
// Layout varies between Tiller templates (some prepend an empty col A, some
// don't), so we locate the header row and resolve column indices by name
// instead of hard-coding positions.
export async function fetchBalanceHistory() {
  let rows;
  try {
    rows = await fetchSheet('Balance History', 'A1:Z20000');
  } catch (err) {
    // Tab not present on this user's spreadsheet — return empty so callers
    // can render gracefully.
    console.warn('Balance History sheet not available:', err.message);
    return [];
  }
  if (rows.length < 2) return [];

  let headerIdx = -1;
  for (let i = 0; i < Math.min(5, rows.length); i++) {
    const r = rows[i] || [];
    const hasDate = r.some(c => /^date$/i.test((c || '').trim()));
    const hasBalance = r.some(c => /^balance$/i.test((c || '').trim()));
    if (hasDate && hasBalance) { headerIdx = i; break; }
  }
  if (headerIdx === -1) return [];

  const headers = rows[headerIdx].map(h => (h || '').trim());
  const idxOf = name => headers.findIndex(h => h.toLowerCase() === name.toLowerCase());
  const dateI = idxOf('Date');
  const balI = idxOf('Balance');
  const acctI = idxOf('Account');
  const acctNumI = idxOf('Account #');
  const acctIdI = idxOf('Account ID');
  const instI = idxOf('Institution');
  if (dateI === -1 || balI === -1) return [];

  const out = [];
  for (let r = headerIdx + 1; r < rows.length; r++) {
    const row = rows[r] || [];
    const date = (row[dateI] || '').trim();
    if (!date) continue;
    out.push({
      date,
      account: acctI !== -1 ? (row[acctI] || '').trim() : '',
      accountNum: acctNumI !== -1 ? (row[acctNumI] || '').trim() : '',
      accountId: acctIdI !== -1 ? (row[acctIdI] || '').trim() : '',
      institution: instI !== -1 ? (row[instI] || '').trim() : '',
      balance: parseMoney((row[balI] || '').trim()),
    });
  }
  return out;
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
