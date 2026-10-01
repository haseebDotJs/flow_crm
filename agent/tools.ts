import { llm } from "@livekit/agents";
import { z } from "zod";
import {
  STAGES,
  cancelFollowUp,
  createFollowUp,
  findContact,
  findFollowUps,
  findOpportunities,
  rescheduleFollowUp,
  updateOpportunityStage,
  type CrmContext,
} from "./crm";

const TIME_SOURCE = z
  .enum(["user_stated", "not_specified"])
  .describe(
    "user_stated ONLY if the user actually said a time (e.g. '10 AM', 'morning', 'afternoon') or agreed to a time " +
      "you suggested. If the user gave only a day (e.g. 'tomorrow'), use not_specified: the tool will refuse and you " +
      "must ask them for a time. Never choose a time yourself.",
  );

/**
 * The ONLY capabilities the model gets. Each wraps a validated CRM operation that is bound
 * to the authenticated user; there is no generic database/SQL tool.
 */
export function buildCrmTools(ctx: CrmContext) {
  const log = (name: string, args: unknown, result: unknown) =>
    console.log(`[tool] ${name}`, JSON.stringify(args), "->", JSON.stringify(result));

  return {
    find_contact: llm.tool({
      description:
        "Search the user's CRM contacts by name (optionally narrowed by email or company). " +
        "Returns status not_found, found (one match) or multiple (ask the user to clarify).",
      parameters: z.object({
        name: z.string().describe("Contact name as spoken by the user, e.g. 'John Smith'"),
        email: z.string().nullish().describe("Optional email to narrow the search"),
        company: z.string().nullish().describe("Optional company to narrow the search"),
      }),
      execute: async (args) => {
        const result = await findContact(ctx, args);
        log("find_contact", args, result);
        return result;
      },
    }),

    find_opportunities: llm.tool({
      description:
        "List a contact's opportunities using the contact_id returned by find_contact. " +
        "Optionally filter by current stage.",
      parameters: z.object({
        contact_id: z.string().describe("Contact id (UUID) from find_contact"),
        stage: z.enum(STAGES).nullish().describe("Optional current-stage filter"),
      }),
      execute: async (args) => {
        const result = await findOpportunities(ctx, args);
        log("find_opportunities", args, result);
        return result;
      },
    }),

    update_opportunity_stage: llm.tool({
      description:
        "Move one opportunity to a new pipeline stage. Use the opportunity id from find_opportunities.",
      parameters: z.object({
        opportunity_id: z.string().describe("Opportunity id (UUID) from find_opportunities"),
        stage: z.enum(STAGES).describe("Target stage"),
      }),
      execute: async (args) => {
        const result = await updateOpportunityStage(ctx, args);
        log("update_opportunity_stage", args, result);
        return result;
      },
    }),

    create_follow_up: llm.tool({
      description:
        "Create a NEW follow-up task for a contact (and optionally one of their opportunities). " +
        "Requires a time the user chose. If the deal already has a pending follow-up the tool refuses; " +
        "to change an existing follow-up use reschedule_follow_up instead. Call at most once per request.",
      parameters: z.object({
        contact_id: z.string().describe("Contact id (UUID) from find_contact"),
        opportunity_id: z.string().nullish().describe("Opportunity id (UUID), when the follow-up relates to one"),
        title: z.string().describe("Short task title, e.g. 'Follow up with John Smith'"),
        due_at: z
          .string()
          .describe(
            "Local date-time in the user's timezone as ISO 8601 WITHOUT offset, e.g. 2026-10-02T10:00:00. " +
              "If the user gave no time, pass the date only (2026-10-02) with time_source not_specified.",
          ),
        time_source: TIME_SOURCE,
        add_another: z
          .boolean()
          .nullish()
          .describe("true ONLY when the user explicitly wants an additional follow-up next to an existing one"),
      }),
      execute: async (args) => {
        const result = await createFollowUp(ctx, args);
        log("create_follow_up", args, result);
        return result;
      },
    }),

    find_follow_ups: llm.tool({
      description:
        "List pending follow-up tasks for a contact and/or opportunity. Use it before changing or " +
        "cancelling a follow-up, and whenever the user asks what follow-ups exist.",
      parameters: z.object({
        contact_id: z.string().nullish().describe("Contact id (UUID) from find_contact"),
        opportunity_id: z.string().nullish().describe("Opportunity id (UUID) from find_opportunities"),
      }),
      execute: async (args) => {
        const result = await findFollowUps(ctx, args);
        log("find_follow_ups", args, result);
        return result;
      },
    }),

    reschedule_follow_up: llm.tool({
      description:
        "Change the date/time of an existing pending follow-up (use the id from find_follow_ups). " +
        "Use this whenever the user wants to move or change a follow-up; never create a duplicate instead.",
      parameters: z.object({
        task_id: z.string().describe("Follow-up id (UUID) from find_follow_ups"),
        due_at: z.string().describe("New local date-time, ISO 8601 WITHOUT offset, e.g. 2026-10-02T21:00:00"),
        time_source: TIME_SOURCE,
      }),
      execute: async (args) => {
        const result = await rescheduleFollowUp(ctx, args);
        log("reschedule_follow_up", args, result);
        return result;
      },
    }),

    cancel_follow_up: llm.tool({
      description:
        "Cancel (remove) a pending follow-up (use the id from find_follow_ups). Use when the user asks to " +
        "delete, remove or cancel a follow-up. It is cancelled, not erased, and can be seen in the Tasks page.",
      parameters: z.object({
        task_id: z.string().describe("Follow-up id (UUID) from find_follow_ups"),
      }),
      execute: async (args) => {
        const result = await cancelFollowUp(ctx, args);
        log("cancel_follow_up", args, result);
        return result;
      },
    }),
  };
}
