// Payment alerts: a private Telegram message to the owner when ScamGuard receives a confirmed payment.
//
// What an alert says: "ScamGuard", the plan or pass length, the amount paid and its currency, and the payment time.
// Nothing about the buyer: no name, email, card, country, install ID, Stripe ID or webhook payload.
//
// How it stays safe for billing:
//  - The alert row is written in the SAME database transaction as the payment's effect, so a confirmed payment is
//    never lost and a retried or overlapping webhook can't create a second alert (one row per checkout session or
//    invoice, ON CONFLICT DO NOTHING). It is written behind a savepoint: if writing it fails, the payment is still
//    recorded and the live map still granted.
//  - Sending happens afterwards, outside the payment path. A failed send is retried a bounded number of times
//    (MAX_ATTEMPTS, about 8.5 hours in all), then marked "failed" and shown in /admin, where "Retry failed alerts"
//    sends them again.
//  - Test-mode payments (Stripe livemode=false) go only to TELEGRAM_TEST_CHAT_ID. Without it they are recorded as
//    "skipped" and never sent. A live-mode payment never goes to the test chat, and a test payment never to the live one.
//
// Railway variables (server-side secrets only; never in source control, the app page or logs):
//   TELEGRAM_BOT_TOKEN       the bot's token from @BotFather
//   TELEGRAM_CHAT_ID         the chat that receives live-payment alerts
//   TELEGRAM_TEST_CHAT_ID    optional: the chat that receives Stripe test-mode alerts
//   TELEGRAM_TEST_BOT_TOKEN  optional: a separate bot for test alerts (defaults to TELEGRAM_BOT_TOKEN)

const TG_API = (Bun.env.TELEGRAM_API_BASE || "https://api.telegram.org").replace(/\/$/, "");
const LIVE = { token: Bun.env.TELEGRAM_BOT_TOKEN || "", chat: Bun.env.TELEGRAM_CHAT_ID || "" };
const TEST = { token: Bun.env.TELEGRAM_TEST_BOT_TOKEN || Bun.env.TELEGRAM_BOT_TOKEN || "", chat: Bun.env.TELEGRAM_TEST_CHAT_ID || "" };
export const alertConfig = () => ({ live: !!(LIVE.token && LIVE.chat), test: !!(TEST.token && TEST.chat) });

export const MAX_ATTEMPTS = 6;
const RETRY_MINUTES = [1, 5, 30, 120, 360]; // wait after failed attempt 1..5; attempt 6 is the last
const CLAIM_MINUTES = 10; // a claimed alert isn't picked up again for this long (covers a crash mid-send)

export const ALERT_SCHEMA = [
  `CREATE TABLE IF NOT EXISTS payment_alerts (
    key text PRIMARY KEY, livemode boolean NOT NULL, kind text NOT NULL, plan text NOT NULL,
    amount bigint NOT NULL, currency text NOT NULL, paid_at timestamptz NOT NULL,
    status text NOT NULL DEFAULT 'pending', attempts integer NOT NULL DEFAULT 0, next_at timestamptz NOT NULL DEFAULT now(),
    last_error text, sent_at timestamptz, created_at timestamptz NOT NULL DEFAULT now())`,
  `CREATE INDEX IF NOT EXISTS payment_alerts_due ON payment_alerts (next_at) WHERE status = 'pending'`,
];

export type AlertInput = {
  key: string;            // "cs:<checkout session id>" for passes, "in:<invoice id>" for the yearly plan
  livemode: boolean;      // Stripe's livemode flag on the event
  kind: "conversion" | "renewal";
  plan: string;           // "pass_<days>" or "yearly"
  amount: number;         // smallest currency unit, as Stripe sends it
  currency: string;
  paidAt: number;         // unix seconds
};

// Queue an alert inside the caller's webhook transaction. Never throws: the payment matters more than the alert.
export async function queueAlert(tx: any, a: AlertInput) {
  if (!/^(cs|in):[A-Za-z0-9_]+$/.test(a.key) || !Number.isSafeInteger(a.amount) || a.amount <= 0
      || !/^[a-z]{3}$/i.test(a.currency || "") || !Number.isFinite(a.paidAt) || a.paidAt <= 0) {
    console.error("alert: incomplete payment details, no alert queued");
    return false;
  }
  try {
    await tx.savepoint(async (sp: any) => {
      await sp`INSERT INTO payment_alerts (key, livemode, kind, plan, amount, currency, paid_at)
               VALUES (${a.key}, ${a.livemode}, ${a.kind}, ${a.plan}, ${a.amount}, ${a.currency.toLowerCase()}, to_timestamp(${a.paidAt}))
               ON CONFLICT (key) DO NOTHING`;
    });
    return true;
  } catch (e: any) {
    console.error("alert: couldn't queue", e?.code || e?.name || "error");
    return false;
  }
}

// Stripe amounts are in the smallest unit; these currencies have no or three decimal places.
const ZERO_DEC = new Set("bif clp djf gnf jpy kmf krw mga pyg rwf ugx vnd vuv xaf xof xpf".split(" "));
const THREE_DEC = new Set("bhd jod kwd omr tnd".split(" "));
export function formatAmount(amount: number, currency: string) {
  const c = currency.toLowerCase(), d = ZERO_DEC.has(c) ? 0 : THREE_DEC.has(c) ? 3 : 2;
  return `${c.toUpperCase()} ${(amount / 10 ** d).toLocaleString("en-US", { minimumFractionDigits: d, maximumFractionDigits: d })}`;
}
export function alertText(a: { livemode: boolean; kind: string; plan: string; amount: number | string; currency: string; paid_at: Date | string }) {
  const days = /^pass_(\d+)$/.exec(a.plan)?.[1];
  const what = a.plan === "yearly" ? (a.kind === "renewal" ? "Yearly plan renewed" : "New yearly plan") : days ? `New ${days}-day pass` : "New payment";
  const when = new Date(a.paid_at).toLocaleString("en-SG", { timeZone: "Asia/Singapore", day: "numeric", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit", hour12: false });
  return `${a.livemode ? "" : "[TEST] "}ScamGuard: ${what}\nPaid: ${formatAmount(Number(a.amount), a.currency)}\nTime: ${when} SGT`;
}

// Returns null when Telegram accepted the message, otherwise a short error code (never the URL: it holds the token).
async function sendTelegram(dest: { token: string; chat: string }, text: string): Promise<string | null> {
  try {
    const r = await fetch(`${TG_API}/bot${dest.token}/sendMessage`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ chat_id: dest.chat, text, disable_web_page_preview: true }),
      signal: AbortSignal.timeout(10_000),
    });
    if (!r.ok) return "http_" + r.status;
    const j: any = await r.json().catch(() => null);
    return j && j.ok === true ? null : "bad_response";
  } catch (e: any) {
    return e?.name === "TimeoutError" ? "timeout" : "network";
  }
}

// Send every alert that is due. Safe to call often and from several places: each alert is claimed with
// FOR UPDATE SKIP LOCKED before sending, so two runs (or two servers) can't send the same one.
let running = false;
export async function deliverDue(sql: any, max = 25) {
  if (!sql || running) return;
  running = true;
  try {
    for (let i = 0; i < max; i++) {
      const rows = await sql`UPDATE payment_alerts SET attempts = attempts + 1, next_at = now() + make_interval(mins => ${CLAIM_MINUTES})
          WHERE key = (SELECT key FROM payment_alerts WHERE status = 'pending' AND next_at <= now() ORDER BY next_at LIMIT 1 FOR UPDATE SKIP LOCKED)
          RETURNING *`;
      if (!rows.length) break;
      const a = rows[0];
      if (!a.livemode && !alertConfig().test) {
        await sql`UPDATE payment_alerts SET status = 'skipped', last_error = 'no_test_chat' WHERE key = ${a.key}`;
        continue;
      }
      if (a.livemode && !alertConfig().live) {
        // Nothing to retry until the variables are set; "Retry failed alerts" in /admin sends it afterwards.
        await sql`UPDATE payment_alerts SET status = 'failed', last_error = 'not_configured' WHERE key = ${a.key}`;
        console.error("alert: Telegram isn't configured; alert kept as failed");
        continue;
      }
      const err = await sendTelegram(a.livemode ? LIVE : TEST, alertText(a));
      if (!err) {
        await sql`UPDATE payment_alerts SET status = 'sent', sent_at = now(), last_error = NULL WHERE key = ${a.key}`;
      } else if (a.attempts >= MAX_ATTEMPTS) {
        await sql`UPDATE payment_alerts SET status = 'failed', last_error = ${err} WHERE key = ${a.key}`;
        console.error(`alert: gave up after ${a.attempts} attempts (${err})`);
      } else {
        const wait = RETRY_MINUTES[Math.min(a.attempts - 1, RETRY_MINUTES.length - 1)];
        await sql`UPDATE payment_alerts SET last_error = ${err}, next_at = now() + make_interval(mins => ${wait}) WHERE key = ${a.key}`;
        console.error(`alert: send failed (${err}), attempt ${a.attempts} of ${MAX_ATTEMPTS}`);
      }
    }
  } catch (e: any) {
    console.error("alert: delivery run failed", e?.code || e?.name || "error");
  } finally {
    running = false;
  }
}

// /admin: counts, the most recent alerts (no Stripe IDs), and whether Telegram is configured.
export async function alertStatus(sql: any) {
  const counts = await sql`SELECT livemode, status, COUNT(*)::int AS n FROM payment_alerts GROUP BY livemode, status`;
  const recent = await sql`SELECT livemode, kind, plan, amount, currency, paid_at, status, attempts, last_error, sent_at
      FROM payment_alerts ORDER BY created_at DESC LIMIT 20`;
  return { config: alertConfig(), counts, recent };
}
export async function retryFailed(sql: any) {
  const r = await sql`UPDATE payment_alerts SET status = 'pending', attempts = 0, next_at = now(), last_error = NULL WHERE status = 'failed' RETURNING key`;
  return r.length;
}
