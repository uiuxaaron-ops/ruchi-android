/*
 * Ruchi native adapter
 * ---------------------------------------------------------------
 * The web prototype runs inside Claude and uses Claude's artifact
 * features through `claude.use(name)`. On a phone those don't exist,
 * so this file provides the same `window.claude.use()` with
 * phone-side stand-ins:
 *
 *   db         -> data saved on the device (localStorage), seeded with
 *                 the starter spots in seed.js
 *   user       -> a stable id for this phone
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

  const caps = { db, user, sample, dictation, downloads };
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
