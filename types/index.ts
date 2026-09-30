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
  created_at: string;
  updated_at: string;
  contacts?: Pick<Contact, "id" | "name"> | null;
  opportunities?: Pick<Opportunity, "id" | "title"> | null;
}
