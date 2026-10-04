// ─── Types ────────────────────────────────────────────────────────────────────

export interface ParsedTransaction {
  is_spam: false;
  /**
   * Set when the amount is not in rupees. The SMS states only the foreign
   * figure, so `amount` holds that number and the rupee value has to come from
   * the card statement or be entered by hand. Without this the charge silently
   * understates: USD 20.00 lands as 20 rather than about 1,937.
   */
  foreign_currency?: string;
  bank: "ICICI" | "AXIS";
  source: "icici_bank" | "icici_cc" | "axis_bank" | "axis_cc";
  account_last4: string;
  amount: number;
  direction: "debit" | "credit";
  merchant: string | null;
  upi_ref: string | null;
  transaction_date: string | null; // YYYY-MM-DD
  transaction_time: string | null; // HH:MM:SS
}

export interface SpamResult {
  is_spam: true;
}

export type ParseResult = ParsedTransaction | SpamResult;

// ─── Date helpers ─────────────────────────────────────────────────────────────

// "18-May-26" → "2026-05-18"
export function parseIndianDate(s: string): string | null {
  const MONTHS: Record<string, string> = {
    jan: "01", feb: "02", mar: "03", apr: "04", may: "05", jun: "06",
    jul: "07", aug: "08", sep: "09", oct: "10", nov: "11", dec: "12",
  };
  const m = s.match(/(\d{2})-([A-Za-z]+)-(\d{2})/);
  if (!m) return null;
  const mon = MONTHS[m[2].toLowerCase()];
  if (!mon) return null;
  return `20${m[3]}-${mon}-${m[1]}`;
}

// "10-05-26" → "2026-05-10"
export function parseAxisDate(s: string): string | null {
  const m = s.match(/(\d{2})-(\d{2})-(\d{2})/);
  if (!m) return null;
  return `20${m[3]}-${m[2]}-${m[1]}`;
}

export function parseAmount(s: string): number {
  return parseFloat(s.replace(/,/g, ""));
}

// ─── ICICI Parsers ────────────────────────────────────────────────────────────

/**
 * ICICI UPI debit
 *   ICICI Bank Acct XX123 debited for Rs 104.00 on 18-May-26;
 *   NEW ADARSH DAIR credited. UPI:600000000001.
 */
export function parseICICIDebit(body: string): ParsedTransaction | null {
  const re =
    /ICICI Bank Acct XX(\d+) debited for Rs ([\d,]+\.?\d*) on (\d{2}-[A-Za-z]+-\d{2});\s*(.+?)\s+credited\.\s*UPI:(\d+)/i;
  const m = body.match(re);
  if (!m) return null;
  return {
    is_spam: false,
    bank: "ICICI",
    source: "icici_bank",
    account_last4: m[1],
    amount: parseAmount(m[2]),
    direction: "debit",
    merchant: m[4].trim(),
    upi_ref: m[5],
    transaction_date: parseIndianDate(m[3]),
    transaction_time: null,
  };
}

/**
 * ICICI UPI credit
 *   Dear Customer, Acct XX123 is credited with Rs 5.00 on 18-May-26
 *   from MEHTA R. UPI:600000000002-ICICI Bank.
 */
export function parseICICICredit(body: string): ParsedTransaction | null {
  const re =
    /Acct XX(\d+) is credited with Rs ([\d,]+\.?\d*) on (\d{2}-[A-Za-z]+-\d{2}) from (.+?)\.\s*UPI:(\d+)/i;
  const m = body.match(re);
  if (!m) return null;
  return {
    is_spam: false,
    bank: "ICICI",
    source: "icici_bank",
    account_last4: m[1],
    amount: parseAmount(m[2]),
    direction: "credit",
    merchant: m[4].trim(),
    upi_ref: m[5],
    transaction_date: parseIndianDate(m[3]),
    transaction_time: null,
  };
}

/**
 * ICICI bill/EMI debit (home loan, etc.) — no UPI ref
 *   ICICI Bank Acc XX123 debited Rs. 18,500.00 on 05-May-26 InfoBIL*Home Loan.Avl Bal Rs. 61,240.00.
 */
export function parseICICIBillDebit(body: string): ParsedTransaction | null {
  const re =
    /ICICI Bank Acc XX(\d+) debited Rs\.\s*([\d,]+\.?\d*) on (\d{2}-[A-Za-z]+-\d{2})\s+Info([^.]+)\./i;
  const m = body.match(re);
  if (!m) return null;
  return {
    is_spam: false,
    bank: "ICICI",
    source: "icici_bank",
    account_last4: m[1],
    amount: parseAmount(m[2]),
    direction: "debit",
    merchant: m[4].trim(),
    upi_ref: null,
    transaction_date: parseIndianDate(m[3]),
    transaction_time: null,
  };
}

/**
 * ICICI account debit alert, reversed word order
 *   Rs. 299.00 debited from ICICI Bank Acc XX123 on 30-Aug-26 VSI*YOUTUBEGO. Bal Rs. 84,310.00.
 *
 * Same event as parseICICIBillDebit but phrased the other way round, which is
 * how a recurring card standing instruction (YouTube, Apple) shows up. It was
 * falling through to spam, so those debits only ever reached the ledger via
 * statement sync.
 */
export function parseICICIAccountDebitAlert(
  body: string,
): ParsedTransaction | null {
  const re =
    /Rs\.?\s*([\d,]+\.?\d*) debited from ICICI Bank Acc XX(\d+) on (\d{2}-[A-Za-z]+-\d{2})\s+([^.]+)\./i;
  const m = body.match(re);
  if (!m) return null;
  return {
    is_spam: false,
    bank: "ICICI",
    source: "icici_bank",
    account_last4: m[2],
    amount: parseAmount(m[1]),
    direction: "debit",
    merchant: m[4].trim(),
    upi_ref: null,
    transaction_date: parseIndianDate(m[3]),
    transaction_time: null,
  };
}

/**
 * ICICI standing-instruction confirmation
 *   We have successfully processed payment of INR 299.00 to Merchant Youtube,
 *   as per Standing Instruction XVEabz8H7p on 30/08/2026 for ICICI Bank Debit Card 0171.
 *
 * Not a transaction. The same debit already arrives as an account alert
 * ("Rs. 299.00 debited from ICICI Bank Acc XX123 ... VSI*YOUTUBEGO"), and
 * recording both would double-count it — the mistake Axis mandate
 * confirmations already caused once. The account alert wins because it carries
 * the account and matches how every other bank debit is recorded.
 */
export function parseICICIStandingInstruction(body: string): SpamResult | null {
  const re =
    /successfully processed payment of INR [\d,]+\.?\d* to Merchant .+ as per Standing Instruction/i;
  return re.test(body) ? { is_spam: true } : null;
}

/**
 * ICICI NEFT/IMPS credit (salary, transfers)
 *   ICICI Bank Account XX123 credited:Rs. 1,65,000.00 on 05-May-26. Info NEFT-UTIBN0000000001-EMPLOYER.
 */
export function parseICICINEFTCredit(body: string): ParsedTransaction | null {
  const re =
    /ICICI Bank Account XX(\d+) credited:Rs\.\s*([\d,]+\.?\d*) on (\d{2}-[A-Za-z]+-\d{2})\.\s*Info\s+([^.]+)\./i;
  const m = body.match(re);
  if (!m) return null;
  return {
    is_spam: false,
    bank: "ICICI",
    source: "icici_bank",
    account_last4: m[1],
    amount: parseAmount(m[2]),
    direction: "credit",
    merchant: m[4].trim(),
    upi_ref: null,
    transaction_date: parseIndianDate(m[3]),
    transaction_time: null,
  };
}

/**
 * ICICI AutoPay / mandate debit
 *   Rs 219.00 debited from ICICI Bank Savings Account XX123 on 07-May-26
 *   towards APPLE MEDIA SER for Create Mandate AutoPay...
 */
export function parseICICIAutoPayDebit(body: string): ParsedTransaction | null {
  const re =
    /Rs ([\d,]+\.?\d*) debited from ICICI Bank\s+\w+ Account XX(\d+) on (\d{2}-[A-Za-z]+-\d{2}) towards ([^\s](?:.*?))(?:\s+for\s|\s+Avl|\s*$)/i;
  const m = body.match(re);
  if (!m) return null;
  return {
    is_spam: false,
    bank: "ICICI",
    source: "icici_bank",
    account_last4: m[2],
    amount: parseAmount(m[1]),
    direction: "debit",
    merchant: m[4].trim(),
    upi_ref: null,
    transaction_date: parseIndianDate(m[3]),
    transaction_time: null,
  };
}

/**
 * ICICI credit card spend (INR or foreign currency)
 *   USD 20.00 spent using ICICI Bank Card XX6655 on 07-May-26 on CLAUDE.AI SUBSC. Avl Limit: ...
 */
export function parseICICICardSpend(body: string): ParsedTransaction | null {
  const re =
    /([A-Z]{3})\s+([\d,]+\.?\d*) spent using ICICI Bank Card XX(\d+) on (\d{2}-[A-Za-z]+-\d{2}) on (.+?)\. Avl/i;
  const m = body.match(re);
  if (!m) return null;
  const currency = m[1].toUpperCase();
  return {
    is_spam: false,
    bank: "ICICI",
    source: "icici_cc",
    account_last4: m[3],
    amount: parseAmount(m[2]),
    direction: "debit",
    merchant: m[5].trim(),
    upi_ref: null,
    transaction_date: parseIndianDate(m[4]),
    transaction_time: null,
    ...(currency === "INR" ? {} : { foreign_currency: currency }),
  };
}

/**
 * ICICI credit card refund
 *   CLAUDE.AI SUBSCRIPTION refund of Rs 340.38 credited to ICICI Bank Credit Card XX6655 on 09-MAY-26.
 */
export function parseICICICCRefund(body: string): ParsedTransaction | null {
  const re =
    /(.+?) refund of Rs ([\d,]+\.?\d*) credited to ICICI Bank Credit Card XX(\d+) on (\d{2}-[A-Za-z]+-\d{2})/i;
  const m = body.match(re);
  if (!m) return null;
  return {
    is_spam: false,
    bank: "ICICI",
    source: "icici_cc",
    account_last4: m[3],
    amount: parseAmount(m[2]),
    direction: "credit",
    merchant: m[1].trim(),
    upi_ref: null,
    transaction_date: parseIndianDate(m[4]),
    transaction_time: null,
  };
}

/**
 * ICICI credit card payment received
 *   Payment of Rs 2,281.86 has been received on your ICICI Bank Credit Card XX6655
 *   through Bharat Bill Payment System on 09-MAY-26.
 *
 * The merchant is the card, not the rail the money travelled down. BBPS and CRED
 * are plumbing that changes between payments; the card is what you actually paid,
 * and it is what makes the row findable next to its sibling on the bank side.
 */
export function parseICICICCPayment(body: string): ParsedTransaction | null {
  const re =
    /Payment of Rs ([\d,]+\.?\d*) has been received on your ICICI Bank Credit Card XX(\d+)(?:\s+through\s+.+?)?\s+on\s+(\d{2}-[A-Za-z]+-\d{2})/i;
  const m = body.match(re);
  if (!m) return null;
  return {
    is_spam: false,
    bank: "ICICI",
    source: "icici_cc",
    account_last4: m[2],
    amount: parseAmount(m[1]),
    direction: "credit",
    merchant: "ICICI Credit Card",
    upi_ref: null,
    transaction_date: parseIndianDate(m[3]),
    transaction_time: null,
  };
}

// ─── Axis Parsers ─────────────────────────────────────────────────────────────

/**
 * Axis Credit Card spend  ← must be checked BEFORE axis_bank
 *   Spent INR 2307
 *   Axis Bank Card no. XX7788
 *   17-05-26 19:45:39 IST
 *   LIFE STYLE
 *   Avl Limit: INR 229480.62
 */
export function parseAxisCC(body: string): ParsedTransaction | null {
  if (!/Spent INR/i.test(body) || !/Axis Bank Card no\./i.test(body))
    return null;

  const amountM = body.match(/Spent INR ([\d,]+\.?\d*)/i);
  const cardM = body.match(/Axis Bank Card no\.\s*XX(\d+)/i);
  const datetimeM = body.match(/(\d{2}-\d{2}-\d{2})\s+(\d{2}:\d{2}:\d{2})/);

  if (!amountM) return null;

  // Merchant is the line immediately after the datetime line
  let merchant: string | null = null;
  const lines = body
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean);
  const dtIdx = lines.findIndex((l) =>
    /\d{2}-\d{2}-\d{2}\s+\d{2}:\d{2}:\d{2}/.test(l)
  );
  if (dtIdx !== -1 && lines[dtIdx + 1]) {
    const candidate = lines[dtIdx + 1];
    if (!/not you|avl limit|sms block/i.test(candidate)) {
      merchant = candidate;
    }
  }

  // Some senders deliver the whole alert on one line, where the merchant sits
  // between the timestamp and the available limit rather than on its own row.
  if (!merchant) {
    const inline = body.match(/\d{2}:\d{2}:\d{2}\s+IST\s+(.+?)\s+Avl Limit/i);
    if (inline) merchant = inline[1].trim();
  }

  return {
    is_spam: false,
    bank: "AXIS",
    source: "axis_cc",
    account_last4: cardM ? cardM[1] : "",
    amount: parseAmount(amountM[1]),
    direction: "debit",
    merchant,
    upi_ref: null,
    transaction_date: datetimeM ? parseAxisDate(datetimeM[1]) : null,
    transaction_time: datetimeM ? datetimeM[2] : null,
  };
}

/**
 * Axis Credit Card payment received
 *   Payment of INR 9152.64 has been received towards your Axis Bank Credit Card XX7788 on 09-05-26 - Axis Bank
 *
 * Axis names no counterparty at all, so this row read as an empty merchant. It is
 * the card, same as the ICICI one.
 */
export function parseAxisCCPayment(body: string): ParsedTransaction | null {
  const re =
    /Payment of INR ([\d,]+\.?\d*) has been received towards your Axis Bank Credit Card XX(\d+) on (\d{2}-\d{2}-\d{2})/i;
  const m = body.match(re);
  if (!m) return null;
  return {
    is_spam: false,
    bank: "AXIS",
    source: "axis_cc",
    account_last4: m[2],
    amount: parseAmount(m[1]),
    direction: "credit",
    merchant: "AXIS Credit Card",
    upi_ref: null,
    transaction_date: parseAxisDate(m[3]),
    transaction_time: null,
  };
}

/**
 * Axis Bank savings/current account UPI SMS
 *   INR 1.00 debited
 *   A/c no. XX4321
 *   10-05-26, 21:08:17
 *   UPI/P2A/600000000003/RIYA MEHTA
 *   Axis Bank
 */
export function parseAxisBank(body: string): ParsedTransaction | null {
  if (
    !/A\/c no\. XX/i.test(body) ||
    !/debited|credited/i.test(body) ||
    !/Axis Bank/i.test(body)
  )
    return null;

  const debitM = body.match(/INR ([\d,]+\.?\d*) debited/i);
  const creditM = body.match(/INR ([\d,]+\.?\d*) credited/i);
  if (!debitM && !creditM) return null;

  const isDebit = !!debitM;
  const amountStr = isDebit ? debitM![1] : creditM![1];

  const accountM = body.match(/A\/c no\.\s*XX(\d+)/i);
  // "10-05-26, 21:08:17"
  const datetimeM = body.match(/(\d{2}-\d{2}-\d{2}),\s*(\d{2}:\d{2}:\d{2})/);
  // "UPI/P2A/600000000003/RIYA MEHTA"
  const upiM = body.match(/UPI\/[A-Z0-9]+\/(\d+)\/([^\r\n]+)/);

  return {
    is_spam: false,
    bank: "AXIS",
    source: "axis_bank",
    account_last4: accountM ? accountM[1] : "",
    amount: parseAmount(amountStr),
    direction: isDebit ? "debit" : "credit",
    merchant: upiM ? upiM[2].trim() : null,
    upi_ref: upiM ? upiM[1] : null,
    transaction_date: datetimeM ? parseAxisDate(datetimeM[1]) : null,
    transaction_time: datetimeM ? datetimeM[2] : null,
  };
}

/**
 * Axis Bank ACH/direct debit (Zerodha, SIP, etc.)
 *   Debit INR 10000.00
 *   Axis Bank A/c XX4321
 *   05-05-26 06:53:42
 *   ACH-DR-ZERODHA BROKING LTD
 *   WhatsApp BAL to 917036165000
 */
export function parseAxisBankACH(body: string): ParsedTransaction | null {
  if (!/Axis Bank A\/c XX/i.test(body)) return null;

  const debitM = body.match(/^Debit INR ([\d,]+\.?\d*)/im);
  const creditM = body.match(/^Credit INR ([\d,]+\.?\d*)/im);
  if (!debitM && !creditM) return null;

  const isDebit = !!debitM;
  const amountStr = isDebit ? debitM![1] : creditM![1];

  const accountM = body.match(/Axis Bank A\/c XX(\d+)/i);
  // "05-05-26 06:53:42" — space separator (no comma)
  const datetimeM = body.match(/(\d{2}-\d{2}-\d{2}) (\d{2}:\d{2}:\d{2})/);

  // Merchant is the line after the datetime line
  let merchant: string | null = null;
  const lines = body.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  const dtIdx = lines.findIndex((l) =>
    /^\d{2}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(l)
  );
  if (dtIdx !== -1 && lines[dtIdx + 1]) {
    const candidate = lines[dtIdx + 1];
    if (!/whatsapp|not you|blockall/i.test(candidate)) {
      merchant = candidate;
    }
  }

  return {
    is_spam: false,
    bank: "AXIS",
    source: "axis_bank",
    account_last4: accountM ? accountM[1] : "",
    amount: parseAmount(amountStr),
    direction: isDebit ? "debit" : "credit",
    merchant,
    upi_ref: null,
    transaction_date: datetimeM ? parseAxisDate(datetimeM[1]) : null,
    transaction_time: datetimeM ? datetimeM[2] : null,
  };
}

/**
 * Axis NACH mandate confirmation (SIP, insurance, recurring mandates)
 *   NACH debit towards INDIAN CLEARING CORP for INR 5,000.00 with UMRN UTIB... has been
 *   successfully processed in A/c no. XX4321 today - Axis Bank
 *
 * Not a transaction. Axis sends two messages for one mandate debit: a dated
 * "Debit INR ... ACH-DR-<party>" alert, and this undated confirmation that the
 * mandate went through. Recording both double-counted the money — and because
 * this one carries no date it fell outside every cycle, so the phantom spend sat
 * invisibly in the carried balance instead of showing up somewhere obvious.
 *
 * Parsed rather than ignored so the fields stay available, but flagged as spam
 * so it never reaches the ledger. If an ACH-DR alert is ever missed, statement
 * sync backfills that debit from the bank's own record.
 */
export function parseAxisNACHDebit(body: string): SpamResult | null {
  const re =
    /NACH debit towards (.+?) for INR ([\d,]+\.?\d*) with UMRN .+ has been successfully processed in A\/c no\. XX(\d+) today/i;
  return re.test(body) ? { is_spam: true } : null;
}

// ─── Main dispatcher ──────────────────────────────────────────────────────────

export function parse(body: string): ParseResult {
  // Order matters:
  // - ICICI UPI parsers before bill/NEFT (more specific regex)
  // - axis_cc before axis_bank (both contain "Axis Bank")
  return (
    parseICICIDebit(body) ||
    parseICICICredit(body) ||
    parseICICIBillDebit(body) ||
    parseICICIAccountDebitAlert(body) ||
    parseICICIStandingInstruction(body) ||
    parseICICINEFTCredit(body) ||
    parseICICIAutoPayDebit(body) ||
    parseICICICardSpend(body) ||
    parseICICICCRefund(body) ||
    parseICICICCPayment(body) ||
    parseAxisCC(body) ||
    parseAxisCCPayment(body) ||
    parseAxisBank(body) ||
    parseAxisBankACH(body) ||
    parseAxisNACHDebit(body) ||
    { is_spam: true }
  );
}
