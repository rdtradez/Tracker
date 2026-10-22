// Daily Tracker reminder service (Cloudflare Worker).
// Needs: a KV namespace bound as SUBS, and a cron trigger "*/5 * * * *".
// It stores which reminders you want and when, plus a small "what's done today" status
// from the app, and sends a notification only when something is still missing.

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "X-Content-Type-Options": "nosniff",
  "Cache-Control": "no-store",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
};
const MAX_SUBS = 20;
const MAX_BODY = 16 * 1024;
// Only real browser push services may be used as notification endpoints.
const PUSH_HOSTS = [/^fcm\.googleapis\.com$/, /^android\.googleapis\.com$/, /^updates\.push\.services\.mozilla\.com$/, /^([a-z0-9-]+\.)*push\.apple\.com$/, /^([a-z0-9-]+\.)*notify\.windows\.com$/];
function validEndpoint(e) {
  try { const u = new URL(String(e)); return u.protocol === "https:" && PUSH_HOSTS.some((r) => r.test(u.hostname)); } catch (x) { return false; }
}
function validId(id) { return typeof id === "string" && /^[A-Za-z0-9_-]{12,100}$/.test(id); }
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
  const s = status && status.date === local.date ? status : { anything: false, remaining: 99, trades: false, water: false, noTrade: false, locked: false };
  const weekday = ["Mon", "Tue", "Wed", "Thu", "Fri"].includes(local.weekday);
  if (type === "checkin") return !s.anything;
  if (type === "finish") return s.remaining > 0;
  if (type === "trades") return weekday && !s.noTrade && !s.trades;
  if (type === "water") return !s.water;
  if (type === "lock") return weekday && !s.locked;
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

// ---------- Groups: share process scores with friends ----------
const CODE_CHARS = "ABCDEFGHJKMNPQRSTUVWXYZ23456789";
const MAX_MEMBERS = 10;
function randStr(n, chars) {
  const a = new Uint8Array(n); crypto.getRandomValues(a);
  let s = ""; for (const x of a) s += chars[x % chars.length]; return s;
}
function safeEqual(a, b) { a = String(a); b = String(b); if (a.length !== b.length) return false; let r = 0; for (let i = 0; i < a.length; i++) r |= a.charCodeAt(i) ^ b.charCodeAt(i); return r === 0; }
function cleanDevice(d) { d = String(d || ""); return validId(d) ? d : ""; }
function cleanNick(n) { return String(n || "").replace(/[\u0000-\u001f<>]/g, "").trim().slice(0, 24); }
function cleanStats(st) {
  st = st || {};
  const num = (v, lo, hi) => { const n = Number(v); return isFinite(n) ? Math.max(lo, Math.min(hi, Math.round(n))) : null; };
  const out = { date: String(st.date || "").slice(0, 10) };
  if ("level" in st) { out.level = num(st.level, 1, 999); out.title = String(st.title || "").slice(0, 30); }
  if ("streak" in st) out.streak = num(st.streak, 0, 9999);
  if ("today" in st) { out.today = num(st.today, 0, 50); out.of = num(st.of, 1, 50); }
  if ("weekPct" in st) out.weekPct = num(st.weekPct, 0, 100);
  if ("planPct" in st) out.planPct = st.planPct == null ? null : num(st.planPct, 0, 100);
  out.checkedIn = !!st.checkedIn;
  return out;
}
async function handleGroup(path, body, env) {
  const gkey = (c) => "g:" + c, mkey = (c, m) => "gm:" + c + ":" + m, nkey = (c, m) => "gn:" + c + ":" + m;
  const code = String(body.code || "").toUpperCase().replace(/[^A-Z0-9]/g, "").slice(0, 8);

  if (path === "/group/create") {
    const nick = cleanNick(body.nick); if (!nick) return json({ error: "Pick a nickname first." }, 400);
    let c = ""; for (let i = 0; i < 6; i++) { c = randStr(6, CODE_CHARS); if (!(await env.SUBS.get(gkey(c)))) break; }
    const memberId = randStr(12, CODE_CHARS.toLowerCase() + "0123456789"), token = randStr(32, CODE_CHARS + "abcdefghjkmnpqrstuvwxyz");
    const g = { name: cleanNick(body.name) || nick + "’s group", created: Date.now(), members: {} };
    g.members[memberId] = { nick, token, deviceId: cleanDevice(body.deviceId), joined: Date.now() };
    await env.SUBS.put(gkey(c), JSON.stringify(g));
    if (body.stats) await env.SUBS.put(mkey(c, memberId), JSON.stringify({ stats: cleanStats(body.stats), updated: Date.now() }));
    return json({ ok: true, code: c, memberId, token, name: g.name });
  }

  if (!code) return json({ error: "Enter the group code." }, 400);
  const g = await env.SUBS.get(gkey(code), "json");
  if (!g) return json({ error: "No group found with that code. Check it and try again." }, 404);

  if (path === "/group/join") {
    const nick = cleanNick(body.nick); if (!nick) return json({ error: "Pick a nickname first." }, 400);
    if (Object.keys(g.members).length >= MAX_MEMBERS) return json({ error: "That group is full (10 people max)." }, 409);
    const taken = Object.values(g.members).some((m) => m.nick.toLowerCase() === nick.toLowerCase());
    if (taken) return json({ error: "Someone in that group already uses that nickname. Pick another." }, 409);
    const memberId = randStr(12, CODE_CHARS.toLowerCase() + "0123456789"), token = randStr(32, CODE_CHARS + "abcdefghjkmnpqrstuvwxyz");
    g.members[memberId] = { nick, token, deviceId: cleanDevice(body.deviceId), joined: Date.now() };
    await env.SUBS.put(gkey(code), JSON.stringify(g));
    if (body.stats) await env.SUBS.put(mkey(code, memberId), JSON.stringify({ stats: cleanStats(body.stats), updated: Date.now() }));
    return json({ ok: true, code, memberId, token, name: g.name });
  }

  const me = typeof body.memberId === "string" && Object.prototype.hasOwnProperty.call(g.members, body.memberId) ? g.members[body.memberId] : null;
  if (!me || typeof body.token !== "string" || !safeEqual(me.token, body.token)) return json({ error: "You are not in this group anymore." }, 403);

  if (path === "/group/update") {
    if (cleanDevice(body.deviceId) && body.deviceId !== me.deviceId) { me.deviceId = cleanDevice(body.deviceId); await env.SUBS.put(gkey(code), JSON.stringify(g)); }
    await env.SUBS.put(mkey(code, body.memberId), JSON.stringify({ stats: cleanStats(body.stats), updated: Date.now() }));
    return json({ ok: true });
  }

  if (path === "/group/view") {
    const ids = Object.keys(g.members);
    const rows = await Promise.all(ids.map(async (id) => {
      const m = (await env.SUBS.get(mkey(code, id), "json")) || {};
      return { id, nick: g.members[id].nick, me: id === body.memberId, stats: m.stats || null, updated: m.updated || null };
    }));
    const nudges = ((await env.SUBS.get(nkey(code, body.memberId), "json")) || []).filter((n) => Date.now() - n.at < 3 * 864e5);
    return json({ ok: true, name: g.name, code, members: rows, nudges });
  }

  if (path === "/group/nudge") {
    const to = typeof body.to === "string" && Object.prototype.hasOwnProperty.call(g.members, body.to) ? g.members[body.to] : null;
    if (!to || body.to === body.memberId) return json({ error: "That person is not in this group." }, 404);
    const day = new Date().toISOString().slice(0, 10);
    let list = ((await env.SUBS.get(nkey(code, body.to), "json")) || []).filter((n) => Date.now() - n.at < 3 * 864e5);
    if (list.some((n) => n.fromId === body.memberId && n.day === day)) return json({ ok: true, already: true });
    list.push({ from: me.nick, fromId: body.memberId, at: Date.now(), day });
    list = list.slice(-5);
    await env.SUBS.put(nkey(code, body.to), JSON.stringify(list));
    let pushed = false;
    if (to.deviceId) {
      const subs = await loadSubs(env); const sub = subs.find((x) => x.id === to.deviceId);
      if (sub) { sub.pending = { type: "nudge", from: me.nick, date: day }; await saveSubs(env, subs); const st = await sendPush(sub, await getVapid(env)); pushed = st >= 200 && st < 300; }
    }
    return json({ ok: true, pushed });
  }

  if (path === "/group/rename") {
    const nick = cleanNick(body.nick); if (!nick) return json({ error: "Pick a username first." }, 400);
    const taken = Object.entries(g.members).some(([id, m]) => id !== body.memberId && m.nick.toLowerCase() === nick.toLowerCase());
    if (taken) return json({ error: "Someone in your group already uses that username. Pick another." }, 409);
    me.nick = nick; await env.SUBS.put(gkey(code), JSON.stringify(g));
    return json({ ok: true });
  }

  if (path === "/group/clearnudges") { await env.SUBS.delete(nkey(code, body.memberId)); return json({ ok: true }); }

  if (path === "/group/leave") {
    delete g.members[body.memberId];
    await env.SUBS.delete(mkey(code, body.memberId)); await env.SUBS.delete(nkey(code, body.memberId));
    if (Object.keys(g.members).length) await env.SUBS.put(gkey(code), JSON.stringify(g)); else await env.SUBS.delete(gkey(code));
    return json({ ok: true });
  }
  return json({ error: "Not found" }, 404);
}


// ---------- Smart insights ----------
// Needs a secret named ANTHROPIC_API_KEY (Settings > Variables and Secrets > Add > Secret).
// Optional variable AI_MODEL to change the model. Each device gets AI_PER_DAY runs a day, and the whole
// service AI_ALL_PER_DAY, so a leaked app link can't run up the bill.
const AI_MAX_BODY = 140 * 1024;
const AI_PER_DAY = 6;
const AI_ALL_PER_DAY = 150;
const AI_SYSTEM = "You are the coach inside Daily Edge, a habit and trading journal app for futures prop firm traders working toward payouts while building healthy habits. The first message holds the trader's logged data. " +
  "When asked for insights, write 4 to 6 insights they can act on. Each one should point to a specific pattern in the data with the numbers that show it (dates, dollar amounts, counts), say why it matters, and give one concrete action. Cover trading first (rule breaks, setups, times of day, sizing against drawdown room, account progress toward targets and payouts, locking after trading), then health and habits, and any link between the two (for example sleep, mood or skipped checks on losing days). End with one line that starts with \"Tomorrow:\" naming the single most important thing to do. " +
  "For follow-up questions, answer briefly from the data. " +
  "Be direct and honest, like a good trading coach; do not sugarcoat losses or broken rules, and do not invent data that is not there. If there is too little data for something, say what to log to find out. Do not give buy or sell calls on markets. Only discuss the trader's data, trading, habits and health; politely decline anything unrelated. " +
  "Format: plain text only, no markdown symbols, no asterisks, no bullet characters, no dashes as punctuation. Number each insight like \"1.\" and start it with a short title on its own line.";
function aiStr(v, n) { return typeof v === "string" ? v.slice(0, n) : ""; }
async function handleInsights(request, env) {
  if (!env.ANTHROPIC_API_KEY) return json({ code: "setup", error: "Insights are not set up yet." }, 503);
  const len = Number(request.headers.get("Content-Length") || 0);
  if (len > AI_MAX_BODY) return json({ code: "error", error: "Request too large" }, 413);
  let body;
  try { const text = await request.text(); if (text.length > AI_MAX_BODY) return json({ code: "error", error: "Request too large" }, 413); body = JSON.parse(text); } catch (e) { return json({ code: "error", error: "Bad request" }, 400); }
  if (!body || typeof body !== "object" || !validId(body.device)) return json({ code: "error", error: "Bad request" }, 400);
  const data = aiStr(body.data, 100000), question = aiStr(body.question, 400).trim();
  if (!data.trim()) return json({ code: "error", error: "No data" }, 400);
  const hist = (Array.isArray(body.history) ? body.history : []).slice(0, 4).filter((h) => h && typeof h === "object" && typeof h.a === "string" && h.a.trim());
  const messages = [{ role: "user", content: "DATA\n" + data + "\n\nGive me my insights." }];
  hist.forEach((h, i) => { if (i) { const q = aiStr(h.q, 400).trim(); if (!q) return; messages.push({ role: "user", content: q }); } messages.push({ role: "assistant", content: aiStr(h.a, 6000) }); });
  if (question) { if (messages[messages.length - 1].role === "user") return json({ code: "error", error: "Bad request" }, 400); messages.push({ role: "user", content: question }); }
  else if (messages.length > 1) return json({ code: "error", error: "Bad request" }, 400);
  const day = new Date().toISOString().slice(0, 10);
  const dk = "ai:" + body.device + ":" + day, ak = "ai:all:" + day;
  const used = Number(await env.SUBS.get(dk)) || 0, all = Number(await env.SUBS.get(ak)) || 0;
  if (used >= AI_PER_DAY) return json({ code: "rate_limited", error: "Daily limit reached" }, 429);
  if (all >= AI_ALL_PER_DAY) return json({ code: "busy", error: "Service limit reached" }, 429);
  await env.SUBS.put(dk, String(used + 1), { expirationTtl: 172800 });
  await env.SUBS.put(ak, String(all + 1), { expirationTtl: 172800 });
  let r, j = {};
  try {
    r = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: { "content-type": "application/json", "x-api-key": env.ANTHROPIC_API_KEY, "anthropic-version": "2023-06-01" },
      body: JSON.stringify({ model: env.AI_MODEL || "claude-sonnet-5-5", max_tokens: 1800, system: AI_SYSTEM, messages }),
    });
    j = await r.json();
  } catch (e) { return json({ code: "error", error: "Could not reach the insights model" }, 502); }
  if (!r.ok) {
    const t = j && j.error && j.error.type;
    return json({ code: t === "authentication_error" || t === "permission_error" ? "setup" : t === "rate_limit_error" || t === "overloaded_error" ? "busy" : "error", error: "The insights model returned an error" }, 502);
  }
  const text = (Array.isArray(j.content) ? j.content : []).filter((c) => c && c.type === "text").map((c) => c.text).join("\n").trim();
  if (!text) return json({ code: "error", error: "Empty answer" }, 502);
  return json({ text, left: Math.max(0, AI_PER_DAY - used - 1) });
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: CORS });
    if (!env.SUBS) return json({ error: "The SUBS storage is not connected yet. Add the KV binding named SUBS." }, 500);

    if (url.pathname === "/" || url.pathname === "/health") return json({ ok: true, service: "tracker reminders", groups: true, insights: !!env.ANTHROPIC_API_KEY });

    if (url.pathname === "/vapid" && request.method === "GET") {
      const v = await getVapid(env);
      return json({ publicKey: v.pub });
    }

    if (url.pathname === "/pending" && request.method === "GET") {
      const id = url.searchParams.get("id");
      if (!validId(id)) return json({ type: "checkin", from: "" });
      const subs = await loadSubs(env);
      const s = subs.find((x) => x.id === id);
      return json({ type: s && s.pending ? s.pending.type : "checkin", from: s && s.pending && s.pending.from ? s.pending.from : "" });
    }

    if (request.method !== "POST") return json({ error: "Not found" }, 404);
    if (url.pathname === "/insights") return handleInsights(request, env);
    const len = Number(request.headers.get("Content-Length") || 0);
    if (len > MAX_BODY) return json({ error: "Request too large" }, 413);
    let body;
    try { const text = await request.text(); if (text.length > MAX_BODY) return json({ error: "Request too large" }, 413); body = JSON.parse(text); } catch (e) { return json({ error: "Bad request" }, 400); }
    if (!body || typeof body !== "object" || Array.isArray(body)) return json({ error: "Bad request" }, 400);
    if (url.pathname.startsWith("/group/")) return handleGroup(url.pathname, body || {}, env);
    if (!validId(body.id)) return json({ error: "Missing or invalid id" }, 400);
    const subs = await loadSubs(env);
    let sub = subs.find((x) => x.id === body.id);

    if (url.pathname === "/subscribe") {
      if (!body.subscription || !validEndpoint(body.subscription.endpoint)) return json({ error: "That is not a browser notification address." }, 400);
      const reminders = (Array.isArray(body.reminders) ? body.reminders : []).slice(0, 12).map((r) => ({
        id: String(r.id || "").replace(/[^A-Za-z0-9_-]/g, "").slice(0, 40), type: ["checkin", "finish", "trades", "water", "lock"].includes(r.type) ? r.type : "checkin", time: /^([01]\d|2[0-3]):[0-5]\d$/.test(String(r.time)) ? String(r.time) : "20:00",
      }));
      if (!sub) {
        if (subs.length >= MAX_SUBS) return json({ error: "Too many devices" }, 429);
        sub = { id: body.id, sent: {} };
        subs.push(sub);
      }
      sub.subscription = { endpoint: String(body.subscription.endpoint).slice(0, 800) };
      sub.tz = String(body.tz || "UTC").slice(0, 60);
      sub.reminders = reminders;
      if (body.status && typeof body.status === "object") { const s = body.status; sub.status = { date: String(s.date || "").slice(0, 10), anything: !!s.anything, remaining: Math.max(0, Math.min(99, Number(s.remaining) || 0)), trades: !!s.trades, water: !!s.water, noTrade: !!s.noTrade, locked: !!s.locked }; }
      await saveSubs(env, subs);
      return json({ ok: true });
    }

    if (url.pathname === "/status") {
      if (!sub) return json({ error: "Not subscribed" }, 404);
      const s = body.status || {};
      sub.status = { date: String(s.date || "").slice(0, 10), anything: !!s.anything, remaining: Math.max(0, Math.min(99, Number(s.remaining) || 0)), trades: !!s.trades, water: !!s.water, noTrade: !!s.noTrade, locked: !!s.locked };
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
