import { isInternal } from "./categories";

/** The fields the cycle figures need from a transaction. */
export type SummaryTxn = {
  direction: string | null;
  category: string | null;
  amount: number | string | null;
  merchant: string | null;
  sub_category: string | null;
};

export type CategoryLine = {
  merchant: string | null;
  amount: number;
  sub_category: string | null;
};

export type CycleSummary = {
  income: number;
  /** Debits that are neither investment nor internal, less refunds. */
  spend: number;
  investments: number;
  refunds: number;
  leftover: number;
  /** Spend per category, largest first. Refunds are not netted per category. */
  categories: { category: string; amount: number }[];
  categoryTxns: Record<string, CategoryLine[]>;
};

/**
 * The figures the dashboard shows for one cycle, shared by the web page and
 * the iOS app's API so both always agree.
 */
export function summarise(txns: SummaryTxn[]): CycleSummary {
  const amount = (t: SummaryTxn) => Number(t.amount ?? 0);

  const income = txns
    .filter(
      (t) => t.direction === "credit" && !isInternal(t.category) && t.category !== "Refund",
    )
    .reduce((sum, t) => sum + amount(t), 0);

  const refunds = txns
    .filter((t) => t.direction === "credit" && t.category === "Refund")
    .reduce((sum, t) => sum + amount(t), 0);

  const investments = txns
    .filter((t) => t.direction === "debit" && t.category === "Investment")
    .reduce((sum, t) => sum + amount(t), 0);

  const isSpend = (t: SummaryTxn) =>
    t.direction === "debit" && t.category !== "Investment" && !isInternal(t.category);

  const spend = txns.filter(isSpend).reduce((sum, t) => sum + amount(t), 0) - refunds;

  const categoryMap: Record<string, number> = {};
  const categoryTxns: Record<string, CategoryLine[]> = {};
  for (const t of txns) {
    if (!isSpend(t)) continue;
    const cat = t.category ?? "Uncategorized";
    categoryMap[cat] = (categoryMap[cat] ?? 0) + amount(t);
    (categoryTxns[cat] ??= []).push({
      merchant: t.merchant,
      amount: amount(t),
      sub_category: t.sub_category,
    });
  }

  const categories = Object.entries(categoryMap)
    .sort(([, a], [, b]) => b - a)
    .map(([category, total]) => ({ category, amount: total }));

  return {
    income,
    spend,
    investments,
    refunds,
    leftover: income - spend - investments,
    categories,
    categoryTxns,
  };
}

/**
 * The cycle's salary, read as its "Salary / Income" credits (the same signal
 * bucket allocation uses): their total and the day the first one landed, or
 * null while it has not arrived.
 */
export function salaryCredit(
  txns: (SummaryTxn & { transaction_date: string | null })[],
): { amount: number; date: string | null } | null {
  const credits = txns.filter(
    (t) => t.direction === "credit" && t.category === "Salary / Income",
  );
  if (credits.length === 0) return null;
  const dates = credits.map((t) => t.transaction_date).filter((d): d is string => !!d).sort();
  return {
    amount: credits.reduce((sum, t) => sum + Number(t.amount ?? 0), 0),
    date: dates[0] ?? null,
  };
}
