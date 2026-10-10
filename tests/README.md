# Tests

## Languages (end to end, real browser)

Never sends a real alert or payment: SMS/WhatsApp links are only observed.

    service postgresql start   # any local Postgres
    DATABASE_URL=postgres://... PORT=4201 bun server.ts &                       # paywall off
    DATABASE_URL=postgres://... PORT=4202 PAYWALL_ENABLED=true bun server.ts &  # paywall on (no Stripe needed)
    BASE=http://localhost:4201 BASE_PAYWALL=http://localhost:4202 node tests/i18n.e2e.mjs

Needs Playwright (`npm i playwright` somewhere on the path) and a Chromium.
Set `SHOTS=<dir>` to save live-map page screenshots. Uses test IPs 165.21.0.1 (SG) and 90.0.0.1 (FR)
via the X-Real-IP header (in production, Railway's edge sets that header itself).

Not covered: a real Android device / the Play Store (TWA) app.

## Translation files

    bun run check:i18n
