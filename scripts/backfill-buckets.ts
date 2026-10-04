// Retroactive funding for cycles that were spent through before buckets existed.
//
//   pnpm backfill:buckets            # dry run — prints the rows, writes nothing
//   pnpm backfill:buckets --apply    # writes the ledger rows
//   pnpm backfill:buckets --through 2026-08   # last cycle to fund (default: last complete month)
//
// Funds the SHORTFALL, not the full allocation: a bucket already topped up by
// hand is left alone, and a bucket half-funded gets only the difference. That
// makes the script safe to re-run at any point in a cycle.
//
// Budgeted buckets get their per-cycle allocation. Pass-through commitments
// (Bills, Investing) get exactly what was spent, since they are not budgeted —
// they are whatever the bills happened to be.
//
// Saving buckets are deliberately left alone: you cannot retroactively save for
// something you already bought, so inventing funding there would be a lie.

process.loadEnvFile(".env.local");

import { createClient } from "@supabase/supabase-js";
import { buildCycles, type Cycle } from "../lib/cycles";

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!,
  { auth: { persistSession: false } },
);

/** Buckets funded to a fixed allocation each cycle. */
const ALLOCATIONS: Record<string, number> = {
  Needs: 20000,
  Wants: 10000,
};

/** Buckets funded to whatever was actually spent — commitments, not budgets. */
const PASS_THROUGH = new Set(["Bills", "Investing"]);

const NOTE_PREFIX = "Backfill";

type Row = {
  bucket_id: string;
  bucket: string;
  cycle: string;
  amount: number;
  occurred_on: string;
  note: string;
  basis: string;
};

function inr(n: number) {
  return "Rs " + Math.round(n).toLocaleString("en-IN");
}

async function build(through: string | null): Promise<Row[]> {
  const { data: buckets, error: bucketError } = await supabase
    .from("buckets")
    .select("id, name, type")
    .is("archived_at", null)
    .order("sort_order");
  if (bucketError) throw new Error(bucketError.message);

  const { data: txns, error: txnError } = await supabase
    .from("sms_transactions")
    .select("bucket_id, amount, direction, transaction_date")
    .eq("is_spam", false)
    .not("transaction_date", "is", null);
  if (txnError) throw new Error(txnError.message);

  const dates = (txns ?? []).map((t) => t.transaction_date as string).sort();
  const today = new Date().toISOString().split("T")[0];
  const allCycles = buildCycles(dates[0] ?? null, dates[dates.length - 1] ?? null, today);

  // Default: every complete month, i.e. everything before the current one.
  const currentKey = today.slice(0, 7);
  const limit = through ?? allCycles.filter((c) => c.id < currentKey).at(-1)?.id ?? null;
  if (!limit) return [];
  const cycles = allCycles.filter((c) => c.id <= limit);

  // Every rupee already put into a bucket during a cycle counts against its
  // shortfall — hand-added funding and transfers in alike.
  const { data: ledger, error: ledgerError } = await supabase
    .from("bucket_ledger")
    .select("bucket_id, amount, occurred_on");
  if (ledgerError) throw new Error(ledgerError.message);

  const fundedIn = (bucketId: string, cycle: Cycle) =>
    (ledger ?? [])
      .filter(
        (l) =>
          l.bucket_id === bucketId &&
          (l.occurred_on as string) >= cycle.startDate &&
          (l.occurred_on as string) < cycle.endDate,
      )
      .reduce((sum, l) => sum + Number(l.amount ?? 0), 0);

  const spendIn = (bucketId: string, cycle: Cycle) =>
    (txns ?? [])
      .filter(
        (t) =>
          t.bucket_id === bucketId &&
          (t.transaction_date as string) >= cycle.startDate &&
          (t.transaction_date as string) < cycle.endDate,
      )
      .reduce(
        (sum, t) =>
          sum + (t.direction === "credit" ? -Number(t.amount ?? 0) : Number(t.amount ?? 0)),
        0,
      );

  const rows: Row[] = [];

  for (const cycle of cycles) {
    for (const bucket of buckets ?? []) {
      if (bucket.type !== "expenditure") continue;

      let goal: number;
      let basis: string;

      if (bucket.name in ALLOCATIONS) {
        goal = ALLOCATIONS[bucket.name];
        basis = "allocation";
      } else if (PASS_THROUGH.has(bucket.name)) {
        goal = spendIn(bucket.id, cycle);
        basis = "actual spend";
      } else {
        continue;
      }

      const alreadyFunded = fundedIn(bucket.id, cycle);
      const amount = Math.round((goal - alreadyFunded) * 100) / 100;
      if (amount <= 0) continue;

      rows.push({
        bucket_id: bucket.id,
        bucket: bucket.name,
        cycle: cycle.label,
        amount,
        occurred_on: cycle.startDate,
        note: `${NOTE_PREFIX} — ${cycle.label}`,
        basis:
          alreadyFunded > 0
            ? `${basis}, topping up ${inr(alreadyFunded)} already in`
            : basis,
      });
    }
  }

  return rows;
}

async function main() {
  const args = process.argv.slice(2);
  const throughFlag = args.indexOf("--through");
  const through = throughFlag >= 0 ? args[throughFlag + 1] : null;

  const rows = await build(through);

  if (rows.length === 0) {
    console.log("Nothing to fund — every cycle in range already meets its allocation.");
    return;
  }

  const byCycle: Record<string, Row[]> = {};
  for (const r of rows) (byCycle[r.cycle] ??= []).push(r);

  console.log(`${rows.length} funding rows:\n`);
  let total = 0;
  for (const [cycle, list] of Object.entries(byCycle)) {
    console.log(`  ${cycle}`);
    for (const r of list) {
      console.log(
        `    ${r.bucket.padEnd(12)} ${inr(r.amount).padStart(14)}   (${r.basis})`,
      );
      total += r.amount;
    }
  }
  console.log(`\n  total ${inr(total)}`);

  if (!args.includes("--apply")) {
    console.log("\nDry run. Re-run with --apply to write these.");
    return;
  }

  const { error } = await supabase.from("bucket_ledger").insert(
    rows.map((r) => ({
      bucket_id: r.bucket_id,
      amount: r.amount,
      kind: "funding",
      occurred_on: r.occurred_on,
      note: r.note,
    })),
  );
  if (error) throw new Error(error.message);

  console.log(`\nWrote ${rows.length} ledger rows.`);
}

main().catch((e) => {
  console.error(e.message ?? e);
  process.exit(1);
});
