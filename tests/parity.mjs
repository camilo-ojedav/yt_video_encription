// Comprueba que web/cipher.js y encoder/cipher.py generan las mismas tablas y que el audio se descifra.
// Uso: node tests/parity.mjs web/media/lain1.json ruta/clave.env
import { readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { geometry, derive, keyTables, tableDigest, decryptAudio } from '../web/cipher.js';

const [pkgPath, keyPath] = process.argv.slice(2);
const pkg = JSON.parse(readFileSync(pkgPath, 'utf8')), key = readFileSync(keyPath, 'utf8').trim(), g = geometry(pkg.grid);
const { kaud, kperm } = await derive(key, pkg.salt, pkg.iter);
const js = await tableDigest(await keyTables(kperm, pkg.bars, g), g);
const py = execFileSync('python', ['-c', `
import sys, json, base64, numpy as np; sys.path.insert(0, 'encoder'); import cipher as c
p = json.load(open(sys.argv[1])); key = open(sys.argv[2], encoding='utf8').read().strip()
bars = np.unpackbits(np.frombuffer(base64.b64decode(p['bars']), np.uint8))[:c.NX*c.NY].reshape(c.NY, c.NX).astype(bool).tolist()
_, kperm = c.derive(key, base64.b64decode(p['salt']))
print(c.table_digest(*c.make_key_tables(kperm, bars)))`, pkgPath, keyPath]).toString().trim();
console.log('JS', js.slice(0, 16), '| PY', py.slice(0, 16), js === py ? 'OK' : 'DISTINTAS');
const audio = await decryptAudio(kaud, readFileSync(new URL('../web/media/' + pkg.audio, import.meta.url)));
console.log('audio descifrado:', audio.byteLength, 'bytes');
try { const bad = await derive(key + 'x', pkg.salt, pkg.iter); await decryptAudio(bad.kaud, readFileSync(new URL('../web/media/' + pkg.audio, import.meta.url))); console.log('ERROR: clave mala aceptada'); }
catch { console.log('clave incorrecta rechazada: OK'); }
if (js !== py) process.exit(1);
