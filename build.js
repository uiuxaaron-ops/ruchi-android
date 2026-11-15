/*
 * Builds www/ for the Android + iOS apps and the installable web app from the Ruchi prototype.
 *   1. copies web/index.html (the same file as the live prototype)
 *   2. swaps Google Fonts for the bundled Poppins files (works offline)
 *   3. loads config.js, seed.js and ruchi-native.js before the app
 * Run: npm run build   (or npm run sync to also copy into the Android project)
 */
const fs = require('fs');
const path = require('path');
const root = __dirname, www = path.join(root, 'www');
fs.rmSync(www, { recursive: true, force: true });
fs.mkdirSync(path.join(www, 'fonts'), { recursive: true });

let html = fs.readFileSync(path.join(root, 'web', 'index.html'), 'utf8');

// 1) fonts: bundle Poppins
const weights = [['400', 'normal'], ['500', 'normal'], ['600', 'normal'], ['700', 'normal'], ['400', 'italic']];
let face = '';
for (const [w, st] of weights) {
  const f = `poppins-latin-${w}-${st}.woff2`;
  fs.copyFileSync(path.join(root, 'node_modules/@fontsource/poppins/files', f), path.join(www, 'fonts', f));
  face += `@font-face{font-family:'Poppins';font-style:${st};font-weight:${w};font-display:swap;src:url(fonts/${f}) format('woff2')}\n`;
}
const before = html.length;
html = html.replace(/<link[^>]*fonts\.googleapis\.com[^>]*>\s*/g, '').replace(/<link[^>]*fonts\.gstatic\.com[^>]*>\s*/g, '');
html = html.replace('</head>', `<style>${face}</style>\n</head>`);
if (html.length === before) console.warn('! Google Fonts link not found — check the font setup');

// 2) Android status bar: the app area starts below the status bar on every screen.
//    The app's own top-inset paddings are zeroed so the gap is never doubled.
// Top safe area: Android adds its own fixed gap (below), so the app's own top inset is 0 there;
// on iPhone it is the real notch / Dynamic Island inset.
html = html.split('env(safe-area-inset-top,0px)').join('var(--sat,0px)').split('env(safe-area-inset-top)').join('var(--sat,0px)');
const topGap = `<style id="android-top-gap">
html.native-android,html.native-android body{background:var(--bg,#FFFFFF)}
html:not(.native-android){--sat:env(safe-area-inset-top,0px)}
html.native-ios,html.native-ios body,html.pwa,html.pwa body{background:var(--bg,#FFFFFF)}
html.pwa #app{max-width:none}
html.native-android{--top-gap:max(env(safe-area-inset-top,0px),40px)}
html.native-android #app{position:fixed;top:var(--top-gap);left:0;right:0;bottom:0;height:auto;max-width:none;margin:0}
</style>`;
html = html.replace('</head>', topGap + '\n</head>');

// 3) installable web app (iPhone "Add to Home Screen", Android Chrome "Install app")
const pwaHead = `<link rel="manifest" href="manifest.webmanifest">
<link rel="apple-touch-icon" href="icons/apple-touch-icon.png">
<meta name="apple-mobile-web-app-capable" content="yes">
<meta name="mobile-web-app-capable" content="yes">
<meta name="apple-mobile-web-app-title" content="Ruchi">
<meta name="apple-mobile-web-app-status-bar-style" content="default">
<meta name="theme-color" content="#FFFFFF" media="(prefers-color-scheme: light)">
<meta name="theme-color" content="#0B0B0C" media="(prefers-color-scheme: dark)">
<script>if(matchMedia('(display-mode: standalone)').matches||navigator.standalone)document.documentElement.classList.add('pwa');
if('serviceWorker' in navigator&&location.protocol==='https:'&&!(window.Capacitor&&window.Capacitor.isNativePlatform&&window.Capacitor.isNativePlatform()))addEventListener('load',()=>navigator.serviceWorker.register('sw.js').catch(()=>{}));</script>`;
html = html.replace('</head>', pwaHead + '\n</head>');

// 4) adapter scripts before the app script
const inject = '<script src="config.js"></script>\n<script src="supabase.js"></script>\n<script src="seed.js"></script>\n<script src="ruchi-native.js"></script>\n';
const i = html.indexOf('<script>');
if (i < 0) throw new Error('App <script> not found in web/index.html');
html = html.slice(0, i) + inject + html.slice(i);

fs.writeFileSync(path.join(www, 'index.html'), html);
for (const f of ['config.js', 'seed.js', 'ruchi-native.js']) fs.copyFileSync(path.join(root, 'src', f), path.join(www, f));
// Supabase client (cloud mode) — bundled, so the app never loads code from the internet
fs.copyFileSync(path.join(root, 'node_modules/@supabase/supabase-js/dist/umd/supabase.js'), path.join(www, 'supabase.js'));
// web app files: manifest, icons, offline service worker
fs.mkdirSync(path.join(www, 'icons'), { recursive: true });
for (const f of ['icon-192.png', 'icon-512.png', 'icon-maskable-512.png', 'apple-touch-icon.png']) fs.copyFileSync(path.join(root, 'assets', 'web', f), path.join(www, 'icons', f));
fs.writeFileSync(path.join(www, 'manifest.webmanifest'), JSON.stringify({
  name: 'Ruchi — Trivandrum’s hidden food map', short_name: 'Ruchi', id: './', start_url: './', scope: './',
  display: 'standalone', orientation: 'portrait', background_color: '#FFFFFF', theme_color: '#FFFFFF',
  icons: [
    { src: 'icons/icon-192.png', sizes: '192x192', type: 'image/png' },
    { src: 'icons/icon-512.png', sizes: '512x512', type: 'image/png' },
    { src: 'icons/icon-maskable-512.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' }
  ]
}, null, 2));
const shell = ['./', 'index.html', 'config.js', 'supabase.js', 'seed.js', 'ruchi-native.js', 'manifest.webmanifest',
  ...fs.readdirSync(path.join(www, 'fonts')).map((f) => 'fonts/' + f), 'icons/apple-touch-icon.png', 'icons/icon-192.png'];
const ver = require('crypto').createHash('sha1').update(html + fs.readFileSync(path.join(root, 'src', 'ruchi-native.js'))).digest('hex').slice(0, 10);
fs.writeFileSync(path.join(www, 'sw.js'), `/* Ruchi offline cache — app files load from the phone; updates arrive next launch. */
const C='ruchi-${ver}',SHELL=${JSON.stringify(shell)};
self.addEventListener('install',e=>{e.waitUntil(caches.open(C).then(c=>c.addAll(SHELL)).then(()=>self.skipWaiting()))});
self.addEventListener('activate',e=>{e.waitUntil(caches.keys().then(ks=>Promise.all(ks.filter(k=>k!==C).map(k=>caches.delete(k)))).then(()=>self.clients.claim()))});
self.addEventListener('fetch',e=>{const u=new URL(e.request.url);if(e.request.method!=='GET'||u.origin!==location.origin)return;
  e.respondWith(fetch(e.request).then(r=>{if(r.ok){const cp=r.clone();caches.open(C).then(c=>c.put(e.request,cp))}return r}).catch(()=>caches.match(e.request,{ignoreSearch:true}).then(r=>r||caches.match('index.html'))))});
`);
console.log('✓ www/ built —', (html.length / 1024).toFixed(0), 'KB');
