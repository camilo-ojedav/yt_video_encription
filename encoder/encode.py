"""Cifra un tramo de video para subirlo a YouTube y reconstruirlo en la web con la clave.

Uso: python encode.py entrada.mp4 inicio duracion clave.env salida.mp4 web/media nombre "Titulo"

- Video (lo que se sube): la imagen (1152x648) se parte en celdas de 18 px con 1 px de guarda, las celdas se barajan con una permutacion
  derivada de la clave y cada celda invierte sus canales R/G/B segun la clave. Sin la clave es un mosaico de colores sin sentido.
- Audio del video subido: espectrograma barajado con la clave (bloques de tiempo y bandas de frecuencia): ruido irreconocible.
- Audio real: AAC cifrado con AES-256-GCM (clave derivada) en web/media/<nombre>.audio.bin. La web lo descifra y lo reproduce en
  sincronia con YouTube (el audio de un iframe de YouTube no es accesible desde la pagina, asi que no se puede descifrar en vivo).
- Paquete web/media/<nombre>.json: sal, parametros y mapa de celdas negras (necesario para rehacer la permutacion; no es secreto).
"""
import sys, os, json, base64, hashlib, subprocess, tempfile
import numpy as np
from scipy.signal import stft, istft
from cryptography.hazmat.primitives.ciphers.aead import AESGCM
import cipher as c

src, ss, dur, keyfile, out_mp4, media_dir, name, title = sys.argv[1:9]
FPS, SR, LEAD = 30, 44100, 4      # LEAD s de colchon (primer fotograma fijo + silencio): YouTube sirve ~4 s de peor calidad al arrancar
key = open(keyfile, encoding='utf8').read().strip()
salt = os.urandom(16)
kaud, kperm = c.derive(key, salt)
os.makedirs(media_dir, exist_ok=True)
os.makedirs(os.path.dirname(os.path.abspath(out_mp4)), exist_ok=True)
tmp = tempfile.mkdtemp()


def ff(*a, **kw):
    return subprocess.run(['ffmpeg', '-v', 'error', '-y', *a], check=True, **kw)


# ---- celdas de imagen siempre negras (las que pueden ir a la zona central tapada) ----
raw = ff('-ss', ss, '-t', dur, '-i', src, '-vf', f'fps=3,scale={c.OW}:{c.OH},format=gray', '-f', 'rawvideo', '-', capture_output=True).stdout
bars = np.frombuffer(raw, np.uint8).reshape(-1, c.OH, c.OW).max(0).reshape(c.NY, c.C, c.NX, c.C).max((1, 3)) < 40
perm, inv = c.make_key_tables(kperm, bars.tolist())
print('celdas negras:', int(bars.sum()), '| huella tablas', c.table_digest(perm, inv)[:16])

# ---- audio ----
raw = ff('-ss', ss, '-t', dur, '-i', src, '-vn', '-ac', '2', '-ar', str(SR), '-f', 'f32le', '-', capture_output=True).stdout
o = np.frombuffer(raw, np.float32).reshape(-1, 2)
# 1) audio real -> AAC -> AES-GCM
ff('-f', 'f32le', '-ar', str(SR), '-ac', '2', '-i', '-', '-c:a', 'aac', '-b:a', '192k', f'{tmp}/a.m4a', input=o.tobytes())
iv = os.urandom(12)
blob = iv + AESGCM(kaud).encrypt(iv, open(f'{tmp}/a.m4a', 'rb').read(), b'ytenc-v1')
open(f'{media_dir}/{name}.audio.bin', 'wb').write(blob)
# 2) audio que va en el video: espectrograma barajado con la clave
rng = np.random.default_rng(int.from_bytes(hashlib.sha256(kperm + b'audio').digest()[:8], 'little'))
f, t, Z = stft(o.T, SR, nperseg=1024, noverlap=768)
TB, GB = 96, 16                                   # bloques de 96 tramas (~0,56 s) y grupos de 16 bins (~690 Hz)
nf = Z.shape[2]
order = np.concatenate([b + rng.permutation(min(TB, nf - b)) for b in range(0, nf, TB)])
Z = Z[:, :, order]
ng = (Z.shape[1] - 1) // GB
gperm = rng.permutation(ng)
Z[:, 1:1 + ng * GB] = Z[:, 1:1 + ng * GB].reshape(2, ng, GB, nf)[:, gperm].reshape(2, ng * GB, nf)
_, y = istft(Z, SR, nperseg=1024, noverlap=768)
y = y.T[:len(o)]
y = (y / (np.abs(y).max() + 1e-9) * 0.5).astype(np.float32)
y = np.vstack([np.zeros((LEAD * SR, 2), np.float32), y])
ff('-f', 'f32le', '-ar', str(SR), '-ac', '2', '-i', '-', f'{tmp}/yt.wav', input=y.tobytes())

# ---- video ----
P = np.array([[perm[(bx, by)] for bx in range(c.NX)] for by in range(c.NY)])                      # [by,bx] -> (sx,sy)
INV = np.array(inv, np.uint8)
XOR = (((INV[..., None] >> np.arange(3)) & 1) * 255).astype(np.uint8)[:, :, None, None, :]       # (NY,NX,1,1,3)


def layer(img):
    cells = img.reshape(c.NY, c.C, c.NX, c.C, 3).transpose(0, 2, 1, 3, 4)
    pad = np.pad(cells, ((0, 0), (0, 0), (c.G, c.G), (c.G, c.G), (0, 0)), mode='edge')
    lay = pad[P[..., 1], P[..., 0]] ^ XOR
    for x, yy in c.ZONE:
        lay[yy, x] = 0
    return lay.transpose(0, 2, 1, 3, 4).reshape(c.H, c.W, 3)


enc = subprocess.Popen(['ffmpeg', '-v', 'error', '-y', '-f', 'rawvideo', '-pix_fmt', 'rgb24', '-s', f'{c.W}x{c.H}', '-r', str(FPS), '-i', '-',
                        '-i', f'{tmp}/yt.wav', '-vf', 'scale=out_color_matrix=bt709:out_range=tv,format=yuv420p',
                        '-c:v', 'libx264', '-preset', 'slow', '-crf', '12', '-colorspace', 'bt709', '-color_primaries', 'bt709',
                        '-color_trc', 'bt709', '-color_range', 'tv', '-c:a', 'aac', '-b:a', '256k', '-shortest', '-movflags', '+faststart',
                        out_mp4], stdin=subprocess.PIPE)
dec = subprocess.Popen(['ffmpeg', '-v', 'error', '-ss', ss, '-t', dur, '-i', src, '-an', '-vf', f'fps={FPS},scale={c.OW}:{c.OH}:flags=lanczos',
                        '-pix_fmt', 'rgb24', '-f', 'rawvideo', '-'], stdout=subprocess.PIPE)
FS = c.OW * c.OH * 3
n = 0
while True:
    buf = dec.stdout.read(FS)
    if len(buf) < FS:
        break
    L = layer(np.frombuffer(buf, np.uint8).reshape(c.OH, c.OW, 3)).tobytes()
    for _ in range(LEAD * FPS + 1 if n == 0 else 1):
        enc.stdin.write(L)
    n += 1
enc.stdin.close(); enc.wait()

bits = np.packbits(bars.astype(np.uint8).ravel())
json.dump({'version': 1, 'name': name, 'title': title, 'salt': base64.b64encode(salt).decode(), 'iter': c.ITER, 'lead': LEAD,
           'duration': n / FPS + LEAD, 'audio': f'{name}.audio.bin', 'bars': base64.b64encode(bits.tobytes()).decode(),
           'grid': {'W': c.W, 'H': c.H, 'PITCH': c.PITCH, 'C': c.C, 'G': c.G}},
          open(f'{media_dir}/{name}.json', 'w'), indent=1)
print('listo', n, 'fotogramas ->', out_mp4)
