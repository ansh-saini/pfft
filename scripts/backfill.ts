// Back-fill ICICI and Axis SMS transactions from local text files.
// 1. Backs up current sms_transactions to backup_<timestamp>.json
// 2. Parses icici_sms.txt (one SMS per line) and axis_sms.txt (blocks separated by blank lines)
// 3. Skips rows whose raw_body already exists in DB
// Run: pnpm tsx scripts/backfill.ts

process.loadEnvFile(".env.local");

import fs from "fs";
import path from "path";
import { createClient } from "@supabase/supabase-js";
import { parse } from "../lib/parser";

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!,
  { auth: { persistSession: false } },
);

// ─── Backup ───────────────────────────────────────────────────────────────────

async function backup(): Promise<void> {
  console.log("Backing up sms_transactions...");

  const { data, error } = await supabase
    .from("sms_transactions")
    .select("*")
    .order("created_at", { ascending: true });

  if (error) {
    console.error("Backup failed:", error.message);
    process.exit(1);
  }

  const filename = `backup_${new Date().toISOString().replace(/[:.]/g, "-")}.json`;
  const filepath = path.join(process.cwd(), filename);
  fs.writeFileSync(filepath, JSON.stringify(data, null, 2));
  console.log(`Backup saved → ${filename} (${data.length} rows)\n`);
}

// ─── SMS file parsers ─────────────────────────────────────────────────────────

function readICICIMessages(): string[] {
  const raw = fs.readFileSync(
    path.join(process.cwd(), "icici_sms.txt"),
    "utf8",
  );
  return raw
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean);
}

function readAxisMessages(): string[] {
  const raw = fs.readFileSync(
    path.join(process.cwd(), "axis_sms.txt"),
    "utf8",
  );
  // Blocks separated by one or more blank lines
  return raw
    .split(/\n{2,}/)
    .map((block) => block.trim())
    .filter(Boolean);
}

// ─── Main ─────────────────────────────────────────────────────────────────────

async function main() {
  await backup();

  // Fetch existing raw_body values for deduplication
  const { data: existing, error: fetchErr } = await supabase
    .from("sms_transactions")
    .select("raw_body");

  if (fetchErr) {
    console.error("Failed to fetch existing rows:", fetchErr.message);
    process.exit(1);
  }

  const existingBodies = new Set(existing.map((r) => r.raw_body as string));
  console.log(`Existing rows in DB: ${existingBodies.size}`);

  const icici = readICICIMessages();
  const axis = readAxisMessages();
  const all = [
    ...icici.map((body) => ({ body, sender: "AM-ICICIB" })),
    ...axis.map((body) => ({ body, sender: "AM-AXISBK" })),
  ];

  console.log(
    `SMS to process: ${all.length} (${icici.length} ICICI + ${axis.length} Axis)\n`,
  );

  let inserted = 0;
  let skippedDuplicate = 0;
  let skippedSpam = 0;
  let errors = 0;

  for (const { body, sender } of all) {
    if (existingBodies.has(body)) {
      skippedDuplicate++;
      continue;
    }

    const parsed = parse(body);

    if (parsed.is_spam) {
      skippedSpam++;
      // Still insert spam rows so the record exists (matches live ingest behaviour)
      const { error } = await supabase.from("sms_transactions").insert({
        raw_body: body,
        sender,
        received_at: null,
        is_spam: true,
        bank: null,
        source: null,
        account_last4: null,
        amount: null,
        direction: null,
        merchant: null,
        upi_ref: null,
        transaction_date: null,
        transaction_time: null,
      });
      if (error) {
        console.error(`  Insert error (spam): ${error.message}`);
        errors++;
      } else {
        // Add to set so re-runs skip it
        existingBodies.add(body);
      }
      continue;
    }

    const received_at = parsed.transaction_date
      ? `${parsed.transaction_date}T${parsed.transaction_time ?? "00:00:00"}+05:30`
      : null;

    const record = {
      raw_body: body,
      sender,
      received_at,
      is_spam: false,
      bank: parsed.bank,
      source: parsed.source,
      account_last4: parsed.account_last4,
      amount: parsed.amount,
      direction: parsed.direction,
      merchant: parsed.merchant,
      upi_ref: parsed.upi_ref,
      transaction_date: parsed.transaction_date,
      transaction_time: parsed.transaction_time,
    };

    const label = `${parsed.merchant ?? "?"} ₹${parsed.amount} ${parsed.direction} (${parsed.source})`;
    process.stdout.write(`  ${label} ... `);

    const { error } = await supabase.from("sms_transactions").insert(record);
    if (error) {
      process.stdout.write(`ERROR: ${error.message}\n`);
      errors++;
    } else {
      process.stdout.write("inserted\n");
      existingBodies.add(body);
      inserted++;
    }
  }

  console.log(`
Done.
  Inserted:           ${inserted}
  Skipped (spam):     ${skippedSpam}
  Skipped (duplicate): ${skippedDuplicate}
  Errors:             ${errors}

Run 'pnpm tag:untagged' to auto-tag the new rows.`);
}

main();
