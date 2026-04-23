#!/usr/bin/env python3
"""Diff two api-signatures.json snapshots and emit a changelog entry.

Given an OLD (baseline) and NEW snapshot, compute:
  - added:   symbols present in NEW, absent in OLD
  - removed: symbols present in OLD, absent in NEW
  - moved:   symbols whose primary module changed
  - tier_changes: modules whose tier changed

Renames are NOT auto-detected (they look like simultaneous add+remove);
they must be recorded manually in the entry's `renamed` list.

Output: a JSON object suitable for appending to changelog.json's entries[].

Usage:
    python3 scripts/diff-api-signatures.py \\
        --old api-signatures.prev.json \\
        --new api-signatures.json \\
        [--append-to changelog.json] \\
        [--date 2026-04-22]
"""
import argparse
import json
from datetime import date as Date
from pathlib import Path


def load(path):
    return json.loads(Path(path).read_text())


def primary_module(snapshot, sym):
    """Return the first-listed providing module for sym, or None."""
    mods = snapshot.get("symbol_index", {}).get(sym)
    return mods[0] if mods else None


def diff_snapshots(old, new):
    old_syms = set(old.get("symbol_index", {}).keys())
    new_syms = set(new.get("symbol_index", {}).keys())

    added = sorted(new_syms - old_syms)
    removed = sorted(old_syms - new_syms)

    # Moves: symbols in both, primary module changed
    moved = []
    for sym in sorted(old_syms & new_syms):
        a = primary_module(old, sym)
        b = primary_module(new, sym)
        if a != b:
            moved.append({"symbol": sym, "from_module": a, "to_module": b,
                          "reason": ""})

    # Tier changes per module
    old_mods = old.get("modules", {})
    new_mods = new.get("modules", {})
    tier_changes = []
    for name in sorted(set(old_mods) & set(new_mods)):
        a = old_mods[name].get("tier")
        b = new_mods[name].get("tier")
        if a and b and a != b:
            tier_changes.append({"module": name, "from": a, "to": b})

    return {
        "added": added,
        "removed": removed,
        "renamed": [],   # Manual annotation
        "moved": moved,
        "tier_changes": tier_changes,
    }


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--old", required=True, help="Baseline api-signatures.json")
    ap.add_argument("--new", required=True, help="Current api-signatures.json")
    ap.add_argument("--append-to", help="Path to changelog.json to update in-place")
    ap.add_argument("--date", default=Date.today().isoformat())
    ap.add_argument("--version", default=None, help="Optional release tag")
    ap.add_argument("--notes", default="")
    args = ap.parse_args()

    old = load(args.old)
    new = load(args.new)
    d = diff_snapshots(old, new)

    entry = {
        "date": args.date,
        "version": args.version,
        "added": d["added"],
        "removed": d["removed"],
        "renamed": d["renamed"],
        "moved": d["moved"],
        "tier_changes": d["tier_changes"],
        "notes": args.notes or (
            f"Auto-diff: +{len(d['added'])} / -{len(d['removed'])} symbols, "
            f"{len(d['moved'])} moved, {len(d['tier_changes'])} tier changes."
        ),
    }

    if args.append_to:
        cl = load(args.append_to)
        cl.setdefault("entries", []).insert(0, entry)
        Path(args.append_to).write_text(json.dumps(cl, indent=2))
        print(f"Appended entry to {args.append_to}")
    else:
        print(json.dumps(entry, indent=2))


if __name__ == "__main__":
    main()
