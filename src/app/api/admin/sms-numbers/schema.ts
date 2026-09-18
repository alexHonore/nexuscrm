import { z } from "zod";

export const createNumberSchema = z.object({
  e164: z.string().trim().min(3),
  label: z.string().trim().max(80).nullable().default(null),
  messagingServiceSid: z.string().trim().max(64).default(""),
  dailyCap: z.number().int().min(1).max(10_000).default(200),
  active: z.boolean().default(true),
  defaultAssistantId: z.uuid().nullable().default(null),
});
