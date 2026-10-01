# ScamGuard SOS

One-tap SOS web app: group SMS to trusted contacts with live location, insurer WhatsApp routing, scam message checker, and emergency numbers for 195 countries.

- `server.ts` — Bun server: serves the app, live-tracking API (Postgres), live map page `/t/:id`, embassy lookup.
- `public/index.html` — the whole app (HTML/CSS/JS).

## Settings (Railway variables)
- `DATABASE_URL` — Postgres for live tracking
- `PUBLIC_URL` — public base URL for live map links (optional)
- `CLAIMS_WHATSAPP` — insurer WhatsApp number with country code (default +65 8887 7041)
- `CLAIMS_NAME` — insurer name shown in the app (default "Insurance assistance")

## Run locally
    DATABASE_URL=postgres://... bun server.ts
