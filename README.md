# Rheo

A personal finance tracker, built as one module per thing worth tracking — what you owe,
what recurs, what you save, what you spend. Each module keeps its own rows and shows what
is due, soon, or settled. Not every module is switched on; [Routes](#routes) is the list
of what currently is.

The data lives in a Google Sheet. A Google Apps Script web app sits in front of it as a
small JSON API, so there is no server to run or pay for — the frontend is a static site
and the spreadsheet is the database.

## Stack

React 19 + TypeScript, Vite, Tailwind CSS v4, TanStack Query, React Router.
Backend is a single Apps Script file (`apps-script/Code.gs`).

## Running it

Requires Node 24 (see `.nvmrc` — `nvm use` picks it up). Vite 8 will not start on Node 18.

```bash
npm install
npm run dev
```

That runs in **mock mode** by default: seeded in-memory data, no Google account, no
network. Good enough for all UI work.

To point at a real backend, copy `.env.example` to `.env.local` and set:

```
VITE_API_MODE=live
VITE_APPS_SCRIPT_URL=<your deployed Apps Script web app URL>
```

If `live` is set without a URL, it falls back to mock and warns in the console.

Scripts: `npm run dev`, `npm run build`, `npm run lint`, `npm run preview`.

## How it fits together

`src/api/` defines a `FinanceApi` interface with two implementations — `MockApi` for
local seed data and `AppsScriptApi` for the deployed backend. `getApi()` in
`src/api/index.ts` picks one based on the env vars, so nothing above that layer knows
which is in use.

Everything above reads through one TanStack Query hook, `useFinanceData()`, which
fetches the whole dataset under a single `['finance','all']` key. Writes go through
`useFinanceMutations()`; the debt and bill mutations return the updated dataset and write
it straight into the cache, avoiding a second round-trip.

Bills follow the debts pattern, with one difference worth knowing: a bill holds a
recurrence rule and only ever has one unpaid payable ahead of it. Paying that payable
mints the next one in the same write, and the next due date is computed on the client —
all four recurrence rules live in `src/lib/billSchedule.ts`, so the backend writes the
date it is given rather than reimplementing them in Apps Script. Closing a bill freezes
it and drops its unpaid payable, and cannot be undone.

Auth is username/password against the Apps Script backend, with sign-up gated by
single-use invite codes. Mock mode skips the invite code entirely.

## Caching

Fetched data is held for 5 minutes and is not refetched when the window regains
focus — the backend can take up to 45 seconds, so refetching on every alt-tab is
never worth it. The cache is also written to `localStorage`, so reopening the app
paints immediately instead of waiting on a cold fetch.

Because of that, an edit made **directly in the Google Sheet** can take a few
minutes to appear. "Refresh data" in the sidebar fetches immediately.

Both the query cache and the cached currency are keyed by user id, and a fresh
`QueryClient` is built per signed-in user (`src/lib/queryClient.ts`,
`SessionScopedQuery` in `src/App.tsx`). On a shared browser this is what keeps one
account's data from reaching the next. Signing out deletes the stored copy; an
expired token leaves it, so signing back in is still instant.

Bump `CACHE_VERSION` in `src/lib/queryClient.ts` whenever the shape of
`FinanceData` changes, or stored data from the old shape will be rehydrated into
code expecting the new one.

## Writes

Edits, deletes and payments are optimistic: the cache is patched from
`src/lib/optimistic.ts`, the dialog closes on submit, and the backend confirms
afterwards. If it rejects the write, the snapshot is restored and a toast says so
— that toast is the only report, since the form is gone by then.

Adds are not optimistic and still wait, because the backend assigns row ids and
builds a new debt's whole schedule. Paying a bill payable waits for the same reason:
it mints the next payable, whose id only the backend can assign. There is nothing
truthful to show until it answers.

The rule for anything added to `src/lib/optimistic.ts`: it must produce exactly
what the backend would return for the same call. If predicting the result needs
something only the server knows, the write waits instead.

## Routes

This section is the one place that says which modules are live. Keep it current here
rather than in the intro, the sidebar, or the sign-in copy — none of those name a module,
so switching one on is a change to this list and to `src/App.tsx`.

**Registered:**

| Module | Routes | What it tracks |
|---|---|---|
| Debts | `/debts`, `/debts/:id` | Loans and credit cards, with a payment schedule or monthly statements |
| Bills | `/bills`, `/bills/:id` | Recurring payments, generating one payable at a time on a schedule |
| Settings | `/settings` | Currency, and signing out |

**Not registered:** `Dashboard`, `Funds`, `Savings`, and `Expendable` still exist under
`src/pages/` from an earlier, broader version of the app, but are deliberately unrouted —
their sheets have no `user_id` column, so the backend does not serve their actions either.
Switching one on means giving its sheet a `user_id` and scoping its handlers first.

Unknown paths land on `/debts`.

## Notes

- No test suite — changes are verified with `npm run build` (which typechecks),
  `npm run lint`, and a manual pass.
- `docs/` is gitignored and local-only.
