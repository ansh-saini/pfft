/**
 * The decision side of tagging, with no I/O: how a note is matched, how
 * confident a decision is allowed to be, and how the model is briefed.
 *
 * A merchant name says who, never why. The note is where the why lives, so
 * the note is the primary input; category and bucket are outputs derived from
 * it. Everything here is pure so it can be tested without a database or a
 * model.
 */

import { CATEGORIES, type TransactionCategory } from "./categories";

/**
 * Below this a row waits in the review queue. Everything at or above it is
 * filed without asking: the user wants to see only what needs them.
 */
export const REVIEW_THRESHOLD = 0.5;

/** Which path filed the row. */
export type TagSource = "rule" | "note" | "history" | "ai" | "user";

/**
 * A note as compared, not as typed. Case, surrounding space, runs of space and
 * trailing punctuation carry no meaning: "Bike fuel", "bike fuel " and "bike
 * fuel." are the same decision.
 */
export function normaliseNote(note: string | null | undefined): string | null {
  if (!note) return null;
  const cleaned = note
    .toLowerCase()
    .replace(/\s+/g, " ")
    .replace(/[\s.,;:!]+$/g, "")
    .trim();
  return cleaned.length ? cleaned : null;
}

/** A decision the user has already confirmed, by note. */
export type ReviewedExample = {
  note: string;
  category: string;
  /** Bucket *name*, so it can be shown to the model and matched back. */
  bucket: string | null;
  /** Decided by a person, so it may be replayed without asking. */
  confirmed?: boolean;
};

/**
 * A note that has been reviewed before is decided the same way again, with no
 * model call. Examples are expected most recent first; the first hit wins, so
 * the newest confirmation of a note is the one that counts.
 */
export function matchReviewedNote(
  note: string | null | undefined,
  examples: ReviewedExample[],
): ReviewedExample | null {
  const wanted = normaliseNote(note);
  if (!wanted) return null;
  return examples.find((e) => normaliseNote(e.note) === wanted) ?? null;
}

/**
 * How sure a decision is allowed to be.
 *
 * Never the model's own number alone — a model saying "0.9" is not evidence.
 * A rule or a reviewed note is a decision the user made: 1.0. Merchant history
 * is the user's own convention, read back: 0.85, comfortably above the review
 * line. The model is capped at 0.8 however sure it says it is, and at 0.6 when
 * it had neither a note nor any history to go on. Under that cap its own number
 * decides whether the row is filed or asked about: a well-known shop clears
 * the review line, a bare person's name should not. A model that gave no
 * number at all is asked about.
 */
export function deriveConfidence(input: {
  source: TagSource;
  modelConfidence?: number | null;
  hasNote: boolean;
  hasHistory: boolean;
}): number {
  switch (input.source) {
    case "rule":
    case "note":
    case "user":
      return 1;
    case "history":
      return 0.85;
    case "ai": {
      const stated = clamp(input.modelConfidence ?? UNSTATED_CONFIDENCE);
      const cap = input.hasNote || input.hasHistory ? 0.8 : 0.6;
      return round2(Math.min(stated, cap));
    }
  }
}

/** What a model answer with no usable confidence counts as: just under the line. */
const UNSTATED_CONFIDENCE = 0.4;

function clamp(n: number): number {
  if (!Number.isFinite(n)) return UNSTATED_CONFIDENCE;
  return Math.max(0, Math.min(1, n));
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

/**
 * Whether a row belongs in the review queue.
 *
 * Anything a person has confirmed is done. Otherwise: no category, no bucket
 * where one is expected, or not enough confidence. A row with no confidence on
 * record but a category and bucket already set predates confidence scoring
 * and has been lived with — it is not re-queued.
 */
export function needsReview(row: {
  reviewed_at: string | null;
  category: string | null;
  bucket_id: string | null;
  ai_confidence: number | string | null;
  mayHoldBucket: boolean;
}): boolean {
  if (row.reviewed_at) return false;
  if (!row.category) return true;
  // Buckets are parkings the user files to by choice, never a gap to fill.
  if (row.ai_confidence === null || row.ai_confidence === undefined) return false;
  return Number(row.ai_confidence) < REVIEW_THRESHOLD;
}

/**
 * Every decision the user has confirmed, as lines the model can read. With a
 * few hundred reviewed notes this is a few thousand tokens and it is cached, so
 * the model sees the whole record of how this person files money rather than a
 * retrieval scheme's guess at the relevant part.
 *
 * Which line wins for a note is decided in `examples` order (hand decisions
 * first); the lines are then sorted. The model server reads this prompt on CPU
 * and keeps what it has read: in a stable order a new note changes one line
 * and the rest is reused, where newest-first would change the start and make
 * it read everything again.
 */
export function buildExampleLibrary(
  examples: ReviewedExample[],
  limit = 400,
): string {
  const seen = new Set<string>();
  const lines: string[] = [];
  for (const e of examples) {
    const key = normaliseNote(e.note);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    lines.push(`- "${key}" → ${e.category}${e.bucket ? ` / ${e.bucket}` : ""}`);
    if (lines.length >= limit) break;
  }
  return lines.sort().join("\n");
}

export type ModelReply = {
  category: TransactionCategory;
  sub_category: string | null;
  bucket: string | null;
  confidence: number;
  reasoning: string | null;
};

/**
 * The model's answer, checked. A category outside the list or a bucket that
 * does not exist is a refusal, not a best effort — a wrong write is worse than
 * a row left for review.
 */
export function parseModelReply(
  raw: string,
  bucketNames: string[],
): ModelReply | null {
  const cleaned = raw
    .replace(/^```(?:json)?\s*/i, "")
    .replace(/\s*```$/, "")
    .trim();

  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(cleaned);
  } catch {
    return null;
  }

  const category = parsed.category;
  if (
    typeof category !== "string" ||
    !CATEGORIES.includes(category as TransactionCategory)
  ) {
    return null;
  }

  let bucket: string | null = null;
  if (typeof parsed.bucket === "string" && parsed.bucket.length) {
    if (!bucketNames.includes(parsed.bucket)) return null;
    bucket = parsed.bucket;
  }

  const confidence =
    typeof parsed.confidence === "number" ? clamp(parsed.confidence) : UNSTATED_CONFIDENCE;

  return {
    category: category as TransactionCategory,
    sub_category:
      typeof parsed.sub_category === "string" && parsed.sub_category.length
        ? parsed.sub_category
        : null,
    bucket,
    confidence,
    reasoning:
      typeof parsed.reasoning === "string" && parsed.reasoning.length
        ? parsed.reasoning
        : null,
  };
}
