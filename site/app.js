/* releasd — one feed for the Rinse FM shows + Bandcamp labels you follow.
   Vanilla JS, no build step. Rinse is queried live (its API allows CORS);
   Bandcamp comes from data/bandcamp.json, prebuilt by build.py. */
(() => {
  'use strict';

  const RINSE_API = 'https://admin.rinse.fm/api';
  const API_URL = 'https://releasd-api.gmbt.workers.dev';  // Cloudflare Worker from worker/
  const LS = { seen: 'releasd.seen', settings: 'releasd.settings', cfg: 'releasd.cfg', ui: 'releasd.ui', shows: 'releasd.shows' };
  const DEFAULT_CFG = { days_back: 30, rinse: { shows: [] }, bandcamp: { fan: '', labels: [], exclude: [] } };

  const $ = (sel, el = document) => el.querySelector(sel);
  const $$ = (sel, el = document) => [...el.querySelectorAll(sel)];
  const load = (k, d) => { try { const v = JSON.parse(localStorage.getItem(k)); return v ?? d; } catch { return d; } };
  const save = (k, v) => { try { localStorage.setItem(k, JSON.stringify(v)); } catch { /* storage unavailable */ } };
  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const COPY_ICON = '<svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg>';
  const nonEmpty = (o) => Object.fromEntries(Object.entries(o || {}).filter(([, v]) => v));

  function migrateSeen(m) {
    for (const [k, v] of Object.entries(m)) if (typeof v === 'number') m[k] = { t: v, s: 1 };
    return m;
  }

  // the personal sync link carries the backend key: https://…/releasd/#k=<key>
  function keyFromUrl() {
    const m = location.hash.match(/[#&]k=([A-Za-z0-9_-]{16,})/);
    return m ? m[1] : '';
  }

  const state = {
    cfg: null,
    rinse: [], bc: null,
    seen: migrateSeen(load(LS.seen, {})),
    ui: Object.assign({ hideSeen: false, showUpcoming: false, tab: 'rinse', bcTab: 'released', rinseSort: 'added', bpm: false }, load(LS.ui, {})),
    settings: Object.assign({ api: API_URL, key: '' }, nonEmpty(load(LS.settings, {})), nonEmpty({ key: keyFromUrl() })),
  };

  /* ---------- ui helpers ---------- */
  let toastTimer;
  function toast(msg, ms = 3500) {
    let el = $('.toast');
    if (!el) { el = document.createElement('div'); el.className = 'toast'; document.body.appendChild(el); }
    el.textContent = msg; el.hidden = false;
    clearTimeout(toastTimer); toastTimer = setTimeout(() => { el.hidden = true; }, ms);
  }
  const fmtDur = (s) => (s >= 3600 ? `${Math.floor(s / 3600)}h ${String(Math.round((s % 3600) / 60)).padStart(2, '0')}m` : `${Math.round(s / 60)} min`);
  const fmtDay = (d, tz) => d.toLocaleDateString('en-GB', { timeZone: tz, day: '2-digit', month: 'short' });

  /* ---------- backend: Cloudflare Worker (worker/) ---------- */
  const apiReady = () => !!(state.settings.api && state.settings.key);
  async function api(path, opts = {}) {
    const r = await fetch(state.settings.api.replace(/\/$/, '') + path, {
      ...opts,
      headers: { Authorization: `Bearer ${state.settings.key}`, 'Content-Type': 'application/json', ...(opts.headers || {}) },
    });
    if (!r.ok) {
      let msg = ''; try { msg = (await r.json()).error || ''; } catch { /* no body */ }
      throw new Error(`API ${r.status}${msg ? ': ' + msg : ''}`);
    }
    return r.json();
  }
  const syncErr = (e, what) => toast(/API 401/.test(e.message) ? 'Sync key rejected — check settings.' : `${what}: ${e.message}`, 6000);

  async function loadConfig() {
    const local = load(LS.cfg, null);
    if (apiReady()) {
      try {
        const { config } = await api('/config');
        if (!local?._localEdits) save(LS.cfg, config);
        return config;
      } catch (e) { console.warn('config via API failed', e); syncErr(e, 'config'); }
    }
    if (local?._localEdits) return local;
    try {
      const r = await fetch(`config.json?t=${Date.now()}`, { cache: 'no-store' });
      if (r.ok) { const cfg = await r.json(); save(LS.cfg, cfg); return cfg; }
    } catch { /* offline or local dev without build */ }
    return local || structuredClone(DEFAULT_CFG);
  }

  async function commitConfig(msg) {
    const cfg = { ...state.cfg }; delete cfg._localEdits;
    if (!apiReady()) {
      state.cfg._localEdits = true; save(LS.cfg, state.cfg);
      toast('Saved in this browser only. Open your personal sync link to sync (see settings).', 5000);
      return false;
    }
    try {
      await api('/config', { method: 'PUT', body: JSON.stringify({ config: cfg, message: msg }) });
      delete state.cfg._localEdits; save(LS.cfg, state.cfg);
      toast('Committed: ' + msg);
      return true;
    } catch (e) {
      state.cfg._localEdits = true; save(LS.cfg, state.cfg);
      toast('Commit failed, kept locally. ' + e.message, 7000);
      return false;
    }
  }

  /* ---------- rinse ---------- */
  async function rinseQuery(q) {
    const r = await fetch(RINSE_API, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ query: q }) });
    const j = await r.json();
    if (j.errors) throw new Error(j.errors.map((e) => e.message).join('; '));
    return j.data;
  }

  async function fetchRinse() {
    const shows = state.cfg.rinse?.shows || [];
    if (!shows.length) { state.rinse = []; return; }
    const since = new Date(Date.now() - (state.cfg.days_back || 30) * 864e5).toISOString().slice(0, 10);
    const rel = `relatedToEntries: [{slug: ${JSON.stringify(shows)}}]`;
    const fields = `{ title slug dateUpdated ... on episode_Entry { displayTitle extract episodeDate episodeTime episodeLength fileUrl isRebroadcast channel { title }
      featuredImage { filename } parentShow { slug title ... on show_Entry { featuredImage { filename } defaultEpisodeImage { filename } } } } }`;
    // a: aired inside the window; b: aired before it but audio attached (entry updated) inside it -> late backfills
    const d = await rinseQuery(`{
      a: episodeEntries(limit: 500, orderBy: "episodeDate DESC", episodeDate: ${JSON.stringify('>= ' + since)}, ${rel}) ${fields}
      b: episodeEntries(limit: 100, orderBy: "dateUpdated DESC", dateUpdated: ${JSON.stringify('>= ' + since)}, episodeDate: ${JSON.stringify('< ' + since)}, fileUrl: ":notempty:", ${rel}) ${fields}
    }`);
    const seen = new Set();
    state.rinse = [...(d.a || []), ...(d.b || [])].filter((e) => !seen.has(e.slug) && seen.add(e.slug)).map(normRinse);
    migrateSlugMarks();
  }
  function migrateSlugMarks() {
    let moved = 0;
    for (const it of state.rinse) {
      const legacy = state.seen['r:' + it.slug];
      if (it.file && legacy?.s === 1 && !state.seen[it.id]) { state.seen[it.id] = { ...legacy }; moved++; }
    }
    if (moved) { save(LS.seen, state.seen); scheduleSeenPush(); }
  }

  const rinseArt = (f) => (f ? `https://image.rinse.fm/_/${encodeURIComponent(f)}?w=112&h=112` : null);

  function normRinse(e) {
    const show = e.parentShow?.[0] || {};
    const day = new Date(e.episodeDate);                 // midnight London, as UTC instant
    const hm = (e.episodeTime || '').slice(11, 16);      // episodeTime carries only the time of day
    const [h, m] = hm ? hm.split(':').map(Number) : [0, 0];
    const when = new Date(day.getTime() + (h * 60 + m) * 60000);
    const updated = new Date(e.dateUpdated);
    const available = e.fileUrl ? updated : when;          // audio arrives with the entry update
    const backfilled = !!e.fileUrl && updated - when > 2 * 864e5;
    const img = e.featuredImage?.[0]?.filename || show.featuredImage?.[0]?.filename || show.defaultEpisodeImage?.[0]?.filename;  // episode art first
    return {
      // one seen-state per audio file: a rebroadcast shares its mp3 with the original, so ticking either ticks both.
      // Pending episodes (no audio yet) get a slug key so a tick there does not stick once the audio lands.
      id: e.fileUrl ? 'r:f:' + e.fileUrl : 'r:' + e.slug + ':pending', slug: e.slug,
      available, backfilled, addedStr: fmtDay(updated, 'Europe/London'), art: rinseArt(img),
      showSlug: show.slug || e.slug.replace(/-\d{2}-\d{2}-\d{4}-\d{4}(-\d+)?$/, ''),
      showTitle: show.title || e.title.split(' - ')[0],
      sub: e.displayTitle || '',
      dateStr: fmtDay(day, 'Europe/London'), time: hm, when,
      length: e.episodeLength, file: e.fileUrl, rebroadcast: !!e.isRebroadcast,
      channel: e.channel?.[0]?.title || '', extract: e.extract || '',
      url: `https://rinse.fm/episodes/${e.slug}`,
      upcoming: when.getTime() > Date.now(),
    };
  }

  function visibleRinse() {
    const key = state.ui.rinseSort === 'aired' ? 'when' : 'available';
    return state.rinse.filter((it) => state.ui.showUpcoming || !it.upcoming).sort((a, b) => b[key] - a[key]);
  }

  function rinseItem(it) {
    const seen = isSeen(it.id);
    const badges = [
      it.rebroadcast && '<span class="badge rb">rebroadcast</span>',
      it.backfilled && '<span class="badge bf">backfilled</span>',
      it.upcoming && '<span class="badge up">upcoming</span>',
      !it.file && !it.upcoming && '<span class="badge">not archived yet</span>',
    ].filter(Boolean).join('');
    const meta = [it.backfilled ? `aired ${it.dateStr} ${it.time} · added ${it.addedStr}` : `${it.dateStr} · ${it.time}`, it.channel, it.length ? `${it.length} min` : '',
      `<a href="${esc(it.url)}" target="_blank" rel="noopener">rinse.fm</a>`,
      it.file ? `<a href="${esc(it.file)}" target="_blank" rel="noopener">mp3</a>` : '',
      `<button type="button" class="btn ghost mini icon" data-copy="${esc(it.url)}" title="copy link to this episode" aria-label="copy link">${COPY_ICON}</button>`].filter(Boolean).join(' · ');
    return `<li class="item has-art${seen ? ' seen' : ''}" data-id="${esc(it.id)}" data-key="${esc(it.slug)}">
      <label class="seenbox" title="seen"><input type="checkbox"${seen ? ' checked' : ''}></label>
      ${it.art ? `<img class="art" src="${esc(it.art)}" alt="" loading="lazy">` : '<div class="art"></div>'}
      <div class="body">
        <div class="line1"><a class="show" href="https://rinse.fm/shows/${esc(it.showSlug)}" target="_blank" rel="noopener">${esc(it.showTitle)}</a>${it.sub ? ` <span class="sub">${esc(it.sub)}</span>` : ''}${badges}</div>
        <div class="meta">${meta}</div>
        ${it.extract ? `<div class="extract">${esc(it.extract)}</div>` : ''}
        ${it.file ? `<audio controls preload="none"${bpmOn() ? ` crossorigin="anonymous" src="${esc(relayUrl(it.file))}"` : ` src="${esc(it.file)}"`}></audio>` : ''}
      </div></li>`;
  }

  /* Re-render a list by reusing existing rows (keyed) and only reordering them. Moving a node within one task does
     not pause its <audio>, so filters/sorting no longer interrupt playback. fresh=true rebuilds every row. */
  const tpl = document.createElement('template');
  function reconcile(ol, items, html, fresh = false) {
    const existing = new Map($$(':scope > .item', ol).map((li) => [li.dataset.key, li]));
    const frag = document.createDocumentFragment();
    for (const it of items) {
      let li = fresh ? null : existing.get(it.key);
      if (li) {
        const on = isSeen(it.id); li.classList.toggle('seen', on);
        const cb = $('.seenbox input', li); if (cb) cb.checked = on;
      } else { tpl.innerHTML = html(it); li = tpl.content.firstElementChild; }
      frag.appendChild(li);
    }
    ol.replaceChildren(frag);
  }

  function renderRinse(fresh = false) {
    const items = visibleRinse();
    reconcile($('#rinseItems'), items.map((it) => Object.assign(it, { key: it.slug })), rinseItem, fresh);
    const shows = state.cfg.rinse?.shows || [];
    $('#rinseStatus').textContent = shows.length
      ? `${items.length} episodes · ${shows.length} shows · last ${state.cfg.days_back || 30} days`
      : 'No shows yet — click “edit shows”.';
    updateCounts();
  }

  /* ---------- bandcamp ---------- */
  async function fetchBandcamp() {
    const r = await fetch(`data/bandcamp.json?t=${Date.now()}`, { cache: 'no-store' });
    if (!r.ok) throw new Error(`data/bandcamp.json → ${r.status}`);
    state.bc = await r.json();
  }

  // pre-order = release date still ahead, or Bandcamp says so (data can be up to 3 h stale)
  const isPre = (r) => new Date(r.release_date).getTime() > Date.now() || (!!r.is_preorder && (r.streamable ?? 0) < (r.tracks ?? 0));

  function allBc() {
    if (!state.bc) return [];
    const ex = new Set((state.cfg.bandcamp?.exclude || []).map(String));
    return state.bc.releases.filter((r) => !(r.via || []).every((v) => ex.has(v.subdomain || '') || ex.has(v.url)));
  }
  function visibleBc(tab = state.ui.bcTab) {
    const items = allBc().filter((r) => isPre(r) === (tab === 'preorders'));
    // released: newest first (build order); pre-orders: soonest out first
    return tab === 'preorders' ? items.sort((a, b) => new Date(a.release_date) - new Date(b.release_date)) : items;
  }

  function bcItem(r) {
    const seen = isSeen(r.id);
    const via = (r.via || []).map((v) => `<a href="${esc(v.url)}" target="_blank" rel="noopener">${esc(v.name)}</a>`).join(', ');
    const label = r.label && !(r.via || []).some((v) => v.name === r.label) ? esc(r.label) : '';
    const pre = isPre(r);
    const date = fmtDay(new Date(r.release_date), 'UTC');
    const tracks = pre
      ? (r.tracks ? `${r.streamable ?? '?'} of ${r.tracks} tracks available` : '')
      : [r.tracks ? `${r.tracks} tr` : '', r.duration ? fmtDur(r.duration) : ''].filter(Boolean).join(' · ');
    const meta = [pre ? `out ${date}` : date, via, label, tracks,
      `<button type="button" class="btn ghost mini icon" data-copy="${esc(r.url || '')}" title="copy link to this release" aria-label="copy link">${COPY_ICON}</button>`,
      (!pre || r.streamable) ? '<button type="button" class="btn play" title="play">▶</button>' : ''].filter(Boolean).join(' · ');
    return `<li class="item has-art${seen ? ' seen' : ''}" data-id="${esc(r.id)}" data-item="${esc(r.item_type)}:${esc(r.item_id)}" data-tracks="${r.tracks || 0}" data-key="${esc(r.id)}">
      <label class="seenbox" title="seen"><input type="checkbox"${seen ? ' checked' : ''}></label>
      ${r.art ? `<img class="art" src="${esc(r.art)}" alt="" loading="lazy">` : '<div class="art"></div>'}
      <div class="body">
        <div class="line1"><span class="artist">${esc(r.artist)}</span> — <a href="${esc(r.url || r.via?.[0]?.url || '#')}" target="_blank" rel="noopener">${esc(r.title)}</a>${pre ? '<span class="badge up">pre-order</span>' : ''}${r.item_type === 'track' ? '<span class="badge">single</span>' : ''}</div>
        <div class="meta">${meta}</div>
        <div class="player"></div>
      </div></li>`;
  }

  function renderBc() {
    $$('.subtab').forEach((b) => b.classList.toggle('active', b.dataset.bctab === state.ui.bcTab));
    const items = visibleBc();
    for (const tab of ['released', 'preorders']) {
      const ol = $(tab === 'released' ? '#bcReleased' : '#bcPre');
      reconcile(ol, visibleBc(tab).map((r) => Object.assign(r, { key: r.id })), bcItem);
      ol.hidden = tab !== state.ui.bcTab;
    }
    if (state.bc) {
      const age = Math.round((Date.now() - new Date(state.bc.generated_at)) / 36e5);
      const errs = state.bc.errors?.length ? ` · ${state.bc.errors.length} fetch errors` : '';
      const st = $('#bcStatus');
      st.textContent = `${items.length} ${state.ui.bcTab === 'preorders' ? 'pre-orders' : 'releases'} · ${state.bc.bands.length} artists/labels · last ${state.bc.days_back} days · built ${age < 1 ? '<1' : age} h ago${errs}`;
      st.title = (state.bc.errors || []).join('\n');
    }
    updateCounts();
  }

  function togglePlayer(li) {
    const box = $('.player', li);
    const wasOpen = !!box.firstChild;
    $$('.player').forEach((p) => { p.innerHTML = ''; });
    $$('.btn.play').forEach((b) => { b.textContent = '▶'; });
    if (wasOpen) return;
    $$('audio').forEach((a) => a.pause());
    const [type, id] = li.dataset.item.split(':');
    const tracks = Number(li.dataset.tracks) || 0;
    // Bandcamp's large layout: 119px info row + 33px per track + padding; the list scrolls beyond ~7 tracks
    const list = type === 'album' && tracks > 1;
    const height = list ? Math.min(165 + 33 * tracks, 420) : 120;
    box.innerHTML = `<iframe src="https://bandcamp.com/EmbeddedPlayer/${esc(type)}=${esc(id)}/size=large/bgcol=161618/linkcol=9bd0ff/tracklist=${list}/artwork=small/transparent=true/" style="height:${height}px" loading="lazy" title="Bandcamp player"></iframe>`;
    $('.btn.play', li).textContent = '✕';
  }

  /* ---------- seen ---------- */
  function updateCounts() {
    const unseen = (list) => list.filter((i) => !isSeen(i.id)).length || '';
    $('#rinseCount').textContent = unseen(visibleRinse());
    $('#bcReleasedCount').textContent = unseen(visibleBc('released'));
    $('#bcPreCount').textContent = unseen(visibleBc('preorders'));
    $('#bcCount').textContent = unseen(allBc());
  }
  const isSeen = (id) => state.seen[id]?.s === 1;
  function setSeen(id, on) { state.seen[id] = { t: Date.now(), s: on ? 1 : 0 }; }
  function markAllSeen(which) {
    (which === 'rinse' ? visibleRinse() : visibleBc()).forEach((i) => setSeen(i.id, true));
    save(LS.seen, state.seen); scheduleSeenPush();
    applySeenToDom();
  }

  /* seen-state sync through the Worker. The server merges per item (last-write-wins), so devices never clobber each other. */
  let seenTimer = null, seenPushing = false, seenDirty = false;

  function mergeSeen(items) {
    let changed = false;
    for (const [id, rec] of Object.entries(items || {})) {
      const cur = state.seen[id];
      if (!cur || (rec.t || 0) > (cur.t || 0)) { state.seen[id] = rec; changed = true; }
    }
    return changed;
  }
  // update checkboxes in place: re-rendering would stop a playing <audio>
  function applySeenToDom() {
    $$('.item').forEach((li) => {
      const on = isSeen(li.dataset.id); li.classList.toggle('seen', on);
      const cb = $('.seenbox input', li); if (cb) cb.checked = on;
    });
    updateCounts();
  }
  async function pullSeen() {
    if (!apiReady()) return false;
    try {
      const changed = mergeSeen((await api('/seen')).items);
      if (changed) save(LS.seen, state.seen);
      return changed;
    } catch (e) { syncErr(e, 'seen sync'); return false; }
  }
  function scheduleSeenPush() {
    if (!apiReady()) return;
    seenDirty = true; clearTimeout(seenTimer); seenTimer = setTimeout(pushSeen, 1500);
  }
  async function pushSeen() {
    if (!apiReady() || seenPushing) return;
    seenPushing = true; seenDirty = false;
    try {
      const merged = await api('/seen', { method: 'PUT', body: JSON.stringify({ items: state.seen }) });
      if (mergeSeen(merged.items)) { save(LS.seen, state.seen); applySeenToDom(); }
    } catch (e) {
      syncErr(e, 'seen sync');
      if (!/API 401/.test(e.message)) seenTimer = setTimeout(() => { seenDirty = true; pushSeen(); }, 15000);  // offline? retry
    } finally {
      seenPushing = false;
      if (seenDirty) scheduleSeenPush();
    }
  }
  // other devices may have marked things while this tab was in the background
  document.addEventListener('visibilitychange', async () => {
    if (document.hidden || !state.cfg) return;
    if (await pullSeen()) applySeenToDom();
  });

  /* ---------- source editors ---------- */
  const chip = (label, kind, val, title = 'remove') => `<span class="chip">${esc(label)}<button type="button" data-rm="${kind}" data-val="${esc(val)}" title="${title}">×</button></span>`;
  const syncHint = () => apiReady() ? '' : '<p class="hint warn">Not synced — edits stay in this browser. <button type="button" class="link" data-settings>Open settings</button></p>';

  function renderEditor(which) {
    const c = state.cfg;
    if (which === 'rinse') {
      $('#rinseEditor').innerHTML = `
        <div class="showtools">
          <input class="search" id="showSearch" type="search" placeholder="search shows…" autocomplete="off" spellcheck="false">
          <label class="chk"><input type="checkbox" id="showHidden"> include hidden</label>
          <span class="hint" id="showCount"></span>
        </div>
        <div class="showlist" id="showList"><span class="hint">loading show list…</span></div>
        ${syncHint()}`;
      fetchShows().then(() => renderShowList(), (e) => { $('#showList').innerHTML = `<span class="hint warn">Could not load show list: ${esc(e.message)}</span>`; });
    } else {
      const bands = state.bc?.bands || [];
      const labels = c.bandcamp?.labels || [];
      const ex = c.bandcamp?.exclude || [];
      $('#bcEditor').innerHTML = `
        <p class="hint">Following as <b>${esc(c.bandcamp?.fan || '—')}</b> on Bandcamp (${bands.length} artists/labels). Changes here apply after the next build (~2 min after commit, or the next 3-hourly run).</p>
        <form class="add" data-add="bandcamp"><input placeholder="extra label URL, e.g. https://hyperdub.bandcamp.com" required spellcheck="false"><button class="btn" type="submit">add</button></form>
        ${labels.length ? `<div class="chips"><span class="hint">extra:</span>${labels.map((u) => chip(u.replace(/^https?:\/\//, ''), 'bclabel', u)).join('')}</div>` : ''}
        ${ex.length ? `<div class="chips"><span class="hint">hidden:</span>${ex.map((s) => chip(s, 'bcunhide', s, 'restore')).join('')}</div>` : ''}
        <details><summary>followed (${bands.length}) — × to hide</summary><div class="chips">${bands.map((b) => chip(b.name, 'bchide', b.subdomain || b.url, 'hide')).join('')}</div></details>
        ${syncHint()}`;
    }
  }

  /* Rinse show catalogue (all ~3k shows, cached a day) for the follow checklist */
  let shows = null;
  async function fetchShows() {
    const cached = load(LS.shows, null);
    if (cached?.list && Date.now() - (cached.t || 0) < 864e5) { shows = cached.list; return shows; }
    const d = await rinseQuery('{ showEntries(limit: 6000, orderBy: "title ASC") { slug title ... on show_Entry { showStatus } } }');
    shows = (d.showEntries || []).map((x) => ({ slug: x.slug, title: x.title, hidden: x.showStatus === 'hidden' }));
    save(LS.shows, { t: Date.now(), list: shows });
    return shows;
  }
  function renderShowList() {
    const box = $('#showList'); if (!box || !shows) return;
    const followed = new Set(state.cfg.rinse?.shows || []);
    const q = ($('#showSearch')?.value || '').trim().toLowerCase();
    const withHidden = !!$('#showHidden')?.checked;
    const bySlug = new Map(shows.map((x) => [x.slug, x]));
    const extra = [...followed].filter((sl) => !bySlug.has(sl)).map((sl) => ({ slug: sl, title: sl, hidden: false }));  // followed but not in catalogue
    const titleCount = new Map(); shows.forEach((x) => titleCount.set(x.title.toLowerCase(), (titleCount.get(x.title.toLowerCase()) || 0) + 1));
    let list = [...extra, ...shows].filter((x) => followed.has(x.slug) || withHidden || !x.hidden);
    if (q) list = list.filter((x) => x.title.toLowerCase().includes(q) || x.slug.includes(q));
    else list.sort((a, b) => (followed.has(b.slug) - followed.has(a.slug)) || a.title.localeCompare(b.title, undefined, { sensitivity: 'base' }));
    const row = (x) => `<label class="showrow${followed.has(x.slug) ? ' on' : ''}"><input type="checkbox" data-show="${esc(x.slug)}"${followed.has(x.slug) ? ' checked' : ''}>
      <span class="t">${esc(x.title)}</span>${(titleCount.get(x.title.toLowerCase()) || 0) > 1 || x.title === x.slug ? ` <span class="s">${esc(x.slug)}</span>` : ''}${x.hidden ? ' <span class="badge">hidden</span>' : ''}</label>`;
    const slugLike = q && /^[a-z0-9-]+$/.test(q) && !bySlug.has(q);
    box.innerHTML = (list.map(row).join('') || '<span class="hint">no matches</span>') +
      (slugLike && !list.length ? `<button type="button" class="btn ghost mini" data-addslug="${esc(q)}">follow “${esc(q)}” anyway</button>` : '');
    $('#showCount').textContent = `${followed.size} followed · ${list.length} shown`;
  }
  let cfgTimer = null, cfgPending = { add: 0, rm: 0 };
  function scheduleShowsCommit() {  // batch rapid ticks into one commit (each commit triggers a rebuild)
    clearTimeout(cfgTimer);
    cfgTimer = setTimeout(async () => {
      const { add, rm } = cfgPending; cfgPending = { add: 0, rm: 0 };
      await Promise.all([commitConfig(`rinse shows: +${add} −${rm}`), fetchRinse().then(renderRinse)]);
    }, 2500);
  }
  function toggleShow(slug, on) {
    state.cfg.rinse = state.cfg.rinse || { shows: [] };
    const set = new Set(state.cfg.rinse.shows || []);
    if (on) set.add(slug); else set.delete(slug);
    state.cfg.rinse.shows = [...set].sort();
    cfgPending[on ? 'add' : 'rm']++;
    $('#showCount').textContent = `${set.size} followed`;
    scheduleShowsCommit();
  }

  function toggleEditor(which) {
    const el = which === 'rinse' ? $('#rinseEditor') : $('#bcEditor');
    el.hidden = !el.hidden;
    if (!el.hidden) renderEditor(which);
  }

  async function addSource(kind, raw) {
    if (!raw) return;
    if (kind === 'rinse') {
      const slug = raw.replace(/\/+$/, '').split('/shows/').pop().split(/[/?#]/)[0].trim().toLowerCase();
      if (!slug) return;
      state.cfg.rinse = state.cfg.rinse || { shows: [] };
      const shows = state.cfg.rinse.shows = state.cfg.rinse.shows || [];
      if (shows.includes(slug)) return toast('already added');
      try {
        const d = await rinseQuery(`{ showEntries(slug: ${JSON.stringify([slug])}) { slug title } }`);
        if (!d.showEntries?.length) return toast(`No Rinse show with slug “${slug}”`, 5000);
      } catch (e) { console.warn(e); }
      shows.push(slug); shows.sort();
      renderEditor('rinse');
      await Promise.all([commitConfig(`add rinse show ${slug}`), fetchRinse().then(renderRinse)]);
    } else {
      let url;
      try { url = new URL(/^https?:\/\//i.test(raw) ? raw : 'https://' + raw).origin; } catch { return toast('not a URL'); }
      const bc = state.cfg.bandcamp = state.cfg.bandcamp || { fan: '', labels: [], exclude: [] };
      bc.labels = bc.labels || [];
      if (bc.labels.includes(url)) return toast('already added');
      bc.labels.push(url);
      renderEditor('bandcamp');
      await commitConfig(`add bandcamp label ${url}`);
    }
  }

  async function removeSource(kind, val) {
    const c = state.cfg;
    if (kind === 'rinse') {
      c.rinse.shows = (c.rinse.shows || []).filter((s) => s !== val);
      renderEditor('rinse');
      await Promise.all([commitConfig(`remove rinse show ${val}`), fetchRinse().then(renderRinse)]);
      return;
    }
    c.bandcamp = c.bandcamp || { fan: '', labels: [], exclude: [] };
    if (kind === 'bclabel') { c.bandcamp.labels = (c.bandcamp.labels || []).filter((u) => u !== val); renderEditor('bandcamp'); await commitConfig(`remove bandcamp label ${val}`); }
    else if (kind === 'bchide') { c.bandcamp.exclude = [...new Set([...(c.bandcamp.exclude || []), val])]; renderEditor('bandcamp'); renderBc(); await commitConfig(`hide bandcamp ${val}`); }
    else if (kind === 'bcunhide') { c.bandcamp.exclude = (c.bandcamp.exclude || []).filter((s) => s !== val); renderEditor('bandcamp'); renderBc(); await commitConfig(`unhide bandcamp ${val}`); }
  }

  /* ---------- settings ---------- */
  const syncLink = () => (state.settings.key ? `${location.origin}${location.pathname}#k=${state.settings.key}` : '');
  function openSettings() {
    const dlg = $('#settings'); const f = $('form', dlg);
    f.api.value = state.settings.api || ''; f.key.value = state.settings.key || '';
    $('#syncLink', dlg).textContent = syncLink() || 'no key yet';
    dlg.returnValue = ''; dlg.showModal();
  }
  $('#settings').addEventListener('close', async (ev) => {
    const dlg = ev.target; if (dlg.returnValue !== 'save') return;
    const f = $('form', dlg);
    state.settings = { api: f.api.value.trim() || API_URL, key: f.key.value.trim() };
    save(LS.settings, state.settings);
    await init();
  });
  document.addEventListener('click', (ev) => {
    if (ev.target.id !== 'copyLink' || !syncLink()) return;
    navigator.clipboard?.writeText(syncLink()).then(() => toast('Sync link copied'), () => toast('Copy failed — select the link manually'));
  });

  function copyText(text) {
    if (!text) return toast('nothing to copy');
    const ok = () => toast('Link copied');
    if (navigator.clipboard?.writeText) navigator.clipboard.writeText(text).then(ok, () => toast('Copy failed: ' + text, 6000));
    else window.prompt('Copy link', text);
  }

  /* ---------- live BPM (Rinse only; Bandcamp plays inside Bandcamp's iframe) ----------
     Web Audio can only analyse media the page may read cross-origin, so with BPM on the mp3 is streamed through
     the Worker's /audio relay (adds CORS headers). Detection library: realtime-bpm-analyzer (range 90-180). */
  const BPM_LIB = 'https://cdn.jsdelivr.net/npm/realtime-bpm-analyzer@5.0.15/dist/index.esm.js';
  const bpmOn = () => !!state.ui.bpm;
  const relayUrl = (u) => `${(state.settings.api || API_URL).replace(/\/$/, '')}/audio?u=${encodeURIComponent(u)}`;
  let bpmCtx = null, bpmLib = null, bpmCur = null;

  async function attachBpm(audio) {
    const badge = $('#bpmLive'); const li = audio.closest('.item');
    badge.title = li ? `${$('.show', li)?.textContent || ''} ${$('.sub', li)?.textContent || ''}`.trim() : '';
    if (bpmCur && bpmCur.audio !== audio) detachBpm();
    if (bpmCur) return;
    try {
      bpmLib = bpmLib || await import(BPM_LIB);
      bpmCtx = bpmCtx || new (window.AudioContext || window.webkitAudioContext)();
      if (bpmCtx.state === 'suspended') await bpmCtx.resume();
      if (!audio._src) { audio._src = bpmCtx.createMediaElementSource(audio); audio._src.connect(bpmCtx.destination); }  // once per element
      const analyzer = await bpmLib.createRealtimeBpmAnalyzer(bpmCtx, { continuousAnalysis: true, stabilizationTime: 20000 });
      const filter = bpmLib.getBiquadFilter(bpmCtx);
      audio._src.connect(filter); filter.connect(analyzer.node); analyzer.connect(bpmCtx.destination);  // analyzer wraps the worklet node; it outputs silence
      badge.textContent = '… bpm'; badge.hidden = false;
      analyzer.on('bpm', (d) => { const c = d && d.bpm && d.bpm[0]; if (c) badge.textContent = `${Math.round(c.tempo)} bpm`; });
      analyzer.on('bpmStable', (d) => { const c = d && d.bpm && d.bpm[0]; if (c) badge.textContent = `${Math.round(c.tempo)} bpm ✓`; });
      bpmCur = { audio, analyzer, filter, badge };
    } catch (e) {
      console.warn('bpm', e); badge.textContent = 'bpm n/a'; badge.hidden = false;
      toast('BPM analysis failed: ' + e.message, 6000);
    }
  }
  function detachBpm() {
    if (!bpmCur) return;
    try { bpmCur.filter.disconnect(); bpmCur.analyzer.disconnect(); } catch { /* already gone */ }
    bpmCur.badge.hidden = true; bpmCur = null;
  }

  /* ---------- events ---------- */
  document.addEventListener('change', (ev) => {
    const t = ev.target;
    if (t.matches('.seenbox input')) {
      const li = t.closest('.item'); setSeen(li.dataset.id, t.checked); save(LS.seen, state.seen); scheduleSeenPush();
      li.classList.toggle('seen', t.checked); updateCounts();
    } else if (t.id === 'hideSeen') { state.ui.hideSeen = t.checked; save(LS.ui, state.ui); document.body.classList.toggle('hide-seen', t.checked); }
    else if (t.id === 'showUpcoming') { state.ui.showUpcoming = t.checked; save(LS.ui, state.ui); renderRinse(); }
    else if (t.id === 'rinseSort') { state.ui.rinseSort = t.value; save(LS.ui, state.ui); renderRinse(); }
    else if (t.id === 'bpmOn') { state.ui.bpm = t.checked; save(LS.ui, state.ui); detachBpm(); renderRinse(true); }
    else if (t.dataset.show) { toggleShow(t.dataset.show, t.checked); t.closest('.showrow')?.classList.toggle('on', t.checked); }
    else if (t.id === 'showHidden') renderShowList();
  });
  document.addEventListener('click', (ev) => {
    const t = ev.target.closest('button'); if (!t) return;
    if (t.matches('.tab')) { state.ui.tab = t.dataset.tab; save(LS.ui, state.ui); renderTabs(); }
    else if (t.matches('.subtab')) { state.ui.bcTab = t.dataset.bctab; save(LS.ui, state.ui); renderBc(); }
    else if (t.matches('.play')) togglePlayer(t.closest('.item'));
    else if (t.dataset.seen) markAllSeen(t.dataset.seen);
    else if (t.dataset.edit) toggleEditor(t.dataset.edit);
    else if (t.id === 'openSettings' || t.hasAttribute('data-settings')) openSettings();
    else if (t.dataset.rm) removeSource(t.dataset.rm, t.dataset.val);
    else if (t.dataset.copy !== undefined) copyText(t.dataset.copy);
    else if (t.dataset.addslug) { toggleShow(t.dataset.addslug, true); $('#showSearch').value = ''; renderShowList(); }
  });
  document.addEventListener('input', (ev) => { if (ev.target.id === 'showSearch') renderShowList(); });
  document.addEventListener('submit', (ev) => {
    const f = ev.target; if (!f.dataset.add) return;
    ev.preventDefault();
    const inp = $('input', f); const v = inp.value.trim(); inp.value = '';
    addSource(f.dataset.add, v);
  });
  document.addEventListener('play', (ev) => {
    if (ev.target.tagName !== 'AUDIO') return;
    $$('audio').forEach((a) => { if (a !== ev.target) a.pause(); });
    $$('.player').forEach((p) => { p.innerHTML = ''; });
    $$('.btn.play').forEach((b) => { b.textContent = '▶'; });
    if (bpmOn()) attachBpm(ev.target);
  }, true);
  document.addEventListener('ended', (ev) => {  // listened to the end -> mark seen
    if (ev.target.tagName !== 'AUDIO') return;
    const li = ev.target.closest('.item'); if (!li) return;
    setSeen(li.dataset.id, true); save(LS.seen, state.seen); scheduleSeenPush(); applySeenToDom();
    toast('Marked as listened');
  }, true);

  function renderTabs() {
    $$('.tab').forEach((b) => b.classList.toggle('active', b.dataset.tab === state.ui.tab));
    $$('.panel').forEach((p) => p.classList.toggle('active', p.id === state.ui.tab));
  }

  /* ---------- init ---------- */
  async function init() {
    if (keyFromUrl()) save(LS.settings, state.settings);  // arrived via the personal sync link: remember the key
    const local = load(LS.cfg, null);
    state.cfg = await loadConfig();
    if (apiReady() && local?._localEdits) {
      if (confirm('You have show/label edits saved only in this browser. Sync them now?')) {
        state.cfg = local; await commitConfig('sync local edits');
      } else { delete local._localEdits; save(LS.cfg, state.cfg); }
    }
    document.body.classList.toggle('hide-seen', !!state.ui.hideSeen);
    $('#hideSeen').checked = !!state.ui.hideSeen;
    $('#showUpcoming').checked = !!state.ui.showUpcoming;
    $('#rinseSort').value = state.ui.rinseSort || 'added';
    $('#bpmOn').checked = !!state.ui.bpm;
    renderTabs();
    $$('.editor').forEach((e) => { if (!e.hidden) renderEditor(e.id === 'rinseEditor' ? 'rinse' : 'bandcamp'); });
    const hadLocal = Object.keys(state.seen).length > 0;
    await Promise.allSettled([
      pullSeen(),
      fetchRinse().then(renderRinse, (e) => { $('#rinseStatus').textContent = 'Rinse API error: ' + e.message; }),
      fetchBandcamp().then(renderBc, (e) => { $('#bcStatus').textContent = 'No Bandcamp data yet — run build.py or wait for the Action. ' + e.message; }),
    ]);
    renderRinse(); renderBc();
    if (hadLocal) scheduleSeenPush();  // upload marks made on this device before/without sync
  }
  init();
})();
