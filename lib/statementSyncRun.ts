import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import { after } from "next/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { tagByIds } from "@/lib/tagger";
import {
  parseICICIStatement,
  parseAxisStatement,
  reconcileAgainstDb,
  statementDateRange,
  parseStatementPeriod,
  closingBalance,
  type StatementRow,
} from "@/lib/statementReconcile";
import { accountBalances } from "@/lib/accountBalance";
import { loadBalanceInputs } from "@/lib/accountBalanceData";
import type { BalanceSnapshot } from "@/lib/balances";
import { statementTextFromBytes } from "@/lib/statementFile";
import {
  BANKS,
  BANK_SOURCE,
  buildBackfillRecords,
  type StatementBank,
} from "@/lib/statementSync";

const PARSERS: Record<StatementBank, (csv: string) => StatementRow[]> = {
  ICICI: parseICICIStatement,
  AXIS: parseAxisStatement,
};

export type SyncReport = {
  bank: StatementBank;
  parsed: number;
  periodStart: string;
  periodEnd: string;
  /** True when the period came from the file's header rather than its rows. */
  periodDeclared: boolean;
  backfilled: number;
  alreadyPresent: number;
  unmatchedInDb: number;
  /** Statement lines matched to an SMS that had no readable date. */
  matchedUndated: number;
  samples: {
    date: string;
    amount: number;
    direction: string;
    description: string;
  }[];
  /**
   * The statement's closing balance, kept as a balance reading so the app's
   * figure for the account starts from it. `predicted` is what the app had
   * worked out for that moment; `drift` is closing minus predicted. Null when
   * the file carries no running balance.
   */
  balance: {
    closing: number;
    at: string;
    predicted: number | null;
    drift: number | null;
    saved: boolean;
    error: string | null;
  } | null;
};

/** The day it is in India, which is the day the bank's statements use. */
function todayInIndia(): string {
  return new Date(Date.now() + 5.5 * 3600 * 1000).toISOString().slice(0, 10);
}

/**
 * Keeps a statement's closing balance as a reading. A statement running up to
 * today was exported moments ago, so its balance is as of now; an older one is
 * as of the end of its last day. Re-syncing the same statement does not add
 * the reading twice.
 */
async function recordClosingBalance(
  supabase: SupabaseClient,
  bank: StatementBank,
  periodStart: string,
  periodEnd: string,
  closing: number,
): Promise<NonNullable<SyncReport["balance"]>> {
  // Written the way Postgres returns timestamps ("+00:00", not "Z"), since
  // readings and transactions are compared as text downstream.
  const at = (periodEnd >= todayInIndia()
    ? new Date().toISOString()
    : new Date(`${periodEnd}T23:59:59+05:30`).toISOString()
  ).replace("Z", "+00:00");
  const atMs = Date.parse(at);
  const note = `Closing balance of the ${bank} statement for ${periodStart} to ${periodEnd}`;
  const { snapshots, txns } = await loadBalanceInputs(supabase);

  // What the app would have said at that moment, from the readings before it.
  const reading: BalanceSnapshot = {
    id: "statement",
    bank,
    balance: closing,
    observed_at: at,
    origin: "statement",
    source_txn_id: null,
    reconcile_group: null,
    note,
  };
  // Strictly earlier in time, so a re-sync compares against the readings
  // before the statement, not against its own earlier copy.
  const earlier = snapshots.filter((s) => Date.parse(s.observed_at) < atMs);
  const account = accountBalances([...earlier, reading], txns).find((a) => a.bank === bank);
  const check = account?.lastCheck?.at === at ? account.lastCheck : null;

  const already = snapshots.some(
    (s) =>
      s.bank === bank &&
      s.origin === "statement" &&
      Number(s.balance) === closing &&
      Date.parse(s.observed_at) === atMs,
  );
  let error: string | null = null;
  if (!already) {
    const { error: insertError } = await supabase.from("balance_snapshots").insert({
      bank,
      balance: closing,
      observed_at: at,
      origin: "statement",
      note,
    });
    error = insertError?.message ?? null;
  }
  return {
    closing,
    at,
    predicted: check?.predicted ?? null,
    drift: check?.drift ?? null,
    saved: error === null,
    error,
  };
}

/**
 * Reconciles one bank statement file against what the SMS feed recorded:
 * inserts the lines it missed (tagged in the background) and records the
 * period as synced. Shared by the web's sync page and `/api/v1/statements`.
 * `supabase` acts as the signed-in person. Throws with a message fit to show.
 */
export async function runStatementSync(
  supabase: SupabaseClient,
  bank: StatementBank,
  bytes: Uint8Array,
): Promise<SyncReport> {
  if (!BANKS.includes(bank)) throw new Error(`Unknown bank: ${bank}`);
  if (bytes.length === 0) throw new Error("Pick a statement file first");

  const csv = statementTextFromBytes(bytes);

  let statementRows: StatementRow[];
  try {
    statementRows = PARSERS[bank](csv);
  } catch (e) {
    // The Axis parser throws when the DR/CR polarity it relies on doesn't hold.
    throw new Error(
      `Could not read this as an ${bank} statement: ${(e as Error).message}`,
    );
  }

  const range = statementDateRange(statementRows);
  if (!range) {
    throw new Error(
      `No transactions found in that file. Is it an ${bank} account statement export?`,
    );
  }

  // The period the statement says it covers, not the span of its transactions:
  // a statement for 1 May–30 Aug with nothing booked until 4 May still covers
  // those quiet days, and no future statement could ever fill them.
  const declared = parseStatementPeriod(csv);
  const periodStart = declared ? declared.start : range.min;
  const periodEnd = declared ? declared.end : range.max;

  const source = BANK_SOURCE[bank];

  // Undated rows are fetched alongside the period: an SMS whose date the parser
  // could not read still represents one of these statement lines, and without it
  // the matcher would call that line missing and insert a duplicate.
  const [{ data: datedRows, error: dbError }, { data: undatedRows }] =
    await Promise.all([
      supabase
        .from("sms_transactions")
        .select("transaction_date, amount, direction")
        .eq("source", source)
        .gte("transaction_date", periodStart)
        .lte("transaction_date", periodEnd),
      supabase
        .from("sms_transactions")
        .select("transaction_date, amount, direction")
        .eq("source", source)
        .is("transaction_date", null),
    ]);
  if (dbError) throw new Error(dbError.message);

  const dbRows = [...(datedRows ?? []), ...(undatedRows ?? [])];

  const { missing, unmatchedDb, matchedUndated } = reconcileAgainstDb(
    statementRows,
    dbRows,
  );

  // Service role: backfilled rows are system-authored, same as the CLI path.
  const admin = createAdminClient();

  const { data: last4Row } = await admin
    .from("sms_transactions")
    .select("account_last4")
    .eq("source", source)
    .not("account_last4", "is", null)
    .order("created_at", { ascending: false })
    .limit(1);

  const records = buildBackfillRecords(
    missing,
    bank,
    source,
    last4Row?.[0]?.account_last4 ?? null,
  );

  let inserted = 0;
  let alreadyPresent = 0;

  if (records.length > 0) {
    const { data: existing } = await admin
      .from("sms_transactions")
      .select("body_hash")
      .in(
        "body_hash",
        records.map((r) => r.body_hash),
      );
    const seen = new Set((existing ?? []).map((r) => r.body_hash));
    const toInsert = records.filter((r) => !seen.has(r.body_hash));
    alreadyPresent = records.length - toInsert.length;

    if (toInsert.length > 0) {
      const { data, error } = await admin
        .from("sms_transactions")
        .insert(toInsert)
        .select("id");
      if (error) throw new Error(error.message);
      inserted = data?.length ?? 0;

      // Statement lines never pass through /ingest, so they are tagged here,
      // after the report has gone back: the model calls take a while.
      const newIds = (data ?? []).map((r) => r.id as string);
      after(() => tagByIds(newIds));
    }
  }

  const { error: syncError } = await supabase.from("statement_syncs").insert({
    bank,
    period_start: periodStart,
    period_end: periodEnd,
    rows_seen: statementRows.length,
    rows_backfilled: inserted,
  });
  if (syncError) throw new Error(syncError.message);

  const closing = closingBalance(statementRows);
  const balance = closing
    ? await recordClosingBalance(supabase, bank, periodStart, periodEnd, closing.balance)
    : null;

  return {
    bank,
    parsed: statementRows.length,
    periodStart,
    periodEnd,
    periodDeclared: declared !== null,
    backfilled: inserted,
    alreadyPresent,
    unmatchedInDb: unmatchedDb.length,
    matchedUndated: matchedUndated ?? 0,
    balance,
    samples: missing.slice(0, 8).map((m) => ({
      date: m.date,
      amount: m.amount,
      direction: m.direction,
      description: m.description.slice(0, 80),
    })),
  };
}
