// Language end-to-end checks. Needs two local servers (see tests/README.md) and Playwright:
//   BASE=http://localhost:4201 BASE_PAYWALL=http://localhost:4202 node tests/i18n.e2e.mjs
// Never sends real alerts: SMS/WhatsApp navigations are only observed, and no payment is made.
import { chromium } from "playwright";
import fs from "node:fs";
const BASE = process.env.BASE || "http://localhost:4201", BASE_PW = process.env.BASE_PAYWALL || "";
const SHOTS = process.env.SHOTS || "";
const exe = process.env.CHROMIUM || (fs.existsSync("/opt/pw-browsers") ? fs.readdirSync("/opt/pw-browsers").filter(d => d.startsWith("chromium-")).map(d => `/opt/pw-browsers/${d}/chrome-linux/chrome`)[0] : undefined);
const b = await chromium.launch(exe ? { executablePath: exe } : {});
let fails = 0; const ok = (c, m) => { console.log((c ? "PASS " : "FAIL ") + m); if (!c) fails++; };
const CONTACTS = JSON.stringify([{ name: "Mum", phone: "+6591234567", primary: true }]);

async function ctxFor({ langs, ip = "165.21.0.1", geo = true } = {}) {
  const o = { viewport: { width: 360, height: 760 }, extraHTTPHeaders: { "x-real-ip": ip } };
  if (langs) o.locale = langs[0];
  if (geo) { o.geolocation = { latitude: 48.8566, longitude: 2.3522 }; o.permissions = ["geolocation"]; }
  const ctx = await b.newContext(o);
  if (langs) await ctx.addInitScript(l => { Object.defineProperty(Navigator.prototype, "languages", { get: () => l }); Object.defineProperty(Navigator.prototype, "language", { get: () => l[0] }); }, langs);
  return ctx;
}
async function open(ctx, url, { contacts = true } = {}) {
  const pg = await ctx.newPage(); pg.errs = []; pg.sent = [];
  pg.on("pageerror", e => pg.errs.push(e.message));
  if (contacts) await pg.addInitScript(c => { if (!localStorage.getItem("sg_contacts")) localStorage.setItem("sg_contacts", c); }, CONTACTS);
  const cdp = await ctx.newCDPSession(pg); await cdp.send("Page.enable");
  cdp.on("Page.frameRequestedNavigation", e => { if (/^(sms:|whatsapp:|https:\/\/wa\.me)/.test(e.url)) pg.sent.push(decodeURIComponent(e.url)); });
  await pg.goto(url); await pg.waitForTimeout(1200); return pg;
}
const lang = pg => pg.evaluate(() => document.documentElement.lang);
const txt = (pg, s) => pg.textContent(s).then(x => (x || "").trim());
const saved = pg => pg.evaluate(() => localStorage.getItem("sg_lang"));

// 1. Device language detection
for (const [langs, want] of [[["fr-FR"], "fr"], [["fr-CA", "en-CA"], "fr"], [["ko-KR"], "ko"], [["de-DE", "ja-JP"], "ja"], [["de-DE"], "en"], [["pt_BR"], "en"]]) {
  const ctx = await ctxFor({ langs }); const pg = await open(ctx, BASE);
  ok(await lang(pg) === want && (await txt(pg, "#safeBtn")).length > 0, `device ${langs.join(",")} -> ${want} (got ${await lang(pg)})`);
  await ctx.close();
}
// 2. Overrides
{ const ctx = await ctxFor({ langs: ["fr-FR"] }); let pg = await open(ctx, BASE);
  ok(await saved(pg) === null, "auto-detected French is not saved as a choice");
  await pg.click("[data-tab=contacts]"); await pg.selectOption("#langSel2", "fr"); await pg.waitForTimeout(200);
  ok(await saved(pg) === '"fr"', "choosing French while auto-French saves an explicit override");
  await pg.selectOption("#langSel2", "en"); await pg.waitForTimeout(200);
  ok(await lang(pg) === "en" && await pg.inputValue("#langSel") === "en", "manual English on a French device; header picker in sync");
  await pg.reload(); await pg.waitForTimeout(1000);
  ok(await lang(pg) === "en" && await txt(pg, "#safeBtn") === "I'm safe", "English choice survives reload");
  await pg.selectOption("#langSel", ""); await pg.waitForTimeout(200);
  ok(await lang(pg) === "fr" && await saved(pg) === null && await pg.inputValue("#langSel2") === "", "Automatic restores device language and clears the override");
  await pg.evaluate(() => localStorage.setItem("sg_lang", '"xx"')); await pg.reload(); await pg.waitForTimeout(800);
  ok(await lang(pg) === "fr", "invalid saved language falls back to device language");
  await pg.evaluate(() => localStorage.setItem("sg_lang", "{not json")); await pg.reload(); await pg.waitForTimeout(800);
  ok(await lang(pg) === "fr" && !pg.errs.length, "corrupt saved value is ignored safely");
  await pg.evaluate(() => localStorage.setItem("sg_lang", '"ko"')); await pg.reload(); await pg.waitForTimeout(800);
  ok(await lang(pg) === "ko", "an earlier saved choice (sg_lang) still applies");
  await ctx.close(); }
{ const ctx = await ctxFor({ langs: ["fr-FR"] });
  await ctx.addInitScript(() => { Object.defineProperty(window, "localStorage", { get() { throw new DOMException("denied", "SecurityError"); } }); });
  const pg = await ctx.newPage(); const errs = []; pg.on("pageerror", e => errs.push(e.message));
  await pg.goto(BASE); await pg.waitForTimeout(1200);
  ok(await lang(pg) === "fr" && await pg.isVisible("#sosBtn"), "storage blocked: app still loads in the device language");
  await pg.selectOption("#langSel", "en"); await pg.waitForTimeout(200);
  ok(await lang(pg) === "en", "storage blocked: switching language still works for this visit" + (errs.length ? " (page errors: " + errs[0] + ")" : ""));
  await ctx.close(); }
// 3. languagechange only in Automatic mode
{ const ctx = await ctxFor({ langs: ["fr-FR"] }); const pg = await open(ctx, BASE);
  await pg.evaluate(() => { Object.defineProperty(Navigator.prototype, "languages", { get: () => ["ko-KR"], configurable: true }); Object.defineProperty(Navigator.prototype, "language", { get: () => "ko-KR", configurable: true }); window.dispatchEvent(new Event("languagechange")); });
  await pg.waitForTimeout(200); ok(await lang(pg) === "ko", "device language change followed in Automatic mode");
  await pg.selectOption("#langSel", "en");
  await pg.evaluate(() => { Object.defineProperty(Navigator.prototype, "languages", { get: () => ["fr-FR"], configurable: true }); window.dispatchEvent(new Event("languagechange")); });
  await pg.waitForTimeout(200); ok(await lang(pg) === "en", "device language change ignored after a manual choice");
  await ctx.close(); }
// 4. Missing translation falls back to English, never blank/undefined
{ const ctx = await ctxFor({ langs: ["fr-FR"] }); const pg = await ctx.newPage();
  await pg.route(BASE + "/", async r => { const res = await r.fetch(); let body = await res.text(); const at = body.indexOf('"Français"'); body = body.replace(/"imSafe":"[^"]*",/g, (m, i) => i > at && i < body.indexOf('"name":', at + 12) ? "" : m); r.fulfill({ response: res, body, headers: { ...res.headers(), "content-encoding": "" } }); });
  await pg.goto(BASE + "/"); await pg.waitForTimeout(1000);
  ok(await lang(pg) === "fr" && await txt(pg, "#safeBtn") === "I'm safe", "missing French key shows English: " + await txt(pg, "#safeBtn"));
  ok(!/undefined/.test(await pg.textContent("body")), "no 'undefined' anywhere on the page");
  await ctx.close(); }
// 5. Changing language keeps typed text, contacts, situation, tab and tracking; sends nothing
{ const ctx = await ctxFor({ langs: ["fr-FR"] });
  const s0 = await open(ctx, BASE); await s0.click("#sosBtn"); await s0.waitForTimeout(2500); await s0.close(); // starts the live map + updates
  const pg = await open(ctx, BASE);
  const trackBefore = await pg.evaluate(() => localStorage.getItem("sg_track"));
  await pg.selectOption("#situSel", "medical");
  await pg.click("[data-tab=contacts]"); await pg.fill("#msgText", "Note en cours de frappe"); await pg.fill("#cPhone", "+33 6 12");
  const before = await pg.evaluate(() => [...document.querySelectorAll("#contactList .contact .n")].map(x => x.textContent.trim()));
  await pg.selectOption("#langSel2", "ko"); await pg.waitForTimeout(300);
  ok(await lang(pg) === "ko", "switched to Korean");
  ok(await pg.inputValue("#msgText") === "Note en cours de frappe" && await pg.inputValue("#cPhone") === "+33 6 12", "typed note and half-typed number kept");
  ok(JSON.stringify(before.map(s=>s.split(" ")[0])) === JSON.stringify((await pg.evaluate(() => [...document.querySelectorAll("#contactList .contact .n")].map(x => x.textContent.trim()))).map(s=>s.split(" ")[0])), "contacts kept");
  ok(await pg.isVisible("#tab-contacts") && await pg.inputValue("#situSel") === "medical", "active tab and selected situation kept");
  ok(!!trackBefore && await pg.evaluate(() => localStorage.getItem("sg_track")) === trackBefore && await pg.isChecked("#trackToggle"), "live map and location updates still running");
  ok(pg.sent.length === 0, "no alert sent by changing language");
  await ctx.close(); }
// 6. Viewer resolves the viewer's own language
{ const r = await (await fetch(BASE + "/api/track/start", { method: "POST", headers: { "content-type": "application/json", "x-real-ip": "10.9.9.9" }, body: JSON.stringify({ name: "Anne" }) })).json();
  for (const [langs, want] of [[["ko-KR"], "ko"], [["fr-CA"], "fr"], [["es-ES"], "en"]]) {
    const ctx = await ctxFor({ langs }); const pg = await ctx.newPage(); await pg.goto(BASE + "/t/" + r.id); await pg.waitForTimeout(1500);
    ok(await lang(pg) === want, `live-map page for a ${langs[0]} viewer -> ${want} (title: ${await txt(pg, "#title")})`);
    if (SHOTS) await pg.screenshot({ path: `${SHOTS}/viewer-${want}.png` });
    await ctx.close(); }
  ok(!/[?&](lang|hl|country)=/.test(r.url), "share link carries no language or country"); }
// 7. SOS, GPS denied, I'm safe, stop sharing (French), observed only
{ const ctx = await ctxFor({ langs: ["fr-FR"] });
  const p1 = await open(ctx, BASE); await p1.click("#sosBtn"); await p1.waitForTimeout(2500);
  const m = p1.sent[0] || "";
  ok(/Je suis en danger/.test(m) && /\/t\//.test(m) && /maps\.google\.com\/\?q=48\.85/.test(m), "French SOS message with GPS pin and live map");
  ok(await txt(p1, "#liveStop") === "Arrêter le partage", "live map box in French");
  // "I'm safe" ends the live map and opens the send sheet (same flow as before); the message goes out from there.
  const p2 = await open(ctx, BASE); await p2.click("#safeBtn"); await p2.waitForTimeout(800);
  const sheetLink = await p2.evaluate(() => [...document.querySelectorAll("#sheetBg a")].map(a => decodeURIComponent(a.getAttribute("href") || "")).find(h => /^sms:|wa\.me/.test(h)) || "");
  ok(await p2.isVisible("#sheetBg") && /Je suis en sécurité maintenant/.test(sheetLink), "'I'm safe' opens the send sheet with the French safe message");
  await p1.close(); await p2.close();
  await ctx.close(); }
{ const ctx = await ctxFor({ langs: ["fr-FR"] }); const p = await open(ctx, BASE); await p.click("#sosBtn"); await p.waitForTimeout(2500);
  // Script click: after an sms: navigation the test browser swallows the next pointer click (not an app issue).
  await p.evaluate(() => document.querySelector("#liveStop").click()); await p.waitForTimeout(400);
  ok(/Carte en direct arrêtée/.test(await txt(p, "#toast")), "'Stop sharing' is separate from 'I'm safe' and shows its own French notice");
  await ctx.close(); }
{ const ctx = await ctxFor({ langs: ["fr-FR"], geo: false }); const p = await open(ctx, BASE);
  await p.click("#sosBtn"); for (let i = 0; i < 20 && !p.sent.length; i++) await p.waitForTimeout(1000); // waits out the GPS timeout
  const m = p.sent[0] || "";
  ok(m.length > 0 && /Position indisponible/.test(m), "GPS denied: SOS still sends, says location unavailable (French)");
  await ctx.close(); }
// 8. Language never touches country, install or entitlement
if (BASE_PW) {
  for (const [ip, langs, want] of [["165.21.0.1", ["fr-FR"], "sg_free"], ["90.0.0.1", ["ko-KR"], "free_session"], ["90.0.0.1", ["en-GB"], "free_session"]]) {
    const ctx = await ctxFor({ langs, ip }); const pg = await open(ctx, BASE_PW); await pg.waitForTimeout(1500);
    const e1 = await pg.evaluate(() => fetch("/api/entitlement").then(r => r.json()));
    const c1 = (await ctx.cookies()).find(c => c.name === "sg_inst")?.value;
    await pg.selectOption("#langSel", langs[0].startsWith("fr") ? "ko" : "fr"); await pg.waitForTimeout(300); await pg.reload(); await pg.waitForTimeout(1800);
    const e2 = await pg.evaluate(() => fetch("/api/entitlement").then(r => r.json()));
    const c2 = (await ctx.cookies()).find(c => c.name === "sg_inst")?.value;
    ok(e1.live.reason === want && e2.live.reason === want && e2.live.freeSessionAvailable === e1.live.freeSessionAvailable && e1.firstCountry === e2.firstCountry, `${langs[0]} UI, network ${ip}: ${want} before and after a language change`);
    ok(!!c1 && c1 === c2, "same install record after a language change");
    await ctx.close(); }
}
// 9. Offline after first visit
{ const ctx = await ctxFor({ langs: ["fr-FR"] }); const pg = await open(ctx, BASE);
  await pg.evaluate(() => navigator.serviceWorker && navigator.serviceWorker.ready); await pg.waitForTimeout(800);
  await pg.reload(); await pg.waitForTimeout(800);
  await ctx.setOffline(true); await pg.reload().catch(() => {}); await pg.waitForTimeout(1200);
  ok(await pg.isVisible("#sosBtn").catch(() => false) && await lang(pg) === "fr", "works offline after first visit, still French");
  await ctx.close(); }

await b.close();
console.log(fails ? `${fails} FAILED` : "ALL PASSED"); process.exit(fails ? 1 : 0);
