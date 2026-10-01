import { createHmac, randomUUID } from "node:crypto";
import { lookup } from "node:dns/promises";
import { isIP } from "node:net";

/** HMAC-SHA256 over "<timestamp>.<raw body>", the same scheme the database trigger uses. */
export function signPayload(secret: string, timestamp: string, body: string) {
  return "sha256=" + createHmac("sha256", secret).update(`${timestamp}.${body}`).digest("hex");
}

/** Expands any IPv6 text form (incl. embedded dotted IPv4) into eight 16-bit groups. */
function expandIPv6(ip: string): number[] | null {
  let v = ip.toLowerCase();
  const dotted = v.match(/(\d+)\.(\d+)\.(\d+)\.(\d+)$/);
  if (dotted) {
    const [a, b, c, d] = dotted.slice(1).map(Number);
    v = v.slice(0, dotted.index) + ((a << 8) | b).toString(16) + ":" + ((c << 8) | d).toString(16);
  }
  const halves = v.split("::");
  if (halves.length > 2) return null;
  const head = halves[0] ? halves[0].split(":") : [];
  const tail = halves.length === 2 && halves[1] ? halves[1].split(":") : [];
  const missing = 8 - head.length - tail.length;
  if ((halves.length === 1 && missing !== 0) || missing < 0) return null;
  const groups = [...head, ...Array(halves.length === 2 ? missing : 0).fill("0"), ...tail].map((g) => parseInt(g, 16));
  return groups.length === 8 && groups.every((g) => Number.isInteger(g) && g >= 0 && g <= 0xffff) ? groups : null;
}

function isPrivateIp(ip: string): boolean {
  if (ip.includes(":")) {
    const g = expandIPv6(ip);
    if (!g) return true; // unparseable: refuse
    // IPv4-mapped (::ffff:a.b.c.d) and IPv4-compatible (::a.b.c.d): judge by the embedded IPv4.
    const firstFiveZero = g.slice(0, 5).every((x) => x === 0);
    if (firstFiveZero && (g[5] === 0xffff || g[5] === 0)) {
      if (g[5] === 0 && g[6] === 0 && g[7] <= 1) return true; // :: and ::1
      return isPrivateIp(`${g[6] >> 8}.${g[6] & 255}.${g[7] >> 8}.${g[7] & 255}`);
    }
    if ((g[0] & 0xffc0) === 0xfe80) return true; // link-local fe80::/10
    if ((g[0] & 0xfe00) === 0xfc00) return true; // unique local fc00::/7
    if ((g[0] & 0xff00) === 0xff00) return true; // multicast
    if (g[0] === 0x64 && g[1] === 0xff9b) return true; // NAT64: can reach IPv4 internals
    return false;
  }
  const [a, b] = ip.split(".").map(Number);
  return (
    a === 0 ||
    a === 10 ||
    a === 127 ||
    (a === 100 && b >= 64 && b <= 127) || // CGNAT
    (a === 169 && b === 254) || // link-local / cloud metadata
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168) ||
    a >= 224 // multicast / reserved
  );
}

/**
 * Server-side guard before the app itself calls a user-supplied URL (SSRF protection):
 * https only, and every address the host resolves to must be public.
 * Returns an error message, or null when the URL is acceptable.
 */
export async function checkWebhookUrl(raw: string): Promise<string | null> {
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    return "Enter a valid URL.";
  }
  if (u.protocol !== "https:") return "Webhook URLs must use https.";
  if (u.username || u.password) return "URLs with credentials are not allowed.";
  if (u.hostname === "localhost" || u.hostname.endsWith(".localhost") || u.hostname.endsWith(".internal")) {
    return "Local addresses are not allowed.";
  }
  const host = u.hostname.replace(/^\[|\]$/g, "");
  try {
    const addrs = isIP(host) ? [{ address: host }] : await lookup(host, { all: true });
    if (addrs.length === 0 || addrs.some((a) => isPrivateIp(a.address))) {
      return "That address is not publicly reachable.";
    }
  } catch {
    return "Could not resolve that host.";
  }
  return null;
}

/** Sends a signed `webhook.test` event so users can verify their receiver. */
export async function sendTestEvent(url: string, secret: string) {
  const body = JSON.stringify({
    id: randomUUID(),
    event: "webhook.test",
    created_at: new Date().toISOString(),
    data: { message: "This is a test event from FlowCRM." },
  });
  const timestamp = String(Math.floor(Date.now() / 1000));
  const res = await fetch(url, {
    method: "POST",
    redirect: "manual", // never follow redirects to an unchecked address
    signal: AbortSignal.timeout(5000),
    headers: {
      "Content-Type": "application/json",
      "User-Agent": "FlowCRM-Webhooks/1.0",
      "X-FlowCRM-Event": "webhook.test",
      "X-FlowCRM-Timestamp": timestamp,
      "X-FlowCRM-Signature": signPayload(secret, timestamp, body),
    },
    body,
  });
  return { status: res.status, ok: res.status >= 200 && res.status < 300 };
}
