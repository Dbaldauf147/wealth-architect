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

// Pick an axis maximum and tick step that land on round dollar amounts ($250,
// $500, $1,000 …) rather than arbitrary fractions of the data max, so the Y
// labels read as real money.
function niceScale(rawMax, targetTicks = 4) {
  const max = Math.max(rawMax, 1);
  const rough = max / targetTicks;
  const mag = Math.pow(10, Math.floor(Math.log10(rough)));
  const norm = rough / mag;
  const step = (norm <= 1 ? 1 : norm <= 2 ? 2 : norm <= 2.5 ? 2.5 : norm <= 5 ? 5 : 10) * mag;
  const count = Math.max(1, Math.ceil(max / step));
  return { yMax: step * count, step, ticks: Array.from({ length: count + 1 }, (_, i) => i * step) };
}

// Axis money label: whole dollars with thousands separators, keeping a decimal
// only when the step itself is fractional (e.g. a $2.50 step on a tiny week).
function fmtAxisDollar(v, step) {
  const digits = step >= 1 ? (Number.isInteger(step) ? 0 : 1) : 2;
  return `$${v.toLocaleString('en-US', { minimumFractionDigits: digits, maximumFractionDigits: digits })}`;
}

// Shared chart geometry. The extra bottom padding leaves room for a second
// line of X labels (the calendar dates / axis caption).
const CHART = {
  w: 560,
  h: 236,
  pad: { top: 16, right: 16, bottom: 44, left: 62 },
};

// Build an inline SVG of the cumulative-daily-spend comparison (this month
// vs. last month), mirroring the Overview page chart. Inline SVG renders
// in most modern email clients (Apple Mail, Gmail web, iOS Mail). For
// clients that strip it (older Outlook), the text headline below provides
// the same information.
function renderMonthCompareSvg(mc) {
  const VB_W = CHART.w;
  const VB_H = CHART.h;
  const pad = CHART.pad;
  const cW = VB_W - pad.left - pad.right;
  const cH = VB_H - pad.top - pad.bottom;
  const maxDay = Math.max(mc.thisMonthDays, mc.lastMonthDays);
  const scale = niceScale(Math.max(
    mc.cumThis[mc.today] || 0,
    mc.cumLast[mc.lastMonthDays] || 0,
    1,
  ));
  const yMax = scale.yMax;

  const xPos = day => pad.left + ((day - 1) / Math.max(1, maxDay - 1)) * cW;
  const yPos = amt => pad.top + cH - (amt / yMax) * cH;

  const thisPts = [];
  for (let i = 1; i <= mc.today; i++) thisPts.push({ x: xPos(i), y: yPos(mc.cumThis[i]) });
  const lastPts = [];
  for (let i = 1; i <= mc.lastMonthDays; i++) lastPts.push({ x: xPos(i), y: yPos(mc.cumLast[i]) });
  const lastPath = lastPts.map((p, i) => `${i === 0 ? 'M' : 'L'} ${p.x.toFixed(1)} ${p.y.toFixed(1)}`).join(' ');
  const thisPath = thisPts.map((p, i) => `${i === 0 ? 'M' : 'L'} ${p.x.toFixed(1)} ${p.y.toFixed(1)}`).join(' ');

  const yTicks = scale.ticks;
  // Day-of-month ticks. The last one is dropped when it would collide with the
  // month-end tick that always gets a label.
  const xTickDays = [1, 5, 10, 15, 20, 25, maxDay]
    .filter((v, i, a) => a.indexOf(v) === i)
    .filter(d => d === maxDay || maxDay - d >= 3);

  const gridLines = yTicks.map((t, i) => {
    const y = yPos(t).toFixed(1);
    const dash = i === 0 ? '0' : '2 4';
    return `<line x1="${pad.left}" x2="${VB_W - pad.right}" y1="${y}" y2="${y}" stroke="#e2e8f0" stroke-width="1" stroke-dasharray="${dash}" />`;
  }).join('');

  const yLabels = yTicks.map(t => {
    const y = (yPos(t) + 4).toFixed(1);
    return `<text x="${pad.left - 8}" y="${y}" text-anchor="end" font-size="10" fill="#94a3b8" font-family="-apple-system,'Segoe UI',sans-serif">${fmtAxisDollar(t, scale.step)}</text>`;
  }).join('');

  // Both months share a day-of-month axis, so the ticks are day numbers with a
  // caption underneath saying what they are, rather than a single month's dates.
  const xLabelY = VB_H - pad.bottom + 16;
  const xLabels = xTickDays.map(d => {
    return `<text x="${xPos(d).toFixed(1)}" y="${xLabelY}" text-anchor="middle" font-size="10" fill="#94a3b8" font-family="-apple-system,'Segoe UI',sans-serif">${d}</text>`;
  }).join('')
    + `<text x="${(pad.left + (VB_W - pad.right)) / 2}" y="${xLabelY + 16}" text-anchor="middle" font-size="10" fill="#94a3b8" font-family="-apple-system,'Segoe UI',sans-serif">Day of month · ${escapeHtml(mc.thisMonthLabel)} vs ${escapeHtml(mc.lastMonthLabel)}</text>`;

  const lastLine = lastPts.length >= 2
    ? `<path d="${lastPath}" fill="none" stroke="#94a3b8" stroke-width="2" stroke-dasharray="4 4" stroke-linecap="round" stroke-linejoin="round" />`
    : '';
  const thisLine = thisPts.length >= 2
    ? `<path d="${thisPath}" fill="none" stroke="#0058be" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" />`
    : '';

  let todayDot = '';
  if (thisPts.length > 0) {
    const last = thisPts[thisPts.length - 1];
    todayDot = `
      <line x1="${last.x.toFixed(1)}" x2="${last.x.toFixed(1)}" y1="${pad.top}" y2="${VB_H - pad.bottom}" stroke="#0058be" stroke-width="1" stroke-dasharray="2 3" opacity="0.4" />
      <circle cx="${last.x.toFixed(1)}" cy="${last.y.toFixed(1)}" r="5" fill="#0058be" stroke="#ffffff" stroke-width="2" />`;
  }
  let priorDot = '';
  if (mc.today <= mc.lastMonthDays) {
    const x = xPos(mc.today).toFixed(1);
    const y = yPos(mc.cumLast[mc.today] || 0).toFixed(1);
    priorDot = `<circle cx="${x}" cy="${y}" r="4" fill="#94a3b8" stroke="#ffffff" stroke-width="2" />`;
  }

  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${VB_W} ${VB_H}" width="100%" preserveAspectRatio="xMidYMid meet" style="display:block;max-width:100%;height:auto;">${gridLines}${yLabels}${xLabels}${lastLine}${thisLine}${priorDot}${todayDot}</svg>`;
}

// Inline SVG of this-week-vs-normal cumulative spend (Mon→Sun), mirroring the
// Overview page Weekly view. Solid blue = this week through today; dotted gray
// = the recent-average ("normal") week.
function renderWeekCompareSvg(wc) {
  const VB_W = CHART.w;
  const VB_H = CHART.h;
  const pad = CHART.pad;
  const cW = VB_W - pad.left - pad.right;
  const cH = VB_H - pad.top - pad.bottom;
  const { dayLabels, dayDates, todayIdx, thisCum, normalCum } = wc;
  const scale = niceScale(Math.max(thisCum[todayIdx] || 0, normalCum[6] || 0, 1));
  const yMax = scale.yMax;

  const xPos = idx => pad.left + (idx / 6) * cW;
  const yPos = amt => pad.top + cH - (amt / yMax) * cH;

  const thisPts = [];
  for (let i = 0; i <= todayIdx; i++) thisPts.push({ x: xPos(i), y: yPos(thisCum[i]) });
  const normalPts = [];
  for (let i = 0; i < 7; i++) normalPts.push({ x: xPos(i), y: yPos(normalCum[i]) });
  const normalPath = normalPts.map((p, i) => `${i === 0 ? 'M' : 'L'} ${p.x.toFixed(1)} ${p.y.toFixed(1)}`).join(' ');
  const thisPath = thisPts.map((p, i) => `${i === 0 ? 'M' : 'L'} ${p.x.toFixed(1)} ${p.y.toFixed(1)}`).join(' ');

  const yTicks = scale.ticks;

  const gridLines = yTicks.map((t, i) => {
    const y = yPos(t).toFixed(1);
    const dash = i === 0 ? '0' : '2 4';
    return `<line x1="${pad.left}" x2="${VB_W - pad.right}" y1="${y}" y2="${y}" stroke="#e2e8f0" stroke-width="1" stroke-dasharray="${dash}" />`;
  }).join('');

  const yLabels = yTicks.map(t => {
    const y = (yPos(t) + 4).toFixed(1);
    return `<text x="${pad.left - 8}" y="${y}" text-anchor="end" font-size="10" fill="#94a3b8" font-family="-apple-system,'Segoe UI',sans-serif">${fmtAxisDollar(t, scale.step)}</text>`;
  }).join('');

  // Weekday name on the first line, the actual calendar date (M/D) beneath it.
  const xLabelY = VB_H - pad.bottom + 16;
  const xLabels = dayLabels.map((lbl, i) => {
    const x = xPos(i).toFixed(1);
    const isToday = i === todayIdx;
    const name = `<text x="${x}" y="${xLabelY}" text-anchor="middle" font-size="10" fill="${isToday ? '#0058be' : '#64748b'}" font-weight="${isToday ? '700' : '400'}" font-family="-apple-system,'Segoe UI',sans-serif">${lbl}</text>`;
    const date = dayDates && dayDates[i]
      ? `<text x="${x}" y="${xLabelY + 14}" text-anchor="middle" font-size="9" fill="${isToday ? '#0058be' : '#94a3b8'}" font-family="-apple-system,'Segoe UI',sans-serif">${dayDates[i]}</text>`
      : '';
    return name + date;
  }).join('');

  const normalLine = normalPts.length >= 2
    ? `<path d="${normalPath}" fill="none" stroke="#94a3b8" stroke-width="2" stroke-dasharray="4 4" stroke-linecap="round" stroke-linejoin="round" />`
    : '';
  const thisLine = thisPts.length >= 2
    ? `<path d="${thisPath}" fill="none" stroke="#0058be" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" />`
    : '';

  let todayDot = '';
  if (thisPts.length > 0) {
    const last = thisPts[thisPts.length - 1];
    todayDot = `
      <line x1="${last.x.toFixed(1)}" x2="${last.x.toFixed(1)}" y1="${pad.top}" y2="${VB_H - pad.bottom}" stroke="#0058be" stroke-width="1" stroke-dasharray="2 3" opacity="0.4" />
      <circle cx="${last.x.toFixed(1)}" cy="${last.y.toFixed(1)}" r="5" fill="#0058be" stroke="#ffffff" stroke-width="2" />`;
  }
  const nx = xPos(todayIdx).toFixed(1);
  const ny = yPos(normalCum[todayIdx] || 0).toFixed(1);
  const priorDot = `<circle cx="${nx}" cy="${ny}" r="4" fill="#94a3b8" stroke="#ffffff" stroke-width="2" />`;

  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${VB_W} ${VB_H}" width="100%" preserveAspectRatio="xMidYMid meet" style="display:block;max-width:100%;height:auto;">${gridLines}${yLabels}${xLabels}${normalLine}${thisLine}${priorDot}${todayDot}</svg>`;
}

// Inline range sparkline mirroring the Budgets page "Normal Range Tracker"
// graphic: a shaded green ±25% band, dashed average line, the 6-month spend
// line, and dots with the current month accented (red when above range).
function renderRangeSparklineSvg(item) {
  const w = 180, h = 56, padX = 4, padY = 4;
  const { series, high, low, avg } = item;
  if (!series || series.length === 0) return '';
  const allVals = [...series.map(s => s.value), high, avg, low].filter(v => v > 0);
  const max = allVals.length ? Math.max(...allVals) * 1.15 : 1;
  const range = max || 1;
  const yPos = v => padY + (h - 2 * padY) * (1 - v / range);
  const xStep = (w - 2 * padX) / Math.max(series.length - 1, 1);
  const xPos = i => padX + i * xStep;
  const path = series.map((s, i) => `${i === 0 ? 'M' : 'L'} ${xPos(i).toFixed(1)} ${yPos(s.value).toFixed(1)}`).join(' ');
  const yHigh = yPos(high), yLow = yPos(low), yAvg = yPos(avg);
  const band = avg > 0 ? `<rect x="${padX}" y="${yHigh.toFixed(1)}" width="${w - 2 * padX}" height="${Math.max(yLow - yHigh, 1).toFixed(1)}" fill="#16a34a" opacity="0.12" rx="2" />` : '';
  const avgLine = avg > 0 ? `<line x1="${padX}" y1="${yAvg.toFixed(1)}" x2="${w - padX}" y2="${yAvg.toFixed(1)}" stroke="#16a34a" stroke-width="1" stroke-dasharray="3 3" opacity="0.7" />` : '';
  const spend = `<path d="${path}" fill="none" stroke="#64748b" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" />`;
  const dots = series.map((s, i) => {
    const above = avg > 0 && s.value > high;
    const below = avg > 0 && s.value < low && s.value > 0;
    const color = s.isCurrent ? (above ? '#ba1a1a' : below ? '#e8a317' : '#16a34a') : '#94a3b8';
    const r = s.isCurrent ? 3.5 : 2.5;
    return `<circle cx="${xPos(i).toFixed(1)}" cy="${yPos(s.value).toFixed(1)}" r="${r}" fill="${color}" />`;
  }).join('');
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${w} ${h}" width="${w}" height="${h}" style="display:block;">${band}${avgLine}${spend}${dots}</svg>`;
}

// Canonical list of reorderable / toggleable weekly-email sections. The header
// (total + WoW) and footer are fixed and not part of this list. `id` is the
// stable key persisted in config; `label` is what the Settings UI shows.
export const WEEKLY_EMAIL_SECTIONS = [
  { id: 'spendCharts', label: 'Spend charts (weekly + monthly)' },
  { id: 'aboveRange', label: 'Above Normal Range' },
  { id: 'suboptimalCards', label: 'Suboptimal Card Usage' },
  { id: 'cardPromos', label: 'Card Promotions' },
  { id: 'topCategories', label: 'Top Categories' },
  { id: 'topMerchants', label: 'Top Merchants' },
  { id: 'monthlyTrends', label: 'Month-to-Date & Movers' },
  { id: 'uncategorized', label: 'Uncategorized Transactions' },
];

export const DEFAULT_EMAIL_SECTIONS = WEEKLY_EMAIL_SECTIONS.map(s => ({ id: s.id, enabled: true }));

// Legacy ids that were merged into a single section, so older saved configs
// migrate to the combined section at the same position instead of being dropped.
const LEGACY_SECTION_MAP = { monthCompare: 'spendCharts', weekCompare: 'spendCharts' };

// Reconcile a stored [{id, enabled}] config with the canonical list: keep the
// stored order/enabled for known ids (migrating legacy ids), drop unknown ids,
// and append any new sections (enabled) at the end so a future-added section
// still shows up.
export function normalizeEmailSections(stored) {
  const known = new Set(WEEKLY_EMAIL_SECTIONS.map(s => s.id));
  const out = [];
  const seen = new Set();
  for (const s of Array.isArray(stored) ? stored : []) {
    if (!s) continue;
    const id = LEGACY_SECTION_MAP[s.id] || s.id;
    if (known.has(id) && !seen.has(id)) {
      out.push({ id, enabled: s.enabled !== false });
      seen.add(id);
    }
  }
  for (const s of WEEKLY_EMAIL_SECTIONS) {
    if (!seen.has(s.id)) out.push({ id: s.id, enabled: true });
  }
  return out;
}

/* `opts.chart(key, svgString, meta)` lets the caller decide how each chart is
   embedded. The default inlines the SVG (fine for the in-app preview / browsers
   that support it). The email sender passes a function that rasterizes the SVG
   to a PNG and returns an <img src="cid:…"> instead, because Gmail and others
   strip inline <svg>.

   `opts.sections` is a [{id, enabled}] config controlling which sections show
   and in what order (see WEEKLY_EMAIL_SECTIONS). Defaults to all, in order. */
export function renderWeeklyEmailHtml(summary, opts = {}) {
  const chart = opts.chart || ((key, svg) => svg);
  const sections = normalizeEmailSections(opts.sections);
  const { topCategories, topMerchants, uncategorized, monthlyTrends, monthCompare, weekCompare, aboveRange, suboptimalCards, cardPromos } = summary;

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

  const parts = {};

  // Weekly + monthly cumulative-spend charts, side by side (weekly left,
  // monthly right). Compact stat lines under each keep the two columns narrow
  // enough to sit together in a 600px email.
  parts.spendCharts = (() => {
    const wc = weekCompare;
    const mc = monthCompare;
    const hasWeek = wc && (wc.thisTotalToDate > 0 || wc.normalFull > 0);
    const hasMonth = mc && (mc.thisTotalToDate > 0 || mc.lastTotalFinal > 0);
    if (!hasWeek && !hasMonth) return '';

    const weekCell = hasWeek ? (() => {
      const paceColor = wc.paceDelta > 0 ? '#b91c1c' : '#16a34a';
      const paceSign = wc.paceDelta >= 0 ? '▲' : '▼';
      return `
          <div style="font-size:15px;font-weight:700;letter-spacing:0.03em;text-transform:uppercase;color:#334155;margin-bottom:10px;">This Week vs Normal</div>
          ${chart('weekChart', renderWeekCompareSvg(wc), { w: CHART.w, h: CHART.h })}
          <div style="font-size:15px;color:#475569;margin-top:10px;line-height:1.5;font-variant-numeric:tabular-nums;">
            <strong style="color:#111;">${money(wc.thisTotalToDate)}</strong> this wk · ${money(wc.normalFull)} normal · <span style="color:${paceColor};font-weight:700;">${paceSign} ${money(Math.abs(wc.paceDelta))}</span>
          </div>`;
    })() : '';

    const monthCell = hasMonth ? (() => {
      const paceColor = mc.paceDelta > 0 ? '#b91c1c' : '#16a34a';
      const paceSign = mc.paceDelta >= 0 ? '▲' : '▼';
      return `
          <div style="font-size:15px;font-weight:700;letter-spacing:0.03em;text-transform:uppercase;color:#334155;margin-bottom:10px;">${escapeHtml(mc.thisMonthLabel)} vs ${escapeHtml(mc.lastMonthLabel)}</div>
          ${chart('monthChart', renderMonthCompareSvg(mc), { w: CHART.w, h: CHART.h })}
          <div style="font-size:15px;color:#475569;margin-top:10px;line-height:1.5;font-variant-numeric:tabular-nums;">
            <strong style="color:#111;">${money(mc.thisTotalToDate)}</strong> ${escapeHtml(mc.thisMonthLabel)} · ${money(mc.lastTotalFinal)} ${escapeHtml(mc.lastMonthLabel)} · <span style="color:${paceColor};font-weight:700;">${paceSign} ${money(Math.abs(mc.paceDelta))}</span>
          </div>`;
    })() : '';

    const inner = (hasWeek && hasMonth)
      ? `<table role="presentation" width="100%" style="border-collapse:collapse;">
            <tr>
              <td width="50%" valign="top" style="padding-right:8px;">${weekCell}</td>
              <td width="50%" valign="top" style="padding-left:8px;">${monthCell}</td>
            </tr>
          </table>`
      : `${weekCell}${monthCell}`;

    return `
    <tr>
      <td style="padding:0 28px 20px;">
        <div style="border-top:1px solid #e2e8f0;padding-top:20px;">
          ${inner}
          <div style="font-size:11px;color:#94a3b8;margin-top:8px;">Excludes transfers, card payments, rent, investments, and retirement.</div>
        </div>
      </td>
    </tr>`;
  })();

  parts.aboveRange = (aboveRange && aboveRange.length) ? `
    <tr>
      <td style="padding:0 28px 20px;">
        <div style="border-top:1px solid #e2e8f0;padding-top:20px;">
          <div style="font-size:11px;font-weight:700;letter-spacing:0.08em;text-transform:uppercase;color:#64748b;margin-bottom:4px;">Above Normal Range</div>
          <div style="font-size:12px;color:#64748b;margin-bottom:14px;">Categories spending more in the last 30 days than their usual range (the average of the three 30-day periods before it, ±25%).</div>
          ${aboveRange.map((item, i) => `
          <table role="presentation" width="100%" style="border-collapse:collapse;margin-bottom:14px;">
            <tr>
              <td style="vertical-align:middle;padding-right:12px;">
                <div style="font-size:13px;font-weight:700;color:#111;">${escapeHtml(item.name)}</div>
                <div style="font-size:12px;color:#b91c1c;margin-top:2px;font-variant-numeric:tabular-nums;">▲ ${money(item.current)} <span style="color:#64748b;">(${item.overPct >= 0 ? '+' : ''}${Math.round(item.overPct)}% vs avg)</span></div>
                <div style="font-size:11px;color:#94a3b8;margin-top:2px;font-variant-numeric:tabular-nums;">Normal range ${money(item.low)} – ${money(item.high)}</div>
              </td>
              <td style="vertical-align:middle;text-align:right;width:188px;">
                ${chart('rangeChart' + i, renderRangeSparklineSvg(item), { w: 180, h: 56 })}
              </td>
            </tr>
          </table>`).join('')}
        </div>
      </td>
    </tr>` : '';

  parts.suboptimalCards = (suboptimalCards && suboptimalCards.items && suboptimalCards.items.length) ? `
    <tr>
      <td style="padding:0 28px 20px;">
        <div style="border-top:1px solid #e2e8f0;padding-top:20px;">
          <div style="font-size:11px;font-weight:700;letter-spacing:0.08em;text-transform:uppercase;color:#64748b;margin-bottom:4px;">Suboptimal Card Usage</div>
          <div style="font-size:12px;color:#64748b;margin-bottom:14px;">Charges in the last 30 days that would have earned more on another card. <strong>${money(suboptimalCards.totalMissed)}</strong> left on the table across ${suboptimalCards.evaluatedCount} charge${suboptimalCards.evaluatedCount === 1 ? '' : 's'}.</div>
          <table role="presentation" width="100%" style="border-collapse:collapse;font-size:12px;">
            ${suboptimalCards.items.map(item => `
            <tr>
              <td style="padding:6px 8px 6px 0;vertical-align:top;">
                <div style="font-size:12.5px;font-weight:600;color:#111;">${escapeHtml(item.description)}</div>
                <div style="font-size:11px;color:#94a3b8;margin-top:2px;">${escapeHtml(item.categoryLabel)} · ${money(item.spend)} on ${escapeHtml(item.usedLabel)} (${item.usedRate}%)</div>
              </td>
              <td style="padding:6px 0;vertical-align:top;text-align:right;white-space:nowrap;">
                <div style="font-size:12.5px;font-weight:700;color:#b91c1c;font-variant-numeric:tabular-nums;">-${money(item.missed)}</div>
                <div style="font-size:11px;color:#64748b;margin-top:2px;">${escapeHtml(item.bestLabel)} pays ${item.bestRate}%</div>
              </td>
            </tr>`).join('')}
          </table>
          ${suboptimalCards.moreCount ? `<div style="font-size:11px;color:#94a3b8;margin-top:10px;font-style:italic;">and ${suboptimalCards.moreCount} more on the Card Promotions tab.</div>` : ''}
          ${suboptimalCards.unknownCount ? `<div style="font-size:11px;color:#94a3b8;margin-top:6px;font-style:italic;">${suboptimalCards.unknownCount} card account${suboptimalCards.unknownCount === 1 ? ' is' : 's are'} unassigned, so their charges were not checked.</div>` : ''}
        </div>
      </td>
    </tr>` : '';

  /* Card credits: what each benefit is worth, how much of it is claimed, and
     the most recent charge that counted toward it.

     The last-charge line is the point of the section. "$300 travel credit, $0
     used" says nothing about whether the benefit is being forgotten or simply
     hasn't come round yet; "last used May 3" answers that in a glance. It
     deliberately reaches back past the current cycle — a monthly credit with no
     hits this month is exactly when the previous month's date is worth seeing —
     and marks anything older than the cycle so the two can't be confused. */
  parts.cardPromos = (cardPromos && cardPromos.items && cardPromos.items.length) ? (() => {
    const cycleWord = p => (p === 'monthly' ? 'month' : p === 'quarterly' ? 'quarter' : 'year');

    const promoRows = cardPromos.items.map(item => {
      const capped = Math.min(item.used, item.value);
      const pct = item.value > 0 ? Math.min(100, Math.round((capped / item.value) * 100)) : 0;
      const done = item.remaining <= 0;
      const barColor = done ? '#16a34a' : (item.color || '#0058be');
      const last = item.lastTransaction;

      // Three states that mean genuinely different things: a benefit with no
      // match rule cannot have a last charge, one with rules but no hits has
      // never been used, and one whose last hit predates the current cycle is
      // the case actually worth flagging.
      let lastLine;
      if (!last) {
        lastLine = item.tracked ? 'No matching charge yet' : 'Tracked by hand — no match rule set';
      } else {
        const acct = last.account ? ` · ${escapeHtml(last.account)}` : '';
        const stale = last.inCurrentCycle
          ? ''
          : ` <span style="color:#b45309;">(before this ${cycleWord(item.period)})</span>`;
        lastLine = `${shortDate(last.date)} · ${escapeHtml(last.description || 'charge')} · ${money(last.amount)}${acct}${stale}`;
      }

      return `
            <tr>
              <td style="padding:8px 8px 8px 0;vertical-align:top;">
                <div style="font-size:12.5px;font-weight:600;color:#111;">${escapeHtml(item.name)}</div>
                <div style="font-size:11px;color:#94a3b8;margin-top:2px;">${escapeHtml(item.card)} · ${escapeHtml(item.period)}</div>
                <div style="font-size:11px;color:#64748b;margin-top:4px;">${lastLine}</div>
              </td>
              <td style="padding:8px 0;vertical-align:top;text-align:right;white-space:nowrap;width:156px;">
                <div style="font-size:12.5px;font-weight:700;color:#111;font-variant-numeric:tabular-nums;">${money(capped)} <span style="color:#64748b;font-weight:400;">of ${money(item.value)}</span></div>
                <div style="background:#f1f5f9;border-radius:4px;height:6px;overflow:hidden;margin-top:6px;">
                  <div style="background:${barColor};height:6px;width:${Math.max(pct, 2)}%;"></div>
                </div>
                <div style="font-size:11px;color:${done ? '#16a34a' : '#64748b'};margin-top:4px;">${done ? 'Fully used' : money(item.remaining) + ' left'}</div>
              </td>
            </tr>`;
    }).join('');

    const more = cardPromos.moreCount
      ? `<div style="font-size:11px;color:#94a3b8;margin-top:10px;font-style:italic;">and ${cardPromos.moreCount} more on the Card Promotions tab.</div>`
      : '';

    return `
    <tr>
      <td style="padding:0 28px 20px;">
        <div style="border-top:1px solid #e2e8f0;padding-top:20px;">
          <div style="font-size:11px;font-weight:700;letter-spacing:0.08em;text-transform:uppercase;color:#64748b;margin-bottom:4px;">Card Promotions</div>
          <div style="font-size:12px;color:#64748b;margin-bottom:14px;"><strong>${money(cardPromos.remaining)}</strong> still unclaimed of ${money(cardPromos.totalValue)} across ${cardPromos.count} benefit${cardPromos.count === 1 ? '' : 's'}${cardPromos.completedCount ? ` · ${cardPromos.completedCount} marked done` : ''}.</div>
          <table role="presentation" width="100%" style="border-collapse:collapse;font-size:12px;">
            ${promoRows}
          </table>
          ${more}
        </div>
      </td>
    </tr>`;
  })() : '';

  parts.topCategories = topCategories.length ? `
    <tr>
      <td style="padding:0 28px 20px;">
        <div style="border-top:1px solid #e2e8f0;padding-top:20px;">
          <div style="font-size:11px;font-weight:700;letter-spacing:0.08em;text-transform:uppercase;color:#64748b;margin-bottom:8px;">Top Categories</div>
          <table role="presentation" width="100%" style="border-collapse:collapse;">
            ${catRows}
          </table>
        </div>
      </td>
    </tr>` : '';

  parts.topMerchants = topMerchants.length ? `
    <tr>
      <td style="padding:0 28px 20px;">
        <div style="border-top:1px solid #e2e8f0;padding-top:20px;">
          <div style="font-size:11px;font-weight:700;letter-spacing:0.08em;text-transform:uppercase;color:#64748b;margin-bottom:8px;">Top Merchants</div>
          <table role="presentation" width="100%" style="border-collapse:collapse;">
            ${merchRows}
          </table>
        </div>
      </td>
    </tr>` : '';

  parts.monthlyTrends = (monthlyTrends && (monthlyTrends.mtdTotal > 0 || monthlyTrends.priorMtdTotal > 0)) ? (() => {
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
      <td style="padding:0 28px 20px;">
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
  })() : '';

  parts.uncategorized = uncategorized.length ? `
    <tr>
      <td style="padding:0 28px 20px;">
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
      <td style="padding:0 28px 20px;">
        <div style="border-top:1px solid #e2e8f0;padding-top:20px;font-size:13px;color:#16a34a;">✓ Everything categorized this week — nice.</div>
      </td>
    </tr>`;

  const enabled = sections.filter(s => s.enabled).map(s => parts[s.id]).filter(Boolean);
  // The fixed header block is intentionally omitted, so strip the first visible
  // section's top divider (otherwise a stray rule sits flush at the card's top
  // edge) and give it a little breathing room instead.
  if (enabled.length) {
    enabled[0] = enabled[0].replace('border-top:1px solid #e2e8f0;padding-top:20px;', 'padding-top:24px;');
  }
  const body = enabled.join('\n');

  return `<!doctype html>
<html>
<head><meta charset="utf-8"><title>Weekly Spending Summary</title></head>
<body style="margin:0;padding:24px;background:#f8fafc;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;color:#111;">
  <table role="presentation" width="100%" style="max-width:960px;margin:0 auto;background:#ffffff;border-radius:12px;box-shadow:0 1px 3px rgba(0,0,0,0.06);overflow:hidden;">
    ${body}
    <tr>
      <td style="padding:16px 28px 24px;background:#f8fafc;border-top:1px solid #e2e8f0;">
        <div style="font-size:11px;color:#94a3b8;text-align:center;">Wealth Architect · Automated weekly summary</div>
      </td>
    </tr>
  </table>
</body>
</html>`;
}
