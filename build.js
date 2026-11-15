/*
 * Builds www/ for the Android app from the Ruchi web prototype.
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

// 2) adapter scripts before the app script
const inject = '<script src="config.js"></script>\n<script src="seed.js"></script>\n<script src="ruchi-native.js"></script>\n';
const i = html.indexOf('<script>');
if (i < 0) throw new Error('App <script> not found in web/index.html');
html = html.slice(0, i) + inject + html.slice(i);

fs.writeFileSync(path.join(www, 'index.html'), html);
for (const f of ['config.js', 'seed.js', 'ruchi-native.js']) fs.copyFileSync(path.join(root, 'src', f), path.join(www, f));
console.log('✓ www/ built —', (html.length / 1024).toFixed(0), 'KB');
