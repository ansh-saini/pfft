/**
 * Recurring transactions: the same money going out around the same day of the
 * month, month after month. Rent on the 1st, a SIP on the 5th, the wifi plan,
 * the maid. A merchant's overall history can be mixed ("ROHAN VERMA" is a
 * lunch split one week and a loan the next), but ₹15,000 to him on the 1st of
 * every month is one thing, and it has been filed the same way every time.
 *
 * Pure, so it can be tested without a database.
 */

import {
  buildPattern,
  confidentFields,
  type AppliedPattern,
  type HistoryRow,
} from "./merchantPatterns";

/** A past transaction, already filed. */
export type PastTxn = HistoryRow & {
  transaction_date: string;
  amount: number;
  merchant: string | null;
};

/** How far apart two days of the month may be and still count as "the same day". */
export const DAY_WINDOW = 4;
/** How far back a recurrence is looked for. */
export const LOOKBACK_MONTHS = 12;
/** Amount drift allowed for the same counterparty: a bill that moves a little. */
export const SAME_MERCHANT_TOLERANCE = 0.1;
/**
 * Amount drift allowed across counterparties. Tight, because a different name
 * at a loosely similar amount is coincidence far more often than a pattern.
 */
export const ANY_MERCHANT_TOLERANCE = 0.02;

function monthIndex(date: string): number {
  return Number(date.slice(0, 4)) * 12 + Number(date.slice(5, 7)) - 1;
}

/**
 * Distance between two days of the month, wrapping at the month end: the 30th
 * and the 2nd are three days apart, not twenty-eight.
 */
export function dayGap(a: string, b: string): number {
  const gap = Math.abs(Number(a.slice(8, 10)) - Number(b.slice(8, 10)));
  return Math.min(gap, 31 - gap);
}

export function amountClose(a: number, b: number, tolerance: number): boolean {
  const larger = Math.max(Math.abs(a), Math.abs(b));
  if (larger === 0) return true;
  return Math.abs(a - b) <= tolerance * larger;
}

/**
 * Past transactions that look like earlier instances of this one: an earlier
 * month within the lookback, around the same day, at about the same amount.
 * At most one per month (the closest amount), newest first. The caller decides
 * which counterparties and which direction are eligible.
 */
export function recurringMatches<T extends PastTxn>(
  tx: { transaction_date: string; amount: number },
  past: T[],
  tolerance: number,
): T[] {
  const txMonth = monthIndex(tx.transaction_date);
  const byMonth = new Map<number, T>();

  for (const p of past) {
    if (!p.transaction_date) continue;
    const month = monthIndex(p.transaction_date);
    const monthsBack = txMonth - month;
    if (monthsBack < 1 || monthsBack > LOOKBACK_MONTHS) continue;
    if (dayGap(tx.transaction_date, p.transaction_date) > DAY_WINDOW) continue;
    if (!amountClose(tx.amount, p.amount, tolerance)) continue;

    const current = byMonth.get(month);
    if (
      !current ||
      Math.abs(p.amount - tx.amount) < Math.abs(current.amount - tx.amount)
    ) {
      byMonth.set(month, p);
    }
  }

  return [...byMonth.entries()].sort((a, b) => b[0] - a[0]).map(([, p]) => p);
}

/**
 * What a recurrence says, when it says it clearly: at least two earlier months
 * and the same agreement a merchant pattern needs. Null when there is no
 * settled category.
 */
export function settledRecurring(matches: PastTxn[]): AppliedPattern | null {
  const fields = confidentFields(buildPattern("", matches));
  return fields.category ? fields : null;
}
