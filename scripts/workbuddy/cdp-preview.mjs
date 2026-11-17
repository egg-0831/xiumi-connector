// cdp-preview.mjs — 用 Chrome/Edge DevTools Protocol 抓秀米预览的真实渲染。
//
// 为什么需要它：官方 get_show_edit_spec 的展示层会把段落换行去掉，光看接口返回
// 判断不出「\n 是否真的变成了多个 <p>」。只有真实渲染 DOM 和截图可信。
//
// 用法：
//   msedge --headless=new --remote-debugging-port=9333 --user-data-dir="$TEMP/xiumi-cdp"
//   node scripts/workbuddy/cdp-preview.mjs \
//     --url "<预览链接>" --ready "<正文标志词>" --out ./preview
//
// 需要 Node >= 22（使用内置 WebSocket），零第三方依赖。

import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';

function parseArgs(argv) {
  const args = {
    url: '',
    ready: '',
    out: './preview',
    width: 420,
    height: 900,
    port: 9333,
    wait: 30,
    screens: 12,
  };
  for (let i = 0; i < argv.length; i++) {
    const k = argv[i];
    if (!k.startsWith('--')) continue;
    const v = argv[i + 1];
    if (v === undefined || v.startsWith('--')) continue;
    if (k === '--url') args.url = v;
    else if (k === '--ready') args.ready = v;
    else if (k === '--out') args.out = v;
    else if (k === '--width') args.width = Number(v);
    else if (k === '--height') args.height = Number(v);
    else if (k === '--port') args.port = Number(v);
    else if (k === '--wait') args.wait = Number(v);
    else if (k === '--screens') args.screens = Number(v);
    i++;
  }
  return args;
}

const A = parseArgs(process.argv.slice(2));
if (!A.url) {
  console.error('缺少 --url：秀米预览链接');
  process.exit(1);
}
if (typeof WebSocket === 'undefined') {
  console.error('当前 Node 没有内置 WebSocket，请用 Node >= 22');
  process.exit(1);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function httpJson(reqPath) {
  return new Promise((resolve, reject) => {
    http
      .get({ host: '127.0.0.1', port: A.port, path: reqPath }, (res) => {
        let body = '';
        res.on('data', (c) => (body += c));
        res.on('end', () => {
          try {
            resolve(JSON.parse(body));
          } catch (e) {
            reject(e);
          }
        });
      })
      .on('error', reject);
  });
}

const targets = await httpJson('/json');
const page = targets.find((t) => t.type === 'page');
if (!page) {
  console.error(`端口 ${A.port} 上没有可调试的 page，请检查浏览器启动参数`);
  process.exit(1);
}

const ws = new WebSocket(page.webSocketDebuggerUrl);
let seq = 0;
const pending = new Map();

function send(method, params = {}) {
  return new Promise((resolve, reject) => {
    const id = ++seq;
    pending.set(id, { resolve, reject });
    ws.send(JSON.stringify({ id, method, params }));
    setTimeout(() => {
      if (pending.has(id)) {
        pending.delete(id);
        reject(new Error(`CDP timeout: ${method}`));
      }
    }, 30000);
  });
}

ws.onmessage = (ev) => {
  const msg = JSON.parse(ev.data);
  if (msg.id && pending.has(msg.id)) {
    const p = pending.get(msg.id);
    pending.delete(msg.id);
    msg.error ? p.reject(new Error(JSON.stringify(msg.error))) : p.resolve(msg.result);
  }
};
await new Promise((resolve, reject) => {
  ws.onopen = resolve;
  ws.onerror = reject;
});

await send('Page.enable');
await send('Runtime.enable');
await send('Emulation.setDeviceMetricsOverride', {
  width: A.width,
  height: A.height,
  deviceScaleFactor: 2,
  mobile: true,
});
await send('Page.navigate', { url: A.url });

let ready = false;
for (let i = 0; i < A.wait; i++) {
  await sleep(1000);
  const r = await send('Runtime.evaluate', {
    expression: 'document.body ? document.body.innerText : ""',
    returnByValue: true,
  });
  const text = r.result.value || '';
  if (A.ready ? text.includes(A.ready) : text.length > 200) {
    console.log(`READY at ${i + 1}s, textlen=${text.length}`);
    ready = true;
    break;
  }
  if (i % 5 === 4) console.log(`waiting ${i + 1}s, textlen=${text.length}`);
}
if (!ready) console.warn('未在等待时间内命中 --ready，继续抓取（可能页面未加载完）');

const geomExpr = `(function(){
  const out = {pageHeight: document.documentElement.scrollHeight,
               viewport: window.innerHeight, images: [], texts: []};
  document.querySelectorAll('img').forEach(function(im){
    const r = im.getBoundingClientRect();
    if (r.width > 0) out.images.push({
      src: (im.src || '').split('/').pop().slice(0, 60),
      w: Math.round(r.width), h: Math.round(r.height),
      top: Math.round(r.top + window.scrollY),
      natural: im.naturalWidth + 'x' + im.naturalHeight
    });
  });
  document.querySelectorAll('p').forEach(function(p){
    const r = p.getBoundingClientRect();
    if (r.width > 0) out.texts.push({
      t: (p.textContent || '').slice(0, 40),
      w: Math.round(r.width), h: Math.round(r.height),
      top: Math.round(r.top + window.scrollY),
      fs: getComputedStyle(p).fontSize,
      lh: getComputedStyle(p).lineHeight
    });
  });
  return JSON.stringify(out);
})()`;

const geom = await send('Runtime.evaluate', { expression: geomExpr, returnByValue: true });
const data = JSON.parse(geom.result.value || '{}');
const outDir = path.resolve(A.out);
fs.mkdirSync(outDir, { recursive: true });
fs.writeFileSync(path.join(outDir, 'geometry.json'), JSON.stringify(data, null, 2));
console.log(`geometry: ${data.pageHeight}px, imgs=${data.images.length}, p=${data.texts.length}`);

const full = await send('Page.captureScreenshot', {
  format: 'png',
  captureBeyondViewport: true,
});
fs.writeFileSync(path.join(outDir, 'full.png'), Buffer.from(full.data, 'base64'));
console.log(`full.png written`);

const total = data.pageHeight || A.height;
let idx = 0;
for (let y = 0; y < total && idx < A.screens; y += A.height) {
  await send('Runtime.evaluate', { expression: `window.scrollTo(0,${y})` });
  await sleep(500);
  const shot = await send('Page.captureScreenshot', { format: 'png' });
  const name = `screen-${String(idx).padStart(2, '0')}.png`;
  fs.writeFileSync(path.join(outDir, name), Buffer.from(shot.data, 'base64'));
  idx++;
}
console.log(`screens: ${idx} -> ${outDir}`);
ws.close();
