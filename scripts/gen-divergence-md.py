#!/usr/bin/env python3
"""Generate docs/divergence.md from divergence.json.

Single source of truth: divergence.json lives in jerboa-mcp (consumed by
jerboa_verify + error-fix lookup). The .md is regenerated from it.

Usage:
    python3 scripts/gen-divergence-md.py \
        --json divergence.json \
        --out  ../jerboa/docs/divergence.md
"""
import argparse
import json
from collections import defaultdict
from pathlib import Path

CATEGORY_ORDER = [
    "arg-order", "arity", "hash-tables", "lists", "strings", "collections",
    "records", "pattern-matching", "binding", "definitions", "control",
    "mutation", "iterators", "parameters", "predicates", "values", "methods",
    "typing", "errors", "concurrency", "process", "io", "formatting",
    "filesystem", "environment", "modules", "regex", "numerics", "bitwise",
    "bytevectors", "vectors", "symbols", "equality", "meta", "time",
    "literals", "reader-syntax", "logging", "internals",
]

SEVERITY_BADGE = {
    "error":   "**ERROR**",
    "warning": "warning",
    "aliased": "aliased (works in prelude)",
    "compat":  "compat (works via specific import)",
}

DIALECT_LABEL = {
    "gerbil": "Gerbil", "gambit": "Gambit", "racket": "Racket",
    "r6rs": "R6RS", "r7rs": "R7RS", "common-lisp": "Common Lisp",
    "clojure": "Clojure", "emacs-lisp": "Emacs Lisp",
    "srfi-1": "SRFI-1", "srfi-13": "SRFI-13", "srfi-69": "SRFI-69",
    "srfi-95": "SRFI-95", "python": "Python", "ruby": "Ruby",
    "javascript": "JavaScript", "java": "Java", "rust": "Rust",
    "c": "C", "sql": "SQL",
    "hallucination": "pure hallucination",
    "scheme-standard": "standard Scheme",
}


def format_dialects(srcs):
    labels = [DIALECT_LABEL.get(s, s) for s in srcs]
    return ", ".join(labels)


def render(data):
    entries = data["entries"]

    by_cat = defaultdict(list)
    for e in entries:
        by_cat[e["category"]].append(e)

    lines = [
        "# LLM Divergence Sheet",
        "",
        f"_Auto-generated from `jerboa-mcp/divergence.json` "
        f"(version {data['version']}, {data['generated']})._",
        f"_{len(entries)} entries._",
        "",
        "> This catalog lists identifiers and forms that LLMs commonly reach for "
        "from other Scheme dialects (Gerbil, Gambit, Racket, R6RS, R7RS, Common "
        "Lisp, Clojure, SRFI) that are **wrong in Jerboa/Chez**. Each entry pairs "
        "the hallucinated form with the correct Jerboa equivalent.",
        ">",
        "> **Severity:** `ERROR` = won't run; `warning` = runs but wrong idiom; "
        "`aliased` = hallucination now accepted as a prelude alias.",
        "",
        "## Contents",
        "",
    ]

    ordered_cats = (
        [c for c in CATEGORY_ORDER if c in by_cat]
        + sorted(c for c in by_cat if c not in CATEGORY_ORDER)
    )

    for cat in ordered_cats:
        lines.append(f"- [{cat}](#{cat}) ({len(by_cat[cat])})")
    lines.append("")

    for cat in ordered_cats:
        lines.append(f"## {cat}")
        lines.append("")
        for e in by_cat[cat]:
            title = f"### `{e['wrong']}` → `{e['correct']}`"
            lines.append(title)
            lines.append("")
            sev = SEVERITY_BADGE.get(e["severity"], e["severity"])
            dial = format_dialects(e["wrong_source"])
            lines.append(f"**{sev}** · from {dial} · id: `{e['id']}`")
            lines.append("")
            avail = e.get("available_via")
            if avail:
                mods = ", ".join(f"`{m}`" for m in avail)
                lines.append(f"**Available in Jerboa via:** {mods}")
                lines.append("")
            lines.append("**Wrong:**")
            lines.append("```scheme")
            lines.append(e["wrong_example"])
            lines.append("```")
            lines.append("")
            lines.append("**Correct:**")
            lines.append("```scheme")
            if e.get("imports"):
                for imp in e["imports"]:
                    lines.append(f"(import {imp})")
            lines.append(e["correct_example"])
            lines.append("```")
            lines.append("")
            if e.get("notes"):
                lines.append(f"_{e['notes']}_")
                lines.append("")
        lines.append("")

    return "\n".join(lines).rstrip() + "\n"


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--json", default="divergence.json",
                    help="Path to divergence.json")
    ap.add_argument("--out", required=True,
                    help="Path to output .md")
    args = ap.parse_args()

    data = json.loads(Path(args.json).read_text())
    md = render(data)
    Path(args.out).write_text(md)
    print(f"Wrote {args.out} ({len(md)} bytes, {len(data['entries'])} entries)")


if __name__ == "__main__":
    main()
