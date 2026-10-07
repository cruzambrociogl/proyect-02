# Mapa del código: dónde está cada cosa

Para cada mecanismo del [documento del protocolo](protocolo-sp.pdf), el archivo, la función y
la línea donde vive. Sigue el orden de las secciones del documento. Los números de línea
corresponden a la versión actual del código; si el archivo cambió, busca por el nombre de la
función.

## Los archivos, de un vistazo

| Carpeta | Archivo | Qué contiene |
| --- | --- | --- |
| `shared/` | [wire.ts](shared/wire.ts) | Cabecera, tipos de mensaje, `encode` y `decode` de cada mensaje de control |
| `shared/` | [units.ts](shared/units.ts) | Paquetes de datos: `CONFETTI` y `TILEPART`, y sus bloques |
| `shared/` | [fec.ts](shared/fec.ts) | Código de borrado sobre GF(256) |
| `shared/` | [emulator.ts](shared/emulator.ts) | Emulador de enlace (`--impair`): pérdida, retardo, cola |
| `server/` | [main.ts](server/main.ts) | Socket UDP, admisión, bucle de ritmo, fin de sesión |
| `server/` | [session.ts](server/session.ts) | Una sesión: mensajes, plan de envío, ventana, reparación, caché de paquetes |
| `server/` | [tumble.ts](server/tumble.ts) | *Slow start* y *run-and-tumble* |
| `server/` | [physarum.ts](server/physarum.ts) | Physarum: tubos por usuario y nodos de la caché |
| `server/` | [image.ts](server/image.ts) | Imagen preparada: niveles, `CHART`, qué unidades necesita una vista |
| `server/` | [admin.ts](server/admin.ts) | Sitio HTTP: lista, visor, `/admin`, carga y preparación |
| `client/` | [main.ts](client/main.ts) | *Client half*: WebSockets, una sesión por página, control de flujo, latido |
| `client/` | [link.ts](client/link.ts) | Lado cliente del protocolo: `ACK`, `REPORT`, reintentos, decodificación |
| `viewer/src/` | [viewer.ts](viewer/src/viewer.ts) | Visor WebGL: dibujo, zoom, conexión, reconexión |
| `viewer/src/` | [forgetting.ts](viewer/src/forgetting.ts) | Caché con curva del olvido |
| `splatpyr/` | [pyramid.py](splatpyr/pyramid.py), [fit.py](splatpyr/fit.py), [codec.py](splatpyr/codec.py), [detail.py](splatpyr/detail.py) | Preparación: pirámide de *tiles*, ajuste de *splats*, formato `.spx`, detalle real |

## 3. Arquitectura

| Qué | Dónde |
| --- | --- |
| El servidor sirve todas las páginas por HTTP (`/`, `/view`, `/admin`, scripts, miniaturas) | [server/admin.ts:48](server/admin.ts#L48) `startAdmin` |
| Una sesión del protocolo por página | [client/main.ts:106](client/main.ts#L106) `session` |
| Las dos rutas WebSocket, `/ws` y `/catalog` | [client/main.ts:207](client/main.ts#L207) |
| Solo se aceptan páginas del servidor o de la propia máquina | [client/main.ts:172](client/main.ts#L172) `originAllowed` |
| Socket UDP del servidor: recibe cada datagrama | [server/main.ts:104](server/main.ts#L104) |

## 4. Representación de la imagen

| Qué | Dónde |
| --- | --- |
| Corte de la pirámide de *tiles* (libvips, en *streaming*) | [splatpyr/pyramid.py:105](splatpyr/pyramid.py#L105) `ingest`, [:270](splatpyr/pyramid.py#L270) `_ingest_vips` |
| JPEG o WebP sin pérdida, el menor | [splatpyr/pyramid.py:59](splatpyr/pyramid.py#L59) `encode_tile`, [:75](splatpyr/pyramid.py#L75) `_choose` |
| Lectura de archivos PSB | [splatpyr/pyramid.py:181](splatpyr/pyramid.py#L181) `_psd_open` |
| Ajuste de los *splats* de una unidad | [splatpyr/fit.py:70](splatpyr/fit.py#L70) `fit_unit` |
| *Blob* de 11 bytes y archivo `.spx` (*chunks*, orden Morton, zlib) | [splatpyr/codec.py:71](splatpyr/codec.py#L71) `to_codes`, [:102](splatpyr/codec.py#L102) `encode` |
| Detalle real (*detail scale*), umbral de 30 dB | [splatpyr/detail.py:41](splatpyr/detail.py#L41) `measure` |
| Límite de zoom en el visor | [viewer/src/viewer.ts:56](viewer/src/viewer.ts#L56) `magnifyLimit` |

## 5. Formato de los mensajes

| Qué | Dónde |
| --- | --- |
| Versión 2, cabecera de 20 bytes, máximo 1,200 bytes | [shared/wire.ts:19](shared/wire.ts#L19) `VERSION`, `HEADER`, `MAX_DATAGRAM` |
| Los 15 tipos de mensaje | [shared/wire.ts:27](shared/wire.ts#L27) `Type` |
| Escribir y leer la cabecera | [shared/wire.ts:49](shared/wire.ts#L49) `encode`, [:81](shared/wire.ts#L81) `decode` |
| Versión distinta: se informa y no se procesa | [shared/wire.ts:76](shared/wire.ts#L76) `versionOf`, [server/main.ts:108](server/main.ts#L108) |
| `VIEW` (con las listas de descartadas y conservadas) | [shared/wire.ts:145](shared/wire.ts#L145) `encodeView`, [:164](shared/wire.ts#L164) `decodeView` |
| `REPORT` | [shared/wire.ts:217](shared/wire.ts#L217) `encodeReport`, [:241](shared/wire.ts#L241) `decodeReport` |
| `ACK`, 22 bytes | [shared/wire.ts:279](shared/wire.ts#L279) `encodeAck`, [:290](shared/wire.ts#L290) `decodeAck` |
| `REPAIR` | [shared/wire.ts:311](shared/wire.ts#L311) `encodeRepair`, [:325](shared/wire.ts#L325) `decodeRepair` |
| `CATALOG` en partes | [shared/wire.ts:340](shared/wire.ts#L340) `encodeCatalog` |
| `CHART` (JSON con la forma de la imagen) | [server/image.ts:22](server/image.ts#L22) `Chart` |
| `CONFETTI` | [shared/units.ts:134](shared/units.ts#L134) `confetti` |
| `TILEPART` | [shared/units.ts:172](shared/units.ts#L172) `tileParts`, [:203](shared/units.ts#L203) `readTilePart` |
| `STATS` (lo que muestra el panel del visor) | [server/session.ts:583](server/session.ts#L583) `stats` |
| Canal local: mensajes JSON de la página | [client/main.ts:106](client/main.ts#L106) `session` |

## 6. Intercambio

| Qué | Dónde |
| --- | --- |
| El servidor atiende cada mensaje: `HELLO`, `OPEN`, `VIEW`, `REPORT`, `ACK`, `BYE` | [server/session.ts:266](server/session.ts#L266) `onMessage` |
| Época: un `VIEW` nuevo rehace el plan, uno viejo se ignora | [server/session.ts:294](server/session.ts#L294) |
| Qué unidades necesita una vista | [server/image.ts:87](server/image.ts#L87) `unitsFor`; nivel: [:18](server/image.ts#L18) `levelFor` |
| Plan de envío y su orden | [server/session.ts:346](server/session.ts#L346) `plan`, [:484](server/session.ts#L484) `nextWork` |
| Reintentos de `HELLO`, `OPEN` y `VIEW` cada 300 ms | [client/link.ts:157](client/link.ts#L157) `retry` |
| El cliente envía `HELLO`, `OPEN`, `VIEW` | [client/link.ts:115](client/link.ts#L115) `hello`, [:129](client/link.ts#L129) `open`, [:142](client/link.ts#L142) `view` |
| El cliente recibe cada datagrama | [client/link.ts:333](client/link.ts#L333) `onDatagram` |
| Catálogo: `LIST` y `CATALOG` | [client/link.ts:183](client/link.ts#L183) `list`, [server/main.ts:61](server/main.ts#L61) `catalog` |
| Reconexión automática del visor | [viewer/src/viewer.ts:421](viewer/src/viewer.ts#L421) `connect`, [:485](viewer/src/viewer.ts#L485) `reconnectNow` |
| Al reconectar, la página declara lo que conserva | [viewer/src/viewer.ts:522](viewer/src/viewer.ts#L522) `heldForView`; el servidor lo acepta en [server/session.ts:294](server/session.ts#L294) |
| Latido: *ping* cada 15 s | [client/main.ts:247](client/main.ts#L247) |
| Límite por cliente: 60 mensajes/s y 250 `ACK`/s | [server/main.ts:87](server/main.ts#L87) `admit` |
| Fin de sesión a los 30 s sin mensajes | [server/main.ts:198](server/main.ts#L198) |

## 7. Mecanismos de control

| Qué | Dónde |
| --- | --- |
| **7.1 Entrega Confetti**: repartir los *blobs* entre los paquetes | [shared/units.ts:134](shared/units.ts#L134) `confetti` |
| El visor dibuja cada paquete en cuanto llega | [viewer/src/viewer.ts:274](viewer/src/viewer.ts#L274) `onConfetti` |
| **7.2 Código de borrado**: tablas de GF(256) | [shared/fec.ts:23](shared/fec.ts#L23) |
| Coeficientes a partir del índice del símbolo | [shared/fec.ts:56](shared/fec.ts#L56) `coefficients` |
| Crear un símbolo de reparación | [shared/fec.ts:90](shared/fec.ts#L90) `repairSymbol` |
| Decodificar (eliminación gaussiana incremental) | [shared/fec.ts:108](shared/fec.ts#L108) `BlockDecoder` |
| Bloques de k ≤ 64 | [shared/fec.ts:17](shared/fec.ts#L17) `MAX_K`, [shared/units.ts:101](shared/units.ts#L101) `blocksOf` |
| Conteos por bloque en el `REPORT` | [client/link.ts:400](client/link.ts#L400) `report` |
| Cuándo y cuánto reparar (k − got + 1, hasta 6 veces) | [server/session.ts:569](server/session.ts#L569) `repairDue`, [:521](server/session.ts#L521) `deficit`, [:536](server/session.ts#L536) `repair` |
| El cliente recibe una reparación | [client/link.ts:319](client/link.ts#L319) `onRepair` |
| **7.3 Ventana deslizante**: número de secuencia al enviar | [server/session.ts:434](server/session.ts#L434) `pump` |
| En vuelo ≤ min(cwnd, rwnd), y el RTO con *backoff* | [server/session.ts:404](server/session.ts#L404) `windowOpen` |
| Procesar un `ACK`: en vuelo y perdidos | [server/session.ts:371](server/session.ts#L371) `onAck` |
| Cálculo de cwnd con el RTT mínimo | [server/tumble.ts:155](server/tumble.ts#L155) `cwnd`, [:161](server/tumble.ts#L161) `minRtt` |
| El cliente envía un `ACK` cada 16 paquetes | [client/link.ts:214](client/link.ts#L214) `noteData`, [:224](client/link.ts#L224) `ack` |
| **7.4 Control de flujo**: rwnd = buffer − pendiente | [client/main.ts:110](client/main.ts#L110) `receiveWindow` |
| Buffer según el ritmo del visor (128 KB a 2 MiB) | [client/main.ts:69](client/main.ts#L69) `DrainRate` |
| El visor informa lo procesado cada 50 ms | [viewer/src/viewer.ts:498](viewer/src/viewer.ts#L498) |
| `ACK` de actualización de ventana | [client/link.ts:400](client/link.ts#L400) `report` (final de la función) |
| **7.5 Slow start**: constantes (IW, HyStart++, CSS) | [server/tumble.ts:79](server/tumble.ts#L79) |
| Crecimiento y condiciones de salida | [server/tumble.ts:182](server/tumble.ts#L182) `onAck` |
| Entrada, salida y reinicio tras inactividad | [server/tumble.ts:132](server/tumble.ts#L132) `enterSlowStart`, [:247](server/tumble.ts#L247) `leaveSlowStart`, [:174](server/tumble.ts#L174) `restartAfterIdle` |
| **7.6 Run-and-tumble**: el controlador | [server/tumble.ts:94](server/tumble.ts#L94) `RunAndTumble` |
| Puntaje y decisión de *run* o *tumble* | [server/tumble.ts:270](server/tumble.ts#L270) `onReport` (puntaje en [:314](server/tumble.ts#L314), probabilidad en [:321](server/tumble.ts#L321)) |
| **7.7 Ritmo**: *token bucket* por sesión y global, cada 2 ms | [server/main.ts:160](server/main.ts#L160) |

## 8. Varios usuarios y caché

| Qué | Dónde |
| --- | --- |
| **8.1 Physarum**: el modelo | [server/physarum.ts:37](server/physarum.ts#L37) `Physarum` |
| Flujo útil y desperdiciado de un usuario | [server/physarum.ts:48](server/physarum.ts#L48) `flowed`; lo informa [server/session.ts:247](server/session.ts#L247) `delivered` y [:255](server/session.ts#L255) `abandoned` |
| La conductancia se adapta al flujo | [server/physarum.ts:68](server/physarum.ts#L68) `adapt` |
| Reparto de la subida entre usuarios | [server/main.ts:178](server/main.ts#L178) |
| Caché de paquetes y su desalojo por conductancia | [server/session.ts:32](server/session.ts#L32) `PacketCache`, [:83](server/session.ts#L83) `evict` |
| **8.2 Curva del olvido**: la caché | [viewer/src/forgetting.ts:34](viewer/src/forgetting.ts#L34) `ForgettingCache` |
| Retención R = e^(−t/S) | [viewer/src/forgetting.ts:74](viewer/src/forgetting.ts#L74) `retention` |
| Repaso espaciado al volver a pantalla | [viewer/src/forgetting.ts:82](viewer/src/forgetting.ts#L82) `frame` |
| Desalojo por retención por byte | [viewer/src/forgetting.ts:97](viewer/src/forgetting.ts#L97) `evict` |
| Presupuestos de 32 MB y 48 MB | [viewer/src/viewer.ts:67](viewer/src/viewer.ts#L67) `MEMORY_BUDGET`, [:76](viewer/src/viewer.ts#L76) `STORE_BUDGET` |
| Segundo nivel (lo desalojado, tal como llegó) | [viewer/src/viewer.ts:338](viewer/src/viewer.ts#L338) `toStore`, [:350](viewer/src/viewer.ts#L350) `fromStore` |
| Descartes informados al servidor en `VIEW` | [viewer/src/viewer.ts:550](viewer/src/viewer.ts#L550) `sendView` |

## El visor y el sitio

| Qué | Dónde |
| --- | --- |
| Dibujo de un cuadro (*splats* y *tiles*) | [viewer/src/viewer.ts:644](viewer/src/viewer.ts#L644) `frame` |
| Decodificar y colocar un *tile* | [viewer/src/viewer.ts:309](viewer/src/viewer.ts#L309) `placeTile` |
| Zoom con la rueda o los dedos | [viewer/src/viewer.ts:823](viewer/src/viewer.ts#L823) `zoomAt` |
| Panel de estadísticas | [viewer/src/viewer.ts:644](viewer/src/viewer.ts#L644) `frame` (al final), [:811](viewer/src/viewer.ts#L811) `windowLine` |
| Agregar y preparar imágenes (`/admin`) | [server/admin.ts:48](server/admin.ts#L48) `startAdmin` |
| Emulador de enlace para las pruebas | [shared/emulator.ts:88](shared/emulator.ts#L88) `EmulatedPath` |
