/* Build the Excel workbook attached to the day-before payment reminder.
   Server-only: exceljs is a heavy dependency and must never reach the
   client bundle, so this lives under api/_lib rather than src/lib
   (underscore-prefixed paths are excluded from Vercel's function routing).

   Workbook layout:
     • Summary        — one row per card due, plus the paying-account math
     • <Card name>    — every charge since that card's last payment (the
                        line items that sum to the projected amount)
     • Payment History— historical payments behind the date projection */

import ExcelJS from 'exceljs';

const HEADER_FILL = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF0058BE' } };
const MONEY = '$#,##0.00';
const DATE_FMT = 'yyyy-mm-dd';

function parseDate(v) {
  if (!v) return null;
  const d = v instanceof Date ? v : new Date(v);
  return isNaN(d) ? null : d;
}

// Summing floats leaves cents like 603.6500000000001 in the cell. The currency
// format hides it, but the raw value shows up in the formula bar and in any
// downstream math, so round on the way in.
function money(n) {
  const v = Number(n);
  return Number.isFinite(v) ? Math.round(v * 100) / 100 : 0;
}

// Excel sheet names cap at 31 chars and forbid : \ / ? * [ ]. Collisions are
// resolved with a numeric suffix so two similarly-named cards can't clobber
// each other's sheet.
function safeSheetName(name, used) {
  let base = String(name || 'Card').replace(/[:\\/?*[\]]/g, '-').slice(0, 31).trim() || 'Card';
  let candidate = base;
  let n = 2;
  while (used.has(candidate.toLowerCase())) {
    const suffix = ` (${n})`;
    candidate = base.slice(0, 31 - suffix.length) + suffix;
    n += 1;
  }
  used.add(candidate.toLowerCase());
  return candidate;
}

function styleHeader(row) {
  row.font = { bold: true, color: { argb: 'FFFFFFFF' }, size: 11 };
  row.fill = HEADER_FILL;
  row.alignment = { vertical: 'middle' };
  row.height = 20;
}

function addTotalRow(sheet, labelCol, label, amountCol, amount) {
  const row = sheet.addRow({ [labelCol]: label, [amountCol]: amount });
  row.font = { bold: true };
  row.getCell(labelCol).border = { top: { style: 'double' } };
  row.getCell(amountCol).border = { top: { style: 'double' } };
  return row;
}

/**
 * @param {object} payload  Output of buildPaymentReminder()
 * @returns {Promise<Buffer>} .xlsx file contents
 */
export async function buildPaymentWorkbook(payload) {
  const { cardsDueTomorrow = [], totalDue = 0, payingAccount, tomorrowDateKey } = payload || {};

  const wb = new ExcelJS.Workbook();
  wb.creator = 'Wealth Architect';
  wb.created = new Date();

  /* ── Summary ── */
  const summary = wb.addWorksheet('Summary');
  summary.columns = [
    { header: 'Card', key: 'card', width: 30 },
    { header: 'Projected Payment', key: 'amount', width: 18, style: { numFmt: MONEY } },
    { header: 'Charges Since Last Payment', key: 'count', width: 26 },
    { header: 'Last Payment', key: 'lastDate', width: 14, style: { numFmt: DATE_FMT } },
    { header: 'Last Payment Amount', key: 'lastAmount', width: 20, style: { numFmt: MONEY } },
    { header: 'Cadence (days)', key: 'cadence', width: 15 },
    { header: 'Recurrence', key: 'recurrence', width: 28 },
  ];
  styleHeader(summary.getRow(1));

  for (const c of cardsDueTomorrow) {
    summary.addRow({
      card: c.displayName || c.name,
      amount: money(c.amount),
      count: (c.charges || []).length,
      lastDate: c.lastPayment ? parseDate(c.lastPayment.date) : null,
      lastAmount: c.lastPayment ? money(c.lastPayment.amount) : null,
      cadence: c.cadenceDays ?? null,
      recurrence: c.recurrence || '—',
    });
  }
  addTotalRow(summary, 'card', 'Total projected', 'amount', money(totalDue));

  // Paying-account block, mirroring what the email body shows.
  summary.addRow({});
  const dueLabel = tomorrowDateKey
    ? new Date(`${tomorrowDateKey}T00:00:00`).toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric', year: 'numeric' })
    : '';
  const meta = [
    ['Payment due', dueLabel],
    ['Paying from', payingAccount ? payingAccount.name : 'Not found in latest balances'],
    ['Current balance', payingAccount ? money(payingAccount.balance) : null],
    ['After projected payment', payingAccount ? money(payingAccount.balance - totalDue) : null],
    ['Balances last updated', payingAccount && payingAccount.updated ? payingAccount.updated : '—'],
  ];
  for (const [label, value] of meta) {
    const row = summary.addRow({ card: label, amount: value });
    row.getCell('card').font = { bold: true };
    if (typeof value === 'number') row.getCell('amount').numFmt = MONEY;
  }

  /* ── One sheet of charges per card ── */
  const usedNames = new Set(['summary', 'payment history']);
  for (const c of cardsDueTomorrow) {
    const sheet = wb.addWorksheet(safeSheetName(c.displayName || c.name, usedNames));
    sheet.columns = [
      { header: 'Date', key: 'date', width: 12, style: { numFmt: DATE_FMT } },
      { header: 'Description', key: 'description', width: 38 },
      { header: 'Category', key: 'category', width: 22 },
      { header: 'Subcategory', key: 'subcategory', width: 22 },
      { header: 'Amount', key: 'amount', width: 14, style: { numFmt: MONEY } },
      { header: 'Charge', key: 'charge', width: 14, style: { numFmt: MONEY } },
      { header: 'Account', key: 'account', width: 26 },
      { header: 'Institution', key: 'institution', width: 20 },
      { header: 'Full Description', key: 'fullDescription', width: 46 },
      { header: 'Transaction ID', key: 'transactionId', width: 24 },
    ];
    styleHeader(sheet.getRow(1));

    // Charges arrive newest-first from the schedule; oldest-first reads better
    // as a statement, and matches how the charges accumulated toward the total.
    const charges = [...(c.charges || [])].sort((a, b) => {
      const da = parseDate(a.date), db = parseDate(b.date);
      return (da ? da.getTime() : 0) - (db ? db.getTime() : 0);
    });

    for (const t of charges) {
      sheet.addRow({
        date: parseDate(t.date),
        description: t.description || '',
        category: t.category || '',
        subcategory: t.subcategory || '',
        amount: money(t.amount),
        // Sign-flipped copy: charges are negative in the feed, but the column
        // that sums to the projected payment should read positive.
        charge: money(-(Number(t.amount) || 0)),
        account: t.account || '',
        institution: t.institution || '',
        fullDescription: t.fullDescription || '',
        transactionId: t.transactionId || '',
      });
    }

    if (charges.length === 0) {
      const row = sheet.addRow({ description: 'No charges recorded since the last payment.' });
      row.font = { italic: true, color: { argb: 'FF64748B' } };
    } else {
      addTotalRow(sheet, 'description', `Projected payment (${charges.length} charges)`, 'charge', money(c.amount));
    }

    sheet.autoFilter = { from: 'A1', to: { row: 1, column: sheet.columnCount } };
    sheet.views = [{ state: 'frozen', ySplit: 1 }];
  }

  /* ── Payment history ── */
  const hist = wb.addWorksheet('Payment History');
  hist.columns = [
    { header: 'Card', key: 'card', width: 30 },
    { header: 'Payment Date', key: 'date', width: 14, style: { numFmt: DATE_FMT } },
    { header: 'Amount', key: 'amount', width: 14, style: { numFmt: MONEY } },
  ];
  styleHeader(hist.getRow(1));
  for (const c of cardsDueTomorrow) {
    for (const p of c.payments || []) {
      hist.addRow({ card: c.displayName || c.name, date: parseDate(p.date), amount: money(p.amount) });
    }
  }
  hist.views = [{ state: 'frozen', ySplit: 1 }];
  summary.views = [{ state: 'frozen', ySplit: 1 }];

  const buffer = await wb.xlsx.writeBuffer();
  return Buffer.from(buffer);
}

