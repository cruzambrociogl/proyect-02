"""
Drawing helpers shared by the figures (same look as v1's): cards in grey bands, green for
code written for this project, amber for a library doing the work, drawn at twice the size
and reduced for antialiasing.

Every piece of text goes through Sheet.text, so one lookup there is the whole of the
translation: a figure passes its Spanish words to Sheet and any string without an entry is
reported, so a missing translation is found rather than shipped in English.
"""

import os
import re

from PIL import Image, ImageDraw, ImageFont

INK = (22, 22, 24)
DIM = (120, 120, 126)
RULE = (214, 214, 220)
OURS = (28, 130, 76)            # written by us
BORROWED = (176, 110, 20)       # a library doing the work
PAPER = (255, 255, 255)
BAND = (246, 246, 248)
SCALE = 2


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
    def __init__(self, width, height, words=None):
        self.size = (width, height)
        self.image = Image.new("RGB", (width * SCALE, height * SCALE), PAPER)
        self.draw = ImageDraw.Draw(self.image)
        self.words = dict(words or {})
        self.seen = []

    def say(self, english, spanish):
        """A sentence built from numbers: give both wordings here, and text() finds it."""
        if self.words:
            self.words[english] = spanish
        return english

    def t(self, text):
        self.seen.append(text)
        return self.words.get(text, text)

    def text(self, xy, text, size=18, bold=False, fill=INK, anchor="la"):
        self.draw.text((xy[0] * SCALE, xy[1] * SCALE), self.t(text),
                       font=font(size * SCALE, bold), fill=fill, anchor=anchor)

    def rect(self, box, outline=RULE, fill=None, width=1, radius=0):
        x0, y0, x1, y1 = (v * SCALE for v in box)
        if radius:
            self.draw.rounded_rectangle([x0, y0, x1, y1], radius=radius * SCALE,
                                        outline=outline, fill=fill, width=width * SCALE)
        else:
            self.draw.rectangle([x0, y0, x1, y1], outline=outline, fill=fill, width=width * SCALE)

    def line(self, a, b, fill=RULE, width=1):
        self.draw.line([a[0] * SCALE, a[1] * SCALE, b[0] * SCALE, b[1] * SCALE], fill=fill, width=width * SCALE)

    def arrow(self, a, b, fill=DIM, width=2, head=9):
        self.line(a, b, fill=fill, width=width)
        (x0, y0), (x1, y1) = a, b
        if abs(x1 - x0) >= abs(y1 - y0):
            s = 1 if x1 > x0 else -1
            points = [(x1, y1), (x1 - s * head, y1 - head * 0.6), (x1 - s * head, y1 + head * 0.6)]
        else:
            s = 1 if y1 > y0 else -1
            points = [(x1, y1), (x1 - head * 0.6, y1 - s * head), (x1 + head * 0.6, y1 - s * head)]
        self.draw.polygon([(x * SCALE, y * SCALE) for x, y in points], fill=fill)

    def paste(self, picture, box):
        """Fit a picture into box (keeping its shape); returns the size it took."""
        x0, y0, x1, y1 = box
        fitted = picture.copy()
        fitted.thumbnail(((x1 - x0) * SCALE, (y1 - y0) * SCALE), Image.LANCZOS)
        self.image.paste(fitted, (x0 * SCALE, y0 * SCALE))
        return fitted.size[0] // SCALE, fitted.size[1] // SCALE

    def save(self, path):
        os.makedirs(os.path.dirname(os.path.abspath(path)), exist_ok=True)
        self.image.resize(self.size, Image.LANCZOS).save(path, quality=95)
        if self.words:
            missing = [s for s in dict.fromkeys(self.seen)
                       if re.search(r"[A-Za-z]{2}", s) and s not in self.words]
            if missing:
                print(f"{len(missing)} strings still untranslated:")
                for s in missing[:60]:
                    print("   ", repr(s))


def card(sheet, box, title, lines, built):
    """One step: what it does and, underneath, what it is made of. built is a list of
    (text, colour) pairs, colour OURS or BORROWED."""
    x0, y0, x1, y1 = box
    sheet.rect(box, outline=RULE, fill=PAPER, width=1, radius=8)
    sheet.line((x0, y0 + 40), (x1, y0 + 40), fill=RULE)
    sheet.text((x0 + 14, y0 + 12), title, size=19, bold=True)
    at = y0 + 54
    for line in lines:
        sheet.text((x0 + 14, at), line, size=15, fill=INK)
        at += 22
    for i, (text, colour) in enumerate(built):
        sheet.text((x0 + 14, y1 - 16 - 20 * (len(built) - i)), text, size=14, fill=colour)


def band(sheet, width, y0, y1, title, subtitle, when):
    sheet.rect((40, y0, width - 40, y1), outline=None, fill=BAND, radius=12)
    sheet.text((62, y0 + 18), title, size=22, bold=True)
    sheet.text((62, y0 + 46), subtitle, size=15, fill=DIM)
    sheet.text((width - 62, y0 + 22), when, size=15, fill=DIM, anchor="ra")
