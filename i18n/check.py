#!/usr/bin/env python3
"""Validate i18n/<lang>.json against en.json: same keys, same {placeholders}, same HTML tags.
Usage: python3 i18n/check.py [lang ...]   (no args = all languages)"""
import json, re, sys, pathlib

D = pathlib.Path(__file__).parent
en = json.loads((D / "en.json").read_text())
PH = re.compile(r"\{[a-z]+\}")
TAG = re.compile(r"</?b>")
KW_RULES = [f"r{i}" for i in range(14) if i not in (5, 12)]

def check(code):
    errs = []
    try:
        d = json.loads((D / f"{code}.json").read_text())
    except Exception as e:
        return [f"cannot parse: {e}"]
    if not d.get("name"): errs.append("missing name")
    for sec in ("t", "x", "v"):
        a, b = en[sec], d.get(sec, {})
        for k in a:
            if k not in b: errs.append(f"{sec}.{k} missing"); continue
            if not isinstance(b[k], str) or not b[k].strip(): errs.append(f"{sec}.{k} empty"); continue
            if sorted(PH.findall(a[k])) != sorted(PH.findall(b[k])):
                errs.append(f"{sec}.{k} placeholders {PH.findall(a[k])} != {PH.findall(b[k])}")
            if sorted(TAG.findall(a[k])) != sorted(TAG.findall(b[k])):
                errs.append(f"{sec}.{k} <b> tags differ")
        for k in b:
            if k not in a: errs.append(f"{sec}.{k} unknown key")
    if code != "en":
        kw = d.get("kw", {})
        for r in KW_RULES:
            v = kw.get(r)
            if not isinstance(v, list) or len(v) < 4: errs.append(f"kw.{r} needs a list of 4+ phrases")
            elif any((not isinstance(p, str)) or len(p.strip()) < 2 for p in v): errs.append(f"kw.{r} has an empty/1-char phrase")
    return errs

if __name__ == "__main__":
    langs = sys.argv[1:] or sorted(p.stem for p in D.glob("*.json") if p.stem != "en")
    bad = 0
    for c in langs:
        e = check(c)
        print(f"{c}: {'OK' if not e else str(len(e)) + ' problem(s)'}")
        for x in e[:40]: print("   ", x)
        bad += bool(e)
    sys.exit(1 if bad else 0)
