# Wealth Architect

A React + Vite app over a Tiller-style Google Sheet, with per-device settings
synced through Firestore.

## Mobile categorizer (PWA)

`#m/review` is a separate, phone-shaped shell for the one job that is painful on
a desktop spreadsheet and easy on a phone: deciding what each transaction is.
It is installable to a home screen — `public/manifest.webmanifest` starts it at
`#m/review`, and `public/sw.js` keeps the shell openable offline.

It reads and writes through the same `DataProvider` as the desktop app, so a
category assigned on a phone is the same category the Transactions table, the
budgets, and the weekly email see.

| Piece | What it does |
| --- | --- |
| `src/mobile/` | The shell: a card deck to review, a list of what was filed, and the month it adds up to |
| `src/lib/suggest.js` | Ranks likely categories from the user's own history — merchant matches first, then shared description words. Pure; no React |
| `src/lib/reviewQueue.js` | Orders the backlog and groups charges from one merchant into a single decision. Pure |
| `src/lib/categories.js` | The category vocabulary, shared with the desktop page so the two can't drift |

Filing a card asks for the category, then the detail (subcategory) — the
prompt is one tap to skip, and a switch on the Rules screen turns it off for a
long triage session. Both kinds of rule are editable there, each row showing
how many transactions it currently matches so an over-broad filter is visible
before it mis-files a year of spending.

Tapping **Split** flags a charge that other people owe a share of and hands it
to Rally (a separate app, `Dbaldauf147/rally`) over `api/rally-expense.js`. The
tag is written locally first and kept even when the hand-off fails, so the
Splits tab is an outbox with a retry rather than a place tags disappear from.
The bridge is a server route because the shared secret Rally authenticates with
must never reach a browser bundle; it needs `RALLY_API_URL` and
`RALLY_INGEST_SECRET`.

Suggestions are drawn only from categories the user has already assigned
themselves — there is no hard-coded merchant list — and every one shows why it
was suggested, so a wrong guess is visible before it is tapped.

## Purchase alerts

The bank texts you seconds after the card is used; the row it belongs to
reaches the sheet days later, reworded by the card network. Answering "what was
that?" in the shop is a much easier question than answering it next week
against `34N7THST FEES BROOKLYN NY` — so an alert can be categorized the moment
it arrives, and the answer waits for its transaction.

**Nothing here creates a transaction.** The sheet stays the only source of rows.
An alert is a note that hands its category over once the real row appears and
then stops existing; one nobody answers simply expires.

| Piece | What it does |
| --- | --- |
| `api/spend-alert.js` | Receives the alert, reads it, writes it to Firestore `spendAlerts` |
| `src/lib/parseAlert.js` | Pulls amount, merchant, card and date out of the bank's prose. Pure; tested against six issuers' wordings |
| `src/lib/alertMatch.js` | Joins an alert to the transaction that later arrives. Pure; tested |
| `src/mobile/AlertsStrip.jsx` | The card above the review deck that asks the question |

Some issuers send as the card rather than the bank — `Prime Visa:`, `Chase
Sapphire Reserve Visa:` — and quote no last four anywhere. That sender label
is then the only thing saying which card was used, so it is kept and matched
against the transaction’s account; network words (`visa`, `amex`, `platinum`)
are ignored in that comparison or every Visa would vouch for every other.

Matching is on the **amount**, exact to the cent — it is the one field neither
the bank nor the network rewrites. The merchant only corroborates, and the date
window allows two days early and ten late for a card to post. Where two
transactions are equally good candidates the alert is left alone: a silent
wrong match writes a category onto someone else's row and looks like you did
it. A category already set by hand is never overwritten.

### Setting it up

1. **Vercel env:** set `SPEND_ALERT_SECRET` to a long random string. Without it
   the route returns 503 and nothing is accepted. `FIREBASE_SERVICE_ACCOUNT_JSON`
   is the same one the crons already use.
2. **Firestore rules:** publish `firestore.rules` — it now carries a
   `spendAlerts` block. Until that is published the phone can read nothing and
   the strip stays empty.
3. **On the iPhone**, Shortcuts → Automation → New. Two are worth having:

   **Bank texts** — trigger *Message*, From: your bank's shortcode, and set it
   to **Run Immediately**. One action, *Get Contents of URL*:

   ```
   URL     https://<your-app>/api/spend-alert
   Method  POST
   Headers x-ingest-secret: <SPEND_ALERT_SECRET>
   Body    JSON  →  text : [Shortcut Input]
   ```

   **Apple Pay taps** — trigger *Transaction*, same action, but send the fields
   already structured so nothing has to be parsed:

   ```
   Body  JSON  →  source   : wallet
                  merchant : [Merchant Name]
                  amount   : [Amount]
                  date     : [Date]
   ```

iOS always posts a notification when an automation runs immediately — Apple
requires it and the toggle can't be turned off — so every alert is visible.
Messages that aren't purchases (declines, balances, one-time codes) are
recognised and dropped with a `200`, so the automation can fire on everything
the bank sends without filling the queue with noise.

The icon PNGs in `public/` are generated: edit `public/app-icon*.svg`, then run
`node scripts/make-icons.mjs`.

## Development

```sh
npm install
npm run dev      # http://localhost:5173  (mobile shell: /#m/review)
npm run build
npm run lint
npm test         # vitest, covers the pure lib/ modules
```

`lib/suggest.js` and `lib/reviewQueue.js` are pure and carry the logic worth
being sure about — how a merchant is recognised, what a saved rule will
actually match, and how a backlog is ordered and grouped. Those have tests;
the React surfaces do not.

Sheet access needs `VITE_SHEETS_API_KEY` and `VITE_SHEETS_SHEET_ID`; see
`.env.example` for the full list.

The service worker is registered in production builds only — see
`src/registerSW.js`, which unregisters any stale worker in dev so edits are
never served from a cache.

---

# React + Vite

This template provides a minimal setup to get React working in Vite with HMR and some ESLint rules.

Currently, two official plugins are available:

- [@vitejs/plugin-react](https://github.com/vitejs/vite-plugin-react/blob/main/packages/plugin-react) uses [Oxc](https://oxc.rs)
- [@vitejs/plugin-react-swc](https://github.com/vitejs/vite-plugin-react/blob/main/packages/plugin-react-swc) uses [SWC](https://swc.rs/)

## React Compiler

The React Compiler is not enabled on this template because of its impact on dev & build performances. To add it, see [this documentation](https://react.dev/learn/react-compiler/installation).

## Expanding the ESLint configuration

If you are developing a production application, we recommend using TypeScript with type-aware lint rules enabled. Check out the [TS template](https://github.com/vitejs/vite/tree/main/packages/create-vite/template-react-ts) for information on how to integrate TypeScript and [`typescript-eslint`](https://typescript-eslint.io) in your project.
