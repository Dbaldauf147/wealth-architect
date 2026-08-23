/* The category vocabulary, shared by every surface that shows or assigns one.

   These used to live inside TransactionsPage. The mobile categorizer needs the
   same list — and, more importantly, needs it to *stay* the same list, so a
   category added here shows up in both places instead of drifting apart. No
   React, no DOM: safe to import from a Vercel Function too. */

export const ALL_CATEGORIES = [
  'Food & Drink', 'Shopping', 'Travel', 'Entertainment', 'Bills & Utilities',
  'Housing', 'Transportation', 'Health & Wellness', 'Income', 'Transfer',
  'Education', 'Personal Care', 'Gifts & Donations', 'Investments', 'Fees & Charges',
  'Uncategorized',
];

export const SUBCATEGORIES = {
  'Food & Drink': ['Restaurants', 'Groceries', 'Fast Food', 'Alcohol & Bars', 'Delivery'],
  'Shopping': ['Clothing', 'Electronics', 'Home Goods', 'Online Shopping', 'Sporting Goods', 'Books'],
  'Travel': ['Flights', 'Hotels', 'Car Rental', 'Vacation', 'Luggage & Travel Gear'],
  'Entertainment': ['Streaming', 'Movies & TV', 'Music', 'Games', 'Events & Concerts', 'Sports'],
  'Bills & Utilities': ['Electric', 'Gas', 'Water', 'Internet', 'Phone', 'Subscriptions', 'Insurance'],
  'Housing': ['Rent', 'Mortgage', 'Property Tax', 'HOA', 'Maintenance & Repairs', 'Furniture'],
  'Transportation': ['Gas & Fuel', 'Parking', 'Tolls', 'Public Transit', 'Ride Share', 'Car Payment', 'Car Insurance', 'Auto Maintenance'],
  'Health & Wellness': ['Doctor', 'Pharmacy', 'Gym & Fitness', 'Mental Health', 'Dental', 'Vision'],
  'Income': ['Salary', 'Freelance', 'Interest', 'Dividends', 'Refund', 'Bonus', 'Other Income'],
  'Transfer': ['Account Transfer', 'Credit Card Payment', 'Loan Payment', 'Investment Transfer'],
  'Education': ['Tuition', 'Books & Supplies', 'Courses', 'Student Loans'],
  'Personal Care': ['Haircut', 'Skincare', 'Spa', 'Cosmetics'],
  'Gifts & Donations': ['Gifts', 'Charity', 'Religious'],
  'Investments': ['Stocks', 'Crypto', 'Real Estate', 'Retirement'],
  'Fees & Charges': ['Bank Fees', 'ATM Fees', 'Late Fees', 'Service Charges', 'Interest Charges'],
};

export const CATEGORY_ICONS = {
  'Food & Drink': 'restaurant',
  'Shopping': 'shopping_bag',
  'Travel': 'flight',
  'Entertainment': 'movie',
  'Bills & Utilities': 'receipt',
  'Housing': 'home',
  'Transportation': 'directions_car',
  'Health & Wellness': 'health_and_safety',
  'Income': 'payments',
  'Transfer': 'swap_horiz',
  'Education': 'school',
  'Personal Care': 'self_improvement',
  'Gifts & Donations': 'redeem',
  'Investments': 'trending_up',
  'Fees & Charges': 'account_balance_wallet',
};

export function getCategoryIcon(cat) {
  return CATEGORY_ICONS[cat] || 'receipt_long';
}

/* Deterministic colour from category name */
export const PALETTE = [
  '#ba1a1a', '#009668', '#0058be', '#7c3aed', '#e8a317',
  '#475569', '#d946ef', '#0891b2', '#dc2626', '#16a34a',
  '#9333ea', '#ea580c', '#2563eb', '#c026d3', '#059669',
];

export function catColor(name) {
  let hash = 0;
  for (let i = 0; i < name.length; i++) hash = name.charCodeAt(i) + ((hash << 5) - hash);
  return PALETTE[Math.abs(hash) % PALETTE.length];
}

export function catBg(name, alpha = 0.08) {
  const c = catColor(name);
  // convert hex to rgba
  const r = parseInt(c.slice(1, 3), 16);
  const g = parseInt(c.slice(3, 5), 16);
  const b = parseInt(c.slice(5, 7), 16);
  return `rgba(${r},${g},${b},${alpha})`;
}

/* Categories that are money arriving or money merely moving between the
   user's own accounts — never "spending". The review flow uses this to keep
   an income card from being scored against the spending suggestions. */
export const NON_SPEND_CATEGORIES = new Set(['Income', 'Transfer', 'Investments']);
