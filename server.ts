// ScamGuard SOS: serves the app, the live-tracking API and the live map page.
// The app page lives in public/index.html.
import { SQL } from "bun";
// Partners (insurers, agencies) are stored in Postgres and managed at /admin.
// Each one gets its own link, e.g. scamguardsos.com/fwd, which loads its name and WhatsApp number.
// Translations: i18n/<lang>.json. The app gets "t", "x" and "kw"; the live-map viewer gets "v".
const LANGS = ["en", "zh", "ms", "id", "th", "my", "ko", "ja"];
const I18N: Record<string, any> = {};
for (const l of LANGS) {
  try { I18N[l] = await Bun.file(new URL(`./i18n/${l}.json`, import.meta.url)).json(); }
  catch (e) { if (l === "en") throw e; console.error(`i18n: skipping ${l}`, e); }
}
const jsonForScript = (o: any) => JSON.stringify(o).replace(/</g, "\\u003c").replace(/\u2028/g, "\\u2028").replace(/\u2029/g, "\\u2029");
const APP_I18N = jsonForScript(Object.fromEntries(Object.entries(I18N).map(([l, d]) => [l, { name: d.name, t: d.t, x: d.x, kw: d.kw }])));
const VIEW_I18N = jsonForScript(Object.fromEntries(Object.entries(I18N).map(([l, d]) => [l, d.v])));
const HTML_T = (await Bun.file(new URL("./public/index.html", import.meta.url)).text())
  .replace("__I18N_DATA__", () => APP_I18N);
type Partner = { slug: string; name: string; wa: string; tel: string; active: boolean };
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
    await sql`CREATE TABLE IF NOT EXISTS usage_daily (day date NOT NULL, slug text NOT NULL, event text NOT NULL, n integer NOT NULL DEFAULT 0, PRIMARY KEY (day, slug, event))`;
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
    const ip = req.headers.get("x-forwarded-for")?.split(",")[0].trim() || "local";
    if (!allowStart(ip)) return json({ error: "Too many tracking links started. Try again later." }, 429);
    const body: any = await readBody(req);
    const id = randomId(16), key = randomId(24);
    const name = String(body.name || "").slice(0, 40);
    await sql!`INSERT INTO track_sessions (id, key_hash, name, expires_at) VALUES (${id}, ${hashKey(key)}, ${name}, now() + interval '24 hours')`;
    sql!`DELETE FROM track_sessions WHERE expires_at < now() - interval '7 days'`.catch(() => {});
    const base = PUBLIC_URL || url.origin;
    return json({ id, key, url: `${base}/t/${id}`, expiresIn: 86400 });
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
    return json({ ok: true });
  }
  if (req.method === "POST" && parts[3] === "end") {
    const b: any = await readBody(req);
    const s = await checkKey(id, b.key);
    if (!s) return json({ error: "Not allowed" }, 403);
    await sql!`UPDATE track_sessions SET ended_at = COALESCE(ended_at, now()) WHERE id = ${id}`;
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
    const rows = await sql!`SELECT slug, name, wa, tel, active FROM partners`;
    PARTNERS = new Map(rows.map((r: any) => [r.slug, { slug: r.slug, name: r.name, wa: r.wa, tel: r.tel || "", active: r.active }]));
    partnersAt = Date.now(); pageCache.clear();
  })().catch(e => { console.error("partners", e); }).finally(() => { partnersLoading = null; });
  return partnersLoading;
}
loadPartners(true);
const RESERVED = new Set(["admin", "api", "t", "privacy", "security", "delete-data", "health", "icons", "sw", "robots", "manifest", "icon", "apple-touch-icon", "well-known", "www", "public", "app", "sos", "help", "login", "logout", "static", "assets"]);
const SLUG_RE = /^[a-z0-9](?:[a-z0-9-]{0,28}[a-z0-9])$/;
function activePartner(slug: string) { const p = PARTNERS.get(slug); return p && p.active ? p : null; }

// ---------- Anonymous usage counts (totals per day, no personal data) ----------
const EVENTS = new Set(["open", "new", "install", "sos", "claim", "check"]);
const hits = new Map<string, number[]>();
function allow(bucket: string, ip: string, max: number, windowMs: number) {
  const k = bucket + ":" + ip, now = Date.now(), list = (hits.get(k) || []).filter(t => now - t < windowMs);
  if (list.length >= max) { hits.set(k, list); return false; }
  list.push(now); hits.set(k, list); return true;
}
setInterval(() => { const now = Date.now(); for (const [k, v] of hits) if (!v.length || now - v[v.length - 1] > 3600e3) hits.delete(k); }, 600e3);
const clientIp = (req: Request) => req.headers.get("x-forwarded-for")?.split(",")[0].trim() || "local";
async function usageEvent(req: Request) {
  if (!allow("ev", clientIp(req), 300, 3600e3)) return new Response(null, { status: 204 });
  let b: any = {}; try { b = JSON.parse(await req.text()); } catch {}
  const e = String(b.e || ""), slug = String(b.p || "");
  if (!EVENTS.has(e) || (slug && !activePartner(slug))) return new Response(null, { status: 204 });
  await initDb();
  await sql!`INSERT INTO usage_daily (day, slug, event, n) VALUES ((now() AT TIME ZONE 'Asia/Singapore')::date, ${slug}, ${e}, 1)
             ON CONFLICT (day, slug, event) DO UPDATE SET n = usage_daily.n + 1`;
  return new Response(null, { status: 204 });
}

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
  if (path === "/api/admin/data" && req.method === "GET") {
    const from = url.searchParams.get("from") || "", to = url.searchParams.get("to") || "";
    if (!isDay(from) || !isDay(to)) return ajson({ error: "Bad dates" }, 400);
    await loadPartners(true);
    const rows = await sql!`SELECT to_char(day, 'YYYY-MM-DD') AS day, slug, event, n FROM usage_daily WHERE day BETWEEN ${from}::date AND ${to}::date ORDER BY day, slug, event`;
    const partners = [...PARTNERS.values()].sort((a, b) => a.slug.localeCompare(b.slug));
    return ajson({ partners, rows, events: [...EVENTS] });
  }
  if (path === "/api/admin/reset" && req.method === "POST") {
    // Copy every count into usage_archive (with the reset time), then clear the live counts.
    const res = await sql!.begin(async (tx: any) => {
      await tx`CREATE TABLE IF NOT EXISTS usage_archive (reset_at timestamptz NOT NULL, day date NOT NULL, slug text NOT NULL, event text NOT NULL, n integer NOT NULL)`;
      const moved = await tx`INSERT INTO usage_archive (reset_at, day, slug, event, n) SELECT now(), day, slug, event, n FROM usage_daily RETURNING n`;
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
    if (!SLUG_RE.test(slug) || RESERVED.has(slug)) return ajson({ error: "Link name must be 2–30 lowercase letters, numbers or dashes, and not a reserved word." }, 400);
    if (!name) return ajson({ error: "Enter the name users will see." }, 400);
    if (wa && (wa.length < 8 || wa.length > 15)) return ajson({ error: "Enter the WhatsApp number with country code (e.g. 6561234567), or leave it blank." }, 400);
    if (tel && (telDigits.length < 3 || telDigits.length > 15 || /\+/.test(tel.slice(1)))) return ajson({ error: "Enter the assistance phone number with country code (e.g. +65 3158 2536), or leave it blank." }, 400);
    if (create) {
      const r = await sql!`INSERT INTO partners (slug, name, wa, tel, active) VALUES (${slug}, ${name}, ${wa}, ${tel}, ${active}) ON CONFLICT (slug) DO NOTHING RETURNING slug`;
      if (!r.length) return ajson({ error: "That link name is already taken." }, 409);
    } else {
      const r = await sql!`UPDATE partners SET name = ${name}, wa = ${wa}, tel = ${tel}, active = ${active} WHERE slug = ${slug} RETURNING slug`;
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
