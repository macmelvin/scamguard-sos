# Languages

Every `i18n/<code>.json` file is one language. The server finds the files by itself
(English first, then by code) and injects them into the app and the live-map page, so
no other file lists languages. `en.json` is the source of truth; missing strings fall
back to English at runtime.

## File format

```json
{
  "name": "Français",          // native name shown in the language pickers
  "t":  { "key": "text" },     // app strings (index.html), same keys as en.json
  "x":  { "English label": "text" }, // hotline labels from the country data, keyed by their English text
  "v":  { "key": "text" },     // live-map page (/t/<id>) strings
  "kw": { "r0": ["phrase", ...], ... } // scam-checker phrases per rule (not in en.json; English rules are in the app code)
}
```

Rules:
- Keep `{placeholders}` and `<b>…</b>` exactly as in English. Word order around a
  placeholder is free (e.g. `trackHint` has `{min}` where the interval picker goes).
- Don't translate brand names, numbers, URLs or anything the user types.
- `kw` needs rules r0–r4, r6–r11 and r13, each with 4+ lower-case phrases. ASCII phrases
  match whole words; phrases with accents or non-Latin script match anywhere.
- Keys in `safety-keys.json` are emergency-critical. Every translation of them needs a
  fluent speaker's review before it can be called reviewed (record it under `reviewed`).

## Check

    bun i18n/check.ts          # all languages; exits 1 on any problem
    bun i18n/check.ts fr ko    # just these

It reports missing, empty or unknown keys, placeholder or `<b>` mismatches, bad `kw`
lists, and any key the app or the live-map page uses that is missing from `en.json`.

## Adding a language (e.g. Spanish)

1. Copy `en.json` to `es.json`, set `"name": "Español"`, translate `t`, `x` and `v`.
2. Add a `kw` section (see `fr.json` for the shape).
3. Run `bun i18n/check.ts es` until it says OK, then restart the server.

That's all: the pickers, device-language detection (`es-MX` → `es`) and the live-map
page pick it up automatically. Have a fluent speaker review the keys in `safety-keys.json`.

The app's language never changes the country, emergency numbers, insurer list,
install record or subscription status. Those follow the network/GPS country only.
