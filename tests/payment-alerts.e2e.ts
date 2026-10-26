// End-to-end test for owner payment alerts (payment-alerts.ts + the Stripe webhook in server.ts).
// Runs the real server against a throwaway Postgres, a fake Stripe API and a fake Telegram API.
// No real Stripe or Telegram call is made, and no charge is created.
//
//   TEST_DATABASE_URL=postgres://postgres@127.0.0.1:54329/sg bun tests/payment-alerts.e2e.ts
//
// WARNING: it drops and recreates the "public" schema of TEST_DATABASE_URL. Never point it at a real database.
import { SQL } from "bun";

const DB = Bun.env.TEST_DATABASE_URL || "";
if (!DB || /railway|rlwy|amazonaws|supabase|neon/i.test(DB)) { console.error("Set TEST_DATABASE_URL to a throwaway local database."); process.exit(2); }
const ROOT = new URL("..", import.meta.url).pathname;
const SECRET = "whsec_local_test_only";
const LIVE_TOKEN = "111111:FAKE_LIVE_TOKEN", TEST_TOKEN_SHARED = LIVE_TOKEN;
const LIVE_CHAT = "-100live", TEST_CHAT = "-100test";
const I = { pass: crypto.randomUUID(), async: crypto.randomUUID(), yearly: crypto.randomUUID(), owner: crypto.randomUUID(),
  testmode: crypto.randomUUID(), fail: crypto.randomUUID(), overlap: crypto.randomUUID(), iso: crypto.randomUUID(), unconf: crypto.randomUUID() };

// ---- fakes ----
const subs: Record<string, any> = {
  sub_sg: { id: "sub_sg", object: "subscription", status: "active", metadata: { app: "scamguard", install_id: I.yearly }, current_period_end: Math.floor(Date.now() / 1000) + 365 * 86400 },
  sub_other: { id: "sub_other", object: "subscription", status: "active", metadata: { app: "otherapp" }, current_period_end: Math.floor(Date.now() / 1000) + 30 * 86400 },
};
const stripeFake = Bun.serve({ port: 0, fetch(req) {
  const m = new URL(req.url).pathname.match(/^\/v1\/subscriptions\/(\w+)$/);
  if (m && subs[m[1]]) return Response.json(subs[m[1]]);
  return Response.json({ error: { message: "No such object" } }, { status: 404 });
} });
let tgFail = false;
const tg: { token: string; chat: string; text: string }[] = [];
const tgFake = Bun.serve({ port: 0, async fetch(req) {
  const m = new URL(req.url).pathname.match(/^\/bot(.+)\/sendMessage$/);
  if (!m) return new Response("nope", { status: 404 });
  if (tgFail) return Response.json({ ok: false }, { status: 500 });
  const b: any = await req.json();
  tg.push({ token: decodeURIComponent(m[1]), chat: String(b.chat_id), text: String(b.text) });
  return Response.json({ ok: true, result: {} });
} });

// ---- server ----
let server: any = null, logs = "", port = 0;
async function startServer(extra: Record<string, string>) {
  port = 30000 + Math.floor(Math.random() * 20000);
  server = Bun.spawn(["bun", "server.ts"], { cwd: ROOT, stdout: "pipe", stderr: "pipe", env: {
    PATH: Bun.env.PATH!, HOME: Bun.env.HOME!, PORT: String(port), DATABASE_URL: DB, STRIPE_WEBHOOK_SECRET: SECRET, STRIPE_SECRET_KEY: "sk_test_fake",
    STRIPE_API_BASE: `http://127.0.0.1:${stripeFake.port}`, TELEGRAM_API_BASE: `http://127.0.0.1:${tgFake.port}`, ADMIN_PASSWORD: "local-admin-pw", ...extra } });
  for (const s of [server.stdout, server.stderr]) (async () => { for await (const c of s) logs += new TextDecoder().decode(c); })();
  for (let i = 0; i < 100; i++) { try { if ((await fetch(`http://127.0.0.1:${port}/health`)).ok) break; } catch {} await Bun.sleep(100); }
  for (let i = 0; i < 100; i++) { try { await sql`SELECT 1 FROM payment_alerts LIMIT 1`; return; } catch {} await Bun.sleep(100); }
  throw new Error("server didn't start");
}
async function stopServer() { server?.kill(); await server?.exited; }

const sql = new SQL(DB);
await sql.unsafe("DROP SCHEMA public CASCADE; CREATE SCHEMA public;");
await startServer({ TELEGRAM_BOT_TOKEN: LIVE_TOKEN, TELEGRAM_CHAT_ID: LIVE_CHAT, TELEGRAM_TEST_CHAT_ID: TEST_CHAT });
for (const [k, id] of Object.entries(I))
  await sql`INSERT INTO app_installs (id, cred_hash, trial_ends_at, policy_version, owner) VALUES (${id}::uuid, 'x', now(), 'test', ${k === "owner"})`;

// ---- helpers ----
let seq = 0;
const now = () => Math.floor(Date.now() / 1000);
async function send(type: string, obj: any, o: { livemode?: boolean; id?: string; badSig?: boolean } = {}) {
  const ev = { id: o.id || `evt_${++seq}_${Date.now()}`, object: "event", type, livemode: o.livemode ?? true, created: now(), data: { object: obj } };
  const raw = JSON.stringify(ev), t = now();
  const sig = new Bun.CryptoHasher("sha256", o.badSig ? "whsec_wrong" : SECRET).update(`${t}.${raw}`).digest("hex");
  const r = await fetch(`http://127.0.0.1:${port}/api/stripe/webhook`, { method: "POST", headers: { "stripe-signature": `t=${t},v1=${sig}`, "content-type": "application/json" }, body: raw });
  return { status: r.status, body: await r.json().catch(() => null), id: ev.id };
}
const settle = () => Bun.sleep(400);
const passSession = (id: string, iid: string, days: number, extra: any = {}) => ({ id, object: "checkout.session", mode: "payment", payment_status: "paid",
  amount_total: 990, currency: "sgd", customer: "cus_secret123", client_reference_id: iid,
  customer_details: { email: "buyer@example.com", name: "Jane Buyer" }, metadata: { app: "scamguard", install_id: iid, days: String(days) }, ...extra });
const invoice = (id: string, sub: string, reason: string, amount = 2990, extra: any = {}) => ({ id, object: "invoice", subscription: sub, billing_reason: reason,
  amount_paid: amount, currency: "sgd", customer: "cus_secret456", customer_email: "yearly@example.com", status_transitions: { paid_at: now() },
  lines: { data: [{ period: { end: now() + 365 * 86400 } }] }, ...extra });
const alertRows = async () => await sql`SELECT * FROM payment_alerts ORDER BY created_at`;
const install = async (id: string) => (await sql`SELECT * FROM app_installs WHERE id = ${id}::uuid`)[0];

let failures = 0;
function check(name: string, ok: boolean, detail = "") { console.log(`${ok ? "PASS" : "FAIL"}  ${name}${ok || !detail ? "" : "  -> " + detail}`); if (!ok) failures++; }

// 1. Bad signature
let r = await send("checkout.session.completed", passSession("cs_badsig", I.pass, 7), { badSig: true });
check("bad signature rejected, nothing recorded", r.status === 400 && (await alertRows()).length === 0);

// 2. Paid one-time pass
r = await send("checkout.session.completed", passSession("cs_paid1", I.pass, 7)); await settle();
check("paid pass: webhook 200", r.status === 200);
check("paid pass: entitlement granted (7 days banked)", (await install(I.pass)).pass_days_banked === 7);
check("paid pass: one live alert sent to live chat", tg.length === 1 && tg[0].chat === LIVE_CHAT && tg[0].token === LIVE_TOKEN, JSON.stringify(tg));
check("paid pass: text = ScamGuard, 7-day pass, SGD 9.90, SGT time", /^ScamGuard: New 7-day pass\nPaid: SGD 9\.90\nTime: .+ SGT$/.test(tg[0]?.text || ""), tg[0]?.text);
const leaked = ["buyer@example.com", "Jane", "cus_", "cs_", I.pass, "install", "evt_"].filter(x => (tg[0]?.text || "").includes(x));
check("paid pass: no customer details, Stripe IDs or install ID in alert", leaked.length === 0, leaked.join(","));

// 3. Webhook retry (same event ID) and overlapping event for the same payment
const dupId = r.id;
r = await send("checkout.session.completed", passSession("cs_paid1", I.pass, 7), { id: dupId }); await settle();
check("retry of same event: no second alert, no extra days", tg.length === 1 && (await install(I.pass)).pass_days_banked === 7);
await send("checkout.session.completed", passSession("cs_overlap", I.overlap, 3)); await settle();
await send("checkout.session.async_payment_succeeded", passSession("cs_overlap", I.overlap, 3)); await settle();
check("overlapping events for one session: exactly one alert", (await alertRows()).filter(a => a.key === "cs:cs_overlap").length === 1 && tg.length === 2);
const overlapDays = (await install(I.overlap)).pass_days_banked;

// 4. Unpaid / pending, then async success; async failure
tg.length = 0;
await send("checkout.session.completed", passSession("cs_async", I.async, 3, { payment_status: "unpaid" })); await settle();
check("pending (unpaid) session: no alert, no days", tg.length === 0 && (await install(I.async)).pass_days_banked === 0);
await send("checkout.session.async_payment_failed", passSession("cs_asyncfail", I.async, 3, { payment_status: "unpaid" })); await settle();
check("async payment failed: no alert", tg.length === 0);
await send("checkout.session.async_payment_succeeded", passSession("cs_async", I.async, 3, { payment_status: "paid" })); await settle();
check("async success: one alert, 3 days granted", tg.length === 1 && /New 3-day pass/.test(tg[0].text) && (await install(I.async)).pass_days_banked === 3, JSON.stringify(tg));

// 5. Unrelated / untagged payments
tg.length = 0;
await send("checkout.session.completed", passSession("cs_other", I.pass, 7, { metadata: { app: "otherapp", install_id: I.pass, days: "7" } })); await settle();
await send("checkout.session.completed", passSession("cs_untagged", I.pass, 7, { metadata: {} })); await settle();
check("other app's and untagged payments ignored", tg.length === 0 && (await install(I.pass)).pass_days_banked === 7);
await send("checkout.session.completed", passSession("cs_unknown", crypto.randomUUID(), 7)); await settle();
check("ScamGuard-tagged payment for an unknown install: no alert", tg.length === 0 && !(await alertRows()).some(a => a.key === "cs:cs_unknown"));

// 6. Owner purchase
await send("checkout.session.completed", passSession("cs_owner", I.owner, 7)); await settle();
check("owner purchase: entitlement granted, no alert", tg.length === 0 && (await install(I.owner)).pass_days_banked === 7);

// 7. Yearly plan: initial payment
await send("checkout.session.completed", { id: "cs_sub", object: "checkout.session", mode: "subscription", payment_status: "paid", subscription: "sub_sg",
  customer: "cus_secret456", amount_total: 2990, currency: "sgd", client_reference_id: I.yearly, metadata: { app: "scamguard", install_id: I.yearly, plan: "yearly" } }); await settle();
check("yearly checkout completion: plan active, no alert", tg.length === 0 && (await install(I.yearly)).sub_status === "active");
await send("invoice.paid", invoice("in_first", "sub_sg", "subscription_create")); await settle();
check("yearly initial invoice: one alert 'New yearly plan', SGD 29.90", tg.length === 1 && /^ScamGuard: New yearly plan\nPaid: SGD 29\.90/.test(tg[0].text), JSON.stringify(tg));
await send("invoice.paid", invoice("in_first", "sub_sg", "subscription_create")); await settle();
check("same invoice in a new event: no second alert", tg.length === 1);

// 8. Renewal, other invoices
await send("invoice.paid", invoice("in_renew", "sub_sg", "subscription_cycle")); await settle();
check("renewal: separate 'Yearly plan renewed' alert", tg.length === 2 && /^ScamGuard: Yearly plan renewed/.test(tg[1].text), JSON.stringify(tg));
await send("invoice.paid", invoice("in_prorate", "sub_sg", "subscription_update", 500)); await settle();
await send("invoice.paid", invoice("in_zero", "sub_sg", "subscription_cycle", 0)); await settle();
await send("invoice.paid", invoice("in_other", "sub_other", "subscription_create")); await settle();
check("proration, zero-amount and other app's invoices: no alert", tg.length === 2);

// 9. Failed payment, cancellation, refund, dispute
await send("invoice.payment_failed", invoice("in_fail", "sub_sg", "subscription_cycle", 0, { amount_due: 2990 })); await settle();
check("failed renewal: no alert, plan past_due", tg.length === 2 && (await install(I.yearly)).sub_status === "past_due");
await send("customer.subscription.deleted", { ...subs.sub_sg, status: "canceled" }); await settle();
await send("charge.refunded", { id: "ch_1", object: "charge", metadata: { app: "scamguard", install_id: I.pass } }); await settle();
await send("charge.dispute.created", { id: "dp_1", object: "dispute", metadata: { app: "scamguard" } }); await settle();
check("cancellation, refund, dispute: no alert", tg.length === 2);

// 10. Test mode vs live mode
tg.length = 0;
await send("checkout.session.completed", passSession("cs_testmode", I.testmode, 5), { livemode: false }); await settle();
check("test-mode payment: goes only to the test chat, marked [TEST]", tg.length === 1 && tg[0].chat === TEST_CHAT && tg[0].text.startsWith("[TEST] ScamGuard: New 5-day pass"), JSON.stringify(tg));
check("test-mode payment: nothing to the live chat", !tg.some(m => m.chat === LIVE_CHAT));

// 11. Telegram down: payment unaffected, bounded retries, recovery from /admin
tg.length = 0; tgFail = true;
r = await send("checkout.session.completed", passSession("cs_tgdown", I.fail, 14)); await settle();
let a = (await sql`SELECT * FROM payment_alerts WHERE key = 'cs:cs_tgdown'`)[0];
check("Telegram down: webhook still 200 and 14 days granted", r.status === 200 && (await install(I.fail)).pass_days_banked === 14);
check("Telegram down: alert kept pending with retry scheduled", a.status === "pending" && a.attempts === 1 && a.last_error === "http_500" && new Date(a.next_at).getTime() > Date.now());
await sql`UPDATE payment_alerts SET attempts = 5, next_at = now() WHERE key = 'cs:cs_tgdown'`;
await send("checkout.session.completed", passSession("cs_tgdown", I.fail, 14), { id: r.id }); await settle(); // a retried event triggers a delivery run
a = (await sql`SELECT * FROM payment_alerts WHERE key = 'cs:cs_tgdown'`)[0];
check("after the 6th failed attempt: marked failed, no more retries", a.status === "failed" && a.attempts === 6, JSON.stringify({ s: a.status, n: a.attempts }));
tgFail = false;
const login = await fetch(`http://127.0.0.1:${port}/api/admin/login`, { method: "POST", headers: { "x-requested-with": "sg-admin", "content-type": "application/json" }, body: JSON.stringify({ password: "local-admin-pw" }) });
const cookie = (login.headers.get("set-cookie") || "").split(";")[0];
const st: any = await (await fetch(`http://127.0.0.1:${port}/api/admin/alerts`, { headers: { cookie } })).json();
check("admin status: config shown, failed alert listed, no Stripe IDs exposed", st.config?.live === true && st.recent.some((x: any) => x.status === "failed") && !JSON.stringify(st).includes("cs_tgdown"));
const rt: any = await (await fetch(`http://127.0.0.1:${port}/api/admin/alerts/retry`, { method: "POST", headers: { cookie, "x-requested-with": "sg-admin", "content-type": "application/json" }, body: "{}" })).json(); await settle();
a = (await sql`SELECT * FROM payment_alerts WHERE key = 'cs:cs_tgdown'`)[0];
check("admin 'Retry failed alerts': alert sent once Telegram is back", rt.requeued === 1 && a.status === "sent" && tg.length === 1 && /14-day pass/.test(tg[0].text));
check("admin endpoints need login", (await fetch(`http://127.0.0.1:${port}/api/admin/alerts`)).status === 401);

// 12. Alert storage broken: the payment must still go through
await sql`ALTER TABLE payment_alerts RENAME TO payment_alerts_off`;
r = await send("checkout.session.completed", passSession("cs_iso", I.iso, 5)); await settle();
await sql`ALTER TABLE payment_alerts_off RENAME TO payment_alerts`;
check("alert table unavailable: webhook 200, 5 days still granted, event recorded", r.status === 200 && (await install(I.iso)).pass_days_banked === 5
  && (await sql`SELECT 1 FROM stripe_events WHERE id = ${r.id}`).length === 1);

// 13. Without Telegram variables: live alerts kept as failed (recoverable), test alerts skipped
await stopServer(); tg.length = 0;
await startServer({});
await send("checkout.session.completed", passSession("cs_unconf", I.unconf, 3)); await settle();
await send("checkout.session.completed", passSession("cs_unconf_test", I.unconf, 3), { livemode: false }); await settle();
const u = Object.fromEntries((await sql`SELECT key, status, last_error FROM payment_alerts WHERE key LIKE 'cs:cs_unconf%'`).map((x: any) => [x.key, x]));
check("no Telegram config: payment granted, nothing sent", tg.length === 0 && (await install(I.unconf)).pass_days_banked === 6);
check("no Telegram config: live alert failed/not_configured, test alert skipped", u["cs:cs_unconf"]?.status === "failed" && u["cs:cs_unconf"]?.last_error === "not_configured" && u["cs:cs_unconf_test"]?.status === "skipped");

// 14. Logs never contain the bot token, chat IDs or buyer details
await stopServer();
const bad = [LIVE_TOKEN, "FAKE_LIVE_TOKEN", LIVE_CHAT, TEST_CHAT, "buyer@example.com", "yearly@example.com"].filter(x => logs.includes(x));
check("server logs: no token, chat ID or customer email", bad.length === 0, bad.join(","));

console.log(`\nNote (existing behaviour, unchanged): two different paid events for one pass session granted ${overlapDays} days (the 3-day pass counted twice); Stripe doesn't send that combination, but the alert deduplicates either way.`);
console.log(failures ? `\n${failures} FAILED` : "\nAll checks passed");
stripeFake.stop(); tgFake.stop(); await sql.close();
process.exit(failures ? 1 : 0);
