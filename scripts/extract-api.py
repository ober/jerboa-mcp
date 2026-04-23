#!/usr/bin/env python3
"""Extract exported symbols from all .sls library files under a Jerboa tree.

Produces api-signatures.json with two top-level maps:
  - modules: (library-name) -> {file, exports}
  - symbol_index: symbol -> [module ...]

The intent is a machine-readable index of "what lives where" so tools
(jerboa_verify, suggest_imports) can answer "where does symbol X come from?"
without loading the running Chez image.

Parsing is deliberately conservative: we tokenize with paren-awareness and
pull the first `(export ...)` form out of each `(library ...)` form. Comments
and strings are ignored. Nested forms inside `(export ...)` (e.g. `(rename
(a b))`) collapse to just the exported name.
"""
import argparse
import json
import re
from collections import defaultdict
from datetime import date
from pathlib import Path

TOKEN_RE = re.compile(
    r'''
      ;[^\n]*              # line comment
    | \#\|.*?\|\#          # block comment (non-greedy)
    | "(?:[^"\\]|\\.)*"    # string
    | \#\\[^\s()\[\]]+     # char literal
    | \(                   # open
    | \)                   # close
    | \[                   # open bracket
    | \]                   # close bracket
    | [^\s()\[\]"]+        # atom
    ''',
    re.VERBOSE | re.DOTALL,
)


def tokenize(src):
    for m in TOKEN_RE.finditer(src):
        tok = m.group(0)
        if tok.startswith(";") or tok.startswith("#|"):
            continue
        yield tok


def read_form(tokens, pos):
    """Read one s-expression starting at tokens[pos]. Returns (form, new_pos)."""
    if pos >= len(tokens):
        return None, pos
    tok = tokens[pos]
    if tok in ("(", "["):
        close = ")" if tok == "(" else "]"
        pos += 1
        items = []
        while pos < len(tokens) and tokens[pos] not in (")", "]"):
            item, pos = read_form(tokens, pos)
            if item is not None:
                items.append(item)
        if pos < len(tokens):
            pos += 1
        return items, pos
    return tok, pos + 1


def flatten_export_names(form):
    """Collect leaf symbol names from an (export ...) body.

    Handles:
        a b c                       -> ['a','b','c']
        (rename (a b) (c d))        -> ['b','d']   (new name)
        (prefix (...) p)            -> flatten inner + prefix p
        (import x)                  -> skip
    """
    out = []
    if isinstance(form, str):
        if form and not form.startswith("("):
            out.append(form)
        return out
    if not form:
        return out
    head = form[0] if isinstance(form[0], str) else None
    if head == "rename":
        for item in form[1:]:
            if isinstance(item, list) and len(item) == 2 and isinstance(item[1], str):
                out.append(item[1])
        return out
    if head == "prefix":
        if len(form) >= 3 and isinstance(form[2], str):
            p = form[2]
            inner = flatten_export_names(form[1])
            out.extend(p + name for name in inner)
        return out
    for item in form:
        out.extend(flatten_export_names(item))
    return out


def library_name_to_str(name_form):
    """Convert a library-name s-expr to canonical '(a b c)' string."""
    if isinstance(name_form, str):
        return name_form
    parts = []
    for item in name_form:
        if isinstance(item, str):
            parts.append(item)
        else:
            parts.append(library_name_to_str(item))
    return "(" + " ".join(parts) + ")"


def extract_library(path):
    """Return (library_name_str, [export_names]) or None if no library form."""
    src = path.read_text(errors="replace")
    tokens = list(tokenize(src))
    pos = 0
    while pos < len(tokens):
        form, pos = read_form(tokens, pos)
        if not isinstance(form, list) or len(form) < 2:
            continue
        if form[0] == "library":
            name = library_name_to_str(form[1])
            for sub in form[2:]:
                if isinstance(sub, list) and sub and sub[0] == "export":
                    exports = flatten_export_names(sub[1:])
                    return name, sorted(set(exports))
            return name, []
    return None


TIER_RULES = [
    # (tier, predicate(rel_path_str))
    ("compat", lambda p: (
        p.startswith("lib/std/compat/")
        or p.startswith("lib/std/clojure/")
        or p.startswith("lib/std/srfi/")
        or p.startswith("lib/jerboa/clojure")
        or "gambit-compat" in p
    )),
    ("unstable", lambda p: (
        p.startswith("lib/std/wasm/") or "/wasm/" in p
        or p.startswith("lib/jerboa/wasm/")
        or p.startswith("lib/std/dev/")
        or p.startswith("lib/std/lsp/")
        or p.startswith("lib/std/typed/")
        or p.startswith("lib/std/secure/")
        or p.startswith("lib/std/protobuf/")
        or p.startswith("lib/std/service/")
        or p.startswith("lib/std/effect/")
        or p.startswith("lib/std/persist/")
        or p.startswith("lib/std/web/")
        or p.startswith("lib/thunderchez/")
        or any(m in p for m in ("experimental", "preview", "beta", "/wip/"))
    )),
    ("core", lambda p: (
        p.startswith("lib/jerboa/prelude") or p == "lib/jerboa/prelude.sls"
        or p.startswith("lib/jerboa/") and "/prelude" not in p
    )),
]


def classify_tier(rel_path):
    """Return one of: core, stable, compat, unstable."""
    for tier, pred in TIER_RULES:
        if pred(rel_path):
            return tier
    return "stable"


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--root", required=True,
                    help="Jerboa repo root (containing lib/)")
    ap.add_argument("--out", required=True, help="Output JSON path")
    args = ap.parse_args()

    root = Path(args.root)
    lib = root / "lib"
    if not lib.is_dir():
        raise SystemExit(f"lib/ not found under {root}")

    modules = {}
    symbol_index = defaultdict(list)
    errors = []

    for sls in sorted(lib.rglob("*.sls")):
        try:
            result = extract_library(sls)
        except Exception as exc:
            errors.append({"file": str(sls.relative_to(root)), "error": str(exc)})
            continue
        if result is None:
            continue
        name, exports = result
        rel = str(sls.relative_to(root))
        tier = classify_tier(rel)
        if name in modules:
            modules[name]["alternatives"] = modules[name].get("alternatives", [])
            modules[name]["alternatives"].append(rel)
        else:
            modules[name] = {"file": rel, "exports": exports, "tier": tier}
        for sym in exports:
            if name not in symbol_index[sym]:
                symbol_index[sym].append(name)

    # Tier counts for stats
    tier_counts = defaultdict(int)
    for m in modules.values():
        tier_counts[m["tier"]] += 1

    out = {
        "version": "1.1",
        "generated": date.today().isoformat(),
        "source_root": str(root),
        "stats": {
            "modules": len(modules),
            "symbols": len(symbol_index),
            "total_exports": sum(len(m["exports"]) for m in modules.values()),
            "parse_errors": len(errors),
            "tiers": dict(tier_counts),
        },
        "tier_definitions": {
            "core":     "Language core (jerboa prelude, reader, core macros). Never breaks.",
            "stable":   "Curated stdlib (std io, std text, std net, ...). SemVer.",
            "compat":   "Compatibility shims for other Schemes (Gambit, Clojure, SRFI). Stable but import-gated.",
            "unstable": "Experimental or vendor-specific (wasm, dev, lsp, thunderchez). May churn.",
        },
        "modules": modules,
        "symbol_index": dict(symbol_index),
        "errors": errors,
    }

    Path(args.out).write_text(json.dumps(out, indent=2, sort_keys=False))
    print(f"Wrote {args.out}")
    print(f"  modules: {out['stats']['modules']}")
    print(f"  symbols: {out['stats']['symbols']}")
    print(f"  exports: {out['stats']['total_exports']}")
    print(f"  errors:  {out['stats']['parse_errors']}")
    print(f"  tiers:   {dict(tier_counts)}")


if __name__ == "__main__":
    main()
