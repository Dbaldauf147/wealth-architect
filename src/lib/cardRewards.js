/* Card reward rates and "did I swipe the right card?" analysis.
   Pure functions — no React, no DOM — so the page stays presentational.

   One numeric rate table drives both the Rate-by-Card grid on the Card
   Promotions tab and the suboptimal-charge flagging, so the two can't
   disagree about which card wins a category. */

// Chase points are valued at 1.5¢ each (the CSR portal/transfer redemption the
// rest of this page assumes), so CSR 3X dining reads as 4.5% effective.
export const POINT_VALUE_CENTS = 1.5;

export const CARD_KEYS = ['sapphire', 'prime', 'bofa'];

export const CARD_LABELS = {
  sapphire: 'Sapphire Reserve',
  prime: 'Prime Visa',
  bofa: 'BofA Customized Cash',
};

export const CARD_COLORS = {
  sapphire: '#0058be',
  prime: '#00a8e1',
  bofa: '#e31837',
};

/* BofA Customized Cash pays 3% in ONE chosen category and 1% elsewhere (plus a
   standing 2% at grocery stores / wholesale clubs). Which category is selected
   changes what counts as optimal, so it's stated once here rather than hedged
   with "or 3% if selected" in every row. */
export const BOFA_CHOICE = 'gas';

// Effective % back per card. `display` keeps the raw earn rate for the table.
// `match` runs against a lowercased haystack of category + subcategory +
// merchant text; the first rule that matches wins, so order is specificity.
export const REWARD_CATEGORIES = [
  {
    key: 'amazon',
    label: 'Amazon / Whole Foods / Amazon Fresh',
    rates: { sapphire: 1.5, prime: 5, bofa: 1 },
    display: { sapphire: '1X', prime: '5%', bofa: '1%' },
    match: h => /\bamazon\b|\bamzn\b|whole foods|\bwfm\b/.test(h),
  },
  {
    key: 'wholesale',
    label: 'Wholesale clubs',
    rates: { sapphire: 1.5, prime: 1, bofa: 2 },
    display: { sapphire: '1X', prime: '1%', bofa: '2%' },
    match: h => /costco|sam'?s club|\bbj'?s\b|wholesale club/.test(h),
  },
  {
    key: 'drugstore',
    label: 'Drugstores / pharmacies',
    rates: { sapphire: 1.5, prime: 1, bofa: 1 },
    display: { sapphire: '1X', prime: '1%', bofa: '1%' },
    match: h => /\bcvs\b|walgreens|duane reade|rite aid|pharmac|drugstore/.test(h),
  },
  {
    key: 'homeImprovement',
    label: 'Home improvement',
    rates: { sapphire: 1.5, prime: 1, bofa: 1 },
    display: { sapphire: '1X', prime: '1%', bofa: '1%' },
    match: h => /home depot|lowe'?s\b|ace hardware|menards|home improvement/.test(h),
  },
  {
    key: 'travelPortal',
    label: 'Travel (via card portal)',
    rates: { sapphire: 12, prime: 5, bofa: 1 },
    display: { sapphire: '8X (Chase Travel)', prime: '5% (Chase Travel)', bofa: '1%' },
    match: h => /chase ?travel/.test(h),
  },
  {
    key: 'travelDirect',
    label: 'Travel (booked direct)',
    rates: { sapphire: 6, prime: 1, bofa: 1 },
    display: { sapphire: '4X flights & hotels', prime: '1%', bofa: '1%' },
    match: h => /\bflights?\b|airlines?\b|\bhotels?\b|motel|resort|marriott|hilton|hyatt|airbnb|vrbo|jetblue|delta air|united air|american air|southwest air|expedia|booking\.com|car rental|hertz|\bavis\b|enterprise rent|amtrak|\btravel\b|vacation/.test(h),
  },
  {
    key: 'gas',
    label: 'Gas / EV charging',
    rates: { sapphire: 1.5, prime: 2, bofa: 3 },
    display: { sapphire: '1X', prime: '2%', bofa: '3% (selected category)' },
    // Deliberately narrow: a bare "gas" is the utility bill, not a fill-up.
    match: h => /gas (&|and) fuel|gas station|\bfuel\b|\bshell\b|exxon|chevron|\bbp\b|mobil|sunoco|citgo|\bwawa\b|speedway|ev charg|supercharger|electrify america/.test(h),
  },
  {
    key: 'groceries',
    label: 'Groceries (supermarkets)',
    rates: { sapphire: 1.5, prime: 1, bofa: 2 },
    display: { sapphire: '1X', prime: '1%', bofa: '2%' },
    match: h => /grocer|supermarket|trader joe|wegmans|safeway|kroger|publix|key food|c-?town|stop (&|and) shop|food bazaar|fairway|\bh mart\b|aldi\b/.test(h),
  },
  {
    key: 'dining',
    label: 'Dining / Restaurants',
    rates: { sapphire: 4.5, prime: 2, bofa: 1 },
    display: { sapphire: '3X', prime: '2%', bofa: '1%' },
    match: h => /restaurant|dining|fast food|food deliv|doordash|\bdd \*|uber ?eats|grubhub|seamless|caviar|postmates|\bcafe\b|coffee|starbucks|dunkin|bakery|\bdeli\b|pizzeria|pizza\b|\btst\*|brewery|\bbars?\b|alcohol|mcdonald|chipotle|sweetgreen/.test(h),
  },
  {
    key: 'transit',
    label: 'Transit / rideshare',
    rates: { sapphire: 1.5, prime: 2, bofa: 1 },
    display: { sapphire: '1X', prime: '2%', bofa: '1%' },
    match: h => /ride ?share|\buber\b|\blyft\b|\bmta\b|metrocard|\bomny\b|public transit|\btransit\b|\btaxi\b|citi ?bike/.test(h),
  },
  {
    key: 'onlineShopping',
    label: 'Online shopping',
    rates: { sapphire: 1.5, prime: 1, bofa: 1 },
    display: { sapphire: '1X', prime: '1%', bofa: '1%' },
    match: h => /online shopping|\betsy\b|\bebay\b|wayfair|\btemu\b|shein/.test(h),
  },
  {
    key: 'other',
    label: 'Everything else',
    rates: { sapphire: 1.5, prime: 1, bofa: 1 },
    display: { sapphire: '1X', prime: '1%', bofa: '1%' },
    match: () => true,
  },
];

const BY_KEY = new Map(REWARD_CATEGORIES.map(c => [c.key, c]));
export const rewardCategory = key => BY_KEY.get(key) || BY_KEY.get('other');

/** The best-paying card for a reward category, and the runners-up, sorted. */
export function rankCards(catKey) {
  const { rates } = rewardCategory(catKey);
  return CARD_KEYS.slice().sort((a, b) => rates[b] - rates[a]);
}

function haystack(t) {
  return `${t.category || ''} ${t.subcategory || ''} ${t.description || ''} ${t.fullDescription || ''}`.toLowerCase();
}

/** Which reward category a transaction earns in. Falls back to 'other'. */
export function classifyRewardCategory(t) {
  const h = haystack(t);
  for (const c of REWARD_CATEGORIES) {
    if (c.match(h)) return c.key;
  }
  return 'other';
}

/** Guess which card an account is from its name (or nickname). Returns null
 *  when the name doesn't identify a card, so the caller can ask the user. */
export function detectCardKey(...names) {
  const n = names.filter(Boolean).join(' ').toLowerCase();
  if (!n) return null;
  if (/sapphire|\bcsr\b/.test(n)) return 'sapphire';
  if (/prime|amazon/.test(n)) return 'prime';
  if (/\bbofa\b|bank of america|customized cash/.test(n)) return 'bofa';
  return null;
}

// Rows that aren't a rewards decision: money moving between the user's own
// accounts, rent, investments, and card fees/interest.
function isNotADiscretionarySwipe(t) {
  const cat = (t.category || '').toLowerCase();
  const sub = (t.subcategory || '').toLowerCase();
  if (cat === 'transfer' || sub === 'account transfer') return true;
  if (cat.startsWith('credit card payment') || sub.startsWith('credit card payment')) return true;
  if (cat === 'investments' || cat === 'retirement' || sub === 'retirement') return true;
  if (cat === 'rent' || sub === 'rent' || cat === 'housing') return true;
  if (cat === 'fees & charges' || /interest charge|late fee|annual fee|bank fee/.test(sub)) return true;
  const desc = `${t.description || ''} ${t.fullDescription || ''}`.toLowerCase();
  if (/automatic payment\s*-?\s*thank|credit crd|payment thank you/.test(desc)) return true;
  return false;
}

// An account we couldn't identify is only worth nagging about if it looks like
// a credit card in the first place — checking-account spend isn't a card choice.
export function looksLikeCard(name) {
  return /card|visa|amex|american express|mastercard|discover|credit/i.test(name || '');
}

/**
 * Charges in the last `days` where a better-paying card was available.
 *
 * @param transactions  all transactions
 * @param asOf          window end (default now)
 * @param days          lookback length (default 30)
 * @param cardKeyFor    (accountName) => card key | null | 'ignore'
 * @param minMissed     hide flags worth less than this many dollars
 * @returns { flagged, totalMissed, totalCharges, evaluatedCount, unknownAccounts, start, end }
 */
export function findSuboptimalCharges({
  transactions,
  asOf = new Date(),
  days = 30,
  cardKeyFor = () => null,
  minMissed = 0.25,
}) {
  const end = new Date(asOf);
  end.setHours(23, 59, 59, 999);
  const start = new Date(end);
  start.setDate(start.getDate() - (days - 1));
  start.setHours(0, 0, 0, 0);

  const flagged = [];
  const unknown = new Map();
  let totalMissed = 0;
  let totalCharges = 0;
  let evaluatedCount = 0;

  for (const t of transactions || []) {
    const amt = Number(t.amount) || 0;
    if (!(amt < 0)) continue; // charges only — refunds and credits aren't a choice
    if (!t.date) continue;
    const d = new Date(t.date);
    if (isNaN(d) || d < start || d > end) continue;
    if (isNotADiscretionarySwipe(t)) continue;

    const account = t.account || '';
    const usedKey = cardKeyFor(account);
    if (usedKey === 'ignore') continue;
    if (!usedKey) {
      if (looksLikeCard(account)) {
        const prev = unknown.get(account) || { account, count: 0, total: 0 };
        prev.count += 1;
        prev.total += Math.abs(amt);
        unknown.set(account, prev);
      }
      continue;
    }

    const spend = Math.abs(amt);
    const catKey = classifyRewardCategory(t);
    const cat = rewardCategory(catKey);
    const [bestKey] = rankCards(catKey);
    const usedRate = cat.rates[usedKey];
    const bestRate = cat.rates[bestKey];

    evaluatedCount += 1;
    totalCharges += spend;
    const missed = (spend * (bestRate - usedRate)) / 100;
    if (bestRate <= usedRate || missed < minMissed) continue;

    totalMissed += missed;
    flagged.push({
      id: t.transactionId || `${t.date}|${t.description}|${t.amount}`,
      date: t.date,
      description: t.description || '(no merchant)',
      account,
      spend,
      categoryKey: catKey,
      categoryLabel: cat.label,
      usedKey,
      usedRate,
      bestKey,
      bestRate,
      missed,
    });
  }

  flagged.sort((a, b) => b.missed - a.missed);
  return {
    flagged,
    totalMissed,
    totalCharges,
    evaluatedCount,
    unknownAccounts: [...unknown.values()].sort((a, b) => b.total - a.total),
    start,
    end,
  };
}
