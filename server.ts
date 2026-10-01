// ScamGuard SOS: serves the app, the live-tracking API and the live map page.
// The app page lives in public/index.html.
import { SQL } from "bun";
// Insurer white-label: set CLAIMS_WHATSAPP (number with country code) and CLAIMS_NAME as Railway variables.
const CLAIMS_WA = (Bun.env.CLAIMS_WHATSAPP || "").replace(/\D/g, "") || "6588877041";
const CLAIMS_NAME = (Bun.env.CLAIMS_NAME || "Insurance assistance").replace(/[<>&"\\`$]/g, "").slice(0, 60);
const HTML = (await Bun.file(new URL("./public/index.html", import.meta.url)).text()).replaceAll("__CLAIMS_WA__", CLAIMS_WA).replaceAll("__CLAIMS_NAME__", CLAIMS_NAME);
const ICON = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512"><rect width="512" height="512" rx="112" fill="#13212E"/><circle cx="256" cy="256" r="170" fill="#D7302A"/><text x="256" y="300" font-family="Arial Narrow,Arial,sans-serif" font-weight="800" font-size="130" fill="#fff" text-anchor="middle">SOS</text></svg>`;
const MANIFEST = JSON.stringify({
  name: "ScamGuard SOS", short_name: "ScamGuard", start_url: "/", display: "standalone",
  background_color: "#13212E", theme_color: "#13212E",
  icons: [{ src: "/icon.svg", sizes: "any", type: "image/svg+xml", purpose: "any maskable" }],
});
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
<header><div class="top"><div class="brand">Scam<span>Guard</span> SOS</div><div class="pill" id="pill">Loading…</div></div>
<h1 id="title">Live location</h1><div class="meta" id="meta">Connecting…</div></header>
<div id="map"></div>
<footer><a id="gmaps" href="#" target="_blank" rel="noopener">Open in Google Maps</a><a class="alt" href="tel:" id="callHint" hidden>Call</a></footer>
<script src="https://cdnjs.cloudflare.com/ajax/libs/leaflet/1.9.4/leaflet.min.js"></script>
<script>
(function(){
var id=location.pathname.split("/").pop(), map, dot, ring, trail, fitted=false, hasMap=typeof L!=="undefined";
function ago(ms){var s=Math.round(ms/1000);if(s<60)return s+" s ago";var m=Math.round(s/60);if(m<60)return m+" min ago";return Math.round(m/60)+" h ago";}
function el(i){return document.getElementById(i);}
function initMap(){map=L.map("map",{zoomControl:true});L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png",{maxZoom:19,attribution:"&copy; OpenStreetMap contributors"}).addTo(map);map.setView([1.35,103.82],11);}
async function load(){
  try{
    var r=await fetch("/api/track/"+id,{cache:"no-store"});
    if(r.status===404){el("pill").textContent="Not found";el("meta").textContent="This tracking link doesn't exist or has been removed.";return;}
    var d=await r.json(), pts=d.points||[], now=new Date(d.now).getTime();
    el("title").textContent=(d.name?d.name+"'s":"Live")+" location";
    var last=pts[pts.length-1], pill=el("pill");
    if(d.ended){pill.className="pill done";pill.textContent="Marked safe";}
    else if(d.expired){pill.className="pill";pill.textContent="Link expired";}
    else if(last && now-last[0]<120000){pill.className="pill live";pill.textContent="● Live";}
    else{pill.className="pill stale";pill.textContent="Waiting for update";}
    if(!last){el("meta").textContent=d.ended?"Tracking ended before any location was shared.":"No location received yet. The phone sends its position while the ScamGuard app is open.";return;}
    var ll=[last[1],last[2]];
    el("meta").textContent="Updated "+ago(now-last[0])+" · ±"+Math.round(last[3]||0)+" m"+(last[4]!=null?" · battery "+Math.round(last[4]*100)+"%":"")+(d.ended?" · stopped sharing "+ago(now-new Date(d.ended).getTime()):"");
    el("gmaps").href="https://maps.google.com/?q="+last[1]+","+last[2];
    var line=pts.map(function(p){return[p[1],p[2]];});
    if(!hasMap){}
    else if(!dot){dot=L.circleMarker(ll,{radius:9,color:"#fff",weight:3,fillColor:"#D7302A",fillOpacity:1}).addTo(map);ring=L.circle(ll,{radius:last[3]||0,color:"#D7302A",weight:1,fillOpacity:.12}).addTo(map);trail=L.polyline(line,{color:"#D7302A",weight:4,opacity:.6}).addTo(map);}
    else{dot.setLatLng(ll);ring.setLatLng(ll).setRadius(last[3]||0);trail.setLatLngs(line);}
    if(hasMap&&!fitted){map.setView(ll,16);fitted=true;}
  }catch(e){el("meta").textContent="Couldn't reach the server. Retrying…";}
}
if(hasMap)initMap();else el("map").innerHTML='<div class="msg">The map could not load. Use Open in Google Maps below to see the latest location.</div>';
load();setInterval(load,10000);
document.addEventListener("visibilitychange",function(){if(!document.hidden)load();});
})();
</script></body></html>`;

Bun.serve({
  port: Number(Bun.env.PORT ?? 3000),
  async fetch(req) {
    const url = new URL(req.url);
    const path = url.pathname;
    if (path.startsWith("/api/track/")) {
      try { return await trackApi(req, url); }
      catch (e) { console.error(e); return json({ error: "Live tracking is temporarily unavailable" }, 503); }
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
    if (path === "/manifest.webmanifest") return new Response(MANIFEST, { headers: { ...common, "Content-Type": "application/manifest+json" } });
    if (path === "/health") return new Response("ok");
    return new Response(HTML, { headers: { ...common, "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-cache" } });
  },
});
console.log("ScamGuard SOS listening");
