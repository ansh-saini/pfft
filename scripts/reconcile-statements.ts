// Reconciles ICICI / Axis account-statement CSV exports against
// sms_transactions, to find SMS that never got ingested — then optionally
// backfills the gaps.
//
// Usage:
//   pnpm reconcile                          # dry-run report only
//   pnpm reconcile --apply                  # also insert missing rows
//   pnpm reconcile --icici path/to.csv --axis path/to.csv
//
// See docs/statement-reconciliation.md for the full process.

process.loadEnvFile(".env.local");

import fs from "fs";
import path from "path";
import { createHash } from "crypto";
import { createClient } from "@supabase/supabase-js";
import {
  parseICICIStatement,
  parseAxisStatement,
  reconcileAgainstDb,
  statementDateRange,
  type StatementRow,
} from "../lib/statementReconcile";

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!,
  { auth: { persistSession: false } },
);

const BACKFILL_NOTE =
  "[Backfilled from account statement — original SMS not available]";

// ─── CLI args ─────────────────────────────────────────────────────────────────

const args = process.argv.slice(2);
const apply = args.includes("--apply");
const getArg = (flag: string, fallback: string) => {
  const i = args.indexOf(flag);
  return i >= 0 && args[i + 1] ? args[i + 1] : fallback;
};
const iciciPath = getArg("--icici", "statements/icici-last-3-months.csv");
const axisPath = getArg("--axis", "statements/axis-last-3-months.csv");

// ─── Helpers ──────────────────────────────────────────────────────────────────

async function accountLast4(source: string, fallback: string): Promise<string> {
  const { data } = await supabase
    .from("sms_transactions")
    .select("account_last4")
    .eq("source", source)
    .not("account_last4", "is", null)
    .order("created_at", { ascending: false })
    .limit(1);
  return data?.[0]?.account_last4 ?? fallback;
}

async function reconcileOne(opts: {
  label: string;
  csvPath: string;
  parse: (csv: string) => StatementRow[];
  source: "icici_bank" | "axis_bank";
  bank: "ICICI" | "AXIS";
  fallbackLast4: string;
}) {
  const { label, csvPath, parse, source, bank, fallbackLast4 } = opts;

  const fullPath = path.join(process.cwd(), csvPath);
  if (!fs.existsSync(fullPath)) {
    console.log(`\n=== ${label} ===\nFile not found: ${csvPath} — skipping.`);
    return { missing: [] as StatementRow[], bank, source, fallbackLast4 };
  }

  const csv = fs.readFileSync(fullPath, "utf8");
  const statementRows = parse(csv);
  const range = statementDateRange(statementRows);

  console.log(`\n=== ${label} ===`);
  console.log(`Parsed ${statementRows.length} rows from ${csvPath}`);
  if (!range) {
    console.log("No rows parsed — nothing to reconcile.");
    return { missing: [], bank, source, fallbackLast4 };
  }
  console.log(`Statement date range: ${range.min} to ${range.max}`);

  const [{ data: datedRows, error }, { data: undatedRows }] = await Promise.all([
    supabase
      .from("sms_transactions")
      .select("transaction_date, amount, direction")
      .eq("source", source)
      .gte("transaction_date", range.min)
      .lte("transaction_date", range.max),
    // An SMS with no readable date is still one of these statement lines.
    supabase
      .from("sms_transactions")
      .select("transaction_date, amount, direction")
      .eq("source", source)
      .is("transaction_date", null),
  ]);

  if (error) {
    console.error(`DB query failed for ${label}:`, error.message);
    process.exit(1);
  }

  const { missing, unmatchedDb, matchedUndated } = reconcileAgainstDb(
    statementRows,
    [...(datedRows ?? []), ...(undatedRows ?? [])],
  );

  if (matchedUndated) {
    console.log(
      `Matched ${matchedUndated} row(s) against an SMS with no readable date.`,
    );
  }

  console.log(`Missing from DB: ${missing.length}`);
  for (const m of missing) {
    console.log(`  ${m.date}  ${m.direction.padEnd(6)} ₹${m.amount}  ${m.description.slice(0, 100)}`);
  }

  if (unmatchedDb.length > 0) {
    console.log(
      `\nIn DB but not in statement: ${unmatchedDb.length} (informational — often out-of-range dates or a different card/account; not touched)`,
    );
    for (const u of unmatchedDb) {
      console.log(`  ${u.transaction_date}  ${u.direction}  ₹${u.amount}`);
    }
  }

  return { missing, bank, source, fallbackLast4 };
}

// ─── Main ─────────────────────────────────────────────────────────────────────

async function main() {
  const results = await Promise.all([
    reconcileOne({
      label: "ICICI",
      csvPath: iciciPath,
      parse: parseICICIStatement,
      source: "icici_bank",
      bank: "ICICI",
      fallbackLast4: "123",
    }),
    reconcileOne({
      label: "AXIS",
      csvPath: axisPath,
      parse: parseAxisStatement,
      source: "axis_bank",
      bank: "AXIS",
      fallbackLast4: "4321",
    }),
  ]);

  const totalMissing = results.reduce((n, r) => n + r.missing.length, 0);

  if (totalMissing === 0) {
    console.log("\nNo gaps found. Nothing to backfill.");
    return;
  }

  if (!apply) {
    console.log(
      `\n${totalMissing} total missing rows found. Re-run with --apply to insert them ` +
        `(category left null — run 'pnpm tag:untagged' afterward).`,
    );
    return;
  }

  console.log(`\nInserting ${totalMissing} rows...`);

  for (const { missing, bank, source, fallbackLast4 } of results) {
    if (missing.length === 0) continue;
    const last4 = await accountLast4(source, fallbackLast4);

    const records = missing.map((m) => ({
      raw_body: `${BACKFILL_NOTE} ${bank} ${m.direction} ${m.amount} ${m.description.slice(0, 200)} ${m.date}`,
      body_hash: createHash("sha256")
        .update(`backfill-${bank}-${m.date}-${m.amount}-${m.direction}-${m.upiRef ?? m.description}`)
        .digest("hex"),
      sender: null,
      received_at: null,
      is_spam: false,
      bank,
      source,
      account_last4: last4,
      amount: m.amount,
      direction: m.direction,
      merchant: null,
      upi_ref: m.upiRef,
      transaction_date: m.date,
      transaction_time: null,
      category: null,
      sub_category: null,
    }));

    // Dedupe against existing body_hash so re-running --apply is idempotent.
    const hashes = records.map((r) => r.body_hash);
    const { data: existing } = await supabase
      .from("sms_transactions")
      .select("body_hash")
      .in("body_hash", hashes);
    const existingHashes = new Set((existing ?? []).map((r) => r.body_hash));
    const toInsert = records.filter((r) => !existingHashes.has(r.body_hash));

    if (toInsert.length === 0) {
      console.log(`  ${bank}: all rows already backfilled, nothing new.`);
      continue;
    }

    const { data, error } = await supabase
      .from("sms_transactions")
      .insert(toInsert)
      .select("id");

    if (error) {
      console.error(`  ${bank}: insert failed:`, error.message);
      continue;
    }
    console.log(`  ${bank}: inserted ${data.length} rows.`);
  }

  console.log("\nDone. Run 'pnpm tag:untagged' to categorize the new rows.");
}

main();
