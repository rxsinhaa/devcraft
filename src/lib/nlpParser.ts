import { OrderRecord, OrderItem } from "@/schema";

const devanagariNumerals: Record<string, string> = {
  "०": "0", "१": "1", "२": "2", "३": "3", "४": "4",
  "५": "5", "६": "6", "७": "7", "८": "8", "९": "9"
};

const wordMaps: Record<string, string> = {
  // Units & Quantities
  "किलो": "kg", "केजी": "kg", "लीटर": "liter",
  "पैकेट": "packet", "डब्बा": "box", "बोरी": "bori", "गड्डी": "gaddi",
  "पाव": "pau", "पीस": "piece", "प्लेट": "plate", "दर्जन": "dozen", "ग्राम": "gram",
  
  // Dates & Temporal
  "आज": "aaj", "कल": "kal", "परसों": "parso", "नरसों": "narsu", "तरसों": "tarso",
  "तारीख": "tarikh", "तारीक": "tarikh",
  "सोमवार": "somwar", "मंगलवार": "mangalwar", "बुधवार": "budhwar",
  "गुरुवार": "guruwar", "शुक्रवार": "shukrawar", "शनिवार": "shaniwar", "रविवार": "raviwar",
  "और": "aur", "एवं": "aur",
  "रुपये": "rs", "रूपए": "rs", "रुपया": "rs", "रूपया": "rs",
  "शाम": "sham", "सुबह": "subah", "दोपहर": "dopahar", "रात": "night",
  "बजे": "baje", "तक": "tak", "को": "ko", "से": "se", "में": "me",
  "चाहिए": "chahiye", "देना": "dena", "देदो": "dedo", "भेज": "bhej", "करो": "karo",
  "भाई": "bhai", "भैया": "bhaiya", "दीदी": "didi",

  // Domain Catalog Devanagari Mappings
  "पजामा": "pajama", "दुपट्टा": "dupatta", "लहंगा": "lehenga", "सलवार": "salwar", "शर्ट": "shirt", "ब्लाउज": "blouse", "कुर्ता": "kurta", "कमीज": "kameez", "सूट": "suit", "शेरवानी": "sherwani",
  "सॉकेट": "socket", "गीजर": "geyser", "घंटी": "doorbell", "मोटर": "water motor", "पंखे": "fan", "पंखा": "fan", "ट्यूब लाइट": "tube light", "ट्यूबलाइट": "tube light", "वायरिंग": "wiring",
  "दही": "dahi", "थाली": "thali", "इडली": "idli", "छोले": "chole", "खिचड़ी": "khichdi", "पोहा": "poha", "पोहे": "poha", "पराठा": "paratha", "पराठे": "paratha", "राजमा": "rajma", "दाल": "dal", "सब्जी": "sabzi", "चावल": "rice", "रोटी": "roti",
  "पेस्ट्री": "pastry", "ब्राउनी": "brownie", "ब्रेड": "bread", "डोनट": "donut", "मफिन": "muffin", "कपकेक": "cupcake", "केक": "cake"
};

const numWords: Record<string, number> = {
  "ek": 1, "do": 2, "teen": 3, "char": 4, "chaar": 4, "paanch": 5, "panch": 5,
  "chhe": 6, "cheh": 6, "saat": 7, "sat": 7, "aath": 8, "ath": 8, "nau": 9, "no": 9, "das": 10,
  "one": 1, "two": 2, "three": 3, "four": 4, "five": 5,
  "six": 6, "seven": 7, "eight": 8, "nine": 9, "ten": 10,
  "half": 0.5, "aadha": 0.5,
  "chhattis": 36, "chattis": 36,
  "aadtis": 38, "adtis": 38,
  "chalis": 40, "challis": 40, "chaalis": 40,
  "bayalis": 42, "byalis": 42,
  "chavalis": 44, "chhavalis": 44, "chawalis": 44,
  "chhiyalis": 46, "chheyalis": 46, "chheyalees": 46,
  "tees": 30, "battis": 32, "saath": 60, "assi": 80, "sau": 100
};

export function normalizeText(text: string): string {
  let normalized = text.normalize("NFC");
  for (const [dev, lat] of Object.entries(devanagariNumerals)) {
    normalized = normalized.replace(new RegExp(dev, "g"), lat);
  }
  for (const [hindi, eng] of Object.entries(wordMaps)) {
    normalized = normalized.replace(new RegExp(hindi, "g"), eng);
  }
  return normalized.replace(/\s+/g, " ").trim();
}

function toISODateString(date: Date): string {
  const yyyy = date.getFullYear();
  const mm = String(date.getMonth() + 1).padStart(2, "0");
  const dd = String(date.getDate()).padStart(2, "0");
  return `${yyyy}-${mm}-${dd}`;
}

export function parseRelativeDate(text: string, baseDateInput: Date | string = new Date()): { date: string | null; ambiguous: boolean } {
  const baseDate = typeof baseDateInput === "string" ? new Date(baseDateInput) : baseDateInput;
  const normalized = normalizeText(text).toLowerCase();
  
  // 0. Check for open-ended vague deadlines that should NOT produce a fixed due_date
  const openEndedPatterns = [
    /\b(next\s*week\s*kabhi\s*bhi|mahine\s*ke\s*end\s*tak|season\s*shuru\s*hone\s*se\s*pehle|diwali\s*se\s*pehle|festival\s*se\s*pehle|shaadi\s*se\s*pehle|exam\s*ke\s*baad|jab\s*ho\s*jaye|jab\s*time\s*mile|jitna\s*jaldi\s*ho\s*sake|asap\s*chahiye|agle\s*mahine)\b/i
  ];
  for (const pat of openEndedPatterns) {
    if (pat.test(normalized)) {
      return { date: null, ambiguous: true };
    }
  }

  // 1. Explicit calendar date with month (e.g., "18 Oct tak", "7 Sep tak", "22 Aug tak", "1 September tak", "10 Oct tak", "11 Oct tak", "3 Sep tak", "23 August tak")
  const monthMap: Record<string, number> = {
    "jan": 0, "january": 0, "feb": 1, "february": 1, "mar": 2, "march": 2,
    "apr": 3, "april": 3, "may": 4, "jun": 5, "june": 5, "jul": 6, "july": 6,
    "aug": 7, "august": 7, "sep": 8, "september": 8, "oct": 9, "october": 9,
    "nov": 10, "november": 10, "dec": 11, "december": 11
  };

  const expMonthRegex = /\b(\d{1,2})\s*(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec|january|february|march|april|june|july|august|september|october|november|december)\b/i;
  const monthMatch = normalized.match(expMonthRegex);
  if (monthMatch) {
    const day = parseInt(monthMatch[1], 10);
    const month = monthMap[monthMatch[2].toLowerCase()];
    if (month !== undefined && day >= 1 && day <= 31) {
      const year = baseDate.getFullYear();
      const d = new Date(year, month, day, 12, 0, 0);
      return { date: toISODateString(d), ambiguous: false };
    }
  }

  // 2. Explicit tarikh (e.g., "18 tarikh tak", "18 tareekh", "२७ तारीख tak", "tarikh 15")
  const tarikhRegex = /\b(\d{1,2})\s*(?:tarikh|tareekh|तारीख|तारीक|tarik)\b|\b(?:tarikh|tareekh|तारीख|तारीक|tarik)\s*(\d{1,2})\b/i;
  const tarikhMatch = normalized.match(tarikhRegex);
  if (tarikhMatch) {
    const dayNum = parseInt(tarikhMatch[1] || tarikhMatch[2], 10);
    if (dayNum >= 1 && dayNum <= 31) {
      const d = new Date(baseDate);
      const currentDay = d.getDate();
      d.setDate(dayNum);
      if (dayNum < currentDay) {
        d.setMonth(d.getMonth() + 1); // Shift to next month
      }
      return { date: toISODateString(d), ambiguous: false };
    }
  }

  // 3. Negation-aware weekday resolution (e.g. "guruvar ko nahi, shukravar ko")
  const weekdayDefs = [
    { idx: 0, names: ["raviwar", "ravivar", "sunday", "sun"] },
    { idx: 1, names: ["somwar", "somvar", "monday", "mon"] },
    { idx: 2, names: ["mangalwar", "mangalvar", "tuesday", "tue"] },
    { idx: 3, names: ["budhwar", "budhvar", "wednesday", "wed"] },
    { idx: 4, names: ["guruwar", "guruvar", "veervar", "thursday", "thu"] },
    { idx: 5, names: ["shukrawar", "shukravar", "friday", "fri"] },
    { idx: 6, names: ["shaniwar", "shanivar", "saturday", "sat"] }
  ];

  let targetWeekday: number | null = null;
  for (const wd of weekdayDefs) {
    for (const name of wd.names) {
      const negPattern = new RegExp(`\\b${name}\\s*(?:ko\\s*)?nahi\\b`, "i");
      if (negPattern.test(normalized)) {
        continue;
      }
      const posPattern = new RegExp(`\\b${name}\\b`, "i");
      if (posPattern.test(normalized)) {
        targetWeekday = wd.idx;
      }
    }
  }

  if (targetWeekday !== null) {
    const d = new Date(baseDate);
    const currentDayOfWeek = d.getDay();
    let daysToAdd = (targetWeekday - currentDayOfWeek + 7) % 7;
    if (daysToAdd === 0) {
      daysToAdd = 7;
    }
    d.setDate(d.getDate() + daysToAdd);
    return { date: toISODateString(d), ambiguous: false };
  }

  // 4. Relative Offsets (Aaj, Kal, Parso, Narsu, Tarso, Is Weekend, Agle Hafte, X din me)
  if (/\b(aaj|today)\b/i.test(normalized)) {
    return { date: toISODateString(new Date(baseDate)), ambiguous: false };
  }
  if (/\b(kal|tomorrow)\b/i.test(normalized)) {
    const d = new Date(baseDate);
    d.setDate(d.getDate() + 1);
    return { date: toISODateString(d), ambiguous: false };
  }
  if (/\b(parso|parson|day\s*after)\b/i.test(normalized)) {
    const d = new Date(baseDate);
    d.setDate(d.getDate() + 2);
    return { date: toISODateString(d), ambiguous: false };
  }
  if (/\b(narsu|narso|tarso|tarson)\b/i.test(normalized)) {
    const d = new Date(baseDate);
    d.setDate(d.getDate() + 3);
    return { date: toISODateString(d), ambiguous: false };
  }
  if (/\b(is\s*weekend|this\s*weekend|weekend)\b/i.test(normalized)) {
    const d = new Date(baseDate);
    const day = d.getDay();
    const daysUntilSaturday = (6 - day + 7) % 7;
    d.setDate(d.getDate() + (daysUntilSaturday === 0 ? 0 : daysUntilSaturday));
    return { date: toISODateString(d), ambiguous: false };
  }
  if (/\b(agle\s*hafte|next\s*week)\b/i.test(normalized)) {
    const d = new Date(baseDate);
    d.setDate(d.getDate() + 7);
    return { date: toISODateString(d), ambiguous: false };
  }

  const dinMatch = normalized.match(/\b(\d+)\s*din\s*me\b/i);
  if (dinMatch) {
    const count = parseInt(dinMatch[1], 10);
    const d = new Date(baseDate);
    d.setDate(d.getDate() + count);
    return { date: toISODateString(d), ambiguous: false };
  }

  return { date: null, ambiguous: false };
}

export function parseAmount(text: string): { amount: number | null; ambiguous: boolean } {
  const normalized = normalizeText(text).toLowerCase();
  
  // Exclude numbers associated with wattage (e.g. "2000 watt", "40 watt", "80 watt", "100 watt", "1500 watt")
  const strippedText = normalized.replace(/\b\d+\s*watt\b/gi, "").replace(/\b(?:sau|assi|saath|do hazaar)\s*watt\b/gi, "");

  const amountRegexes = [
    /₹\s*(\d+(?:\.\d+)?)/g,
    /\brs\.?\s*(\d+(?:\.\d+)?)/g,
    /\b(\d+(?:\.\d+)?)\s*rs\b/g,
    /\b(\d+(?:\.\d+)?)\s*rupees\b/g,
    /\b(\d+(?:\.\d+)?)\s*\/\-/g,
    /\b(\d+(?:\.\d+)?)\s*(?:tak|ke andar|me|ka)\b/g,
    /(?:tak|ke andar|me)\s*(\d+(?:\.\d+)?)\b/g
  ];

  const values: number[] = [];
  for (const regex of amountRegexes) {
    let match;
    while ((match = regex.exec(strippedText)) !== null) {
      const val = parseFloat(match[1]);
      if (!isNaN(val) && val >= 50 && val <= 50000) {
        values.push(val);
      }
    }
  }

  if (values.length === 0) {
    const bareMatch = strippedText.match(/,\s*(\d{3,4})\s*$/);
    if (bareMatch) {
      values.push(parseFloat(bareMatch[1]));
    }
  }

  const unique = Array.from(new Set(values));
  if (unique.length === 1) {
    return { amount: unique[0], ambiguous: false };
  } else if (unique.length > 1) {
    return { amount: unique[unique.length - 1], ambiguous: false };
  }
  return { amount: null, ambiguous: false };
}

export function parseReferencesPriorOrder(text: string): boolean {
  const lower = normalizeText(text).toLowerCase();
  if (lower.includes("pichli baar jaisa nahi") || lower.includes("last time jaisa nahi") || lower.includes("pehle jaisa nahi") || lower.includes("is baar naya")) {
    return false;
  }
  if (lower.includes("wahi roz wala") || lower.includes("jo hamesha bhejte ho") || lower.includes("wahi wala kaam")) {
    return false;
  }
  const priorKeywords = ["pichli baar jaisa", "last time jaisa", "pehle jaisa hi", "last wale jaisa", "wahi wala", "purana", "pichla"];
  return priorKeywords.some(kw => lower.includes(kw));
}

export function parseCustomer(text: string): string | null {
  const norm = normalizeText(text);

  // 1. Negation-aware customer: "X ke liye nahi, Y ke liye"
  const custNegMatch = norm.match(/([a-zA-Z\u0900-\u097F]+(?:\s+ji|\s+bhai|\s+didi|\s+aunty)?)\s+ke\s+liye\s+nahi[,\s]+(?:sirf\s+)?([a-zA-Z\u0900-\u097F]+(?:\s+ji|\s+bhai|\s+didi|\s+aunty)?)\s+ke\s+liye/i);
  if (custNegMatch && custNegMatch[2]) {
    const c = custNegMatch[2].trim();
    if (!["bhaiya", "bhai", "ji", "didi", "aunty"].includes(c.toLowerCase())) return c;
  }

  // 2. Direct customer prefixes
  const custPatterns = [
    /\bmain\s+([a-zA-Z\u0900-\u097F]+)\s+bol\s+rah/i,
    /\b([a-zA-Z\u0900-\u097F]+)\s+bol\s+raha\s+hu/i,
    /\b([a-zA-Z\u0900-\u097F]+)\s+ke\s+naam\s+se\b/i,
    /\b([a-zA-Z\u0900-\u097F]+)\s+ke\s+ghar\b/i,
    /\b([a-zA-Z\u0900-\u097F]+)\s+ke\s+yahan\b/i,
    /\b([a-zA-Z\u0900-\u097F]+(?:\s+ji|\s+didi|\s+aunty|\s+bhai)?)\s+ka\s+order\b/i,
    /\b([a-zA-Z\u0900-\u097F]+(?:\s+didi|\s+aunty|\s+bhai)?)\s+ke\s+liye\b/i,
    /\b([a-zA-Z\u0900-\u097F]+)\s+ji\b/i,
    /\b([a-zA-Z\u0900-\u097F]+)\s+bhai\b/i,
    /\b([a-zA-Z\u0900-\u097F]+)\s+aunty\b/i,
    /\b([a-zA-Z\u0900-\u097F]+)\s+didi\b/i
  ];

  const forbidden = [
    "bhaiya", "bhai", "ji", "didi", "aunty", "uncle", "sir", "apna", "mera", "naam",
    "somwar", "somvar", "mangalwar", "mangalvar", "budhwar", "budhvar", "guruwar", "guruvar", "shukrawar", "shukravar", "shaniwar", "shanivar", "raviwar", "ravivar",
    "aaj", "kal", "parso", "narsu", "tarso", "is", "next", "agle", "din", "lunch", "breakfast", "dinner", "mahine", "saal", "hafte", "weekend", "order", "delivery",
    "geyser", "shirt", "socket", "wiring", "cake", "bread", "pastry", "cookies", "poha", "thali", "rajma", "sabzi", "sabji", "roti", "paratha", "parantha", "chole", "chhole", "khichdi", "idli", "curd", "dahi", "suit", "pant", "pent", "salwar", "pajama", "pyjama", "blouse", "sherwani", "lehenga", "kameez", "dupatta", "koti", "west coat", "switchboard", "inverter", "mcb", "tubelight"
  ];

  for (const pat of custPatterns) {
    const match = norm.match(pat);
    if (match && match[1]) {
      const candidate = match[1].trim();
      const lower = candidate.toLowerCase();
      
      if (!forbidden.includes(lower) && !forbidden.some(f => lower === f)) {
        return candidate;
      }
    }
  }

  return null;
}

export function normalizeDomainItem(desc: string): string {
  const s = desc.toLowerCase().trim();
  // Tailor
  if (s.includes("koti") || s.includes("west coat") || s.includes("waistcoat")) return "waistcoat";
  if (s.includes("pant") || s.includes("pent")) return "pant";
  if (s.includes("pajama") || s.includes("pyjama")) return "pajama";
  if (s.includes("blouse") || s.includes("ब्लाउज")) return "blouse";
  if (s.includes("shirt") || s.includes("shart")) return "shirt";
  if (s.includes("suit")) return "suit";
  if (s.includes("kurti") || s.includes("cotton kurti")) return "cotton kurti";
  if (s.includes("kurta")) return "kurta";
  if (s.includes("kameez")) return "kameez";
  if (s.includes("salwar") || s.includes("shalwar") || s.includes("सलवार")) return "salwar";
  if (s.includes("lehenga") || s.includes("lehnga") || s.includes("लहंगा")) return "lehenga";
  if (s.includes("sherwani") || s.includes("शेरवानी")) return "sherwani";
  if (s.includes("dupatta") || s.includes("दुपट्टा")) return "dupatta";

  // Electrician
  if (s.includes("socket") || s.includes("plug point") || s.includes("सॉकेट")) return "socket";
  if (s.includes("wiring") || s.includes("वायरिंग")) return "wiring";
  if (s.includes("switchboard") || s.includes("switch board") || s.includes("board")) return "switch board";
  if (s.includes("inverter") || s.includes("invertor")) return "inverter";
  if (s.includes("geyser") || s.includes("gizer") || s.includes("गीजर")) return "geyser";
  if (s.includes("chimney") || s.includes("exaust fan") || s.includes("exhaust fan")) return "exhaust fan";
  if (s.includes("pankha") || s.includes("ceiling fan") || s.includes("fan")) return "ceiling fan";
  if (s.includes("doorbell") || s.includes("door bell") || s.includes("ghanti") || s.includes("घंटी")) return "doorbell";
  if (s.includes("water motor") || (s.includes("motor") && !s.includes("fan") && !s.includes("geyser"))) return "water motor";
  if (s.includes("tubelight") || s.includes("tube light") || s.includes("ट्यूब लाइट")) return "tube light";
  if (s.includes("mcb") || s.includes("fuse box")) return "mcb";
  if (s.includes("ac point") || s.includes("ac")) return "ac point";

  // Baker
  if (s.includes("bday cake") || s.includes("birthday cake")) return "birthday cake";
  if (s.includes("cheesecake") || s.includes("cheese cake")) return "cheesecake";
  if (s.includes("pastry") || s.includes("पेस्ट्री")) return "pastry";
  if (s.includes("cookie") || s.includes("cookies") || s.includes("biscuit")) return "cookies";
  if (s.includes("bread") || s.includes("bread loaf") || s.includes("ब्रेड")) return "bread loaf";
  if (s.includes("muffin")) return "muffin";
  if (s.includes("cupcake") || s.includes("cup cake")) return "cupcake";
  if (s.includes("donut") || s.includes("doughnut") || s.includes("डोनट")) return "donut";
  if (s.includes("brownie") || s.includes("browni") || s.includes("ब्राउनी")) return "brownie";
  if (s.includes("cake") || s.includes("kek")) return "cake";

  // Tiffin
  if (s.includes("rajma") || s.includes("राजमा")) return "rajma";
  if (s.includes("curd") || s.includes("dahi") || s.includes("दही")) return "curd";
  if (s.includes("paneer sabzi") || s.includes("paneer ki sabji") || s.includes("paneer")) return "paneer sabzi";
  if (s.includes("sabzi") || s.includes("sabji")) return "sabzi";
  if (s.includes("paratha") || s.includes("parantha") || s.includes("पराठा")) return "paratha";
  if (s.includes("thali") || s.includes("थाली")) return "thali";
  if (s.includes("idli") || s.includes("इडली")) return "idli";
  if (s.includes("chole") || s.includes("chhole") || s.includes("छोले")) return "chole";
  if (s.includes("poha") || s.includes("pohe")) return "poha";
  if (s.includes("khichdi") || s.includes("खिचड़ी")) return "khichdi";
  if (s.includes("dal") || s.includes("daal") || s.includes("दाल")) return "dal";
  if (s.includes("roti")) return "roti";
  if (s.includes("rice") || s.includes("chawal")) return "rice";

  return s;
}

export function extractItemAttributes(clause: string, itemType: string): Record<string, any> {
  const norm = normalizeText(clause).toLowerCase();
  const attrs: Record<string, any> = {};

  // Tailor attributes
  const chestMatch = norm.match(/\bchest\s*(\d{2})\b/) || norm.match(/\bchest\s*(chhattis|aadtis|chalis|bayalis|chavalis|chhiyalis)\b/);
  if (chestMatch) {
    attrs.chest = isNaN(Number(chestMatch[1])) ? numWords[chestMatch[1]] : parseInt(chestMatch[1], 10);
  }

  const waistMatch = norm.match(/\bwaist\s*(\d{2})\b/) || norm.match(/\bwaist\s*(tees|battis|chalis)\b/);
  if (waistMatch) {
    attrs.waist = isNaN(Number(waistMatch[1])) ? numWords[waistMatch[1]] : parseInt(waistMatch[1], 10);
  }

  const lengthMatch = norm.match(/\blength\s*(\d{2})\b/) || norm.match(/\blength\s*(chalis|aadtis|bayalis)\b/);
  if (lengthMatch) {
    attrs.length = isNaN(Number(lengthMatch[1])) ? numWords[lengthMatch[1]] : parseInt(lengthMatch[1], 10);
  }

  const sizeMatch = norm.match(/\bsize\s*(s|m|l|xl|xxl)\b/i) || norm.match(/\b(xxl|xl|s|m|l)\s*size\b/i) || norm.match(/\b(xxl|xl)\b/i);
  if (sizeMatch) {
    attrs.size = sizeMatch[1].toUpperCase();
  }

  const fitMatch = norm.match(/\b(regular|slim|loose)(?:\s*fit)?\b/i);
  if (fitMatch) {
    attrs.fit = fitMatch[1].toLowerCase();
  }

  const sleeveMatch = norm.match(/\b(3\/4|three-quarter|three quarter)\s*sleeve\b/i) ||
                      norm.match(/\b(full|pura)\s*sleeve\b/i) ||
                      norm.match(/\b(half|aadha)\s*sleeve\b/i);
  if (sleeveMatch) {
    const sl = sleeveMatch[1].toLowerCase();
    attrs.sleeve = (sl === "3/4" || sl.includes("three")) ? "three-quarter" : (sl === "full" || sl === "pura") ? "full" : "half";
  }

  const fabricMatch = norm.replace(/\bred\s*velvet\b/gi, "").match(/\b(cotton|silk|linen|velvet|chiffon|rayon|khadi)\b/i);
  if (fabricMatch) {
    attrs.fabric = fabricMatch[1].toLowerCase();
  }

  const colorMatch = norm.replace(/\bblack\s*forest\b/gi, "").match(/\b(navy\s*blue|maroon|bottle\s*green|mustard|grey|beige|pink|white|black)\b/i);
  if (colorMatch) {
    attrs.color = colorMatch[1].toLowerCase();
  }

  // Electrician attributes
  const brandMatch = norm.match(/\b(havells|anchor|polycab|orient|usha|bajaj|crompton)\b/i);
  if (brandMatch) {
    const b = brandMatch[1].toLowerCase();
    attrs.brand = b.charAt(0).toUpperCase() + b.slice(1);
  }

  const roomMatch = norm.match(/\b(kitchen|bathroom|hall|bedroom|balcony|terrace)\b/i);
  if (roomMatch) {
    attrs.room = roomMatch[1].toLowerCase();
  }

  const appText = norm.replace(/\b(?:exaust|exhaust|chimney)\s*fan\b/gi, "")
                      .replace(/\b(?:ceiling|table)\s*fan\b/gi, "")
                      .replace(/\bwater\s*motor\b/gi, "")
                      .replace(/\btube\s*light\b/gi, "")
                      .replace(/\bac\s*point\b/gi, "")
                      .replace(/\bswitch\s*board\b/gi, "");

  const appMatches = Array.from(appText.matchAll(/\b(fridge\s*point|fan|geyser|light|motor|ac)\b/gi));
  for (const m of appMatches) {
    const candidate = m[1].toLowerCase().replace(/\s+/, " ");
    if (itemType === candidate || (itemType === "ceiling fan" && candidate === "fan") || (itemType === "water motor" && candidate === "motor") || (itemType === "geyser" && candidate === "geyser") || (itemType === "tube light" && candidate === "light") || (itemType === "ac point" && candidate === "ac")) {
      continue;
    }
    attrs.appliance = candidate;
    break;
  }

  const wattMatch = norm.match(/\b(\d+)\s*watt\b/i) || norm.match(/\b([a-zA-Z\u0900-\u097F]+)\s*watt\b/i);
  if (wattMatch) {
    const w = wattMatch[1].toLowerCase();
    if (!isNaN(Number(w))) {
      attrs.wattage = parseInt(w, 10);
    } else if (w === "do hazaar" || w === "2 hazaar") {
      attrs.wattage = 2000;
    } else if (w === "hazaar" || w === "1 hazaar") {
      attrs.wattage = 1000;
    } else if (numWords[w] !== undefined) {
      attrs.wattage = numWords[w];
    }
  }

  if (norm.includes("fuse ud gaya") || norm.includes("fuse blown")) {
    attrs.issue = "fuse blown";
  } else if (norm.includes("current aa raha") || norm.includes("jhatka lag raha") || norm.includes("current")) {
    attrs.issue = "leaking current";
  } else if (norm.includes("short ho gaya") || norm.includes("short")) {
    attrs.issue = "short circuit";
  } else if (norm.includes("chingari") || norm.includes("spark")) {
    attrs.issue = "spark";
  } else if (norm.includes("dheema chal raha") || norm.includes("dheere chal raha") || norm.includes("dheema hai") || norm.includes("dheema")) {
    attrs.issue = "slow";
  } else if (norm.includes("awaaz aa rahi") || norm.includes("awaaz kar rahe") || norm.includes("awaaz")) {
    attrs.issue = "noise";
  } else if (norm.includes("chal nahi raha") || norm.includes("band hai")) {
    attrs.issue = "not working";
  }

  // Baker attributes
  const flavMatch = norm.match(/\b(butterscotch|coffee|red\s*velvet|pineapple|black\s*forest|vanilla|strawberry|mango|chocolate)\b/i);
  if (flavMatch) {
    attrs.flavour = flavMatch[1].toLowerCase();
  }

  const weightMatch = norm.match(/(\d+(?:\.\d+)?)\s*kg\b/i);
  if (weightMatch) {
    attrs.weight_kg = parseFloat(weightMatch[1]);
  }

  const tierMatch = norm.match(/\b(\d+)\s*tier\b/i);
  if (tierMatch) {
    attrs.tier = parseInt(tierMatch[1], 10);
  }

  const shapeMatch = norm.match(/\b(round|square|heart)(?:\s*shape)?\b/i);
  if (shapeMatch) {
    attrs.shape = shapeMatch[1].toLowerCase();
  }

  if (norm.includes("eggless") || norm.includes("egg free")) {
    attrs.egg_free = true;
  } else if (/\b(?:normal\s+)?ande\s*wal[eia]/i.test(norm) || /\bande\s*wal[eia]/i.test(norm)) {
    attrs.egg_free = false;
  }

  // Tiffin attributes
  const daysMatch = norm.match(/\b(\d+)\s*din\s*(?:ke\s*liye|dinner|lunch|breakfast|subah|sham)\b/i) || norm.match(/\b(\d+)\s*din\b(?!\s*me)/i);
  if (daysMatch) {
    attrs.days = parseInt(daysMatch[1], 10);
  }

  const rotiMatch = norm.match(/\b(\d+)\s*roti\b/i);
  if (rotiMatch) {
    attrs.roti_count = parseInt(rotiMatch[1], 10);
  }

  const mealMatch = norm.match(/\b(breakfast|lunch|dinner)\b/i);
  if (mealMatch) {
    attrs.meal = mealMatch[1].toLowerCase();
  }

  if (norm.includes("aadha portion") || norm.includes("aadha quantity") || (norm.includes("aadha") && !norm.includes("aadha sleeve"))) {
    attrs.portion = "half";
  } else if (norm.includes("pura portion") || norm.includes("pura quantity")) {
    attrs.portion = "full";
  } else if (norm.includes("zyada portion") || norm.includes("zyada quantity") || norm.includes("zyada")) {
    attrs.portion = "extra";
  }

  if (norm.includes("tez") || norm.includes("spicy")) {
    attrs.spice_level = "spicy";
  } else if (norm.includes("normal masala") || (norm.includes("normal") && !norm.includes("normal ande"))) {
    attrs.spice_level = "medium";
  } else if (norm.includes("kam mirchi") || norm.includes("mild")) {
    attrs.spice_level = "mild";
  }

  if (norm.includes("jain nahi")) {
    attrs.jain = false;
  } else if (norm.includes("jain wala") || norm.includes("jain")) {
    attrs.jain = true;
  }

  return attrs;
}

export function parseOrderHeuristic(rawText: string, baseDateInput: Date | string = new Date()): OrderRecord {
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

  const baseDate = typeof baseDateInput === "string" ? new Date(baseDateInput) : baseDateInput;
  const normalized = normalizeText(rawText);

  // 1. Customer
  const customer = parseCustomer(rawText);

  // 2. Date
  const dateResult = parseRelativeDate(rawText, baseDate);
  const due_date = dateResult.date;

  // 3. Amount
  const amountResult = parseAmount(rawText);
  const amount = amountResult.amount;

  // 4. References Prior Order
  const references_prior_order = parseReferencesPriorOrder(rawText);

  // 5. Items Parsing with Negation Filtering
  const items: OrderItem[] = [];

  // Isolate only domain item negations (e.g. "shirt nahi", "geyser nahi", "poha nahi") without breaking "chal nahi raha" or "jain nahi"
  const prepText = normalized.replace(/(\b(?:shirt|shart|geyser|gizer|socket|wiring|inverter|switchboard|switch board|pankha|fan|ceiling fan|cake|kek|birthday cake|cheesecake|pastry|cookie|cookies|brownie|bread|roti|poha|sabzi|sabji|rajma|chole|chhole|daal|dal|khichdi|suit|pant|pent|blouse|salwar|shalwar|sherwani|kurta|kurti|cotton kurti|koti|thali|idli|dahi|curd|tubelight|tube light|mcb|doorbell|ghanti|kameez|dupatta)\s+(?:ko\s+)?nahi)\b/gi, "$1, ");

  // Split into major clauses by punctuation or connectors
  const rawClauses = prepText.split(/\n|(?<!\d)\.(?!\d)|,|\baur\b(?!\s+(?:balcony|kitchen|bathroom|hall|bedroom|terrace|dono)\b)/i);

  // List of recognized core domain keywords (sorted with compound phrases first)
  const recognizedKeywords = [
    "waistcoat", "koti", "west coat", "pant", "pent", "pajama", "pyjama", "blouse", "shirt", "shart", "suit", "cotton kurti", "kurti", "kurta", "kameez", "salwar", "shalwar", "lehenga", "lehnga", "sherwani", "dupatta",
    "socket", "plug point", "wiring", "switchboard", "switch board", "inverter", "invertor", "geyser", "gizer", "exhaust fan", "chimney fan", "exaust fan", "ceiling fan", "pankha", "doorbell", "door bell", "ghanti", "water motor", "motor", "tubelight", "tube light", "mcb", "fuse box", "ac point",
    "birthday cake", "bday cake", "cheesecake", "cheese cake", "pastry", "cookies", "cookie", "biscuit", "bread loaf", "bread", "muffin", "cupcake", "cup cake", "donut", "doughnut", "brownie", "browni", "cake", "kek",
    "rajma", "curd", "dahi", "paneer sabzi", "paneer", "sabzi", "sabji", "paratha", "parantha", "thali", "idli", "chole", "chhole", "poha", "pohe", "khichdi", "dal", "daal", "roti", "rice", "chawal",
    "पजामा", "दुपट्टा", "लहंगा", "सलवार", "शर्ट", "ब्लाउज", "कुर्ता", "कमीज", "सूट", "शेरवानी",
    "सॉकेट", "गीजर", "घंटी", "मोटर", "पंखे", "पंखा", "ट्यूब लाइट", "ट्यूबलाइट", "वायरिंग",
    "दही", "थाली", "इडली", "इड़ली", "ईडली", "छोले", "खिचड़ी", "पोहा", "पोहे", "पराठा", "पराठे", "राजमा", "दाल", "सब्जी", "चावल", "रोटी",
    "पेस्ट्री", "ब्राउनी", "ब्रेड", "डोनट", "मफिन", "कपकेक", "केक"
  ];

  for (let i = 0; i < rawClauses.length; i++) {
    let clause = rawClauses[i].trim();
    if (!clause) continue;
    const lowerClause = clause.toLowerCase();

    // Check if the clause starts with or contains an item negation (e.g. "shirt nahi", "geyser nahi", "dal nahi")
    const isNegatedItem = recognizedKeywords.some(kw => {
      const negRegex = new RegExp(`\\b${kw}\\s+(?:ko\\s+)?nahi\\b`, "i");
      return negRegex.test(lowerClause);
    });

    if (isNegatedItem) {
      continue;
    }

    // Check if this clause is an appliance/room symptom modifier on an existing electrician item (e.g. "motor aur balcony dono jagah current aa raha hai", "motor aur geyser dono me short ho gaya")
    const isSymptomModifier = items.length > 0 &&
      /\b(dono\s*jagah|dono\s*me)\b/i.test(lowerClause) &&
      !/\b(?:ek|do|teen|char|paanch|chhe|saat|aath|nau|das|\d+)\s+[a-zA-Z\u0900-\u097F]+/i.test(lowerClause);

    if (isSymptomModifier) {
      const lastItem = items[items.length - 1];
      if (["geyser", "inverter", "mcb", "switch board", "exhaust fan", "ceiling fan", "tube light", "socket", "wiring", "water motor", "ac point"].includes(lastItem.description)) {
        const additionalAttrs = extractItemAttributes(clause, lastItem.description);
        Object.assign(lastItem.attributes, additionalAttrs);
        continue;
      }
    }

    // Identify which recognized item keywords appear in this clause
    const matchedKws = recognizedKeywords.filter(kw => {
      if (kw === "roti") {
        if (/\b\d+\s*roti\s*ke\s*saath\b/i.test(lowerClause)) return false;
        if (items.length > 0 && /^\s*(?:\d+|ek|do|teen|char|paanch)\s*roti\b/i.test(lowerClause) && !/\b(?:chahiye|bhej|dena|aur|roz|din\s*ke\s*liye|jain|breakfast|dinner)\b/i.test(lowerClause)) {
          const lastDesc = items[items.length - 1].description;
          if (["thali", "chole", "dal", "sabzi", "khichdi", "paneer sabzi", "rice", "curd", "roti"].includes(lastDesc)) return false;
        }
        if (items.some(it => it.description === "roti") && /\b\d+\s*roti\s*(?:zyada|extra|rakhna)\b/i.test(lowerClause)) {
          return false;
        }
      }
      const wordRegex = new RegExp(`\\b${kw}\\b`, "i");
      return wordRegex.test(lowerClause);
    });

    if (matchedKws.length > 0) {
      matchedKws.sort((a, b) => b.length - a.length);
      const chosenKw = matchedKws[0];
      const canonicalDesc = normalizeDomainItem(chosenKw);

      // Check if this is a repeat specification clause for an already declared item (e.g. "pastry round eggless coffee wali", "sabji dinner me 3 roti ke saath")
      const existingItemIndex = items.findIndex(it => it.description === canonicalDesc && Object.keys(it.attributes).length === 0);
      
      const countMatch = lowerClause.match(new RegExp(`(?:(\\d+)|\\b(ek|do|teen|char|paanch|chhe|saat|aath|nau|das)\\b)\\s+(?:piece|pcs|plate|dabba|packet|bori)?\\s*(?:[a-zA-Z\\s]{0,15})?\\b${chosenKw}\\b`, "i"));
      const hasExplicitNewCount = countMatch !== null;

      if (existingItemIndex !== -1 && !hasExplicitNewCount) {
        const targetItem = items[existingItemIndex];
        const additionalAttrs = extractItemAttributes(clause, canonicalDesc);
        Object.assign(targetItem.attributes, additionalAttrs);
        continue;
      }

      // Extract quantity for this item
      let qty = 1;

      // Range check: "do ya teen" -> 2, "paanch ya chhe" -> 5
      const rangeMatch = lowerClause.match(/\b(ek|do|teen|char|paanch|chhe)\s+ya\s+(do|teen|char|paanch|chhe|saat)\b/i) ||
                         lowerClause.match(/\b(\d+)\s+ya\s+(\d+)\b/i);
      if (rangeMatch) {
        const lowerBound = isNaN(Number(rangeMatch[1])) ? numWords[rangeMatch[1].toLowerCase()] : parseInt(rangeMatch[1], 10);
        qty = lowerBound || 1;
      } else {
        const qtyRegex = new RegExp(`(?:(\\d+)|\\b(ek|do|teen|char|paanch|chhe|saat|aath|nau|das)\\b)\\s+(?:ya\\s+\\w+\\s+)?(?:[a-zA-Z\\s]*?)?\\b${chosenKw}\\b`, "i");
        const qtyPostRegex = new RegExp(`\\b${chosenKw}\\b\\s+(?:(\\b\\d+\\b)|\\b(ek|do|teen|char|paanch|chhe|saat|aath|nau|das)\\b)(?!\\s*(?:watt|rs|rupees|kg|din|tier|tarikh|tareekh|roti|plate|piece|sleeve|\\/|\\.))`, "i");
        
        const mPre = lowerClause.match(qtyRegex);
        const mPost = lowerClause.match(qtyPostRegex);

        if (mPre) {
          const val = mPre[1] || mPre[2];
          qty = isNaN(Number(val)) ? numWords[val.toLowerCase()] : parseInt(val, 10);
        } else if (mPost) {
          const val = mPost[1] || mPost[2];
          qty = isNaN(Number(val)) ? numWords[val.toLowerCase()] : parseInt(val, 10);
        } else {
          const anyNum = lowerClause.match(/(?<![\/\d])\b(\d+)\b(?!\s*(?:kg|watt|tier|din|roti|tarikh|tareekh|rs|rupees|percent|%|\/|\.|sleeve|chest|length|waist))/i);
          if (anyNum && parseInt(anyNum[1], 10) <= 20) {
            qty = parseInt(anyNum[1], 10);
          }
        }
      }

      const attributes = extractItemAttributes(clause, canonicalDesc);

      items.push({
        description: canonicalDesc,
        quantity: Math.max(1, Math.round(qty)),
        attributes
      });
    } else if (items.length > 0) {
      // Shared roti/attributes modifier (e.g. "8 roti ke saath dono me, 5 din breakfast ke liye", "2 roti zyada rakhna")
      if (/\b\d+\s*roti\s*ke\s*saath\b/i.test(lowerClause) || /\b\d+\s*roti\s*(?:zyada|extra|rakhna)\b/i.test(lowerClause)) {
        const rotiMatch = lowerClause.match(/\b(\d+)\s*roti\b/i);
        const rotiCount = rotiMatch ? parseInt(rotiMatch[1], 10) : undefined;
        const additionalAttrs = extractItemAttributes(clause, "tiffin");
        if (rotiCount) additionalAttrs.roti_count = rotiCount;

        if (lowerClause.includes("dono me") || lowerClause.includes("dono")) {
          items.forEach(it => {
            if (["thali", "chole", "dal", "sabzi", "khichdi", "paneer sabzi", "rice", "idli", "curd", "roti"].includes(it.description)) {
              Object.assign(it.attributes, additionalAttrs);
            }
          });
        } else {
          const lastItem = items[items.length - 1];
          if (["thali", "chole", "dal", "sabzi", "khichdi", "paneer sabzi", "rice", "idli", "curd", "roti"].includes(lastItem.description)) {
            Object.assign(lastItem.attributes, additionalAttrs);
          }
        }
        continue;
      }

      // Symptom or general modifier on last item
      const lastItem = items[items.length - 1];
      const additionalAttrs = extractItemAttributes(clause, lastItem.description);
      Object.assign(lastItem.attributes, additionalAttrs);
    }
  }

  // 6. Needs Clarification Calibration
  let needs_clarification = false;

  const vagueTriggers = [
    /\b(next\s*week\s*kabhi\s*bhi|mahine\s*ke\s*end\s*tak|season\s*shuru\s*hone\s*se\s*pehle|diwali\s*se\s*pehle|festival\s*se\s*pehle|shaadi\s*se\s*pehle|exam\s*ke\s*baad|jab\s*ho\s*jaye|jab\s*time\s*mile|jitna\s*jaldi\s*ho\s*sake|asap|thoda\s*jaldi\s*dekh\s*lo|jaldi\s*aa\s*jao|agle\s*mahine)\b/i,
    /\b(do\s*ya\s*teen|teen\s*ya\s*char|paanch\s*ya\s*chhe|chhe\s*ya\s*saat|\d+\s*ya\s*\d+|३\s*ya\s*४)\b/i,
    /\b(kuch\s*acha\s*sa|aap\s*decide\s*kar\s*lo|aap\s*samajh\s*gaye|wo\s*silwana\s*tha|wahi\s*roz\s*wala|wahi\s*wala\s*kaam)\b/i,
    /\b(thoda\s*jaldi\s*ho\s*jaye|zara|dekh\s*lena\s*zara)\b/i
  ];

  if (items.length === 0) {
    needs_clarification = true;
  } else {
    for (const pat of vagueTriggers) {
      if (pat.test(normalized)) {
        needs_clarification = true;
        break;
      }
    }
  }

  // Electrician domain: if items exist but no issue is specified across any item, needs clarification
  const isElectricianOrder = items.some(it => ["inverter", "wiring", "geyser", "switch board", "socket", "tube light", "mcb", "exhaust fan", "ceiling fan", "doorbell", "water motor", "ac point"].includes(it.description));
  const hasElectricianIssue = items.some(it => it.attributes && it.attributes.issue);
  if (isElectricianOrder && !hasElectricianIssue) {
    needs_clarification = true;
  }

  // Baker domain: if cakes/cheesecake/brownie/cookies/pastry/muffin/donut ordered without flavour and without prior-order reference, needs clarification
  const isBakerOrder = items.some(it => ["birthday cake", "cake", "cheesecake", "pastry", "cookies", "muffin", "donut", "brownie"].includes(it.description));
  const hasBakerFlavour = items.some(it => it.attributes && it.attributes.flavour);
  if (isBakerOrder && !hasBakerFlavour && !references_prior_order) {
    needs_clarification = true;
  }

  // If due_date is missing and urgent / open delivery is requested
  if (!due_date && /\b(urgent|jaldi\s*bhej|jaldi\s*aa\s*jao|jaldi\s*dekh\s*lo|jaldi\s*chahiye|kabhi\s*bhi)\b/i.test(normalized)) {
    needs_clarification = true;
  }

  // Confidence
  let confidence = 1.0;
  if (items.length === 0) {
    confidence = 0.1;
  } else if (needs_clarification) {
    confidence = 1.0;
  }

  return {
    customer,
    items,
    due_date,
    amount,
    references_prior_order,
    confidence,
    needs_clarification
  };
}


