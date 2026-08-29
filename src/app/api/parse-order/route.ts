import { NextResponse } from "next/server";
import { GoogleGenerativeAI, SchemaType } from "@google/generative-ai";

// System instructions to guide code-switching extraction and date resolution
const systemInstruction = `
You are an order parser for a micro-enterprise. 

CRITICAL GUIDELINES:
1. Physical Items Only: ONLY extract physical goods or products ordered. NEVER extract conversational filler, questions, or greetings (e.g., 'ho jayega kya?', 'bhaiya', 'chahiye', 'karo', 'kar dena', 'ok', 'yes') as items.
2. Customer Name Validation: Extract the actual human name or identifier of the customer. Do NOT assign conversational filler or terms of address (e.g., 'bhaiya', 'uncle', 'bhai', 'didi', 'madam') to the 'customer' field. If no clear human name is present, set 'customer' to null.
3. Temporal Separation: You must EXCLUDE all relative temporal phrases (e.g. "parso", "kal", "subah", "sham", "tomorrow", "next Tuesday", "2 baje", "10 baje") and prepositions (e.g. "tak", "ko", "se", "at", "by") from the item descriptions. These must be resolved into the 'due_date' field, NOT left inside the item's 'description'.
   - Example: "parso 2 baje 2 kg aaloo" -> items: [{ description: "aaloo", quantity: 2, attributes: { unit: "kg" } }], due_date: (resolve "parso" relative to baseDate).
4. Relative Date Resolution: Resolve all relative date phrases relative to the 'baseDate' provided in the input payload. Format the resolved 'due_date' as an ISO-8601 date string (YYYY-MM-DD).
   - "aaj" / "today" -> baseDate
   - "kal" / "tomorrow" -> baseDate + 1 day
   - "parso" / "day after tomorrow" -> baseDate + 2 days
   - "next [Weekday]" / "agle [Weekday]" -> Find the next calendar date matching that weekday.
   - "[Number] tarikh" -> The [Number]th day of the current or next month.
5. Quantity Normalization: Quantities must be integers. Resolve text-based numbers (e.g., "ek" -> 1, "do" -> 2, "teen" -> 3, "half packet" -> 1 packet).
6. Amount Resolution: Extract currency values (e.g. "Rs 500", "500/-", "₹1200", "1200 rupees") and assign them as a number in the 'amount' field.
7. Prior Order Tracking: Set 'references_prior_order' to true if the text matches repeat requests like "same as last time", "pichla wala", "purana order", "repeat".
8. Flag Ambiguity: Set 'needs_clarification' to true if an item description is logged but lacks a quantity, if there are multiple conflicting temporal details, or if the order is extremely vague.
`;

export async function POST(request: Request) {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    console.error("[Gemini API Crash]: GEMINI_API_KEY is not defined in the server environment variables.");
    return NextResponse.json(
      { error: "GEMINI_API_KEY environment variable is not configured." },
      { status: 500 }
    );
  }

  // Instantiate GenAI client dynamically per request to ensure fresh env loading
  const genAI = new GoogleGenerativeAI(apiKey);

  try {
    const { message, baseDate } = await request.json();
    if (!message) {
      return NextResponse.json({ error: "Message is required" }, { status: 400 });
    }

    // Initialize model targeting gemini-3.6-flash and apiVersion "v1" (since 1.5 and 2.0 are deprecated in 2026)
    const model = genAI.getGenerativeModel({
      model: "gemini-3.6-flash",
      systemInstruction: systemInstruction,
      generationConfig: {
        responseMimeType: "application/json",
        responseSchema: {
          type: SchemaType.OBJECT,
          properties: {
            customer: {
              type: SchemaType.STRING,
              description: "Customer name or identifier if present, or null if unknown.",
            },
            items: {
              type: SchemaType.ARRAY,
              description: "Array of order items extracted.",
              items: {
                type: SchemaType.OBJECT,
                properties: {
                  description: {
                    type: SchemaType.STRING,
                    description: "Item name (e.g. 'aaloo', 'tiffin'). Must not contain time words.",
                  },
                  quantity: {
                    type: SchemaType.INTEGER,
                    description: "Item count.",
                  },
                  attributes: {
                    type: SchemaType.OBJECT,
                    description: "Details like unit ('kg', 'packet', 'piece') or specifications.",
                    properties: {},
                  },
                },
                required: ["description", "quantity", "attributes"],
              },
            },
            due_date: {
              type: SchemaType.STRING,
              description: "Resolved due date in YYYY-MM-DD format, or null.",
            },
            amount: {
              type: SchemaType.NUMBER,
              description: "Total order cost, or null.",
            },
            references_prior_order: {
              type: SchemaType.BOOLEAN,
              description: "True if referencing a prior order.",
            },
            confidence: {
              type: SchemaType.NUMBER,
              description: "Parse confidence score between 0.0 and 1.0.",
            },
            needs_clarification: {
              type: SchemaType.BOOLEAN,
              description: "True if highly ambiguous or incomplete.",
            },
          },
          required: [
            "customer",
            "items",
            "due_date",
            "amount",
            "references_prior_order",
            "confidence",
            "needs_clarification",
          ],
        },
      },
    }, { apiVersion: "v1" });

    const userPrompt = `
Reference baseDate context: ${baseDate || new Date().toISOString()}
Message to parse: "${message}"
`;

    const result = await model.generateContent(userPrompt);
    const responseText = result.response.text();

    if (!responseText) {
      throw new Error("Empty response from Gemini API");
    }

    const parsedJson = JSON.parse(responseText);

    // Normalize potential string "null" / "undefined" hallucinations to actual nulls
    if (parsedJson.customer === "null" || parsedJson.customer === "undefined") {
      parsedJson.customer = null;
    }
    if (parsedJson.due_date === "null" || parsedJson.due_date === "undefined") {
      parsedJson.due_date = null;
    }
    if (parsedJson.amount === "null" || parsedJson.amount === "undefined" || isNaN(Number(parsedJson.amount))) {
      parsedJson.amount = null;
    }

    return NextResponse.json(parsedJson);

  } catch (error: any) {
    console.error("Gemini API Parse Route Error [API Crash Details]:", {
      name: error.name,
      message: error.message,
      stack: error.stack,
      cause: error.cause
    });
    return NextResponse.json(
      { error: error.message || "Failed parsing order via Gemini API" },
      { status: 500 }
    );
  }
}
