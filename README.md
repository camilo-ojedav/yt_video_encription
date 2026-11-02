# yt_video_encription

Videos cifrados subidos a YouTube que solo se ven y se oyen bien en la web, con una clave secreta.

- **En YouTube**, la imagen es un mosaico de celdas de 18 px barajadas, con la mitad invertidas en color, y el audio es ruido: es su espectrograma barajado. Las dos cosas dependen de la clave.
- **En la web** (`web/`, desplegada en https://video.shard.icu), la clave rehace la permutación y la inversión. El video de YouTube se reconstruye en vivo con un `backdrop-filter` SVG (dos `feDisplacementMap`) y una máscara con `mix-blend-mode: difference`. El audio real se descifra con AES-256-GCM desde `web/media/<nombre>.audio.bin` y suena sincronizado con el video.

La clave no sale del navegador ni se guarda en el repositorio. Si la clave es incorrecta, AES-GCM lo detecta y la página no muestra nada.

## Por qué el audio no se descifra desde YouTube

Una página no puede leer el audio ni los píxeles de un iframe de YouTube, porque es de otro origen. La imagen sí se puede reordenar, porque los filtros CSS se aplican sobre el iframe sin leerlo. El audio no tiene un equivalente. Por eso el audio de YouTube va irreconocible y el bueno viaja cifrado en la web.

## Cifrar un tramo

```
cd encoder
pip install -r requirements.txt
python encode.py entrada.mp4 INICIO DURACION clave.env salida.mp4 ../web/media NOMBRE "Título"
```

Después, añade `{"pkg": "NOMBRE.json", "title": "...", "youtube": "<link>"}` a `web/media/videos.json`.

## Ver

`https://video.shard.icu/?p=NOMBRE&yt=<id de YouTube>`. Pega la clave y pulsa «Descifrar y cargar». También puedes abrir el `.mp4` cifrado local en vez de YouTube.

- La imagen sale limpia a escala 1:1 o mayor (usa F para pantalla completa). En una ventana más pequeña aparece una rejilla tenue.
- `?pad=120`: úsalo si se ve la interfaz de YouTube.
- `#k=<clave>`: pasa la clave en el fragmento de la URL, que no llega al servidor.

## Pruebas

- `node tests/parity.mjs web/media/lain1.json clave.env`: comprueba que JS y Python generan las mismas tablas y que el audio se descifra.
- `node tests/e2e.mjs http://localhost:PUERTO/ clave.env video.mp4 salida/`: hace una prueba en Chrome headless.

## Despliegue

Es un sitio estático: la raíz es `web/`. Hay un ejemplo de configuración de nginx en `deploy/`.
