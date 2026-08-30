import { NextResponse } from "next/server";
import { GoogleGenerativeAI, SchemaType } from "@google/generative-ai";
import { parseOrderHeuristic } from "@/lib/nlpParser";

// System instructions to guide multi-domain code-switching extraction, unlabeled attributes, and temporal resolution
const systemInstruction = `
You are an expert order parser for micro-enterprises (tailors, bakers, electricians/technicians, tiffin/grocers).

CRITICAL GUIDELINES:
1. Physical Items & Services Only:
   - Extract products, garments, baked goods, or service tasks.
   - Clean the 'description' to only be the core item/service name (e.g. 'kurta', 'chocolate truffle cake', 'ceiling fan fitting', 'aaloo', 'tiffin').
   - NEVER include conversational filler, greetings, or questions (e.g., 'ho jayega kya?', 'bhaiya', 'chahiye', 'karo', 'kar dena', 'ok', 'deliver') in the description.

2. Attribute Extraction Without Labels:
   - Extract specifications, measurements, colors, flavors, and units into the 'attributes' key-value object.
   - Tailoring: Extract color, chest size, waist, length (e.g., "navy blue, chest 40" -> attributes: { "color": "navy blue", "chest": "40" }).
   - Baking: Extract weight, flavor, dietary preferences (e.g., "1 kg chocolate truffle eggless" -> attributes: { "weight": "1 kg", "flavor": "chocolate truffle", "type": "eggless" }).
   - Groceries / Food: Extract unit and packaging (e.g., "2 kg aaloo" -> attributes: { "unit": "kg" }, "3 plate momos" -> attributes: { "unit": "plate" }).
   - Services: Extract task type or room if present (e.g., "switchboard repair" -> attributes: { "service_type": "repair" }).

3. Customer Name vs. Terms of Address:
   - Extract ONLY the actual customer name (e.g., "Pooja", "Ravi", "Amit").
   - NEVER assign greetings, titles, or recipient terms of address (e.g., "Sharma ji", "Bhaiya", "Uncle", "Bhai", "Didi", "Sir", "Madam") to 'customer'.
   - If no distinct customer human name is present, set 'customer' to null.

4. Temporal Resolution to ISO-8601 (YYYY-MM-DD):
   - Relative to the provided 'baseDate', resolve:
     * "aaj" / "today" -> baseDate
     * "kal" / "tomorrow" -> baseDate + 1 day
     * "parso" / "day after tomorrow" -> baseDate + 2 days
     * "is weekend" / "this weekend" / "weekend" -> The upcoming Saturday/Sunday of the current week
     * "agle [Weekday]" / "next [Weekday]" -> The next calendar date matching that weekday
     * "agle hafte" / "next week" -> baseDate + 7 days
     * "[Number] tarikh" -> The [Number]th day of current or next month
   - Exclude all time words ("subah", "sham", "10 baje", "tak", "ko") from item descriptions.
   - If no date/deadline is mentioned, set 'due_date' to null.
   - Conflicting/Concessive Dates: If the message states a primary deadline AND a fallback concession (e.g. "kal sham chahiye lekin mangalwar tak ho to bhi theek hai"), resolve 'due_date' to the PRIMARY (most urgent/first-stated) date, and set 'needs_clarification' to true because a concession window exists.

5. Quantity Normalization:
   - Quantities must be positive integers. Resolve words (e.g. "ek" -> 1, "do" -> 2, "teen" -> 3, "half" -> 1).

6. Amount Resolution vs. Unspecified Price:
   - Extract numerical currency value ONLY if explicitly stated as paid, due, or total (e.g., "Rs 500", "750/-", "₹1200", "1200 rupees").
   - Compound/Itemized Prices: If multiple item-level prices are given for DIFFERENT items in the SAME order (e.g. "1st wale ka 850, dusre ka 900"), SUM them into a single total 'amount' (e.g. 850 + 900 = 1750). Do not just take the first number.
   - If a listed item explicitly has no price yet ("rate baad mein", "price batayenge baad mein"), that is fine — sum whatever prices ARE given, and set 'needs_clarification' to true because part of the order is unpriced.
   - If the message asks a price question (e.g. "Kitna lagega?", "Kitna hua?") or mentions no price, 'amount' MUST BE null (NEVER 0, NEVER 1).

7. Prior Order Tracking:
   - Set 'references_prior_order' to true if text matches repeat patterns like "same as last time", "last time jaisa hi", "purana order", "repeat", "pichla wala", "purana wala address".

8. Ambiguity & Clarification:
   - Set 'needs_clarification' to true if the message is too vague to know what is being ordered, lacks items, or has conflicting details. Set confidence < 0.5.
   - For clear orders, set 'needs_clarification' to false and confidence between 0.85 and 1.0.

9. Multi-Variant Decomposition:
   - When an order specifies multiple variants of a product (e.g. "2 kurta: ek navy blue, doosra maroon, chest 40 dono ka, full sleeve"), emit separate items of quantity 1 for each variant and distribute shared attributes (e.g. chest: "40", sleeve: "full sleeve") to ALL variants — not just the nearest one in the text.

10. Free-Form Attributes:
   - The attributes list accepts ANY relevant key (color, chest, sleeve, size, weight, flavor, type, service, etc.) — it is not limited to a fixed set. Capture every stated specification rather than dropping it.

11. Distinct Service Line Items:
   - A tailoring/service request bundled in the same message (e.g. "3 kapda silai ke liye") is its own item with its own quantity and a 'service' attribute — do not merge it into a physical-goods item.

FEW-SHOT EXAMPLES:
- Input: "bhaiya 2 kurta chahiye navy blue, chest 40, parso tak ho jayega kya? last time jaisa hi"
  Output: { "customer": null, "items": [{ "description": "kurta", "quantity": 2, "attributes": { "color": "navy blue", "chest": "40" } }], "due_date": "2026-08-31", "amount": null, "references_prior_order": true, "confidence": 0.95, "needs_clarification": false }

- Input: "1 kg chocolate truffle cake eggless chahiye is weekend tak. 750 rs online bhej diya. - Pooja"
  Output: { "customer": "Pooja", "items": [{ "description": "chocolate truffle cake", "quantity": 1, "attributes": { "weight": "1 kg", "flavor": "chocolate truffle", "type": "eggless" } }], "due_date": "2026-08-30", "amount": 750, "references_prior_order": false, "confidence": 0.95, "needs_clarification": false }

- Input: "Sharma ji, agle mangalwar ko 3 ceiling fan fitting aur 1 switchboard repair karwana hai. Kitna lagega?"
  Output: { "customer": null, "items": [{ "description": "ceiling fan fitting", "quantity": 3, "attributes": { "service": "fitting" } }, { "description": "switchboard repair", "quantity": 1, "attributes": { "service": "repair" } }], "due_date": "2026-09-01", "amount": null, "references_prior_order": false, "confidence": 0.95, "needs_clarification": false }

- Input: "Bhaiya urgent kaam hai thoda saman deliver kar dena."
  Output: { "customer": null, "items": [], "due_date": null, "amount": null, "references_prior_order": false, "confidence": 0.2, "needs_clarification": true }

- Input: "Ravi bhai, pichli baar wala same kurta phir se, 2 chahiye, ek navy blue aur doosra maroon, chest 40 dono ka, full sleeve. 1st wale ka 850, dusre ka 900/-, rate baad mein bata denge silai ke liye."
  Output: { "customer": "Ravi", "items": [{ "description": "kurta", "quantity": 1, "attributes": { "color": "navy blue", "chest": "40", "sleeve": "full sleeve" } }, { "description": "kurta", "quantity": 1, "attributes": { "color": "maroon", "chest": "40", "sleeve": "full sleeve" } }, { "description": "kapda silai", "quantity": 1, "attributes": { "service": "stitching" } }], "due_date": null, "amount": 1750, "references_prior_order": true, "confidence": 0.6, "needs_clarification": true }
`;

export async function POST(request: Request) {
  let message = "";
  let baseDate: string | undefined;

  try {
    const body = await request.json();
    message = body.message || "";
    baseDate = body.baseDate;
  } catch {
    return NextResponse.json({ error: "Invalid JSON request payload" }, { status: 400 });
  }

  if (!message) {
    return NextResponse.json({ error: "Message is required" }, { status: 400 });
  }

  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    console.warn("[Gemini API Warning]: GEMINI_API_KEY not found. Routing to local deterministic heuristic parser.");
    const fallback = parseOrderHeuristic(message, baseDate ? new Date(baseDate) : new Date());
    return NextResponse.json({
      ...fallback,
      confidence: Math.max(0.1, fallback.confidence - 0.1)
    });
  }

  // Instantiate GenAI client dynamically per request to ensure fresh env loading
  const genAI = new GoogleGenerativeAI(apiKey);

  try {

    const modelName = "gemini-3.6-flash";
    const model = genAI.getGenerativeModel({
      model: modelName,
      systemInstruction: systemInstruction,
      generationConfig: {
        temperature: 0.0,
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
                    description: "Item/service name (e.g. 'kurta', 'tiffin', 'cake', 'kapda silai'). Must not contain time words.",
                  },
                  quantity: {
                    type: SchemaType.INTEGER,
                    description: "Item count.",
                  },
                  attributes: {
                    type: SchemaType.ARRAY,
                    description: "List of all attributes, measurements, and specifications (e.g. chest, waist, size, length, sleeve, color, unit, weight, flavor, type, service).",
                    items: {
                      type: SchemaType.OBJECT,
                      properties: {
                        key: { type: SchemaType.STRING, description: "Attribute key name (e.g. chest, waist, size, length, sleeve, color, unit, weight, flavor, type, service)" },
                        value: { type: SchemaType.STRING, description: "Attribute value (e.g. 40, 32, XL, full sleeve, navy blue, 1 kg, eggless)" },
                      },
                      required: ["key", "value"],
                    },
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
              description: "Total order cost as a positive number, or null if unpriced.",
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
              description: "True if highly ambiguous, incomplete, or missing item details.",
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

    // Normalize potential string "null" / ":null" / "undefined" hallucinations to actual nulls
    if (
      parsedJson.customer === "null" ||
      parsedJson.customer === ":null" ||
      parsedJson.customer === "undefined" ||
      parsedJson.customer === "items" ||
      parsedJson.customer === "null null"
    ) {
      parsedJson.customer = null;
    } else if (parsedJson.customer) {
      const lowerCust = parsedJson.customer.toLowerCase().trim();
      const addressTerms = ["sharma ji", "sharmaji", "bhaiya", "bhai", "uncle", "didi", "sir", "madam", "ji", "aunty"];
      if (addressTerms.some(term => lowerCust === term || lowerCust === `${term}.`)) {
        parsedJson.customer = null;
      }
    }

    if (
      parsedJson.due_date === "null" ||
      parsedJson.due_date === ":null" ||
      parsedJson.due_date === "undefined" ||
      parsedJson.due_date === "amount" ||
      !parsedJson.due_date ||
      !/^\d{4}-\d{2}-\d{2}/.test(parsedJson.due_date)
    ) {
      parsedJson.due_date = parsedJson.due_date && /^\d{4}-\d{2}-\d{2}/.test(parsedJson.due_date) ? parsedJson.due_date : null;
    }

    // Clean amount: support both prefix ("Rs 150", "₹1200") and suffix ("150 rs", "600/-")
    // Sum ALL price mentions in the message (handles compound/itemized prices like "850 ... 900/-")
    const priceRegexes = [
      /(?:rs\.?|₹|inr)\s*(\d+(?:\.\d+)?)/gi,
      /(\d+(?:\.\d+)?)\s*(?:rs\.?|rupees|inr|\/\-)/gi
    ];
    const foundPrices: number[] = [];
    for (const regex of priceRegexes) {
      let m;
      while ((m = regex.exec(message)) !== null) {
        const val = parseFloat(m[1]);
        if (!isNaN(val)) foundPrices.push(val);
      }
    }
    const uniquePrices = Array.from(new Set(foundPrices));

    if (uniquePrices.length === 0) {
      parsedJson.amount = null;
    } else if (uniquePrices.length === 1) {
      parsedJson.amount = parsedJson.amount && !isNaN(Number(parsedJson.amount))
        ? Number(parsedJson.amount)
        : uniquePrices[0];
    } else {
      // Multiple distinct prices found — prefer Gemini's own summed 'amount' if it plausibly
      // matches the sum of found prices; otherwise sum them ourselves as a safe fallback.
      const sum = uniquePrices.reduce((a, b) => a + b, 0);
      const geminiAmount = Number(parsedJson.amount);
      parsedJson.amount = !isNaN(geminiAmount) && geminiAmount >= Math.max(...uniquePrices)
        ? geminiAmount
        : sum;
    }

    // Ensure items and attributes are sanitized
    if (Array.isArray(parsedJson.items)) {
      // Only apply message-wide regex attribute recovery when there's exactly ONE item.
      // With multiple items/variants, a global regex match (e.g. first color found) would
      // get copied onto every item, silently corrupting variants that differ from each other.
      const singleItemOrder = parsedJson.items.length === 1;

      parsedJson.items = parsedJson.items.map((item: any) => {
        const cleanAttributes: Record<string, any> = {};

        if (Array.isArray(item.attributes)) {
          for (const pair of item.attributes) {
            if (pair && pair.key && pair.value) {
              const k = String(pair.key).toLowerCase().trim();
              const v = String(pair.value).trim();
              if (v && v !== "null" && v !== ":null" && v !== "undefined") {
                cleanAttributes[k] = v.length > 30 ? v.split(/[\s,]/)[0] : v;
              }
            }
          }
        } else if (typeof item.attributes === "object" && item.attributes !== null) {
          for (const [k, v] of Object.entries(item.attributes)) {
            if (v !== null && v !== "null" && v !== "" && v !== undefined && v !== ":null" && v !== "undefined") {
              const strVal = String(v).trim();
              cleanAttributes[k.toLowerCase().trim()] = strVal.length > 30 ? strVal.split(/[\s,]/)[0] : strVal;
            }
          }
        }

        // Universal deterministic contextual attribute recovery pass
        // (only safe to run when the whole message maps to a single item — see guard above,
        // otherwise a single global match gets incorrectly copied onto every variant)
        if (singleItemOrder) {
          const chestMatch = message.match(/\bchest\s*[:=-]?\s*(\d{2})\b/i);
          if (chestMatch && !cleanAttributes.chest) {
            cleanAttributes.chest = chestMatch[1];
          }
          const waistMatch = message.match(/\bwaist\s*[:=-]?\s*(\d{2})\b/i);
          if (waistMatch && !cleanAttributes.waist) {
            cleanAttributes.waist = waistMatch[1];
          }
          const sizeMatch = message.match(/\bsize\s*[:=-]?\s*(\d{1,2}|[a-zA-Z]+)\b/i);
          if (sizeMatch && !cleanAttributes.size) {
            cleanAttributes.size = sizeMatch[1];
          }
          const sleeveMatch = message.match(/\b(full\s*sleeve|half\s*sleeve|sleeveless)\b/i);
          if (sleeveMatch && !cleanAttributes.sleeve) {
            cleanAttributes.sleeve = sleeveMatch[1].toLowerCase();
          }
          const colorMatch = message.match(/\b(navy\s*blue|maroon|sky\s*blue|dark\s*blue|black|white|red|blue|green|yellow|pink|orange)\b/i);
          if (colorMatch && !cleanAttributes.color) {
            cleanAttributes.color = colorMatch[1].toLowerCase();
          }
          const weightMatch = message.match(/\b(\d+(?:\.\d+)?\s*(?:kg|kilo|gm|gram|pound))\b/i);
          if (weightMatch && (!cleanAttributes.weight || cleanAttributes.weight.length > 20)) {
            cleanAttributes.weight = weightMatch[1].toLowerCase();
          }
          const egglessMatch = message.match(/\b(eggless|sugar\s*free|with\s*egg)\b/i);
          if (egglessMatch && !cleanAttributes.type) {
            cleanAttributes.type = egglessMatch[1].toLowerCase();
          }
        }

        return {
          description: String(item.description || "").trim(),
          quantity: Math.max(1, Math.round(Number(item.quantity) || 1)),
          attributes: cleanAttributes,
        };
      });
    } else {
      parsedJson.items = [];
    }

    return NextResponse.json(parsedJson);
  } catch (error: any) {
    console.error("Gemini API Parse Route Error (Rate limit, quota, or network):", {
      name: error.name,
      message: error.message,
    });

    // Server-side fallback to deterministic heuristic parser if Gemini API fails or is rate-limited
    try {
      const fallbackResult = parseOrderHeuristic(message, baseDate ? new Date(baseDate) : new Date());
      return NextResponse.json({
        ...fallbackResult,
        confidence: Math.max(0.1, fallbackResult.confidence - 0.1),
      });
    } catch {
      return NextResponse.json(
        { error: error.message || "Failed parsing order via Gemini API" },
        { status: 500 }
      );
    }
  }
}