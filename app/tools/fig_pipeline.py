#!/usr/bin/env python3
"""
Figure: everything that happens to an image between the file on disk and the pixels on the
screen, and what each stage is built out of.

Drawn from the real store, so the thumbnails are the actual image and the actual tile, and
every number on it was measured rather than estimated.

  python3 tools/fig_pipeline.py --out ../docs/pipeline.png
"""

import argparse
import os
import sys

from PIL import Image, ImageDraw, ImageFont

INK = (22, 22, 24)
DIM = (120, 120, 126)
RULE = (214, 214, 220)
OURS = (28, 130, 76)            # written by us
BORROWED = (176, 110, 20)       # a library doing the work
PAPER = (255, 255, 255)
BAND = (246, 246, 248)

W, H = 2400, 1460
SCALE = 2                       # drawn at twice the size, then reduced: cheap antialiasing


def font(size, bold=False):
    for path in (("/System/Library/Fonts/Supplemental/Arial Bold.ttf" if bold
                  else "/System/Library/Fonts/Supplemental/Arial.ttf"),
                 "/System/Library/Fonts/Helvetica.ttc"):
        try:
            return ImageFont.truetype(path, size)
        except OSError:
            continue
    return ImageFont.load_default()


class Sheet:
    def __init__(self, width, height):
        self.size = (width, height)
        self.image = Image.new("RGB", (width * SCALE, height * SCALE), PAPER)
        self.draw = ImageDraw.Draw(self.image)

    def text(self, xy, text, size=18, bold=False, fill=INK, anchor="la"):
        self.draw.text((xy[0] * SCALE, xy[1] * SCALE), text,
                       font=font(size * SCALE, bold), fill=fill, anchor=anchor)

    def rect(self, box, outline=RULE, fill=None, width=1, radius=0):
        x0, y0, x1, y1 = (v * SCALE for v in box)
        if radius:
            self.draw.rounded_rectangle([x0, y0, x1, y1], radius=radius * SCALE,
                                        outline=outline, fill=fill, width=width * SCALE)
        else:
            self.draw.rectangle([x0, y0, x1, y1], outline=outline, fill=fill, width=width * SCALE)

    def line(self, a, b, fill=RULE, width=1):
        self.draw.line([a[0] * SCALE, a[1] * SCALE, b[0] * SCALE, b[1] * SCALE],
                       fill=fill, width=width * SCALE)

    def arrow(self, a, b, fill=DIM, width=2, head=9):
        self.line(a, b, fill=fill, width=width)
        (x0, y0), (x1, y1) = a, b
        if abs(x1 - x0) >= abs(y1 - y0):                  # horizontal
            s = 1 if x1 > x0 else -1
            points = [(x1, y1), (x1 - s * head, y1 - head * 0.6), (x1 - s * head, y1 + head * 0.6)]
        else:
            s = 1 if y1 > y0 else -1
            points = [(x1, y1), (x1 - head * 0.6, y1 - s * head), (x1 + head * 0.6, y1 - s * head)]
        self.draw.polygon([(x * SCALE, y * SCALE) for x, y in points], fill=fill)

    def paste(self, picture, box):
        x0, y0, x1, y1 = box
        fitted = picture.copy()
        fitted.thumbnail(((x1 - x0) * SCALE, (y1 - y0) * SCALE), Image.LANCZOS)
        self.image.paste(fitted, (x0 * SCALE, y0 * SCALE))
        return fitted.size[0] // SCALE, fitted.size[1] // SCALE

    def save(self, path):
        self.image.resize(self.size, Image.LANCZOS).save(path, quality=95)


def stage(sheet, box, title, lines, built, colour=OURS):
    """One step of the pipeline: what it does, and underneath, what it is made of."""
    x0, y0, x1, y1 = box
    sheet.rect(box, outline=RULE, fill=PAPER, width=1, radius=8)
    sheet.line((x0, y0 + 40), (x1, y0 + 40), fill=RULE)
    sheet.text((x0 + 14, y0 + 12), title, size=19, bold=True)
    at = y0 + 54
    for line in lines:
        sheet.text((x0 + 14, at), line, size=15, fill=INK if not line.startswith("·") else DIM)
        at += 22
    for line in built:
        sheet.text((x0 + 14, y1 - 16 - 20 * (len(built) - built.index(line))), line,
                   size=14, fill=colour)


def band(sheet, y0, y1, title, subtitle, when):
    sheet.rect((40, y0, W - 40, y1), outline=None, fill=BAND, radius=12)
    sheet.text((62, y0 + 18), title, size=22, bold=True)
    sheet.text((62, y0 + 46), subtitle, size=15, fill=DIM)
    sheet.text((W - 62, y0 + 22), when, size=15, fill=DIM, anchor="ra")


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--store", default="images/.prepared/ladder-tiles/holbein_8000.jpg")
    ap.add_argument("--screen", default=None, help="a screenshot of the viewer, optional")
    ap.add_argument("--out", default="../docs/pipeline.png")
    args = ap.parse_args()

    sheet = Sheet(W, H)
    sheet.text((60, 40), "From the file to the screen", size=34, bold=True)
    sheet.text((60, 84),
               "Every stage of PROJECT02, and what each one is built out of. "
               "Green is code written for this project; amber is a library doing the work.",
               size=17, fill=DIM)
    sheet.text((W - 60, 46), "measured on holbein_8000.jpg  ·  7,011 × 8,000  ·  56 megapixels",
               size=15, fill=DIM, anchor="ra")
    sheet.text((W - 60, 70), "and eso1242a.tif  ·  25,000 × 18,832  ·  470 megapixels",
               size=15, fill=DIM, anchor="ra")

    # ---------------------------------------------------------------- preparation
    band(sheet, 130, 540, "1 · Preparation",
         "The image is cut up once, before anyone looks at it. Nothing here happens while a viewer waits.",
         "once per image  ·  15 min 22 s for 470 megapixels")

    preview = os.path.join(args.store, "preview.jpg")
    if os.path.isfile(preview):
        picture = Image.open(preview)
        width, height = sheet.paste(picture, (66, 210, 240, 500))
        sheet.rect((66, 210, 66 + width, 210 + height), outline=RULE)
        sheet.text((66, 214 + height), "the file on disk", size=14, fill=DIM)
        sheet.text((66, 234 + height), "1.5 GB TIFF / 13 MB JPEG", size=14, fill=DIM)

    stage(sheet, (300, 200, 640, 500), "Read in strips",
          ["The source never fits in memory, so it",
           "is read a band at a time, and each band",
           "is cut into tiles before the next is read.",
           "",
           "470 megapixels in 1.5 GB of memory."],
          ["javax.imageio.ImageReader", "setSourceRegion, setSourceSubsampling"],
          colour=BORROWED)

    stage(sheet, (680, 200, 1020, 500), "A ladder of levels",
          ["Each level is 1.25× smaller than the one",
           "below it - not 2×. A view then always finds",
           "a level within 12% of the size it wants,",
           "so nothing is scaled far enough to blur.",
           "",
           "eso1242a: 22 levels, 20,375 tiles, 713 MB."],
          ["p2.media.LadderTiles"])

    stage(sheet, (1060, 200, 1400, 500), "Tiles of 256 px",
          ["Small enough that one costs 13 KB and",
           "decodes in a millisecond; large enough",
           "that a screenful is a dozen of them,",
           "not a thousand.",
           "",
           "JPEG, quality 0.85."],
          ["javax.imageio (JPEG writer)"],
          colour=BORROWED)

    stage(sheet, (1440, 200, 1830, 500), "Or: fitted as splats",
          ["A second method, swappable with the first:",
           "each unit becomes 4,000 Gaussian blobs of",
           "11 bytes each, fitted by gradient descent",
           "on the GPU, and drawn as shapes instead",
           "of pixels. 35.9 dB on a face, 40.0 on an eye."],
          ["PyTorch 2 (Metal), NumPy, Pillow", "p2.media.SplatMethod drives it"],
          colour=BORROWED)

    tile = os.path.join(args.store, "0", "16_7.jpg")
    if os.path.isfile(tile):
        picture = Image.open(tile)
        width, height = sheet.paste(picture, (1880, 250, 2030, 400))
        sheet.rect((1880, 250, 1880 + width, 250 + height), outline=RULE)
        sheet.text((1880, 254 + height), "one tile of the finest level", size=14, fill=DIM)
        sheet.text((1880, 274 + height), "256 × 256 px, ~13 KB", size=14, fill=DIM)

    sheet.arrow((252, 350), (296, 350))
    sheet.arrow((644, 350), (676, 350))
    sheet.arrow((1024, 350), (1056, 350))
    # not an arrow: the two methods are alternatives, not steps one after the other
    sheet.text((1420, 342), "or", size=17, fill=DIM, anchor="ma")
    sheet.arrow((1404, 300), (1436, 300), fill=RULE)
    sheet.arrow((1404, 400), (1436, 400), fill=RULE)

    # ---------------------------------------------------------------- the protocol
    band(sheet, 570, 980, "2 · The protocol",
         "What the server decides, and how the bytes leave. No TCP, no HTTP, no library: "
         "sockets and our own rules.",
         "per view  ·  43.9 mbit/s on a 50 mbit path")

    stage(sheet, (66, 640, 420, 940), "Which units",
          ["The viewer says where it is looking. The",
           "server works out the level and the tiles that",
           "cover it, nearest the middle first, and skips",
           "everything the viewer already holds.",
           "",
           "A move cancels the old view's work outright."],
          ["p2.session.Session"])

    stage(sheet, (460, 640, 814, 940), "Cut into symbols",
          ["Each unit is split into 1,200-byte symbols.",
           "The first ones are the unit's own bytes, so a",
           "clean path does no arithmetic at all; beyond",
           "those, endless repair symbols, each a mixture",
           "of the rest over a field of 256 elements.",
           "",
           "Any k of them rebuild the unit."],
          ["p2.fec - GF(256), written here"])

    stage(sheet, (854, 640, 1208, 940), "Which one, how much, how fast",
          ["Earliest deadline first, visible work ahead of",
           "guesses. Repair in proportion to the loss the",
           "far end reports. Speed set by how long packets",
           "are waiting, not by whether they are lost.",
           "",
           "3% overhead clean, 15% at 10% loss."],
          ["p2.net.udp.Sender, RateControl"])

    stage(sheet, (1248, 640, 1602, 940), "Datagrams",
          ["1,232 bytes: 16 of packet header, 16 saying",
           "which unit and symbol, 1,200 of payload.",
           "Nothing is ever split across two packets,",
           "so nothing is lost in halves.",
           "",
           "No connection, no handshake underneath."],
          ["java.nio.channels.DatagramChannel"],
          colour=BORROWED)

    stage(sheet, (1642, 640, 2030, 940), "A path that misbehaves",
          ["Between the two ends, on purpose: loss,",
           "delay, jitter, reordering, duplication and a",
           "narrow pipe, all reproducible from a flag.",
           "",
           "--impair loss=2%,delay=25ms,",
           "         jitter=5ms,rate=30mbit"],
          ["p2.net.udp.Impairment"])

    for x in (424, 818, 1212, 1606):
        sheet.arrow((x, 790), (x + 32, 790))

    # ---------------------------------------------------------------- the client
    band(sheet, 1010, 1420, "3 · The client",
         "A browser cannot open a UDP socket, so it is not the client - it is the screen. "
         "The client is a Java process beside it.",
         "per frame  ·  60 fps, 12 tiles on screen")

    stage(sheet, (66, 1080, 420, 1380), "Rebuild",
          ["Symbols arrive in any order and any subset.",
           "Each one is eliminated against the ones",
           "already held; when k of them are in, the",
           "unit falls out whole.",
           "",
           "A few times a second it says what it still",
           "needs - a count, never a list of what was lost."],
          ["p2.net.udp.Receiver"])

    stage(sheet, (460, 1080, 814, 1380), "Hand it to the page",
          ["The rebuilt message goes to the browser",
           "unchanged, over the WebSocket it is already",
           "connected by. The bridge carries the protocol",
           "without interpreting it.",
           "",
           "Handshake and framing written here too."],
          ["p2.bridge.Bridge, p2.net.WebSocketLink"])

    stage(sheet, (854, 1080, 1208, 1380), "Draw",
          ["Tiles are decoded by the browser itself and",
           "drawn to a 2D canvas. Splats are drawn as",
           "shapes on the GPU, accumulated in a float",
           "buffer and divided through at the end.",
           "",
           "No framework, no library: one ES module."],
          ["createImageBitmap, Canvas2D, WebGL2"],
          colour=BORROWED)

    if args.screen and os.path.isfile(args.screen):
        shot = Image.open(args.screen)
        crop = shot.crop((int(shot.width * 0.23), int(shot.height * 0.07), shot.width, shot.height))
        width, height = sheet.paste(crop, (1248, 1080, 1700, 1380))
        sheet.rect((1248, 1080, 1248 + width, 1080 + height), outline=RULE)
        sheet.text((1248, 1084 + height), "what the viewer shows", size=14, fill=DIM)

    stage(sheet, (1740, 1080, 2030, 1380), "What it costs",
          ["50 MB of decoded tiles, then the least",
           "useful are dropped and the server told.",
           "",
           "Memory stays flat however long you zoom:",
           "the cache is a budget, not a heap."],
          ["web/viewer/scene.js"])

    for x in (424, 818, 1212):
        sheet.arrow((x, 1230), (x + 32, 1230))

    sheet.arrow((1160, 544), (1160, 566))
    sheet.arrow((1160, 984), (1160, 1006))

    out = args.out
    os.makedirs(os.path.dirname(os.path.abspath(out)), exist_ok=True)
    sheet.save(out)
    print(f"wrote {out}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
