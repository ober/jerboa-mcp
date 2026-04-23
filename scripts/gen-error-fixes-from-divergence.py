#!/usr/bin/env python3
"""Generate per-identifier error-fix entries from divergence.json.

For every divergence entry whose `wrong` form is a simple identifier and
whose severity is 'error' or 'compat', produce an error-fix entry that
matches Chez's unbound-variable error for that specific identifier.

Pattern format matches the existing error-fixes.json style (Python re,
case-insensitive). The pattern is constructed to match:

    Exception: variable FOO is not bound
    Unhandled exception: unbound identifier FOO

where FOO is the hallucinated name, word-boundary anchored.

Merges into error-fixes.json in-place, skipping IDs already present.
"""
import argparse
import json
import re
from pathlib import Path

SIMPLE_ID = re.compile(r'^[A-Za-z_\-+*/<>=!?0-9$%&^~.]+$')


def to_pattern(name):
    """Build a regex matching Chez unbound-variable error for this name."""
    # Escape regex metachars in the identifier.
    escaped = re.escape(name)
    return rf"(variable\s+{escaped}\s+is\s+not\s+bound|unbound\s+identifier\s+{escaped})"


def entry_from_divergence(d):
    w = d["wrong"]
    if not SIMPLE_ID.match(w):
        return None
    if d["severity"] not in ("error", "compat"):
        return None

    eid = f"hallucinated-{d['id']}"

    avail = d.get("available_via") or []
    if avail:
        fix = (
            f"'{w}' is not in the prelude. Import one of: "
            + ", ".join(avail)
            + f". Or use the Jerboa idiom: {d['correct']}."
        )
        err_type = "Compat Import Needed"
    else:
        fix = (
            f"'{w}' does not exist in Jerboa/Chez. "
            f"Use {d['correct']} instead. See divergence catalog id '{d['id']}'."
        )
        err_type = "Hallucinated Identifier"

    out = {
        "id": eid,
        "pattern": to_pattern(w),
        "type": err_type,
        "message": f"'{w}' is not a Jerboa identifier (from {', '.join(d['wrong_source'])})",
        "explanation": d.get("notes", "") or (
            f"LLMs commonly reach for '{w}' from "
            f"{', '.join(d['wrong_source'])} training data. "
            f"Jerboa uses '{d['correct']}'."
        ),
        "fix": fix,
        "code_example": d["correct_example"],
        "wrong_example": d["wrong_example"],
        "imports": d.get("imports", []) or avail[:1],
        "related_divergence": d["id"],
    }
    return out


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--divergence", default="divergence.json")
    ap.add_argument("--error-fixes", default="error-fixes.json")
    ap.add_argument("--out", default="error-fixes.json")
    ap.add_argument("--dry-run", action="store_true")
    args = ap.parse_args()

    div = json.loads(Path(args.divergence).read_text())
    existing = json.loads(Path(args.error_fixes).read_text())
    existing_ids = {e["id"] for e in existing}

    new_entries = []
    skipped = 0
    for d in div["entries"]:
        e = entry_from_divergence(d)
        if e is None:
            continue
        if e["id"] in existing_ids:
            skipped += 1
            continue
        new_entries.append(e)

    merged = existing + new_entries

    if not args.dry_run:
        Path(args.out).write_text(json.dumps(merged, indent=2))
    print(f"Existing entries: {len(existing)}")
    print(f"Generated:        {len(new_entries)}")
    print(f"Skipped (dup id): {skipped}")
    print(f"Total after:      {len(merged)}")
    if not args.dry_run:
        print(f"Wrote {args.out}")


if __name__ == "__main__":
    main()
