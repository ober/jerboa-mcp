#!/usr/bin/env python3
"""Generate docs/api-index.md from api-signatures.json.

One doc, three sections:
  1. Prelude exports (full list — what (import (jerboa prelude)) gives you).
  2. "Where is X?" — alphabetical index of every exported symbol with its
     providing modules. LLMs use this to answer "what import do I need for X?".
  3. Module catalog — every library and its export count.

Symbol-level index is the high-value section — it's the anti-hallucination
lookup: if symbol X doesn't appear here, it's not in Jerboa anywhere.
"""
import argparse
import json
from pathlib import Path


def render(api):
    modules = api["modules"]
    idx = api["symbol_index"]

    out = []
    out.append("# Jerboa API Index")
    out.append("")
    out.append(
        f"_Auto-generated from `jerboa-mcp/api-signatures.json` "
        f"({api['generated']}). "
        f"{api['stats']['modules']} modules, "
        f"{api['stats']['symbols']} unique symbols, "
        f"{api['stats']['total_exports']} total exports._"
    )
    out.append("")
    out.append(
        "> **Authoritative.** If a symbol does not appear in the index below, "
        "it is not exported by any Jerboa library and any reference is a "
        "hallucination. This index is parsed directly from `.sls` source files "
        "on every regeneration."
    )
    out.append("")
    out.append("## Contents")
    out.append("")
    out.append("- [1. Prelude exports](#1-prelude-exports)")
    out.append("- [2. Where is X? (symbol → modules)](#2-where-is-x-symbol--modules)")
    out.append("- [3. Module catalog](#3-module-catalog)")
    out.append("")

    # Section 1: prelude
    prelude = modules.get("(jerboa prelude)")
    out.append("## 1. Prelude exports")
    out.append("")
    if prelude:
        out.append(
            f"Importing `(jerboa prelude)` gives you {len(prelude['exports'])} "
            f"bindings. Everything listed here is available with no further import."
        )
        out.append("")
        out.append("<details><summary>Full list</summary>")
        out.append("")
        out.append("```")
        cols = 3
        exports = prelude["exports"]
        width = max(len(s) for s in exports) + 2
        for i in range(0, len(exports), cols):
            row = exports[i:i + cols]
            out.append("".join(s.ljust(width) for s in row).rstrip())
        out.append("```")
        out.append("")
        out.append("</details>")
        out.append("")
    else:
        out.append("_(jerboa prelude) not found in module map._")
        out.append("")

    # Section 2: symbol index
    out.append("## 2. Where is X? (symbol → modules)")
    out.append("")
    out.append(
        "Every exported symbol, mapped to the modules that export it. If a "
        "symbol has multiple providers, any of them will give you that binding."
    )
    out.append("")

    # Group by first character for navigation.
    groups = {}
    for sym in sorted(idx.keys()):
        first = sym[0].lower()
        if not first.isalnum():
            first = "sym"
        groups.setdefault(first, []).append(sym)

    # Nav row
    nav = "| " + " | ".join(f"[{k}](#idx-{k})" for k in sorted(groups)) + " |"
    out.append(nav)
    out.append("| " + " | ".join(["---"] * len(groups)) + " |")
    out.append("")

    for key in sorted(groups):
        out.append(f"### <a name=\"idx-{key}\"></a>{key}")
        out.append("")
        out.append("| Symbol | Modules |")
        out.append("| --- | --- |")
        for sym in groups[key]:
            mods = idx[sym]
            if len(mods) > 4:
                mods_str = ", ".join(f"`{m}`" for m in mods[:4]) + f", ... (+{len(mods) - 4})"
            else:
                mods_str = ", ".join(f"`{m}`" for m in mods)
            # Escape pipes in symbol for table
            sym_display = sym.replace("|", "\\|")
            out.append(f"| `{sym_display}` | {mods_str} |")
        out.append("")

    # Section 3: module catalog
    out.append("## 3. Module catalog")
    out.append("")
    out.append(
        f"All {len(modules)} modules sorted by name. Export count in parentheses."
    )
    out.append("")
    out.append("| Module | Exports | Source file |")
    out.append("| --- | --- | --- |")
    for name in sorted(modules):
        info = modules[name]
        out.append(f"| `{name}` | {len(info['exports'])} | `{info['file']}` |")
    out.append("")

    return "\n".join(out) + "\n"


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--api", default="api-signatures.json")
    ap.add_argument("--out", required=True)
    args = ap.parse_args()

    api = json.loads(Path(args.api).read_text())
    md = render(api)
    Path(args.out).write_text(md)
    print(f"Wrote {args.out} ({len(md)} bytes)")


if __name__ == "__main__":
    main()
