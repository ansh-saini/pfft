// Parses ICICI / Axis account-statement CSV exports and reconciles them
// against sms_transactions, to catch SMS that never got ingested.
//
// See docs/statement-reconciliation.md for the full process and the
// quirks of each export format that this file works around.

export interface StatementRow {
  date: string; // YYYY-MM-DD
  amount: number;
  direction: "debit" | "credit";
  description: string;
  upiRef: string | null;
  /** The account balance the bank printed after this line, when it did. */
  balance?: number;
}

export interface DbTxnRow {
  transaction_date: string | null;
  amount: number | null;
  direction: string | null;
}

// ─── ICICI ────────────────────────────────────────────────────────────────────
//
// Export quirk: some remarks cells contain a literal newline (the bank name
// wraps, e.g. "...UPI/Punjab \nNational Bank/..."). That splits one logical
// transaction across two physical CSV lines — the continuation line starts
// with ",,,,,". This parser re-joins those before extracting fields.

export function parseICICIStatement(csv: string): StatementRow[] {
  const raw = csv.replace(/\r/g, "");
  const lines = raw.split("\n");

  const logicalRows: string[] = [];
  let buf: string | null = null;
  for (const line of lines) {
    if (/^,\d+,/.test(line)) {
      if (buf) logicalRows.push(buf);
      buf = line;
    } else if (buf && /^,,,,,/.test(line)) {
      const mid = line.replace(/^,,,,,/, "").replace(/,+$/, "");
      const current: string = buf;
      const idx: number = current.search(/,\d+\.\d\d,\d+\.\d\d,\d+\.\d\d,$/);
      buf = idx >= 0 ? current.slice(0, idx) + mid + current.slice(idx) : current + mid;
    }
  }
  if (buf) logicalRows.push(buf);

  const out: StatementRow[] = [];
  for (const row of logicalRows) {
    const dateM = row.match(/^,\d+,"(\d\d),(\d\d),(\d\d\d\d)"/);
    const amountsM = row.match(/,(\d+\.\d\d),(\d+\.\d\d),(\d+\.\d\d),$/);
    if (!dateM || !amountsM) continue; // legend/footer rows, etc.

    const [, dd, mm, yyyy] = dateM;
    const [, withdrawal, deposit, after] = amountsM;
    const w = parseFloat(withdrawal);
    const d = parseFloat(deposit);

    const refMatches = row.match(
      /(?<=\/)(\d{9,13})(?=\/[A-Za-z0-9]{15,45}\/?,\d+\.\d\d)/g,
    );

    out.push({
      date: `${yyyy}-${mm}-${dd}`,
      amount: w > 0 ? w : d,
      direction: w > 0 ? "debit" : "credit",
      description: row,
      upiRef: refMatches ? refMatches[refMatches.length - 1] : null,
      balance: parseFloat(after),
    });
  }
  return out;
}

// ─── Axis ─────────────────────────────────────────────────────────────────────
//
// Two export layouts are in the wild.
//
// Up to Aug 2026: "Tran Date,CHQNO,PARTICULARS,DR,CR,BAL,SOL", CHQNO "-", and
// the DR column holds money IN, CR money OUT: backwards from the label.
//
// From Sep 2026: a leading "SRL NO" column, CHQNO empty, and DR/CR mean what
// they say. Customer details push the header down the page.
//
// The polarity is not trusted from either: axisPolarity() reads it off the
// running balance on every file and refuses one where neither reading holds.

interface AxisRawRow {
  date: string; // DD-MM-YYYY
  dr: string;
  cr: string;
  bal: string;
  particulars: string;
}

function parseAxisRawRows(csv: string): AxisRawRow[] {
  const raw = csv.replace(/\r/g, "");
  const lines = raw.split("\n");
  const out: AxisRawRow[] = [];
  // Optional serial number, date, cheque number ("-", empty, or a number).
  const re =
    /^(?:\d+,)?(\d\d-\d\d-\d\d\d\d),[^,]*,(.*),\s*([\d.]+)?\s*,\s*([\d.]+)?\s*,\s*([\d.]+),\d+$/;
  for (const line of lines) {
    const m = line.match(re);
    if (!m) continue;
    out.push({
      date: m[1],
      particulars: m[2].trim(),
      dr: m[3] || "",
      cr: m[4] || "",
      bal: m[5],
    });
  }
  return out;
}

/** Which way round the DR and CR columns are in this file. */
type AxisPolarity = "dr-is-credit" | "dr-is-debit";

/**
 * Reads the polarity off the running balance: whichever reading predicts the
 * next balance from the last one on at least 90% of rows. Throws when neither
 * does, so a format change nobody has looked at is caught loudly instead of
 * silently mis-parsed.
 */
function axisPolarity(rows: AxisRawRow[]): AxisPolarity {
  let checked = 0;
  let drCredit = 0;
  let drDebit = 0;
  for (let i = 1; i < rows.length; i++) {
    const prevBal = parseFloat(rows[i - 1].bal);
    const bal = parseFloat(rows[i].bal);
    const dr = rows[i].dr ? parseFloat(rows[i].dr) : 0;
    const cr = rows[i].cr ? parseFloat(rows[i].cr) : 0;
    if (!dr && !cr) continue;
    checked++;
    if (Math.abs(prevBal + dr - cr - bal) < 0.01) drCredit++;
    if (Math.abs(prevBal - dr + cr - bal) < 0.01) drDebit++;
  }
  // A single row cannot be checked. Every file seen with one row so far was
  // the older export.
  if (checked === 0) return "dr-is-credit";
  if (drCredit / checked >= 0.9) return "dr-is-credit";
  if (drDebit / checked >= 0.9) return "dr-is-debit";
  throw new Error(
    `Axis statement DR/CR polarity could not be read from the balances ` +
      `(${drCredit}/${checked} rows fit DR=credit, ${drDebit}/${checked} fit DR=debit). ` +
      `The export format may have changed — check parseAxisStatement() in lib/statementReconcile.ts.`,
  );
}

export function parseAxisStatement(csv: string): StatementRow[] {
  const rawRows = parseAxisRawRows(csv);
  const polarity = axisPolarity(rawRows);

  return rawRows.map((r) => {
    const [dd, mm, yyyy] = r.date.split("-");
    const inCol = polarity === "dr-is-credit" ? r.dr : r.cr;
    const outCol = polarity === "dr-is-credit" ? r.cr : r.dr;
    const isCredit = !!inCol;
    const amount = parseFloat(isCredit ? inCol : outCol);
    const refM = r.particulars.match(/UPI\/[A-Z0-9]+\/(\d+)/);
    return {
      date: `${yyyy}-${mm}-${dd}`,
      amount,
      direction: isCredit ? "credit" : "debit",
      description: r.particulars,
      upiRef: refM ? refM[1] : null,
      balance: parseFloat(r.bal),
    };
  });
}

/**
 * The balance the statement ends on: the running balance after its latest
 * line. Exports list oldest first, but the order is read from the dates
 * rather than assumed.
 */
export function closingBalance(rows: StatementRow[]): { date: string; balance: number } | null {
  const withBalance = rows.filter((r) => r.balance !== undefined && Number.isFinite(r.balance));
  if (withBalance.length === 0) return null;
  const first = withBalance[0];
  const last = withBalance[withBalance.length - 1];
  const closing = first.date > last.date ? first : last;
  return { date: closing.date, balance: closing.balance! };
}

// ─── Reconciliation ───────────────────────────────────────────────────────────

export interface ReconcileResult {
  /** Statement rows matched to an SMS whose date the parser could not read. */
  matchedUndated?: number;
  missing: StatementRow[]; // in statement, not in DB
  unmatchedDb: DbTxnRow[]; // in DB, not in statement (informational)
}

// Matches by (date, amount, direction) as a multiset — merchant text in SMS
// vs. statement narrations rarely matches character-for-character, but the
// triple (date, amount, direction) is reliable and self-correcting for
// same-day duplicate amounts (each DB row is consumed at most once).
export function reconcileAgainstDb(
  statementRows: StatementRow[],
  dbRows: DbTxnRow[],
): ReconcileResult {
  const pool = dbRows.map((r) => ({ ...r, used: false }));
  const missing: StatementRow[] = [];

  const sameMoney = (d: (typeof pool)[number], row: StatementRow) =>
    d.direction === row.direction &&
    d.amount !== null &&
    Math.abs(d.amount - row.amount) < 0.01;

  // Pass 1: exact date match. Run to completion first so a dated row is never
  // consumed by something an undated row could have answered.
  const unmatched: StatementRow[] = [];
  for (const row of statementRows) {
    const idx = pool.findIndex(
      (d) => !d.used && d.transaction_date === row.date && sameMoney(d, row),
    );
    if (idx >= 0) pool[idx].used = true;
    else unmatched.push(row);
  }

  // Pass 2: an SMS whose date the parser could not read is still that
  // transaction. Without this it looks missing and gets inserted a second time,
  // silently double-counting the money.
  let matchedUndated = 0;
  for (const row of unmatched) {
    const idx = pool.findIndex(
      (d) => !d.used && d.transaction_date === null && sameMoney(d, row),
    );
    if (idx >= 0) {
      pool[idx].used = true;
      matchedUndated++;
    } else {
      missing.push(row);
    }
  }

  return {
    missing,
    unmatchedDb: pool.filter((d) => !d.used),
    matchedUndated,
  };
}

export function statementDateRange(
  rows: StatementRow[],
): { min: string; max: string } | null {
  if (rows.length === 0) return null;
  const dates = rows.map((r) => r.date).sort();
  return { min: dates[0], max: dates[dates.length - 1] };
}

/**
 * The period a statement declares it covers, taken from its header.
 *
 * This is not the same as the range of transactions in the file: a statement
 * for 1 May–30 Aug with nothing booked until 4 May still *covers* 1–3 May.
 * Using the transaction range would leave those quiet days looking unsynced
 * forever, since no statement can ever produce a transaction on them.
 *
 *   Axis:  Statement of Account No - N for the period (From : 01-05-2026  To : 30-08-2026)
 *   ICICI: ,Transaction Date from,,"02,05,2026",to,"02,08,2026",,,,
 */
export function parseStatementPeriod(
  text: string,
): { start: string; end: string } | null {
  // Newer Axis exports put ~15 lines of customer details above the period.
  const head = text.replace(/\r/g, "").split("\n").slice(0, 30).join("\n");

  // Axis: DD-MM-YYYY inside a "From : ... To : ..." clause.
  const axis = head.match(
    /From\s*:\s*(\d{2})-(\d{2})-(\d{4})\s*To\s*:\s*(\d{2})-(\d{2})-(\d{4})/i,
  );
  if (axis) {
    return {
      start: `${axis[3]}-${axis[2]}-${axis[1]}`,
      end: `${axis[6]}-${axis[5]}-${axis[4]}`,
    };
  }

  // ICICI: DD,MM,YYYY quoted cells either side of a "to" cell.
  const icici = head.match(
    /from\s*,*\s*"?(\d{2}),(\d{2}),(\d{4})"?\s*,\s*to\s*,\s*"?(\d{2}),(\d{2}),(\d{4})"?/i,
  );
  if (icici) {
    return {
      start: `${icici[3]}-${icici[2]}-${icici[1]}`,
      end: `${icici[6]}-${icici[5]}-${icici[4]}`,
    };
  }

  return null;
}

/**
 * A readable merchant from a statement narration.
 *
 * Statement narrations are not SMS text — they carry the counterparty buried
 * among routing codes, so a backfilled transaction shows as "—" in the UI
 * unless we pull the name out. Formats seen across both banks:
 *
 *   ACH-CR-INDUS TOWERS LIMITED-NACH-1911682-1911682  → INDUS TOWERS LIMITED
 *   ACH-DR-ZERODHA BROKING LTD-4DQ2H4EE-UTIB702       → ZERODHA BROKING LTD
 *   UPI/P2M/600000000004/Policybaz/YES BANK /Oid//    → Policybaz      (Axis)
 *   UPI/NEW ADARSH/paytmqr6rafmx@/UPI/YES BANK L/...  → NEW ADARSH     (ICICI)
 *   RD/900000000000001/A SHARMA                        → A SHARMA
 *   VSI/YOUTUBEGOOG/202600000000/600000000005/        → YOUTUBEGOOG
 *   BIL/Home Loan XX99999 EMI A Sharma               → Home Loan XX99999 EMI A Sharma
 *   MINDSPACE BUSIN/                                  → MINDSPACE BUSIN
 *
 * Returns null rather than guessing when what's left is only a reference
 * number — an empty merchant is better than a meaningless one.
 */
export function merchantFromNarration(narration: string): string | null {
  const text = narration.trim().replace(/\/+$/, "").trim();
  if (!text) return null;

  let candidate: string;

  const ach = text.match(/^ACH-(?:CR|DR)-(.+)$/i);
  if (ach) {
    candidate = ach[1].split("-")[0];
  } else if (text.includes("/")) {
    const parts = text.split("/");
    const head = parts[0].toUpperCase();
    if (head === "UPI") {
      // Axis tags the flow (P2A/P2M/P2V) and puts the name one field later
      // than ICICI does.
      candidate = /^P2[AMV]$/i.test(parts[1] ?? "")
        ? (parts[3] ?? "")
        : (parts[1] ?? "");
    } else if (head === "RD") {
      candidate = [...parts].reverse().find((p) => p.trim()) ?? "";
    } else {
      candidate = parts[1] ?? "";
    }
  } else {
    candidate = text;
  }

  const cleaned = candidate.replace(/\s+/g, " ").trim();

  // Reference numbers are not merchants.
  if (cleaned.length < 2) return null;
  if (/^[\d\s.-]+$/.test(cleaned)) return null;

  return cleaned.slice(0, 80);
}
