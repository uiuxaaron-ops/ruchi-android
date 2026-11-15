/*
 * Ruchi native adapter
 * ---------------------------------------------------------------
 * The web prototype runs inside Claude and uses Claude's artifact
 * features through `claude.use(name)`. On a phone those don't exist,
 * so this file provides the same `window.claude.use()` with
 * phone-side stand-ins:
 *
 *   db         -> CLOUD: shared Supabase database (config.js supabaseUrl/Key),
 *                 cached on the phone, realtime, offline outbox.
 *                 LOCAL (no Supabase config): data on this phone only,
 *                 seeded with the starter spots in seed.js
 *   user       -> cloud: silent Supabase account; local: a stable id per phone
 *   sample     -> Ask Ruchi AI through YOUR server (config.js -> aiEndpoint).
 *                 No endpoint = the app's built-in offline planner.
 *   dictation  -> Android speech recognition (Capacitor plugin)
 *   downloads  -> save + share sheet (Capacitor Filesystem + Share)
 *
 * It also wires the Android back button and haptics.
 * Load order in index.html: config.js, seed.js, ruchi-native.js, then the app.
 */
(function () {
  'use strict';
  if (window.claude && window.claude.use) return; // running inside Claude: use the real thing

  const CFG = Object.assign({ aiEndpoint: '', aiModelTier: 'default' }, window.RUCHI_CONFIG || {});
  const Cap = window.Capacitor;
  const P = (Cap && Cap.Plugins) || {};
  const isNative = !!(Cap && Cap.isNativePlatform && Cap.isNativePlatform());

  /* ---------- local database (same API the app already uses) ----------
     Stored in IndexedDB (hundreds of MB) so photos never fill it up.
     Older installs that used localStorage are migrated on first launch. */
  const KEY = 'ruchi_db_v1';
  const clone = (v) => JSON.parse(JSON.stringify(v));
  let store = null;
  const seedInto = (st) => {
    st = st || clone(window.RUCHI_SEED || { spots: {}, reviews: {}, confirms: {}, profiles: {}, experiments: {} });
    if (window.RUCHI_SEED) for (const [c, docs] of Object.entries(window.RUCHI_SEED)) {
      st[c] = st[c] || {};
      for (const [id, d] of Object.entries(docs)) if (!(id in st[c]) && !(st._deleted || []).includes(c + '/' + id)) st[c][id] = clone(d);
    }
    return st;
  };
  const idb = () => new Promise((res, rej) => {
    if (!window.indexedDB) return rej(new Error('no idb'));
    const r = indexedDB.open('ruchi', 1);
    r.onupgradeneeded = () => r.result.createObjectStore('kv');
    r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error);
  });
  let dbh = null;
  const ready = (async () => {
    let fromLS = null;
    try { fromLS = JSON.parse(localStorage.getItem(KEY) || 'null'); } catch (e) {}
    try {
      dbh = await idb();
      const got = await new Promise((res) => { const t = dbh.transaction('kv').objectStore('kv').get(KEY); t.onsuccess = () => res(t.result || null); t.onerror = () => res(null); });
      store = seedInto(got || fromLS);
      if (!got) await writeIdb();                 // first run or migration from localStorage
      if (fromLS) try { localStorage.removeItem(KEY); } catch (e) {}
    } catch (e) {
      dbh = null; store = seedInto(fromLS);       // very old WebView: fall back to localStorage
    }
  })();
  const writeIdb = () => new Promise((res) => {
    try { const t = dbh.transaction('kv', 'readwrite'); t.objectStore('kv').put(store, KEY); t.oncomplete = res; t.onerror = () => res(); } catch (e) { res(); }
  });
  let saveT = null;
  const persist = () => {
    clearTimeout(saveT);
    saveT = setTimeout(async () => {
      if (dbh) return writeIdb();
      try { localStorage.setItem(KEY, JSON.stringify(store)); }
      catch (e) { try { window.toast && window.toast('Phone storage is full. Free up space to keep saving.'); } catch (_) {} }
    }, 120);
  };
  window.addEventListener('pagehide', () => { if (saveT) { clearTimeout(saveT); dbh ? writeIdb() : persist(); } });
  const subs = {};
  const snap = (c) => ({
    docs: Object.entries(store[c] || {}).map(([id, v]) => ({ id, data: () => clone(v), exists: true })),
    metadata: { fromCache: false },
    size: Object.keys(store[c] || {}).length
  });
  const emit = (c) => (subs[c] || []).forEach((cb) => { try { cb(snap(c)); } catch (e) { console.error(e); } });
  const newId = () => 'u' + Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
  const docRef = (path) => {
    const [c, id] = path.split('/');
    return {
      id,
      async get() { await ready; const v = store[c] && store[c][id]; return { id, exists: !!v, data: () => (v ? clone(v) : undefined) }; },
      async set(d) { await ready; store[c] = store[c] || {}; store[c][id] = clone(d); persist(); emit(c); },
      async update(d) { await ready; store[c] = store[c] || {}; store[c][id] = Object.assign({}, store[c][id] || {}, clone(d)); persist(); emit(c); },
      async delete() { await ready; if (store[c]) delete store[c][id]; (store._deleted = store._deleted || []).push(path); persist(); emit(c); }
    };
  };
  const db = {
    doc: docRef,
    collection(c) {
      return {
        doc: (id) => docRef(c + '/' + id),
        async get() { await ready; return snap(c); },
        async add(d) { const id = newId(); await docRef(c + '/' + id).set(d); return { id }; },
        onSnapshot(cb, err) {
          (subs[c] = subs[c] || []).push(cb);
          ready.then(() => cb(snap(c)));
          return () => { subs[c] = (subs[c] || []).filter((f) => f !== cb); };
        }
      };
    }
  };


  /* =====================================================================
     CLOUD MODE (Supabase) — on when config.js has supabaseUrl + supabaseAnonKey.
     Same db API as above, but every phone shares one database:
       - silent sign-in (anonymous Supabase account per install)
       - reads: cached copy first (instant, works offline), then live data,
         then realtime pushes when anyone changes anything
       - writes: shown instantly, sent to the server; if offline they wait
         in an outbox and sync when the phone is back online
       - photos (data:image/...) are uploaded to the "photos" bucket and
         replaced by their public URL before saving
       - first cloud launch moves this phone's own local data up
     ===================================================================== */
  function makeCloud(local) {
    const SB = window.supabase;
    if (!CFG.supabaseUrl || !CFG.supabaseAnonKey || !SB || !SB.createClient) return null;
    const sb = SB.createClient(CFG.supabaseUrl, CFG.supabaseAnonKey, {
      auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: false, storageKey: 'ruchi_auth' },
      realtime: { params: { eventsPerSecond: 5 } }
    });
    const COLS = ['spots', 'reviews', 'confirms', 'profiles', 'experiments'];
    let uid = null;
    try { uid = localStorage.getItem('ruchi_cloud_uid'); } catch (e) {}

    /* ---- cache (IndexedDB, same "ruchi" database as the local store) ---- */
    const CK = 'ruchi_cloud_cache_v1', OK = 'ruchi_cloud_outbox_v1';
    let cache = {}, outbox = [];
    const kvGet = (k) => new Promise((res) => { local.idb().then((h) => { const t = h.transaction('kv').objectStore('kv').get(k); t.onsuccess = () => res(t.result || null); t.onerror = () => res(null); }).catch(() => { try { res(JSON.parse(localStorage.getItem(k) || 'null')); } catch (e) { res(null); } }); });
    const kvPut = (k, v) => local.idb().then((h) => new Promise((res) => { const t = h.transaction('kv', 'readwrite'); t.objectStore('kv').put(v, k); t.oncomplete = res; t.onerror = res; })).catch(() => { try { localStorage.setItem(k, JSON.stringify(v)); } catch (e) {} });
    let cT = null;
    const saveCache = () => { clearTimeout(cT); cT = setTimeout(() => kvPut(CK, cache), 400); };
    const saveOutbox = () => kvPut(OK, outbox);
    const cacheReady = Promise.all([kvGet(CK), kvGet(OK)]).then(([c, o]) => { cache = c || {}; outbox = Array.isArray(o) ? o : []; });

    /* ---- auth: silent anonymous account, kept across launches ---- */
    let authP = null;
    const signIn = () => authP || (authP = (async () => {
      const { data } = await sb.auth.getSession();
      let u = data && data.session && data.session.user;
      if (!u) {
        const r = await sb.auth.signInAnonymously();
        if (r.error) throw r.error;
        u = r.data.user;
      }
      uid = u.id;
      try { localStorage.setItem('ruchi_cloud_uid', uid); } catch (e) {}
      return uid;
    })().catch((e) => { authP = null; throw e; }));

    /* ---- snapshots + listeners ---- */
    const subs = {}, loaded = {};
    const snapOf = (c, fromCache) => {
      const m = cache[c] || {};
      return { docs: Object.entries(m).map(([id, v]) => ({ id, data: () => clone(v), exists: true })), metadata: { fromCache: !!fromCache }, size: Object.keys(m).length };
    };
    const emit = (c, fromCache) => (subs[c] || []).forEach((cb) => { try { cb(snapOf(c, fromCache)); } catch (e) { console.error(e); } });
    const putLocal = (c, id, v) => { (cache[c] = cache[c] || {})[id] = v; saveCache(); };
    const dropLocal = (c, id) => { if (cache[c]) delete cache[c][id]; saveCache(); };

    async function fetchAll(c) {
      const rows = {};
      for (let from = 0; ; from += 1000) {
        const { data, error } = await sb.from('docs').select('id,data').eq('collection', c).range(from, from + 999);
        if (error) throw error;
        for (const r of data) rows[r.id] = r.data;
        if (data.length < 1000) break;
      }
      // keep writes that haven't reached the server yet
      for (const op of outbox) if (op.c === c) { if (op.t === 'del') delete rows[op.id]; else rows[op.id] = op.d; }
      cache[c] = rows; loaded[c] = true; saveCache(); emit(c, false);
    }
    const refresh = (c) => fetchAll(c).catch((e) => { console.warn('ruchi cloud: fetch ' + c, e); });

    let chan = null, everJoined = false;
    function startRealtime() {
      if (chan) return;
      chan = sb.channel('ruchi-docs')
        .on('postgres_changes', { event: '*', schema: 'public', table: 'docs' }, (p) => {
          const row = p.eventType === 'DELETE' ? p.old : p.new;
          if (!row || !COLS.includes(row.collection)) return;
          if (outbox.some((o) => o.c === row.collection && o.id === row.id)) return; // our pending write wins
          if (p.eventType === 'DELETE') dropLocal(row.collection, row.id); else putLocal(row.collection, row.id, row.data);
          emit(row.collection, false);
        })
        .subscribe((st) => {
          if (st === 'SUBSCRIBED') { if (everJoined) Object.keys(subs).forEach(refresh); everJoined = true; } // catch up after a reconnect
        });
    }

    /* ---- photos: data URLs -> storage URLs ---- */
    const isImg = (v) => typeof v === 'string' && v.startsWith('data:image/') && v.length > 2000;
    async function uploadImg(dataUrl) {
      const blob = await (await fetch(dataUrl)).blob();
      const ext = (blob.type.split('/')[1] || 'jpg').replace('jpeg', 'jpg');
      const path = uid + '/' + Date.now().toString(36) + Math.random().toString(36).slice(2, 8) + '.' + ext;
      const { error } = await sb.storage.from('photos').upload(path, blob, { contentType: blob.type || 'image/jpeg', cacheControl: '31536000', upsert: false });
      if (error) throw error;
      return sb.storage.from('photos').getPublicUrl(path).data.publicUrl;
    }
    async function withPhotoUrls(v) {
      if (isImg(v)) return uploadImg(v);
      if (Array.isArray(v)) return Promise.all(v.map(withPhotoUrls));
      if (v && typeof v === 'object') { const o = {}; for (const [k, x] of Object.entries(v)) o[k] = await withPhotoUrls(x); return o; }
      return v;
    }

    /* ---- sending writes (with offline outbox) ---- */
    const isNetErr = (e) => !navigator.onLine || (e && (e.name === 'TypeError' || /fetch|network|Failed to|timeout/i.test(String(e.message || e))));
    const permErr = (e) => ({ code: (e && e.code === '42501') || /row-level security|permission/i.test(String(e && e.message)) ? 'invalid_argument' : 'server', message: (e && e.message) || 'Save failed' });
    async function send(op) {
      await signIn();
      if (op.t === 'del') {
        const { data, error } = await sb.from('docs').delete().eq('collection', op.c).eq('id', op.id).select('id');
        if (error) throw error;
        if (!data || !data.length) throw { code: '42501', message: 'Not allowed to delete this' }; // the rules silently skip others' rows
        return;
      }
      const d = await withPhotoUrls(op.d);
      const { error } = await sb.from('docs').upsert({ collection: op.c, id: op.id, owner: uid, data: d }, { onConflict: 'collection,id' });
      if (error) throw error;
      if (JSON.stringify(d) !== JSON.stringify(op.d) && cache[op.c] && cache[op.c][op.id]) { putLocal(op.c, op.id, d); emit(op.c, false); } // show the hosted photo URL
    }
    let flushing = false;
    async function flush() {
      if (flushing || !outbox.length) return; flushing = true;
      try {
        while (outbox.length) {
          const op = outbox[0];
          try { await send(op); }
          catch (e) {
            if (isNetErr(e)) break;                      // still offline: try later
            console.warn('ruchi cloud: dropped write', op.c + '/' + op.id, e);
          }
          outbox.shift(); saveOutbox();
        }
      } finally { flushing = false; }
    }
    window.addEventListener('online', flush);
    setInterval(flush, 30000);
    document.addEventListener('visibilitychange', () => { if (!document.hidden) { flush(); Object.keys(subs).forEach(refresh); } });

    async function write(op) {
      await cacheReady;
      const prev = cache[op.c] && cache[op.c][op.id];
      if (op.t === 'del') dropLocal(op.c, op.id); else putLocal(op.c, op.id, op.d);
      emit(op.c, false);
      const queued = outbox.some((o) => o.c === op.c && o.id === op.id);
      if (!queued) {
        try { await send(op); return; }
        catch (e) {
          if (!isNetErr(e)) {                           // refused by the server: undo
            if (prev === undefined) dropLocal(op.c, op.id); else putLocal(op.c, op.id, prev);
            emit(op.c, false); throw permErr(e);
          }
        }
      }
      outbox = outbox.filter((o) => !(o.c === op.c && o.id === op.id)); // keep only the latest write per doc
      outbox.push(op); saveOutbox();
    }

    /* ---- the db object the app uses ---- */
    const docRef = (path) => {
      const [c, id] = path.split('/');
      return {
        id,
        async get() {
          await cacheReady;
          try { const { data, error } = await sb.from('docs').select('data').eq('collection', c).eq('id', id).maybeSingle(); if (!error) { if (data) putLocal(c, id, data.data); else if (!outbox.some((o) => o.c === c && o.id === id)) dropLocal(c, id); } } catch (e) {}
          const v = cache[c] && cache[c][id];
          return { id, exists: v !== undefined, data: () => (v === undefined ? undefined : clone(v)) };
        },
        set: (d) => write({ t: 'set', c, id, d: clone(d) }),
        async update(d) { await cacheReady; return write({ t: 'set', c, id, d: Object.assign({}, (cache[c] && cache[c][id]) || {}, clone(d)) }); },
        delete: () => write({ t: 'del', c, id })
      };
    };
    const db = {
      doc: docRef,
      collection(c) {
        return {
          doc: (id) => docRef(c + '/' + id),
          async get() { await cacheReady; try { await fetchAll(c); } catch (e) {} return snapOf(c, !loaded[c]); },
          async add(d) { await signIn().catch(() => {}); const id = newId(); await docRef(c + '/' + id).set(d); return { id }; },
          onSnapshot(cb, err) {
            (subs[c] = subs[c] || []).push(cb);
            cacheReady.then(() => {
              if (cache[c]) cb(snapOf(c, true));             // instant: last known data
              return signIn().then(() => { startRealtime(); return fetchAll(c); });
            }).catch((e) => { console.warn('ruchi cloud: ' + c, e); if (!cache[c] && err) err(e); });
            return () => { subs[c] = (subs[c] || []).filter((f) => f !== cb); };
          }
        };
      }
    };

    /* ---- move this phone's local data to the cloud, once ---- */
    async function migrate() {
      try { if (localStorage.getItem('ruchi_cloud_migrated') === uid) return; } catch (e) { return; }
      await local.ready;
      const st = local.store(), old = local.uid;
      if (st && old) {
        for (const c of ['profiles', 'reviews', 'confirms', 'experiments']) {
          const v = st[c] && st[c][old];
          if (v) await write({ t: 'set', c, id: uid, d: clone(v) }).catch(() => {});
        }
        for (const [id, v] of Object.entries(st.spots || {})) {
          if (v && v.by === old) await write({ t: 'set', c: 'spots', id: newId(), d: Object.assign(clone(v), { by: uid }) }).catch(() => {});
        }
      }
      try { localStorage.setItem('ruchi_cloud_migrated', uid); } catch (e) {}
    }

    const user = {
      async id() {
        try { await Promise.race([signIn(), new Promise((_, rej) => setTimeout(() => rej(new Error('timeout')), 8000))]); }
        catch (e) { if (!uid) return null; }               // offline but signed in before: keep going
        migrate().then(flush).catch(() => {});
        cacheReady.then(flush);
        return uid;
      },
      async profiles(ids) {
        await cacheReady;
        const out = {};
        for (const i of ids) { const p = cache.profiles && cache.profiles[i]; out[i] = { name: (p && p.nick) || '' }; }
        return out;
      }
    };
    window.RUCHI_CLOUD = { sb, flush, outbox: () => outbox.length, uid: () => uid };
    return { db, user };
  }

  /* ---------- user ---------- */
  let uid = null;
  try { uid = localStorage.getItem('ruchi_uid'); if (!uid) { uid = 'me' + newId(); localStorage.setItem('ruchi_uid', uid); } } catch (e) { uid = 'me-local'; }
  const user = {
    async id() { return uid; },
    async profiles(ids) {
      const out = {};
      await ready;
      for (const i of ids) { const p = store.profiles && store.profiles[i]; out[i] = { name: (p && p.nick) || '' }; }
      return out;
    }
  };

  /* ---------- AI (your server) ---------- */
  let sample = null;
  if (CFG.aiEndpoint) {
    const call = async (input, opts = {}) => {
      const messages = typeof input === 'string' ? [{ role: 'user', content: input }] : input;
      let r;
      try {
        r = await fetch(CFG.aiEndpoint, {
          method: 'POST',
          headers: { 'content-type': 'application/json', ...(CFG.aiKey ? { 'x-ruchi-key': CFG.aiKey } : {}) },
          body: JSON.stringify({ messages, tier: opts.modelTier || CFG.aiModelTier }),
          signal: opts.signal
        });
      } catch (e) {
        if (e && e.name === 'AbortError') throw e;
        throw { code: 'network', message: 'Can’t reach Ruchi AI' };
      }
      if (r.status === 429) throw { code: 'rate_limited', message: 'Too many questions, try again soon' };
      if (!r.ok) throw { code: 'server', message: 'Ruchi AI error ' + r.status };
      const j = await r.json();
      const text = j.text || '';
      if (opts.onText) try { opts.onText({ text, delta: text }); } catch (e) {}
      return { text, truncated: !!j.truncated };
    };
    sample = async (input, opts) => call(input, opts);
    sample.json = async (input, opts) => {
      const { text } = await call(input, opts);
      const m = text.match(/\{[\s\S]*\}/);
      if (!m) throw { code: 'bad_json', message: 'AI reply was not JSON' };
      return JSON.parse(m[0]);
    };
    sample.limits = async () => ({ images: false });
  }

  /* ---------- voice (Android speech recognition) ---------- */
  let dictation = null;
  const SR = P.SpeechRecognition;
  if (isNative && SR) {
    const h = { partial: [], final: [], state: [] };
    let last = '', listening = false;
    const fire = (k, v) => h[k].forEach((f) => { try { f(v); } catch (e) {} });
    SR.addListener('partialResults', (d) => {
      const t = (d && d.matches && d.matches[0]) || '';
      if (t) { last = t; fire('partial', { text: t }); }
    });
    SR.addListener('listeningState', (d) => {
      if (d && d.status === 'stopped' && listening) {
        listening = false;
        if (last) { fire('final', { text: last }); last = ''; }
        fire('state', { state: 'idle', reason: 'stopped' });
      }
    });
    dictation = {
      onPartial: (f) => h.partial.push(f),
      onFinal: (f) => h.final.push(f),
      onState: (f) => h.state.push(f),
      async start() {
        const perm = await SR.requestPermissions().catch(() => null);
        if (!perm || perm.speechRecognition !== 'granted') throw { code: 'not_granted' };
        const av = await SR.available().catch(() => ({ available: false }));
        if (!av.available) throw { code: 'unavailable' };
        last = ''; listening = true; fire('state', { state: 'listening' });
        await SR.start({ language: 'en-IN', maxResults: 1, partialResults: true, popup: false });
      },
      async stop() {
        try { await SR.stop(); } catch (e) {}
        await new Promise((r) => setTimeout(r, 250));
        if (listening) { listening = false; if (last) { fire('final', { text: last }); last = ''; } fire('state', { state: 'idle', reason: 'stopped' }); }
      }
    };
  }

  /* ---------- downloads (save image -> share sheet) ---------- */
  const downloads = {
    async save({ filename, data }) {
      if (isNative && P.Filesystem && P.Share) {
        const b64 = await new Promise((res, rej) => { const fr = new FileReader(); fr.onload = () => res(String(fr.result).split(',')[1]); fr.onerror = rej; fr.readAsDataURL(data); });
        const w = await P.Filesystem.writeFile({ path: filename, data: b64, directory: 'CACHE' });
        await P.Share.share({ title: 'Ruchi', files: [w.uri] });
        return;
      }
      const a = document.createElement('a'); a.href = URL.createObjectURL(data); a.download = filename; a.click();
      setTimeout(() => URL.revokeObjectURL(a.href), 4000);
    }
  };

  const cloud = makeCloud({ ready, store: () => store, uid, idb });
  const caps = cloud ? { db: cloud.db, user: cloud.user, sample, dictation, downloads } : { db, user, sample, dictation, downloads };
  window.claude = Object.freeze({ use: async (name) => caps[name] || null });

  /* ---------- Android niceties ---------- */
  if (isNative) {
    document.documentElement.classList.add('native-android');
    // vibration -> native haptics (feels better than WebView vibrate)
    if (P.Haptics) {
      navigator.vibrate = (ms) => { P.Haptics.impact({ style: (ms || 0) >= 10 ? 'MEDIUM' : 'LIGHT' }).catch(() => {}); return true; };
    }
    // back button: close the top-most layer, else go to the map, else leave the app
    if (P.App) {
      const shown = (sel) => { const el = document.querySelector(sel); return !!(el && el.classList.contains('show')); };
      const call = (fn, ...a) => { if (typeof window[fn] === 'function') { window[fn](...a); return true; } return false; };
      P.App.addListener('backButton', () => {
        const app = document.getElementById('app');
        if (app && app.classList.contains('voicing')) return call('voiceCancel');
        if (document.querySelector('.sheet.show, #shareModal.show')) return call('closeSheets');
        if (shown('#locp')) return call('closeLoc');
        if (shown('#nfp')) return call('closeNotifs');
        if (shown('#lstp')) return call('closeList');
        if (shown('#sv')) return call('closeSearch');
        if (shown('#page-ask')) return call('closeAsk');
        if (app && app.classList.contains('adding')) return call('cancelAdd') || call('go', 'map');
        if (shown('#onboard') || shown('#auth')) {
          const back = document.querySelector('#onboard.show .backbtn, #auth.show .backbtn');
          if (back) return back.click();
        }
        if (document.querySelector('.page.show:not(#page-ask)')) return call('go', 'map');
        P.App.exitApp();
      });
    }
    if (P.SplashScreen) window.addEventListener('load', () => setTimeout(() => P.SplashScreen.hide().catch(() => {}), 250));
  }
})();
