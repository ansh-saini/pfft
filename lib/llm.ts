/**
 * One chat call to the self-hosted open-weight model: llama.cpp's
 * `llama-server` on the owner's Mac behind Tailscale Funnel (see `llm/`),
 * which speaks the OpenAI chat API. The reply is
 * held to `schema` by the server's grammar, so it is valid JSON of that shape.
 *
 * Config: LLM_BASE_URL (no trailing /v1), LLM_API_KEY, LLM_MODEL (a label;
 * llama-server answers with whatever model it loaded), LLM_TIMEOUT_MS.
 *
 * Server code only: it reads the key from the environment. Not marked
 * `server-only` because the tag scripts run it under tsx.
 *
 * Throws when the server is unconfigured, unreachable, slow or answers with an
 * error. The caller decides what that means.
 */
export async function completeJSON(input: {
  system: string;
  user: string;
  schema: Record<string, unknown>;
  maxTokens?: number;
}): Promise<string> {
  const base = process.env.LLM_BASE_URL;
  if (!base) throw new Error("LLM_BASE_URL is not set");

  // The iOS app gives /api/v1/ingest 15 seconds. A slower answer would cost
  // the notification, so the row waits in the Inbox instead.
  const timeoutMs = Number(process.env.LLM_TIMEOUT_MS) || 10_000;

  const res = await fetch(`${base.replace(/\/+$/, "")}/v1/chat/completions`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${process.env.LLM_API_KEY ?? ""}`,
    },
    body: JSON.stringify({
      model: process.env.LLM_MODEL ?? "local",
      messages: [
        { role: "system", content: input.system },
        { role: "user", content: input.user },
      ],
      temperature: 0,
      max_tokens: input.maxTokens ?? 256,
      response_format: {
        type: "json_schema",
        json_schema: { name: "reply", strict: true, schema: input.schema },
      },
    }),
    signal: AbortSignal.timeout(timeoutMs),
  });

  if (!res.ok) {
    throw new Error(`model server answered ${res.status}: ${(await res.text()).slice(0, 200)}`);
  }
  const data = (await res.json()) as {
    choices?: { message?: { content?: string | null } }[];
  };
  return data.choices?.[0]?.message?.content?.trim() ?? "";
}
