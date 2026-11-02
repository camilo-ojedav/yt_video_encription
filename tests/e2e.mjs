// Prueba en Chrome headless: abre la web, mete la clave y el .mp4 cifrado local, reproduce, pausa y captura.
// Uso: node tests/e2e.mjs http://localhost:PUERTO/ clave.env video.mp4 salida_dir
import { spawn } from 'node:child_process';
import { readFileSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
const [url, keyPath, mp4, out] = process.argv.slice(2);
mkdirSync(out, { recursive: true });
const sleep = ms => new Promise(r => setTimeout(r, ms)), PORT = 9341;
const chrome = spawn('C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe', ['--headless=new', `--remote-debugging-port=${PORT}`,
  `--user-data-dir=${mkdtempSync(path.join(tmpdir(), 'cdp-'))}`, '--autoplay-policy=no-user-gesture-required', '--window-size=1400,1000', '--hide-scrollbars', 'about:blank'], { stdio: 'ignore' });
let t; for (let i = 0; i < 40; i++) { try { t = await (await fetch(`http://127.0.0.1:${PORT}/json`)).json(); if (t.length) break; } catch {} await sleep(250); }
const ws = new WebSocket(t.find(x => x.type === 'page').webSocketDebuggerUrl); await new Promise(r => ws.onopen = r);
let id = 0; const pend = {}; const logs = [];
ws.onmessage = m => { const d = JSON.parse(m.data); if (d.id && pend[d.id]) { pend[d.id](d); delete pend[d.id]; } if (d.method === 'Runtime.exceptionThrown' || d.method === 'Runtime.consoleAPICalled') logs.push(JSON.stringify(d.params).slice(0, 300)); };
const send = (method, params = {}) => new Promise(r => { const i = ++id; pend[i] = r; ws.send(JSON.stringify({ id: i, method, params })); });
const ev = async e => (await send('Runtime.evaluate', { expression: e, returnByValue: true, awaitPromise: true })).result?.result?.value;
const shot = async n => writeFileSync(path.join(out, n + '.png'), Buffer.from((await send('Page.captureScreenshot', { format: 'png' })).result.data, 'base64'));
await send('Page.enable'); await send('Runtime.enable'); await send('DOM.enable');
await send('Emulation.setDeviceMetricsOverride', { width: 1400, height: 1000, deviceScaleFactor: 1, mobile: false });
await send('Page.navigate', { url }); await sleep(2500);
const doc = await send('DOM.getDocument'); const q = await send('DOM.querySelector', { nodeId: doc.result.root.nodeId, selector: '#file' });
await send('DOM.setFileInputFiles', { nodeId: q.result.nodeId, files: [path.resolve(mp4)] });
await ev(`document.getElementById('key').value=${JSON.stringify(readFileSync(keyPath, 'utf8').trim())}; document.getElementById('file').dispatchEvent(new Event('change'))`);
await ev(`document.getElementById('btnUnlock').click()`);
const st = () => ev(`document.getElementById('st').textContent`);
for (let i = 0; i < 120; i++) { const s = await st(); if (/Listo|incorrecta|error|Falta/i.test(s)) break; await sleep(250); }
console.log('estado:', await st());
await ev(`document.getElementById('btnPlay').click()`);
await sleep(+(process.env.WAIT || 9000));
console.log('audio activo:', await ev('!!__dbg.src'), '| t', await ev('__dbg.P.time()'));
await ev(`document.getElementById('btnPause').click()`); await sleep(600);
console.log('pausado en', await ev('__dbg.P.time()'));
await shot('dec');
await ev(`document.getElementById('fxToggle').click()`); await sleep(400); await shot('raw');
const r = await ev(`(()=>{const b=document.getElementById('box').getBoundingClientRect(), v=document.getElementById('view').getBoundingClientRect(); return {bx:b.left,by:b.top,vx:v.left,vy:v.top,vw:v.width,vh:v.height,t:__dbg.P.time()}})()`);
writeFileSync(path.join(out, 'meta.json'), JSON.stringify(r));
console.log(r, logs.join('\n'));
ws.close(); chrome.kill(); process.exit(0);
