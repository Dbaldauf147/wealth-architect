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

The icon PNGs in `public/` are generated: edit `public/app-icon*.svg`, then run
`node scripts/make-icons.mjs`.

## Development

```sh
npm install
npm run dev      # http://localhost:5173  (mobile shell: /#m/review)
npm run build
npm run lint
```

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
