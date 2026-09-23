#!/usr/bin/env python3
"""
The two figures in Spanish.

Every line of text on both figures passes through one call, so one lookup there is the whole
translation and there is no second copy of either drawing to keep in step. The line breaks are
fixed by the drawing, so each Spanish line has to fit where the English one was: that is why
some of these are recast rather than translated word for word.

Anything with no entry here is drawn in English and reported when the figure is made.
"""

WORDS = {
    # ------------------------------------------------------------------ pipeline: heading
    "From the file to the screen": "Del archivo a la pantalla",
    "Every stage of PROJECT02, and what each one is built out of. Green is code written for "
    "this project; amber is a library doing the work.":
        "Cada etapa de PROJECT02 y de qué está hecha. En verde, código escrito para este "
        "proyecto; en ámbar, una biblioteca haciendo el trabajo.",
    "measured on holbein_8000.jpg  ·  7,011 × 8,000  ·  56 megapixels":
        "medido sobre holbein_8000.jpg  ·  7.011 × 8.000  ·  56 megapíxeles",
    "and eso1242a.tif  ·  25,000 × 18,832  ·  470 megapixels":
        "y eso1242a.tif  ·  25.000 × 18.832  ·  470 megapíxeles",

    # ------------------------------------------------------------------ pipeline: 1
    "1 · Preparation": "1 · Preparación",
    "The image is cut up once, before anyone looks at it. Nothing here happens while a viewer "
    "waits.":
        "La imagen se trocea una sola vez, antes de que nadie la mire. Nada de esto ocurre "
        "mientras alguien espera.",
    "once per image  ·  15 min 22 s for 470 megapixels":
        "una vez por imagen  ·  15 min 22 s para 470 megapíxeles",
    "the file on disk": "el archivo en disco",
    "1.5 GB TIFF / 13 MB JPEG": "TIFF de 1,5 GB / JPEG de 13 MB",
    "or": "o",

    "Read in strips": "Leer por franjas",
    "The source never fits in memory, so it": "El original no cabe en memoria, así que se lee",
    "is read a band at a time, and each band": "una franja a la vez, y cada franja se corta",
    "is cut into tiles before the next is read.": "en teselas antes de leer la siguiente.",
    "470 megapixels in 1.5 GB of memory.": "470 megapíxeles con 1,5 GB de memoria.",

    "A ladder of levels": "Una escalera de niveles",
    "Each level is 1.25× smaller than the one": "Cada nivel es 1,25× más pequeño que el",
    "below it - not 2×. A view then always finds": "anterior, no 2×. Así una vista encuentra",
    "a level within 12% of the size it wants,": "siempre un nivel a menos del 12% del tamaño",
    "so nothing is scaled far enough to blur.": "que quiere, y nada se escala hasta borrarse.",
    "eso1242a: 22 levels, 20,375 tiles, 713 MB.": "eso1242a: 22 niveles, 20.375 teselas, 713 MB.",

    "Tiles of 256 px": "Teselas de 256 px",
    "Small enough that one costs 13 KB and": "Pequeñas: una cuesta 13 KB y se decodifica",
    "decodes in a millisecond; large enough": "en un milisegundo. Grandes: una pantalla",
    "that a screenful is a dozen of them,": "entera son una docena de ellas,",
    "not a thousand.": "no un millar.",
    "JPEG, quality 0.85.": "JPEG, calidad 0,85.",

    "Or: fitted as splats": "O: ajustada como splats",
    "A second method, swappable with the first:": "Un segundo método, intercambiable con el",
    "each unit becomes 4,000 Gaussian blobs of": "primero: cada unidad son 4.000 manchas",
    "11 bytes each, fitted by gradient descent": "gaussianas de 11 bytes, ajustadas por",
    "on the GPU, and drawn as shapes instead": "descenso de gradiente en la GPU y dibujadas",
    "of pixels. 35.9 dB on a face, 40.0 on an eye.": "como formas. 35,9 dB en una cara, 40,0 en un ojo.",
    "p2.media.SplatMethod drives it": "p2.media.SplatMethod lo dirige",

    "one tile of the finest level": "una tesela del nivel más fino",

    # ------------------------------------------------------------------ pipeline: 2
    "2 · The protocol": "2 · El protocolo",
    "What the server decides, and how the bytes leave. No TCP, no HTTP, no library: sockets "
    "and our own rules.":
        "Qué decide el servidor y cómo salen los bytes. Sin TCP, sin HTTP, sin bibliotecas: "
        "sockets y nuestras propias reglas.",
    "per view  ·  43.9 mbit/s on a 50 mbit path":
        "por vista  ·  43,9 mbit/s en un enlace de 50 mbit",

    "Which units": "Qué unidades",
    "The viewer says where it is looking. The": "El visor dice dónde está mirando. El servidor",
    "server works out the level and the tiles that": "calcula el nivel y las teselas que lo cubren,",
    "cover it, nearest the middle first, and skips": "las del centro primero, y omite todo lo que",
    "everything the viewer already holds.": "el visor ya tiene.",
    "A move cancels the old view's work outright.": "Moverse cancela el trabajo de la vista anterior.",

    "Cut into symbols": "Cortar en símbolos",
    "Each unit is split into 1,200-byte symbols.": "Cada unidad se parte en símbolos de 1.200 B.",
    "The first ones are the unit's own bytes, so a": "Los primeros son sus propios bytes: un camino",
    "clean path does no arithmetic at all; beyond": "limpio no hace ni una operación. Más allá,",
    "those, endless repair symbols, each a mixture": "símbolos de reparación sin fin, cada uno una",
    "of the rest over a field of 256 elements.": "mezcla de los demás sobre un campo de 256.",
    "Any k of them rebuild the unit.": "k cualesquiera reconstruyen la unidad.",
    "p2.fec - GF(256), written here": "p2.fec - GF(256), escrito aquí",

    "Which one, how much, how fast": "Cuál, cuánto y a qué velocidad",
    "Earliest deadline first, visible work ahead of": "Plazo más cercano primero, lo visible antes",
    "guesses. Repair in proportion to the loss the": "que las conjeturas. Reparación en proporción",
    "far end reports. Speed set by how long packets": "a la pérdida informada. Velocidad según lo que",
    "are waiting, not by whether they are lost.": "esperan los paquetes, no si se pierden.",
    "3% overhead clean, 15% at 10% loss.": "3% de exceso limpio, 15% con 10% de pérdida.",

    "Datagrams": "Datagramas",
    "1,232 bytes: 16 of packet header, 16 saying": "1.232 bytes: 16 de cabecera, 16 que dicen qué",
    "which unit and symbol, 1,200 of payload.": "unidad y qué símbolo, 1.200 de carga útil.",
    "Nothing is ever split across two packets,": "Nada se parte entre dos paquetes, así que",
    "so nothing is lost in halves.": "nada se pierde por la mitad.",
    "No connection, no handshake underneath.": "Sin conexión ni saludo por debajo.",

    "A path that misbehaves": "Un camino que se porta mal",
    "Between the two ends, on purpose: loss,": "Entre los dos extremos, a propósito: pérdida,",
    "delay, jitter, reordering, duplication and a": "retardo, jitter, reordenado, duplicación y un",
    "narrow pipe, all reproducible from a flag.": "enlace estrecho, reproducible con una opción.",

    # ------------------------------------------------------------------ pipeline: 3
    "3 · The client": "3 · El cliente",
    "A browser cannot open a UDP socket, so it is not the client - it is the screen. The "
    "client is a Java process beside it.":
        "Un navegador no puede abrir un socket UDP, así que no es el cliente: es la pantalla. "
        "El cliente es un proceso Java a su lado.",
    "per frame  ·  60 fps, 12 tiles on screen": "por cuadro  ·  60 fps, 12 teselas en pantalla",

    "Rebuild": "Reconstruir",
    "Symbols arrive in any order and any subset.": "Los símbolos llegan en cualquier orden y",
    "Each one is eliminated against the ones": "cantidad. Cada uno se elimina contra los que",
    "already held; when k of them are in, the": "ya hay; cuando entran k, la unidad sale",
    "unit falls out whole.": "entera.",
    "A few times a second it says what it still": "Varias veces por segundo dice qué le falta:",
    "needs - a count, never a list of what was lost.": "una cuenta, nunca una lista de lo perdido.",

    "Hand it to the page": "Entregarlo a la página",
    "The rebuilt message goes to the browser": "El mensaje reconstruido va al navegador sin",
    "unchanged, over the WebSocket it is already": "tocar, por el WebSocket que ya está abierto.",
    "connected by. The bridge carries the protocol": "El puente transporta el protocolo sin",
    "without interpreting it.": "interpretarlo.",
    "Handshake and framing written here too.": "El saludo y el tramado también son nuestros.",

    "Draw": "Dibujar",
    "Tiles are decoded by the browser itself and": "Las teselas las decodifica el navegador y se",
    "drawn to a 2D canvas. Splats are drawn as": "pintan en un lienzo 2D. Los splats se dibujan",
    "shapes on the GPU, accumulated in a float": "como formas en la GPU, acumulados en un búfer",
    "buffer and divided through at the end.": "flotante y divididos al final.",
    "No framework, no library: one ES module.": "Sin framework ni bibliotecas: un módulo ES.",
    "what the viewer shows": "lo que muestra el visor",

    "What it costs": "Lo que cuesta",
    "50 MB of decoded tiles, then the least": "50 MB de teselas decodificadas; luego se tiran",
    "useful are dropped and the server told.": "las menos útiles y se le avisa al servidor.",
    "Memory stays flat however long you zoom:": "La memoria no crece por mucho zoom que hagas:",
    "the cache is a budget, not a heap.": "la caché es un presupuesto, no un montón.",

    # ------------------------------------------------------------------ protocol: heading
    "The protocol": "El protocolo",
    "How a session starts, what travels, how a unit survives loss, and how two ends stay in "
    "step with no acknowledgements at all.":
        "Cómo arranca una sesión, qué viaja, cómo sobrevive una unidad a la pérdida y cómo los "
        "dos extremos se mantienen en paso sin una sola confirmación.",
    "every number here was measured or taken from the running code":
        "todas las cifras están medidas o tomadas del código en ejecución",

    # ------------------------------------------------------------------ protocol: 1
    "1 · Starting a session": "1 · Arranque de sesión",
    "There is no handshake. Nothing is negotiated, nothing is agreed, and neither end waits "
    "for the other to be ready.":
        "No hay saludo inicial. Nada se negocia, nada se acuerda y ningún extremo espera a que "
        "el otro esté listo.",
    "Browser": "Navegador",
    "the screen · plain JavaScript": "la pantalla · JavaScript puro",
    "Client (bridge)": "Cliente (puente)",
    "holds the UDP socket · Java": "tiene el socket UDP · Java",
    "Server": "Servidor",
    "the image · Java": "la imagen · Java",

    "over the WebSocket": "por el WebSocket",
    "CONTROL packet: HELLO": "paquete CONTROL: HELLO",
    "the session is created by this packet arriving - no accept, no negotiation":
        "la sesión se crea porque llega este paquete: sin accept, sin negociación",
    "version, which image method": "versión y método de imagen",
    "the bridge now stops repeating HELLO": "el puente deja de repetir HELLO",
    "CONTROL packet: OPEN": "paquete CONTROL: OPEN",
    "7,011 × 8,000 · 2,503 units · 17 levels · tile size 256":
        "7.011 × 8.000 · 2.503 unidades · 17 niveles · tesela de 256",
    "and stops repeating OPEN": "y deja de repetir OPEN",
    "VIEW  epoch 1": "VIEW  época 1",
    "centre x, centre y, scale, screen size, units dropped since last time":
        "centro x, centro y, escala, tamaño de pantalla y unidades descartadas",
    "CONTROL packet: VIEW": "paquete CONTROL: VIEW",
    "repeated every 150 ms until an answer shows it arrived":
        "se repite cada 150 ms hasta que una respuesta demuestre que llegó",
    "as symbols, nearest the middle of the screen first":
        "como símbolos, las del centro de la pantalla primero",
    "what has arrived and what is still wanted  ·  every 10 ms, for as long as the session lasts":
        "qué ha llegado y qué falta  ·  cada 10 ms, mientras dure la sesión",

    "Repeated, not acknowledged:": "Se repiten, no se confirman:",
    "HELLO, OPEN and VIEW say how": "HELLO, OPEN y VIEW dicen cómo",
    "things are, not what happened,": "están las cosas, no qué pasó,",
    "so a lost one costs 150 ms and": "así que perder uno cuesta 150 ms",
    "nothing else.": "y nada más.",
    "The answer stops the repeating:": "La respuesta detiene la repetición:",
    "WELCOME stops HELLO, CHART": "WELCOME calla a HELLO, y CHART",
    "stops OPEN. VIEW keeps going -": "a OPEN. VIEW sigue siempre:",
    "it is also the keep-alive.": "también hace de latido.",

    "So a repeat must be harmless:": "Repetir debe ser inofensivo:",
    "the server remembers the last": "el servidor recuerda el último",
    "message of each kind and does": "mensaje de cada tipo y no hace",
    "nothing if it sees it again": "nada si lo vuelve a ver antes",
    "within a second.": "de un segundo.",
    "That check is per kind. Comparing": "La comprobación es por tipo:",
    "against whatever came last found": "compararlo con el último que",
    "a difference every time, and": "llegó daba distinto siempre y",
    "re-opened the image 7 times a": "reabría la imagen 7 veces por",
    "second until it was fixed.": "segundo hasta que se corrigió.",

    "No teardown either:": "Tampoco hay cierre:",
    "a session exists because packets": "una sesión existe porque llegan",
    "arrive from an address, and stops": "paquetes de una dirección, y deja",
    "existing 30 seconds after they": "de existir 30 segundos después",
    "stop. A viewer that vanishes": "de que paren. Un visor que",
    "costs one timeout.": "desaparece cuesta un timeout.",

    # ------------------------------------------------------------------ protocol: 2
    "2 · What actually travels": "2 · Qué viaja realmente",
    "Three kinds of packet. Nothing is ever split across two of them, so nothing arrives in "
    "halves.":
        "Tres tipos de paquete. Nada se parte entre dos, así que nada llega a medias.",
    "DATA   server → client   ·   1,232 bytes, the only packet carrying image bytes":
        "DATA   servidor → cliente   ·   1.232 bytes, el único que lleva bytes de imagen",
    "P 2 ver type": "P 2 ver tipo",
    "session": "sesión",
    "sequence": "secuencia",
    "epoch": "época",
    "unit": "unidad",
    "length": "largo",
    "block": "bloque",
    "sym": "símb",
    "one symbol of the unit": "un símbolo de la unidad",
    "packet header, 16 B": "cabecera de paquete, 16 B",
    "which unit and which symbol, 16 B": "qué unidad y qué símbolo, 16 B",
    "payload, 1,200 B": "carga útil, 1.200 B",

    "The sequence number does not order anything - the codec does not care what arrives":
        "El número de secuencia no ordena nada: al codec le da igual qué llega y en qué orden.",
    "or in what order. It is there to measure: 940 packets seen out of a highest number of":
        "Está para medir: 940 paquetes vistos frente a un máximo de 1.000 son un 6% de pérdida,",
    "1,000 is 6% loss, without either end tracking which ones those were.":
        "sin que ninguno de los dos extremos apunte cuáles fueron.",
    "The microsecond stamp is echoed back, and what comes back is the round trip.":
        "La marca en microsegundos vuelve como eco, y lo que vuelve es el viaje de ida y vuelta.",
    "The epoch sits outside the coded bytes so a symbol for a view the viewer has already":
        "La época va fuera de los bytes codificados: un símbolo de una vista ya abandonada se",
    "left is dropped without being decoded at all.":
        "descarta sin llegar a decodificarlo.",

    "REPORT   client → server   ·   29 bytes and up to 100 needs":
        "REPORT   cliente → servidor   ·   29 bytes y hasta 100 peticiones",
    "header": "cabecera",
    "echo": "eco",
    "hold": "espera",
    "received": "recibidos",
    "highest": "máximo",
    "credit": "crédito",
    "part": "parc",
    "cut": "cort",
    "unit, block, how many more … × n": "unidad, bloque, cuántos más … × n",

    "CONTROL   client → server   ·   16 B header, then a whole message of the ordinary":
        "CONTROL   cliente → servidor   ·   16 B de cabecera y un mensaje completo del",
    "protocol - hello, open, view - carried unchanged, which is why the session layer":
        "protocolo corriente - hello, open, view - transportado sin tocar: por eso la capa de",
    "does not know which transport it is running on.":
        "sesión no sabe sobre qué transporte está corriendo.",
    "No packet type for an acknowledgement exists. There is nowhere to put one.":
        "No existe un tipo de paquete para confirmar. No hay dónde ponerlo.",

    # ------------------------------------------------------------------ protocol: 3
    "3 · The erasure code: how a unit survives loss":
        "3 · El código de borrado: cómo sobrevive una unidad a la pérdida",
    "The part that replaces retransmission. Worked through on a real tile - the eye of the "
    "Holbein portrait, 17,736 bytes, at the finest level.":
        "La parte que sustituye a la retransmisión. Resuelto sobre una tesela real: el ojo del "
        "retrato de Holbein, 17.736 bytes, en el nivel más fino.",
    "this is the FEC": "esto es el FEC",
    "366 lines of Java, and 123 of test": "366 líneas de Java y 123 de prueba",

    "Cut the unit into symbols": "Cortar la unidad en símbolos",
    "17,736 bytes ÷ 1,200 = 15 symbols. The last one is short and padded.":
        "17.736 bytes ÷ 1.200 = 15 símbolos. El último va corto y relleno.",
    "Symbols 0 to 14 are the unit's own bytes. That matters: a path that":
        "Los símbolos 0 a 14 son los bytes de la unidad. Importa: un camino",
    "loses nothing does no arithmetic at all, at either end.":
        "sin pérdida no hace ni una operación, en ninguno de los extremos.",
    'the bytes themselves - "systematic"': 'los bytes tal cual - "sistemático"',
    "mixtures, endless": "mezclas, sin fin",

    "Every mixture is one equation": "Cada mezcla es una ecuación",
    "the real coefficients of symbol 15:   98  126  236  8  255  184  174  107 …":
        "los coeficientes reales del símbolo 15:   98  126  236  8  255  184  174  107 …",
    "and for the first byte of each:   98·255 + 126·104 + 236·229 + … = 61":
        "y para el primer byte de cada uno:   98·255 + 126·104 + 236·229 + … = 61",
    "Addition is exclusive-or. Multiplication is the Reed-Solomon one: a field of 256 elements,":
        "La suma es un o-exclusivo. La multiplicación es la de Reed-Solomon: un campo de 256",
    "polynomial 0x11D, a 64 KB table, one array lookup per byte.":
        "elementos, polinomio 0x11D, una tabla de 64 KB, un acceso por byte.",
    "The coefficients come from the symbol's own number through a fixed mixer, so both ends":
        "Los coeficientes salen del número del propio símbolo con un mezclador fijo, así que los",
    "generate the same ones and no packet ever carries a coefficient. None is ever zero: a zero":
        "dos extremos generan los mismos y ningún paquete lleva coeficientes. Ninguno es cero:",
    "would quietly drop a symbol out of the mixture.":
        "un cero sacaría en silencio un símbolo de la mezcla.",

    "Three go missing on the way": "Tres se pierden por el camino",
    "The receiver asks for a number": "El receptor pide un número",
    '"unit 42, block 0 — three more"': '"unidad 42, bloque 0 — tres más"',
    "Not which ones. It does not know which they were, and it does not need to:":
        "No cuáles. No sabe cuáles fueron, y tampoco le hace falta saberlo:",
    "it only counts how many equations it is short of.":
        "solo cuenta cuántas ecuaciones le faltan.",
    "Any three mixtures rebuild it": "Tres mezclas cualesquiera la reconstruyen",
    "the unit, byte for byte": "la unidad, byte a byte",

    "Fifteen unknowns, and every symbol that arrives is one equation in them. Each is":
        "Quince incógnitas, y cada símbolo que llega es una ecuación con ellas. Cada uno se",
    "eliminated against the ones already held as it arrives, so the work is spread over the":
        "elimina contra los que ya hay según llega, así que el trabajo se reparte durante la",
    "transfer instead of landing in a lump at the end, and a symbol that teaches nothing new":
        "transferencia en vez de caer de golpe al final, y un símbolo que no aporta nada nuevo",
    "is recognised and thrown away on the spot.":
        "se reconoce y se descarta en el acto.",
    "Fifteen independent equations and the unit falls out. 0.4 ms for a 60 KB unit.":
        "Quince ecuaciones independientes y la unidad sale sola. 0,4 ms para una de 60 KB.",

    "What the repair costs, measured": "Lo que cuesta la reparación, medido",
    "path loses": "el camino pierde",
    "symbols sent beyond the minimum": "símbolos enviados por encima del mínimo",
    "No symbol was ever wasted at any of those rates: every one that arrived added something":
        "Ningún símbolo se desperdició en ninguna de esas tasas: todos los que llegaron aportaron",
    "the receiver did not already have. The sender picks how many to send from the loss the":
        "algo que el receptor no tenía. El emisor elige cuántos enviar según la pérdida que le",
    "receiver reports, so redundancy is paid only where the path loses packets.":
        "informan, así que la redundancia se paga solo donde el camino pierde paquetes.",

    "Where it lives:": "Dónde vive:",
    "p2/fec/Galois.java          70 lines   the field: one table, two operations":
        "p2/fec/Galois.java          70 líneas   el campo: una tabla, dos operaciones",
    "p2/fec/Block.java           76 lines   how a message is cut, and the coefficients":
        "p2/fec/Block.java           76 líneas   cómo se corta un mensaje y los coeficientes",
    "p2/fec/BlockDecoder.java   100 lines   elimination as symbols arrive":
        "p2/fec/BlockDecoder.java   100 líneas   eliminación según llegan los símbolos",
    "p2/fec/MessageCodec.java   120 lines   the encoder and the receiving half":
        "p2/fec/MessageCodec.java   120 líneas   el codificador y la mitad receptora",
    "p2/fec/FecSelfTest.java    123 lines   encode, drop at random, check byte for byte":
        "p2/fec/FecSelfTest.java    123 líneas   codificar, tirar al azar, verificar byte a byte",

    "Why not just ask for the packet that was lost?":
        "¿Por qué no pedir sin más el paquete que se perdió?",
    "Because by the time the request arrives the view may be gone - and because any":
        "Porque cuando la petición llegue puede que la vista ya no exista, y porque cualquier",
    "mixture answers any gap. One spare symbol covers whichever of the fifteen went":
        "mezcla tapa cualquier hueco. Un símbolo de más cubre cualquiera de los quince que",
    "missing, so the sender never has to keep particular packets to hand, and the":
        "falte, así que el emisor nunca guarda paquetes concretos y el receptor nunca tiene",
    "receiver never has to name them. That is the whole reason there is no NAK, no":
        "que nombrarlos. Esa es toda la razón de que aquí no haya NAK, ni repetición",
    "selective repeat and no acknowledgement anywhere in this protocol.":
        "selectiva, ni confirmación en ninguna parte de este protocolo.",

    "How to tell it in five sentences:": "Cómo contarlo en cinco frases:",
    "1 · A unit is cut into 1,200-byte symbols, and the first ones are simply its own bytes.   "
    "2 · Beyond those, the sender can make endless mixtures of them, each one an equation.":
        "1 · La unidad se corta en símbolos de 1.200 bytes, y los primeros son sencillamente sus "
        "propios bytes.   2 · Más allá, el emisor puede hacer mezclas sin fin, cada una una ecuación.",
    "3 · Whatever is lost, the receiver counts how many equations it is short of and asks for "
    "that many - never for particular packets.   4 · Any mixtures will do, because any k":
        "3 · Se pierda lo que se pierda, el receptor cuenta cuántas ecuaciones le faltan y pide "
        "esa cantidad, nunca paquetes concretos.   4 · Sirve cualquier mezcla, porque k",
    "independent equations solve k unknowns.   5 · So loss is repaired without anything being "
    "sent twice, and without either end tracking what went missing.":
        "ecuaciones independientes resuelven k incógnitas.   5 · Así la pérdida se repara sin "
        "enviar nada dos veces y sin que ningún extremo lleve la cuenta de lo que faltó.",

    # ------------------------------------------------------------------ protocol: 4
    "4 · Staying in step, with nothing acknowledged":
        "4 · Mantenerse en paso, sin confirmar nada",
    "Three rules do the work that acknowledgements usually do. Each was wrong once, and the "
    "mistake is written beside it.":
        "Tres reglas hacen el trabajo que suelen hacer las confirmaciones. Cada una estuvo mal "
        "una vez, y el error está escrito al lado.",

    "A gap is not a loss:": "Un hueco no es una pérdida:",
    "While symbols are still arriving, what is": "Mientras sigan llegando símbolos, lo que",
    "missing is on its way. The receiver asks": "falta viene en camino. El receptor pregunta",
    "only after a unit has gone quiet for about": "solo cuando una unidad lleva callada",
    "a round trip, and not again until another": "un viaje de ida y vuelta, y no vuelve a",
    "has passed.": "hacerlo hasta que pase otro.",
    "Got wrong: asking as soon as a hole": "Lo tuvimos mal: preguntar en cuanto",
    "appeared doubled the traffic - 102%": "aparecía un hueco duplicaba el tráfico:",
    "overhead on a path losing nothing.": "102% de exceso sin perder ni un paquete.",

    "Silence means delivered:": "El silencio significa entregada:",
    "A unit is finished when the receiver stops": "Una unidad termina cuando el receptor deja",
    "naming it. So the receiver names every unit": "de nombrarla. Por eso nombra todas las que",
    "it holds, every time - with a count of zero": "tiene, siempre, con una cuenta de cero para",
    "for the ones it is not asking about yet -": "las que aún no pide, y avisa cuando su",
    "and says when its list had to be cut short.": "lista se quedó corta.",
    "Got wrong: staying quiet about a unit to": "Lo tuvimos mal: callar sobre una unidad",
    "save room lost it for good. The sender": "para ahorrar sitio la perdía para siempre.",
    "freed it, and the request that followed": "El emisor la liberaba y la petición que",
    "found nothing left to answer it.": "venía después no encontraba nada.",

    "The epoch is shared:": "La época es compartida:",
    "The client raises it on every view. Both": "El cliente la sube en cada vista. Los dos",
    "ends drop everything older, and the report": "extremos tiran lo más viejo, y el informe",
    "carries it, so the sender knows what the": "la lleva, así que el emisor sabe qué tiró",
    "receiver threw away and offers it again.": "el receptor y vuelve a ofrecerlo.",
    "Got wrong: only the receiver applied the": "Lo tuvimos mal: solo el receptor aplicaba",
    "rule. The sender read its silence as": "la regla. El emisor leía su silencio como",
    "delivery and left holes on the screen that": "entrega y dejaba huecos en la pantalla que",
    "nothing would ever fill - 5 tiles of 15,": "nada llenaría: 5 teselas de 15, seguían",
    "still missing after four seconds.": "faltando cuatro segundos después.",
}
