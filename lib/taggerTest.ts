import { randomUUID } from "crypto";
import { buildRecord } from "@/lib/ingest";
import { tagTransaction, type TagResult } from "@/lib/tagger";

/**
 * Made-up bank SMS with what the tagger should make of them. The app's Tagger
 * Test runs each one through the real parser and tagger (the model included,
 * against the real filing history) as a dry run: nothing is written.
 *
 * `expected` is the category; `expectedPath` is how it should be decided,
 * because "Self Transfer" from the card-payment rule and from the model are
 * not the same result. Merchants and descriptions are picked to be new, so the
 * model cases reach the model.
 */
export type TaggerTestCase = {
  id: string;
  title: string;
  sms: string;
  description: string | null;
  expected: string | null;
  expectedPath: "rule" | "ai" | "spam";
  why: string;
};

export const TAGGER_TEST_CASES: TaggerTestCase[] = [
  {
    id: "card-payment",
    title: "Credit card bill paid",
    sms: "Payment of INR 8421.50 has been received towards your Axis Bank Credit Card XX7788 on 03-10-26 - Axis Bank",
    description: null,
    expected: "Self Transfer",
    expectedPath: "rule",
    why: "The card side of a bill payment is the user's own money moving. A fixed rule, no model.",
  },
  {
    id: "promo",
    title: "Promotional SMS",
    sms: "Get a pre-approved personal loan up to Rs 5,00,000 at 10.5% p.a. Apply now: icici.co/pl T&C apply - ICICI Bank",
    description: null,
    expected: null,
    expectedPath: "spam",
    why: "Not a transaction. The parser drops it before the tagger.",
  },
  {
    id: "coffee",
    title: "New cafe, no description",
    sms: "ICICI Bank Acct XX123 debited for Rs 340.00 on 03-Oct-26; THIRD WAVE COFF credited. UPI:627701234561. Call 18002662 for dispute. SMS BLOCK 123 to 9215676766",
    description: null,
    expected: "Food & Dining",
    expectedPath: "ai",
    why: "A merchant never seen before. The model has to know Third Wave is a coffee chain.",
  },
  {
    id: "streaming",
    title: "Streaming plan on the card",
    sms: "INR 399.00 spent using ICICI Bank Card XX6655 on 03-Oct-26 on SONYLIV PREMIUM. Avl Limit: INR 91,204.10. If not you, call 1800 2662/SMS BLOCK 6655 to 9215676766",
    description: null,
    expected: "Subscription",
    expectedPath: "ai",
    why: "The prompt files recurring digital services as Subscription, not Entertainment.",
  },
  {
    id: "flight",
    title: "Flight booking",
    sms: "Spent INR 6420\nAxis Bank Card no. XX7788\n03-10-26 11:02:17 IST\nINDIGO AIRLINES\nAvl Limit: INR 218511.06\nNot you? SMS BLOCK 7788 to 919951860002",
    description: null,
    expected: "Travel & Transport",
    expectedPath: "ai",
    why: "Well-known airline, card spend.",
  },
  {
    id: "person-electricity",
    title: "Paid a person, with a description",
    sms: "INR 1860.00 debited\nA/c no. XX4321\n03-10-26, 09:41:05\nUPI/P2A/627788812345/RAMESH CHAND\nNot you? SMS BLOCKUPI Cust ID to 919951860002\nAxis Bank",
    description: "paid mom's electricity bill",
    expected: "Utilities",
    expectedPath: "ai",
    why: "A person's name says nothing. The description says what it was for.",
  },
  {
    id: "racket",
    title: "Sports kit, with a description",
    sms: "ICICI Bank Acct XX123 debited for Rs 1250.00 on 03-Oct-26; KARAN SPORTS credited. UPI:627705566778. Call 18002662 for dispute. SMS BLOCK 123 to 9215676766",
    description: "badminton racket restring and grip",
    expected: "Fitness",
    expectedPath: "ai",
    why: "The prompt puts sports kit fees in Fitness, not Shopping.",
  },
  {
    id: "paid-back",
    title: "Friend paid back their share",
    sms: "Dear Customer, Acct XX123 is credited with Rs 650.00 on 03-Oct-26 from NEHA KAPOOR. UPI:627712233445-ICICI Bank.",
    description: "neha's share of friday dinner",
    expected: "Refund",
    expectedPath: "ai",
    why: "Money back for a spend the user fronted reimburses it. Not income.",
  },
  {
    id: "sip",
    title: "Broker top-up, with a description",
    sms: "ICICI Bank Acct XX123 debited for Rs 10000.00 on 03-Oct-26; GROWW INVEST TE credited. UPI:627799887766. Call 18002662 for dispute. SMS BLOCK 123 to 9215676766",
    description: "extra mutual fund sip this month",
    expected: "Investment",
    expectedPath: "ai",
    why: "Money into funds is Investment, not spending.",
  },
];

export type TaggerTestRun = {
  spam: boolean;
  parsed: { merchant: string | null; amount: number | null; direction: string | null } | null;
  result: TagResult | null;
  /** How the tagger decided: "rule", "history", "note", "ai", or "spam". */
  path: string | null;
  ms: number;
};

/** One SMS through the parser and the tagger, writing nothing. */
export async function runTaggerTest(sms: string, description: string | null): Promise<TaggerTestRun> {
  const started = Date.now();
  const record = buildRecord(sms);
  if (record.is_spam || !record.direction || record.amount === null) {
    return { spam: true, parsed: null, result: null, path: "spam", ms: Date.now() - started };
  }
  const result = await tagTransaction(
    {
      // No row has this id, so history and lookalikes are everything else.
      id: randomUUID(),
      merchant: record.merchant,
      direction: record.direction,
      amount: record.amount,
      source: record.source ?? "",
      bank: record.bank ?? "",
      raw_body: sms,
      description,
      transaction_date: record.transaction_date,
    },
    { dryRun: true },
  );
  return {
    spam: false,
    parsed: { merchant: record.merchant, amount: record.amount, direction: record.direction },
    result: result ?? null,
    path: result?.tagged_by ?? null,
    ms: Date.now() - started,
  };
}
