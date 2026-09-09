# Wealth Architect — working notes

## Git workflow

**Every requested change ships as its own PR.** For each user request that produces code changes:

1. Create a fresh feature branch off the latest `master`. Use `claude/<short-kebab-slug>` for the name — pick a slug that describes the change (e.g. `claude/card-usage-table`, `claude/spend-alert-secret`).
2. Commit on that branch and push it with `git push -u origin <branch>`.
3. Open the PR. Prefer the GitHub API (`mcp__github__create_pull_request`) when it's available; if it fails, fall back to printing the compare URL: `https://github.com/Dbaldauf147/wealth-architect/pull/new/<branch>`.
4. **Merge it yourself** (`mcp__github__merge_pull_request`) once the work is verified — the user asked for this rather than being handed a link each time. Report the merge commit instead. Verification doesn't get lighter for being faster: see below for what it means here. If the branch conflicts or the change turns out riskier than it looked, fix that first rather than merging and explaining afterwards. Still stop and ask on anything destructive or genuinely ambiguous.
5. Don't push directly to `master`. Everything lands through a PR.

Branches stay one-PR-per-change so each fix can be reviewed and merged independently — don't pile unrelated changes onto a previous branch.

## Verifying before you merge

**Nothing runs on pull requests** — there are no GitHub Actions in this repo, so the verification is whatever you actually run:

    npm run build     # vite build
    npm run lint      # eslint .
    npm test          # vitest run

Then **check the actual behaviour**. Chromium and Playwright are available: drive the real page and assert on what you changed, watching `pageerror` as you go — a panel that throws while rendering looks empty, not broken.

The `api/` routes are the part a page can't exercise. `spend-alert` in particular refuses everything with a 503 until `SPEND_ALERT_SECRET` is set, so "it returned 503" locally is the configured behaviour and not a bug you just introduced. When you change a route, import it in Node to prove it loads and read its shape against the caller.

## Deploys

Vercel builds `master` on every merge and ships the site, the `api/` routes, the crons and the headers in `vercel.json`. A merged PR is live within a couple of minutes.

What that build does **not** ship:

- `firestore.rules` — released with `firebase deploy --only firestore:rules` (`firebase.json` and `.firebaserc` are checked in, so it's that one command, not a console paste). The `spendAlerts` block is the standing example: until it's published the phone can read nothing and the strip on the page stays empty, which looks like no data rather than a denied read.
- Environment variables — `SPEND_ALERT_SECRET`, `FIREBASE_SERVICE_ACCOUNT_JSON` and the rest live in Vercel → Settings → Environment Variables. Code that starts reading a new one is not shipped until that value exists; say so in the PR rather than leaving it to be discovered by a 503.
