// State tax on capital gains, as a starting point.
//
// READ THIS BEFORE TRUSTING A NUMBER HERE.
//
// `rate` is the state's **top marginal** individual income tax rate, which is
// what most states apply to capital gains. Three things make it an
// approximation rather than an answer:
//
//   1. In a graduated state it is the *top* bracket. Someone well below it
//      pays less — often much less. California's 13.3% applies over $1M.
//   2. A dozen states treat capital gains differently from wages — an
//      exclusion, a preferential rate, a separate excise, or no tax at all.
//      Those carry a `note`, and the rate shown is the headline one, not the
//      effective one, except where the note says otherwise.
//   3. Rates move. Several states are mid-way through scheduled cuts, and
//      these were compiled for the 2025–26 filing years.
//
// The figure is only ever used to prefill an editable box. Anyone who knows
// their real rate should type it, and the UI says so.

export const STATE_TAX_AS_OF = '2025–26 filing years';

export const NO_INCOME_TAX = ['AK', 'FL', 'NV', 'NH', 'SD', 'TN', 'TX', 'WY'];

export const STATES = [
  { code: 'AL', name: 'Alabama', rate: 0.0500 },
  { code: 'AK', name: 'Alaska', rate: 0, note: 'No state income tax.' },
  { code: 'AZ', name: 'Arizona', rate: 0.0250, note: 'A 25% subtraction applies to long-term gains on assets acquired after 2011, so the effective rate is nearer 1.9%.' },
  { code: 'AR', name: 'Arkansas', rate: 0.0390, note: '50% of net long-term gains are excluded, so the effective rate is roughly half the figure shown.' },
  { code: 'CA', name: 'California', rate: 0.1330, note: 'Graduated. 13.3% is the top bracket including the 1% surcharge over $1M — most filers are well below it.' },
  { code: 'CO', name: 'Colorado', rate: 0.0440 },
  { code: 'CT', name: 'Connecticut', rate: 0.0699, note: 'Graduated; this is the top bracket.' },
  { code: 'DE', name: 'Delaware', rate: 0.0660, note: 'Graduated; this is the top bracket.' },
  { code: 'DC', name: 'District of Columbia', rate: 0.1075, note: 'Graduated; this is the top bracket.' },
  { code: 'FL', name: 'Florida', rate: 0, note: 'No state income tax.' },
  { code: 'GA', name: 'Georgia', rate: 0.0519, note: 'Flat, and scheduled to keep falling toward 4.99%.' },
  { code: 'HI', name: 'Hawaii', rate: 0.1100, note: 'Long-term gains are capped at 7.25%, well below the top income rate shown.' },
  { code: 'ID', name: 'Idaho', rate: 0.0530 },
  { code: 'IL', name: 'Illinois', rate: 0.0495, note: 'Flat rate.' },
  { code: 'IN', name: 'Indiana', rate: 0.0300, note: 'Flat, and still falling. Counties add roughly 1–3% on top.' },
  { code: 'IA', name: 'Iowa', rate: 0.0380, note: 'Flat rate.' },
  { code: 'KS', name: 'Kansas', rate: 0.0558, note: 'Graduated; this is the top bracket.' },
  { code: 'KY', name: 'Kentucky', rate: 0.0400, note: 'Flat, and scheduled to fall to 3.5%.' },
  { code: 'LA', name: 'Louisiana', rate: 0.0300, note: 'Flat rate.' },
  { code: 'ME', name: 'Maine', rate: 0.0715, note: 'Graduated; this is the top bracket.' },
  { code: 'MD', name: 'Maryland', rate: 0.0575, note: 'Counties add roughly 2.25–3.2% on top of this.' },
  { code: 'MA', name: 'Massachusetts', rate: 0.0500, note: 'Long-term gains 5%, short-term gains 8.5%, plus a 4% surtax on income over about $1M.' },
  { code: 'MI', name: 'Michigan', rate: 0.0425, note: 'Flat. Some cities add roughly 1–2.4%.' },
  { code: 'MN', name: 'Minnesota', rate: 0.0985, note: 'Graduated; this is the top bracket. An extra 1% applies to net investment income over $1M.' },
  { code: 'MS', name: 'Mississippi', rate: 0.0440, note: 'Flat, and scheduled to keep falling.' },
  { code: 'MO', name: 'Missouri', rate: 0, note: 'Missouri exempted individual capital gains from 2025 — worth confirming it applies to you.' },
  { code: 'MT', name: 'Montana', rate: 0.0590, note: 'Capital gains get preferential rates of roughly 3.0–4.1%, below the figure shown.' },
  { code: 'NE', name: 'Nebraska', rate: 0.0520, note: 'Graduated and scheduled to fall toward 3.99%.' },
  { code: 'NV', name: 'Nevada', rate: 0, note: 'No state income tax.' },
  { code: 'NH', name: 'New Hampshire', rate: 0, note: 'No tax on wages or gains; the interest and dividends tax was repealed from 2025.' },
  { code: 'NJ', name: 'New Jersey', rate: 0.1075, note: 'Graduated; this is the top bracket, over $1M.' },
  { code: 'NM', name: 'New Mexico', rate: 0.0590, note: '40% of net capital gains can be deducted, so the effective rate is lower.' },
  { code: 'NY', name: 'New York', rate: 0.1090, note: 'Graduated; this is the top bracket. New York City residents add roughly 3.9% more.' },
  { code: 'NC', name: 'North Carolina', rate: 0.0425, note: 'Flat, and scheduled to keep falling.' },
  { code: 'ND', name: 'North Dakota', rate: 0.0250, note: '40% of long-term gains are excluded, so the effective rate is lower.' },
  { code: 'OH', name: 'Ohio', rate: 0.0350, note: 'Graduated; this is the top bracket.' },
  { code: 'OK', name: 'Oklahoma', rate: 0.0475, note: 'Graduated; this is the top bracket.' },
  { code: 'OR', name: 'Oregon', rate: 0.0990, note: 'Graduated; this is the top bracket. Portland-area residents pay more.' },
  { code: 'PA', name: 'Pennsylvania', rate: 0.0307, note: 'Flat. Municipalities may add a local earned income tax.' },
  { code: 'RI', name: 'Rhode Island', rate: 0.0599, note: 'Graduated; this is the top bracket.' },
  { code: 'SC', name: 'South Carolina', rate: 0.0620, note: '44% of net long-term gains are deducted, putting the effective rate nearer 3.5%.' },
  { code: 'SD', name: 'South Dakota', rate: 0, note: 'No state income tax.' },
  { code: 'TN', name: 'Tennessee', rate: 0, note: 'No state income tax.' },
  { code: 'TX', name: 'Texas', rate: 0, note: 'No state income tax.' },
  { code: 'UT', name: 'Utah', rate: 0.0455, note: 'Flat rate.' },
  { code: 'VT', name: 'Vermont', rate: 0.0875, note: 'Graduated; this is the top bracket. A partial exclusion applies to some long-term gains.' },
  { code: 'VA', name: 'Virginia', rate: 0.0575, note: 'Graduated; this is the top bracket.' },
  { code: 'WA', name: 'Washington', rate: 0.0700, note: 'No income tax, but a 7% excise on long-term gains above roughly $270,000 a year. Below that, nothing.' },
  { code: 'WV', name: 'West Virginia', rate: 0.0482, note: 'Graduated and scheduled to keep falling.' },
  { code: 'WI', name: 'Wisconsin', rate: 0.0765, note: '30% of long-term gains are excluded, putting the effective rate nearer 5.4%.' },
  { code: 'WY', name: 'Wyoming', rate: 0, note: 'No state income tax.' },
];

export function findState(code) {
  return STATES.find(s => s.code === code) || null;
}
