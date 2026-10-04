# Architecture

Personal finance tracker. An iOS app sends bank SMS to a Next.js API, which parses them, stores them in Supabase and tags them with an open-weight model the owner hosts. There is no web app: the Next.js server is the iOS app's API only.

**Stack:** iOS app (SwiftUI) · Next.js 16 API routes on Vercel · Supabase (Postgres + Auth) · llama.cpp `llama-server` with Qwen3-4B-Instruct (GGUF) on the owner's Mac, behind Tailscale Funnel

## Data flow

```
iOS app (Shortcuts automation) → POST /api/v1/ingest (Bearer session)
                        ↓
                  regex parse SMS body (per bank/source)
                        ↓
                  insert into sms_transactions
                        ↓
                  lib/tagger.ts → lib/llm.ts → Tailscale Funnel → llama-server on a Mac → update category
```

Every `/api/v1` route but `auth/*` needs the signed-in session (`lib/api/auth.ts` `withUser`).

## SMS parsers

| source | bank |
|--------|------|
| `icici_bank` | ICICI UPI debit/credit |
| `axis_bank` | AXIS UPI debit/credit |
| `axis_cc` | AXIS credit card spend |

Parser order in `lib/parser.ts`: `axis_cc` before `axis_bank` (both contain "Axis Bank"). Unrecognised → `is_spam: true`.

## Database

Supabase CLI. Migrations in `supabase/migrations/` (timestamped SQL). Never edit after pushing — add a new one.

```bash
pnpm db:new <name>   # create migration
pnpm db:push         # apply (needs SUPABASE_ACCESS_TOKEN)
pnpm db:pull         # pull remote diff
```

`sms_transactions` key columns: `direction` (`debit|credit`), `category` (13 fixed values — see `lib/categories.ts`), `sub_category` (free text).

## Reconciliation

`balance_snapshots` holds what an account actually held at a moment. `origin: 'sms'` rows are recorded automatically — ICICI states "Avl Bal" on its non-UPI alerts, Axis states a balance in none of its messages — and `origin: 'manual'` rows are entered by hand.

Only a complete `reconcile_group` (every bank captured together) is reconcilable: `lib/balances.ts` compares the bank total against bucket balances **recomputed as of that date**, and `Unallocated = bank − Σ buckets`. `pnpm audit:data` reports the gap, or that nothing has ever been reconciled.

A card SMS quotes "Avl Limit" — headroom on a liability, never read as a balance.

```bash
pnpm backfill:balances          # read balances out of stored SMS (dry run)
pnpm backfill:balances --apply
```

## Supabase clients

- `lib/api/auth.ts` `withUser`: a client acting as the signed-in user, per request
- `lib/supabase/admin.ts`: `after()` callbacks, scripts

Create fresh per-request, never singleton.

## Auto-tagging

`lib/tagger.ts`: server code (it holds the model key). `lib/categories.ts` holds the category list. `lib/tagging.ts` is the pure decision layer (description matching, derived confidence, review predicate, model briefing) and is safe anywhere. `lib/inbox.ts` holds `needsInput`, the one rule for what the user sees.

**The user's description is the primary input.** `sub_category` is what the user says a transaction was for ("bike fuel", "refund against books"). The model reads it and decides the category; the tagger never writes `sub_category`. Decision order in `tagTransaction`:

1. Card-payment rule → `Self Transfer`, confidence 1.0.
2. Exact match on a description the user decided by hand before (`reviewed_at` set) → replay, 1.0, no model call.
3. Merchant rule (`merchant_mappings`) → 1.0. A recurrence (`lib/recurring.ts`: same counterparty, amount within 10%, within 4 days of the same day of the month, in 2+ earlier months that agree) → 0.85, even when the merchant's overall history is mixed. Merchant history → 0.85. All only when there is **no** description; with one they are context for the model.
4. The model (`lib/llm.ts`, see "Model server" below). System prompt: how the user's descriptions have been filed (hand decisions first). User prompt: the description, dated past filings of the merchant with amounts and buckets, the recurrence, and same-amount same-day payments to other parties (₹500+, within 2%). Capped 0.8; capped 0.6 with neither description nor history.

Confidence is derived from which path decided, never taken from the model. A model answer with no confidence counts as 0.4.

**The Inbox (the iOS Inbox tab, `GET /api/v1/inbox`) is the only place that asks.** `needsInput`: unreviewed and (no category, no bucket where one belongs, or confidence under `REVIEW_THRESHOLD` 0.5), or spending still outside a bucket. Writing a description in the app (`POST /api/v1/transactions/[id]/describe`) calls `describeTransaction`: saves `sub_category`, re-tags with `force`, and shows the result in place. Picking a category or bucket by hand writes `handDecision()` (`reviewed_at`, `tagged_by: user`, confidence 1): it leaves the Inbox and the tagger leaves it alone until a new description is written.

**Where tagging runs.** `/api/v1/ingest` inline. Statement sync and manual entries without a category via `after()` → `tagByIds`. `pnpm tag:queue` re-runs the Inbox (`--refresh-ai` also re-runs unreviewed model-filed rows, `--dry` counts). Every `bucket_id` write goes through `bucketPatch` → `mayHoldBucket`.

## Model server (`llm/`)

The model runs on the owner's Mac (M2 Pro), on its GPU through Metal: llama.cpp's `llama-server` with `unsloth/Qwen3-4B-Instruct-2507-GGUF:Q4_K_M`. It listens on 127.0.0.1 only and needs the API key in `~/.finance-llm/api-key` on every route but `/health`. Tailscale Funnel gives it a stable public HTTPS URL (`https://<mac>.<tailnet>.ts.net`); nothing else reaches it.

- `llm/serve.sh`: starts the server under `caffeinate -i` (no idle sleep). Loads the downloaded GGUF from `~/.finance-llm/models` directly, so a restart works offline; downloads it with `-hf` the first time.
- `llm/install.sh`: launchd agent `com.finance.llm` (starts at login, restarts on exit), creates the API key on first run. Log: `~/.finance-llm/llm.log`.
- `llm/funnel.sh`: `tailscale funnel --bg` to the server's port. The Funnel lives in Tailscale's config and returns with the Tailscale app at login.

Measured with the real 2,675-token system prompt: 1.4-1.6 s per call once the prompt is cached, 8-10 s for the first call and after a new description changes the example library. On CPU the same model took 10-12 s and about 100 s.

When the Mac is off or asleep, the tagger's call fails, and the transaction waits in the Inbox.

`lib/llm.ts` `completeJSON` posts to `${LLM_BASE_URL}/v1/chat/completions` with `response_format: json_schema`, so the server's grammar holds the reply to `REPLY_SCHEMA` in `lib/tagger.ts` (a listed category, a confidence, a reason). `temperature: 0`. It gives up after `LLM_TIMEOUT_MS` (default 10 s) because the iOS app waits 15 s on `/api/v1/ingest`; a call that fails or times out leaves the row in the Inbox.

What the model sees: the transaction's merchant, amount, date, bank, raw SMS and the user's description, the merchant's past filings, and the library of the user's past descriptions. It goes only to the owner's Mac, through Tailscale Funnel (TLS ends on the Mac); no AI vendor receives it.


## iOS app (`ios/`) and its API (`/api/v1`)

SwiftUI, iOS 26, no packages. `ios/Finance.xcodeproj` uses synchronized folders, so new files in `ios/Finance/` join the target on their own. Build and test: `xcodebuild -project ios/Finance.xcodeproj -scheme Finance -destination 'platform=iOS Simulator,name=iPhone 17' test`.

The app always talks to your deployed API (`APIClient.productionServer`); debug builds can override it with `FINANCE_SERVER`. It never talks to Supabase. It signs in through `POST /api/v1/auth/sign-in` (and `/refresh`), keeps the session in the Keychain, and sends the access token as `Authorization: Bearer`. `lib/api/auth.ts` `withUser` turns that into a Supabase client acting as the user.

Routes: `auth/sign-in`, `auth/refresh`, `meta`, `summary?cycle=`, `balance`, `inbox`, `transactions?cycle=|q=`, `transactions/[id]` (GET, PATCH category as a hand decision), `transactions/[id]/describe`, `parkings`, `parkings/[id]`, `parkings/moves`, `parkings/moves/[id]`, `statements`, `statements/detect`, `ingest` (POST a bank SMS, through `lib/ingestMessage.ts`). Logic lives in `lib/`: `lib/summary.ts`, `lib/transactions.ts`, `lib/inbox.ts`, `lib/parkingsData.ts`, `lib/api/data.ts`.

Debug builds accept `FINANCE_SERVER`, `FINANCE_ACCESS_TOKEN` and `FINANCE_TAB` in the launch environment for simulator smoke tests.

The app keeps the last reply to every GET on disk (`ResponseCache`, in the Caches directory, keyed by path and query). A screen opens on its cached reply and refreshes in place; the spinner only shows when that screen was never loaded. On launch and on return from the background, `AppStore.refreshAll` fetches meta, inbox, transactions and buckets; Home loads its summary when it appears. Searches and single transactions are not cached. Sign out clears the cache.

**Log Transaction** (`ios/Finance/Intents/LogTransactionIntent.swift`) is an App Intent the Shortcuts message automation runs on a bank SMS, in the background. `Ingestor` posts it to `/api/v1/ingest` with the signed-in session and `Notifier` shows the result as the app's own notification: amount and merchant, then category and bucket. When the row needs the user, the notification has a reply field; the reply goes to `transactions/[id]/describe` and the notification is replaced with what was filed. A message that cannot be sent is kept in `Application Support/pending-messages.json` and sent on the next run or app launch. The server answers a message it already has (same `body_hash`) with that row and `duplicate: true`, so retries are safe. Spam is logged without a notification. Debug builds also accept `FINANCE_LOG_SMS` to run the same path on launch.

## Cycles

Cycle-based (not calendar months). `lib/cycles.ts` derives cycles from `Salary / Income` credits.

## Env vars

```
NEXT_PUBLIC_SUPABASE_URL
NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY
SUPABASE_SERVICE_ROLE_KEY
LLM_BASE_URL       # https://<mac>.<tailnet>.ts.net, no trailing /v1
LLM_API_KEY        # contents of ~/.finance-llm/api-key on the Mac
LLM_MODEL          # optional label sent with each call
LLM_TIMEOUT_MS     # optional, default 10000
```
