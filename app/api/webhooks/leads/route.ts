import { NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";

export const dynamic = "force-dynamic";

const MAX_BODY_BYTES = 10_000;

const json = (body: object, status: number) =>
  NextResponse.json(body, { status, headers: { "Cache-Control": "no-store" } });

/**
 * Inbound lead webhook: creates a contact + a New opportunity for the API key's owner.
 *
 *   curl -X POST https://<host>/api/webhooks/leads \
 *     -H "Authorization: Bearer fcrm_..." -H "Content-Type: application/json" \
 *     -d '{"name":"Ada Lovelace","email":"ada@example.com","company":"Analytical Engines","value":12000}'
 *
 * The API key is the credential. It is verified inside the database (ingest_lead), which only
 * ever writes to the key owner's rows. This route uses the public publishable key, no service key.
 */
export async function POST(request: Request) {
  const auth = request.headers.get("authorization");
  const key = (auth?.toLowerCase().startsWith("bearer ") ? auth.slice(7) : request.headers.get("x-api-key"))?.trim();
  if (!key) return json({ error: "missing_api_key", message: "Send your key as 'Authorization: Bearer <key>'." }, 401);

  const raw = await request.text();
  if (raw.length > MAX_BODY_BYTES) return json({ error: "payload_too_large" }, 413);
  let payload: unknown;
  try {
    payload = JSON.parse(raw);
  } catch {
    return json({ error: "invalid_json", message: "Body must be valid JSON." }, 400);
  }

  const supabase = createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY!,
    { auth: { persistSession: false, autoRefreshToken: false } },
  );
  const { data, error } = await supabase.rpc("ingest_lead", { p_key: key, p_payload: payload });
  if (error || !data) return json({ error: "server_error" }, 502);

  if (data.ok) {
    return json(
      { ok: true, contact_id: data.contact_id, opportunity_id: data.opportunity_id, created_contact: data.created_contact },
      201,
    );
  }
  switch (data.error) {
    case "invalid_api_key":
      return json({ error: "invalid_api_key" }, 401);
    case "rate_limited":
      return json({ error: "rate_limited", message: "Too many leads; retry shortly." }, 429);
    default:
      return json({ error: "invalid_payload", message: data.message ?? "Invalid payload." }, 422);
  }
}
