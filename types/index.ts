export const STAGES = ["new", "qualified", "proposal", "negotiation", "won", "lost"] as const;
export type Stage = (typeof STAGES)[number];

export const TASK_STATUSES = ["pending", "completed", "cancelled"] as const;
export type TaskStatus = (typeof TASK_STATUSES)[number];

export const STAGE_LABELS: Record<Stage, string> = {
  new: "New",
  qualified: "Qualified",
  proposal: "Proposal",
  negotiation: "Negotiation",
  won: "Won",
  lost: "Lost",
};

export interface Contact {
  id: string;
  user_id: string;
  name: string;
  email: string | null;
  phone: string | null;
  company: string | null;
  notes: string | null;
  created_at: string;
  updated_at: string;
}

export interface Opportunity {
  id: string;
  user_id: string;
  contact_id: string;
  title: string;
  value: number;
  stage: Stage;
  notes: string | null;
  created_at: string;
  updated_at: string;
  contacts?: Pick<Contact, "id" | "name" | "company"> | null;
}

export interface Task {
  id: string;
  user_id: string;
  contact_id: string | null;
  opportunity_id: string | null;
  title: string;
  description: string | null;
  due_at: string | null;
  status: TaskStatus;
  source?: "manual" | "automation";
  auto_email?: boolean;
  email_template_id?: string | null;
  email_status?: EmailStatus;
  email_error?: string | null;
  email_sent_at?: string | null;
  created_at: string;
  updated_at: string;
  contacts?: Pick<Contact, "id" | "name" | "email"> | null;
  opportunities?: Pick<Opportunity, "id" | "title"> | null;
  email_templates?: Pick<EmailTemplate, "id" | "name"> | null;
}

export type EmailStatus = "none" | "queued" | "sent" | "failed";

export interface EmailTemplate {
  id: string;
  user_id: string;
  name: string;
  subject: string;
  body: string;
  created_at: string;
  updated_at: string;
}

export interface EmailLogEntry {
  id: string;
  task_id: string | null;
  to_email: string;
  intended_email: string | null;
  subject: string;
  test_mode: boolean;
  status: "queued" | "sent" | "failed";
  error: string | null;
  created_at: string;
  sent_at: string | null;
}

export type Role = "admin" | "member";

export type ActivityActor = "user" | "voice" | "automation" | "webhook";

export interface ActivityEntry {
  id: string;
  user_id: string;
  entity_type: "contact" | "opportunity" | "task";
  entity_id: string;
  action: string;
  summary: string;
  actor: ActivityActor;
  metadata: Record<string, unknown>;
  created_at: string;
}
