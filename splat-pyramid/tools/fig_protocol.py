"""
The protocol's algorithms, one row per step, in the order a unit meets them on its way from
the server to the viewer.

  python3 tools/fig_protocol.py [--lang es] [--out docs/protocol.png]
"""

import argparse
import os

from figkit import BAND, DIM, INK, OURS, RULE, Sheet

W = 2400
MAIN = (28, 130, 76)
SUPPORT = (60, 60, 66)

# (step, algorithm, what it does, main?)
ROWS = [
    ("1. Decide what to send", "Job plan with epochs (own)",
     "Each VIEW builds a plan: splat chunks first, then tiles. A new VIEW cancels the old plan. "
     "The base unit is always repaired first, and tile repairs come before background chunks.", False),
    ("2. Serve several users", "Physarum",
     "Each cached unit is a node whose conductance is the data flowing out of it to anyone; the cache "
     "evicts the least conductance per byte. Each user is a tube that grows with useful flow (data sent "
     "whole while still wanted); when the server's upload is the limit, it is shared by tube size.", False),
    ("3. Not look like a DDoS", "Per-client message limit",
     "60 messages/s per client, bursts of 120.", False),
    ("4. How fast to send", "Run-and-tumble (own, main)",
     "Like a bacterium: it keeps \"running\" at a rate while the score improves and \"tumbles\" to a new "
     "rate when it gets worse. Score = sent rate × e^(−queue delay / 80 ms). It starts at 4 Mbit/s "
     "and cuts hard if delay passes 150 ms.", True),
    ("5. Spread the packets out", "Token-bucket pacing with overdraft",
     "Sends at the rate the tumbler chose, with no bursts.", False),
    ("6. Splats on the wire", "Confetti delivery (own, main)",
     "A unit's blobs are dealt across its packets like cards. Any subset of packets still draws the "
     "whole unit, only softer, so a lost packet leaves blur, not a hole.", True),
    ("7. Repair losses", "Rateless erasure code over GF(256) (own, from v1)",
     "The client only reports how many packets arrived per block. The server sends new combined "
     "packets until the count is enough, and never resends a specific packet.", False),
    ("8. Client feedback", "Count-only REPORT, plus retries of HELLO/OPEN/VIEW",
     "Received counts, bytes and one-way delay (from the header's sentAt) are what feed the tumbler.", False),
    ("9. Memory in the browser", "Forgetting curve (Ebbinghaus)",
     "Each cached unit is a memory that fades unless it's on screen. Coming back after time away "
     "makes it last longer, and coarse levels start out lasting longer. When the 32 MB budget is "
     "full, the least remembered per byte goes. A second level of 48 MB keeps evicted data compressed.", False),
]

SPANISH = {
    "The protocol's algorithms": "Los algoritmos del protocolo",
    "From the server to the client: each step a piece of data meets on its way to the screen.":
        "Del servidor al cliente: cada paso que recorre un dato en su camino a la pantalla.",
    "step": "paso", "algorithm": "algoritmo", "what it does in the project": "qué hace en el proyecto",
    "main algorithm": "algoritmo principal", "server": "servidor", "client": "cliente",
    "1. Decide what to send": "1. Decidir qué enviar",
    "Job plan with epochs (own)": "Plan de trabajo con épocas (propio)",
    "Each VIEW builds a plan: splat chunks first, then tiles. A new VIEW cancels the old plan. "
    "The base unit is always repaired first, and tile repairs come before background chunks.":
        "Cada VIEW arma un plan: primero los bloques de splats, luego las teselas. Un VIEW nuevo cancela "
        "el plan anterior. La unidad base siempre se repara primero, y la reparación de teselas va antes "
        "que los bloques de fondo.",
    "2. Serve several users": "2. Atender a varios usuarios",
    "Physarum": "Physarum (moho mucilaginoso)",
    "Each cached unit is a node whose conductance is the data flowing out of it to anyone; the cache "
    "evicts the least conductance per byte. Each user is a tube that grows with useful flow (data sent "
    "whole while still wanted); when the server's upload is the limit, it is shared by tube size.":
        "Cada unidad en caché es un nodo cuya conductancia es el flujo de datos que sale de ella hacia "
        "cualquiera; la caché desaloja la de menor conductancia por byte. Cada usuario es un tubo que crece "
        "con el flujo útil (datos enviados completos mientras aún se querían); cuando la subida del "
        "servidor es el límite, se reparte según el tamaño del tubo.",
    "3. Not look like a DDoS": "3. No parecer un DDoS",
    "Per-client message limit": "Límite de mensajes por cliente",
    "60 messages/s per client, bursts of 120.": "60 mensajes/s por cliente, ráfagas de 120.",
    "4. How fast to send": "4. Qué tan rápido enviar",
    "Run-and-tumble (own, main)": "Run-and-tumble (propio, principal)",
    "Like a bacterium: it keeps \"running\" at a rate while the score improves and \"tumbles\" to a new "
    "rate when it gets worse. Score = sent rate × e^(−queue delay / 80 ms). It starts at 4 Mbit/s "
    "and cuts hard if delay passes 150 ms.":
        "Como una bacteria: sigue \"nadando\" a una tasa mientras el puntaje mejora y \"da un tumbo\" hacia "
        "una tasa nueva cuando empeora. Puntaje = tasa enviada × e^(−retardo de cola / 80 ms). Empieza en "
        "4 Mbit/s y recorta fuerte si el retardo pasa de 150 ms.",
    "5. Spread the packets out": "5. Espaciar los paquetes",
    "Token-bucket pacing with overdraft": "Ritmo por cubeta de fichas, con sobregiro",
    "Sends at the rate the tumbler chose, with no bursts.":
        "Envía a la tasa que eligió el run-and-tumble, sin ráfagas.",
    "6. Splats on the wire": "6. Splats en la red",
    "Confetti delivery (own, main)": "Entrega confeti (propio, principal)",
    "A unit's blobs are dealt across its packets like cards. Any subset of packets still draws the "
    "whole unit, only softer, so a lost packet leaves blur, not a hole.":
        "Las manchas de una unidad se reparten entre sus paquetes como cartas. Cualquier subconjunto de "
        "paquetes dibuja la unidad completa, solo más suave: un paquete perdido deja desenfoque, no un hueco.",
    "7. Repair losses": "7. Reparar pérdidas",
    "Rateless erasure code over GF(256) (own, from v1)": "Código de borrado sin tasa sobre GF(256) (propio, de v1)",
    "The client only reports how many packets arrived per block. The server sends new combined "
    "packets until the count is enough, and never resends a specific packet.":
        "El cliente solo reporta cuántos paquetes llegaron por bloque. El servidor envía paquetes "
        "combinados nuevos hasta que la cuenta alcanza, y nunca reenvía un paquete específico.",
    "8. Client feedback": "8. Retroalimentación del cliente",
    "Count-only REPORT, plus retries of HELLO/OPEN/VIEW": "REPORT solo con cuentas, más reintentos de HELLO/OPEN/VIEW",
    "Received counts, bytes and one-way delay (from the header's sentAt) are what feed the tumbler.":
        "Las cuentas recibidas, los bytes y el retardo de ida (del sentAt de la cabecera) alimentan al "
        "run-and-tumble.",
    "9. Memory in the browser": "9. Memoria en el navegador",
    "Forgetting curve (Ebbinghaus)": "Curva del olvido (Ebbinghaus)",
    "Each cached unit is a memory that fades unless it's on screen. Coming back after time away "
    "makes it last longer, and coarse levels start out lasting longer. When the 32 MB budget is "
    "full, the least remembered per byte goes. A second level of 48 MB keeps evicted data compressed.":
        "Cada unidad en caché es un recuerdo que se desvanece si no está en pantalla. Volver a ella tras "
        "un tiempo hace que dure más, y los niveles gruesos empiezan durando más. Cuando el presupuesto de "
        "32 MB se llena, sale la menos recordada por byte. Un segundo nivel de 48 MB guarda comprimido lo "
        "desalojado.",
}


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--lang", default="en", choices=("en", "es"))
    ap.add_argument("--out")
    args = ap.parse_args()
    out = args.out or os.path.join(os.path.dirname(__file__), "..", "docs",
                                   "protocol.png" if args.lang == "en" else "protocol-es.png")

    # columns: rail, step, algorithm, what
    X_RAIL, X_STEP, X_ALG, X_WHAT, X_END = 60, 150, 560, 1120, W - 60
    PAD, LINE = 18, 26

    probe = Sheet(W, 100, SPANISH if args.lang == "es" else None)
    heights = []
    for step, alg, what, main_ in ROWS:
        n = max(len(probe.wrap(step, X_ALG - X_STEP - 30, 19, True)),
                len(probe.wrap(alg, X_WHAT - X_ALG - 30, 19, True)),
                len(probe.wrap(what, X_END - X_WHAT - 30, 17)))
        heights.append(max(1, n) * LINE + 2 * PAD)
    top = 200
    H = top + sum(heights) + 90

    s = Sheet(W, H, SPANISH if args.lang == "es" else None)
    s.text((60, 40), "The protocol's algorithms", size=34, bold=True)
    s.text((60, 84), "From the server to the client: each step a piece of data meets on its way to the screen.",
           size=17, fill=DIM)
    # legend
    s.rect((W - 360, 44, W - 340, 64), outline=None, fill=MAIN, radius=3)
    s.text((W - 330, 44), "main algorithm", size=16, fill=DIM)

    # header row
    s.text((X_STEP, top - 38), "step", size=15, bold=True, fill=DIM)
    s.text((X_ALG, top - 38), "algorithm", size=15, bold=True, fill=DIM)
    s.text((X_WHAT, top - 38), "what it does in the project", size=15, bold=True, fill=DIM)
    s.line((X_STEP, top - 8), (X_END, top - 8), fill=INK, width=2)

    y = top
    for i, ((step, alg, what, main_), h) in enumerate(zip(ROWS, heights)):
        if main_:
            s.rect((X_STEP - 10, y + 3, X_END, y + h - 3), outline=None, fill=(232, 245, 237), radius=8)
        elif i % 2:
            s.rect((X_STEP - 10, y + 3, X_END, y + h - 3), outline=None, fill=BAND, radius=8)
        for j, line in enumerate(s.wrap(step, X_ALG - X_STEP - 30, 19, True)):
            s.text((X_STEP, y + PAD + j * LINE), line, size=19, bold=True, raw=True)
        for j, line in enumerate(s.wrap(alg, X_WHAT - X_ALG - 30, 19, True)):
            s.text((X_ALG, y + PAD + j * LINE), line, size=19, bold=True, fill=MAIN if main_ else SUPPORT, raw=True)
        for j, line in enumerate(s.wrap(what, X_END - X_WHAT - 30, 17)):
            s.text((X_WHAT, y + PAD + 1 + j * LINE), line, size=17, raw=True)
        y += h
        s.line((X_STEP, y), (X_END, y), fill=RULE)

    # the rail: server at the top, client at the bottom
    s.text((X_RAIL + 20, top + 4), "server", size=15, bold=True, fill=DIM, anchor="ma")
    s.arrow((X_RAIL + 20, top + 32), (X_RAIL + 20, y - 34), fill=RULE, width=4, head=14)
    s.text((X_RAIL + 20, y - 26), "client", size=15, bold=True, fill=DIM, anchor="ma")
    s.save(out)
    print(f"wrote {out}")


if __name__ == "__main__":
    main()
