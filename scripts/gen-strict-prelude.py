#!/usr/bin/env python3
"""Generate lib/jerboa/prelude/strict.sls from api-signatures.json.

The strict prelude re-exports (jerboa prelude) minus the compat aliases
that cause LLMs to fall back to other-Scheme spellings. Users who want
maximum idiomatic feedback write:

    (import (jerboa prelude strict))

and any use of, e.g., hash-table-set! becomes an unbound-identifier
error pointing at the correct name.

The list of aliases to strip comes from divergence.json entries whose
severity is 'aliased'. This keeps both files in sync: adding a new
alias to the prelude + divergence.json automatically removes it from
strict on the next regeneration.
"""
import argparse
import json
import re
from datetime import date
from pathlib import Path


SIMPLE_ID = re.compile(r'^[A-Za-z_\-+*/<>=!?0-9$%&^~.]+$')


def load_strict_excludes(divergence):
    """Return set of simple-identifier aliases to strip from strict."""
    out = set()
    for e in divergence["entries"]:
        if e["severity"] != "aliased":
            continue
        w = e["wrong"]
        if SIMPLE_ID.match(w):
            out.add(w)
    return out


def render_library(exports_strict, excluded):
    lines = [
        "#!chezscheme",
        ";;; (jerboa prelude strict) — prelude with compat aliases removed.",
        ";;;",
        ";;; AUTO-GENERATED from api-signatures.json + divergence.json by",
        ";;; jerboa-mcp/scripts/gen-strict-prelude.py. Do not edit by hand.",
        ";;;",
        ";;; This variant of the prelude removes the following compat aliases",
        ";;; so that code written against it uses the native Jerboa spelling:",
    ]
    for name in sorted(excluded):
        lines.append(f";;;   {name}")
    lines.append(";;;")
    lines.append(";;; Use it with:   (import (jerboa prelude strict))")
    lines.append("")
    lines.append("(library (jerboa prelude strict)")
    lines.append("  (export")

    # Pretty-print the export list in 3 columns for readability.
    col_width = max(len(e) for e in exports_strict) + 2
    cols = 3
    for i in range(0, len(exports_strict), cols):
        row = exports_strict[i:i + cols]
        line = "    " + "".join(s.ljust(col_width) for s in row).rstrip()
        lines.append(line)

    lines.append("  )")
    lines.append("  (import (except (jerboa prelude)")

    for name in sorted(excluded):
        lines.append(f"                  {name}")
    lines.append("                  )))")
    lines.append("")
    return "\n".join(lines)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--api", default="api-signatures.json")
    ap.add_argument("--divergence", default="divergence.json")
    ap.add_argument("--out", required=True,
                    help="Path to write strict.sls (typically "
                         "jerboa/lib/jerboa/prelude/strict.sls)")
    args = ap.parse_args()

    api = json.loads(Path(args.api).read_text())
    div = json.loads(Path(args.divergence).read_text())

    prelude = api["modules"].get("(jerboa prelude)")
    if not prelude:
        raise SystemExit("(jerboa prelude) not found in api-signatures.json")

    excluded = load_strict_excludes(div)
    strict_exports = [e for e in prelude["exports"] if e not in excluded]
    strict_exports.sort()

    text = render_library(strict_exports, excluded)
    Path(args.out).write_text(text)
    print(f"Wrote {args.out}")
    print(f"  prelude exports:   {len(prelude['exports'])}")
    print(f"  strict exports:    {len(strict_exports)}")
    print(f"  removed aliases:   {len(excluded)}")
    for n in sorted(excluded):
        print(f"    - {n}")


if __name__ == "__main__":
    main()
