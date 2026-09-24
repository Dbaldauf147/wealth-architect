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
// `pattern` runs against a lowercased haystack of category + subcategory +
// merchant text; the first rule that matches wins, so order is specificity.
// It's a bare regex rather than a predicate so the "why this card?" popup can
// quote the words that put a charge in its category.
export const REWARD_CATEGORIES = [
  {
    key: 'amazon',
    label: 'Amazon / Whole Foods / Amazon Fresh',
    rates: { sapphire: 1.5, prime: 5, bofa: 1 },
    display: { sapphire: '1X', prime: '5%', bofa: '1%' },
    pattern: /\bamazon\b|\bamzn\b|whole foods|\bwfm\b/,
  },
  {
    key: 'wholesale',
    label: 'Wholesale clubs',
    rates: { sapphire: 1.5, prime: 1, bofa: 2 },
    display: { sapphire: '1X', prime: '1%', bofa: '2%' },
    pattern: /costco|sam'?s club|\bbj'?s\b|wholesale club/,
  },
  {
    key: 'drugstore',
    label: 'Drugstores / pharmacies',
    rates: { sapphire: 1.5, prime: 1, bofa: 1 },
    display: { sapphire: '1X', prime: '1%', bofa: '1%' },
    pattern: /\bcvs\b|walgreens|duane reade|rite aid|pharmac|drugstore/,
  },
  {
    key: 'homeImprovement',
    label: 'Home improvement',
    rates: { sapphire: 1.5, prime: 1, bofa: 1 },
    display: { sapphire: '1X', prime: '1%', bofa: '1%' },
    pattern: /home depot|lowe'?s\b|ace hardware|menards|home improvement/,
  },
  {
    key: 'travelPortal',
    label: 'Travel (via card portal)',
    rates: { sapphire: 12, prime: 5, bofa: 1 },
    display: { sapphire: '8X (Chase Travel)', prime: '5% (Chase Travel)', bofa: '1%' },
    pattern: /chase ?travel/,
  },
  {
    key: 'travelDirect',
    label: 'Travel (booked direct)',
    rates: { sapphire: 6, prime: 1, bofa: 1 },
    display: { sapphire: '4X flights & hotels', prime: '1%', bofa: '1%' },
    pattern: /\bflights?\b|airlines?\b|\bhotels?\b|motel|resort|marriott|hilton|hyatt|airbnb|vrbo|jetblue|delta air|united air|american air|southwest air|expedia|booking\.com|car rental|hertz|\bavis\b|enterprise rent|amtrak|\btravel\b|vacation/,
  },
  {
    key: 'gas',
    label: 'Gas / EV charging',
    rates: { sapphire: 1.5, prime: 2, bofa: 3 },
    display: { sapphire: '1X', prime: '2%', bofa: '3% (selected category)' },
    // Deliberately narrow: a bare "gas" is the utility bill, not a fill-up.
    pattern: /gas (&|and) fuel|gas station|\bfuel\b|\bshell\b|exxon|chevron|\bbp\b|mobil|sunoco|citgo|\bwawa\b|speedway|ev charg|supercharger|electrify america/,
  },
  {
    key: 'groceries',
    label: 'Groceries (supermarkets)',
    rates: { sapphire: 1.5, prime: 1, bofa: 2 },
    display: { sapphire: '1X', prime: '1%', bofa: '2%' },
    pattern: /grocer|supermarket|trader joe|wegmans|safeway|kroger|publix|key food|c-?town|stop (&|and) shop|food bazaar|fairway|\bh mart\b|aldi\b/,
  },
  {
    key: 'dining',
    label: 'Dining / Restaurants',
    rates: { sapphire: 4.5, prime: 2, bofa: 1 },
    display: { sapphire: '3X', prime: '2%', bofa: '1%' },
    pattern: /restaurant|dining|fast food|food deliv|doordash|\bdd \*|uber ?eats|grubhub|seamless|caviar|postmates|\bcafe\b|coffee|starbucks|dunkin|bakery|\bdeli\b|pizzeria|pizza\b|\btst\*|brewery|\bbars?\b|alcohol|mcdonald|chipotle|sweetgreen/,
  },
  {
    key: 'transit',
    label: 'Transit / rideshare',
    rates: { sapphire: 1.5, prime: 2, bofa: 1 },
    display: { sapphire: '1X', prime: '2%', bofa: '1%' },
    pattern: /ride ?share|\buber\b|\blyft\b|\bmta\b|metrocard|\bomny\b|public transit|\btransit\b|\btaxi\b|citi ?bike/,
  },
  {
    key: 'onlineShopping',
    label: 'Online shopping',
    rates: { sapphire: 1.5, prime: 1, bofa: 1 },
    display: { sapphire: '1X', prime: '1%', bofa: '1%' },
    pattern: /online shopping|\betsy\b|\bebay\b|wayfair|\btemu\b|shein/,
  },
  {
    key: 'other',
    label: 'Everything else',
    rates: { sapphire: 1.5, prime: 1, bofa: 1 },
    display: { sapphire: '1X', prime: '1%', bofa: '1%' },
    pattern: null, // catch-all
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

/** Which reward category a transaction earns in, and the text that put it
 *  there (null for the catch-all). */
function classify(t) {
  const h = haystack(t);
  for (const c of REWARD_CATEGORIES) {
    if (!c.pattern) return { key: c.key, matched: null };
    const m = h.match(c.pattern);
    if (m) return { key: c.key, matched: m[0].trim() };
  }
  return { key: 'other', matched: null };
}

/** Which reward category a transaction earns in. Falls back to 'other'. */
export function classifyRewardCategory(t) {
  return classify(t).key;
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
// accounts, rent, investments, and card fees/interest. Returns why, or null.
function notADiscretionarySwipe(t) {
  const cat = (t.category || '').toLowerCase();
  const sub = (t.subcategory || '').toLowerCase();
  if (cat === 'transfer' || sub === 'account transfer') return 'a transfer between your own accounts';
  if (cat.startsWith('credit card payment') || sub.startsWith('credit card payment')) return 'a credit card payment';
  if (cat === 'investments' || cat === 'retirement' || sub === 'retirement') return 'an investment or retirement contribution';
  if (cat === 'rent' || sub === 'rent' || cat === 'housing') return 'rent / housing';
  if (cat === 'fees & charges' || /interest charge|late fee|annual fee|bank fee/.test(sub)) return 'a fee or interest charge';
  const desc = `${t.description || ''} ${t.fullDescription || ''}`.toLowerCase();
  if (/automatic payment\s*-?\s*thank|credit crd|payment thank you/.test(desc)) return 'a credit card payment';
  return null;
}

// An account we couldn't identify is only worth nagging about if it looks like
// a credit card in the first place — checking-account spend isn't a card choice.
export function looksLikeCard(name) {
  return /card|visa|amex|american express|mastercard|discover|credit/i.test(name || '');
}

/**
 * Why one charge was (or wasn't) put on the right card — the reasoning behind
 * a single row of findSuboptimalCharges, laid out for the "why?" popup. Both
 * go through here, so the popup can't contradict the flag table.
 *
 * verdict:
 *   'best'        the card used pays the most (or ties for the most) here
 *   'suboptimal'  another card pays more; `missed` is the dollar gap
 *   'unknownCard' the account isn't mapped to a card profile
 *   'ignored'     the account is mapped to "ignore"
 *   'excluded'    not a rewards decision (transfer, rent, fee...); see `excludedReason`
 *   'notACharge'  a refund, credit or deposit
 *
 * `ranking` lists every card best-first with its rate and what this charge
 * would have earned on it, so the popup shows the comparison, not just the
 * winner. `matched` is the text that put the charge in its category.
 */
export function explainCardChoice(t, usedKey) {
  const amt = Number(t?.amount) || 0;
  const spend = Math.abs(amt);
  const { key: categoryKey, matched } = classify(t || {});
  const cat = rewardCategory(categoryKey);
  const ranked = rankCards(categoryKey);
  const topRate = cat.rates[ranked[0]];
  const ranking = ranked.map(key => ({
    key,
    rate: cat.rates[key],
    display: cat.display[key],
    earned: (spend * cat.rates[key]) / 100,
    best: cat.rates[key] === topRate,
  }));
  const base = {
    spend, categoryKey, categoryLabel: cat.label, matched, ranking,
    usedKey: CARD_KEYS.includes(usedKey) ? usedKey : null,
    bestKey: ranked[0], bestRate: topRate,
    usedRate: null, missed: 0, excludedReason: null,
  };

  if (!(amt < 0)) return { ...base, verdict: 'notACharge' };
  const excludedReason = notADiscretionarySwipe(t);
  if (excludedReason) return { ...base, verdict: 'excluded', excludedReason };
  if (usedKey === 'ignore') return { ...base, verdict: 'ignored' };
  if (!base.usedKey) return { ...base, verdict: 'unknownCard' };

  const usedRate = cat.rates[usedKey];
  return {
    ...base,
    verdict: usedRate >= topRate ? 'best' : 'suboptimal',
    // On a tie the card actually used is the answer, not whichever sorted first.
    bestKey: usedRate >= topRate ? usedKey : ranked[0],
    usedRate,
    missed: Math.max(0, (spend * (topRate - usedRate)) / 100),
  };
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

    const account = t.account || '';
    const x = explainCardChoice(t, cardKeyFor(account));
    if (x.verdict === 'excluded' || x.verdict === 'ignored') continue;
    if (x.verdict === 'unknownCard') {
      if (looksLikeCard(account)) {
        const prev = unknown.get(account) || { account, count: 0, total: 0 };
        prev.count += 1;
        prev.total += x.spend;
        unknown.set(account, prev);
      }
      continue;
    }

    evaluatedCount += 1;
    totalCharges += x.spend;
    if (x.verdict !== 'suboptimal' || x.missed < minMissed) continue;

    totalMissed += x.missed;
    flagged.push({
      id: t.transactionId || `${t.date}|${t.description}|${t.amount}`,
      date: t.date,
      description: t.description || '(no merchant)',
      account,
      spend: x.spend,
      categoryKey: x.categoryKey,
      categoryLabel: x.categoryLabel,
      usedKey: x.usedKey,
      usedRate: x.usedRate,
      bestKey: x.bestKey,
      bestRate: x.bestRate,
      missed: x.missed,
      // The source row, so the page can open the "why?" popup on it.
      txn: t,
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
