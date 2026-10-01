/**
 * Template variables and a client-side renderer used ONLY for the live preview.
 * The real rendering happens in the database (render_email_template); tests keep both in sync.
 */
export const TEMPLATE_VARIABLES = [
  { key: "first_name", label: "First name", sample: "John" },
  { key: "contact_name", label: "Contact name", sample: "John Smith" },
  { key: "company", label: "Company", sample: "Acme Inc." },
  { key: "opportunity_title", label: "Opportunity", sample: "Acme Enterprise License" },
  { key: "sender_name", label: "Your name", sample: "Alex Morgan" },
] as const;

const OPEN = "\u0001";
const CLOSE = "\u0002";

/** Single pass: values are never re-scanned for placeholders; unknown variables become empty. */
export function renderTemplate(text: string, vars: Record<string, string>): string {
  let r = text.replaceAll(OPEN, "").replaceAll(CLOSE, "");
  r = r.replace(/\{\{\s*([a-z_]+)\s*\}\}/g, `${OPEN}$1${CLOSE}`);
  for (const [k, v] of Object.entries(vars)) {
    const value = v.replaceAll(OPEN, "").replaceAll(CLOSE, "");
    // A function replacer keeps "$&", "$1" etc. in values literal.
    r = r.replaceAll(`${OPEN}${k}${CLOSE}`, () => value);
  }
  return r.replace(new RegExp(`${OPEN}[a-z_]*${CLOSE}`, "g"), "");
}

export function sampleVars(): Record<string, string> {
  return Object.fromEntries(TEMPLATE_VARIABLES.map((v) => [v.key, v.sample]));
}
