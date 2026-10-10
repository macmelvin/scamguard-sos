// Validate every i18n/<code>.json against en.json. Run: bun i18n/check.ts [code ...]   (exit 1 on any problem)
// Checks: required keys present and non-empty in t/x/v, no unknown keys, identical {placeholders} and <b> tags,
// scam-checker phrase lists (kw), and that every key the app and live-map page reference exists in English.
import { readdirSync, readFileSync } from "node:fs";
const DIR = new URL("./", import.meta.url), ROOT = new URL("../", import.meta.url);
const read = (u: URL) => readFileSync(u, "utf8");
const en = JSON.parse(read(new URL("en.json", DIR)));
const SECTIONS = ["t", "x", "v"] as const;
const PH = /\{[a-zA-Z]+\}/g, TAG = /<\/?b>/g;
const KW_RULES = Array.from({ length: 14 }, (_, i) => i).filter(i => i !== 5 && i !== 12).map(i => "r" + i);
const sorted = (s: string, re: RegExp) => (s.match(re) || []).sort().join(",");

function checkLang(code: string): string[] {
  const errs: string[] = [];
  let d: any;
  try { d = JSON.parse(read(new URL(`${code}.json`, DIR))); } catch (e: any) { return [`cannot parse: ${e.message}`]; }
  if (typeof d.name !== "string" || !d.name.trim()) errs.push("missing native name");
  for (const sec of SECTIONS) {
    const a = en[sec] || {}, b = d[sec] || {};
    for (const k of Object.keys(a)) {
      const v = b[k];
      if (v === undefined) { errs.push(`${sec}.${k} missing`); continue; }
      if (typeof v !== "string" || !v.trim()) { errs.push(`${sec}.${k} empty or not text`); continue; }
      if (sorted(a[k], PH) !== sorted(v, PH)) errs.push(`${sec}.${k} placeholders ${a[k].match(PH) || []} != ${v.match(PH) || []}`);
      if (sorted(a[k], TAG) !== sorted(v, TAG)) errs.push(`${sec}.${k} <b> tags differ`);
    }
    for (const k of Object.keys(b)) if (!(k in a)) errs.push(`${sec}.${k} unknown key (not in en.json)`);
  }
  if (code !== "en") {
    const kw = d.kw || {};
    for (const r of KW_RULES) {
      const v = kw[r];
      if (!Array.isArray(v) || v.length < 4) errs.push(`kw.${r} needs a list of 4+ phrases`);
      else if (v.some((p: any) => typeof p !== "string" || p.trim().length < 2)) errs.push(`kw.${r} has an empty/1-char phrase`);
    }
    for (const k of Object.keys(kw)) if (!KW_RULES.includes(k)) errs.push(`kw.${k} unknown rule`);
  }
  return errs;
}

function checkReferences(): string[] {
  const errs: string[] = [];
  const html = read(new URL("public/index.html", ROOT)), server = read(new URL("server.ts", ROOT));
  const used = new Set<string>();
  for (const m of html.matchAll(/data-i18n(?:-ph|-aria|-label)?="([A-Za-z0-9_]+)"/g)) used.add(m[1]);
  for (const m of html.matchAll(/\bt\("([A-Za-z0-9_]+)"\s*[,)]/g)) used.add(m[1]); // dynamic keys ("situ_"+x) are skipped
  for (const k of used) if (!(k in en.t)) errs.push(`app uses t.${k}, missing from en.json`);
  for (const m of server.matchAll(/\bV\("([A-Za-z0-9_]+)"/g)) if (!(m[1] in en.v)) errs.push(`live-map page uses v.${m[1]}, missing from en.json`);
  const safety = JSON.parse(read(new URL("safety-keys.json", DIR)));
  for (const sec of ["t", "v"]) for (const k of safety[sec] || []) if (!(k in en[sec])) errs.push(`safety-keys.json lists ${sec}.${k}, missing from en.json`);
  return errs;
}

const all = readdirSync(DIR).map(f => f.match(/^([a-z]{2,3})\.json$/)?.[1]).filter(Boolean) as string[];
const langs = process.argv.slice(2).length ? process.argv.slice(2) : all.sort();
let bad = 0;
for (const c of langs) {
  const e = checkLang(c);
  console.log(`${c}: ${e.length ? e.length + " problem(s)" : "OK"}`);
  e.slice(0, 40).forEach(x => console.log("    " + x)); bad += e.length ? 1 : 0;
}
const r = checkReferences();
console.log(`references: ${r.length ? r.length + " problem(s)" : "OK"}`); r.forEach(x => console.log("    " + x));
process.exit(bad || r.length ? 1 : 0);
