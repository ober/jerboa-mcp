#!/usr/bin/env python3
"""Audit divergence.json against api-signatures.json and write corrections.

For each divergence entry whose `wrong` is a simple identifier:
  - If the identifier IS exported from some module, the entry is a "compat"
    rather than a pure error: rewrite notes to say where it's available,
    downgrade severity from 'error' to 'compat' unless already 'aliased'.
  - Populate an `available_via` field listing exporting modules.
  - If the identifier is NOT exported anywhere, keep severity as-is and set
    `available_via: []` for clarity.

Leaves multi-token / parenthesized 'wrong' forms (pattern templates) alone,
since they're syntactic shapes, not symbols.
"""
import argparse
import json
import re
from pathlib import Path

SIMPLE_ID = re.compile(r'^[A-Za-z_\-+*/<>=!?0-9$%&^~.]+$')


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--divergence", default="divergence.json")
    ap.add_argument("--api", default="api-signatures.json")
    ap.add_argument("--out", default="divergence.json",
                    help="Output (default: overwrite divergence.json)")
    ap.add_argument("--dry-run", action="store_true")
    args = ap.parse_args()

    div = json.loads(Path(args.divergence).read_text())
    api = json.loads(Path(args.api).read_text())
    idx = api["symbol_index"]

    changed = 0
    for e in div["entries"]:
        w = e["wrong"]
        if not SIMPLE_ID.match(w):
            e.setdefault("available_via", None)  # N/A (pattern form)
            continue
        mods = idx.get(w, [])
        e["available_via"] = mods
        if mods and e["severity"] == "error":
            e["severity"] = "compat"
            changed += 1
            # Prepend an accurate truth-claim to notes. The pre-audit notes
            # may contain stale "doesn't exist" claims; we flag this.
            truth = f"AVAILABLE in Jerboa via: {', '.join(mods)}."
            orig = e.get("notes", "")
            if orig and not orig.startswith("AVAILABLE"):
                e["notes"] = truth + " " + orig
            else:
                e["notes"] = truth
        elif mods and e["severity"] == "warning":
            pass

    if not args.dry_run:
        Path(args.out).write_text(json.dumps(div, indent=2))
        print(f"Wrote {args.out}")
    print(f"Reclassified {changed} entries from 'error' to 'compat'")

    # Summary
    from collections import Counter
    sev = Counter(e["severity"] for e in div["entries"])
    print("Severity counts:", dict(sev))


if __name__ == "__main__":
    main()
