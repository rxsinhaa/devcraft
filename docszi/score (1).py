"""Official Dev-Craft Test A scorer.

    python score.py --gold messages_test.json --pred my_output.json

Test A = 0.60 * field-level extraction + 0.20 * date resolution + 0.20 * needs_clarification,
micro-averaged over every message. This is the exact file judges run. Standard library only.

Prediction file: a JSON list (or {"results": [...]}) of objects carrying "id" plus the seven
schema fields, either at the top level or nested under "output"/"expected"/"result".
"""
from __future__ import annotations

import argparse
import json
import re
import sys
from pathlib import Path
from typing import Any

W_FIELD, W_DATE, W_CLARIFY = 0.60, 0.20, 0.20
DESC_MATCH_THRESHOLD = 0.80
STOPWORDS = {"a", "an", "the", "ka", "ki", "ke", "wala", "wali", "ek"}
_PUNCT = re.compile(r"[^\w\sऀ-ॿ]+", re.UNICODE)


# ----------------------------------------------------------------- normalisation helpers

def norm_text(value: Any) -> str:
    """Lowercase, strip punctuation, collapse whitespace."""
    return re.sub(r"\s+", " ", _PUNCT.sub(" ", str(value).lower())).strip()


def tokens(value: Any) -> set[str]:
    """Content tokens of a description, used for fuzzy item matching."""
    return {t for t in norm_text(value).split() if t not in STOPWORDS} or {norm_text(value)}


def token_f1(a: Any, b: Any) -> float:
    """Token-set F1 between two descriptions."""
    ta, tb = tokens(a), tokens(b)
    overlap = len(ta & tb)
    return 0.0 if not overlap else 2 * overlap / (len(ta) + len(tb))


def norm_value(value: Any) -> Any:
    """Canonical form for attribute / scalar comparison. Numeric-aware: 40 == '40'."""
    if value is None:
        return None
    if isinstance(value, bool):
        return "true" if value else "false"
    if isinstance(value, (int, float)):
        return float(value)
    text = norm_text(value)
    try:
        return float(text)
    except ValueError:
        return text


def same(a: Any, b: Any) -> bool:
    """Equality after normalisation; null == null counts as a hit."""
    return norm_value(a) == norm_value(b)


# ------------------------------------------------------------------------------ alignment

def align_items(gold: list[dict], pred: list[dict]) -> tuple[list[tuple[dict, dict]], int, int]:
    """Greedily pair gold and predicted items by description F1.

    Returns (pairs, unmatched_gold, unmatched_pred). Unmatched items on either side are
    charged as full misses, so padding the output with speculative items cannot help.
    """
    candidates = sorted(
        ((token_f1(g.get("description", ""), p.get("description", "")), gi, pi)
         for gi, g in enumerate(gold) for pi, p in enumerate(pred)),
        key=lambda t: -t[0])
    used_g: set[int] = set()
    used_p: set[int] = set()
    pairs: list[tuple[dict, dict]] = []
    for score, gi, pi in candidates:
        if score <= 0 or gi in used_g or pi in used_p:
            continue
        used_g.add(gi)
        used_p.add(pi)
        pairs.append((gold[gi], pred[pi]))
    return pairs, len(gold) - len(used_g), len(pred) - len(used_p)


def score_items(gold: list[dict], pred: list[dict]) -> tuple[float, float]:
    """Credit and slot count across description, quantity and attributes."""
    pairs, miss_g, miss_p = align_items(gold, pred)
    credit = slots = 0.0

    for g, p in pairs:
        slots += 2
        if token_f1(g.get("description", ""), p.get("description", "")) >= DESC_MATCH_THRESHOLD:
            credit += 1
        if same(g.get("quantity"), p.get("quantity")):
            credit += 1
        ga, pa = g.get("attributes") or {}, p.get("attributes") or {}
        for key in set(ga) | set(pa):
            slots += 1
            if key in ga and key in pa and same(ga[key], pa[key]):
                credit += 1

    for item in [g for g in gold if all(g is not x for x, _ in pairs)]:
        slots += 2 + len(item.get("attributes") or {})       # missed gold item: full miss
    for _ in range(miss_p):
        slots += 2                                           # spurious predicted item
    return credit, slots


# --------------------------------------------------------------------------------- scoring

def score_record(gold: dict, pred: dict) -> dict[str, Any]:
    """Score one message across the three measured components."""
    credit, slots = score_items(gold.get("items") or [], pred.get("items") or [])
    for field in ("customer", "amount", "references_prior_order"):
        slots += 1
        if same(gold.get(field), pred.get(field)):
            credit += 1

    date_hit = same(gold.get("due_date"), pred.get("due_date"))
    clarify_hit = bool(gold.get("needs_clarification")) == bool(pred.get("needs_clarification"))
    field_acc = credit / slots if slots else 1.0
    return {
        "field_accuracy": field_acc,
        "date_hit": date_hit,
        "clarification_hit": clarify_hit,
        "total": W_FIELD * field_acc + W_DATE * date_hit + W_CLARIFY * clarify_hit,
    }


# ----------------------------------------------------------------------------------- io

def _rows(blob: Any) -> list[dict]:
    if isinstance(blob, dict):
        for key in ("results", "records", "messages", "data"):
            if isinstance(blob.get(key), list):
                return blob[key]
        return [dict(v, id=k) for k, v in blob.items() if isinstance(v, dict)]
    return blob


def _payload(row: dict) -> dict:
    for key in ("expected", "output", "result", "record", "prediction"):
        if isinstance(row.get(key), dict):
            return row[key]
    return row


def load(path: Path) -> dict[str, dict]:
    """Read a gold or prediction file into {id: record}."""
    rows = _rows(json.loads(path.read_text(encoding="utf-8")))
    return {str(r.get("id", i)): _payload(r) for i, r in enumerate(rows)}


def main() -> int:
    ap = argparse.ArgumentParser(description="Dev-Craft Test A scorer")
    ap.add_argument("--gold", required=True, type=Path)
    ap.add_argument("--pred", required=True, type=Path)
    ap.add_argument("--out", type=Path, help="write the per-message breakdown here")
    args = ap.parse_args()

    gold, pred = load(args.gold), load(args.pred)
    missing = [k for k in gold if k not in pred]
    rows = []
    for mid, g in gold.items():
        p = pred.get(mid) or {}
        row = score_record(g, p)
        row["id"] = mid
        rows.append(row)

    n = len(rows) or 1
    field = sum(r["field_accuracy"] for r in rows) / n
    dates = sum(r["date_hit"] for r in rows) / n
    clar = sum(r["clarification_hit"] for r in rows) / n
    total = W_FIELD * field + W_DATE * dates + W_CLARIFY * clar

    print(f"\n  messages scored        {len(rows)}")
    if missing:
        print(f"  MISSING PREDICTIONS    {len(missing)}  (scored as zero) e.g. {missing[:5]}")
    print(f"\n  {'measure':<26}{'score':>8}{'weight':>9}{'contribution':>14}")
    print(f"  {'-' * 57}")
    print(f"  {'field-level extraction':<26}{field:>8.3f}{W_FIELD:>9.0%}{W_FIELD * field:>14.3f}")
    print(f"  {'date resolution':<26}{dates:>8.3f}{W_DATE:>9.0%}{W_DATE * dates:>14.3f}")
    print(f"  {'needs_clarification':<26}{clar:>8.3f}{W_CLARIFY:>9.0%}{W_CLARIFY * clar:>14.3f}")
    print(f"  {'-' * 57}")
    print(f"  {'TEST A':<26}{'':>8}{'':>9}{total:>14.3f}\n")

    if args.out:
        args.out.write_text(json.dumps(
            {"summary": {"field_accuracy": field, "date_accuracy": dates,
                         "clarification_accuracy": clar, "test_a": total,
                         "scored": len(rows), "missing": missing},
             "per_message": rows}, indent=2), encoding="utf-8")
        print(f"  breakdown -> {args.out}\n")
    return 0


if __name__ == "__main__":
    sys.exit(main())
