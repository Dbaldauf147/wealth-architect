/* Small display helpers shared by the mobile screens. */

const money = new Intl.NumberFormat('en-US', {
  style: 'currency', currency: 'USD', minimumFractionDigits: 2,
});

const moneyRound = new Intl.NumberFormat('en-US', {
  style: 'currency', currency: 'USD', maximumFractionDigits: 0,
});

export const fmt = (n) => money.format(Number(n) || 0);

/* Amounts on a phone compete for width with everything else, so anything in
   the thousands drops its cents and anything past six figures is abbreviated. */
export function fmtCompact(n) {
  const v = Number(n) || 0;
  const abs = Math.abs(v);
  // 999,999 rounds up to 1000k, so hand anything that would over to the M branch.
  if (abs >= 999_500) return `${v < 0 ? '-' : ''}$${(abs / 1_000_000).toFixed(1)}M`;
  if (abs >= 100_000) return `${v < 0 ? '-' : ''}$${Math.round(abs / 1000)}k`;
  if (abs >= 1000) return moneyRound.format(v);
  return money.format(v);
}

export function parseDate(value) {
  if (!value) return null;
  // Sheet dates arrive as either ISO or M/D/YYYY; both parse, but an ISO
  // date-only string is parsed as UTC and can render as the previous day in
  // western timezones, so pin those to local noon.
  if (typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value)) {
    const [y, m, d] = value.split('-').map(Number);
    return new Date(y, m - 1, d, 12);
  }
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? null : d;
}

export function fmtDate(value) {
  const d = parseDate(value);
  if (!d) return '';
  return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
}

/* "3 days ago" reads faster than a date when triaging a backlog. */
export function fmtRelative(value, now = new Date()) {
  const d = parseDate(value);
  if (!d) return '';
  const days = Math.round((now - d) / 86_400_000);
  if (days <= 0) return 'Today';
  if (days === 1) return 'Yesterday';
  if (days < 7) return `${days} days ago`;
  if (days < 31) return `${Math.floor(days / 7)} week${days < 14 ? '' : 's'} ago`;
  if (days < 365) return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
  return d.toLocaleDateString('en-US', { month: 'short', year: 'numeric' });
}

export const monthKey = (value) => {
  const d = parseDate(value);
  if (!d) return '';
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
};

export function monthLabel(key) {
  if (!key) return '';
  const [y, m] = key.split('-').map(Number);
  return new Date(y, m - 1, 1).toLocaleDateString('en-US', { month: 'long', year: 'numeric' });
}
