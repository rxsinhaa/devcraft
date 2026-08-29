import { OrderRecord, OrderRecordSchema } from "@/schema";
import { parseOrderHeuristic } from "./nlpParser";

/**
 * Parses an incoming order message using a hybrid pipeline.
 * Attempts to hit the online LLM API first if network is available.
 * Instantly falls back to the local regex/heuristics parser if offline,
 * if the request times out (5 seconds), or if the API returns an error/invalid structure.
 * 
 * @param rawText The raw unstructured message from the customer
 * @param baseDate The reference date for relative temporal parsing (defaults to now)
 */
export async function parseMessage(rawText: string, baseDate: Date = new Date()): Promise<OrderRecord> {
  // 1. Instantly check local offline status
  if (typeof navigator !== "undefined" && !navigator.onLine) {
    console.warn("Device is offline. Bypassing LLM API and routing directly to heuristic fallback parser.");
    return parseOrderHeuristic(rawText, baseDate);
  }

  // 2. Setup request timeout (15s) using AbortController
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), 15000);

  try {
    const response = await fetch("/api/parse-order", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ 
        message: rawText, 
        baseDate: baseDate.toISOString() 
      }),
      signal: controller.signal,
    });

    clearTimeout(timeoutId);

    if (!response.ok) {
      throw new Error(`LLM API returned unsuccessful status code: ${response.status}`);
    }

    const data = await response.json();
    
    // 3. Strict schema validation to catch structural hallucinations
    const validatedData = OrderRecordSchema.parse(data);
    return validatedData;

  } catch (error: any) {
    clearTimeout(timeoutId);
    
    const isTimeout = error.name === "AbortError";
    console.error("Hybrid Router [API Path Error Details]:", {
      name: error.name,
      message: error.message,
      stack: error.stack,
      isTimeout
    });
    
    console.error(
      `Hybrid Router: LLM API path failed (${isTimeout ? "Timeout" : error.message}). Falling back to heuristic parsing engine.`
    );
    
    // 4. Offline Fallback execution
    const fallbackRecord = parseOrderHeuristic(rawText, baseDate);
    
    // Penalize confidence score slightly because API failed, representing higher uncertainty
    return {
      ...fallbackRecord,
      confidence: Math.max(0.1, fallbackRecord.confidence - 0.1),
    };
  }
}
