# pfft

**P**rivacy **F**ocused **F**inance **T**racker. A personal finance tracker for India. An iPhone app reads bank SMS (ICICI, Axis), files each transaction into a category and asks you only when it isn't sure. The model that does the filing is open-weight and runs on a Mac at home, so no AI company sees your spending.

## How it works

```
iPhone (Shortcuts automation on a bank SMS)
   -> iOS app "Log Transaction" intent
   -> POST /api/v1/ingest   (Next.js API on Vercel)
   -> parse the SMS, store it in Supabase
   -> rules and your own filing history first
   -> otherwise ask the model (Tailscale Funnel -> llama.cpp llama-server, Qwen3-4B-Instruct, on a Mac's GPU)
   -> notification: what it was filed as, or "what was this for?"
```

Most transactions never reach the model. A description you've used before, a merchant rule, a payment that recurs every month or a merchant you always file the same way are decided without it. The model gets the rest, with your past descriptions and the merchant's history in front of it, and its answer is held to a JSON schema (a listed category, a confidence, a reason). Under 0.5 confidence, the transaction waits in the app's Inbox for you.

## Parts

| Path | What |
|---|---|
| `ios/` | SwiftUI app (iOS 26): Home, Transactions, Inbox, Parkings, the Log Transaction intent, Face ID lock |
| `app/api/v1/` | The app's API (Next.js route handlers) |
| `lib/` | Parsing, tagging, cycles, balances; `lib/llm.ts` calls the model server |
| `llm/` | The model server on a Mac: `serve.sh`, `install.sh` (launchd agent), `funnel.sh` (Tailscale Funnel) |
| `supabase/migrations/` | Database schema |

More detail in [docs/architecture.md](docs/architecture.md).

## Run it

1. **Model server** (an Apple Silicon Mac):
   ```bash
   brew install llama.cpp
   brew install --cask tailscale      # open it and sign in
   llm/install.sh                     # downloads the model (2.5 GB), starts it at login, prints LLM_API_KEY
   llm/funnel.sh                      # stable public HTTPS URL for LLM_BASE_URL
   ```
2. **Database.** Create a Supabase project and apply `supabase/migrations/` (`pnpm db:push`).
3. **API.** Put these in `.env.local` (and in Vercel for a deploy):
   ```
   NEXT_PUBLIC_SUPABASE_URL=
   NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY=
   SUPABASE_SERVICE_ROLE_KEY=
   LLM_BASE_URL=http://127.0.0.1:8089   # or your https://<mac>.<tailnet>.ts.net URL
   LLM_API_KEY=                          # from ~/.finance-llm/api-key
   ```
   then `pnpm install && pnpm dev`.
4. **App.** Open `ios/Finance.xcodeproj`, point `APIClient.productionServer` at your API (debug builds also read `FINANCE_SERVER`), and run it on your phone. Add a Shortcuts message automation for your bank's sender that runs "Log Transaction".

`pnpm lint` and `pnpm build` check the API. The unit tests aren't in this repo: their fixtures are real bank SMS.
