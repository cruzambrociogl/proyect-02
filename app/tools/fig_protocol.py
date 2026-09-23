#!/usr/bin/env python3
"""
Figure: the protocol itself - how a session starts without a handshake, what is in a packet,
how a unit survives loss, and how the two ends stay in step without acknowledgements.

The worked example is real. Its numbers come from running the codec on an actual tile:

  jshell --class-path server/build   (see the commit message)
  unit 17,736 bytes -> 15 symbols; coefficients of symbol 15 = 98 126 236 8 255 ...;
  98*255 + 126*104 + 236*229 + ... = 61; three lost, three mixtures, rebuilt byte for byte.

  python3 tools/fig_protocol.py --out ../docs/protocol.png
"""

import argparse
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from fig_pipeline import (BAND, BORROWED, DIM, INK, OURS, PAPER, RULE, Sheet,  # noqa: E402
                          language)

W, H = 2400, 3260
LOST = (196, 62, 58)
KEPT = (28, 130, 76)
REPAIR = (58, 104, 190)
WASH = (238, 242, 248)


def band(sheet, y0, y1, number, title, subtitle, accent=False):
    """A section. The one that matters most is tinted and outlined, so the eye finds it."""
    sheet.rect((40, y0, W - 40, y1), outline=REPAIR if accent else None,
               fill=(240, 245, 252) if accent else BAND, radius=12, width=2 if accent else 1)
    sheet.text((62, y0 + 16), f"{number} · {title}", size=22, bold=True)
    sheet.text((62, y0 + 46), subtitle, size=15, fill=DIM)


def badge(sheet, x, y, text, colour=REPAIR):
    width = 13 * len(text) + 28
    sheet.rect((x, y, x + width, y + 34), outline=colour, fill=PAPER, radius=17, width=2)
    sheet.text((x + width / 2, y + 8), text, size=15, bold=True, fill=colour, anchor="ma")
    return x + width


def step(sheet, x, y, number, title):
    """A numbered beat of the walkthrough, so it can be told in order."""
    sheet.rect((x, y, x + 34, y + 34), outline=REPAIR, fill=REPAIR, radius=17)
    sheet.text((x + 17, y + 7), str(number), size=17, bold=True, fill=PAPER, anchor="ma")
    sheet.text((x + 48, y + 7), title, size=18, bold=True)


def note(sheet, box, lines, colour=DIM):
    x0, y0, x1, y1 = box
    sheet.rect(box, outline=RULE, fill=PAPER, radius=8)
    at = y0 + 14
    for line in lines:
        bold = line.endswith(":")
        sheet.text((x0 + 14, at), line, size=15, bold=bold,
                   fill=INK if bold or not line.startswith("·") else colour)
        at += 21


def lane(sheet, x, y0, y1, title, subtitle):
    sheet.rect((x - 105, y0, x + 105, y0 + 46), outline=RULE, fill=PAPER, radius=6)
    sheet.text((x, y0 + 10), title, size=16, bold=True, anchor="ma")
    sheet.text((x, y0 + 52), subtitle, size=13, fill=DIM, anchor="ma")
    step = 12
    for y in range(int(y0 + 76), int(y1), step * 2):
        sheet.line((x, y), (x, min(y + step, y1)), fill=RULE)


def message(sheet, x0, x1, y, label, detail=None, colour=INK, dashed=False):
    sheet.text(((x0 + x1) / 2, y - 26), label, size=15, bold=True, fill=colour, anchor="ma")
    if detail:
        sheet.text(((x0 + x1) / 2, y + 8), detail, size=13, fill=DIM, anchor="ma")
    if dashed:
        step = 9
        x = x0
        while (x < x1) if x1 > x0 else (x > x1):
            nxt = x + step if x1 > x0 else x - step
            sheet.line((x, y), (nxt, y), fill=colour, width=2)
            x = nxt + (step if x1 > x0 else -step)
        sheet.arrow((x1 - 14 if x1 > x0 else x1 + 14, y), (x1, y), fill=colour, width=2)
    else:
        sheet.arrow((x0, y), (x1, y), fill=colour, width=2)


def strip(sheet, x, y, width, fields, height=44):
    """One packet, drawn to scale where it can be and marked where it cannot."""
    total = sum(f[3] for f in fields)          # drawn to a weight, not to scale: 1,200 bytes
    at = x                                     # beside 2 would be a line and a speck
    for label, size, colour, shown in fields:
        piece = width * shown / total
        sheet.rect((at, y, at + piece, y + height), outline=RULE, fill=colour, radius=4)
        sheet.text((at + piece / 2, y + 8), label, size=13, bold=True, anchor="ma")
        sheet.text((at + piece / 2, y + 26), f"{size} B", size=12, fill=DIM, anchor="ma")
        at += piece + 4
    return at


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--lang", default="en", choices=("en", "es"))
    ap.add_argument("--out", default="../docs/protocol.png")
    args = ap.parse_args()
    if args.lang == "es":
        from fig_spanish import WORDS
        language(WORDS)

    sheet = Sheet(W, H)
    sheet.text((60, 40), "The protocol", size=34, bold=True)
    sheet.text((60, 84),
               "How a session starts, what travels, how a unit survives loss, and how two ends "
               "stay in step with no acknowledgements at all.", size=17, fill=DIM)
    sheet.text((W - 60, 48), "every number here was measured or taken from the running code",
               size=15, fill=DIM, anchor="ra")

    # ---------------------------------------------------------------- 1. starting up
    band(sheet, 130, 1000, "1", "Starting a session",
         "There is no handshake. Nothing is negotiated, nothing is agreed, and neither end "
         "waits for the other to be ready.")

    bx, cx, sx = 380, 1120, 1860
    lane(sheet, bx, 212, 950, "Browser", "the screen · plain JavaScript")
    lane(sheet, cx, 212, 950, "Client (bridge)", "holds the UDP socket · Java")
    lane(sheet, sx, 212, 950, "Server", "the image · Java")

    message(sheet, bx, cx, 300, "HELLO", "over the WebSocket")
    message(sheet, cx, sx, 340, "CONTROL packet: HELLO",
            "the session is created by this packet arriving - no accept, no negotiation",
            colour=OURS)
    message(sheet, sx, cx, 400, "WELCOME", "version, which image method", colour=OURS)
    message(sheet, cx, bx, 440, "WELCOME", "the bridge now stops repeating HELLO")

    message(sheet, bx, cx, 520, "OPEN  holbein_8000.jpg")
    message(sheet, cx, sx, 560, "CONTROL packet: OPEN", colour=OURS)
    message(sheet, sx, cx, 620, "CHART",
            "7,011 × 8,000 · 2,503 units · 17 levels · tile size 256", colour=OURS)
    message(sheet, cx, bx, 660, "CHART", "and stops repeating OPEN")

    message(sheet, bx, cx, 740, "VIEW  epoch 1",
            "centre x, centre y, scale, screen size, units dropped since last time")
    message(sheet, cx, sx, 780, "CONTROL packet: VIEW",
            "repeated every 150 ms until an answer shows it arrived", colour=OURS)
    message(sheet, sx, cx, 840, "UNIT · UNIT · UNIT …",
            "as symbols, nearest the middle of the screen first", colour=REPAIR)
    message(sheet, cx, sx, 900, "REPORT",
            "what has arrived and what is still wanted  ·  every 10 ms, for as long as the "
            "session lasts", colour=OURS)

    note(sheet, (2050, 230, 2340, 470),
         ["Repeated, not acknowledged:",
          "HELLO, OPEN and VIEW say how",
          "things are, not what happened,",
          "so a lost one costs 150 ms and",
          "nothing else.",
          "",
          "The answer stops the repeating:",
          "WELCOME stops HELLO, CHART",
          "stops OPEN. VIEW keeps going -",
          "it is also the keep-alive."])

    note(sheet, (2050, 500, 2340, 740),
         ["So a repeat must be harmless:",
          "the server remembers the last",
          "message of each kind and does",
          "nothing if it sees it again",
          "within a second.",
          "",
          "That check is per kind. Comparing",
          "against whatever came last found",
          "a difference every time, and",
          "re-opened the image 7 times a",
          "second until it was fixed."])

    note(sheet, (2050, 770, 2340, 950),
         ["No teardown either:",
          "a session exists because packets",
          "arrive from an address, and stops",
          "existing 30 seconds after they",
          "stop. A viewer that vanishes",
          "costs one timeout."])

    # ---------------------------------------------------------------- 2. packets
    band(sheet, 1030, 1560, "2", "What actually travels",
         "Three kinds of packet. Nothing is ever split across two of them, so nothing arrives in halves.")

    sheet.text((66, 1100), "DATA   server → client   ·   1,232 bytes, the only packet carrying image bytes",
               size=16, bold=True)
    strip(sheet, 66, 1128, 2260, [
        ("P 2 ver type", 4, WASH, 60), ("session", 4, WASH, 60), ("sequence", 4, WASH, 70),
        ("micros", 4, WASH, 60),
        ("epoch", 4, PAPER, 60), ("unit", 4, PAPER, 60), ("length", 4, PAPER, 60),
        ("block", 2, PAPER, 44), ("sym", 2, PAPER, 40),
        ("one symbol of the unit", 1200, (233, 240, 250), 560)])
    sheet.text((66, 1180), "packet header, 16 B", size=13, fill=DIM)
    sheet.text((612, 1180), "which unit and which symbol, 16 B", size=13, fill=DIM)
    sheet.text((1300, 1180), "payload, 1,200 B", size=13, fill=DIM)

    note(sheet, (66, 1210, 1180, 1370),
         ["The sequence number does not order anything - the codec does not care what arrives",
          "or in what order. It is there to measure: 940 packets seen out of a highest number of",
          "1,000 is 6% loss, without either end tracking which ones those were.",
          "",
          "The microsecond stamp is echoed back, and what comes back is the round trip.",
          "The epoch sits outside the coded bytes so a symbol for a view the viewer has already",
          "left is dropped without being decoded at all."])

    sheet.text((66, 1400), "REPORT   client → server   ·   29 bytes and up to 100 needs",
               size=16, bold=True)
    strip(sheet, 66, 1428, 1100, [
        ("header", 16, WASH, 90), ("echo", 4, PAPER, 44), ("hold", 4, PAPER, 44),
        ("received", 4, PAPER, 60), ("highest", 4, PAPER, 56), ("credit", 4, PAPER, 50),
        ("epoch", 4, PAPER, 50), ("part", 2, PAPER, 38), ("cut", 1, PAPER, 30),
        ("n", 2, PAPER, 26), ("unit, block, how many more … × n", 8, (233, 240, 250), 240)])

    note(sheet, (1220, 1400, 2340, 1530),
         ["CONTROL   client → server   ·   16 B header, then a whole message of the ordinary",
          "protocol - hello, open, view - carried unchanged, which is why the session layer",
          "does not know which transport it is running on.",
          "",
          "No packet type for an acknowledgement exists. There is nowhere to put one."])

    # ---------------------------------------------------------------- 3. FEC
    band(sheet, 1590, 2760, "3", "The erasure code: how a unit survives loss",
         "The part that replaces retransmission. Worked through on a real tile - the eye of the "
         "Holbein portrait, 17,736 bytes, at the finest level.", accent=True)
    at = badge(sheet, 1090, 1602, "this is the FEC")
    badge(sheet, at + 14, 1602, "366 lines of Java, and 123 of test", colour=DIM)

    # ---- 1 cut
    step(sheet, 66, 1690, 1, "Cut the unit into symbols")
    sheet.text((66, 1738), "17,736 bytes ÷ 1,200 = 15 symbols. The last one is short and padded.",
               size=15)
    sheet.text((66, 1762), "Symbols 0 to 14 are the unit's own bytes. That matters: a path that",
               size=15)
    sheet.text((66, 1784), "loses nothing does no arithmetic at all, at either end.", size=15)

    for i in range(15):
        x = 66 + i * 52
        sheet.rect((x, 1820, x + 46, 1866), outline=RULE, fill=PAPER, radius=4)
        sheet.text((x + 23, 1832), f"s{i}", size=14, bold=True, anchor="ma")
    sheet.text((66, 1876), "the bytes themselves - \"systematic\"", size=13, fill=DIM)

    for i in range(3):
        x = 66 + (15 + i) * 52 + 16
        sheet.rect((x, 1820, x + 46, 1866), outline=REPAIR, fill=(228, 238, 252), radius=4)
        sheet.text((x + 23, 1832), f"r{i}", size=14, bold=True, anchor="ma", fill=REPAIR)
    sheet.text((66 + 15 * 52 + 16, 1876), "mixtures, endless", size=13, fill=REPAIR)

    # ---- 2 mix
    step(sheet, 66, 1930, 2, "Every mixture is one equation")
    sheet.text((66, 1984), "r0  =  c0·s0  +  c1·s1  +  …  +  c14·s14",
               size=19, bold=True, fill=REPAIR)
    sheet.text((66, 2020), "the real coefficients of symbol 15:   98  126  236  8  255  184  174  107 …",
               size=15)
    sheet.text((66, 2046), "and for the first byte of each:   98·255 + 126·104 + 236·229 + … = 61",
               size=15)
    sheet.text((66, 2080), "Addition is exclusive-or. Multiplication is the Reed-Solomon one: "
               "a field of 256 elements,", size=15, fill=DIM)
    sheet.text((66, 2102), "polynomial 0x11D, a 64 KB table, one array lookup per byte.",
               size=15, fill=DIM)
    sheet.text((66, 2134), "The coefficients come from the symbol's own number through a fixed "
               "mixer, so both ends", size=15, fill=DIM)
    sheet.text((66, 2156), "generate the same ones and no packet ever carries a coefficient. "
               "None is ever zero: a zero", size=15, fill=DIM)
    sheet.text((66, 2178), "would quietly drop a symbol out of the mixture.", size=15, fill=DIM)

    # ---- 3 lose
    step(sheet, 1300, 1690, 3, "Three go missing on the way")
    for i in range(15):
        x = 1300 + (i % 8) * 64
        y = 1748 + (i // 8) * 58
        lost = i in (3, 11, 12)
        sheet.rect((x, y, x + 54, y + 44), outline=LOST if lost else RULE,
                   fill=(253, 240, 240) if lost else PAPER, radius=4)
        sheet.text((x + 27, y + 12), f"s{i}", size=14, bold=True, anchor="ma",
                   fill=LOST if lost else INK)
        if lost:
            sheet.line((x + 8, y + 8), (x + 46, y + 36), fill=LOST, width=2)
            sheet.line((x + 46, y + 8), (x + 8, y + 36), fill=LOST, width=2)

    # ---- 4 ask
    step(sheet, 1300, 1880, 4, "The receiver asks for a number")
    sheet.rect((1300, 1930, 2080, 1986), outline=OURS, fill=(238, 248, 242), radius=8)
    sheet.text((1320, 1946), "\"unit 42, block 0 — three more\"", size=18, bold=True, fill=OURS)
    sheet.text((1300, 2000), "Not which ones. It does not know which they were, and it does not "
               "need to:", size=15)
    sheet.text((1300, 2022), "it only counts how many equations it is short of.", size=15)

    # ---- 5 rebuild
    step(sheet, 1300, 2060, 5, "Any three mixtures rebuild it")
    for i in range(3):
        x = 1300 + i * 64
        sheet.rect((x, 2110, x + 54, 2154), outline=REPAIR, fill=(228, 238, 252), radius=4)
        sheet.text((x + 27, 2122), f"r{i}", size=14, bold=True, anchor="ma", fill=REPAIR)
    sheet.arrow((1490, 2132), (1540, 2132), fill=DIM)
    sheet.rect((1560, 2110, 1960, 2154), outline=KEPT, fill=(238, 248, 242), radius=4)
    sheet.text((1760, 2122), "the unit, byte for byte", size=15, bold=True, anchor="ma", fill=KEPT)

    note(sheet, (1300, 2180, 2340, 2330),
         ["Fifteen unknowns, and every symbol that arrives is one equation in them. Each is",
          "eliminated against the ones already held as it arrives, so the work is spread over the",
          "transfer instead of landing in a lump at the end, and a symbol that teaches nothing new",
          "is recognised and thrown away on the spot.",
          "",
          "Fifteen independent equations and the unit falls out. 0.4 ms for a 60 KB unit."])

    # ---- the cost, and where it lives
    sheet.text((66, 2230), "What the repair costs, measured", size=18, bold=True)
    columns = [("path loses", "0%", "5%", "10%", "20%", "40%"),
               ("symbols sent beyond the minimum", "0%", "6%", "12%", "28%", "86%")]
    for row, (head, *values) in enumerate(columns):
        y = 2270 + row * 32
        sheet.text((66, y), head, size=15, bold=(row == 0), fill=DIM if row == 0 else INK)
        for col, value in enumerate(values):
            sheet.text((620 + col * 116, y), value, size=15,
                       bold=(row == 1), fill=INK if row else DIM)
    sheet.text((66, 2340), "No symbol was ever wasted at any of those rates: every one that "
               "arrived added something", size=15, fill=DIM)
    sheet.text((66, 2362), "the receiver did not already have. The sender picks how many to send "
               "from the loss the", size=15, fill=DIM)
    sheet.text((66, 2384), "receiver reports, so redundancy is paid only where the path loses "
               "packets.", size=15, fill=DIM)

    note(sheet, (66, 2430, 1180, 2600),
         ["Where it lives:",
          "p2/fec/Galois.java          70 lines   the field: one table, two operations",
          "p2/fec/Block.java           76 lines   how a message is cut, and the coefficients",
          "p2/fec/BlockDecoder.java   100 lines   elimination as symbols arrive",
          "p2/fec/MessageCodec.java   120 lines   the encoder and the receiving half",
          "p2/fec/FecSelfTest.java    123 lines   encode, drop at random, check byte for byte"])

    note(sheet, (1220, 2430, 2340, 2600),
         ["Why not just ask for the packet that was lost?",
          "Because by the time the request arrives the view may be gone - and because any",
          "mixture answers any gap. One spare symbol covers whichever of the fifteen went",
          "missing, so the sender never has to keep particular packets to hand, and the",
          "receiver never has to name them. That is the whole reason there is no NAK, no",
          "selective repeat and no acknowledgement anywhere in this protocol."])

    note(sheet, (66, 2630, 2340, 2740),
         ["How to tell it in five sentences:",
          "1 · A unit is cut into 1,200-byte symbols, and the first ones are simply its own bytes.   "
          "2 · Beyond those, the sender can make endless mixtures of them, each one an equation.",
          "3 · Whatever is lost, the receiver counts how many equations it is short of and asks for "
          "that many - never for particular packets.   4 · Any mixtures will do, because any k",
          "independent equations solve k unknowns.   5 · So loss is repaired without anything "
          "being sent twice, and without either end tracking what went missing."])

    # ---------------------------------------------------------------- 4. staying in step
    band(sheet, 2790, 3220, "4", "Staying in step, with nothing acknowledged",
         "Three rules do the work that acknowledgements usually do. Each was wrong once, and "
         "the mistake is written beside it.")

    note(sheet, (66, 2880, 810, 3160),
         ["A gap is not a loss:",
          "While symbols are still arriving, what is",
          "missing is on its way. The receiver asks",
          "only after a unit has gone quiet for about",
          "a round trip, and not again until another",
          "has passed.",
          "",
          "Got wrong: asking as soon as a hole",
          "appeared doubled the traffic - 102%",
          "overhead on a path losing nothing."])

    note(sheet, (850, 2880, 1594, 3160),
         ["Silence means delivered:",
          "A unit is finished when the receiver stops",
          "naming it. So the receiver names every unit",
          "it holds, every time - with a count of zero",
          "for the ones it is not asking about yet -",
          "and says when its list had to be cut short.",
          "",
          "Got wrong: staying quiet about a unit to",
          "save room lost it for good. The sender",
          "freed it, and the request that followed",
          "found nothing left to answer it."])

    note(sheet, (1634, 2880, 2340, 3160),
         ["The epoch is shared:",
          "The client raises it on every view. Both",
          "ends drop everything older, and the report",
          "carries it, so the sender knows what the",
          "receiver threw away and offers it again.",
          "",
          "Got wrong: only the receiver applied the",
          "rule. The sender read its silence as",
          "delivery and left holes on the screen that",
          "nothing would ever fill - 5 tiles of 15,",
          "still missing after four seconds."])

    out = args.out
    os.makedirs(os.path.dirname(os.path.abspath(out)), exist_ok=True)
    sheet.save(out)
    print(f"wrote {out}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
