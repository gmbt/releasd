/* releasd-api — Cloudflare Worker.
   GET/PUT /seen    seen marks in KV, server-side per-item last-write-wins merge
   GET/PUT /config  config.json in the GitHub repo (token stays here, never in a browser)
   GET     /health
   Auth: Authorization: Bearer <API_KEY>. CORS limited to ALLOWED_ORIGINS. */

const SEEN_KEY = 'seen';
const KEEP_MS = 180 * 864e5;

export default {
  async fetch(req, env) {
    const url = new URL(req.url);
    const cors = corsHeaders(req.headers.get('Origin') || '', env);
    if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors });
    if (url.pathname === '/health') return json({ ok: true }, 200, cors);
    if (!authorized(req, env)) return json({ error: 'unauthorized' }, 401, cors);
    try {
      const route = `${req.method} ${url.pathname}`;
      if (route === 'GET /seen') return json(await getSeen(env), 200, cors);
      if (route === 'PUT /seen') return json(await putSeen(env, await req.json()), 200, cors);
      if (route === 'GET /config') return json(await getConfig(env), 200, cors);
      if (route === 'PUT /config') return json(await putConfig(env, await req.json()), 200, cors);
      return json({ error: 'not found' }, 404, cors);
    } catch (e) {
      return json({ error: String(e && e.message || e) }, 502, cors);
    }
  },
};

/* ---------- plumbing ---------- */
function corsHeaders(origin, env) {
  const allowed = (env.ALLOWED_ORIGINS || '').split(',').map((s) => s.trim()).filter(Boolean);
  const h = {
    'Access-Control-Allow-Methods': 'GET, PUT, OPTIONS',
    'Access-Control-Allow-Headers': 'Authorization, Content-Type',
    'Access-Control-Max-Age': '86400',
    'Vary': 'Origin',
    'Cache-Control': 'no-store',
  };
  if (allowed.includes(origin)) h['Access-Control-Allow-Origin'] = origin;
  return h;
}
const json = (data, status, headers) =>
  new Response(JSON.stringify(data), { status, headers: { ...headers, 'Content-Type': 'application/json; charset=utf-8' } });

function authorized(req, env) {
  const h = req.headers.get('Authorization') || '';
  const key = h.startsWith('Bearer ') ? h.slice(7).trim() : '';
  return !!env.API_KEY && key.length === env.API_KEY.length && timingSafeEqual(key, env.API_KEY);
}
function timingSafeEqual(a, b) {
  let r = 0;
  for (let i = 0; i < a.length; i++) r |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return r === 0;
}
const b64encode = (s) => btoa(String.fromCharCode(...new TextEncoder().encode(s)));
const b64decode = (s) => new TextDecoder().decode(Uint8Array.from(atob(s.replace(/\s/g, '')), (c) => c.charCodeAt(0)));

/* ---------- seen marks ---------- */
function mergeItems(into, from) {
  let changed = false;
  for (const [id, rec] of Object.entries(from || {})) {
    if (!rec || typeof rec.t !== 'number' || id.length > 200) continue;
    const cur = into[id];
    if (!cur || rec.t > cur.t) { into[id] = { t: rec.t, s: rec.s ? 1 : 0 }; changed = true; }
  }
  return changed;
}

async function getSeen(env) {
  const doc = (await env.STATE.get(SEEN_KEY, 'json')) || { v: 1, items: {} };
  if (!doc.seeded) {  // one-time migration from the earlier seen.json-on-a-branch approach, whenever the token is available
    const legacy = await legacySeen(env);
    if (legacy) {
      mergeItems(doc.items, legacy.items);
      doc.seeded = true; doc.updated = Date.now();
      await env.STATE.put(SEEN_KEY, JSON.stringify(doc));
    }
  }
  return doc;
}

async function putSeen(env, body) {
  const doc = await getSeen(env);
  let changed = mergeItems(doc.items, body && body.items);
  const cutoff = Date.now() - KEEP_MS;
  for (const [id, rec] of Object.entries(doc.items)) if (rec.t < cutoff) { delete doc.items[id]; changed = true; }
  if (changed) { doc.updated = Date.now(); await env.STATE.put(SEEN_KEY, JSON.stringify(doc)); }
  return doc;
}

// returns {items} to merge, {} when there is nothing to migrate, null when it cannot be known yet (no token / GitHub down)
async function legacySeen(env) {
  if (!env.GH_TOKEN) return null;
  try {
    const r = await gh(env, '/contents/seen.json?ref=state', { headers: { Accept: 'application/vnd.github.raw+json' } });
    return await r.json();
  } catch (e) {
    return /GitHub 404/.test(e.message) ? {} : null;
  }
}

/* ---------- config.json via GitHub ---------- */
async function gh(env, path, init = {}) {
  if (!env.GH_TOKEN) throw new Error('GH_TOKEN secret not set');
  const r = await fetch(`https://api.github.com/repos/${env.GH_OWNER}/${env.GH_REPO}${path}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${env.GH_TOKEN}`, Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28', 'User-Agent': 'releasd-worker', ...(init.headers || {}),
    },
  });
  if (!r.ok) throw new Error(`GitHub ${r.status}: ${(await r.text()).slice(0, 200)}`);
  return r;
}

async function getConfig(env) {
  const j = await (await gh(env, '/contents/config.json')).json();
  return { sha: j.sha, config: JSON.parse(b64decode(j.content)) };
}

function validateConfig(cfg) {
  if (!cfg || typeof cfg !== 'object') throw new Error('config must be an object');
  const shows = cfg.rinse && cfg.rinse.shows;
  if (!Array.isArray(shows) || !shows.every((s) => typeof s === 'string' && /^[a-z0-9-]{1,80}$/.test(s))) throw new Error('rinse.shows invalid');
  const bc = cfg.bandcamp || {};
  for (const k of ['labels', 'exclude']) if (bc[k] && !(Array.isArray(bc[k]) && bc[k].every((s) => typeof s === 'string'))) throw new Error(`bandcamp.${k} invalid`);
  if (cfg.days_back !== undefined && !(Number.isInteger(cfg.days_back) && cfg.days_back > 0 && cfg.days_back <= 365)) throw new Error('days_back invalid');
}

async function putConfig(env, body) {
  const cfg = body && body.config;
  validateConfig(cfg);
  const message = String((body && body.message) || 'config via releasd').slice(0, 120);
  const content = b64encode(JSON.stringify(cfg, null, 2) + '\n');
  let sha = (await getConfig(env)).sha;
  for (let attempt = 0; ; attempt++) {
    try {
      const j = await (await gh(env, '/contents/config.json', { method: 'PUT', body: JSON.stringify({ message, content, sha }) })).json();
      return { sha: j.content.sha, commit: j.commit.sha };
    } catch (e) {
      if (attempt === 0 && /GitHub 409/.test(e.message)) { sha = (await getConfig(env)).sha; continue; }
      throw e;
    }
  }
}
