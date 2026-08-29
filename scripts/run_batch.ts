import * as fs from "fs";
import * as path from "path";
import { parseOrderHeuristic } from "../src/lib/nlpParser";
import { OrderRecordSchema } from "../src/schema";

/**
 * Run Batch Test Harness
 * Ingests messages_test.json, parses them, validates them against Zod,
 * computes metrics, and outputs results.json.
 */
function runBatchTest() {
  const rootDir = path.join(__dirname, "..");
  const testFilePath = path.join(rootDir, "messages_test.json");
  const outputFilePath = path.join(rootDir, "results.json");

  console.log("==================================================");
  console.log("     Starting NLP Fallback Batch Test Harness     ");
  console.log("==================================================");

  if (!fs.existsSync(testFilePath)) {
    console.error(`Error: Test messages file not found at ${testFilePath}`);
    process.exit(1);
  }

  // 1. Read input messages
  const rawData = fs.readFileSync(testFilePath, "utf-8");
  let messages: string[] = [];
  try {
    messages = JSON.parse(rawData);
  } catch (error) {
    console.error("Error parsing messages_test.json as JSON array:", error);
    process.exit(1);
  }

  console.log(`Loaded ${messages.length} messages for validation.\n`);

  const results: any[] = [];
  let validCount = 0;
  let itemsCount = 0;
  let dateCount = 0;
  let amountCount = 0;
  let clarificationCount = 0;
  let priorOrderCount = 0;

  // Set standard reference base date for testing (2026-08-29)
  const baseDate = new Date("2026-08-29T12:00:00Z");

  // 2. Loop and process
  messages.forEach((msg, idx) => {
    console.log(`[Message ${idx + 1}] Processing: "${msg}"`);

    // Parse message using fallback heuristic engine
    const parsed = parseOrderHeuristic(msg, baseDate);

    // Validate strictly against Zod schema
    const validation = OrderRecordSchema.safeParse(parsed);
    
    if (validation.success) {
      validCount++;
      results.push(parsed);
    } else {
      console.warn(`\x1b[31m[FAIL] Schema validation failed for msg ${idx + 1}:`, validation.error.format(), `\x1b[0m`);
      // Still push to display issues, or handle gracefully
      results.push(parsed);
    }

    // Accumulate metrics
    if (parsed.items.length > 0) itemsCount++;
    if (parsed.due_date !== null) dateCount++;
    if (parsed.amount !== null) amountCount++;
    if (parsed.needs_clarification) clarificationCount++;
    if (parsed.references_prior_order) priorOrderCount++;

    console.log("-> Parsed Result:", JSON.stringify(parsed, null, 2));
    console.log("--------------------------------------------------");
  });

  // 3. Write results.json
  try {
    fs.writeFileSync(outputFilePath, JSON.stringify(results, null, 2), "utf-8");
    console.log(`\n\x1b[32m[SUCCESS] Parsed results written to ${outputFilePath}\x1b[0m`);
  } catch (e) {
    console.error("Failed to write results.json:", e);
  }

  // 4. Compute and log metrics
  const total = messages.length;
  const validationRate = (validCount / total) * 100;
  const itemsExtractionRate = (itemsCount / total) * 100;
  const dateResolutionRate = (dateCount / total) * 100;
  const amountExtractionRate = (amountCount / total) * 100;
  const clarificationRate = (clarificationCount / total) * 100;
  const priorOrderRate = (priorOrderCount / total) * 100;

  console.log("\n==================================================");
  console.log("            Batch Test Metrics Summary            ");
  console.log("==================================================");
  console.log(`Total Messages Processed: ${total}`);
  console.log(`Schema Validation Pass Rate: ${validationRate.toFixed(1)}% (${validCount}/${total})`);
  console.log(`Items Extracted (>=1 item): ${itemsExtractionRate.toFixed(1)}% (${itemsCount}/${total})`);
  console.log(`Due Date Resolved:           ${dateResolutionRate.toFixed(1)}% (${dateCount}/${total})`);
  console.log(`Amount Extracted:             ${amountExtractionRate.toFixed(1)}% (${amountCount}/${total})`);
  console.log(`References Prior Order Rate:  ${priorOrderRate.toFixed(1)}% (${priorOrderCount}/${total})`);
  console.log(`Needs Clarification Flagged:  ${clarificationRate.toFixed(1)}% (${clarificationCount}/${total})`);
  console.log("==================================================");

  if (validCount !== total) {
    console.error("\x1b[31mValidation failure detected: Not all results met the Zod schema specification.\x1b[0m");
    process.exit(1);
  } else {
    console.log("\x1b[32mAll results strictly adhered to the target Zod schema.\x1b[0m");
    process.exit(0);
  }
}

runBatchTest();
