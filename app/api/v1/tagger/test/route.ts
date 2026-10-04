import { NextResponse } from "next/server";
import { withUser } from "@/lib/api/auth";
import { TAGGER_TEST_CASES, runTaggerTest } from "@/lib/taggerTest";

/** The made-up SMS the app's Tagger Test runs, with what each should become. */
export const GET = withUser(async () => NextResponse.json({ cases: TAGGER_TEST_CASES }));

/**
 * Runs one SMS through the parser and the tagger as a dry run: nothing is
 * written. `{ "case_id": "coffee" }` runs a listed case and says whether it
 * passed; `{ "sms": "...", "description": "..." }` runs any text.
 */
export const POST = withUser(async (request) => {
  let body: { case_id?: unknown; sms?: unknown; description?: unknown };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Body must be JSON" }, { status: 422 });
  }

  if (typeof body.case_id === "string") {
    const testCase = TAGGER_TEST_CASES.find((c) => c.id === body.case_id);
    if (!testCase) return NextResponse.json({ error: "No such case" }, { status: 404 });
    const run = await runTaggerTest(testCase.sms, testCase.description);
    const category = run.spam ? null : (run.result?.category ?? null);
    return NextResponse.json({
      ...run,
      case_id: testCase.id,
      passed: category === testCase.expected && run.path === testCase.expectedPath,
    });
  }

  if (typeof body.sms !== "string" || !body.sms.trim()) {
    return NextResponse.json({ error: "'case_id' or 'sms' is required" }, { status: 422 });
  }
  const description =
    typeof body.description === "string" && body.description.trim() ? body.description.trim() : null;
  return NextResponse.json({ ...(await runTaggerTest(body.sms.trim(), description)), passed: null });
});
