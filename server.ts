// ScamGuard SOS: serves the app, the live-tracking API and the live map page.
// The app page lives in public/index.html.
import { SQL } from "bun";
import maxmind from "maxmind";
import { readdirSync } from "node:fs";
// Partners (insurers, agencies) are stored in Postgres and managed at /admin.
// Each one gets its own link, e.g. scamguardsos.com/fwd, which loads its name and WhatsApp number.
// Translations: i18n/<lang>.json. The app gets "t", "x" and "kw"; the live-map viewer gets "v".
// Language registry: every i18n/<code>.json file is a language (see i18n/README.md). English first, then by
// code. A file that fails to parse or lacks "name"/"t" is skipped (logged); English is required.
const I18N_DIR = new URL("./i18n/", import.meta.url);
const LANGS = readdirSync(I18N_DIR).map(f => f.match(/^([a-z]{2,3})\.json$/)?.[1]).filter(Boolean)
  .sort((a, b) => (a === "en" ? -1 : b === "en" ? 1 : a!.localeCompare(b!))) as string[];
const I18N: Record<string, any> = {};
for (const l of LANGS) {
  try {
    const d = await Bun.file(new URL(`${l}.json`, I18N_DIR)).json();
    if (!d || typeof d.name !== "string" || typeof d.t !== "object") throw new Error("missing name or t");
    I18N[l] = d;
  } catch (e) { if (l === "en") throw e; console.error(`i18n: skipping ${l}`, e); }
}
const jsonForScript = (o: any) => JSON.stringify(o).replace(/</g, "\\u003c").replace(/\u2028/g, "\\u2028").replace(/\u2029/g, "\\u2029");
const APP_I18N = jsonForScript(Object.fromEntries(Object.entries(I18N).map(([l, d]) => [l, { name: d.name, t: d.t, x: d.x, kw: d.kw }])));
const VIEW_I18N = jsonForScript(Object.fromEntries(Object.entries(I18N).map(([l, d]) => [l, d.v])));
const HTML_T = (await Bun.file(new URL("./public/index.html", import.meta.url)).text())
  .replace("__I18N_DATA__", () => APP_I18N);
// sponsorDays: live tracking the partner pays for. 0 = off, -1 = included without limit on their link,
// N = each phone that opens their link gets N days once (they start with its first live map). sponsorUntil: last day (SGT) or "".
type Partner = { slug: string; name: string; wa: string; tel: string; active: boolean; sponsorDays: number; sponsorUntil: string };
const pageCache = new Map<string, { html: string; gz: Uint8Array }>();
function page(p: Partner | null) {
  const key = p ? p.slug : "";
  let c = pageCache.get(key);
  if (!c) {
    const data = p ? jsonForScript({ slug: p.slug, name: p.name, wa: p.wa, tel: p.tel }) : "null";
    const html = HTML_T.replace("__PARTNER_DATA__", () => data)
      .replace('href="/manifest.webmanifest"', p ? `href="/manifest.webmanifest?p=${p.slug}"` : 'href="/manifest.webmanifest"');
    c = { html, gz: Bun.gzipSync(new TextEncoder().encode(html)) };
    pageCache.set(key, c);
  }
  return c;
}
function htmlResponse(req: Request, headers: Record<string, string>, p: Partner | null = null) {
  const c = page(p), gz = /\bgzip\b/.test(req.headers.get("accept-encoding") || "");
  return new Response(gz ? c.gz : c.html, { headers: { ...headers, "Vary": "Accept-Encoding", ...(gz ? { "Content-Encoding": "gzip" } : {}) } });
}
const ICON = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512"><rect width="512" height="512" rx="112" fill="#13212E"/><circle cx="256" cy="256" r="170" fill="#D7302A"/><text x="256" y="300" font-family="Arial Narrow,Arial,sans-serif" font-weight="800" font-size="130" fill="#fff" text-anchor="middle">SOS</text></svg>`;
const MANIFEST_OBJ = ({
  name: "ScamGuard SOS", short_name: "ScamGuard", start_url: "/", display: "standalone",
  background_color: "#13212E", theme_color: "#13212E",
  id: "/", scope: "/", orientation: "portrait",
  description: "One-tap SOS that texts your trusted contacts your live location, a scam message checker, and emergency numbers for 195 countries.",
  categories: ["lifestyle", "utilities", "travel"],
  icons: [
    { src: "/icons/icon-192.png", sizes: "192x192", type: "image/png", purpose: "any" },
    { src: "/icons/icon-512.png", sizes: "512x512", type: "image/png", purpose: "any" },
    { src: "/icons/maskable-512.png", sizes: "512x512", type: "image/png", purpose: "maskable" },
    { src: "/icon.svg", sizes: "any", type: "image/svg+xml", purpose: "any" },
  ],
});
const manifestFor = (p: Partner | null) => JSON.stringify(p ? { ...MANIFEST_OBJ, start_url: "/" + p.slug, id: "/" + p.slug } : MANIFEST_OBJ);
// Android app (Google Play) verification. Set ANDROID_PACKAGE and ANDROID_SHA256 (comma-separated
// signing-certificate fingerprints from Play Console > App integrity) as Railway variables.
const ANDROID_PACKAGE = Bun.env.ANDROID_PACKAGE || "com.bricks2clicks.scamguard";
const ASSETLINKS = JSON.stringify((Bun.env.ANDROID_SHA256 || "").split(",").map(x => x.trim()).filter(Boolean).length
  ? [{ relation: ["delegate_permission/common.handle_all_urls"], target: { namespace: "android_app", package_name: ANDROID_PACKAGE,
      sha256_cert_fingerprints: Bun.env.ANDROID_SHA256!.split(",").map(x => x.trim()).filter(Boolean) } }]
  : []);
const PUBLIC_DIR = new URL("./public/", import.meta.url);
const PRIVACY = await Bun.file(new URL("./privacy.html", PUBLIC_DIR)).text();
const ADMIN_HTML = await Bun.file(new URL("./admin.html", PUBLIC_DIR)).text();
const SW = await Bun.file(new URL("./sw.js", PUBLIC_DIR)).text();
const SECURITY = await Bun.file(new URL("./security.html", PUBLIC_DIR)).text();
const DELETE_DATA = await Bun.file(new URL("./delete-data.html", PUBLIC_DIR)).text();
const common = { "Permissions-Policy": "geolocation=(self)", "X-Content-Type-Options": "nosniff", "Referrer-Policy": "no-referrer" };
const PUBLIC_URL = (Bun.env.PUBLIC_URL || "").replace(/\/$/, "");

// ---------- Embassy data (open Database of Embassies, Wikidata, public domain) ----------
const EMB_URL = "https://raw.githubusercontent.com/database-of-embassies/database-of-embassies/master/database_of_embassies.csv";
const KEEP = new Set(["embassy", "high commission", "consulate general", "consulate", "de facto embassy", "de facto consulate"]);
let EMB: Record<string, any[]> | null = null;
let embLoading: Promise<void> | null = null;
function loadEmb() {
  if (EMB) return Promise.resolve();
  if (!embLoading) embLoading = (async () => {
    const r = await fetch(EMB_URL);
    if (!r.ok) throw new Error("embassy data " + r.status);
    const lines = (await r.text()).split("\n").slice(1);
    const out: Record<string, any[]> = {};
    for (const line of lines) {
      const f = line.split(";");
      if (f.length < 25 || !KEEP.has(f[21])) continue;
      (out[f[0]] ||= []).push({ c: f[4], city: f[6], t: f[21], a: f[8], ph: f[11], em: f[12], w: f[13], j: f[2] });
    }
    EMB = out;
  })().catch(e => { embLoading = null; throw e; });
  return embLoading;
}
loadEmb().catch(() => {});

// ---------- Live tracking (Postgres) ----------
const sql = Bun.env.DATABASE_URL ? new SQL(Bun.env.DATABASE_URL) : null;
let dbReady: Promise<void> | null = null;
function initDb() {
  if (!sql) return Promise.reject(new Error("no database"));
  if (!dbReady) dbReady = (async () => {
    await sql`CREATE TABLE IF NOT EXISTS track_sessions (id text PRIMARY KEY, key_hash text NOT NULL, name text, created_at timestamptz NOT NULL DEFAULT now(), ended_at timestamptz, expires_at timestamptz NOT NULL, last_at timestamptz)`;
    await sql`CREATE TABLE IF NOT EXISTS track_points (session_id text NOT NULL REFERENCES track_sessions(id) ON DELETE CASCADE, t timestamptz NOT NULL DEFAULT now(), lat double precision NOT NULL, lng double precision NOT NULL, acc real, bat real)`;
    await sql`CREATE INDEX IF NOT EXISTS track_points_sid_t ON track_points (session_id, t)`;
    await sql`CREATE TABLE IF NOT EXISTS partners (slug text PRIMARY KEY, name text NOT NULL, wa text NOT NULL, active boolean NOT NULL DEFAULT true, created_at timestamptz NOT NULL DEFAULT now())`;
    await sql`ALTER TABLE partners ADD COLUMN IF NOT EXISTS tel text NOT NULL DEFAULT ''`;
    await sql`ALTER TABLE partners ADD COLUMN IF NOT EXISTS sponsor_days integer NOT NULL DEFAULT 0`;
    await sql`ALTER TABLE partners ADD COLUMN IF NOT EXISTS sponsor_until date`;
    await sql`CREATE TABLE IF NOT EXISTS sponsor_grants (install_id uuid NOT NULL, slug text NOT NULL, days integer NOT NULL, granted_at timestamptz NOT NULL DEFAULT now(), PRIMARY KEY (install_id, slug))`;
    await sql`CREATE TABLE IF NOT EXISTS usage_daily (day date NOT NULL, slug text NOT NULL, event text NOT NULL, n integer NOT NULL DEFAULT 0, PRIMARY KEY (day, slug, event))`;
    // country is an added dimension (see geoCountry above) -- existing rows default to
    // '' so history reported before this change is untouched. The old 3-column primary
    // key is replaced with a 4-column unique index so the same (day, slug, event) can
    // now have one row per country; usageEvent()'s ON CONFLICT target below must match.
    await sql`ALTER TABLE usage_daily ADD COLUMN IF NOT EXISTS country text NOT NULL DEFAULT ''`;
    await sql`ALTER TABLE usage_daily DROP CONSTRAINT IF EXISTS usage_daily_pkey`;
    await sql`CREATE UNIQUE INDEX IF NOT EXISTS usage_daily_uq ON usage_daily (day, slug, event, country)`;
    // Install records for the international free trial (shadow mode: recorded, never enforced).
    // No personal data: a random ID, a hashed random credential (in an HttpOnly cookie), dates,
    // and the 2-letter country looked up from the IP at the time (the IP itself is not stored).
    await sql`CREATE TABLE IF NOT EXISTS app_installs (
      id uuid PRIMARY KEY, cred_hash text NOT NULL,
      created_at timestamptz NOT NULL DEFAULT now(), last_seen_at timestamptz NOT NULL DEFAULT now(),
      trial_started_at timestamptz NOT NULL DEFAULT now(), trial_ends_at timestamptz NOT NULL,
      first_country text, last_country text, country_resolved_at timestamptz,
      sg_exempt boolean NOT NULL DEFAULT false, policy_version text NOT NULL,
      first_slug text NOT NULL DEFAULT '', platform text NOT NULL DEFAULT '')`;
    await sql`CREATE INDEX IF NOT EXISTS app_installs_seen ON app_installs (last_seen_at)`;
    // Live-tracking subscription (PAYWALL_ENABLED gates it; see "Live tracking entitlement" below).
    await sql`ALTER TABLE app_installs ADD COLUMN IF NOT EXISTS owner boolean NOT NULL DEFAULT false`;
    await sql`ALTER TABLE app_installs ADD COLUMN IF NOT EXISTS free_session_used boolean NOT NULL DEFAULT false`;
    await sql`ALTER TABLE app_installs ADD COLUMN IF NOT EXISTS free_session_at timestamptz`;
    await sql`ALTER TABLE app_installs ADD COLUMN IF NOT EXISTS shadow_free_used boolean NOT NULL DEFAULT false`;
    await sql`ALTER TABLE app_installs ADD COLUMN IF NOT EXISTS paid_until timestamptz`;
    await sql`ALTER TABLE app_installs ADD COLUMN IF NOT EXISTS sub_status text`;
    await sql`ALTER TABLE app_installs ADD COLUMN IF NOT EXISTS stripe_customer_id text`;
    await sql`ALTER TABLE app_installs ADD COLUMN IF NOT EXISTS stripe_subscription_id text`;
    await sql`ALTER TABLE app_installs ADD COLUMN IF NOT EXISTS sub_updated_at timestamptz`;
    await sql`ALTER TABLE app_installs ADD COLUMN IF NOT EXISTS pass_days_banked integer NOT NULL DEFAULT 0`;
    await sql`CREATE INDEX IF NOT EXISTS app_installs_sub ON app_installs (stripe_subscription_id)`;
    await sql`ALTER TABLE track_sessions ADD COLUMN IF NOT EXISTS free_session boolean NOT NULL DEFAULT false`;
    await sql`ALTER TABLE track_sessions ADD COLUMN IF NOT EXISTS country text NOT NULL DEFAULT ''`;
    await sql`ALTER TABLE track_sessions ADD COLUMN IF NOT EXISTS install_id uuid`;
    // Price A/B test: each install's cohort (A or B), from a hash of its ID, plus per-cohort daily funnel counts.
    await sql`ALTER TABLE app_installs ADD COLUMN IF NOT EXISTS ab_cohort text`;
    await sql`CREATE TABLE IF NOT EXISTS ab_daily (day date NOT NULL, cohort text NOT NULL, event text NOT NULL, n bigint NOT NULL DEFAULT 0, PRIMARY KEY (day, cohort, event))`;
    await sql`CREATE TABLE IF NOT EXISTS stripe_events (id text PRIMARY KEY, type text NOT NULL, received_at timestamptz NOT NULL DEFAULT now())`;
  })().catch(e => { dbReady = null; throw e; });
  return dbReady;
}
initDb().catch(() => {});
function randomId(bytes: number) {
  const b = crypto.getRandomValues(new Uint8Array(bytes));
  return Buffer.from(b).toString("base64url");
}
function hashKey(key: string) { return new Bun.CryptoHasher("sha256").update(key).digest("hex"); }
const starts = new Map<string, number[]>();
function allowStart(ip: string) {
  const now = Date.now(), list = (starts.get(ip) || []).filter(t => now - t < 3600e3);
  if (list.length >= 30) return false;
  list.push(now); starts.set(ip, list); return true;
}
const json = (d: any, status = 200) => Response.json(d, { status, headers: { ...common, "Cache-Control": "no-store" } });
async function readBody(req: Request) { try { return await req.json(); } catch { return {}; } }
async function checkKey(id: string, key: string) {
  const rows = await sql!`SELECT id, key_hash, ended_at, expires_at, last_at FROM track_sessions WHERE id = ${id}`;
  const s = rows[0];
  if (!s || typeof key !== "string" || s.key_hash !== hashKey(key)) return null;
  return s;
}
async function trackApi(req: Request, url: URL) {
  await initDb();
  const parts = url.pathname.split("/").filter(Boolean); // api, track, [id], [action]
  if (req.method === "POST" && parts.length === 3 && parts[2] === "start") {
    const ip = clientIp(req);
    if (!allowStart(ip)) return json({ error: "Too many tracking links started. Try again later." }, 429);
    const body: any = await readBody(req);
    // Only STARTING a live map is ever gated. Points and ends for a running live map never check it.
    await loadPartners();
    // Demo mode (?demo=pass): a live map that lasts 10 minutes, for showing the flow. Not gated, not counted.
    const demo = body.demo === 1;
    const gate = demo ? { allowed: true, paywall: false, country: "", installId: null, paidUntil: null } : await liveTrackGate(req, String(body.p || ""));
    if (!gate.allowed) return json({ error: "Live tracking needs a pass", code: "livetrack_locked" }, 403);
    const id = randomId(16), key = randomId(24);
    const name = String(body.name || "").slice(0, 40);
    // A live map runs until "I'm safe" / "Stop sharing". It also stops when the pass ends (paywall on; never
    // sooner than 24 hours after it starts), and in any case after LIVE_MAX_DAYS, so a forgotten one ends.
    const ins = await sql!`INSERT INTO track_sessions (id, key_hash, name, expires_at, free_session, country, install_id)
      VALUES (${id}, ${hashKey(key)}, ${name}, LEAST(now() + make_interval(days => ${LIVE_MAX_DAYS}), now() + make_interval(mins => ${demo ? 10 : 60 * 24 * LIVE_MAX_DAYS}),
        CASE WHEN ${gate.paywall} THEN GREATEST(COALESCE(${gate.paidUntil}::timestamptz, now()), now() + interval '24 hours')
             ELSE now() + make_interval(days => ${LIVE_MAX_DAYS}) END), false, ${gate.country}, ${gate.installId}::uuid)
      RETURNING expires_at`;
    sql!`DELETE FROM track_sessions WHERE expires_at < now() - interval '7 days'`.catch(() => {});
    const base = PUBLIC_URL || url.origin;
    return json({ id, key, url: `${base}/t/${id}`, expiresIn: Math.round((new Date(ins[0].expires_at).getTime() - Date.now()) / 1000) });
  }
  const id = parts[2] || "";
  if (!/^[A-Za-z0-9_-]{10,40}$/.test(id)) return json({ error: "Not found" }, 404);
  if (req.method === "POST" && parts[3] === "point") {
    const b: any = await readBody(req);
    const s = await checkKey(id, b.key);
    if (!s) return json({ error: "Not allowed" }, 403);
    if (s.ended_at || new Date(s.expires_at) < new Date()) return json({ error: "Tracking has ended" }, 410);
    const lat = Number(b.lat), lng = Number(b.lng);
    if (!(lat >= -90 && lat <= 90 && lng >= -180 && lng <= 180)) return json({ error: "Bad location" }, 400);
    if (s.last_at && Date.now() - new Date(s.last_at).getTime() < 4000) return json({ ok: true, skipped: true });
    const acc = Number.isFinite(Number(b.acc)) ? Math.min(Number(b.acc), 100000) : null;
    const bat = Number.isFinite(Number(b.bat)) ? Math.max(0, Math.min(1, Number(b.bat))) : null;
    await sql!`INSERT INTO track_points (session_id, lat, lng, acc, bat) VALUES (${id}, ${lat}, ${lng}, ${acc}, ${bat})`;
    await sql!`UPDATE track_sessions SET last_at = now() WHERE id = ${id}`;
    return json({ ok: true, expires: new Date(s.expires_at).getTime() }); // the end can move later when more pass days are bought
  }
  if (req.method === "POST" && parts[3] === "end") {
    const b: any = await readBody(req);
    const s = await checkKey(id, b.key);
    if (!s) return json({ error: "Not allowed" }, 403);
    await sql!`UPDATE track_sessions SET ended_at = now() WHERE id = ${id} AND ended_at IS NULL`;
    return json({ ok: true });
  }
  if (req.method === "POST" && parts[3] === "delete") {
    // Self-service deletion: only the phone that created the live map holds its key.
    const b: any = await readBody(req);
    const s = await checkKey(id, b.key);
    if (!s) return json({ ok: true, gone: true }); // unknown or already deleted: nothing left to remove
    await sql!`DELETE FROM track_sessions WHERE id = ${id}`; // points are removed with it (ON DELETE CASCADE)
    return json({ ok: true, deleted: true });
  }
  if (req.method === "GET" && parts.length === 3) {
    const rows = await sql!`SELECT name, created_at, ended_at, expires_at, last_at FROM track_sessions WHERE id = ${id}`;
    const s = rows[0];
    if (!s) return json({ error: "Not found" }, 404);
    const expired = new Date(s.expires_at) < new Date();
    const pts = await sql!`SELECT t, lat, lng, acc, bat FROM (SELECT * FROM track_points WHERE session_id = ${id} ORDER BY t DESC LIMIT 1000) p ORDER BY t ASC`;
    return json({ name: s.name, created: s.created_at, ended: s.ended_at, expired, expires: s.expires_at, now: new Date(),
      points: pts.map((p: any) => [new Date(p.t).getTime(), p.lat, p.lng, p.acc, p.bat]) });
  }
  return json({ error: "Not found" }, 404);
}

const VIEWER = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<meta name="robots" content="noindex, nofollow"><title>Live location · ScamGuard SOS</title>
<link rel="icon" href="/icon.svg" type="image/svg+xml">
<link rel="stylesheet" href="https://cdnjs.cloudflare.com/ajax/libs/leaflet/1.9.4/leaflet.min.css">
<style>
:root{--bg:#F2F4F6;--surface:#fff;--ink:#13212E;--ink-2:#4A5A68;--line:#D9DFE5;--sos:#D7302A;--safe:#157F55;--warn:#B97A00}
@media (prefers-color-scheme:dark){:root{--bg:#0D151D;--surface:#16212C;--ink:#E8EEF3;--ink-2:#9AABB9;--line:#27384A;--sos:#EF4A40;--safe:#4CC98E;--warn:#F2B53A}}
*{box-sizing:border-box}html,body{height:100%;margin:0}
body{background:var(--bg);color:var(--ink);font:15px/1.45 system-ui,-apple-system,"Segoe UI",sans-serif;display:flex;flex-direction:column}
header{padding:calc(env(safe-area-inset-top,0px) + 10px) 16px 10px;background:var(--surface);border-bottom:1px solid var(--line);display:flex;flex-direction:column;gap:6px}
.top{display:flex;justify-content:space-between;align-items:center;gap:10px;flex-wrap:wrap}
.brand{font-weight:800;letter-spacing:.04em;text-transform:uppercase}.brand span{color:var(--sos)}
.pill{font-weight:700;font-size:13px;padding:5px 10px;border-radius:999px;color:#fff;background:var(--ink-2)}
.pill.live{background:var(--sos)}.pill.stale{background:var(--warn)}.pill.done{background:var(--safe)}
h1{font-size:18px;margin:0}.meta{color:var(--ink-2);font-size:13px}
#map{flex:1;min-height:300px}
footer{padding:10px 16px calc(env(safe-area-inset-bottom,0px) + 10px);background:var(--surface);border-top:1px solid var(--line);display:flex;gap:10px;flex-wrap:wrap}
footer a{flex:1 1 140px;text-align:center;padding:12px;border-radius:12px;font-weight:700;text-decoration:none;background:var(--ink);color:var(--bg)}
footer a.alt{background:transparent;color:var(--ink);border:1px solid var(--line)}
.msg{padding:24px 16px;text-align:center;color:var(--ink-2)}
</style></head><body>
<header><div class="top"><div class="brand">Scam<span>Guard</span> SOS</div><div class="pill" id="pill"></div></div>
<h1 id="title"></h1><div class="meta" id="meta"></div></header>
<div id="map"></div>
<footer><a id="gmaps" href="#" target="_blank" rel="noopener"></a><a class="alt" href="tel:" id="callHint" hidden>Call</a></footer>
<script src="https://cdnjs.cloudflare.com/ajax/libs/leaflet/1.9.4/leaflet.min.js"></script>
<script>
(function(){
var VI=${VIEW_I18N}, LG="en";
(navigator.languages&&navigator.languages.length?navigator.languages:[navigator.language||"en"]).some(function(x){var b=String(x||"").toLowerCase().split("-")[0];if(b==="in")b="id";if(VI[b]){LG=b;return true;}return false;});
function V(k,o){var s=(VI[LG]&&VI[LG][k])||VI.en[k]||k;if(o)for(var n in o)s=s.split("{"+n+"}").join(o[n]);return s;}
document.documentElement.lang=LG;document.title=V("title")+" · ScamGuard SOS";
var id=location.pathname.split("/").pop(), map, dot, ring, trail, fitted=false, hasMap=typeof L!=="undefined";
function ago(ms){var s=Math.round(ms/1000);if(s<60)return V("secAgo",{n:s});var m=Math.round(s/60);if(m<60)return V("minAgo",{n:m});return V("hAgo",{n:Math.round(m/60)});}
function el(i){return document.getElementById(i);}
el("pill").textContent=V("loading");el("title").textContent=V("title");el("meta").textContent=V("connecting");el("gmaps").textContent=V("openGmaps");
function initMap(){map=L.map("map",{zoomControl:true});L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png",{maxZoom:19,attribution:"&copy; OpenStreetMap contributors"}).addTo(map);map.setView([1.35,103.82],11);}
async function load(){
  try{
    var r=await fetch("/api/track/"+id,{cache:"no-store"});
    if(r.status===404){el("pill").textContent=V("notFound");el("meta").textContent=V("notFoundBody");return;}
    var d=await r.json(), pts=d.points||[], now=new Date(d.now).getTime();
    el("title").textContent=d.name?V("titleName",{name:d.name}):V("title");
    var last=pts[pts.length-1], pill=el("pill");
    if(d.ended){pill.className="pill done";pill.textContent=V("markedSafe");}
    else if(d.expired){pill.className="pill";pill.textContent=V("expired");}
    else if(last && now-last[0]<120000){pill.className="pill live";pill.textContent=V("live");}
    else{pill.className="pill stale";pill.textContent=V("waiting");}
    if(!last){el("meta").textContent=d.ended?V("endedNoLoc"):V("noLocYet");return;}
    var ll=[last[1],last[2]];
    el("meta").textContent=V("updated",{ago:ago(now-last[0])})+" · ±"+Math.round(last[3]||0)+" m"+(last[4]!=null?" · "+V("battery",{n:Math.round(last[4]*100)}):"")+(d.ended?" · "+V("stopped",{ago:ago(now-new Date(d.ended).getTime())}):"");
    el("gmaps").href="https://maps.google.com/?q="+last[1]+","+last[2];
    var line=pts.map(function(p){return[p[1],p[2]];});
    if(!hasMap){}
    else if(!dot){dot=L.circleMarker(ll,{radius:9,color:"#fff",weight:3,fillColor:"#D7302A",fillOpacity:1}).addTo(map);ring=L.circle(ll,{radius:last[3]||0,color:"#D7302A",weight:1,fillOpacity:.12}).addTo(map);trail=L.polyline(line,{color:"#D7302A",weight:4,opacity:.6}).addTo(map);}
    else{dot.setLatLng(ll);ring.setLatLng(ll).setRadius(last[3]||0);trail.setLatLngs(line);}
    if(hasMap&&!fitted){map.setView(ll,16);fitted=true;}
  }catch(e){el("meta").textContent=V("retry");}
}
if(hasMap)initMap();else {el("map").innerHTML='<div class="msg"></div>';el("map").firstChild.textContent=V("mapFail");}
load();setInterval(load,10000);
document.addEventListener("visibilitychange",function(){if(!document.hidden)load();});
})();
</script></body></html>`;

// ---------- Partners ----------
let PARTNERS = new Map<string, Partner>();
let partnersAt = 0, partnersLoading: Promise<void> | null = null;
async function loadPartners(force = false) {
  if (!force && Date.now() - partnersAt < 60_000) return;
  if (partnersLoading && !force) return partnersLoading;
  partnersLoading = (async () => {
    await initDb();
    const rows = await sql!`SELECT slug, name, wa, tel, active, sponsor_days, to_char(sponsor_until, 'YYYY-MM-DD') AS sponsor_until FROM partners`;
    PARTNERS = new Map(rows.map((r: any) => [r.slug, { slug: r.slug, name: r.name, wa: r.wa, tel: r.tel || "", active: r.active, sponsorDays: r.sponsor_days || 0, sponsorUntil: r.sponsor_until || "" }]));
    partnersAt = Date.now(); pageCache.clear();
  })().catch(e => { console.error("partners", e); }).finally(() => { partnersLoading = null; });
  return partnersLoading;
}
loadPartners(true);
const RESERVED = new Set(["admin", "api", "t", "privacy", "security", "delete-data", "health", "icons", "sw", "robots", "manifest", "icon", "apple-touch-icon", "well-known", "www", "public", "app", "sos", "help", "login", "logout", "static", "assets"]);
const SLUG_RE = /^[a-z0-9](?:[a-z0-9-]{0,28}[a-z0-9])$/;
function activePartner(slug: string) { const p = PARTNERS.get(slug); return p && p.active ? p : null; }
// The partner behind this link, if it currently pays for its users' live tracking.
function sponsorOf(slug: string) {
  const p = activePartner(String(slug || "").slice(0, 30));
  if (!p || !p.sponsorDays) return null;
  const today = new Date(Date.now() + 8 * 3600e3).toISOString().slice(0, 10); // Singapore date
  return p.sponsorUntil && p.sponsorUntil < today ? null : p;
}
async function countPartner(event: string, slug: string, country: string) {
  try {
    await sql!`INSERT INTO usage_daily (day, slug, event, country, n) VALUES ((now() AT TIME ZONE 'Asia/Singapore')::date, ${slug}, ${event}, ${country || ""}, 1)
               ON CONFLICT (day, slug, event, country) DO UPDATE SET n = usage_daily.n + 1`;
  } catch (e) { console.error("count", e); }
}

// ---------- Anonymous usage counts (totals per day, no personal data) ----------
const EVENTS = new Set(["open", "new", "install", "sos", "claim", "check"]);
// Live-tracking subscription counters. Kept out of EVENTS so the partner usage table is unchanged.
// The app sends the first three; the server records the rest itself.
const MONEY_CLIENT_EVENTS = new Set(["welcome_prompt_shown", "livetrack_lock_shown", "upgrade_tapped", "liveline_tapped"]);
const MONEY_EVENTS = ["welcome_prompt_shown", "liveline_tapped", "livetrack_locked", "livetrack_lock_shown", "upgrade_tapped", "checkout_started", "paid", "pass_3", "pass_5", "pass_7", "pass_14", "pass_30"];
const hits = new Map<string, number[]>();
function allow(bucket: string, ip: string, max: number, windowMs: number) {
  const k = bucket + ":" + ip, now = Date.now(), list = (hits.get(k) || []).filter(t => now - t < windowMs);
  if (list.length >= max) { hits.set(k, list); return false; }
  list.push(now); hits.set(k, list); return true;
}
setInterval(() => { const now = Date.now(); for (const [k, v] of hits) if (!v.length || now - v[v.length - 1] > 3600e3) hits.delete(k); }, 600e3);
// Railway's edge sets X-Real-IP to the visitor's address (a visitor can't forge it the way they can
// add their own X-Forwarded-For entries). X-Forwarded-For is only a fallback for local development.
const clientIp = (req: Request) => req.headers.get("x-real-ip")?.trim() || req.headers.get("x-forwarded-for")?.split(",").pop()?.trim() || "local";
// Country-only geolocation for the usage counters below -- a local DB-IP Country Lite
// mmdb (geo/country.mmdb, CC-BY-4.0 -- attribution in public/admin.html) read with the
// "maxmind" package, so there's no external API call, no latency, and no rate limit on
// the request path. Only the resulting 2-letter code is ever stored (see usageEvent
// below) -- the IP itself never reaches usage_daily, same privacy stance as before.
// Note: this particular mmdb build returns a flat { country_code } shape rather than
// the official MaxMind { country: { iso_code } } one, hence checking both below.
const geoLookup = await maxmind.open(new URL("./geo/country.mmdb", import.meta.url).pathname);
function geoCountry(ip: string): string {
  try { const r: any = geoLookup.get(ip); return r?.country_code || r?.country?.iso_code || ""; } catch { return ""; }
}
const countryOf = (req: Request) => geoCountry(clientIp(req));
async function usageEvent(req: Request) {
  if (!allow("ev", clientIp(req), 300, 3600e3)) return new Response(null, { status: 204 });
  let b: any = {}; try { b = JSON.parse(await req.text()); } catch {}
  const e = String(b.e || ""), slug = String(b.p || "");
  if (!(EVENTS.has(e) || MONEY_CLIENT_EVENTS.has(e)) || (slug && !activePartner(slug))) return new Response(null, { status: 204 });
  await initDb();
  const country = countryOf(req);
  await sql!`INSERT INTO usage_daily (day, slug, event, country, n) VALUES ((now() AT TIME ZONE 'Asia/Singapore')::date, ${slug}, ${e}, ${country}, 1)
             ON CONFLICT (day, slug, event, country) DO UPDATE SET n = usage_daily.n + 1`;
  if (MONEY_CLIENT_EVENTS.has(e)) {
    // Price test: the cohort comes from the install record on the server, not from the app.
    const row = await currentInstall(req);
    if (row && !row.owner) await countAb(e, cohortOf(row));
  }
  return new Response(null, { status: 204 });
}

// ---------- Live tracking passes ----------
// Business rule (owner-confirmed, 12 Oct 2026):
//  - ScamGuard is free worldwide. Every SOS goes out with the phone's GPS location (a one-off map pin).
//  - Live tracking (the live map) needs a one-time pass of 3, 5, 7, 14 or 30 days, bought on the website
//    through Stripe Checkout. No free live map, no Singapore exception. A pass's days start counting at the
//    first live map started after buying it (pass_days_banked until then); days bought while a pass is running
//    are added to it.
//  - Google Play app: GPS only, no pass offer and no payment UI (Play billing rules). A pass bought on the
//    website still works in the Play app on the same phone, because they share the install cookie.
// The SOS message, emergency calls, scam checks, policy number and insurer call shortcut are never gated.
// While PAYWALL_ENABLED is not "true", live tracking stays free for everyone, no Stripe call is made and the
// server only counts how many live maps WOULD have been locked.
const PAYWALL_ENABLED = Bun.env.PAYWALL_ENABLED === "true";
// Owner test: PAYWALL_OWNER_TEST="true" turns the paywall on ONLY for installs opened in owner mode (?notrack=1),
// so real payments can be tried on the owner's phone while everyone else is unaffected.
const PAYWALL_OWNER_TEST = Bun.env.PAYWALL_OWNER_TEST === "true";
// Partner links (an active partner's slug, e.g. /ntuc) are never paywalled: live tracking stays free there.
const paywallOn = (row: any, slug = "") => (PAYWALL_ENABLED || (PAYWALL_OWNER_TEST && !!(row && row.owner))) && !activePartner(String(slug || "").slice(0, 30));
const TRIAL_POLICY = "v3-gps-free-livetrack-pass";
const STRIPE_KEY = Bun.env.STRIPE_SECRET_KEY || "";
const STRIPE_WEBHOOK_SECRET = Bun.env.STRIPE_WEBHOOK_SECRET || "";
// One Stripe one-time Price per pass, e.g. STRIPE_PASS_PRICES="3:price_aaa,5:price_bbb,7:price_ccc,14:price_ddd,30:price_eee".
// Only the lengths listed here are offered. Amounts and currency are read from Stripe, never typed twice.
const PASS_DAYS = [3, 5, 7, 14, 30];
const PASS_PRICES: Record<number, string> = Object.fromEntries((Bun.env.STRIPE_PASS_PRICES || "").split(",")
  .map(x => x.trim().split(":")).filter(([d, id]) => PASS_DAYS.includes(Number(d)) && /^price_\w+$/.test(id || ""))
  .map(([d, id]) => [Number(d), id]));
// ---- Price A/B test ----
// Every install gets a stable cohort from a hash of its ID (same install, same cohort, always), stored on its record.
//  A: the passes in STRIPE_PASS_PRICES (3, 5, 7 and 14 days).
//  B: one 30-day pass at S$2.99. Fill in its Stripe price ID below (or set STRIPE_PASS_PRICE_B_30 in Railway).
// While B has no price, cohort B is shown A's passes, so nobody sees a different price.
const PRICE_B_30D = "" /* <- the S$2.99 30-day one-time price ID, e.g. "price_1Abc..." */ || Bun.env.STRIPE_PASS_PRICE_B_30 || "";
const PRICES_A: Record<number, string> = PASS_PRICES;
const PRICES_B: Record<number, string> = /^price_\w+$/.test(PRICE_B_30D) ? { 30: PRICE_B_30D } : {};
const AB_ON = Object.keys(PRICES_B).length > 0;
const cohortHash = (id: string) => (new Bun.CryptoHasher("sha256").update("scamguard-price-ab-v1:" + id).digest()[0] & 1) ? "B" : "A";
const cohortOf = (row: any) => (row && (row.ab_cohort === "A" || row.ab_cohort === "B")) ? row.ab_cohort : row && row.id ? cohortHash(String(row.id)) : "A";
const pricesFor = (cohort: string) => cohort === "B" && AB_ON ? PRICES_B : PRICES_A;
async function countAb(event: string, cohort: string, n = 1) {
  try {
    await sql!`INSERT INTO ab_daily (day, cohort, event, n) VALUES ((now() AT TIME ZONE 'Asia/Singapore')::date, ${cohort}, ${event}, ${n})
               ON CONFLICT (day, cohort, event) DO UPDATE SET n = ab_daily.n + ${n}`;
  } catch (e) { console.error("ab count", e); }
}
// EU VAT: Stripe Tax on the Checkout Session. Off until the owner decides (needs Stripe Tax set up first).
const STRIPE_TAX = Bun.env.STRIPE_TAX === "true";
const stripeConfigured = () => !!STRIPE_KEY && Object.keys(PASS_PRICES).length > 0;
const billingReady = (row: any) => paywallOn(row) && stripeConfigured();
// Amounts are read from Stripe per price ID and cached for an hour.
const priceCache = new Map<string, { at: number; amount: number; currency: string } | null>();
async function priceInfo(id: string) {
  const c = priceCache.get(id);
  if (c && Date.now() - c.at < 3600e3) return c;
  try {
    const pr = await stripe("GET", "/v1/prices/" + id);
    if (pr && pr.active !== false && Number.isFinite(pr.unit_amount) && pr.currency) {
      const v = { at: Date.now(), amount: pr.unit_amount, currency: String(pr.currency).toUpperCase() }; priceCache.set(id, v); return v;
    }
  } catch (e) { console.error("price", id, e); }
  return null;
}
async function passOffers(cohort = "A") {
  if (!(PAYWALL_ENABLED || PAYWALL_OWNER_TEST) || !stripeConfigured()) return [];
  const map = pricesFor(cohort), list: { days: number; amount: number; currency: string }[] = [];
  for (const d of PASS_DAYS) {
    if (!map[d]) continue;
    const p = await priceInfo(map[d]);
    if (p) list.push({ days: d, amount: p.amount, currency: p.currency });
  }
  return list;
}
async function countServer(event: string, country: string) {
  try {
    await sql!`INSERT INTO usage_daily (day, slug, event, country, n) VALUES ((now() AT TIME ZONE 'Asia/Singapore')::date, '', ${event}, ${country || ""}, 1)
               ON CONFLICT (day, slug, event, country) DO UPDATE SET n = usage_daily.n + 1`;
  } catch (e) { console.error("count", e); }
}
function paidActive(row: any, now = Date.now()) {
  return !!(row && row.paid_until && new Date(row.paid_until).getTime() > now);
}
const hasPass = (row: any) => paidActive(row) || !!(row && row.pass_days_banked > 0);
// May this install start a live map? Only an active pass allows it once the paywall is on.
const LIVE_MAX_DAYS = 30; // longest a single live map can run if nobody taps "I'm safe" or "Stop sharing"
async function liveTrackGate(req: Request, slug = ""): Promise<{ allowed: boolean; paywall: boolean; country: string; installId: string | null; paidUntil: Date | null }> {
  const r0 = await currentInstall(req);
  const res = (allowed: boolean, row: any) => ({ allowed, paywall: paywallOn(row, slug), country, installId: row ? row.id : null, paidUntil: row && row.paid_until ? new Date(row.paid_until) : null });
  const country = (r0 && r0.first_country) || countryOf(req) || "";
  const row = r0;
  const pp = activePartner(String(slug || "").slice(0, 30));
  if (pp && (PAYWALL_ENABLED || (PAYWALL_OWNER_TEST && row && row.owner))) {
    // Partner link: free live map, counted for the partner's report.
    if (!row || !row.owner) countPartner("sponsored_live", pp.slug, country);
    return res(true, row);
  }
  const sp = paywallOn(row, slug) ? sponsorOf(slug) : null;
  if (sp && sp.sponsorDays === -1) {
    // The partner includes live tracking on its link: no limit, counted for the partner's report.
    if (!row || !row.owner) countPartner("sponsored_live", sp.slug, country);
    return { allowed: true, paywall: true, country, installId: row ? row.id : null, paidUntil: null };
  }
  if (sp && (paidActive(row) || (row && row.pass_days_banked > 0)) && (!row || !row.owner)) countPartner("sponsored_live", sp.slug, country);
  if (paidActive(row)) return res(true, row);
  if (row && row.pass_days_banked > 0) {
    // First live map after buying: the banked days start now. One atomic statement, so two taps can't start it twice.
    const st = await sql!`UPDATE app_installs SET paid_until = now() + make_interval(days => pass_days_banked), pass_days_banked = 0
      WHERE id = ${row.id} AND pass_days_banked > 0 AND (paid_until IS NULL OR paid_until <= now()) RETURNING id`;
    const now = (await sql!`SELECT * FROM app_installs WHERE id = ${row.id}`)[0];
    if (st.length || paidActive(now)) return res(true, now);
  }
  if (!row || !row.owner) countServer("livetrack_locked", country); // shadow mode: "would have been locked"
  return res(!paywallOn(row, slug), row);
}
const INST_COOKIE = "sg_inst";
function readInstCookie(req: Request) {
  const m = (req.headers.get("cookie") || "").match(/(?:^|;\s*)sg_inst=([0-9a-f-]{36})\.([A-Za-z0-9_-]{43})/);
  return m ? { id: m[1], cred: m[2] } : null;
}
async function currentInstall(req: Request) {
  const c = readInstCookie(req); if (!c) return null;
  const r = await sql!`SELECT * FROM app_installs WHERE id = ${c.id}::uuid`;
  return r[0] && safeEq(r[0].cred_hash, hashKey(c.cred)) ? r[0] : null;
}
async function entitlement(row: any, slug = "") {
  const pw = paywallOn(row, slug), sp = pw ? sponsorOf(slug) : null, unlimited = !!(sp && sp.sponsorDays === -1);
  const paid = hasPass(row) || unlimited;
  return {
    paywall: pw, billing: pw && stripeConfigured() && row.platform !== "play" && !sp, passes: !pw || row.platform === "play" || sp ? [] : await passOffers(cohortOf(row)), cohort: cohortOf(row),
    live: { allowed: !pw || paid, reason: unlimited ? "partner" : paid ? "pass" : "gps_only" },
    sponsor: sp ? { name: sp.name, days: sp.sponsorDays } : null,
    paid, paidUntil: paidActive(row) ? row.paid_until : null, daysReady: row.pass_days_banked || 0,
    firstCountry: row.first_country || null, policy: TRIAL_POLICY, serverNow: Date.now(),
  };
}
const instHeaders = (cookie?: string) => ({ ...common, "Cache-Control": "no-store", ...(cookie ? { "Set-Cookie": cookie } : {}) });
async function installApi(req: Request, path: string) {
  if (req.method === "GET" && path === "/api/entitlement") {
    await initDb(); const row = await currentInstall(req);
    await loadPartners();
    const slug = new URL(req.url).searchParams.get("p") || "";
    return Response.json(row ? await entitlement(row, slug) : { reason: "unregistered" }, { status: row ? 200 : 404, headers: instHeaders() });
  }
  if (req.method === "GET" && path === "/api/passes") {
    // The demo link (?demo=pass) shows this install's cohort prices, so demos match what real users see.
    await initDb(); const row = await currentInstall(req);
    const cohort = cohortOf(row);
    return Response.json({ cohort, passes: stripeConfigured() ? await passOffers(cohort) : [] }, { headers: instHeaders() });
  }
  if (req.method !== "POST" || req.headers.get("x-sg") !== "1") return json({ error: "Bad request" }, 400);
  await initDb();
  if (path === "/api/install/hello") {
    let b: any = {}; try { b = await req.json(); } catch {}
    const country = countryOf(req) || null;
    await loadPartners();
    const slug = String(b.p || "").slice(0, 30);
    // A partner that gives each user N days: granted once per phone per partner, banked until the first live map.
    const grant = async (r: any) => {
      const sp = paywallOn(r, slug) ? sponsorOf(slug) : null;
      if (!sp || sp.sponsorDays <= 0 || r.platform === "play") return r;
      const g = await sql!`INSERT INTO sponsor_grants (install_id, slug, days) VALUES (${r.id}::uuid, ${sp.slug}, ${sp.sponsorDays}) ON CONFLICT DO NOTHING RETURNING days`;
      if (!g.length) return r;
      if (!r.owner) countPartner("sponsor_granted", sp.slug, r.first_country || "");
      const u = await sql!`UPDATE app_installs SET
          paid_until = CASE WHEN paid_until > now() THEN paid_until + make_interval(days => ${sp.sponsorDays}) ELSE paid_until END,
          pass_days_banked = CASE WHEN paid_until > now() THEN pass_days_banked ELSE pass_days_banked + ${sp.sponsorDays} END
        WHERE id = ${r.id} RETURNING *`;
      return u[0] || r;
    };
    const row = await currentInstall(req);
    if (row) {
      const resolveNow = !row.first_country && country;
      const upd = await sql!`UPDATE app_installs SET last_seen_at = now(), last_country = COALESCE(${country}, last_country),
          owner = owner OR ${b.owner === 1}, ab_cohort = COALESCE(ab_cohort, ${cohortHash(String(row.id))}), platform = CASE WHEN ${b.platform === "play"} THEN 'play' ELSE platform END,
          first_country = COALESCE(first_country, ${country}), country_resolved_at = CASE WHEN ${!!resolveNow} THEN now() ELSE country_resolved_at END,
          sg_exempt = CASE WHEN ${!!resolveNow} THEN ${country === "SG"} ELSE sg_exempt END
        WHERE id = ${row.id} RETURNING *`;
      return Response.json(await entitlement(await grant(upd[0]), slug), { headers: instHeaders() });
    }
    if (!allow("inst", clientIp(req), 30, 3600e3)) return json({ error: "Too many requests" }, 429);
    const id = crypto.randomUUID(), cred = randomId(32);
    const platform = ["browser", "homescreen", "play"].includes(b.platform) ? b.platform : "browser";
    const ins = await sql!`INSERT INTO app_installs (id, cred_hash, trial_ends_at, first_country, last_country, country_resolved_at, sg_exempt, policy_version, first_slug, platform, owner, ab_cohort)
      VALUES (${id}::uuid, ${hashKey(cred)}, now(), ${country}, ${country}, ${country ? new Date() : null}, ${country === "SG"}, ${TRIAL_POLICY}, ${slug}, ${platform}, ${b.owner === 1}, ${cohortHash(id)}) RETURNING *`;
    const cookie = `${INST_COOKIE}=${id}.${cred}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${400 * 86400}`;
    return Response.json(await entitlement(await grant(ins[0]), slug), { headers: instHeaders(cookie) });
  }
  if (path === "/api/install/forget") {
    const row = await currentInstall(req);
    if (row) await sql!`DELETE FROM app_installs WHERE id = ${row.id}`;
    // A pass is tied to this install record, so clearing data ends it; the app warns before that happens.
    return Response.json({ ok: true, hadPass: hasPass(row) }, { headers: instHeaders(`${INST_COOKIE}=; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=0`) });
  }
  if (path === "/api/billing/checkout") {
    let b: any = {}; try { b = await req.json(); } catch {}
    const days = Number(b.days);
    const row = await currentInstall(req);
    if (!billingReady(row)) return json({ error: "Live tracking passes aren't available yet", code: "billing_off" }, 409);
    if (!row) return json({ error: "Open the app again and retry", code: "no_install" }, 409);
    // The price is fixed into the Checkout Session here, so a buyer keeps the price they were shown.
    const cohort = cohortOf(row), priceId = pricesFor(cohort)[days];
    if (!priceId) return json({ error: "Unknown pass", code: "bad_pass" }, 400);
    if (row.platform === "play") return json({ error: "Not available in the Play app", code: "play_app" }, 409);
    if (!allow("checkout", clientIp(req), 10, 3600e3)) return json({ error: "Too many requests" }, 429);
    const origin = PUBLIC_URL || new URL(req.url).origin;
    const f: Record<string, string> = {
      mode: "payment", "line_items[0][price]": priceId, "line_items[0][quantity]": "1", "metadata[cohort]": cohort,
      // The Stripe account is shared with the owner's other apps: tag ScamGuard payments, and show
      // "SCAMGUARD" on the card statement after the account's own descriptor.
      client_reference_id: row.id, "metadata[app]": "scamguard", "metadata[install_id]": row.id, "metadata[days]": String(days),
      "payment_intent_data[metadata][app]": "scamguard", "payment_intent_data[metadata][install_id]": row.id, "payment_intent_data[metadata][days]": String(days),
      "payment_intent_data[statement_descriptor_suffix]": "SCAMGUARD",
      success_url: origin + "/?paid=1", cancel_url: origin + "/?paid=0",
    };
    if (STRIPE_TAX) f["automatic_tax[enabled]"] = "true";
    const cs = await stripe("POST", "/v1/checkout/sessions", f);
    if (!cs.url) { console.error("checkout", cs.error); return json({ error: "Couldn't open checkout. Try again." }, 502); }
    if (!row.owner) { countServer("checkout_started", row.first_country || ""); countAb("checkout_started", cohort); }
    return json({ url: cs.url });
  }
  return json({ error: "Not found" }, 404);
}

// ---------- Stripe (no SDK: form-encoded REST calls; card details only ever go to Stripe's hosted pages) ----------
async function stripe(method: string, path: string, form?: Record<string, string>) {
  const r = await fetch((Bun.env.STRIPE_API_BASE || "https://api.stripe.com") + path, {
    method, headers: { Authorization: "Bearer " + STRIPE_KEY, "Content-Type": "application/x-www-form-urlencoded" },
    body: form ? new URLSearchParams(form).toString() : undefined,
  });
  return await r.json().catch(() => ({ error: { message: "Bad response from Stripe" } }));
}
function verifyStripe(raw: string, header: string) {
  if (!STRIPE_WEBHOOK_SECRET) return false;
  const parts = Object.fromEntries(header.split(",").map(x => x.split("=")).filter(x => x.length === 2).map(([k, v]) => [k, v])) as any;
  const sigs = header.split(",").filter(x => x.startsWith("v1=")).map(x => x.slice(3));
  const ts = Number(parts.t);
  if (!ts || !sigs.length || Math.abs(Date.now() / 1000 - ts) > 300) return false;
  const want = new Bun.CryptoHasher("sha256", STRIPE_WEBHOOK_SECRET).update(`${parts.t}.${raw}`).digest("hex");
  return sigs.some((s: string) => safeEq(s, want));
}
async function stripeWebhook(req: Request) {
  const raw = await req.text();
  if (!verifyStripe(raw, req.headers.get("stripe-signature") || "")) return json({ error: "Bad signature" }, 400);
  let ev: any; try { ev = JSON.parse(raw); } catch { return json({ error: "Bad body" }, 400); }
  await initDb();
  const o = ev.data?.object || {};
  // The Stripe account also serves the owner's other apps: anything not tagged as a ScamGuard pass is acknowledged and ignored.
  if (o.metadata?.app !== "scamguard") return json({ received: true, ignored: true });
  // Idempotent: the event ID is recorded in the same transaction as its effect.
  await sql!.begin(async (tx: any) => {
    const fresh = await tx`INSERT INTO stripe_events (id, type) VALUES (${String(ev.id)}, ${String(ev.type)}) ON CONFLICT (id) DO NOTHING RETURNING id`;
    if (!fresh.length) return;
    const paidNow = (ev.type === "checkout.session.completed" && o.payment_status === "paid") || ev.type === "checkout.session.async_payment_succeeded";
    if (paidNow && o.mode === "payment") {
      const installId = String(o.client_reference_id || o.metadata?.install_id || "");
      const days = Number(o.metadata?.days);
      if (!/^[0-9a-f-]{36}$/.test(installId) || !PASS_DAYS.includes(days)) { console.error("stripe: bad pass metadata", o.id); return; }
      // A pass that's running gets the days added on; otherwise they wait (banked) until the first live map.
      const r = await tx`UPDATE app_installs SET stripe_customer_id = COALESCE(${o.customer || null}, stripe_customer_id),
          paid_until = CASE WHEN paid_until > now() THEN paid_until + make_interval(days => ${days}) ELSE paid_until END,
          pass_days_banked = CASE WHEN paid_until > now() THEN pass_days_banked ELSE pass_days_banked + ${days} END,
          sub_status = 'pass', sub_updated_at = now()
        WHERE id = ${installId}::uuid RETURNING first_country, owner, id, ab_cohort`;
      if (!r.length) console.error("stripe: paid pass for unknown install", installId, o.id);
      // A live map already running for this install keeps going until the (now later) end of the pass.
      await tx`UPDATE track_sessions t SET expires_at = LEAST(t.created_at + make_interval(days => ${LIVE_MAX_DAYS}), GREATEST(t.expires_at, a.paid_until))
        FROM app_installs a WHERE a.id = ${installId}::uuid AND t.install_id = a.id AND t.ended_at IS NULL AND t.expires_at > now() AND a.paid_until IS NOT NULL`;
      if (r[0] && !r[0].owner) {
        await countServer("paid", r[0].first_country || ""); await countServer("pass_" + days, r[0].first_country || "");
        const c = o.metadata?.cohort === "A" || o.metadata?.cohort === "B" ? o.metadata.cohort : cohortOf(r[0]);
        await countAb("paid", c); await countAb("pass_" + days, c);
        if (Number.isFinite(o.amount_total)) await countAb("revenue_cents", c, Number(o.amount_total));
      }
    } else if (ev.type === "charge.refunded" || ev.type === "charge.dispute.created") {
      console.log("stripe:", ev.type, o.id, "metadata", JSON.stringify(o.metadata || {})); // logged only; the pass isn't revoked automatically
    }
  });
  return json({ received: true });
}
// Install records not seen for 13 months are deleted.
// Installs with unused pass days are kept; others with a pass are kept until 13 months after it ran out.
setInterval(() => { if (sql) sql`DELETE FROM app_installs WHERE last_seen_at < now() - interval '13 months' AND pass_days_banked = 0 AND (paid_until IS NULL OR paid_until < now() - interval '13 months')`.catch(() => {}); }, 6 * 3600e3);

// ---------- Admin (password in the ADMIN_PASSWORD Railway variable) ----------
const ADMIN_PASSWORD = Bun.env.ADMIN_PASSWORD || "";
const enc = new TextEncoder();
const sha = (x: string) => new Bun.CryptoHasher("sha256").update(x).digest();
const ADMIN_SECRET = sha("scamguard-admin-session:" + ADMIN_PASSWORD);
function sign(v: string) { return new Bun.CryptoHasher("sha256", ADMIN_SECRET).update(v).digest("base64url"); }
function safeEq(a: Uint8Array | string, b: Uint8Array | string) {
  const x = typeof a === "string" ? enc.encode(a) : a, y = typeof b === "string" ? enc.encode(b) : b;
  if (x.length !== y.length) return false;
  let d = 0; for (let i = 0; i < x.length; i++) d |= x[i] ^ y[i]; return d === 0;
}
function isAdmin(req: Request) {
  if (!ADMIN_PASSWORD) return false;
  const m = (req.headers.get("cookie") || "").match(/(?:^|;\s*)sg_admin=([^;]+)/);
  if (!m) return false;
  const [exp, sig] = m[1].split(".");
  return !!exp && !!sig && Number(exp) > Date.now() && safeEq(sig, sign(exp));
}
const noStore = { ...common, "Cache-Control": "no-store", "X-Frame-Options": "DENY", "X-Robots-Tag": "noindex, nofollow" };
const ajson = (d: any, status = 200, extra: Record<string, string> = {}) => Response.json(d, { status, headers: { ...noStore, ...extra } });
function sameOrigin(req: Request) {
  if (req.headers.get("x-requested-with") !== "sg-admin") return false;
  const o = req.headers.get("origin"); if (!o) return true;
  try { return new URL(o).host === (req.headers.get("host") || ""); } catch { return false; }
}
const cleanName = (x: any) => String(x || "").replace(/[<>&"\\`$]/g, "").replace(/\s+/g, " ").trim().slice(0, 60);
const isDay = (x: string) => /^\d{4}-\d{2}-\d{2}$/.test(x);
async function adminApi(req: Request, url: URL) {
  const path = url.pathname;
  if (req.method === "POST" && !sameOrigin(req)) return ajson({ error: "Bad request" }, 400);
  if (path === "/api/admin/login" && req.method === "POST") {
    if (!ADMIN_PASSWORD) return ajson({ error: "Admin isn't set up. Add an ADMIN_PASSWORD variable in Railway." }, 503);
    if (!allow("login", clientIp(req), 10, 15 * 60e3)) return ajson({ error: "Too many attempts. Try again in 15 minutes." }, 429);
    let b: any = {}; try { b = await req.json(); } catch {}
    if (!safeEq(sha(String(b.password || "")), sha(ADMIN_PASSWORD))) return ajson({ error: "Wrong password" }, 401);
    const exp = String(Date.now() + 12 * 3600e3);
    return ajson({ ok: true }, 200, { "Set-Cookie": `sg_admin=${exp}.${sign(exp)}; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=43200` });
  }
  if (path === "/api/admin/logout" && req.method === "POST") return ajson({ ok: true }, 200, { "Set-Cookie": "sg_admin=; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=0" });
  if (!isAdmin(req)) return ajson({ error: "Please log in" }, 401);
  await initDb();
  if (path === "/api/admin/trials" && req.method === "GET") {
    const t = await sql!`SELECT
        COUNT(*)::int AS installs,
        COUNT(*) FILTER (WHERE sg_exempt)::int AS sg_free,
        COUNT(*) FILTER (WHERE NOT sg_exempt)::int AS intl,
        COUNT(*) FILTER (WHERE platform = 'play')::int AS intl_play,
        COUNT(*) FILTER (WHERE paid_until > now())::int AS subscribers,
        COUNT(*) FILTER (WHERE pass_days_banked > 0)::int AS passes_waiting,
        COUNT(*) FILTER (WHERE paid_until IS NOT NULL)::int AS ever_paid,
        COUNT(*) FILTER (WHERE first_country IS NULL)::int AS unresolved
      FROM app_installs WHERE NOT owner`;
    const byCountry = await sql!`SELECT COALESCE(first_country, '') AS country, COUNT(*)::int AS installs,
        COUNT(*) FILTER (WHERE last_seen_at > now() - interval '30 days')::int AS active_30d,
        COUNT(*) FILTER (WHERE paid_until > now())::int AS paid
      FROM app_installs WHERE NOT owner GROUP BY 1 ORDER BY installs DESC LIMIT 50`;
    const ev = await sql!`SELECT country, event, SUM(n)::int AS n FROM usage_daily WHERE event IN ${sql!(MONEY_EVENTS)} GROUP BY country, event`;
    const abInst = await sql!`SELECT COALESCE(ab_cohort, '') AS cohort, COUNT(*)::int AS installs, COUNT(*) FILTER (WHERE paid_until IS NOT NULL OR pass_days_banked > 0)::int AS buyers
      FROM app_installs WHERE NOT owner AND platform <> 'play' AND first_slug = '' GROUP BY 1`;
    const abEv = await sql!`SELECT cohort, event, SUM(n)::bigint AS n FROM ab_daily GROUP BY cohort, event`;
    const ab = { on: AB_ON, cohorts: {} as any };
    for (const c of ["A", "B"]) ab.cohorts[c] = { passes: AB_ON || c === "A" ? await passOffers(c) : [], installs: 0, buyers: 0, events: {} as any };
    for (const r of abInst) if (ab.cohorts[r.cohort]) { ab.cohorts[r.cohort].installs = r.installs; ab.cohorts[r.cohort].buyers = r.buyers; }
    for (const r of abEv) if (ab.cohorts[r.cohort]) ab.cohorts[r.cohort].events[r.event] = Number(r.n);
    return ajson({ totals: t[0], byCountry, events: ev, eventNames: MONEY_EVENTS, enforced: PAYWALL_ENABLED, ownerTest: PAYWALL_OWNER_TEST, billing: stripeConfigured(), stripeTax: STRIPE_TAX, passes: await passOffers("A"), passDays: Object.keys(PASS_PRICES).map(Number), policy: TRIAL_POLICY, ab });
  }
  if (path === "/api/admin/data" && req.method === "GET") {
    const from = url.searchParams.get("from") || "", to = url.searchParams.get("to") || "";
    if (!isDay(from) || !isDay(to)) return ajson({ error: "Bad dates" }, 400);
    await loadPartners(true);
    // Summed over country (GROUP BY, not a plain SELECT) so this keeps its pre-existing
    // shape: exactly one row per (day, slug, event), same as before country existed.
    // admin.html's summary table already sums rows by slug+event so that part would've
    // tolerated one-row-per-country fine, but its daily trend chart (the bars) keys
    // straight off row.day -> row.n with no summing -- it would silently show just one
    // country's count per day instead of the true total if rows split by country here.
    const rows = await sql!`SELECT to_char(day, 'YYYY-MM-DD') AS day, slug, event, SUM(n)::int AS n FROM usage_daily WHERE day BETWEEN ${from}::date AND ${to}::date GROUP BY day, slug, event ORDER BY day, slug, event`;
    // Additive -- byCountry is its own breakdown, summed across partners/slugs: a
    // day-level "day, slug, event" split by country isn't needed yet, just the overall
    // country mix for the date range.
    const byCountry = await sql!`SELECT country, event, SUM(n)::int AS n FROM usage_daily WHERE day BETWEEN ${from}::date AND ${to}::date GROUP BY country, event ORDER BY country, event`;
    const partners = [...PARTNERS.values()].sort((a, b) => a.slug.localeCompare(b.slug));
    return ajson({ partners, rows, byCountry, events: [...EVENTS, "sponsored_live", "sponsor_granted"] });
  }
  if (path === "/api/admin/reset" && req.method === "POST") {
    // Copy every count into usage_archive (with the reset time), then clear the live counts.
    const res = await sql!.begin(async (tx: any) => {
      await tx`CREATE TABLE IF NOT EXISTS usage_archive (reset_at timestamptz NOT NULL, day date NOT NULL, slug text NOT NULL, event text NOT NULL, n integer NOT NULL)`;
      // usage_archive predates the country column -- add it here too (existing archived
      // rows default to '', same as usage_daily) so a reset doesn't drop the dimension.
      await tx`ALTER TABLE usage_archive ADD COLUMN IF NOT EXISTS country text NOT NULL DEFAULT ''`;
      const moved = await tx`INSERT INTO usage_archive (reset_at, day, slug, event, country, n) SELECT now(), day, slug, event, country, n FROM usage_daily RETURNING n`;
      await tx`DELETE FROM usage_daily`;
      return moved.length;
    });
    return ajson({ ok: true, archivedRows: res });
  }
  if (path === "/api/admin/partner" && req.method === "POST") {
    let b: any = {}; try { b = await req.json(); } catch {}
    const slug = String(b.slug || "").toLowerCase().trim(), name = cleanName(b.name), wa = String(b.wa || "").replace(/\D/g, "");
    const tel = String(b.tel || "").replace(/[^\d+ ()-]/g, "").replace(/\s+/g, " ").trim().slice(0, 24);
    const telDigits = tel.replace(/\D/g, "");
    const active = b.active !== false, create = !!b.create;
    const sponsorDays = [0, -1, 3, 7, 14, 30, 90, 365].includes(Number(b.sponsorDays)) ? Number(b.sponsorDays) : 0;
    const sponsorUntil = /^\d{4}-\d{2}-\d{2}$/.test(String(b.sponsorUntil || "")) ? String(b.sponsorUntil) : null;
    if (!SLUG_RE.test(slug) || RESERVED.has(slug)) return ajson({ error: "Link name must be 2–30 lowercase letters, numbers or dashes, and not a reserved word." }, 400);
    if (!name) return ajson({ error: "Enter the name users will see." }, 400);
    if (wa && (wa.length < 8 || wa.length > 15)) return ajson({ error: "Enter the WhatsApp number with country code (e.g. 6561234567), or leave it blank." }, 400);
    if (tel && (telDigits.length < 3 || telDigits.length > 15 || /\+/.test(tel.slice(1)))) return ajson({ error: "Enter the assistance phone number with country code (e.g. +65 3158 2536), or leave it blank." }, 400);
    if (create) {
      const r = await sql!`INSERT INTO partners (slug, name, wa, tel, active, sponsor_days, sponsor_until) VALUES (${slug}, ${name}, ${wa}, ${tel}, ${active}, ${sponsorDays}, ${sponsorUntil}::date) ON CONFLICT (slug) DO NOTHING RETURNING slug`;
      if (!r.length) return ajson({ error: "That link name is already taken." }, 409);
    } else {
      const r = await sql!`UPDATE partners SET name = ${name}, wa = ${wa}, tel = ${tel}, active = ${active}, sponsor_days = ${sponsorDays}, sponsor_until = ${sponsorUntil}::date WHERE slug = ${slug} RETURNING slug`;
      if (!r.length) return ajson({ error: "Partner not found." }, 404);
    }
    await loadPartners(true);
    return ajson({ ok: true });
  }
  return ajson({ error: "Not found" }, 404);
}

Bun.serve({
  port: Number(Bun.env.PORT ?? 3000),
  async fetch(req) {
    const url = new URL(req.url);
    const path = url.pathname;
    // Send www.<domain> to the bare domain so everyone uses one address.
    const host = (req.headers.get("host") || "").toLowerCase();
    if (host.startsWith("www.")) return Response.redirect(`https://${host.slice(4)}${path}${url.search}`, 301);
    if (path.startsWith("/api/track/")) {
      try { return await trackApi(req, url); }
      catch (e) { console.error(e); return json({ error: "Live tracking is temporarily unavailable" }, 503); }
    }
    if (path === "/api/ev" && req.method === "POST") {
      try { return await usageEvent(req); } catch (e) { console.error(e); return new Response(null, { status: 204 }); }
    }
    if (path === "/api/stripe/webhook" && req.method === "POST") {
      try { return await stripeWebhook(req); } catch (e) { console.error(e); return json({ error: "Server error" }, 500); }
    }
    if (path === "/api/entitlement" || path === "/api/passes" || path.startsWith("/api/install/") || path.startsWith("/api/billing/")) {
      try { return await installApi(req, path); } catch (e) { console.error(e); return json({ error: "Server error" }, 500); }
    }
    if (path.startsWith("/api/admin/")) {
      try { return await adminApi(req, url); } catch (e) { console.error(e); return ajson({ error: "Server error" }, 500); }
    }
    if (path === "/admin" || path === "/admin/") return new Response(ADMIN_HTML, { headers: { ...noStore, "Content-Type": "text/html; charset=utf-8", "Content-Security-Policy": "default-src 'self'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'" } });
    if (path.startsWith("/api/partner/")) {
      await loadPartners();
      const p = activePartner(path.slice(13));
      return p ? json({ slug: p.slug, name: p.name, wa: p.wa, tel: p.tel }) : json({ error: "Not found" }, 404);
    }
    if (path.startsWith("/t/")) return new Response(VIEWER, { headers: { ...common, "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-cache", "X-Robots-Tag": "noindex" } });
    if (path === "/api/embassies") {
      try {
        await loadEmb();
        const from = url.searchParams.get("from") || "";
        return Response.json(EMB![from] || [], { headers: { ...common, "Cache-Control": "public, max-age=86400" } });
      } catch (e) {
        return Response.json({ error: "Embassy data is temporarily unavailable" }, { status: 503, headers: common });
      }
    }
    if (path === "/icon.svg") return new Response(ICON, { headers: { ...common, "Content-Type": "image/svg+xml", "Cache-Control": "public, max-age=86400" } });
    if (path === "/manifest.webmanifest") { await loadPartners(); return new Response(manifestFor(activePartner(url.searchParams.get("p") || "")), { headers: { ...common, "Content-Type": "application/manifest+json" } }); }
    if (path === "/health") return new Response("ok");
    if (path === "/.well-known/assetlinks.json") return new Response(ASSETLINKS, { headers: { ...common, "Content-Type": "application/json", "Cache-Control": "public, max-age=3600" } });
    if (path === "/sw.js") return new Response(SW, { headers: { ...common, "Content-Type": "text/javascript; charset=utf-8", "Cache-Control": "no-cache" } });
    if (path === "/delete-data") return new Response(DELETE_DATA, { headers: { ...common, "Content-Type": "text/html; charset=utf-8", "Cache-Control": "public, max-age=3600" } });
    if (path === "/security") return new Response(SECURITY, { headers: { ...common, "Content-Type": "text/html; charset=utf-8", "Cache-Control": "public, max-age=3600" } });
    if (path === "/privacy") return new Response(PRIVACY, { headers: { ...common, "Content-Type": "text/html; charset=utf-8", "Cache-Control": "public, max-age=3600" } });
    if (/^\/icons\/[a-z0-9-]+\.png$/.test(path) || path === "/apple-touch-icon.png") {
      const f = Bun.file(new URL("." + (path === "/apple-touch-icon.png" ? "/icons/apple-touch-icon.png" : path), PUBLIC_DIR));
      if (await f.exists()) return new Response(f, { headers: { ...common, "Content-Type": "image/png", "Cache-Control": "public, max-age=604800" } });
    }
    if (path === "/robots.txt") return new Response("User-agent: *\nDisallow: /t/\nDisallow: /api/\nDisallow: /admin\n", { headers: { "Content-Type": "text/plain" } });
    const pm = path.match(/^\/([A-Za-z0-9-]{2,30})\/?$/);
    if (pm) {
      await loadPartners();
      const p = activePartner(pm[1].toLowerCase());
      if (p) {
        if (path !== "/" + p.slug) return new Response(null, { status: 301, headers: { Location: `/${p.slug}${url.search}` } });
        return htmlResponse(req, { ...common, "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-cache" }, p);
      }
    }
    return htmlResponse(req, { ...common, "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-cache" });
  },
});
console.log("ScamGuard SOS listening");
