/**
 * Parkings and Float.
 *
 * A parking is money set aside in software inside one bank balance: an
 * emergency fund, a trip, Diwali gifting. Float is everything not parked:
 * bank balance minus the parkings. It is never stored, so it cannot drift:
 * salary landing raises it, spending lowers it, a reconciliation corrects it.
 *
 * A parking moves when money is moved into or out of it, or when a
 * transaction is filed to it. A spend filed to a parking drains it down to
 * zero and the rest of the spend falls on Float, which needs nothing extra:
 * the bank fell by the whole spend and the parking only by what it held.
 */

export type ParkingMove = {
  bucket_id: string;
  amount: number | string;
  occurred_on: string | null;
  created_at?: string | null;
};

export type FiledTxn = {
  bucket_id: string | null;
  amount: number | string | null;
  direction: string | null;
  transaction_date: string | null;
  received_at?: string | null;
};

export type ParkingFigures = {
  balance: number;
  /** Spend filed here that the parking actually paid, after the floor at zero. */
  paid: number;
};

type Event = { at: string; delta: number; spend: boolean; date: string | null };

const round2 = (n: number) => Math.round(n * 100) / 100;

/** Orders by day, then by the moment it was written, so same-day events keep their order. */
function sortKey(date: string | null, moment: string | null | undefined): string {
  return `${date ?? "0000-00-00"}|${moment ?? ""}`;
}

/**
 * Each parking's balance, walked in time order. A spend takes what the parking
 * holds and no more; money in and moves apply in full.
 *
 * `window`, when given, also sums how much of the spend dated inside it the
 * parkings paid, for the month's "paid from parkings" line.
 */
export function computeParkings(
  parkingIds: string[],
  moves: ParkingMove[],
  txns: FiledTxn[],
  window?: { startDate: string; endDate: string },
): { byId: Record<string, ParkingFigures>; paidInWindow: number } {
  const events = new Map<string, Event[]>(parkingIds.map((id) => [id, []]));
  for (const m of moves) {
    events.get(m.bucket_id)?.push({
      at: sortKey(m.occurred_on, m.created_at),
      delta: Number(m.amount ?? 0),
      spend: false,
      date: m.occurred_on,
    });
  }
  for (const t of txns) {
    if (!t.bucket_id) continue;
    const amount = Number(t.amount ?? 0);
    const debit = t.direction === "debit";
    events.get(t.bucket_id)?.push({
      at: sortKey(t.transaction_date, t.received_at),
      delta: debit ? -amount : amount,
      spend: debit,
      date: t.transaction_date,
    });
  }

  const byId: Record<string, ParkingFigures> = {};
  let paidInWindow = 0;
  for (const [id, list] of events) {
    list.sort((a, b) => (a.at < b.at ? -1 : a.at > b.at ? 1 : 0));
    let balance = 0;
    let paid = 0;
    for (const e of list) {
      if (e.spend) {
        const take = Math.min(-e.delta, Math.max(balance, 0));
        balance -= take;
        paid += take;
        if (window && e.date && e.date >= window.startDate && e.date < window.endDate) {
          paidInWindow += take;
        }
      } else {
        balance += e.delta;
      }
    }
    byId[id] = { balance: round2(balance), paid: round2(paid) };
  }
  return { byId, paidInWindow: round2(paidInWindow) };
}

/** Float: the bank balance not parked anywhere. Null while the bank balance is unknown. */
export function floatBalance(bankTotal: number | null, parkings: Record<string, ParkingFigures>): number | null {
  if (bankTotal === null) return null;
  const parked = Object.values(parkings).reduce((sum, p) => sum + p.balance, 0);
  return round2(bankTotal - parked);
}
