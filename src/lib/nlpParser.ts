import { OrderRecord, OrderItem } from "@/schema";

const devanagariNumerals: Record<string, string> = {
  "०": "0", "१": "1", "२": "2", "३": "3", "४": "4",
  "५": "5", "६": "6", "७": "7", "८": "8", "९": "9"
};

const wordMaps: Record<string, string> = {
  "किलो": "kg",
  "केजी": "kg",
  "लीटर": "liter",
  "ली": "liter",
  "पैकेट": "packet",
  "डब्बा": "box",
  "बोरी": "bori",
  "गड्डी": "gaddi",
  "पाव": "pau",
  "पीस": "piece",
  "प्लेट": "plate",
  "दर्जन": "dozen",
  "ग्राम": "gram",
  "आज": "aaj",
  "कल": "kal",
  "परसों": "parso",
  "tariq": "tarikh",
  "तारीख": "tarikh",
  "सोमवार": "monday",
  "मंगलवार": "tuesday",
  "बुधवार": "wednesday",
  "गुरुवार": "thursday",
  "शुक्रवार": "friday",
  "शनिवार": "saturday",
  "रविवार": "sunday",
  "और": "aur",
  "एवं": "aur",
  "रुपये": "rs",
  "रूपए": "rs",
  "रुपया": "rs",
  "रूपया": "rs",
  "रू": "rs",
  "शाम": "sham",
  "सुबह": "subah",
  "दोपहर": "dopahar",
  "रात": "night",
  "बजे": "baje",
  "तक": "tak",
  "को": "ko",
  "se": "se",
  "से": "se",
  "में": "me",
  "चाहिए": "chahiye",
  "देना": "dena",
  "देदो": "dedo",
  "भेज": "bhej",
  "कर": "kar",
  "करो": "karo",
  "भाई": "bhai",
  "भैया": "bhaiya",
  "दीदी": "didi"
};

const numWords: Record<string, number> = {
  "ek": 1, "do": 2, "teen": 3, "chaar": 4, "paanch": 5,
  "cheh": 6, "saat": 7, "aath": 8, "nau": 9, "das": 10,
  "one": 1, "two": 2, "three": 3, "four": 4, "five": 5,
  "six": 6, "seven": 7, "eight": 8, "nine": 9, "ten": 10,
  "half": 0.5, "aadha": 0.5
};

const nonItemWords = new Set([
  "ko", "se", "me", "tak", "par", "to", "for", "in", "at", "on",
  "shyam", "sham", "subah", "dopahar", "kal", "parso", "aaj", "tomorrow",
  "today", "day", "night", "tarikh", "date", "delivery", "rs", "rupee",
  "rupees", "please", "pls", "order", "bhej", "dedo", "dena", "chahiye"
]);

/**
 * Standardizes Devanagari digits/characters into Romanized Hinglish lowercase tokens
 */
export function normalizeText(text: string): string {
  let normalized = text;
  
  // Replace Devanagari numerals
  for (const [dev, lat] of Object.entries(devanagariNumerals)) {
    normalized = normalized.replace(new RegExp(dev, "g"), lat);
  }
  
  // Replace Devanagari keywords
  for (const [hindi, eng] of Object.entries(wordMaps)) {
    normalized = normalized.replace(new RegExp(hindi, "g"), eng);
  }
  
  return normalized.toLowerCase().replace(/\s+/g, " ").trim();
}

/**
 * Returns formatted YYYY-MM-DD string
 */
function toISODateString(date: Date): string {
  const yyyy = date.getFullYear();
  const mm = String(date.getMonth() + 1).padStart(2, "0");
  const dd = String(date.getDate()).padStart(2, "0");
  return `${yyyy}-${mm}-${dd}`;
}

/**
 * Resolves temporal expressions relative to baseDate
 */
export function parseRelativeDate(text: string, baseDate: Date = new Date()): { date: string | null; ambiguous: boolean } {
  const normalized = text.toLowerCase();
  let resolvedDate: Date | null = null;
  let matches = 0;
  
  // 1. Aaj / Today
  if (/\b(aaj|today)\b/.test(normalized)) {
    resolvedDate = new Date(baseDate);
    matches++;
  }
  
  // 2. Kal / Tomorrow
  if (/\b(kal|tomorrow)\b/.test(normalized)) {
    const d = new Date(baseDate);
    d.setDate(d.getDate() + 1);
    resolvedDate = d;
    matches++;
  }
  
  // 3. Parso / Day after tomorrow
  if (/\b(parso|day after)\b/.test(normalized)) {
    const d = new Date(baseDate);
    d.setDate(d.getDate() + 2);
    resolvedDate = d;
    matches++;
  }
  
  // 4. Tarikh (e.g. 10 tarikh, tarikh 15)
  const tarikhRegex = /\b(\d{1,2})\s*tarikh\b|\btarikh\s*(\d{1,2})\b/;
  const tarikhMatch = normalized.match(tarikhRegex);
  if (tarikhMatch) {
    const dayNum = parseInt(tarikhMatch[1] || tarikhMatch[2], 10);
    if (dayNum >= 1 && dayNum <= 31) {
      const d = new Date(baseDate);
      const currentDay = d.getDate();
      d.setDate(dayNum);
      if (dayNum < currentDay) {
        d.setMonth(d.getMonth() + 1); // Shift to next month if past
      }
      resolvedDate = d;
      matches++;
    }
  }
  
  // 5. Weekdays (e.g. agle mangalwar, next monday)
  const weekdays = [
    { name: "sunday", patterns: [/\b(sunday|sun|raviwar)\b/] },
    { name: "monday", patterns: [/\b(monday|mon|somwar)\b/] },
    { name: "tuesday", patterns: [/\b(tuesday|tue|mangalwar)\b/] },
    { name: "wednesday", patterns: [/\b(wednesday|wed|budhwar)\b/] },
    { name: "thursday", patterns: [/\b(thursday|thu|guruwar|veervar)\b/] },
    { name: "friday", patterns: [/\b(friday|fri|shukrawar)\b/] },
    { name: "saturday", patterns: [/\b(saturday|sat|shaniwar)\b/] }
  ];
  
  for (let i = 0; i < weekdays.length; i++) {
    const wd = weekdays[i];
    for (const pat of wd.patterns) {
      if (pat.test(normalized)) {
        const isNext = /\b(next|agle|agli)\b/.test(normalized);
        const d = new Date(baseDate);
        const currentDayOfWeek = d.getDay();
        let daysToAdd = (i - currentDayOfWeek + 7) % 7;
        
        if (daysToAdd === 0) {
          daysToAdd = 7; // e.g., today is Tuesday, "tuesday" means next week
        }
        if (isNext && daysToAdd > 0 && daysToAdd < 7) {
          daysToAdd += 7;
        }
        
        d.setDate(d.getDate() + daysToAdd);
        resolvedDate = d;
        matches++;
        break;
      }
    }
  }

  // 6. Explicit dates like "29/08" or "30 aug"
  const explicitRegex = /\b(\d{1,2})[\/\-](0?[1-9]|1[0-2])\b|\b(\d{1,2})\s*(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)\b/;
  const expMatch = normalized.match(explicitRegex);
  if (expMatch) {
    if (expMatch[1] && expMatch[2]) {
      const day = parseInt(expMatch[1], 10);
      const month = parseInt(expMatch[2], 10) - 1;
      const d = new Date(baseDate);
      d.setDate(day);
      d.setMonth(month);
      if (d < baseDate) {
        d.setFullYear(d.getFullYear() + 1);
      }
      resolvedDate = d;
      matches++;
    } else if (expMatch[3] && expMatch[4]) {
      const day = parseInt(expMatch[3], 10);
      const monthNames = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];
      const month = monthNames.indexOf(expMatch[4].substring(0, 3));
      if (month !== -1) {
        const d = new Date(baseDate);
        d.setDate(day);
        d.setMonth(month);
        if (d < baseDate) {
          d.setFullYear(d.getFullYear() + 1);
        }
        resolvedDate = d;
        matches++;
      }
    }
  }

  return {
    date: resolvedDate ? toISODateString(resolvedDate) : null,
    ambiguous: matches > 1
  };
}

/**
 * Extracts total amount from currency patterns
 */
export function parseAmount(text: string): { amount: number | null; ambiguous: boolean } {
  const normalized = text.toLowerCase();
  // Match "rs 500", "500rs", "500/-", "₹500"
  const amountRegexes = [
    /\brs\.?\s*(\d+(?:\.\d+)?)\b/g,
    /₹\s*(\d+(?:\.\d+)?)\b/g,
    /\b(\d+(?:\.\d+)?)\s*rs\b/g,
    /\b(\d+(?:\.\d+)?)\s*\/\-/g
  ];
  
  const values: number[] = [];
  for (const regex of amountRegexes) {
    let match;
    while ((match = regex.exec(normalized)) !== null) {
      const val = parseFloat(match[1]);
      if (!isNaN(val)) {
        values.push(val);
      }
    }
  }
  
  const uniqueValues = Array.from(new Set(values));
  if (uniqueValues.length === 1) {
    return { amount: uniqueValues[0], ambiguous: false };
  } else if (uniqueValues.length > 1) {
    return { amount: uniqueValues[0], ambiguous: true }; // Multiple conflicting amounts
  }
  
  return { amount: null, ambiguous: false };
}

/**
 * Parses a single item line
 */
function parseItemLine(line: string): OrderItem & { needsClarification: boolean } | null {
  let cleanLine = line.trim();
  if (!cleanLine) return null;

  const lowerLine = cleanLine.toLowerCase();

  // Exclude lines that are clearly questions, status queries, or repeat references rather than items
  const hasQuantityOrUnit = /\b\d+\b/g.test(cleanLine) || 
                            Object.keys(numWords).some(w => lowerLine.includes(w)) ||
                            new RegExp("\\b(kg|kilo|liter|litre|ltr|packet|pkt|box|dabba|bori|gaddi|pau|kacchi|plate|piece|pc|pcs|dozen|gram|gm)\\b", "i").test(cleanLine);

  if (!hasQuantityOrUnit) {
    if (
      lowerLine.includes("kya") ||
      lowerLine.includes("kab") ||
      lowerLine.includes("jayega") ||
      lowerLine.includes("milega") ||
      lowerLine.includes("dena hai") ||
      lowerLine.includes("hoga") ||
      lowerLine.includes("rakhna") ||
      lowerLine.includes("tayyar") ||
      lowerLine.includes("ready") ||
      lowerLine.includes("milenge") ||
      lowerLine.includes("same as") ||
      lowerLine.includes("last time") ||
      lowerLine.includes("purana") ||
      lowerLine.includes("pichla") ||
      lowerLine.includes("repeat") ||
      lowerLine.includes("tak") ||
      lowerLine.includes("ko")
    ) {
      return null;
    }
  }

  // 1. Strip price / amount patterns
  const amountPatterns = [
    /\brs\.?\s*\d+(?:\.\d+)?\b/gi,
    /₹\s*\d+(?:\.\d+)?\b/gi,
    /\b\d+(?:\.\d+)?\s*rs\b/gi,
    /\b\d+(?:\.\d+)?\s*rupees\b/gi,
    /\b\d+(?:\.\d+)?\s*\/\-/gi,
    /\btotal\b/gi,
    /\bpay\s*(?:kar\s*diya|diya)?\b/gi
  ];
  for (const pattern of amountPatterns) {
    cleanLine = cleanLine.replace(pattern, "");
  }

  // 2. Strip relative date / temporal patterns
  const datePatterns = [
    /\b(aaj|today|kal|tomorrow|parso|subah|sham|dopahar|night|day|delivery|deliver)\b/gi,
    /\b(monday|tuesday|wednesday|thursday|friday|saturday|sunday)\b/gi,
    /\b(somwar|mangalwar|budhwar|guruwar|shukrawar|shaniwar|ravivar)\b/gi,
    /\bnext\b/gi,
    /\bagle\b/gi,
    /\b\d{1,2}[\/\-](0?[1-9]|1[0-2])\b/gi,
    /\b\d{1,2}\s*(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)\b/gi,
    /\b\d{1,2}\s*(baje|o'clock)\b/gi,
    /\btak\b/gi,
    /\bko\b/gi,
    /\bse\b/gi
  ];
  for (const pattern of datePatterns) {
    cleanLine = cleanLine.replace(pattern, "");
  }

  // 3. Remove common filler words
  const fillers = [
    /\bbhaiya\b/gi, /\bbhai\b/gi, /\buncle\b/gi, /\bdidi\b/gi,
    /\bchahiye\b/gi, /\bdedo\b/gi, /\bbhej\s*do\b/gi, /\bbhej\s*dena\b/gi, 
    /\bdena\b/gi, /\ble\s*aana\b/gi, /\border\b/gi, /\bplease\b/gi, /\bpls\b/gi,
    /\burgent\b/gi, /\bdal\s*dena\b/gi, /\bdalna\b/gi,
    /\bhoga\b/gi, /\bkar\b/gi, /\bkaro\b/gi, /\bhai\b/gi, /\bhein\b/gi,
    /\bmujhe\b/gi, /\bke\s*liye\b/gi, /\bready\b/gi, /\brakhna\b/gi
  ];
  for (const filler of fillers) {
    cleanLine = cleanLine.replace(filler, "");
  }
  
  let parseTarget = cleanLine.replace(/\s+/g, " ").trim();
  if (!parseTarget) return null;

  // Split and filter out leftover non-item tokens
  const tokens = parseTarget.split(/\s+/);
  const relevantWords = tokens.filter(w => !nonItemWords.has(w.toLowerCase()) && !/^\d+$/.test(w));
  if (relevantWords.length === 0) return null;

  // Standard local/global units
  const unitsRegexStr = "\\b(kg|kilo|liter|litre|ltr|packet|pkt|box|dabba|bori|gaddi|pau|kacchi|plate|piece|pc|pcs|dozen|gram|gm)\\b";
  const unitsRegex = new RegExp(unitsRegexStr, "i");

  let quantity = 1;
  let unit: string | null = null;
  let description = "";
  let needsClarification = false;

  const getNumberFromWord = (word: string): number | null => {
    const w = word.toLowerCase();
    return numWords[w] !== undefined ? numWords[w] : null;
  };

  const firstTokenNum = parseFloat(tokens[0]);
  const firstTokenWordNum = getNumberFromWord(tokens[0]);
  
  const lastTokenNum = parseFloat(tokens[tokens.length - 1]);
  const lastTokenWordNum = getNumberFromWord(tokens[tokens.length - 1]);
  
  const unitMatch = parseTarget.match(unitsRegex);
  if (unitMatch) {
    unit = unitMatch[1].toLowerCase();
  }

  // 1. Quantity at start: e.g. "2 kg aaloo" or "do dabba sweet"
  if (!isNaN(firstTokenNum) || firstTokenWordNum !== null) {
    quantity = !isNaN(firstTokenNum) ? firstTokenNum : firstTokenWordNum!;
    let remaining = tokens.slice(1);
    
    if (unit && remaining[0] && remaining[0].toLowerCase() === unit) {
      remaining = remaining.slice(1);
    } else if (unit) {
      remaining = remaining.filter(t => t.toLowerCase() !== unit);
    }
    description = remaining.join(" ");
  } 
  // 2. Quantity at end: e.g. "aaloo 2 kg" or "sweet do dabba"
  else if (!isNaN(lastTokenNum) || lastTokenWordNum !== null) {
    let remaining = tokens;
    const secondLast = tokens[tokens.length - 2];
    const secondLastNum = parseFloat(secondLast);
    const secondLastWordNum = secondLast ? getNumberFromWord(secondLast) : null;
    
    if (unit && tokens[tokens.length - 1].toLowerCase() === unit && 
        (!isNaN(secondLastNum) || secondLastWordNum !== null)) {
      quantity = !isNaN(secondLastNum) ? secondLastNum : secondLastWordNum!;
      remaining = tokens.slice(0, tokens.length - 2);
    } else if (!isNaN(lastTokenNum) || lastTokenWordNum !== null) {
      quantity = !isNaN(lastTokenNum) ? lastTokenNum : lastTokenWordNum!;
      remaining = tokens.slice(0, tokens.length - 1);
      if (unit) {
        remaining = remaining.filter(t => t.toLowerCase() !== unit);
      }
    }
    description = remaining.join(" ");
  } 
  // 3. Fallback: Search for any numeric quantity in the tokens
  else {
    let foundQtyIndex = -1;
    let foundQty: number | null = null;
    
    for (let i = 0; i < tokens.length; i++) {
      const num = parseFloat(tokens[i]);
      const wordNum = getNumberFromWord(tokens[i]);
      if (!isNaN(num)) {
        foundQty = num;
        foundQtyIndex = i;
        break;
      } else if (wordNum !== null) {
        foundQty = wordNum;
        foundQtyIndex = i;
        break;
      }
    }
    
    if (foundQty !== null && foundQtyIndex !== -1) {
      quantity = foundQty;
      const remaining = tokens.filter((_, idx) => idx !== foundQtyIndex && (!unit || tokens[idx].toLowerCase() !== unit));
      description = remaining.join(" ");
    } else {
      needsClarification = true;
      quantity = 1; 
      const remaining = tokens.filter(t => !unit || t.toLowerCase() !== unit);
      description = remaining.join(" ");
    }
  }

  description = description.trim().replace(/[.,\/#!$%\^&\*;:{}=\-_`~()?]/g, "").replace(/\s+/g, " ").trim();
  if (!description || nonItemWords.has(description.toLowerCase())) return null;

  // Apply Hinglish/Hindi -> English item translations
  const lowerDesc = description.toLowerCase();
  let finalDescription = description;

  const itemTranslations: Record<string, string> = {
    "aaloo": "potato",
    "aalu": "potato",
    "pyaaz": "onion",
    "pyaz": "onion",
    "pyaaj": "onion",
    "tamatar": "tomato",
    "dhaniya": "coriander",
    "adrak": "ginger",
    "lehsun": "garlic",
    "doodh": "milk",
    "cheeni": "sugar",
    "chini": "sugar",
    "chai": "tea",
    "chawal": "rice",
    "atta": "flour",
    "dal": "lentils",
    "daal": "lentils",
    "tel": "oil",
    "paneer": "cottage cheese",
    "sabzi": "vegetables",
    "sabji": "vegetables",
    "bread": "bread",
    "ब्रेड": "bread",
    "चीनी": "sugar",
    "दूध": "milk",
    "आलू": "potato",
    "प्याज": "onion",
    "टमाटर": "tomato"
  };

  // Check if description is a direct match or contains the keyword
  for (const [hindi, eng] of Object.entries(itemTranslations)) {
    if (lowerDesc === hindi) {
      finalDescription = eng;
      break;
    } else if (lowerDesc.includes(hindi)) {
      finalDescription = finalDescription.replace(new RegExp(hindi, "gi"), eng);
    }
  }

  const attributes: Record<string, any> = {};
  if (unit) {
    attributes.unit = unit;
  } else {
    // Missing unit detection. If it is a known bulk commodity, flag needs_clarification.
    const bulkKeywords = ["potato", "aaloo", "aalu", "doodh", "milk", "chini", "sugar", "pyaaz", "onion", "oil", "tel", "atta", "chawal", "rice"];
    const checkDesc = finalDescription.toLowerCase();
    const isBulk = bulkKeywords.some(kw => checkDesc.includes(kw));
    
    if (isBulk) {
      needsClarification = true;
    }
    attributes.unit = "piece"; // Default unit
  }

  return {
    description: finalDescription,
    quantity: Math.round(quantity),
    attributes,
    needsClarification
  };
}

/**
 * Heuristics-based fallback parsing engine for offline operations
 */
export function parseOrderHeuristic(rawText: string, baseDate: Date = new Date()): OrderRecord {
  if (!rawText || !rawText.trim()) {
    return {
      customer: null,
      items: [],
      due_date: null,
      amount: null,
      references_prior_order: false,
      confidence: 0.0,
      needs_clarification: true
    };
  }

  const normalized = normalizeText(rawText);
  let needsClarification = false;

  // 1. Detect Customer name (heuristic)
  // Look for patterns like "name is X", "naam X", "X ordering", "sender X"
  let customer: string | null = null;
  const customerRegexes = [
    /\b(?:name is|naam|sender|from)\s+([a-zA-Z\u0900-\u097F]+)/i,
    /([a-zA-Z\u0900-\u097F]+)\s+(?:ordering|here)/i
  ];
  for (const regex of customerRegexes) {
    const match = normalized.match(regex);
    if (match && match[1]) {
      const nameCandidate = match[1].toLowerCase();
      // Ignore address labels and filler words
      const forbiddenNames = ["bhaiya", "bhai", "uncle", "didi", "dada", "apna", "mera", "naam", "ko", "se", "ek", "do"];
      if (!forbiddenNames.includes(nameCandidate) && !nonItemWords.has(nameCandidate)) {
        customer = match[1];
        break;
      }
    }
  }

  // 2. Parse Date
  const dateResult = parseRelativeDate(normalized, baseDate);
  const due_date = dateResult.date;
  if (dateResult.ambiguous) {
    needsClarification = true;
  }

  // 3. Parse Amount
  const amountResult = parseAmount(normalized);
  const amount = amountResult.amount;
  if (amountResult.ambiguous) {
    needsClarification = true;
  }

  // 4. Parse references_prior_order
  const priorOrderKeywords = ["purana", "pichla", "wahi", "same", "last time", "repeat", "पहले", "पुराना"];
  const references_prior_order = priorOrderKeywords.some(kw => normalized.includes(kw));

  // 5. Parse Items
  // Split lines by newline, commas, "and", "aur"
  const itemLines = normalized.split(/\n|,|\band\b|\baur\b/);
  const items: OrderItem[] = [];

  for (const line of itemLines) {
    const parsedLine = parseItemLine(line);
    if (parsedLine) {
      items.push({
        description: parsedLine.description,
        quantity: parsedLine.quantity,
        attributes: parsedLine.attributes
      });
      if (parsedLine.needsClarification) {
        needsClarification = true;
      }
    }
  }

  // Confidence Calculation
  let confidence = 0.8; // Max heuristic confidence
  if (items.length === 0) {
    needsClarification = true;
    confidence = 0.1;
  } else if (needsClarification) {
    confidence = 0.4;
  }

  return {
    customer,
    items,
    due_date,
    amount,
    references_prior_order,
    confidence,
    needs_clarification: needsClarification
  };
}
