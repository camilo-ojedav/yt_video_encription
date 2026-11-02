"""Cifrado compartido con web/cipher.js (deben dar EXACTAMENTE lo mismo; lo comprueba tests/parity.mjs).

Clave -> PBKDF2-HMAC-SHA256(clave, sal, ITER) -> 64 bytes:
  bytes  0..31  clave AES-256-GCM del audio
  bytes 32..63  clave AES-256-CTR cuyo flujo (contador 0, bloques de ceros) da los numeros aleatorios u32 little-endian que deciden
                la permutacion de celdas y la inversion de color de cada celda.

Geometria (igual que html_video_idea/tools/guard_common.py): video 1280x720 = 64x36 celdas de PITCH=20 px. Cada celda lleva C=18 px de
imagen + G=1 px de guarda por lado (repite el borde). Imagen reconstruida: 64x36 celdas de 18 px = 1152x648, centrada.
"""
import hashlib, struct
from cryptography.hazmat.primitives.ciphers import Cipher, algorithms, modes

W, H, PITCH, C, G = 1280, 720, 20, 18, 1
NX, NY = W // PITCH, H // PITCH
OW, OH = NX * C, NY * C
X0, Y0 = ((W - OW) // 2) // 2 * 2, ((H - OH) // 2) // 2 * 2
ZX, ZY = range(29, 35), range(15, 21)           # zona central del reproductor de YouTube (spinner / boton play): se tapa con negro
ZONE = {(x, y) for x in ZX for y in ZY}
ITER = 600_000
K1, K2 = 40, PITCH - C


def derive(key: str, salt: bytes):
    k = hashlib.pbkdf2_hmac('sha256', key.encode('utf8'), salt, ITER, 64)
    return k[:32], k[32:]


class Rng:
    """u32 del flujo AES-256-CTR (contador de 128 bits empezando en 0)."""
    def __init__(self, kperm: bytes, n_u32: int):
        enc = Cipher(algorithms.AES(kperm), modes.CTR(b'\0' * 16)).encryptor()
        self.buf = enc.update(b'\0' * (4 * n_u32)) + enc.finalize()
        self.i = 0

    def u32(self):
        v = struct.unpack_from('<I', self.buf, 4 * self.i)[0]
        self.i += 1
        return v

    def below(self, n):
        return self.u32() % n

    def shuffle(self, a):
        for i in range(len(a) - 1, 0, -1):
            j = self.below(i + 1)
            a[i], a[j] = a[j], a[i]


N_U32 = 4 * NX * NY                               # de sobra: barajar celdas negras + resto + inversiones


def make_key_tables(kperm: bytes, bars):
    """bars[by][bx] True si la celda de IMAGEN es siempre negra. Devuelve (perm, inv):
    perm[(bx,by)] = celda de imagen dentro de la celda de capa (bx,by). Desplazamientos = multiplos impares de PITCH (paridad opuesta,
    lo exige feDisplacementMap de 8 bits). La zona central solo recibe celdas negras.
    inv[by][bx] = 0 o 7 (bits R,G,B): 7 = celda de capa invertida (0 en la zona)."""
    rng = Rng(kperm, N_U32)
    perm = {}
    for px, py in ((0, 0), (1, 0), (0, 1), (1, 1)):
        outs = [(bx, by) for by in range(NY) for bx in range(NX) if bx % 2 == px and by % 2 == py]
        srcs = [(bx, by) for by in range(NY) for bx in range(NX) if bx % 2 != px and by % 2 != py]
        zs = [c for c in outs if c in ZONE]
        blk = [c for c in srcs if bars[c[1]][c[0]]]
        rng.shuffle(blk)
        assert len(blk) >= len(zs), 'faltan celdas negras para la zona central'
        used = blk[:len(zs)]
        perm.update(zip(zs, used))
        used = set(used)
        rest_out = [c for c in outs if c not in ZONE]
        rest_src = [c for c in srcs if c not in used]
        rng.shuffle(rest_src)
        perm.update(zip(rest_out, rest_src))
    assert len(set(perm.values())) == NX * NY
    inv = [[(rng.u32() & 1) * 7 for _ in range(NX)] for _ in range(NY)]   # invierte los 3 canales o ninguno (invertir canales sueltos tine los bordes de celda: croma 4:2:0)
    for x, y in ZONE:
        inv[y][x] = 0
    return perm, inv


def table_digest(perm, inv):
    """Huella para comparar con la version JS."""
    s = ','.join(f'{perm[(x, y)][0]}:{perm[(x, y)][1]}:{inv[y][x]}' for y in range(NY) for x in range(NX))
    return hashlib.sha256(s.encode()).hexdigest()
