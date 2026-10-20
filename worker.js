// Daily Tracker reminder service (Cloudflare Worker).
// Needs: a KV namespace bound as SUBS, and a cron trigger "*/5 * * * *".
// It stores which reminders you want and when, plus a small "what's done today" status
// from the app, and sends a notification only when something is still missing.

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
};
const MAX_SUBS = 20;
const WINDOW_MIN = 10; // send within 10 minutes after the chosen time

function json(data, status = 200) {
  return new Response(JSON.stringify(data), { status, headers: { "Content-Type": "application/json", ...CORS } });
}
function b64u(buf) {
  const bytes = buf instanceof Uint8Array ? buf : new Uint8Array(buf);
  let s = "";
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
function b64uText(str) { return b64u(new TextEncoder().encode(str)); }

async function getVapid(env) {
  const saved = await env.SUBS.get("vapid", "json");
  if (saved) return saved;
  const kp = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign", "verify"]);
  const pub = b64u(await crypto.subtle.exportKey("raw", kp.publicKey));
  const priv = await crypto.subtle.exportKey("jwk", kp.privateKey);
  const v = { pub, priv };
  await env.SUBS.put("vapid", JSON.stringify(v));
  return v;
}

async function vapidHeader(endpoint, vapid) {
  const aud = new URL(endpoint).origin;
  const header = b64uText(JSON.stringify({ typ: "JWT", alg: "ES256" }));
  const claims = b64uText(JSON.stringify({ aud, exp: Math.floor(Date.now() / 1000) + 12 * 3600, sub: "mailto:tracker@example.com" }));
  const key = await crypto.subtle.importKey("jwk", vapid.priv, { name: "ECDSA", namedCurve: "P-256" }, false, ["sign"]);
  const sig = await crypto.subtle.sign({ name: "ECDSA", hash: "SHA-256" }, key, new TextEncoder().encode(header + "." + claims));
  return "vapid t=" + header + "." + claims + "." + b64u(sig) + ", k=" + vapid.pub;
}

function localParts(tz, now) {
  let parts;
  try {
    parts = new Intl.DateTimeFormat("en-US", { timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", weekday: "short", hour12: false }).formatToParts(now);
  } catch (e) {
    parts = new Intl.DateTimeFormat("en-US", { timeZone: "UTC", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", weekday: "short", hour12: false }).formatToParts(now);
  }
  const p = {};
  for (const x of parts) p[x.type] = x.value;
  const hour = parseInt(p.hour, 10) % 24;
  return { date: p.year + "-" + p.month + "-" + p.day, minutes: hour * 60 + parseInt(p.minute, 10), weekday: p.weekday };
}

// Decide whether a reminder of this type should fire, given today's status from the app.
function needsReminder(type, status, local) {
  const s = status && status.date === local.date ? status : { anything: false, remaining: 99, trades: false, water: false, noTrade: false };
  const weekday = ["Mon", "Tue", "Wed", "Thu", "Fri"].includes(local.weekday);
  if (type === "checkin") return !s.anything;
  if (type === "finish") return s.remaining > 0;
  if (type === "trades") return weekday && !s.noTrade && !s.trades;
  if (type === "water") return !s.water;
  return false;
}

async function loadSubs(env) { return (await env.SUBS.get("subs", "json")) || []; }
async function saveSubs(env, subs) { await env.SUBS.put("subs", JSON.stringify(subs)); }

async function sendPush(sub, vapid) {
  const res = await fetch(sub.subscription.endpoint, {
    method: "POST",
    headers: { Authorization: await vapidHeader(sub.subscription.endpoint, vapid), TTL: "3600", Urgency: "normal", "Content-Length": "0" },
  });
  return res.status;
}

async function runSchedule(env, now = new Date()) {
  const subs = await loadSubs(env);
  if (!subs.length) return { sent: 0 };
  const vapid = await getVapid(env);
  let sent = 0, changed = false;
  const keep = [];
  for (const sub of subs) {
    const local = localParts(sub.tz || "UTC", now);
    let gone = false;
    sub.sent = sub.sent || {};
    for (const r of sub.reminders || []) {
      const [h, m] = String(r.time || "").split(":").map(Number);
      if (isNaN(h) || isNaN(m)) continue;
      const t = h * 60 + m, diff = local.minutes - t;
      const key = r.id || r.type + "@" + r.time;
      if (diff < 0 || diff >= WINDOW_MIN || sub.sent[key] === local.date) continue;
      if (!needsReminder(r.type, sub.status, local)) { sub.sent[key] = local.date; changed = true; continue; }
      sub.pending = { type: r.type, date: local.date };
      const code = await sendPush(sub, vapid);
      sub.sent[key] = local.date;
      changed = true;
      if (code === 404 || code === 410) { gone = true; break; }
      if (code >= 200 && code < 300) sent++;
    }
    if (!gone) keep.push(sub);
    else changed = true;
  }
  if (changed) await saveSubs(env, keep);
  return { sent };
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: CORS });
    if (!env.SUBS) return json({ error: "The SUBS storage is not connected yet. Add the KV binding named SUBS." }, 500);

    if (url.pathname === "/" || url.pathname === "/health") return json({ ok: true, service: "tracker reminders" });

    if (url.pathname === "/vapid" && request.method === "GET") {
      const v = await getVapid(env);
      return json({ publicKey: v.pub });
    }

    if (url.pathname === "/pending" && request.method === "GET") {
      const id = url.searchParams.get("id");
      const subs = await loadSubs(env);
      const s = subs.find((x) => x.id === id);
      return json({ type: s && s.pending ? s.pending.type : "checkin" });
    }

    if (request.method !== "POST") return json({ error: "Not found" }, 404);
    let body;
    try { body = await request.json(); } catch (e) { return json({ error: "Bad request" }, 400); }
    if (!body || typeof body.id !== "string" || body.id.length > 100) return json({ error: "Missing id" }, 400);
    const subs = await loadSubs(env);
    let sub = subs.find((x) => x.id === body.id);

    if (url.pathname === "/subscribe") {
      if (!body.subscription || !body.subscription.endpoint) return json({ error: "Missing subscription" }, 400);
      const reminders = (Array.isArray(body.reminders) ? body.reminders : []).slice(0, 12).map((r) => ({
        id: String(r.id || "").slice(0, 40), type: String(r.type || "checkin").slice(0, 20), time: String(r.time || "20:00").slice(0, 5),
      }));
      if (!sub) {
        if (subs.length >= MAX_SUBS) return json({ error: "Too many devices" }, 429);
        sub = { id: body.id, sent: {} };
        subs.push(sub);
      }
      sub.subscription = body.subscription;
      sub.tz = String(body.tz || "UTC").slice(0, 60);
      sub.reminders = reminders;
      if (body.status) sub.status = body.status;
      await saveSubs(env, subs);
      return json({ ok: true });
    }

    if (url.pathname === "/status") {
      if (!sub) return json({ error: "Not subscribed" }, 404);
      const s = body.status || {};
      sub.status = { date: String(s.date || ""), anything: !!s.anything, remaining: Number(s.remaining) || 0, trades: !!s.trades, water: !!s.water, noTrade: !!s.noTrade };
      await saveSubs(env, subs);
      return json({ ok: true });
    }

    if (url.pathname === "/unsubscribe") {
      await saveSubs(env, subs.filter((x) => x.id !== body.id));
      return json({ ok: true });
    }

    if (url.pathname === "/test") {
      if (!sub) return json({ error: "Not subscribed" }, 404);
      sub.pending = { type: "test", date: "" };
      await saveSubs(env, subs);
      const code = await sendPush(sub, await getVapid(env));
      return json({ ok: code >= 200 && code < 300, status: code });
    }

    return json({ error: "Not found" }, 404);
  },

  async scheduled(event, env, ctx) {
    ctx.waitUntil(runSchedule(env));
  },
};
