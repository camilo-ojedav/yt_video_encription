import { geometry, derive, decryptAudio, keyTables, makeMaps, makeInvMask } from './cipher.js';

const $ = id => document.getElementById(id), sleep = ms => new Promise(r => setTimeout(r, ms)), say = t => $('st').textContent = t;
const Q = new URLSearchParams(location.search);
const idOf = s => (s.match(/(?:v=|youtu\.be\/|embed\/|shorts\/)([\w-]{11})/) || [, /^[\w-]{11}$/.test(s.trim()) ? s.trim() : ''])[1];
// Tras cada arranque o salto YouTube sirve ~4 s de peor calidad: los videos traen pkg.lead s de colchon y al reanudar se retrocede REWIND s.
const REWIND = +(Q.get('rewind') ?? 5);
// PAD: px fisicos de banda recortada arriba y abajo para ocultar la interfaz de YouTube (?pad=120 si aparece el titulo).
const PAD = +(Q.get('pad') ?? 0);
let pkg = null, g = null, maps = null, audioBuf = null, actx = null, gain = null, P = null, geo = { s: 1 };
let ytReady = false; window.onYouTubeIframeAPIReady = () => { ytReady = true; };

/* ---------- lista de videos ---------- */
const list = await (await fetch('media/videos.json', { cache: 'no-cache' })).json();
for (const v of list) $('pkg').add(new Option(v.title, v.pkg));
if (Q.get('p')) $('pkg').value = Q.get('p') + '.json';
const entry = () => list.find(v => v.pkg === $('pkg').value) || list[0];
const fillYt = () => { $('yt').value = Q.get('yt') || entry().youtube || ''; $('title').textContent = entry().title; };
$('pkg').onchange = fillYt; fillYt();
const hashKey = new URLSearchParams(location.hash.slice(1)).get('k');
try { $('key').value = hashKey || localStorage.getItem('ytenc-key') || ''; $('remember').checked = !!localStorage.getItem('ytenc-key'); } catch {}
if (hashKey) history.replaceState(null, '', location.pathname + location.search);   // que la clave no quede en la barra

/* ---------- geometria: el video (1280x720) 1:1 sobre pixeles FISICOS; solo se reduce si no cabe (y entonces sale una rejilla tenue) ---------- */
function toDataURL(rgba, w, h, devW, devH) {
  const c = document.createElement('canvas'); c.width = w; c.height = h; c.getContext('2d').putImageData(new ImageData(rgba, w, h), 0, 0);
  if (devW === w && devH === h) return c.toDataURL();
  const d = document.createElement('canvas'); d.width = devW; d.height = devH; const x = d.getContext('2d');
  x.imageSmoothingEnabled = false; x.drawImage(c, 0, 0, devW, devH); return d.toDataURL();
}
function layout() {
  const VW = g?.W ?? 1280, VH = g?.H ?? 720;
  const fs = document.fullscreenElement === $('wrap'), D = window.devicePixelRatio || 1;
  const avail = fs ? $('wrap').clientWidth : document.documentElement.clientWidth, availH = fs ? $('wrap').clientHeight : Infinity;
  const natW = VW / D, natH = VH / D, padC = PAD / D;
  const hFull = fs ? availH : window.innerHeight, hCtl = fs ? availH : Math.max(300, window.innerHeight - 190);
  const sCtl = Math.min(avail * D / VW, hCtl * D / VH, 3), sFull = Math.min(avail * D / VW, hFull * D / VH, 3);
  const s = +(Q.get('s') || 0) || (sCtl >= 1 ? sCtl : (sFull >= 1 ? 1 : sFull));
  const devW = Math.round(VW * s), devH = Math.round(VH * s), cw = devW / D, ch = devH / D;
  geo = { s, w: natW, h: natH + 2 * padC };
  const box = $('box'); box.style.width = cw + 'px'; box.style.height = ch + 'px';
  box.style.marginLeft = Math.max(0, Math.round(((avail - cw) / 2) * D) / D) + 'px';
  box.style.marginTop = fs ? Math.max(0, Math.round(((availH - ch) / 2) * D) / D) + 'px' : '0';
  const sc = $('scaler'); sc.style.width = natW + 'px'; sc.style.height = natH + 'px'; sc.style.transform = 'scale(' + s + ')';
  const el = $('layer').firstElementChild;
  if (el && el.tagName === 'IFRAME') { P?.setSize?.(geo.w, geo.h); el.style.width = geo.w + 'px'; el.style.height = geo.h + 'px'; el.style.marginTop = -padC + 'px'; }
  if (el && el.tagName === 'VIDEO') { el.style.width = natW + 'px'; el.style.height = natH + 'px'; }
  $('fx').style.width = cw + 'px'; $('fx').style.height = ch + 'px';
  if (!g) return;
  const v = $('view'); v.style.left = (g.X0 / VW * cw) + 'px'; v.style.top = (g.Y0 / VH * ch) + 'px'; v.style.width = (g.OW / VW * cw) + 'px'; v.style.height = (g.OH / VH * ch) + 'px';
  if (!maps) return;
  const f = $('unshuffle'); for (const [a, x] of [['x', 0], ['y', 0], ['width', cw], ['height', ch]]) f.setAttribute(a, x);
  [[1, maps.m1, maps.scale1], [2, maps.m2, maps.scale2]].forEach(([i, m, sc2]) => {
    const im = $('fmap' + i); for (const [a, x] of [['x', 0], ['y', 0], ['width', cw], ['height', ch]]) im.setAttribute(a, x);
    const key = devW + 'x' + devH; if (im.dataset.k !== key) { im.setAttribute('href', toDataURL(m, VW, VH, devW, devH)); im.dataset.k = key; }
    $('fdisp' + i).setAttribute('scale', sc2 * s / D);
  });
  $('warn').textContent = s < 0.999 ? `Ventana pequeña: el video se reduce a ${Math.round(s * 100)} % y puede aparecer una rejilla. Pulsa F o agranda la ventana (${Math.ceil(VW / D)} × ${Math.ceil(VH / D)} px) para verlo limpio.`
    : D > 2.6 ? `Zoom ${Math.round(D * 100)} %: demasiado alto, puede aparecer una rejilla.` : '';
}
addEventListener('resize', layout); document.addEventListener('fullscreenchange', layout); layout();
const toggleFs = () => document.fullscreenElement ? document.exitFullscreen() : $('wrap').requestFullscreen().catch(e => say('Pantalla completa no disponible: ' + e.message));
$('btnFs').onclick = toggleFs;
addEventListener('keydown', e => {
  if (e.target.tagName === 'INPUT' && e.target.type !== 'checkbox' && e.target.type !== 'range') return;
  if (e.key === 'f' || e.key === 'F') toggleFs();
  if (e.key === ' ') { e.preventDefault(); if (!$('btnPlay').disabled) (timer ? $('btnPause') : $('btnPlay')).click(); }
});

/* ---------- reproductores: YouTube o archivo local, con la misma interfaz ---------- */
function ytPlayer(id) {
  return new Promise(async (res, rej) => {
    for (let i = 0; !ytReady && i < 100; i++) await sleep(100);
    if (!ytReady) return rej(new Error('no cargó la API de YouTube'));
    $('layer').innerHTML = '<div id="player"></div>';
    const y = new YT.Player('player', {
      width: geo.w, height: geo.h, videoId: id,
      playerVars: { controls: 0, disablekb: 1, rel: 0, modestbranding: 1, playsinline: 1, fs: 0, iv_load_policy: 3, cc_load_policy: 0, vq: 'hd720' },
      events: {
        onReady: () => { y.mute(); layout(); res({
          play: () => { y.setPlaybackQuality?.('hd720'); y.playVideo(); }, pause: () => y.pauseVideo(), seek: t => y.seekTo(t, true),
          time: () => y.getCurrentTime(), dur: () => y.getDuration(), rate: r => y.setPlaybackRate(r),
          playing: () => y.getPlayerState() === 1, buffered: () => y.getVideoLoadedFraction() * y.getDuration(), setSize: (w, h) => y.setSize(w, h),
        }); },
        onError: e => rej(new Error('YouTube error ' + e.data)),
      },
    });
  });
}
function filePlayer(file) {
  $('layer').innerHTML = '';
  const v = document.createElement('video'); v.muted = true; v.playsInline = true; v.preload = 'auto'; v.src = URL.createObjectURL(file);
  $('layer').append(v); layout();
  return new Promise(res => v.addEventListener('loadeddata', () => res({
    play: () => v.play(), pause: () => v.pause(), seek: t => { v.currentTime = t; }, time: () => v.currentTime, dur: () => v.duration,
    rate: r => { v.playbackRate = r; }, playing: () => !v.paused && !v.ended && v.readyState > 2,
    buffered: () => v.duration,
  }), { once: true }));
}

/* ---------- desbloqueo ---------- */
let localFile = null;
$('file').onchange = e => { localFile = e.target.files[0] || null; if (localFile) say('Archivo elegido: ' + localFile.name + '. Ahora pulsa «Descifrar y cargar».'); };
$('unlock').onsubmit = async e => {
  e.preventDefault();
  const key = $('key').value.trim(), ytId = idOf($('yt').value);
  if (!key) return say('Falta la clave.');
  if (!localFile && !ytId) return say('Falta el link de YouTube (o abre el .mp4 cifrado).');
  $('btnUnlock').disabled = true; stopAll();
  try {
    say('Descargando paquete…');
    pkg = await (await fetch('media/' + $('pkg').value)).json(); g = geometry(pkg.grid);
    const blob = await (await fetch('media/' + pkg.audio)).arrayBuffer();
    say('Derivando la clave…');
    const { kaud, kperm } = await derive(key, pkg.salt, pkg.iter);
    let plain; try { plain = await decryptAudio(kaud, blob); } catch { throw new Error('Clave incorrecta.'); }
    try { if ($('remember').checked) localStorage.setItem('ytenc-key', key); else localStorage.removeItem('ytenc-key'); } catch {}
    actx ??= new AudioContext(); gain ??= actx.createGain(); gain.connect(actx.destination); setVol();
    audioBuf = await actx.decodeAudioData(plain);
    const tables = await keyTables(kperm, pkg.bars, g);
    maps = makeMaps(tables, g);
    $('inv').getContext('2d').putImageData(new ImageData(makeInvMask(tables, g), g.W, g.H), 0, 0);
    $('fx').classList.toggle('on', $('fxToggle').checked);
    $('fmap1').dataset.k = $('fmap2').dataset.k = '';
    say('Cargando video…');
    P = localFile ? await filePlayer(localFile) : await ytPlayer(ytId);
    layout();
    if (!localFile) await prebuffer();
    P.seek(0); P.pause(); await sleep(400);
    $('veil').classList.add('off');
    $('btnPlay').disabled = $('btnPause').disabled = false;
    say('Listo. Pulsa Reproducir (o Espacio).');
  } catch (err) { say(err.message || String(err)); }
  $('btnUnlock').disabled = false;
};

// Bufferiza todo el tramo (en silencio y a 2x) para que no haya paradas.
async function prebuffer() {
  P.rate(2); P.play();
  const t0 = Date.now();
  while (Date.now() - t0 < 90000) {
    const d = P.dur(); if (d > 0 && (P.buffered() >= d - 0.5 || P.time() >= d - 1)) break;
    say('Bufferizando… ' + P.time().toFixed(1) + ' s'); await sleep(250);
  }
  P.pause(); P.rate(1);
}

/* ---------- reproduccion: el audio descifrado (Web Audio) sigue al video ---------- */
let timer = 0, src = null, srcT0 = 0, hist = [], holdUntil = 0, pausedAt = null;
function stopAudio() { if (src) { try { src.stop(); } catch {} src.disconnect(); src = null; } }
function startAudio(vt) {
  stopAudio();
  const pos = vt - pkg.lead; if (pos >= audioBuf.duration) return;
  src = actx.createBufferSource(); src.buffer = audioBuf; src.connect(gain);
  const now = actx.currentTime;
  if (pos >= 0) src.start(now, pos); else src.start(now - pos, 0);
  srcT0 = now - pos;                                   // instante (reloj de audio) en que sonaria la muestra 0
  hist = []; holdUntil = Date.now() + 800;
}
function stopAll() { clearInterval(timer); timer = 0; stopAudio(); try { P?.pause(); } catch {} }

$('btnPlay').onclick = async () => {
  clearInterval(timer); await actx.resume();
  const from = pausedAt == null ? 0 : Math.max(0, pausedAt - REWIND); pausedAt = null;
  P.rate(1); P.seek(from); P.play();
  const t0 = Date.now(); while (Date.now() - t0 < 8000 && !P.playing()) await sleep(20);
  timer = setInterval(control, 100);
};
$('btnPause').onclick = () => { if (timer) pausedAt = P.time(); stopAll(); say('Pausado en ' + (pausedAt ?? 0).toFixed(1) + ' s. Al reanudar retrocede ' + REWIND + ' s.'); };

function control() {
  const vt = P.time(), d = P.dur();
  if (d > 0 && vt >= d - 0.2) { stopAll(); P.seek(0); pausedAt = null; return say('Fin. Pulsa Reproducir para verlo otra vez.'); }
  if (!P.playing()) { stopAudio(); return say('Cargando… ' + vt.toFixed(1) + ' s'); }
  if (!src) startAudio(vt);
  else if (Date.now() > holdUntil) {
    hist.push(actx.currentTime - srcT0 - (vt - pkg.lead)); if (hist.length > 7) hist.shift();
    const m = [...hist].sort((a, b) => a - b)[hist.length >> 1];
    if (hist.length >= 5 && Math.abs(m) > 0.07) startAudio(vt);       // desfase audio-video > 70 ms: se recoloca el audio
  }
  say((vt < pkg.lead ? 'Colchón inicial… ' : '') + vt.toFixed(1) + ' / ' + (d - pkg.lead).toFixed(0) + ' s');
}
function setVol() { if (gain) gain.gain.value = (+$('vol').value / 100) ** 2; }
$('vol').oninput = setVol;
$('fxToggle').onchange = e => { $('fx').classList.toggle('on', e.target.checked); $('inv').style.display = e.target.checked ? '' : 'none'; };
window.__dbg = { get P() { return P; }, get src() { return src; } };
