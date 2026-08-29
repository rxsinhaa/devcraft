import { z } from "zod";

/**
 * Item schema parsed from an order
 */
export const OrderItemSchema = z.object({
  description: z.string().describe("Description of the item ordered"),
  quantity: z.number().int().describe("Integer quantity of the item"),
  attributes: z.record(z.string(), z.any()).describe("Dynamic attributes of the item (e.g. size, unit, color)"),
});

/**
 * Zod Schema for the parsed Order Record
 */
export const OrderRecordSchema = z.object({
  customer: z.string().nullable().describe("Name/identifier of the customer, or null if unknown"),
  items: z.array(OrderItemSchema).describe("List of items ordered"),
  due_date: z
    .string()
    .nullable()
    .refine(
      (val) => {
        if (val === null) return true;
        // Basic ISO-8601 date validation (YYYY-MM-DD, or full YYYY-MM-DDTHH:mm:ss.sssZ, etc.)
        const parsed = Date.parse(val);
        return !isNaN(parsed) && /^\d{4}-\d{2}-\d{2}(T\d{2}:\d{2}:\d{2}(\.\d{3})?(Z|[+-]\d{2}(:\d{2})?)?)?$/.test(val);
      },
      { message: "Invalid ISO-8601 date format" }
    )
    .describe("ISO-8601 date string or null"),
  amount: z.number().nullable().describe("Total amount or value of the order, or null"),
  references_prior_order: z.boolean().describe("Whether this order refers to a prior conversation/order"),
  confidence: z.number().min(0).max(1).describe("Confidence score of the parse between 0 and 1"),
  needs_clarification: z.boolean().describe("Whether the raw message needs manual clarification"),
});

export type OrderItem = z.infer<typeof OrderItemSchema>;
export type OrderRecord = z.infer<typeof OrderRecordSchema>;
