import { parseStatementCsv, parseStatementText } from './statementAudit.js';

/* A dropped statement file to parsed lines. Browser-only (File, and pdf.js
   for PDFs), which is why it sits apart from the pure statementAudit.js. */

/** PDF or CSV → parser output. Throws a readable message. */
export async function readStatementFile(f) {
  try {
    if (/\.pdf$/i.test(f.name) || f.type === 'application/pdf') {
      const { pdfToText } = await import('./pdfText');
      return parseStatementText(await pdfToText(await f.arrayBuffer()));
    }
    return parseStatementCsv(await f.text());
  } catch (err) {
    console.error('Statement read failed:', err);
    throw new Error(/password/i.test(err?.name || err?.message || '')
      ? 'This PDF is password-protected. Download an unlocked copy from your card issuer and try again.'
      : `Couldn't read this file: ${err?.message || err}`);
  }
}

/** YYYY-MM-DD from the date's own calendar day, for <input type="date">. */
export const isoDay = d => (d ? `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}` : '');
