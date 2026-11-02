// Igual que encoder/cipher.py (tests/parity.mjs comprueba que dan las mismas tablas). Funciona en el navegador y en Node (WebCrypto).
const subtle = globalThis.crypto.subtle;
export const ZX = [29, 35], ZY = [15, 21];                     // zona central [desde, hasta) tapada con negro (interfaz de YouTube)
export const inZone = (x, y) => x >= ZX[0] && x < ZX[1] && y >= ZY[0] && y < ZY[1];
const b64 = s => Uint8Array.from(atob(s), ch => ch.charCodeAt(0));

export function geometry(grid) {
  const { W, H, PITCH, C, G } = grid, NX = W / PITCH, NY = H / PITCH, OW = NX * C, OH = NY * C;
  return { W, H, PITCH, C, G, NX, NY, OW, OH, X0: (((W - OW) / 2) >> 1) << 1, Y0: (((H - OH) / 2) >> 1) << 1, K1: 40, K2: PITCH - C };
}

/** clave (texto) + sal -> { kaud: CryptoKey AES-GCM, kperm: bytes } */
export async function derive(key, saltB64, iter) {
  const base = await subtle.importKey('raw', new TextEncoder().encode(key), 'PBKDF2', false, ['deriveBits']);
  const bits = new Uint8Array(await subtle.deriveBits({ name: 'PBKDF2', hash: 'SHA-256', salt: b64(saltB64), iterations: iter }, base, 512));
  const kaud = await subtle.importKey('raw', bits.slice(0, 32), 'AES-GCM', false, ['decrypt']);
  return { kaud, kperm: bits.slice(32) };
}

export async function decryptAudio(kaud, blob) {
  const u = new Uint8Array(blob);
  return subtle.decrypt({ name: 'AES-GCM', iv: u.slice(0, 12), additionalData: new TextEncoder().encode('ytenc-v1') }, kaud, u.slice(12));
}

async function rng(kperm, n) {
  const k = await subtle.importKey('raw', kperm, 'AES-CTR', false, ['encrypt']);
  const buf = await subtle.encrypt({ name: 'AES-CTR', counter: new Uint8Array(16), length: 64 }, k, new Uint8Array(4 * n));
  const dv = new DataView(buf); let i = 0;
  const r = { u32: () => dv.getUint32(4 * i++, true) };
  r.below = n => r.u32() % n;
  r.shuffle = a => { for (let i = a.length - 1; i > 0; i--) { const j = r.below(i + 1); [a[i], a[j]] = [a[j], a[i]]; } };
  return r;
}

/** -> { perm: Int16Array [by*NX+bx] = indice de celda de imagen, inv: Uint8Array [by*NX+bx] = bits RGB a invertir } */
export async function keyTables(kperm, barsB64, g) {
  const { NX, NY } = g, N = NX * NY;
  const bitsArr = b64(barsB64), bar = i => (bitsArr[i >> 3] >> (7 - (i & 7))) & 1;
  const r = await rng(kperm, 4 * N);
  const perm = new Int16Array(N).fill(-1);
  for (const [px, py] of [[0, 0], [1, 0], [0, 1], [1, 1]]) {
    const outs = [], srcs = [];
    for (let by = 0; by < NY; by++) for (let bx = 0; bx < NX; bx++) {
      if (bx % 2 === px && by % 2 === py) outs.push(by * NX + bx);
      if (bx % 2 !== px && by % 2 !== py) srcs.push(by * NX + bx);
    }
    const isZ = i => inZone(i % NX, (i / NX) | 0);
    const zs = outs.filter(isZ), blk = srcs.filter(bar);
    r.shuffle(blk);
    if (blk.length < zs.length) throw new Error('faltan celdas negras');
    const used = new Set(blk.slice(0, zs.length));
    zs.forEach((z, i) => perm[z] = blk[i]);
    const restOut = outs.filter(i => !isZ(i)), restSrc = srcs.filter(i => !used.has(i));
    r.shuffle(restSrc);
    restOut.forEach((o, i) => perm[o] = restSrc[i]);
  }
  const inv = new Uint8Array(N);
  for (let i = 0; i < N; i++) inv[i] = (r.u32() & 1) * 7;   // los 3 canales o ninguno (ver cipher.py)
  for (let i = 0; i < N; i++) if (inZone(i % NX, (i / NX) | 0)) inv[i] = 0;
  return { perm, inv };
}

export async function tableDigest({ perm, inv }, g) {
  const parts = [];
  for (let i = 0; i < perm.length; i++) parts.push(`${perm[i] % g.NX}:${(perm[i] / g.NX) | 0}:${inv[i]}`);
  const h = new Uint8Array(await subtle.digest('SHA-256', new TextEncoder().encode(parts.join(','))));
  return [...h].map(x => x.toString(16).padStart(2, '0')).join('');
}

/** Mapas RGBA (W x H) de los dos feDisplacementMap. map1: cada ventana de salida lee su celda de capa. map2: recorta el nucleo. */
export function makeMaps({ perm }, g) {
  const { W, H, PITCH, C, G, NX, NY, OW, OH, X0, Y0, K1, K2 } = g;
  const m1 = new Uint8ClampedArray(W * H * 4).fill(128), m2 = new Uint8ClampedArray(W * H * 4).fill(128);
  for (let i = 3; i < m1.length; i += 4) m1[i] = m2[i] = 255;
  const lev = (d, K) => { const r = (d + 127.5 * K) / K; if (Math.abs(r - Math.round(r)) > 1e-9 || r < 0 || r > 255) throw new Error('mapa'); return Math.round(r); };
  for (let t = 0; t < perm.length; t++) {             // celda de capa t contiene la celda de imagen perm[t] -> ventana perm[t] lee t
    const tx = t % NX, ty = (t / NX) | 0, cx = perm[t] % NX, cy = (perm[t] / NX) | 0;
    const R = lev((tx - cx) * PITCH, K1), Gc = lev((ty - cy) * PITCH, K1);
    for (let y = cy * PITCH; y < (cy + 1) * PITCH; y++) for (let x = cx * PITCH; x < (cx + 1) * PITCH; x++) { const p = 4 * (y * W + x); m1[p] = R; m1[p + 1] = Gc; }
  }
  for (let cx = 0; cx < NX; cx++) {
    const R = lev((PITCH - C) * cx + G - X0, K2);
    for (let y = Y0; y < Y0 + OH; y++) for (let x = X0 + cx * C; x < X0 + (cx + 1) * C; x++) m2[4 * (y * W + x)] = R;
  }
  for (let cy = 0; cy < NY; cy++) {
    const Gc = lev((PITCH - C) * cy + G - Y0, K2);
    for (let y = Y0 + cy * C; y < Y0 + (cy + 1) * C; y++) for (let x = X0; x < X0 + OW; x++) m2[4 * (y * W + x) + 1] = Gc;
  }
  return { m1, m2, scale1: K1 * 255, scale2: K2 * 255 };
}

/** Mascara de inversion (W x H RGBA): blanco en los canales a invertir de cada celda de capa. Se pone encima con mix-blend-mode:difference. */
export function makeInvMask({ inv }, g) {
  const { W, H, PITCH, NX } = g, m = new Uint8ClampedArray(W * H * 4);
  for (let t = 0; t < inv.length; t++) {
    const tx = t % NX, ty = (t / NX) | 0, v = inv[t];
    for (let y = ty * PITCH; y < (ty + 1) * PITCH; y++) for (let x = tx * PITCH; x < (tx + 1) * PITCH; x++) {
      const p = 4 * (y * W + x); m[p] = v & 1 ? 255 : 0; m[p + 1] = v & 2 ? 255 : 0; m[p + 2] = v & 4 ? 255 : 0; m[p + 3] = 255;
    }
  }
  return m;
}
