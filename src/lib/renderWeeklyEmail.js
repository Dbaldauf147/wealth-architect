/* Render a weekly summary object (from buildWeeklySummary) to HTML suitable
   for an email client. Inline styles only — email clients strip <style> tags. */

function money(n) {
  const sign = n < 0 ? '-' : '';
  const abs = Math.abs(n);
  return `${sign}$${abs.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

function shortDate(iso) {
  const d = new Date(iso);
  return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
}

function escapeHtml(s) {
  return String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function daysUntil(iso, now = new Date()) {
  const target = new Date(iso);
  const diffMs = target - now;
  return Math.round(diffMs / 86400000);
}

export function renderWeeklyEmailHtml(summary) {
  const { range, expenseTotal, wowDelta, wowPct, topCategories, topMerchants, uncategorized, transactionCount, uncategorizedCount, nextCardPayment, monthlyTrends } = summary;

  const deltaStr = wowPct == null
    ? 'No prior-week data'
    : `${wowDelta >= 0 ? '▲' : '▼'} ${money(Math.abs(wowDelta))} (${wowPct >= 0 ? '+' : ''}${wowPct.toFixed(1)}%) vs. prior week`;
  const deltaColor = wowDelta >= 0 ? '#b91c1c' : '#16a34a';

  const catBarMax = topCategories.length ? topCategories[0].amount : 1;

  const catRows = topCategories.map(c => {
    const pct = Math.max(4, Math.round((c.amount / catBarMax) * 100));
    return `
      <tr>
        <td style="padding:8px 0;font-size:13px;color:#111;white-space:nowrap;">${escapeHtml(c.name)}</td>
        <td style="padding:8px 12px;width:60%;">
          <div style="background:#f1f5f9;border-radius:4px;height:10px;overflow:hidden;">
            <div style="background:#0058be;height:10px;width:${pct}%;"></div>
          </div>
        </td>
        <td style="padding:8px 0;font-size:13px;color:#111;text-align:right;white-space:nowrap;font-variant-numeric:tabular-nums;">
          <strong>${money(c.amount)}</strong> <span style="color:#64748b;">(${c.pct.toFixed(0)}%)</span>
        </td>
      </tr>`;
  }).join('');

  const merchRows = topMerchants.map(m => `
    <tr>
      <td style="padding:6px 0;font-size:13px;color:#111;">${escapeHtml(m.name)}</td>
      <td style="padding:6px 0;font-size:12px;color:#64748b;white-space:nowrap;">${m.count}×</td>
      <td style="padding:6px 0;font-size:13px;text-align:right;white-space:nowrap;font-variant-numeric:tabular-nums;"><strong>${money(m.amount)}</strong></td>
    </tr>`).join('');

  const uncatRows = uncategorized.slice(0, 25).map(t => `
    <tr>
      <td style="padding:6px 0;font-size:12px;color:#64748b;white-space:nowrap;">${shortDate(t.date)}</td>
      <td style="padding:6px 8px;font-size:13px;color:#111;">${escapeHtml(t.description)}</td>
      <td style="padding:6px 0;font-size:13px;text-align:right;white-space:nowrap;font-variant-numeric:tabular-nums;">${money(t.amount)}</td>
    </tr>`).join('');

  const uncatExtra = uncategorized.length > 25
    ? `<p style="margin:8px 0 0;font-size:12px;color:#64748b;">…and ${uncategorized.length - 25} more. <a href="#" style="color:#0058be;">Review them all in the app.</a></p>`
    : '';

  return `<!doctype html>
<html>
<head><meta charset="utf-8"><title>Weekly Spending Summary</title></head>
<body style="margin:0;padding:24px;background:#f8fafc;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;color:#111;">
  <table role="presentation" width="100%" style="max-width:600px;margin:0 auto;background:#ffffff;border-radius:12px;box-shadow:0 1px 3px rgba(0,0,0,0.06);overflow:hidden;">
    <tr>
      <td style="padding:24px 28px 16px;">
        <div style="font-size:11px;font-weight:700;letter-spacing:0.08em;text-transform:uppercase;color:#64748b;">Weekly Spending Summary</div>
        <div style="font-size:14px;color:#64748b;margin-top:4px;">${shortDate(range.start)} – ${shortDate(range.end)}</div>
      </td>
    </tr>
    <tr>
      <td style="padding:0 28px 24px;">
        <div style="font-size:42px;font-weight:700;color:#111;letter-spacing:-0.02em;line-height:1;">${money(expenseTotal)}</div>
        <div style="font-size:13px;color:${deltaColor};margin-top:8px;">${deltaStr}</div>
        <div style="font-size:12px;color:#64748b;margin-top:4px;">${transactionCount} transactions · ${uncategorizedCount} uncategorized</div>
      </td>
    </tr>

    ${nextCardPayment ? (() => {
      const days = daysUntil(nextCardPayment.nextDate);
      const when = days <= 0
        ? 'expected today'
        : days === 1
        ? 'in 1 day'
        : `in ${days} days`;
      return `
    <tr>
      <td style="padding:0 28px 24px;">
        <div style="border-top:1px solid #e2e8f0;padding-top:20px;">
          <div style="font-size:11px;font-weight:700;letter-spacing:0.08em;text-transform:uppercase;color:#64748b;margin-bottom:8px;">Next Credit Card Payment</div>
          <div style="display:flex;justify-content:space-between;align-items:baseline;">
            <div>
              <div style="font-size:15px;font-weight:600;color:#111;">${escapeHtml(nextCardPayment.card)}</div>
              <div style="font-size:12px;color:#64748b;margin-top:2px;">${shortDate(nextCardPayment.nextDate)} · ${when}</div>
            </div>
            <div style="font-size:18px;font-weight:600;color:#111;font-variant-numeric:tabular-nums;text-align:right;">${money(nextCardPayment.lastAmount)}</div>
          </div>
          <div style="font-size:11px;color:#94a3b8;margin-top:6px;">Projected from past payment cadence (~${nextCardPayment.cadenceDays} days). Last paid ${shortDate(nextCardPayment.lastDate)}.</div>
        </div>
      </td>
    </tr>`;
    })() : ''}

    ${topCategories.length ? `
    <tr>
      <td style="padding:0 28px;">
        <div style="border-top:1px solid #e2e8f0;padding-top:20px;">
          <div style="font-size:11px;font-weight:700;letter-spacing:0.08em;text-transform:uppercase;color:#64748b;margin-bottom:8px;">Top Categories</div>
          <table role="presentation" width="100%" style="border-collapse:collapse;">
            ${catRows}
          </table>
        </div>
      </td>
    </tr>` : ''}

    ${topMerchants.length ? `
    <tr>
      <td style="padding:20px 28px 0;">
        <div style="border-top:1px solid #e2e8f0;padding-top:20px;">
          <div style="font-size:11px;font-weight:700;letter-spacing:0.08em;text-transform:uppercase;color:#64748b;margin-bottom:8px;">Top Merchants</div>
          <table role="presentation" width="100%" style="border-collapse:collapse;">
            ${merchRows}
          </table>
        </div>
      </td>
    </tr>` : ''}

    ${monthlyTrends && (monthlyTrends.mtdTotal > 0 || monthlyTrends.priorMtdTotal > 0) ? (() => {
      const mt = monthlyTrends;
      const headlineColor = mt.mtdDelta >= 0 ? '#b91c1c' : '#16a34a';
      const headlineDelta = mt.mtdPct == null
        ? `${money(mt.mtdTotal)} so far this month (no prior data)`
        : `${mt.mtdDelta >= 0 ? '▲' : '▼'} ${money(Math.abs(mt.mtdDelta))} (${mt.mtdPct >= 0 ? '+' : ''}${mt.mtdPct.toFixed(1)}%) vs. same days last month`;

      const moverRows = mt.topMovers.map(m => {
        const up = m.delta >= 0;
        const arrow = up ? '▲' : '▼';
        const color = up ? '#b91c1c' : '#16a34a';
        const pctStr = m.pct == null
          ? '<span style="color:#64748b;">new this month</span>'
          : `<span style="color:#64748b;">(${m.pct >= 0 ? '+' : ''}${m.pct.toFixed(0)}%)</span>`;
        return `
          <tr>
            <td style="padding:6px 0;font-size:13px;color:#111;">${escapeHtml(m.name)}</td>
            <td style="padding:6px 8px;font-size:12px;color:${color};white-space:nowrap;">${arrow} ${money(Math.abs(m.delta))}</td>
            <td style="padding:6px 0;font-size:12px;text-align:right;white-space:nowrap;font-variant-numeric:tabular-nums;">
              <strong style="color:#111;">${money(m.current)}</strong> ${pctStr}
            </td>
          </tr>`;
      }).join('');

      return `
    <tr>
      <td style="padding:20px 28px 0;">
        <div style="border-top:1px solid #e2e8f0;padding-top:20px;">
          <div style="font-size:11px;font-weight:700;letter-spacing:0.08em;text-transform:uppercase;color:#64748b;margin-bottom:8px;">${escapeHtml(mt.monthLabel)} — Month-to-Date</div>
          <div style="font-size:24px;font-weight:700;color:#111;letter-spacing:-0.01em;line-height:1;">${money(mt.mtdTotal)}</div>
          <div style="font-size:12px;color:${headlineColor};margin-top:6px;">${headlineDelta}</div>
          ${mt.topMovers.length ? `
          <div style="font-size:11px;font-weight:700;letter-spacing:0.08em;text-transform:uppercase;color:#64748b;margin:14px 0 4px;">Biggest Movers</div>
          <table role="presentation" width="100%" style="border-collapse:collapse;">
            ${moverRows}
          </table>` : ''}
        </div>
      </td>
    </tr>`;
    })() : ''}

    ${uncategorized.length ? `
    <tr>
      <td style="padding:20px 28px 24px;">
        <div style="border-top:1px solid #e2e8f0;padding-top:20px;">
          <div style="font-size:11px;font-weight:700;letter-spacing:0.08em;text-transform:uppercase;color:#64748b;margin-bottom:8px;">Uncategorized Transactions</div>
          <table role="presentation" width="100%" style="border-collapse:collapse;">
            ${uncatRows}
          </table>
          ${uncatExtra}
        </div>
      </td>
    </tr>` : `
    <tr>
      <td style="padding:20px 28px 24px;">
        <div style="border-top:1px solid #e2e8f0;padding-top:16px;font-size:13px;color:#16a34a;">✓ Everything categorized this week — nice.</div>
      </td>
    </tr>`}

    <tr>
      <td style="padding:16px 28px 24px;background:#f8fafc;border-top:1px solid #e2e8f0;">
        <div style="font-size:11px;color:#94a3b8;text-align:center;">Wealth Architect · Automated weekly summary</div>
      </td>
    </tr>
  </table>
</body>
</html>`;
}
