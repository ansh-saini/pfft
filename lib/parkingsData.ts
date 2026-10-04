import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import { accountBalances } from "@/lib/accountBalance";
import { loadBalanceInputs } from "@/lib/accountBalanceData";
import { getCycles, getCurrentCycleId } from "@/lib/cycles";
import { BANK_SOURCE } from "@/lib/statementSync";
import { computeParkings, floatBalance, type FiledTxn, type ParkingMove } from "@/lib/parkings";

export type ParkingRow = { id: string; name: string; goal: number | null; sort_order: number };

export type LedgerMove = ParkingMove & {
  id: string;
  kind: string;
  transfer_group: string | null;
  note: string | null;
};

type Window = { startDate: string; endDate: string };

const CARD_SOURCES = ["icici_cc", "axis_cc"];

/** Today in India, the day a move is dated. */
export function todayInIndia(): string {
  return new Date(Date.now() + 5.5 * 3600 * 1000).toISOString().slice(0, 10);
}

/** Every parking, every move, every transaction filed to one. */
export async function loadParkingInputs(supabase: SupabaseClient): Promise<{
  parkings: ParkingRow[];
  moves: LedgerMove[];
  filed: FiledTxn[];
}> {
  const [{ data: buckets, error: e1 }, { data: moves, error: e2 }, { data: filed, error: e3 }] = await Promise.all([
    supabase.from("buckets").select("id, name, type, target_amount, sort_order").order("sort_order"),
    supabase.from("bucket_ledger").select("id, bucket_id, amount, kind, occurred_on, created_at, transfer_group, note"),
    supabase
      .from("sms_transactions")
      .select("bucket_id, amount, direction, transaction_date, received_at")
      .eq("is_spam", false)
      .not("bucket_id", "is", null),
  ]);
  const error = e1 ?? e2 ?? e3;
  if (error) throw new Error(error.message);
  const parkings = (buckets ?? [])
    .filter((b) => b.type === "saving")
    .map((b) => ({
      id: b.id as string,
      name: b.name as string,
      goal: b.target_amount === null ? null : Number(b.target_amount),
      sort_order: b.sort_order as number,
    }));
  return { parkings, moves: (moves ?? []) as LedgerMove[], filed: (filed ?? []) as FiledTxn[] };
}

/** Spend this window that parkings paid, for the month's "paid from parkings" line. */
export async function paidFromParkings(supabase: SupabaseClient, window: Window): Promise<number> {
  const { parkings, moves, filed } = await loadParkingInputs(supabase);
  return computeParkings(parkings.map((p) => p.id), moves, filed, window).paidInWindow;
}

/** The current and previous cycle windows. */
async function windows(supabase: SupabaseClient): Promise<{ current: Window | null; previous: Window | null }> {
  const cycles = await getCycles(supabase);
  const id = getCurrentCycleId(cycles);
  const index = cycles.findIndex((c) => c.id === id);
  return { current: cycles[index] ?? null, previous: index > 0 ? cycles[index - 1] : null };
}

/**
 * Parkings with their balances, and Float with this month's movement: money
 * into and out of the bank accounts (moves between them excluded) and card
 * spend since the last card bill, which has not left the bank yet. Also last
 * month's moves out of Float, which the app offers to repeat on salary day.
 */
export async function getParkingsOverview(supabase: SupabaseClient) {
  const [{ parkings, moves, filed }, { snapshots, txns }, { current, previous }] = await Promise.all([
    loadParkingInputs(supabase),
    loadBalanceInputs(supabase),
    windows(supabase),
  ]);
  const ids = parkings.map((p) => p.id);
  const { byId } = computeParkings(ids, moves, filed);
  const accounts = accountBalances(snapshots, txns);
  const known = accounts.filter((a) => a.balance !== null);
  const bankTotal = known.length === accounts.length ? known.reduce((sum, a) => sum + a.balance!, 0) : null;

  let monthIn = 0;
  let monthOut = 0;
  let cardSinceBill = 0;
  if (current) {
    const [{ data: month }, { data: lastBill }] = await Promise.all([
      supabase
        .from("sms_transactions")
        .select("source, direction, amount, category")
        .eq("is_spam", false)
        .in("source", Object.values(BANK_SOURCE))
        .gte("transaction_date", current.startDate)
        .lt("transaction_date", current.endDate),
      supabase
        .from("sms_transactions")
        .select("transaction_date")
        .eq("is_spam", false)
        .eq("category", "Credit Card Bill")
        .order("transaction_date", { ascending: false })
        .limit(1),
    ]);
    for (const t of month ?? []) {
      // ICICI to Axis is not money in or out of the household.
      if (t.category === "Self Transfer") continue;
      const amount = Number(t.amount ?? 0);
      if (t.direction === "credit") monthIn += amount;
      if (t.direction === "debit") monthOut += amount;
    }
    const since = lastBill?.[0]?.transaction_date ?? current.startDate;
    const { data: card } = await supabase
      .from("sms_transactions")
      .select("direction, amount, category")
      .eq("is_spam", false)
      .in("source", CARD_SOURCES)
      .gt("transaction_date", since);
    for (const t of card ?? []) {
      if (t.category === "Self Transfer") continue; // the bill's far end on the card
      cardSinceBill += (t.direction === "debit" ? 1 : -1) * Number(t.amount ?? 0);
    }
  }

  const fromFloat = (w: Window | null) =>
    moves.filter(
      (m) => m.kind === "funding" && Number(m.amount) > 0 && m.occurred_on && w &&
        m.occurred_on >= w.startDate && m.occurred_on < w.endDate && ids.includes(m.bucket_id),
    );
  const lastMonth = new Map<string, number>();
  for (const m of fromFloat(previous)) {
    lastMonth.set(m.bucket_id, (lastMonth.get(m.bucket_id) ?? 0) + Number(m.amount));
  }

  const round2 = (n: number) => Math.round(n * 100) / 100;
  return {
    float: {
      balance: floatBalance(bankTotal, byId),
      bank_total: bankTotal,
      month_in: round2(monthIn),
      month_out: round2(monthOut),
      card_since_bill: round2(Math.max(cardSinceBill, 0)),
    },
    parkings: parkings.map((p) => ({ ...p, balance: byId[p.id].balance })),
    suggestion: {
      moves: [...lastMonth.entries()].map(([parking_id, amount]) => ({ parking_id, amount: round2(amount) })),
      parked_this_month: fromFloat(current).length > 0,
    },
  };
}

/** Each parking's balance and Float, as they stand. */
export async function currentBalances(supabase: SupabaseClient) {
  const [{ parkings, moves, filed }, { snapshots, txns }] = await Promise.all([
    loadParkingInputs(supabase),
    loadBalanceInputs(supabase),
  ]);
  const { byId } = computeParkings(parkings.map((p) => p.id), moves, filed);
  const accounts = accountBalances(snapshots, txns);
  const known = accounts.filter((a) => a.balance !== null);
  const bankTotal = known.length === accounts.length ? known.reduce((sum, a) => sum + a.balance!, 0) : null;
  return { parkings, moves, filed, byId, float: floatBalance(bankTotal, byId) };
}
