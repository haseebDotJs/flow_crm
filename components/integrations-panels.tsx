"use client";

import { useState, useTransition } from "react";
import { Check, Copy, Loader2, RefreshCw, Send, Trash2 } from "lucide-react";
import { toast } from "sonner";
import {
  createApiKey,
  deleteWebhook,
  regenerateWebhookSecret,
  revokeApiKey,
  saveWebhook,
  sendTestWebhook,
  setWebhookEnabled,
} from "@/app/(app)/integrations/actions";
import { Badge } from "@/components/badge";
import { LocalTime } from "@/components/local-time";

export interface EndpointView {
  url: string;
  secret: string;
  enabled: boolean;
}
export interface DeliveryView {
  id: string;
  event: string;
  created_at: string;
  status_code: number | null;
  error: string | null;
}
export interface ApiKeyView {
  id: string;
  name: string;
  key_prefix: string;
  created_at: string;
  last_used_at: string | null;
  revoked_at: string | null;
}

function CopyButton({ value, label }: { value: string; label: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <button
      type="button"
      className="btn-secondary !px-2.5 !py-1.5 text-xs"
      aria-label={label}
      onClick={async () => {
        try {
          await navigator.clipboard.writeText(value);
          setCopied(true);
          setTimeout(() => setCopied(false), 1500);
        } catch {
          toast.error("Could not copy to the clipboard.");
        }
      }}
    >
      {copied ? <Check className="h-3.5 w-3.5" /> : <Copy className="h-3.5 w-3.5" />} {copied ? "Copied" : "Copy"}
    </button>
  );
}

function statusBadge(d: DeliveryView) {
  if (d.status_code === null) {
    return d.error ? (
      <Badge className="bg-red-50 text-red-700 ring-red-200">Failed</Badge>
    ) : (
      <Badge className="bg-slate-100 text-slate-600 ring-slate-200">Pending</Badge>
    );
  }
  const ok = d.status_code >= 200 && d.status_code < 300;
  return (
    <Badge className={ok ? "bg-emerald-50 text-emerald-700 ring-emerald-200" : "bg-red-50 text-red-700 ring-red-200"}>
      HTTP {d.status_code}
    </Badge>
  );
}

export function WebhookPanel({ endpoint, deliveries }: { endpoint: EndpointView | null; deliveries: DeliveryView[] }) {
  const [url, setUrl] = useState(endpoint?.url ?? "");
  const [showSecret, setShowSecret] = useState(false);
  const [pending, start] = useTransition();
  const [error, setError] = useState<string | null>(null);

  const run = (fn: () => Promise<{ ok: boolean; error?: string }>, success: string) =>
    start(async () => {
      setError(null);
      const res = await fn();
      if (res.ok) toast.success(success);
      else {
        setError(res.error ?? "Something went wrong.");
        toast.error(res.error ?? "Something went wrong.");
      }
    });

  return (
    <div className="space-y-5 p-4">
      <form
        className="space-y-2"
        onSubmit={(e) => {
          e.preventDefault();
          run(() => saveWebhook({ url, enabled: endpoint?.enabled ?? true }), "Webhook saved");
        }}
      >
        <label className="label" htmlFor="wh-url">Endpoint URL (https)</label>
        <div className="flex flex-col gap-2 sm:flex-row">
          <input
            id="wh-url"
            className="input"
            placeholder="https://your-n8n.example.com/webhook/flowcrm"
            value={url}
            onChange={(e) => setUrl(e.target.value)}
            required
          />
          <button type="submit" className="btn-primary shrink-0" disabled={pending}>
            {pending && <Loader2 className="h-4 w-4 animate-spin" />} Save
          </button>
        </div>
        {error && <p role="alert" className="text-sm text-red-600">{error}</p>}
      </form>

      {endpoint && (
        <>
          <div className="flex flex-wrap items-center gap-2">
            <label className="flex cursor-pointer items-center gap-2 text-sm">
              <input
                type="checkbox"
                checked={endpoint.enabled}
                disabled={pending}
                onChange={(e) => run(() => setWebhookEnabled(e.target.checked), e.target.checked ? "Webhook enabled" : "Webhook paused")}
              />
              Send events
            </label>
            <button
              type="button"
              className="btn-secondary !py-1.5 text-xs"
              disabled={pending}
              onClick={() => run(async () => {
                const r = await sendTestWebhook();
                return r.ok ? { ok: true } : { ok: false, error: r.error };
              }, "Test event delivered")}
            >
              <Send className="h-3.5 w-3.5" /> Send test event
            </button>
            <button
              type="button"
              className="btn-danger !py-1.5 text-xs"
              disabled={pending}
              onClick={() => {
                if (confirm("Remove this webhook?")) {
                  setUrl("");
                  run(deleteWebhook, "Webhook removed");
                }
              }}
            >
              <Trash2 className="h-3.5 w-3.5" /> Remove
            </button>
          </div>

          <div>
            <p className="label">Signing secret</p>
            <div className="flex flex-wrap items-center gap-2">
              <code className="rounded-md bg-slate-100 px-2 py-1.5 text-xs">
                {showSecret ? endpoint.secret : "•".repeat(24)}
              </code>
              <button type="button" className="btn-secondary !px-2.5 !py-1.5 text-xs" onClick={() => setShowSecret((s) => !s)}>
                {showSecret ? "Hide" : "Reveal"}
              </button>
              <CopyButton value={endpoint.secret} label="Copy signing secret" />
              <button
                type="button"
                className="btn-secondary !px-2.5 !py-1.5 text-xs"
                disabled={pending}
                onClick={() => confirm("Generate a new secret? The old one stops working.") && run(regenerateWebhookSecret, "Secret regenerated")}
              >
                <RefreshCw className="h-3.5 w-3.5" /> Regenerate
              </button>
            </div>
            <p className="mt-1.5 text-xs text-slate-500">
              Each request carries <code>X-FlowCRM-Signature: sha256=HMAC(secret, timestamp + &quot;.&quot; + raw body)</code> and{" "}
              <code>X-FlowCRM-Timestamp</code>. Verify both and reject old timestamps.
            </p>
          </div>
        </>
      )}

      <div>
        <p className="label">Recent deliveries</p>
        {deliveries.length === 0 ? (
          <p className="text-sm text-slate-400">
            Nothing sent yet. Move a deal to a new stage, or use &ldquo;Send test event&rdquo;.
          </p>
        ) : (
          <ul className="divide-y divide-slate-100 rounded-lg border border-slate-200">
            {deliveries.map((d) => (
              <li key={d.id} className="flex items-center justify-between gap-3 px-3 py-2 text-sm">
                <span className="min-w-0 truncate">
                  <code className="text-xs">{d.event}</code>
                  <span className="ml-2 text-xs text-slate-400"><LocalTime iso={d.created_at} /></span>
                </span>
                {statusBadge(d)}
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}

export function ApiKeysPanel({ keys, endpointUrl }: { keys: ApiKeyView[]; endpointUrl: string }) {
  const [name, setName] = useState("");
  const [newKey, setNewKey] = useState<string | null>(null);
  const [pending, start] = useTransition();
  const [error, setError] = useState<string | null>(null);

  const active = keys.filter((k) => !k.revoked_at);
  const revoked = keys.filter((k) => k.revoked_at);

  return (
    <div className="space-y-5 p-4">
      <form
        className="flex flex-col gap-2 sm:flex-row"
        onSubmit={(e) => {
          e.preventDefault();
          setError(null);
          start(async () => {
            const res = await createApiKey(name);
            if (res.ok) {
              setNewKey(res.key);
              setName("");
              toast.success("API key created");
            } else setError(res.error);
          });
        }}
      >
        <input
          className="input"
          placeholder="Key name, e.g. Landing page form"
          value={name}
          onChange={(e) => setName(e.target.value)}
          maxLength={100}
          required
          aria-label="API key name"
        />
        <button type="submit" className="btn-primary shrink-0" disabled={pending}>
          {pending && <Loader2 className="h-4 w-4 animate-spin" />} Create key
        </button>
      </form>
      {error && <p role="alert" className="text-sm text-red-600">{error}</p>}

      {newKey && (
        <div role="status" className="space-y-2 rounded-lg border border-amber-200 bg-amber-50 p-3">
          <p className="text-sm font-medium text-amber-800">Copy your key now. It won&apos;t be shown again.</p>
          <div className="flex flex-wrap items-center gap-2">
            <code className="break-all rounded-md bg-white px-2 py-1.5 text-xs">{newKey}</code>
            <CopyButton value={newKey} label="Copy API key" />
            <button type="button" className="btn-secondary !px-2.5 !py-1.5 text-xs" onClick={() => setNewKey(null)}>
              Done
            </button>
          </div>
        </div>
      )}

      {active.length === 0 ? (
        <p className="text-sm text-slate-400">No active keys.</p>
      ) : (
        <ul className="divide-y divide-slate-100 rounded-lg border border-slate-200">
          {active.map((k) => (
            <li key={k.id} className="flex flex-wrap items-center justify-between gap-2 px-3 py-2 text-sm">
              <span>
                <span className="font-medium">{k.name}</span>
                <code className="ml-2 text-xs text-slate-500">{k.key_prefix}…</code>
                <span className="ml-2 text-xs text-slate-400">
                  {k.last_used_at ? (
                    <>
                      last used <LocalTime iso={k.last_used_at} />
                    </>
                  ) : (
                    "never used"
                  )}
                </span>
              </span>
              <button
                type="button"
                className="btn-danger !px-2.5 !py-1 text-xs"
                disabled={pending}
                onClick={() =>
                  confirm(`Revoke “${k.name}”? Requests using it will stop working.`) &&
                  start(async () => {
                    const res = await revokeApiKey(k.id);
                    if (res.ok) toast.success("Key revoked");
                    else toast.error(res.error);
                  })
                }
              >
                Revoke
              </button>
            </li>
          ))}
        </ul>
      )}
      {revoked.length > 0 && (
        <p className="text-xs text-slate-400">{revoked.length} revoked key{revoked.length > 1 ? "s" : ""} hidden.</p>
      )}

      <div>
        <p className="label">Example request</p>
        <pre className="overflow-x-auto rounded-lg bg-slate-900 p-3 text-xs leading-relaxed text-slate-100">{`curl -X POST ${endpointUrl} \\
  -H "Authorization: Bearer <your key>" \\
  -H "Content-Type: application/json" \\
  -d '{"name":"Ada Lovelace","email":"ada@example.com",
       "company":"Analytical Engines","value":12000}'`}</pre>
        <p className="mt-1.5 text-xs text-slate-500">
          Fields: <code>name</code> (required), <code>email</code>, <code>phone</code>, <code>company</code>,{" "}
          <code>value</code>, <code>opportunity_title</code>, <code>notes</code>. Creates the contact (reused if the email
          exists) and a New opportunity.
        </p>
      </div>
    </div>
  );
}
