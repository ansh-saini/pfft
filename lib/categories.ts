export const CATEGORIES = [
  "Bike",
  "Credit Card Bill",
  "Dividend / Interest",
  "EMI / Loan",
  "Entertainment",
  "Fitness",
  "Food & Dining",
  "Groceries",
  "Health & Medical",
  "Insurance",
  "Investment",
  "Other",
  "Refund",
  "Salary / Income",
  "Self Transfer",
  "Shopping",
  "Subscription",
  "Travel & Transport",
  "Utilities",
] as const;

export type TransactionCategory = (typeof CATEGORIES)[number];

/**
 * Money moving between your own accounts. Never income, never spend, in either
 * direction.
 *
 * A credit-card bill settles purchases that were already counted on the day
 * they happened, so counting the settlement too charges the same rupee twice —
 * and files it against the wrong bucket, since a Blinkit order paid by card
 * belongs to Needs, not to Bills. The matching "payment received on your card"
 * SMS is the same money arriving at the other end, so it is not income either.
 */
export const INTERNAL_CATEGORIES = ["Self Transfer", "Credit Card Bill"] as const;

export function isInternal(category: string | null | undefined): boolean {
  return INTERNAL_CATEGORIES.includes(
    category as (typeof INTERNAL_CATEGORIES)[number],
  );
}
