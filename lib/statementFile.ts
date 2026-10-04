/**
 * Banks label several unrelated formats ".xls", so the extension says nothing.
 * Sniff the actual bytes and turn whatever it is into CSV text the existing
 * statement parsers can read.
 */

import * as XLSX from "xlsx";

export type StatementFileKind =
  | "csv"
  | "html"
  | "xlsx"
  | "xls-binary"
  | "unknown";

export function sniffStatementFile(bytes: Uint8Array): StatementFileKind {
  if (bytes.length === 0) return "unknown";

  // OLE2 compound document — a real legacy Excel .xls (BIFF).
  if (
    bytes[0] === 0xd0 &&
    bytes[1] === 0xcf &&
    bytes[2] === 0x11 &&
    bytes[3] === 0xe0
  ) {
    return "xls-binary";
  }

  // Zip container — .xlsx.
  if (bytes[0] === 0x50 && bytes[1] === 0x4b) return "xlsx";

  const head = new TextDecoder("utf-8", { fatal: false })
    .decode(bytes.slice(0, 4096))
    .trim()
    .toLowerCase();

  if (/^<(!doctype|html|table|meta|\?xml)/.test(head) || head.includes("<table"))
    return "html";

  return "csv";
}

function decodeEntities(s: string): string {
  return s
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'")
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(Number(n)));
}

/**
 * Flattens an HTML table into CSV. Banks that serve ".xls" as HTML wrap the
 * same rows and columns in markup, so the existing CSV parsers work once the
 * tags are gone.
 */
export function htmlTableToCsv(html: string): string {
  const rows: string[] = [];
  const rowRe = /<tr[^>]*>([\s\S]*?)<\/tr>/gi;
  const cellRe = /<t[dh][^>]*>([\s\S]*?)<\/t[dh]>/gi;

  let rowMatch: RegExpExecArray | null;
  while ((rowMatch = rowRe.exec(html)) !== null) {
    const cells: string[] = [];
    let cellMatch: RegExpExecArray | null;
    cellRe.lastIndex = 0;
    while ((cellMatch = cellRe.exec(rowMatch[1])) !== null) {
      // Decode before collapsing whitespace: &nbsp; padding is common in bank
      // exports and would otherwise survive the trim and break amount parsing.
      const text = decodeEntities(
        cellMatch[1].replace(/<br\s*\/?>/gi, " ").replace(/<[^>]+>/g, ""),
      )
        .replace(/\s+/g, " ")
        .trim();
      // Re-quote anything that would otherwise break the CSV shape.
      cells.push(/[",]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text);
    }
    if (cells.length > 0) rows.push(cells.join(","));
  }

  return rows.join("\n");
}

export class UnsupportedStatementFile extends Error {
  constructor(public kind: StatementFileKind) {
    super("Could not read that file. Export the statement as CSV or Excel.");
    this.name = "UnsupportedStatementFile";
  }
}

/**
 * Flattens an Excel workbook into CSV.
 *
 * ICICI has no CSV export — it serves a real BIFF8 .xls — so this is the only
 * path that avoids a manual convert-in-Excel step. Cells are read raw
 * (`raw: false`) so dates and amounts arrive as the strings the statement
 * displays, which is what the per-bank parsers expect.
 */
export function workbookToCsv(bytes: Uint8Array): string {
  const workbook = XLSX.read(bytes, { type: "array", cellDates: false });

  const sheets = workbook.SheetNames.map((name) =>
    XLSX.utils.sheet_to_csv(workbook.Sheets[name], {
      blankrows: false,
      rawNumbers: false,
    }).trim(),
  ).filter(Boolean);

  // SheetJS never throws on junk input — it falls back to reading the bytes as
  // text — so a corrupt download lands here as nothing usable. The caller
  // reports "no transactions found", which is the accurate message.
  if (sheets.length === 0) return "";

  // Statements are single-sheet in practice; if a workbook has several, the
  // one with the most rows is the statement and the rest are cover pages.
  return sheets.reduce((a, b) =>
    b.split("\n").length > a.split("\n").length ? b : a,
  );
}

/** CSV text from an uploaded statement, whatever wrapper the bank used. */
export function statementTextFromBytes(bytes: Uint8Array): string {
  const kind = sniffStatementFile(bytes);

  if (kind === "xls-binary" || kind === "xlsx") return workbookToCsv(bytes);

  const text = new TextDecoder("utf-8", { fatal: false }).decode(bytes);
  if (kind === "csv") return text;
  if (kind === "html") return htmlTableToCsv(text);
  throw new UnsupportedStatementFile(kind);
}
