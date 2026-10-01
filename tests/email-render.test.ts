/**
 * The browser preview renderer must match the database renderer exactly.
 * Usage: npm run test:email-render
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { config } from "dotenv";
import { createClient } from "@supabase/supabase-js";
import { renderTemplate } from "../lib/email-template";

config({ path: ".env.local", quiet: true });

const admin = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SECRET_KEY!, {
  auth: { persistSession: false, autoRefreshToken: false },
});

const CASES: [string, Record<string, string>][] = [
  ["Hi {{first_name}}, welcome to {{company}}", { first_name: "Ada", company: "Analytical Engines" }],
  ["Spaces {{ first_name }} and {{   company}}", { first_name: "Ada", company: "AE" }],
  ["Unknown {{nope}} and {{ also_unknown }} removed", { first_name: "Ada" }],
  ["No placeholders at all.", { first_name: "Ada" }],
  ["Injection {{company}}", { company: "{{first_name}}", first_name: "Ada" }],
  ["Multi\nline {{first_name}}\n\nSigned, {{sender_name}}", { first_name: "Ada", sender_name: "Bob" }],
  ["Braces { not a var } and {{first_name}}", { first_name: "Ada" }],
  ["Case matters {{First_Name}} {{first_name}}", { first_name: "Ada" }],
  ["Special $1 \\1 & <b>{{company}}</b>", { company: "R&D \\1 $&" }],
];

describe("client preview == database renderer", () => {
  for (const [text, vars] of CASES) {
    it(JSON.stringify(text).slice(0, 60), async () => {
      const { data, error } = await admin.rpc("render_email_template", { p_text: text, p_vars: vars });
      assert.equal(error, null);
      assert.equal(renderTemplate(text, vars), data);
    });
  }
});
