/**
 * Learning how a merchant is usually filed, from what has already been filed.
 *
 * A hand-saved mapping is an explicit rule and always wins. This covers the far
 * larger set of merchants that were never bookmarked but have been categorised
 * many times — roughly 250 transactions across 44 merchants that agree with
 * themselves completely.
 */


/**
 * The same shop reaches us spelled differently depending on where it came
 * from: an SMS says "VSI*YOUTUBEGO", the bank statement says "YOUTUBEGOOG".
 * Comparing the raw strings splits one merchant's history in two and the
 * pattern never reaches the two-transaction floor.
 *
 * Strips the rail prefix banks bolt on (VSI*, BIL*, ACH-DR-, UPI/ ...) and
 * everything that is not a letter or digit.
 */
export function normaliseMerchant(name: string | null): string {
  if (!name) return "";
  return name
    .toUpperCase()
    .replace(/^(ACH-[CD]R-|NEFT-|IMPS-|[A-Z]{2,6}[*/])+/g, "")
    .replace(/[^A-Z0-9]/g, "");
}

/** How much of a name must survive before a prefix match is trusted. */
const MIN_PREFIX_LENGTH = 8;

/**
 * Whether two merchant strings name the same counterparty.
 *
 * Banks truncate to different widths, so one spelling is often a prefix of the
 * other. That is only trusted past a length floor: "ZOMATO" and "ZOMATO LTD"
 * are left apart rather than risk folding genuinely different merchants —
 * missing a match costs a model call, a wrong one silently mis-files money.
 */
export function sameMerchant(a: string | null, b: string | null): boolean {
  const na = normaliseMerchant(a);
  const nb = normaliseMerchant(b);
  if (!na || !nb) return false;
  if (na === nb) return true;

  const [shorter, longer] = na.length <= nb.length ? [na, nb] : [nb, na];
  return shorter.length >= MIN_PREFIX_LENGTH && longer.startsWith(shorter);
}

export type HistoryRow = {
  category: string | null;
  sub_category: string | null;
  bucket_id: string | null;
};

export type FieldSuggestion<T> = {
  value: T;
  /** How many of the merchant's past transactions agree. */
  agreeing: number;
  total: number;
};

export type MerchantPattern = {
  merchant: string;
  seen: number;
  category: FieldSuggestion<string> | null;
  subCategory: FieldSuggestion<string> | null;
  bucketId: FieldSuggestion<string> | null;
};

/** Below this the history is treated as genuinely mixed and left to the model. */
export const AGREEMENT_THRESHOLD = 0.7;
/** One prior transaction is an anecdote, not a pattern. */
export const MIN_OCCURRENCES = 2;

function dominant<T extends string>(
  values: (T | null)[],
): FieldSuggestion<T> | null {
  const present = values.filter((v): v is T => v !== null && v !== "");
  if (present.length === 0) return null;

  const tally = new Map<T, number>();
  for (const v of present) tally.set(v, (tally.get(v) ?? 0) + 1);

  let best: T | null = null;
  let bestCount = 0;
  for (const [value, count] of tally) {
    if (count > bestCount) {
      best = value;
      bestCount = count;
    }
  }
  if (best === null) return null;

  // Measured against every past transaction, not only those carrying a value,
  // so a merchant that is usually left blank does not look decisive.
  return { value: best, agreeing: bestCount, total: values.length };
}

export function buildPattern(
  merchant: string,
  history: HistoryRow[],
): MerchantPattern {
  return {
    merchant,
    seen: history.length,
    category: dominant(history.map((h) => h.category)),
    subCategory: dominant(history.map((h) => h.sub_category)),
    bucketId: dominant(history.map((h) => h.bucket_id)),
  };
}

/** Whether a field's history agrees strongly enough to apply without asking. */
export function isConfident<T>(
  suggestion: FieldSuggestion<T> | null,
  seen: number,
): boolean {
  if (!suggestion) return false;
  if (seen < MIN_OCCURRENCES) return false;
  return suggestion.agreeing / suggestion.total >= AGREEMENT_THRESHOLD;
}

export type AppliedPattern = {
  category?: string;
  sub_category?: string;
  bucket_id?: string;
};

/**
 * The fields worth applying automatically. Each is judged on its own: a
 * merchant whose category is settled but whose bucket varies contributes the
 * category and leaves the bucket alone.
 */
export function confidentFields(pattern: MerchantPattern): AppliedPattern {
  const out: AppliedPattern = {};
  if (isConfident(pattern.category, pattern.seen))
    out.category = pattern.category!.value;
  if (isConfident(pattern.subCategory, pattern.seen))
    out.sub_category = pattern.subCategory!.value;
  if (isConfident(pattern.bucketId, pattern.seen))
    out.bucket_id = pattern.bucketId!.value;
  return out;
}

/** A short, human-readable account of why a pattern was applied. */
export function describePattern(pattern: MerchantPattern): string {
  const parts: string[] = [];
  if (isConfident(pattern.category, pattern.seen))
    parts.push(`${pattern.category!.value} (${pattern.category!.agreeing}/${pattern.category!.total})`);
  if (isConfident(pattern.bucketId, pattern.seen))
    parts.push(`bucket ${pattern.bucketId!.agreeing}/${pattern.bucketId!.total}`);
  return parts.length ? parts.join(", ") : "no confident pattern";
}
