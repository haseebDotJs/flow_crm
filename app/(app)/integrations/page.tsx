import { headers } from "next/headers";
import { ApiKeysPanel, WebhookPanel, type ApiKeyView, type DeliveryView, type EndpointView } from "@/components/integrations-panels";
import { ErrorState } from "@/components/states";
import { createClient } from "@/lib/supabase/server";

export const metadata = { title: "Integrations · FlowCRM" };

export default async function IntegrationsPage() {
  const supabase = await createClient();
  const [endpoint, deliveries, keys] = await Promise.all([
    supabase.from("webhook_endpoints").select("url, secret, enabled").maybeSingle(),
    supabase.rpc("list_webhook_deliveries", { p_limit: 15 }),
    supabase
      .from("api_keys")
      .select("id, name, key_prefix, created_at, last_used_at, revoked_at")
      .order("created_at", { ascending: false }),
  ]);

  const error = endpoint.error || deliveries.error || keys.error;
  if (error) return <ErrorState message={`Could not load integrations: ${error.message}`} />;

  const h = await headers();
  const host = h.get("x-forwarded-host") ?? h.get("host") ?? "localhost:3000";
  const proto = h.get("x-forwarded-proto") ?? (host.startsWith("localhost") ? "http" : "https");
  const leadsUrl = `${proto}://${host}/api/webhooks/leads`;

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-semibold">Integrations</h1>
        <p className="text-sm text-slate-500">
          Connect FlowCRM to tools like n8n, Make or Zapier. Events go out by webhook; leads come in by API.
        </p>
      </div>

      <section className="card">
        <div className="border-b border-slate-100 px-4 py-3">
          <h2 className="text-sm font-semibold">Outbound webhook</h2>
          <p className="text-xs text-slate-500">
            We POST a signed <code>opportunity.stage_changed</code> event to your URL whenever a deal changes stage, whether
            from the pipeline, the Voice AI or an automation.
          </p>
        </div>
        <WebhookPanel
          endpoint={(endpoint.data as EndpointView | null) ?? null}
          deliveries={(deliveries.data ?? []) as DeliveryView[]}
        />
      </section>

      <section className="card">
        <div className="border-b border-slate-100 px-4 py-3">
          <h2 className="text-sm font-semibold">Inbound lead API</h2>
          <p className="text-xs text-slate-500">
            Let forms, ads or automation tools create leads in FlowCRM. Each key only ever writes to your account.
          </p>
        </div>
        <ApiKeysPanel keys={(keys.data ?? []) as ApiKeyView[]} endpointUrl={leadsUrl} />
      </section>
    </div>
  );
}
