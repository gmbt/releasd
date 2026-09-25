/* releasd — one feed for the Rinse FM shows + Bandcamp labels you follow.
   Vanilla JS, no build step. Rinse is queried live (its API allows CORS);
   Bandcamp comes from data/bandcamp.json, prebuilt by build.py. */
(() => {
  'use strict';

  const RINSE_API = 'https://admin.rinse.fm/api';
  const GH_API = 'https://api.github.com';
  const LS = { seen: 'releasd.seen', settings: 'releasd.settings', cfg: 'releasd.cfg', ui: 'releasd.ui' };
  const DEFAULT_CFG = { days_back: 30, rinse: { shows: [] }, bandcamp: { fan: '', labels: [], exclude: [] } };

  const $ = (sel, el = document) => el.querySelector(sel);
  const $$ = (sel, el = document) => [...el.querySelectorAll(sel)];
  const load = (k, d) => { try { const v = JSON.parse(localStorage.getItem(k)); return v ?? d; } catch { return d; } };
  const save = (k, v) => { try { localStorage.setItem(k, JSON.stringify(v)); } catch { /* storage unavailable */ } };
  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const b64 = (s) => btoa(String.fromCharCode(...new TextEncoder().encode(s)));
  const unb64 = (s) => new TextDecoder().decode(Uint8Array.from(atob(s.replace(/\s/g, '')), (c) => c.charCodeAt(0)));
  const nonEmpty = (o) => Object.fromEntries(Object.entries(o || {}).filter(([, v]) => v));

  function detectRepo() {
    const m = location.hostname.match(/^([^.]+)\.github\.io$/i);
    return { owner: m ? m[1] : '', repo: m ? (location.pathname.split('/').filter(Boolean)[0] || '') : '', token: '' };
  }

  const state = {
    cfg: null, cfgSha: null,
    rinse: [], bc: null,
    seen: load(LS.seen, {}),
    ui: Object.assign({ hideSeen: false, showUpcoming: false, tab: 'rinse', bcTab: 'released' }, load(LS.ui, {})),
    settings: Object.assign(detectRepo(), nonEmpty(load(LS.settings, {}))),
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

  /* ---------- github sync ---------- */
  const ghReady = () => !!(state.settings.token && state.settings.owner && state.settings.repo);
  const cfgPath = () => `/repos/${state.settings.owner}/${state.settings.repo}/contents/config.json`;

  async function gh(path, opts = {}) {
    const r = await fetch(GH_API + path, { ...opts, headers: { Authorization: `Bearer ${state.settings.token}`, Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28', ...(opts.headers || {}) } });
    if (!r.ok) throw new Error(`GitHub ${r.status}: ${(await r.text()).slice(0, 160)}`);
    return r.json();
  }

  async function loadConfig() {
    const local = load(LS.cfg, null);
    if (ghReady()) {
      try {
        const r = await gh(cfgPath());
        state.cfgSha = r.sha;
        const cfg = JSON.parse(unb64(r.content));
        if (!local?._localEdits) save(LS.cfg, cfg);
        return cfg;
      } catch (e) { console.warn('config via GitHub failed', e); toast(e.message, 6000); }
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
    if (!ghReady()) {
      state.cfg._localEdits = true; save(LS.cfg, state.cfg);
      toast('Saved in this browser only. Add a GitHub token in settings to sync.', 5000);
      return false;
    }
    try {
      if (!state.cfgSha) { try { state.cfgSha = (await gh(cfgPath())).sha; } catch { /* file does not exist yet */ } }
      const r = await gh(cfgPath(), { method: 'PUT', body: JSON.stringify({ message: msg, content: b64(JSON.stringify(cfg, null, 2) + '\n'), sha: state.cfgSha || undefined }) });
      state.cfgSha = r.content.sha;
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
    const d = await rinseQuery(`{ episodeEntries(limit: 500, orderBy: "episodeDate DESC", episodeDate: ${JSON.stringify('>= ' + since)}, relatedToEntries: [{slug: ${JSON.stringify(shows)}}]) {
      title slug ... on episode_Entry { displayTitle extract episodeDate episodeTime episodeLength fileUrl isRebroadcast channel { title } parentShow { slug title } } } }`);
    state.rinse = (d.episodeEntries || []).map(normRinse).sort((a, b) => b.when - a.when);
  }

  function normRinse(e) {
    const show = e.parentShow?.[0] || {};
    const day = new Date(e.episodeDate);                 // midnight London, as UTC instant
    const hm = (e.episodeTime || '').slice(11, 16);      // episodeTime carries only the time of day
    const [h, m] = hm ? hm.split(':').map(Number) : [0, 0];
    const when = new Date(day.getTime() + (h * 60 + m) * 60000);
    return {
      id: 'r:' + e.slug,
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

  const visibleRinse = () => state.rinse.filter((it) => state.ui.showUpcoming || !it.upcoming);

  function rinseItem(it) {
    const seen = !!state.seen[it.id];
    const badges = [
      it.rebroadcast && '<span class="badge rb">rebroadcast</span>',
      it.upcoming && '<span class="badge up">upcoming</span>',
      !it.file && !it.upcoming && '<span class="badge">not archived yet</span>',
    ].filter(Boolean).join('');
    const meta = [it.dateStr, it.time, it.channel, it.length ? `${it.length} min` : '',
      `<a href="${esc(it.url)}" target="_blank" rel="noopener">rinse.fm</a>`,
      it.file ? `<a href="${esc(it.file)}" target="_blank" rel="noopener">mp3</a>` : ''].filter(Boolean).join(' · ');
    return `<li class="item${seen ? ' seen' : ''}" data-id="${esc(it.id)}">
      <label class="seenbox" title="seen"><input type="checkbox"${seen ? ' checked' : ''}></label>
      <div class="body">
        <div class="line1"><a class="show" href="https://rinse.fm/shows/${esc(it.showSlug)}" target="_blank" rel="noopener">${esc(it.showTitle)}</a>${it.sub ? ` <span class="sub">${esc(it.sub)}</span>` : ''}${badges}</div>
        <div class="meta">${meta}</div>
        ${it.extract ? `<div class="extract">${esc(it.extract)}</div>` : ''}
        ${it.file ? `<audio controls preload="none" src="${esc(it.file)}"></audio>` : ''}
      </div></li>`;
  }

  function renderRinse() {
    const items = visibleRinse();
    $('#rinseItems').innerHTML = items.map(rinseItem).join('');
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
  const isPre = (r) => new Date(r.release_date).getTime() > Date.now() || !!r.is_preorder;

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
    const seen = !!state.seen[r.id];
    const via = (r.via || []).map((v) => `<a href="${esc(v.url)}" target="_blank" rel="noopener">${esc(v.name)}</a>`).join(', ');
    const label = r.label && !(r.via || []).some((v) => v.name === r.label) ? esc(r.label) : '';
    const pre = isPre(r);
    const date = fmtDay(new Date(r.release_date), 'UTC');
    const tracks = pre
      ? (r.tracks ? `${r.streamable ?? '?'} of ${r.tracks} tracks available` : '')
      : [r.tracks ? `${r.tracks} tr` : '', r.duration ? fmtDur(r.duration) : ''].filter(Boolean).join(' · ');
    const meta = [pre ? `out ${date}` : date, via, label, tracks,
      (!pre || r.streamable) ? '<button type="button" class="btn play">play</button>' : ''].filter(Boolean).join(' · ');
    return `<li class="item has-art${seen ? ' seen' : ''}" data-id="${esc(r.id)}" data-item="${esc(r.item_type)}:${esc(r.item_id)}">
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
    $('#bcItems').innerHTML = items.map(bcItem).join('');
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
    if (box.firstChild) { box.innerHTML = ''; return; }
    $$('.player').forEach((p) => { p.innerHTML = ''; });
    $$('audio').forEach((a) => a.pause());
    const [type, id] = li.dataset.item.split(':');
    box.innerHTML = `<iframe src="https://bandcamp.com/EmbeddedPlayer/${esc(type)}=${esc(id)}/size=large/bgcol=161618/linkcol=9bd0ff/tracklist=false/artwork=small/transparent=true/" loading="lazy" title="Bandcamp player"></iframe>`;
  }

  /* ---------- seen ---------- */
  function updateCounts() {
    $('#rinseCount').textContent = visibleRinse().filter((i) => !state.seen[i.id]).length || '';
    const unseen = (list) => list.filter((i) => !state.seen[i.id]).length || '';
    $('#bcReleasedCount').textContent = unseen(visibleBc('released'));
    $('#bcPreCount').textContent = unseen(visibleBc('preorders'));
    $('#bcCount').textContent = unseen(allBc());
  }
  function setSeen(id, on) { if (on) state.seen[id] = Date.now(); else delete state.seen[id]; }
  function markAllSeen(which) {
    (which === 'rinse' ? visibleRinse() : visibleBc()).forEach((i) => setSeen(i.id, true));
    save(LS.seen, state.seen);
    which === 'rinse' ? renderRinse() : renderBc();
  }

  /* ---------- source editors ---------- */
  const chip = (label, kind, val, title = 'remove') => `<span class="chip">${esc(label)}<button type="button" data-rm="${kind}" data-val="${esc(val)}" title="${title}">×</button></span>`;
  const syncHint = () => ghReady() ? '' : '<p class="hint warn">Not synced to GitHub — edits stay in this browser. <button type="button" class="link" data-settings>Set token</button></p>';

  function renderEditor(which) {
    const c = state.cfg;
    if (which === 'rinse') {
      $('#rinseEditor').innerHTML = `
        <div class="chips">${(c.rinse?.shows || []).map((s) => chip(s, 'rinse', s)).join('') || '<span class="hint">no shows</span>'}</div>
        <form class="add" data-add="rinse"><input placeholder="show slug or rinse.fm/shows/… URL" required spellcheck="false"><button class="btn" type="submit">add</button></form>
        ${syncHint()}`;
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
  function openSettings() {
    const dlg = $('#settings'); const f = $('form', dlg);
    f.owner.value = state.settings.owner || ''; f.repo.value = state.settings.repo || ''; f.token.value = state.settings.token || '';
    dlg.returnValue = ''; dlg.showModal();
  }
  $('#settings').addEventListener('close', async (ev) => {
    const dlg = ev.target; if (dlg.returnValue !== 'save') return;
    const f = $('form', dlg);
    state.settings = { owner: f.owner.value.trim(), repo: f.repo.value.trim(), token: f.token.value.trim() };
    save(LS.settings, state.settings);
    state.cfgSha = null;
    await init();
  });

  /* ---------- events ---------- */
  document.addEventListener('change', (ev) => {
    const t = ev.target;
    if (t.matches('.seenbox input')) {
      const li = t.closest('.item'); setSeen(li.dataset.id, t.checked); save(LS.seen, state.seen);
      li.classList.toggle('seen', t.checked); updateCounts();
    } else if (t.id === 'hideSeen') { state.ui.hideSeen = t.checked; save(LS.ui, state.ui); document.body.classList.toggle('hide-seen', t.checked); }
    else if (t.id === 'showUpcoming') { state.ui.showUpcoming = t.checked; save(LS.ui, state.ui); renderRinse(); }
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
  });
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
  }, true);

  function renderTabs() {
    $$('.tab').forEach((b) => b.classList.toggle('active', b.dataset.tab === state.ui.tab));
    $$('.panel').forEach((p) => p.classList.toggle('active', p.id === state.ui.tab));
  }

  /* ---------- init ---------- */
  async function init() {
    const local = load(LS.cfg, null);
    state.cfg = await loadConfig();
    if (ghReady() && local?._localEdits) {
      if (confirm('You have show/label edits saved only in this browser. Push them to GitHub now?')) {
        state.cfg = local; await commitConfig('sync local edits');
      } else { delete local._localEdits; save(LS.cfg, state.cfg); }
    }
    document.body.classList.toggle('hide-seen', !!state.ui.hideSeen);
    $('#hideSeen').checked = !!state.ui.hideSeen;
    $('#showUpcoming').checked = !!state.ui.showUpcoming;
    renderTabs();
    $$('.editor').forEach((e) => { if (!e.hidden) renderEditor(e.id === 'rinseEditor' ? 'rinse' : 'bandcamp'); });
    await Promise.allSettled([
      fetchRinse().then(renderRinse, (e) => { $('#rinseStatus').textContent = 'Rinse API error: ' + e.message; }),
      fetchBandcamp().then(renderBc, (e) => { $('#bcStatus').textContent = 'No Bandcamp data yet — run build.py or wait for the Action. ' + e.message; }),
    ]);
  }
  init();
})();
