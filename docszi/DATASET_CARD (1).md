# Dev-Craft — Dataset Card & Scoring Addendum

This document is **normative**. Where the Technical Brief is silent, this decides. It does not
change any field name or type in `schema.json` — the output contract is exactly as published.

Read this before you write your parser. Four things below are worth marks.

---

## 1. Files you have

| File | What it is |
|---|---|
| `messages_train.json` | 250 labelled messages. Your development and validation set. |
| `schema.json` | The output contract, plus the attribute key vocabulary. |
| `score.py` | **The exact scorer judges will run for Test A.** Run it against train constantly. |
| `sample_submission.json` | The output shape the scorer accepts. |
| `conflict_scenarios.md` | Three offline-edit sequences your sync layer must handle. |

At judging you receive `messages_test_inputs.json` — 50 held-out messages in the same input
format, with `expected` removed. Your system must consume that file and emit predictions.

---

## 2. Input format — `received_at` is the date anchor

Every record you are given looks like this:

```json
{
  "id": "train-0007",
  "domain": "tailor",
  "received_at": "2026-08-29T10:14:00+05:30",
  "message": "bhaiya 2 kurta chahiye navy blue, chest 40, parso tak ho jayega kya? last time jaisa hi"
}
```

**`received_at` is when the message arrived, in Asia/Kolkata.** Every relative date resolves
against it — `parso` is two days after `received_at`, not two days after today. A parser that
resolves against the system clock will fail Test A on almost every dated message.

`domain` is given. You may use it or ignore it.

Your output is the seven `schema.json` fields, keyed by `id`. `received_at` and `domain` are
inputs only — do not emit them.

---

## 3. `needs_clarification` — the decision rule

This is 20% of Test A and it is not a judgment call. Set it to `true` **if and only if** at
least one of the following holds:

- **(a)** No identifiable item — the message orders *something* but never says what.
- **(b)** A quantity is referenced but is unreadable or self-contradictory — `"do ya teen kurta"`.
  **Convention: record the FIRST stated value** (`quantity: 2`) *and* set the flag.
  Do not average, do not take the larger, do not drop the item.
- **(c)** A deadline is referenced but cannot be resolved to a calendar date — `jaldi`, `asap`,
  `urgent`, `jab ho jaye`, `festival se pehle`, `next week kabhi bhi`, `agle mahine`,
  `mahine ke end tak`, `diwali se pehle`, `shaadi se pehle`, `exam ke baad`, `jab time mile`.
  **This list is illustrative, not exhaustive.** The test is whether the phrase pins down a
  single calendar date, not whether it appears in a keyword list.
- **(d)** A **blocking attribute** is missing, so the order genuinely cannot be started:

  | Domain | Blocking attribute | Why it blocks |
  |---|---|---|
  | `baker` | `flavour` | you cannot bake a cake without knowing the flavour |
  | `electrician` | `issue` | you cannot bring the right parts for an unnamed fault |

  For a multi-item message, it must be missing from **every** item to trigger this.

  **Only these two domains.** A `tailor` order with no `chest` and a `tiffin` order with no
  `meal` are *underspecified, not unfulfillable* — the tailor has measurements on file and the
  tiffin service has a standing meal schedule. Those are `needs_clarification: false`, with the
  attribute simply absent from `attributes`. Do not flag them.

### The distinction that decides this criterion

**A field that is simply absent and never referenced is `null`, not a clarification.**

| Message | `due_date` | `needs_clarification` |
|---|---|---|
| `"kurta chahiye"` | `null` | `false` — no deadline was ever mentioned |
| `"kurta chahiye jaldi"` | `null` | `true` — a deadline *was* referenced and cannot be resolved |

Guessing a date for `jaldi` scores worse than flagging it. The brief says confident wrong
answers score worse than flagged uncertainty; this is where that is measured.

---

## 4. Date resolution conventions

All dates resolve against `received_at` in **Asia/Kolkata**, and are emitted as `YYYY-MM-DD`.

| Phrase | Resolves to |
|---|---|
| `aaj` / `kal` / `parso` / `narsu`, `tarso` | +0 / +1 / +2 / +3 days |
| `agle <weekday>` / `next <weekday>` (`somvar`…`ravivar`) | the **strictly next** such weekday; if today is Tuesday, `agle mangalvar` is +7, never +0 |
| `is weekend` | the **upcoming Saturday** |
| `<N> tarikh` / `<N> tareekh` / `<N> ko` | the Nth of the current month if `N >= today`, otherwise the Nth of next month |
| `agle hafte` / `next week` | +7 days |
| `<N> din me` | +N days |
| `5 September`, `5 Sep`, `5/9` | that calendar date |
| `jaldi`, `asap`, `urgent`, `jab ho jaye`, `festival se pehle`, `next week kabhi bhi`, `agle mahine`, `mahine ke end tak`, `diwali se pehle`, `shaadi se pehle`, `exam ke baad`, `jab time mile` (not exhaustive) | `null` + `needs_clarification: true` |

**`kal` is genuinely ambiguous in Hindi** (yesterday or tomorrow). Orders are forward-looking,
so in this dataset `kal` always means **tomorrow**. This is a stated convention, not a trap.

Devanagari numerals appear in dates and quantities: `१० तारीख` is the 10th.

---

## 5. Attribute keys are a closed set

`attributes` is not free-form. Keys **must** come from the domain's list in
`schema.json` → `x-devcraft-vocabulary`:

- **tailor** — `color, fabric, chest, waist, length, sleeve, size, fit`
- **tiffin** — `portion, spice_level, meal, roti_count, jain, days`
- **electrician** — `appliance, issue, room, brand, wattage`
- **baker** — `flavour, weight_kg, egg_free, tier, message_on_cake, shape`

A key outside the list is scored as wrong. Values are compared after normalisation
(lowercased, trimmed, punctuation stripped), and numerically where both sides are numbers —
so `40`, `"40"` and `"40 "` are all the same, but `"navy"` is not `"navy blue"`.

Canonical value forms used in gold: `spice_level` ∈ mild/medium/spicy · `portion` ∈
half/full/extra · `sleeve` ∈ full/half/three-quarter · `fit` ∈ slim/regular/loose ·
`jain` and `egg_free` are booleans · `issue` ∈ not working / spark / noise / slow /
short circuit / fuse blown / leaking current.

---

## 6. How Test A is scored

```
Test A  =  0.60 × field-level extraction
         + 0.20 × date resolution
         + 0.20 × needs_clarification
```

micro-averaged over all 50 messages. Run it yourself:

```bash
python score.py --gold messages_train.json --pred my_output.json --out breakdown.json
```

**Item alignment.** Gold and predicted items are paired greedily by description token-set F1.
An item on either side that finds no partner is charged as a **full miss across all its
fields** — so padding your output with speculative items lowers your score.

**Per-field rules.**

| Field | Credit when |
|---|---|
| `description` | token-set F1 ≥ **0.80** after normalising (lowercase, punctuation stripped, `a/an/the/ka/ki/ke/wala/wali/ek` dropped) |
| `quantity` | exact integer. An unmarked item is `1`. |
| `attributes` | scored per key over the **union** of gold and predicted keys; both key and value must match |
| `customer`, `amount` | exact after normalisation; `null` vs `null` is a hit |
| `references_prior_order` | exact boolean |
| `due_date` | exact `YYYY-MM-DD`; `null` vs `null` is a hit |
| `needs_clarification` | exact boolean |

### Traps you should expect

The data deliberately punishes keyword spotting. All of these occur in both splits:

| Pattern | Example | Correct reading |
|---|---|---|
| Urgency decoy | `"jaldi chahiye, parso tak"` | the date **is** resolvable; `needs_clarification: false` |
| Weekday negation | `"somvar ko nahi, mangalvar ko"` | Tuesday, not Monday |
| Customer decoy | `"Ramesh ke liye nahi, Sunita ke liye"` | `customer: "Sunita"` |
| Negated item | `"pant nahi, sirf shirt"` | one item; `pant` is **not** ordered |
| Negated prior | `"pichli baar jaisa nahi, is baar naya"` | `references_prior_order: false` |
| Count after the noun | `"kurta 3 chahiye"` | `quantity: 3` |
| Measurement in words | `"chest chalis"`, `"assi watt"` | `40`, `80` |
| Attributes detached | items listed first, specs in a later clause | match each spec back to its item |

Hindi number words used for measurements: `athais` 28, `tees` 30, `battis` 32, `chautis` 34,
`chhattis` 36, `aadtis` 38, `chalis` 40, `bayalis` 42, `chavalis` 44, `chhiyalis` 46,
`adtalis` 48, `saath` 60, `assi` 80, `sau` 100, `hazaar` 1000, `dedh hazaar` 1500,
`do hazaar` 2000.

**`confidence` is not scored.** It is required by the schema — emit it — but it contributes
nothing to Test A. Judges may use it as a tie-break, and a well-calibrated confidence is worth
mentioning in your presentation.

**Prediction file format.** A JSON list of objects, each with `id` plus the seven schema
fields (or those fields nested under `output`). A missing `id` scores zero for that message.
See `sample_submission.json`.

---

## 7. How this data was built, and its limits

Records were sampled first and the Hinglish message was generated from the record, so **every
label is correct by construction** — no message was hand-labelled and no model was asked to
guess a label. An automated faithfulness gate then verified, for all 300 messages, that every
gold value is actually recoverable from the text and that no field absent from the label leaked
into it.

Stated honestly, because the brief rewards it:

- **Every message was written by hand**, then verified mechanically against its record.
  Devanagari appears in ~33% of train and ~34% of test messages, mixed with Roman in the same
  sentence. Spelling varies (`chahiye`/`chaiye`, `kurta`/`kurtha`, `geyser`/`gizer`).
- **Attribute keys and values are closed sets.** That is what makes scoring unambiguous, but it
  also means a team that mines the 250 train records for the vocabulary gets much of field
  extraction by lookup. Expect the field-level component to compress near the top; date
  resolution and `needs_clarification` are where scores actually separate.
- **The held-out 50 come from the same sampler with a different seed and a different stylistic
  register.** No message and no phrasing skeleton is shared between train and test.
- **Domain mix:** tailor 70, tiffin 65, electrician 60, baker 55 in train; 14/13/12/11 in test.
- **`message_on_cake` is in the vocabulary but does not occur in gold.** It is reserved; do not
  expect to be scored on it.
- Amounts are plain INR integers. No currency conversion, no per-unit pricing.
