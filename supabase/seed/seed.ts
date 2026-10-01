/**
 * Seeds a demo user plus CRM data. Idempotent: re-running resets the demo user's data.
 * Usage: npm run seed   (requires NEXT_PUBLIC_SUPABASE_URL and SUPABASE_SECRET_KEY in .env.local)
 *
 * The secret key bypasses RLS. It is used ONLY here, never by the web app or the agent.
 */
import { config } from "dotenv";
import { createClient } from "@supabase/supabase-js";

config({ path: ".env.local" });

// Demo credentials for local/demo use only.
export const DEMO_EMAIL = "demo@flowcrm.test";
export const DEMO_PASSWORD = "FlowCRM-demo-2026";

const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
const secret = process.env.SUPABASE_SECRET_KEY;
if (!url || !secret) {
  console.error("Missing NEXT_PUBLIC_SUPABASE_URL or SUPABASE_SECRET_KEY in .env.local");
  process.exit(1);
}

const admin = createClient(url, secret, { auth: { persistSession: false, autoRefreshToken: false } });

async function getOrCreateDemoUser(): Promise<string> {
  const { data, error } = await admin.auth.admin.createUser({
    email: DEMO_EMAIL,
    password: DEMO_PASSWORD,
    email_confirm: true,
    user_metadata: { full_name: "Demo User" },
  });
  if (data?.user) return data.user.id;

  // Already exists: find it and reset the password so the documented login works.
  if (error && /already|registered|exists/i.test(error.message)) {
    for (let page = 1; page < 20; page++) {
      const list = await admin.auth.admin.listUsers({ page, perPage: 100 });
      if (list.error) throw list.error;
      const found = list.data.users.find((u) => u.email === DEMO_EMAIL);
      if (found) {
        await admin.auth.admin.updateUserById(found.id, { password: DEMO_PASSWORD, email_confirm: true });
        return found.id;
      }
      if (list.data.users.length < 100) break;
    }
  }
  throw error ?? new Error("Could not create demo user");
}

function at(daysFromNow: number, hour: number) {
  const d = new Date();
  d.setDate(d.getDate() + daysFromNow);
  d.setHours(hour, 0, 0, 0);
  return d.toISOString();
}

async function must<T>(p: PromiseLike<{ data: T; error: { message: string } | null }>) {
  const { data, error } = await p;
  if (error) throw new Error(error.message);
  return data;
}

async function main() {
  const userId = await getOrCreateDemoUser();

  // Reset demo data (opportunities/tasks cascade from contacts).
  await must(admin.from("tasks").delete().eq("user_id", userId));
  await must(admin.from("contacts").delete().eq("user_id", userId));

  const contacts = await must(
    admin
      .from("contacts")
      .insert(
        [
          { name: "John Smith", company: "Acme Inc.", email: "john@acme.com", phone: "+1 555 0101" },
          { name: "Sarah Williams", company: "Globex", email: "sarah@globex.com", phone: "+1 555 0102" },
          { name: "Mike Johnson", company: "Stark Industries", email: "mike@stark.com", phone: "+1 555 0103" },
          { name: "Emily Davis", company: "Northstar", email: "emily@northstar.com", phone: "+1 555 0104" },
        ].map((c) => ({ ...c, user_id: userId })),
      )
      .select("id, name"),
  );
  const id = (name: string) => contacts!.find((c) => c.name === name)!.id;

  const opps = await must(
    admin
      .from("opportunities")
      .insert(
        [
          { title: "Acme Enterprise License", contact_id: id("John Smith"), value: 25000, stage: "new" },
          { title: "Globex Expansion", contact_id: id("Sarah Williams"), value: 40000, stage: "qualified" },
          { title: "Stark Platform Contract", contact_id: id("Mike Johnson"), value: 15000, stage: "proposal" },
          { title: "Northstar Renewal", contact_id: id("Emily Davis"), value: 30000, stage: "negotiation" },
        ].map((o) => ({ ...o, user_id: userId })),
      )
      .select("id, title"),
  );
  const oppId = (title: string) => opps!.find((o) => o.title === title)!.id;

  await must(
    admin.from("tasks").insert(
      [
        {
          title: "Send pricing deck to Sarah",
          contact_id: id("Sarah Williams"),
          opportunity_id: oppId("Globex Expansion"),
          due_at: at(1, 14),
        },
        {
          title: "Review proposal with Mike",
          contact_id: id("Mike Johnson"),
          opportunity_id: oppId("Stark Platform Contract"),
          due_at: at(0, 17),
        },
        {
          title: "Renewal contract call with Emily",
          contact_id: id("Emily Davis"),
          opportunity_id: oppId("Northstar Renewal"),
          due_at: at(5, 11),
        },
        {
          title: "Overdue: confirm Emily's billing contact",
          contact_id: id("Emily Davis"),
          opportunity_id: oppId("Northstar Renewal"),
          due_at: at(-1, 9),
        },
      ].map((t) => ({ ...t, user_id: userId })),
    ),
  );

  // Demo user is an admin; start with an empty activity log (seeding itself isn't user activity).
  await must(admin.from("profiles").update({ role: "admin" }).eq("id", userId));
  await must(admin.from("activity_log").delete().eq("user_id", userId));
  // Reset integrations so the demo starts without a webhook or API keys.
  await must(admin.from("webhook_deliveries").delete().eq("user_id", userId));
  await must(admin.from("webhook_endpoints").delete().eq("user_id", userId));
  await must(admin.from("api_keys").delete().eq("user_id", userId));

  console.log(`Seeded demo data for ${DEMO_EMAIL} (password in supabase/seed/seed.ts).`);
}

main().catch((e) => {
  console.error("Seed failed:", e.message ?? e);
  process.exit(1);
});
