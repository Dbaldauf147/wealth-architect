/* The printed lines of a PDF, in reading order, as plain text — what
   parseStatementText (statementAudit.js) reads. Browser-only.

   pdf.js hands back positioned text fragments, not lines: one table row can
   arrive as a dozen pieces, and not always left to right. Fragments are
   grouped by their baseline (to within a couple of points, since a column of
   amounts can sit a hair off the description beside it) and each group is
   sorted by x, so a statement's activity row comes out as
   "09/03 AMAZON MKTPL*AB12CD3 Amzn.com/bill WA 45.67".

   pdf.js is imported on first use so its ~1 MB never reaches pages that
   don't read PDFs. */

const SAME_LINE_PT = 2.5;

export async function pdfToText(arrayBuffer) {
  const [{ getDocument, GlobalWorkerOptions }, { default: workerUrl }] = await Promise.all([
    import('pdfjs-dist'),
    import('pdfjs-dist/build/pdf.worker.min.mjs?url'),
  ]);
  GlobalWorkerOptions.workerSrc = workerUrl;
  // Cleanup lives on the loading task in pdf.js 6, not on the document.
  const task = getDocument({ data: new Uint8Array(arrayBuffer) });
  const out = [];
  try {
    const doc = await task.promise;
    for (let p = 1; p <= doc.numPages; p++) {
      const page = await doc.getPage(p);
      const { items } = await page.getTextContent();
      const rows = [];
      for (const it of items) {
        if (!it.str || !it.str.trim()) continue;
        const x = it.transform[4];
        const y = it.transform[5];
        let row = rows.find(r => Math.abs(r.y - y) <= SAME_LINE_PT);
        if (!row) { row = { y, parts: [] }; rows.push(row); }
        row.parts.push({ x, str: it.str });
      }
      rows.sort((a, b) => b.y - a.y); // PDF y runs bottom-up
      for (const r of rows) out.push(r.parts.sort((a, b) => a.x - b.x).map(s => s.str.trim()).join(' '));
    }
  } finally {
    await task.destroy();
  }
  return out.join('\n');
}
