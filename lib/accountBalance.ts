import { countedAt, type BalanceSnapshot } from "./balances";
import { BANKS, BANK_SOURCE, type StatementBank } from "./statementSync";

/** The fields a running balance needs from a transaction. */
export type BalanceTxn = {
  source: string | null;
  direction: string | null;
  amount: number | string | null;
  transaction_date: string | null;
  received_at: string | null;
};

export type BalanceCheck = {
  /** When the bank stated the balance this check compares against. */
  at: string;
  origin: BalanceSnapshot["origin"];
  /** What the app worked out from the previous reading plus the transactions since. */
  predicted: number;
  /** What the bank said. */
  actual: number;
  /** actual minus predicted. Zero means every rupee in between was recorded. */
  drift: number;
};

export type AccountBalance = {
  bank: StatementBank;
  /** The app's own figure: the last reading plus everything recorded since. */
  balance: number | null;
  /** The reading it starts from. */
  anchor: { balance: number; at: string; origin: BalanceSnapshot["origin"] } | null;
  /** Transactions counted on top of the anchor. */
  movedSince: number;
  /** The most recent time a bank reading could be compared with the app's figure. */
  lastCheck: BalanceCheck | null;
  /** Of every such comparison, how many agreed to the rupee. */
  checks: { total: number; matched: number };
};

const round2 = (n: number) => Math.round(n * 100) / 100;

function signed(t: BalanceTxn): number {
  const amount = Number(t.amount ?? 0);
  return t.direction === "credit" ? amount : t.direction === "debit" ? -amount : 0;
}

/**
 * Money that moved in an account after one reading and up to another (or up
 * to now when `to` is null). Uses the reconciliation's own rule for which side
 * of a reading a transaction fell on.
 */
function movedBetween(
  txns: BalanceTxn[],
  from: string,
  to: string | null,
): { net: number; count: number } {
  let net = 0;
  let count = 0;
  for (const t of txns) {
    const before = countedAt(t.transaction_date, t.received_at, from);
    const byEnd = to === null ? t.transaction_date !== null : countedAt(t.transaction_date, t.received_at, to);
    if (!before && byEnd) {
      net += signed(t);
      count += 1;
    }
  }
  return { net, count };
}

/**
 * Each account's balance as the app knows it, and how well that has held up.
 *
 * The figure is the latest balance reading (an "Avl Bal" SMS or one typed
 * during a reconciliation) plus every transaction recorded on that account
 * since. Every later reading is a test of the method: the earlier reading
 * plus the transactions in between should land exactly on it. A drift means
 * money moved that no SMS or statement recorded.
 */
export function accountBalances(
  snapshots: BalanceSnapshot[],
  txns: BalanceTxn[],
): AccountBalance[] {
  return BANKS.map((bank) => {
    const source = BANK_SOURCE[bank];
    const own = txns.filter((t) => t.source === source);
    const readings = snapshots
      .filter((s) => s.bank === bank)
      .sort((a, b) => (a.observed_at < b.observed_at ? -1 : a.observed_at > b.observed_at ? 1 : 0));

    const anchor = readings.at(-1);
    if (!anchor) {
      return { bank, balance: null, anchor: null, movedSince: 0, lastCheck: null, checks: { total: 0, matched: 0 } };
    }

    let lastCheck: BalanceCheck | null = null;
    let total = 0;
    let matched = 0;
    for (let i = 1; i < readings.length; i++) {
      const prev = readings[i - 1];
      const next = readings[i];
      // Readings that share a moment (backfilled SMS carry only a date) cannot
      // be ordered against each other, so they test nothing.
      const stamped = (at: string) => readings.filter((r) => r.observed_at === at).length > 1;
      if (stamped(prev.observed_at) || stamped(next.observed_at)) continue;
      const predicted = round2(Number(prev.balance) + movedBetween(own, prev.observed_at, next.observed_at).net);
      const actual = Number(next.balance);
      const drift = round2(actual - predicted);
      total += 1;
      if (Math.abs(drift) < 1) matched += 1;
      lastCheck = { at: next.observed_at, origin: next.origin, predicted, actual, drift };
    }

    const since = movedBetween(own, anchor.observed_at, null);
    return {
      bank,
      balance: round2(Number(anchor.balance) + since.net),
      anchor: { balance: Number(anchor.balance), at: anchor.observed_at, origin: anchor.origin },
      movedSince: since.count,
      lastCheck,
      checks: { total, matched },
    };
  });
}
