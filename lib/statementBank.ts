import { BANKS, type StatementBank } from "./statementSync";
import { parseAxisStatement, parseICICIStatement } from "./statementReconcile";

/** One of the user's accounts: its bank and the digits the bank shows. */
export type KnownAccount = { bank: StatementBank; last4: string };

/**
 * The account number as banks print it: masked ("XX4321", "****4321") or in
 * full ("917010000004321"). A bare run like "14321.00" is an amount, not an
 * account, so at least two mask characters or five digits must come first.
 */
export function mentionsAccount(text: string, last4: string): boolean {
  return new RegExp(`(?:[Xx*]{2,}|\\d{5,})${last4}(?![\\d.])`).test(text);
}

/**
 * Which bank a statement file is from. The account number decides first, in
 * the file name and then the contents; failing that, whichever bank's
 * parser finds rows in it. Null when neither can tell.
 */
export function detectStatementBank(
  name: string,
  text: string,
  accounts: KnownAccount[],
): { bank: StatementBank; by: "account" | "format" } | null {
  for (const source of [name, text]) {
    const hits = accounts.filter((a) => mentionsAccount(source, a.last4));
    const banks = [...new Set(hits.map((a) => a.bank))];
    if (banks.length === 1) return { bank: banks[0], by: "account" };
  }
  const parses = BANKS.filter((bank) => {
    try {
      return (bank === "ICICI" ? parseICICIStatement(text) : parseAxisStatement(text)).length > 0;
    } catch {
      return false;
    }
  });
  return parses.length === 1 ? { bank: parses[0], by: "format" } : null;
}
