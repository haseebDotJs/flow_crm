import { llm } from "@livekit/agents";
import { z } from "zod";
import {
  STAGES,
  createFollowUp,
  findContact,
  findOpportunities,
  updateOpportunityStage,
  type CrmContext,
} from "./crm";

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
        "Create a follow-up task for a contact (and optionally one of their opportunities). " +
        "Call this at most once per requested follow-up.",
      parameters: z.object({
        contact_id: z.string().describe("Contact id (UUID) from find_contact"),
        opportunity_id: z.string().nullish().describe("Opportunity id (UUID), when the follow-up relates to one"),
        title: z.string().describe("Short task title, e.g. 'Follow up with John Smith'"),
        due_at: z
          .string()
          .describe(
            "Local date-time in the user's timezone as ISO 8601 WITHOUT offset, e.g. 2026-10-02T10:00:00",
          ),
      }),
      execute: async (args) => {
        const result = await createFollowUp(ctx, args);
        log("create_follow_up", args, result);
        return result;
      },
    }),
  };
}
