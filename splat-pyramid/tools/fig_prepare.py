#!/usr/bin/env python3
"""
Figure: preparing an image, from the uploaded file to an image the server is serving, and
what each step is built out of.

Drawn from a real preparation: the pictures are the actual source, an actual tile and the
actual blobs of one unit, and every number comes from the preparation's log and the files it
wrote.

  python3 tools/fig_prepare.py PREPARED_DIR LOG SOURCE [--lang es] [--out docs/prepare.png]

LOG is the output of `ingest` then `build`, each run under /usr/bin/time -l.
"""

import argparse
import glob
import math
import os
import re
import struct
import sys

import numpy as np
from PIL import Image, ImageDraw

sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), ".."))
from figkit import BORROWED, DIM, INK, OURS, RULE, Sheet, band, card  # noqa: E402

W, H = 2400, 1560
Image.MAX_IMAGE_PIXELS = None

KEEP = ("server/admin.ts  (Node http)", "splatpyr/pyramid.py", "libvips dzsave, libjpeg, libwebp", "NumPy",
        "libvips shrink, Pillow", "splatpyr/build.py", "splatpyr/fit.py", "SciPy (sparse LU)", "PyTorch (Metal / MPS)",
        "splatpyr/polish.py", "zlib", "splatpyr/codec.py", "server/image.ts, server/main.ts",
        "shared/units.ts, shared/fec.ts, server/session.ts")

SPANISH = {
    "libvips, through pyvips": "libvips, mediante pyvips",
    "Preparing an image": "Preparar una imagen",
    "From the uploaded file to an image the server is serving, and what each step is built out of. Green is code written for this project; amber is a library doing the work.":
        "Del archivo subido a una imagen que el servidor está sirviendo, y de qué está hecho cada paso. Verde es código escrito para este proyecto; ámbar es una biblioteca haciendo el trabajo.",
    "1 · Arrive, and cut into levels": "1 · Llegar y cortarse en niveles",
    "The file is streamed in and cut once. Nothing here happens while a viewer waits.":
        "El archivo entra como flujo y se corta una sola vez. Nada de esto ocurre mientras un visor espera.",
    "2 · Fit the splats": "2 · Ajustar los splats",
    "The coarse levels become Gaussian blobs: what arrives first, and what survives a lossy network.":
        "Los niveles gruesos se vuelven manchas gaussianas: lo que llega primero y lo que sobrevive a una red con pérdidas.",
    "3 · Ready": "3 · Listo",
    "What the server ends up with, and what it does when the first viewer asks.":
        "Con qué se queda el servidor, y qué hace cuando el primer visor pide la imagen.",
    "Upload": "Subida",
    "Read as a stream": "Lectura en flujo",
    "Every level, as tiles": "Cada nivel, en teselas",
    "The levels to fit": "Los niveles a ajustar",
    "Each level adds what is missing": "Cada nivel agrega lo que falta",
    "Where the blobs go": "Dónde van las manchas",
    "Colours in one solve": "Colores en una sola resolución",
    "Polish": "Pulido",
    "Packed for the wire": "Empaquetado para la red",
    "What the server has": "Lo que tiene el servidor",
    "At the first request": "En la primera petición",
    "the uploaded file": "el archivo subido",
    "one tile of the finest level, at the eye": "una tesela del nivel más fino, en el ojo",
    "one unit: its blobs, and what they draw": "una unidad: sus manchas, y lo que dibujan",
    "blobs (outlines at 2 sigma)": "manchas (contornos a 2 sigma)",
    "drawn": "dibujado",
    "original": "original",
    "The server site streams the file to disk": "El sitio del servidor escribe el archivo a disco",
    "as it arrives, so its size does not matter.": "mientras llega, así que su tamaño no importa.",
    "Or it is dropped into originals/.": "O se deja en originals/.",
    "Then Prepare runs the steps below in a": "Luego Preparar corre los pasos de abajo en un",
    "background process, one image at a time,": "proceso aparte, una imagen a la vez,",
    "with its progress on the page.": "con su progreso en la página.",
    "The image is read a strip at a time and": "La imagen se lee por franjas y",
    "never whole: memory stays flat whatever": "nunca entera: la memoria se mantiene plana sin",
    "its size.": "importar su tamaño.",
    "Each level is half the one below, cut into": "Cada nivel es la mitad del de abajo, cortado en",
    "256 px tiles: what the viewer shows at rest.": "teselas de 256 px: lo que el visor muestra en reposo.",
    "Per tile, the smaller of JPEG (q85) or": "Por tesela, lo menor entre JPEG (q85) o",
    "lossless WebP if within 1.5x of it: text": "WebP sin pérdida si queda a 1.5x: texto",
    "and line art come out exact.": "y dibujos de línea salen exactos.",
    "A second pass shrinks the image straight": "Una segunda pasada reduce la imagen directo",
    "to the split level: the levels above it,": "al nivel de corte: los niveles de arriba,",
    "at most ~300 units, are kept lossless as": "como mucho ~300 unidades, se guardan sin",
    "PNG for the fitter. Below the split the": "pérdida como PNG para el ajuste. Bajo el corte",
    "tiles are enough.": "basta con las teselas.",
    "The top unit is fitted to its pixels, as a": "La unidad superior se ajusta a sus píxeles, como",
    "weighted average of blobs; every level below": "promedio ponderado de manchas; cada nivel inferior",
    "to what the levels above still miss, as": "a lo que a los niveles de arriba aún les falta,",
    "signed corrections. A unit already within": "como correcciones con signo. Una unidad ya dentro",
    "the target gets no blobs at all.": "del objetivo no recibe manchas.",
    "A quadtree splits where the error is largest;": "Un quadtree divide donde el error es mayor;",
    "each blob is stretched along the local edge": "cada mancha se estira a lo largo del borde local",
    "(structure tensor); isolated points (stars,": "(tensor de estructura); los puntos aislados",
    "glints) get a tiny blob each.": "(estrellas, brillos) reciben una mancha diminuta.",
    "With shapes fixed the image is linear in the": "Con las formas fijas la imagen es lineal en los",
    "colours: one sparse least-squares solve. On": "colores: un solo mínimos cuadrados disperso. En",
    "detail levels a dropout penalty keeps any": "niveles de detalle una penalización de dropout",
    "one blob from mattering much, so a lost": "evita que una sola mancha importe mucho, así un",
    "packet leaves softness, not a mark.": "paquete perdido deja suavidad, no una marca.",
    "300 steps of Adam over position, size,": "300 pasos de Adam sobre posición, tamaño,",
    "rotation and colour, on the GPU, starting": "rotación y color, en la GPU, partiendo de",
    "from the formula's answer. Fixed patch": "la respuesta de la fórmula. Tamaños fijos",
    "shapes, so Apple's GPU backend stays fast.": "de parche, para que la GPU de Apple siga rápida.",
    "11 bytes a blob. Sorted by importance into": "11 bytes por mancha. Ordenadas por importancia en",
    "chunks (1/8, 1/4, 1/2, all): any prefix is a": "bloques (1/8, 1/4, 1/2, todo): cualquier prefijo es",
    "coarser unit. Morton order and byte planes,": "una unidad más gruesa. Orden Morton y planos de",
    "then deflate: one .spx file per unit.": "bytes, luego deflate: un archivo .spx por unidad.",
    "The folder lists every level as ready, and": "La carpeta lista cada nivel como listo, y",
    "the server picks it up within 2 s: the image": "el servidor la detecta en 2 s: la imagen",
    "is in the catalog the gallery asks for over": "aparece en el catálogo que la galería pide por",
    "our protocol (LIST, CATALOG).": "nuestro protocolo (LIST, CATALOG).",
    "Each unit is read and cut into packets once:": "Cada unidad se lee y se corta en paquetes una vez:",
    "blobs dealt across packets like cards, the": "manchas repartidas entre paquetes como cartas, los",
    "packets grouped in blocks for the erasure": "paquetes agrupados en bloques para el código de",
    "code. Every viewer is sent from that copy.": "borrado. Cada visor recibe desde esa copia.",
    "level": "nivel",
    "tiles": "teselas",
    "splat units": "unidades de splats",
    "empty": "vacías",
    "measured on": "medido en",
}


def parse_log(path):
    text = open(path, errors="replace").read()
    ingest_part, _, build_part = text.partition("ingest done")
    out = {"tiles": {}, "levels": {}}
    m = re.search(r"ingest done in (\d+)s", text)
    out["ingest_s"] = int(m.group(1)) if m else None
    rss = re.findall(r"(\d+)\s+maximum resident set size", text)
    out["ingest_rss"] = int(rss[0]) if rss else None
    out["build_rss"] = int(rss[1]) if len(rss) > 1 else None
    m = re.search(r"built down to level 0 in (\d+)s", text)
    out["build_s"] = int(m.group(1)) if m else None
    for m in re.finditer(r"^level (\d+): (\d+) units \((\d+) fitted, (\d+) empty\), (\d+) blobs, (\d+) KB, .*?, ([\d.]+)s$", text, re.M):
        L = int(m.group(1))
        out["levels"][L] = {"units": int(m.group(2)), "empty": int(m.group(4)), "blobs": int(m.group(5)),
                            "kb": int(m.group(6)), "s": float(m.group(7))}
    for m in re.finditer(r"^\s+level (\d+): ([\d]+ \w+(?:, \d+ \w+)?) tiles", ingest_part, re.M):
        out["tiles"][int(m.group(1))] = m.group(2)
    m = re.search(r"(\w+) pass in (\d+)s[\s\S]*?(\w+) pass in (\d+)s", ingest_part)
    out["passes"] = m.groups() if m else None
    return out


def folder_bytes(path):
    return sum(os.path.getsize(f) for f in glob.glob(os.path.join(path, "**", "*"), recursive=True) if os.path.isfile(f))


def human(b):
    return f"{b / 2**30:.2f} GB" if b >= 2**30 else f"{b / 2**20:.0f} MB" if b >= 2**20 else f"{b / 2**10:.0f} KB"


def blob_picture(prepared, level, x, y, size=360):
    """One splat unit: its blobs as outlines, what it draws (with the levels above), and the
    original pixels."""
    sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), ".."))
    from splatpyr.build import Store
    from splatpyr.codec import read_unit
    st = Store(prepared)
    T = st.pyr.tile
    w, h = st.pyr.unit_size(level, x, y)
    drawn = np.clip(st.prediction(level, x * T, y * T, x * T + w, y * T + h, finest=level), 0, 1)
    pixels = st.pyr.crop(level, x * T, y * T, x * T + w, y * T + h)
    _, _, _, blobs = read_unit(st.path(level, x, y))
    k = size / max(w, h)
    outline = Image.fromarray((pixels * 60).astype(np.uint8)).resize((round(w * k), round(h * k)))
    d = ImageDraw.Draw(outline, "RGBA")
    for i in range(len(blobs)):
        c, s_ = math.cos(blobs.th[i]), math.sin(blobs.th[i])
        pts = []
        for a in np.linspace(0, 2 * math.pi, 20):
            u, v = 2 * blobs.sx[i] * math.cos(a), 2 * blobs.sy[i] * math.sin(a)
            pts.append(((blobs.x[i] + u * c - v * s_) * k, (blobs.y[i] + u * s_ + v * c) * k))
        d.line(pts + [pts[0]], fill=(255, 255, 255, 70), width=1)
    to_img = lambda a: Image.fromarray((a * 255).round().astype(np.uint8)).resize((round(w * k), round(h * k)), Image.LANCZOS)  # noqa: E731
    return outline, to_img(drawn), to_img(pixels), len(blobs)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("prepared")
    ap.add_argument("log")
    ap.add_argument("source")
    ap.add_argument("--lang", default="en", choices=("en", "es"))
    ap.add_argument("--out", default=None)
    ap.add_argument("--face", default="0.5988,0.2347", help="where the finest tile and the unit are taken, as fractions")
    args = ap.parse_args()
    out = args.out or os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "docs",
                                   "prepare.png" if args.lang == "en" else "prepare-es.png")
    import json
    meta = json.load(open(os.path.join(args.prepared, "pyramid.json")))
    Wimg, Himg, top, split, T = meta["width"], meta["height"], meta["max_level"], meta["split"], meta["tile"]
    log = parse_log(args.log)
    fx, fy = (float(v) for v in args.face.split(","))

    s = Sheet(W, H, {**SPANISH, **{k: k for k in KEEP}} if args.lang == "es" else None)
    s.text((60, 40), "Preparing an image", size=34, bold=True)
    s.text((60, 84), "From the uploaded file to an image the server is serving, and what each step is built out of. "
                     "Green is code written for this project; amber is a library doing the work.", size=17, fill=DIM)
    name = os.path.basename(args.source)
    short = "Hans Holbein, Der Kaufmann Georg Gisze" if "Holbein" in name else name
    s.text((W - 60, 46), s.say(f"measured on {short}", f"medido en {short}"), size=15, fill=DIM, anchor="ra")
    s.text((W - 60, 70), s.say(f"{Wimg:,} × {Himg:,}  ·  {Wimg * Himg / 1e6:,.0f} megapixels  ·  {human(os.path.getsize(args.source))} JPEG", f"{Wimg:,} × {Himg:,}  ·  {Wimg * Himg / 1e6:,.0f} megapíxeles  ·  JPEG de {human(os.path.getsize(args.source))}"),
           size=15, fill=DIM, anchor="ra")

    # ------------------------------------------------------------------ 1 · arrive and cut
    tiles_bytes, pixels_bytes, splats_bytes = (folder_bytes(os.path.join(args.prepared, d)) for d in ("tiles", "pixels", "splats"))
    n_tiles = sum(len(os.listdir(os.path.join(args.prepared, "tiles", d))) for d in os.listdir(os.path.join(args.prepared, "tiles")))
    rss = log["ingest_rss"]
    band(s, W, 130, 560, "1 · Arrive, and cut into levels",
         "The file is streamed in and cut once. Nothing here happens while a viewer waits.",
         s.say(f"once per image  ·  {log['ingest_s']} s, {rss / 2**30:.1f} GB of memory at most", f"una vez por imagen  ·  {log['ingest_s']} s, {rss / 2**30:.1f} GB de memoria como máximo") if rss else "once per image")
    src = Image.open(args.source)
    src.draft("RGB", (600, 600))
    src = src.convert("RGB")
    w_, h_ = s.paste(src, (66, 210, 250, 500))
    s.rect((66, 210, 66 + w_, 210 + h_), outline=RULE)
    s.text((66, 214 + h_), "the uploaded file", size=14, fill=DIM)

    card(s, (300, 200, 640, 520), "Upload",
         ["The server site streams the file to disk", "as it arrives, so its size does not matter.",
          "Or it is dropped into originals/.", "", "Then Prepare runs the steps below in a",
          "background process, one image at a time,", "with its progress on the page."],
         [("server/admin.ts  (Node http)", OURS)])
    card(s, (680, 200, 1000, 520), "Read as a stream",
         ["The image is read a strip at a time and", "never whole: memory stays flat whatever",
          "its size.", "",
          s.say(f"{Wimg * Himg / 1e6:,.0f} megapixels in {rss / 2**30:.1f} GB.", f"{Wimg * Himg / 1e6:,.0f} megapíxeles en {rss / 2**30:.1f} GB.") if rss else ""],
         [("libvips, through pyvips", BORROWED), ("splatpyr/pyramid.py", OURS)])
    lvl0 = log["tiles"].get(0, "")
    lvl0 = re.sub(r"(\d+) (jpg|webp)", lambda m: f"{int(m.group(1)):,} {'JPEG' if m.group(2) == 'jpg' else 'lossless WebP'}", lvl0)
    card(s, (1040, 200, 1420, 520), "Every level, as tiles",
         ["Each level is half the one below, cut into", "256 px tiles: what the viewer shows at rest.", "",
          "Per tile, the smaller of JPEG (q85) or", "lossless WebP if within 1.5x of it: text",
          "and line art come out exact.", "",
          s.say(f"{top + 1} levels, {n_tiles:,} tiles, {human(tiles_bytes)}.", f"{top + 1} niveles, {n_tiles:,} teselas, {human(tiles_bytes)}."), s.say(f"finest level: {lvl0}.", f"nivel más fino: {lvl0}.".replace("lossless WebP", "WebP sin pérdida"))],
         [("libvips dzsave, libjpeg, libwebp", BORROWED)])
    units_fit = sum(v["units"] for v in log["levels"].values())
    card(s, (1460, 200, 1800, 520), "The levels to fit",
         ["A second pass shrinks the image straight", "to the split level: the levels above it,",
          "at most ~300 units, are kept lossless as", "PNG for the fitter. Below the split the",
          "tiles are enough.", "",
          s.say(f"levels {top}..{split}: {units_fit} units, {human(pixels_bytes)} of PNG.", f"niveles {top}..{split}: {units_fit} unidades, {human(pixels_bytes)} de PNG.")],
         [("libvips shrink, Pillow", BORROWED)])
    for a, b in (((250, 360), (300, 360)), ((640, 360), (680, 360)), ((1000, 360), (1040, 360)), ((1420, 360), (1460, 360))):
        s.arrow(a, b)
    # the finest tile at the face
    L0 = os.path.join(args.prepared, "tiles", "0")
    tx, ty = int(fx * Wimg / T), int(fy * Himg / T)
    tile = next((os.path.join(L0, f"{tx}_{ty}.{e}") for e in ("webp", "jpg") if os.path.exists(os.path.join(L0, f"{tx}_{ty}.{e}"))), None)
    if tile:
        tw, th = s.paste(Image.open(tile).convert("RGB").resize((256 * 2, 256 * 2), Image.NEAREST), (1860, 210, 2110, 460))
        s.rect((1860, 210, 1860 + tw, 210 + th), outline=RULE)
        s.text((1860, 216 + th), "one tile of the finest level, at the eye", size=14, fill=DIM)
        size_line = f"256 × 256 px, {human(os.path.getsize(tile))} {tile.rsplit('.', 1)[1].upper()}".replace("KB JPG", "KB JPEG")
        s.text((1860, 236 + th), s.say(size_line, size_line), size=14, fill=DIM)

    # ------------------------------------------------------------------ 2 · fit the splats
    blobs_total = sum(v["blobs"] for v in log["levels"].values())
    empties = sum(v["empty"] for v in log["levels"].values())
    band(s, W, 600, 1040, "2 · Fit the splats",
         "The coarse levels become Gaussian blobs: what arrives first, and what survives a lossy network.",
         s.say(f"{units_fit} units  ·  {log['build_s'] / 60:.0f} min on the Mac's GPU", f"{units_fit} unidades  ·  {log['build_s'] / 60:.0f} min en la GPU del Mac") if log["build_s"] else s.say(f"{units_fit} units", f"{units_fit} unidades"))
    card(s, (60, 670, 400, 1010), "Each level adds what is missing",
         ["The top unit is fitted to its pixels, as a", "weighted average of blobs; every level below",
          "to what the levels above still miss, as", "signed corrections. A unit already within",
          "the target gets no blobs at all.", "",
          s.say(f"{units_fit} units, {empties} of them empty.", f"{units_fit} unidades, {empties} de ellas vacías."), s.say(f"{blobs_total:,} blobs in all.", f"{blobs_total:,} manchas en total.")],
         [("splatpyr/build.py", OURS)])
    card(s, (440, 670, 780, 1010), "Where the blobs go",
         ["A quadtree splits where the error is largest;", "each blob is stretched along the local edge",
          "(structure tensor); isolated points (stars,", "glints) get a tiny blob each."],
         [("NumPy", BORROWED), ("splatpyr/fit.py", OURS)])
    card(s, (820, 670, 1160, 1010), "Colours in one solve",
         ["With shapes fixed the image is linear in the", "colours: one sparse least-squares solve. On",
          "detail levels a dropout penalty keeps any", "one blob from mattering much, so a lost",
          "packet leaves softness, not a mark."],
         [("SciPy (sparse LU)", BORROWED), ("splatpyr/fit.py", OURS)])
    card(s, (1200, 670, 1540, 1010), "Polish",
         ["300 steps of Adam over position, size,", "rotation and colour, on the GPU, starting",
          "from the formula's answer. Fixed patch", "shapes, so Apple's GPU backend stays fast."],
         [("PyTorch (Metal / MPS)", BORROWED), ("splatpyr/polish.py", OURS)])
    card(s, (1580, 670, 1900, 1010), "Packed for the wire",
         ["11 bytes a blob. Sorted by importance into", "chunks (1/8, 1/4, 1/2, all): any prefix is a",
          "coarser unit. Morton order and byte planes,", "then deflate: one .spx file per unit.", "",
          s.say(f"{human(splats_bytes)} for all {units_fit} units.", f"{human(splats_bytes)} para las {units_fit} unidades.")],
         [("zlib", BORROWED), ("splatpyr/codec.py", OURS)])
    for a, b in (((400, 840), (440, 840)), ((780, 840), (820, 840)), ((1160, 840), (1200, 840)), ((1540, 840), (1580, 840))):
        s.arrow(a, b)
    # ------------------------------------------------------------------ 3 · ready
    band(s, W, 1080, 1520, "3 · Ready",
         "What the server ends up with, and what it does when the first viewer asks.",
         s.say(f"{human(tiles_bytes + splats_bytes)} served  ·  {human(pixels_bytes)} kept only for fitting again", f"{human(tiles_bytes + splats_bytes)} servidos  ·  {human(pixels_bytes)} guardados solo para volver a ajustar"))
    # the pyramid, one row per level
    x0, y0 = 70, 1160
    s.text((x0, y0), "level", size=14, fill=DIM)
    s.text((x0 + 90, y0), "tiles", size=14, fill=DIM)
    s.text((x0 + 250, y0), "splat units", size=14, fill=DIM)
    for i, L in enumerate(range(top, -1, -1)):
        y = y0 + 26 + i * 36
        cols, rows = math.ceil(math.ceil(Wimg / 2 ** L) / T), math.ceil(math.ceil(Himg / 2 ** L) / T)
        s.text((x0, y + 4), f"{L}", size=15, bold=True)
        bar = min(140, 6 + 140 * math.log2(1 + cols * rows) / math.log2(1 + 12154))
        s.rect((x0 + 90, y + 2, x0 + 90 + bar, y + 22), outline=None, fill=(222, 232, 246), radius=3)
        s.text((x0 + 96, y + 5), f"{cols * rows:,}", size=13)
        if L >= split:
            lv = log["levels"].get(L, {})
            s.rect((x0 + 250, y + 2, x0 + 250 + bar, y + 22), outline=None, fill=(222, 240, 228), radius=3)
            s.text((x0 + 256, y + 5), s.say(f"{lv.get('units', cols * rows)}" + (f"  ({lv['empty']} empty)" if lv.get("empty") else ""), f"{lv.get('units', cols * rows)}" + (f"  ({lv['empty']} vacías)" if lv.get("empty") else "")), size=13)
    card(s, (560, 1150, 1000, 1490), "What the server has",
         ["The folder lists every level as ready, and", "the server picks it up within 2 s: the image",
          "is in the catalog the gallery asks for over", "our protocol (LIST, CATALOG).", "",
          s.say(f"tiles: {human(tiles_bytes)}   splats: {human(splats_bytes)}", f"teselas: {human(tiles_bytes)}   splats: {human(splats_bytes)}")],
         [("server/image.ts, server/main.ts", OURS)])
    card(s, (1040, 1150, 1480, 1490), "At the first request",
         ["Each unit is read and cut into packets once:", "blobs dealt across packets like cards, the",
          "packets grouped in blocks for the erasure", "code. Every viewer is sent from that copy."],
         [("shared/units.ts, shared/fec.ts, server/session.ts", OURS)])
    s.arrow((1000, 1320), (1040, 1320))
    # one unit of the split level, at the face: its blobs, what they draw, the original
    ux, uy = int(fx * Wimg / 2 ** split / T), int(fy * Himg / 2 ** split / T)
    outline, drawn, original, nb = blob_picture(args.prepared, split, ux, uy, size=560)
    s.text((1530, 1150), s.say(f"one unit: its blobs, and what they draw  ·  level {split}, {nb:,} blobs", f"una unidad: sus manchas, y lo que dibujan  ·  nivel {split}, {nb:,} manchas"),
           size=14, fill=DIM)
    for i, (pic, cap) in enumerate(((outline, "blobs (outlines at 2 sigma)"), (drawn, "drawn"), (original, "original"))):
        x0 = 1530 + i * 280
        pw, ph = s.paste(pic, (x0, 1178, x0 + 265, 1443))
        s.rect((x0, 1178, x0 + pw, 1178 + ph), outline=RULE)
        s.text((x0, 1178 + ph + 5), cap, size=13, fill=DIM)
    s.save(out)
    print(f"wrote {out}")


if __name__ == "__main__":
    main()
