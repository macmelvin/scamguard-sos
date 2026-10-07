# ScamGuard SOS

One-tap SOS web app: group SMS to trusted contacts with live location, insurer WhatsApp routing, scam message checker, and emergency numbers for 195 countries.

- `server.ts` — Bun server: serves the app, live-tracking API (Postgres), live map page `/t/:id`, embassy lookup.
- `public/index.html` — the whole app (HTML/CSS/JS).

## Settings (Railway variables)
- `DATABASE_URL` — Postgres for live tracking
- `PUBLIC_URL` — public base URL for live map links (optional)
- `CLAIMS_WHATSAPP` — insurer WhatsApp number with country code (default +65 8887 7041)
- `CLAIMS_NAME` — insurer name shown in the app (default "Insurance assistance")
- `ANDROID_PACKAGE` — Android app package name (default `com.bricks2clicks.scamguard`)
- `ANDROID_SHA256` — comma-separated signing-key SHA-256 fingerprints from Play Console › App integrity; served at `/.well-known/assetlinks.json` so the Play app opens full-screen

Other pages: `/privacy` (privacy policy), `/security` (security & data summary for partners), `/sw.js` (offline support). Inside the Play app (`?twa=1` or Android referrer) the donation card is hidden.

## Run locally
    DATABASE_URL=postgres://... bun server.ts

## Languages

The app and the live-map page come in English, 中文, Bahasa Melayu, Bahasa Indonesia, ไทย, မြန်မာ, 한국어 and 日本語.
All text is in `i18n/<lang>.json` (`t` = app, `x` = extra hotline labels, `v` = live-map page, `kw` = scam-checker phrases).
`en.json` is the master copy. After editing, run `python3 i18n/check.py` to confirm every language has the same keys and placeholders.
Messages to the insurer's WhatsApp always stay in English.

## Partners and admin

- Each insurer or agency gets its own link, e.g. `scamguardsos.com/fwd`. Opening it loads the partner's name and contact options; a home-screen app added from that link keeps them. Plain scamguardsos.com is always the public version.
- Plain `scamguardsos.com` (and the Google Play app) is the public version: no insurer options. Medical, accident and evacuation alert the user's SOS contacts instead.
- Manage partners and see usage at `/admin`. Set the password in the Railway variable `ADMIN_PASSWORD` (long and unique). Without it, admin stays locked.
- A partner can have a WhatsApp number, an assistance phone line, both, or neither (tracking-only link).
- Usage counts are anonymous daily totals per link (`usage_daily` table): opens, new users, installs, SOS sent, partner chats, scam checks.
