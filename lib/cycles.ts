import type { SupabaseClient } from "@supabase/supabase-js";

export type Cycle = {
  id: string; // "YYYY-MM"
  label: string; // "May 2026"
  startDate: string; // inclusive "YYYY-MM-DD"
  endDate: string; // exclusive "YYYY-MM-DD" (the 1st of the next month)
};

const MONTH_NAMES = [
  "January", "February", "March", "April", "May", "June",
  "July", "August", "September", "October", "November", "December",
];

function pad(n: number): string {
  return String(n).padStart(2, "0");
}

/** First day of the month after the given one. */
function nextMonth(year: number, month: number): [number, number] {
  return month === 12 ? [year + 1, 1] : [year, month + 1];
}

export function monthKeyOf(date: string): string {
  return date.slice(0, 7);
}

/**
 * Calendar months from the first transaction through today.
 *
 * Cycles used to run salary-credit to salary-credit, but the salary lands
 * anywhere from the 3rd to the 7th while fixed commitments (home loan on the
 * 5th, Apple on the 7th, Policybazaar on the 8th) fire on fixed dates. A moving
 * boundary put two home-loan EMIs in one cycle and none in the next. A calendar
 * month puts every recurring commitment in exactly one period, every time.
 *
 * The salary credit is still the moment to allocate money into buckets — it is
 * a funding event, not a period boundary.
 */
export function buildCycles(
  firstDate: string | null,
  lastDate: string | null,
  today: string,
): Cycle[] {
  const startKey = firstDate ? monthKeyOf(firstDate) : monthKeyOf(today);
  const lastSeen = lastDate ? monthKeyOf(lastDate) : monthKeyOf(today);
  const endKey = lastSeen > monthKeyOf(today) ? lastSeen : monthKeyOf(today);

  if (startKey > endKey) return [];

  const cycles: Cycle[] = [];
  let [year, month] = startKey.split("-").map(Number);

  // Guard against a malformed date producing an unbounded loop.
  for (let i = 0; i < 600; i++) {
    const key = `${year}-${pad(month)}`;
    const [nextYear, nextMonthNum] = nextMonth(year, month);

    cycles.push({
      id: key,
      label: `${MONTH_NAMES[month - 1]} ${year}`,
      startDate: `${key}-01`,
      endDate: `${nextYear}-${pad(nextMonthNum)}-01`,
    });

    if (key >= endKey) break;
    [year, month] = [nextYear, nextMonthNum];
  }

  return cycles;
}

export async function getCycles(supabase: SupabaseClient): Promise<Cycle[]> {
  const [{ data: earliest }, { data: latest }] = await Promise.all([
    supabase
      .from("sms_transactions")
      .select("transaction_date")
      .eq("is_spam", false)
      .not("transaction_date", "is", null)
      .order("transaction_date", { ascending: true })
      .limit(1),
    supabase
      .from("sms_transactions")
      .select("transaction_date")
      .eq("is_spam", false)
      .not("transaction_date", "is", null)
      .order("transaction_date", { ascending: false })
      .limit(1),
  ]);

  const first = earliest?.[0]?.transaction_date ?? null;
  const last = latest?.[0]?.transaction_date ?? null;

  return buildCycles(first, last, todayISO());
}

export function todayISO(): string {
  const d = new Date();
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

export function getCurrentCycleId(cycles: Cycle[]): string | null {
  if (cycles.length === 0) return null;
  const key = monthKeyOf(todayISO());
  const match = cycles.find((c) => c.id === key);
  return match ? match.id : cycles[cycles.length - 1].id;
}
