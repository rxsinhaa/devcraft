# Offline-First Order Management System PWA

A high-performance, resilient, local-first Progressive Web App (PWA) designed for micro-enterprises operating in emerging economies with severe and unpredictable network partitions. It allows operators to manage order intakes, parse unstructured Hinglish/Devanagari messages into structured commerce records, track financial outstanding balances, and synchronize data across devices with deterministic conflict resolution.

---

## 1. Core Technology Stack

The application employs a modern, offline-first client architecture built to minimize network dependencies and run smoothly on mid-range Android devices:

* **Framework**: Next.js 16 (App Router) with React 19.
* **Service Worker & PWA Caching**: `@serwist/next` (the modern successor to `next-pwa`) managing service worker registration, static app shell caching (PrecacheAndRoute), and offline availability.
* **Client-Side Persistence**: `dexie` and `dexie-react-hooks` for reactive IndexedDB abstraction, enabling sub-millisecond, non-blocking queries and mutations.
* **Schema Validation**: `zod` for strict runtime structure enforcement, capturing LLM hallucinations or corrupted replication streams.
* **State & Synchronization**: Event-Sourced append-only mutation logs tracked by Hybrid Logical Clocks (HLC) for eventually consistent multi-device synchronization.

---

## 2. Architecture & Offline-First Data Flow

```mermaid
graph TD
    A[WhatsApp Copy-Paste Message] --> B[Hybrid Router / llmClient]
    B -->|Network Online| C[Gemini 3.6 API route]
    B -->|Network Offline / Timeout| D[Offline Heuristic Parser]
    C -->|Zod Validation Pass| E[Local Mutation Event Log]
    C -->|Zod Fail / Server Crash| D
    D --> E
    E --> F[(IndexedDB / Dexie)]
    F -->|Optimistic UI Update| G[Dashboard Page]
    E -->|Background Sync Reconnection| H[Event Synchronization Engine]
```

### Critical Render Path & sub-5MB Payload
* **Precaching**: The Serwist service worker interceptor caches all static code assets, assets (CSS, JS), and Google Web Fonts (`Outfit`) upon first load, completely bypassing the network for subsequent cold starts.
* **IndexedDB Reactivity**: React components consume IndexedDB datasets using Dexie `useLiveQuery` observables, updating the user interface instantly upon write mutations without relying on blocking API cycles.
* **Persistent Browser Storage**: Explicitly requests origin persistent storage (`navigator.storage.persist()`) during application startup, preventing browsers from evicting local data during device storage pressure.

---

## 3. NLP Parsing Pipeline

To accommodate unstable networks, the parsing engine operates on a hybrid pipeline:

### A. Primary Online Path (Gemini 3.6 Flash)
When connected, requests are sent to `/api/parse-order` leveraging Google Gemini 3.6 Flash:
* **System Prompt Constraints**: Aggressively configured to reject conversational filler/questions (e.g. *"ho jayega kya?"*, *"bhaiya"*) and filter out temporal expressions.
* **JSON Schema Enforcement**: Uses the model's native `responseSchema` and `responseMimeType: "application/json"` parameters to guarantee structural compliance.
* **Timeout Shield**: Enforces a `15000ms` (15 seconds) client timeout to prevent browser UI freezing during model cold starts.

### B. Fallback Offline Path (Algorithmic Regex Engine)
If offline, rate-limited, or timed out, processing defaults immediately to [nlpParser.ts](file:///Users/rouneet/Documents/rxcodes/rxdev/smoothatdevcraft/src/lib/nlpParser.ts):
1. **Transliteration Normalizer**: Standardizes Devanagari numerals (`०-९`) and prepositions to standard Romanized counterparts.
2. **Date & Amount Stripping**: Strips price patterns (`rs 1200`, `1200/-`) and temporal details (`kal`, `parso`, `sham tak`) from lines *first*, preventing them from leaking into the final item descriptions.
3. **Dictionary-Based Translations**: Maps common Hindi/Hinglish grocery and catering nouns to English (e.g. `aaloo` -> `potato`, `pyaaz` -> `onion`, `doodh` -> `milk`, `चीनी` -> `sugar`).
4. **Colloquial Date Math**: Translates relative tokens mathematically relative to the system date (e.g. `"parso"` -> `baseDate + 2 days`, `"agle mangalwar"` -> next Tuesday).
5. **Safety Flagging**: Sets `needs_clarification: true` for missing quantities on bulk commodities or highly ambiguous strings.

---

## 4. Deterministic Sync & Causality Clock

Replicating data across peer-to-peer or disconnected client nodes requires deterministic conflict resolution:

* **Event Sourcing**: Local database modifications are captured as immutable mutation logs (`event_log` table) recording `CREATE`, `UPDATE`, or `DELETE` events.
* **Hybrid Logical Clocks (HLC)**: Every mutation is tagged with an HLC timestamp (`physical:logical:node_id`). HLC ensures causal ordering (happens-before relationship) without requiring a centralized coordinator or synchronized device clocks.
* **Conflict Resolution**: During sync replay:
  * Concurrent updates to identical fields from different devices are caught by comparing event timestamps.
  * Rather than executing silent Last-Write-Wins (LWW) overrides, the engine suspends the automatic merge and writes the divergent properties to a `conflict_state` table.
  * A dedicated **Conflict Resolution Modal** blocks operation on that record until the operator manually selects the correct state.

---

## 5. Operational Dashboard (Epic 4 Queries)

Designed as a non-scrolling single-viewport cockpit, the query layer answers four core operational directives:
1. **Temporal Triage**: Separates items due today (Amber alert) and past due incomplete items (Rose alert).
2. **Financial Outstanding Debt**: Consolidates unpaid customer debt in a descending ledger grouped by customer name.
3. **Historical Continuity**: Pulls the attributes (e.g. sizes, units) of the chosen customer's most recent order to pre-fill repeated requests.
4. **Capacity Planner**: Aggregates rolling 7-day workload quantities against a threshold (60 units) to visually warn operators when fully committed.

---

## 6. Known System Limitations

* **Colloquial Date Parser**: The offline fallback engine is designed for standard relative dates. It cannot resolve highly complex, nested temporal prose, obscure regional dialects, or financial quarter references.
* **Replication Storage Cost**: Because of event sourcing, the `event_log` table grows indefinitely as mutations are registered. Long-term operations will require a compaction/snapshotting strategy to avoid browser quota limits.
* **IndexedDB Origin Constraints**: iOS/Safari and Android/Chrome enforce dynamic client storage limits (ranging from 1GB to 60% of free disk space). Under critical low space, the browser might warn of `QuotaExceededError` if the origin fails to secure persistent status.
