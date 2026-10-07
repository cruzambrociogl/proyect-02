# Guía conceptual del Protocolo SP

Esta guía explica las ideas detrás del proyecto, sin el detalle byte por byte. Para los
formatos exactos está el [documento del protocolo](protocolo-sp.pdf); para encontrar cada cosa
en el código, el [mapa del código](MAPA-DEL-CODIGO.md).

## 1. La idea en un minuto

Queremos ver en el navegador imágenes enormes (hasta 93 GB, 176,393 × 176,393 px) como en un
mapa: alejar para verla entera, acercar hasta leer cada dígito.

- La imagen **nunca se envía completa**. Se envía solo lo que la pantalla necesita en ese
  momento, a la resolución que necesita.
- El cliente **no pide archivos**. Solo dice dónde está mirando; el servidor decide qué
  enviar, en qué orden y a qué velocidad.
- Los datos viajan por **UDP con un protocolo propio** (el Protocolo SP), que hace por su
  cuenta lo que TCP haría: detectar pérdidas, recuperarlas, no saturar la red y no saturar al
  receptor.
- Lo primero que llega es una versión borrosa hecha de **splats**; encima llegan los **tiles**
  con la imagen exacta. El usuario siempre ve algo.

## 2. El problema

Una imagen de 93 GB no cabe en la memoria del navegador, tardaría horas en bajar y casi toda
quedaría fuera de la pantalla. Una pantalla muestra unos 2 millones de píxeles; la imagen
tiene 31,000 millones.

La solución clásica es la de los mapas en línea: preparar la imagen a varias resoluciones y
cortarla en cuadros pequeños. El proyecto pide además que la transferencia use un protocolo
propio, con mecanismos de control como los de TCP, y que los algoritmos no repitan los de
otros grupos (Reno, Vegas y Selective Repeat ya estaban tomados).

## 3. Cómo se representa la imagen

### 3.1 La pirámide

La imagen se prepara una sola vez, antes de servirla:

- El **nivel 0** es la imagen a resolución completa.
- Cada nivel siguiente tiene la mitad de ancho y de alto.
- Se sigue hasta que la imagen entera cabe en un cuadro de 256 × 256 px. La de 93 GB tiene 11
  niveles.

Si el usuario ve la imagen entera, basta el nivel más alto (un solo cuadro). Si acerca al
máximo, se usa el nivel 0, pero solo los cuadros que caen en la pantalla. En ambos casos se
envían más o menos los mismos pocos megabytes.

### 3.2 Tiles

Cada nivel se corta en cuadros de 256 × 256 px llamados **tiles**. Cada uno se guarda como
JPEG o como WebP sin pérdida, el que resulte menor: las fotos quedan pequeñas y el texto y
los dígitos quedan exactos.

Un tile tiene una debilidad: es un archivo comprimido. Si le falta un pedazo, no se puede
decodificar nada de él.

### 3.3 Qué es el splatting

Un **splat** es una mancha de color suave: una gaussiana elíptica. Tiene un centro, dos
radios, una rotación y un color. Es fuerte en el centro y se desvanece hacia los bordes.

**Gaussian splatting** es representar una imagen como la suma de muchas de esas manchas. Con
pocas se ve la forma general, borrosa; con más, aparece el detalle. La técnica viene de la
reconstrucción de escenas 3D (Kerbl et al., 2023); aquí se usa en 2D.

Cada mancha (un **blob**) ocupa 11 bytes: posición, radios, rotación, color e intensidad.

Para preparar los splats de un cuadro, un programa **ajusta** las manchas: las coloca donde la
imagen tiene más contenido y corrige sus colores hasta que la suma se parezca a la imagen
original. Se hace por niveles: el nivel más alto es una base completa, y cada nivel inferior
solo añade lo que le falta al anterior.

### 3.4 Por qué usar las dos cosas

Los splats tienen dos propiedades que un tile no tiene:

1. **Sirven incompletos.** Cada mancha es independiente. Con la mitad de las manchas se ve la
   misma zona, más suave. Con un tile incompleto no se ve nada.
2. **Se pueden ordenar por importancia.** Las manchas grandes e intensas van primero. El
   primer octavo ya es una versión gruesa de toda la zona.

Por eso llegan primero: llenan la pantalla en milisegundos y aguantan pérdidas. Pero no dan
la imagen exacta (pierden texturas finas), así que encima llegan los tiles, que sí lo son.

- **Splats**: solo en los niveles gruesos (unas 300 unidades por imagen). Lo primero visible.
- **Tiles**: en todos los niveles. La imagen exacta, cuando la vista está en reposo.

A cada pieza que se transfiere, sea un tile o un grupo de splats, se le llama **unit**
(unidad). Se identifica por su tipo, nivel y posición.

## 4. Las tres piezas del sistema

| Pieza | Dónde corre | Qué hace |
| --- | --- | --- |
| **Servidor** | la máquina del servidor | Tiene las imágenes preparadas. Decide qué enviar a cada usuario. También sirve las páginas por HTTP |
| **Client half** | la máquina del usuario | Habla el Protocolo SP con el servidor por UDP y le pasa los datos al navegador |
| **Visor** | el navegador | Dibuja la imagen con WebGL y dice dónde está mirando |

**¿Por qué existe el client half?** Un navegador no puede abrir sockets UDP. El client half es
la mitad del cliente que sí puede: recibe por UDP y entrega al visor por un WebSocket local.

**¿Qué viaja por dónde?**

- **HTTP**: solo los archivos iniciales (las páginas, su JavaScript, las miniaturas), siempre
  desde el servidor.
- **Protocolo SP sobre UDP**: toda la imagen.
- **WebSocket local**: el tramo entre el client half y el visor, dentro de la misma máquina.
  No forma parte del protocolo de red.

## 5. Por qué UDP y no TCP

TCP entrega los bytes **en orden**. Si se pierde un paquete, todo lo que llegó después espera
hasta que el perdido se retransmita. A eso se le llama bloqueo de cabeza de línea.

Para un archivo eso es correcto. Para nosotros no: las unidades son independientes. Si se
pierde un paquete de un tile de la esquina, el tile del centro no tiene por qué esperar.

UDP no garantiza nada: los paquetes pueden perderse, duplicarse o llegar desordenados. Eso
nos deja decidir a nosotros qué hacer con cada pérdida. El costo es que hay que construir
todo lo que TCP da hecho, y eso es justamente el Protocolo SP.

## 6. El Protocolo SP: la conversación

### 6.1 Mensajes

Cada datagrama UDP lleva un mensaje: una **cabecera fija de 20 bytes** y un contenido.

La cabecera dice: que es un mensaje nuestro (las letras "SP"), la versión, el tipo de
mensaje, la **época**, el tamaño del contenido, la hora de envío y el **número de
secuencia**.

Ningún mensaje pasa de 1,200 bytes, para que nunca se fragmente en el camino. Hay 15 tipos:

| Grupo | Mensajes | Quién los envía |
| --- | --- | --- |
| Abrir y cerrar | `HELLO`, `WELCOME`, `OPEN`, `CHART`, `BYE` | ambos |
| Lo que el cliente informa | `VIEW`, `REPORT`, `ACK` | cliente |
| Los datos de la imagen | `CONFETTI`, `TILEPART`, `REPAIR` | servidor |
| Lista de imágenes | `LIST`, `CATALOG` | ambos |
| Estado y errores | `STATS`, `FAULT` | servidor |

### 6.2 Una sesión paso a paso

1. **Saludo.** El cliente envía `HELLO`; el servidor responde `WELCOME` y crea la sesión.
2. **Elegir imagen.** El cliente envía `OPEN` con el nombre. El servidor responde `CHART`: el
   tamaño de la imagen, cuántos niveles tiene, cuáles tienen splats.
3. **Mirar.** Cada vez que el usuario mueve o acerca, el cliente envía `VIEW`: el centro de
   la vista, la escala y el tamaño de la pantalla.
4. **Recibir.** El servidor envía los datos: `CONFETTI` (splats), `TILEPART` (trozos de
   tiles) y `REPAIR` (reparaciones). El cliente confirma con `ACK` y `REPORT`.
5. **Cerrar.** `BYE`, o 30 segundos de silencio.

### 6.3 El cliente describe, el servidor decide

Esta es la decisión central del diseño. En un visor de mapas normal, el cliente pide cada
cuadro ("dame el tile 5, 3, 2"). Aquí el cliente solo dice **qué está viendo**.

Con eso el servidor calcula qué unidades cubren esa vista y las envía en orden de
importancia:

1. La base (el nivel más alto), porque todo se dibuja encima de ella.
2. El primer trozo de los splats de cada zona en pantalla, de lo grueso a lo fino: algo
   visible en toda la pantalla lo antes posible.
3. Los tiles del nivel que el zoom necesita, empezando por el centro.
4. Las reparaciones y el resto de los splats.

El servidor lleva la cuenta de lo que ya envió a cada cliente, así que no repite. Cuando el
navegador borra algo de su memoria, se lo avisa en el siguiente `VIEW` para que el servidor
sepa que tendría que enviarlo de nuevo.

### 6.4 Épocas: cancelar lo que ya no sirve

Cada `VIEW` lleva un número que sube en uno: la **época**. Cuando llega una vista nueva, el
servidor descarta todo lo que tenía pendiente de la anterior y rehace su plan.

Sin esto, un usuario que hace zoom rápido acumularía una cola de datos de vistas por las que
ya pasó. Con épocas, el servidor siempre trabaja para la vista actual.

## 7. Los mecanismos de control

Cada uno resuelve un problema que TCP también resuelve, pero adaptado a que nuestros datos
son unidades independientes con un orden de importancia.

### 7.1 Entrega Confetti: que una pérdida no deje un hueco

**Problema.** Una unidad de splats ocupa varios paquetes. Si cada paquete llevara las manchas
de una región, perder uno dejaría un hueco en esa región.

**Idea.** Repartir las manchas entre los paquetes como quien reparte cartas: la primera al
paquete 1, la segunda al paquete 2, y así en ronda. Cada paquete termina con una muestra
pareja de toda la unidad.

**Resultado.** Si se pierde un paquete, la unidad se ve completa pero un poco más suave. Nada
espera una retransmisión. Con 1 % de pérdida la imagen pierde solo 0.4 dB de calidad.

Además, la preparación de los splats ya cuenta con esto: se ajustan de modo que ninguna
mancha sola importe demasiado.

### 7.2 Código de borrado: recuperar sin preguntar qué se perdió

**Problema.** Un tile sí necesita todos sus paquetes. La forma clásica es retransmitir: el
receptor dice cuáles le faltan (Selective Repeat, SACK) y el emisor los reenvía. Eso exige
listas de paquetes perdidos y cuesta un viaje de ida y vuelta por cada pérdida.

**Idea.** Enviar paquetes extra que sirvan para reparar **cualquier** pérdida.

Los paquetes de una unidad se agrupan en bloques de hasta 64. Un **símbolo de reparación** es
una mezcla matemática de todos los paquetes del bloque. Es como un sistema de ecuaciones: con
k paquetes originales, **cualesquiera k piezas** que lleguen, sean originales o mezclas,
permiten despejar los k originales.

- Las mezclas se calculan en **GF(256)**, una aritmética sobre bytes donde sumar, multiplicar
  y dividir siempre dan otro byte exacto. Por eso las ecuaciones se pueden resolver sin
  errores de redondeo.
- Es **rateless**: se pueden fabricar tantos símbolos distintos como hagan falta, no una
  cantidad fija decidida de antemano.
- Es **sistemático**: primero se envían los paquetes originales tal cual. Si no hay pérdida,
  no se decodifica nada.

**La retroalimentación es solo un número.** El cliente no dice qué paquetes perdió. Dice
"de este bloque tengo 61 piezas útiles de 64". El servidor envía 3 símbolos nuevos, más 1 de
reserva. Cualquier símbolo sirve, así que nunca llega un duplicado inútil.

**Frente a Selective Repeat:** no hay listas de paquetes perdidos, y el tráfico de reparación
resultó unas 10 veces menor que reenviar unidades enteras.

### 7.3 Números de secuencia, ACK y ventana deslizante

**Problema.** El servidor necesita saber cuánto de lo que envió sigue en camino, para no
meter en la red más de lo que cabe.

**Idea.** Igual que TCP, pero contando paquetes en lugar de bytes:

- Cada paquete de datos lleva un **número de secuencia** que sube de uno en uno.
- El cliente responde con un `ACK` cada 16 paquetes: "el número más alto que vi es N, y en
  total recibí M".
- Con eso el servidor sabe qué sigue **en vuelo** (los números mayores que N) y cuántos se
  **perdieron** (N − M).

La **ventana deslizante** es el límite de lo que puede estar en vuelo a la vez:

`en vuelo ≤ min(cwnd, rwnd)`

- **cwnd** (ventana de congestión): cuánto aguanta la red.
- **rwnd** (ventana de recepción): cuánto aguanta el receptor.

Cuando llega un `ACK`, los paquetes confirmados dejan de contar y la ventana "se desliza": se
pueden enviar más.

**Diferencia con TCP.** En TCP la ventana es sobre un flujo ordenado. Aquí es solo una cuenta
de bytes en vuelo: una pérdida no detiene a los demás paquetes, y lo perdido lo repara el
código de borrado.

**Temporizador (RTO).** Si pasa demasiado tiempo sin `ACK`, el servidor da por perdido lo
que estaba en vuelo y baja a enviar un paquete a la vez. Si sigue sin respuesta, espera cada
vez el doble (*backoff* exponencial). Así un cliente que desapareció casi no recibe tráfico.

### 7.4 Control de flujo: no ahogar al navegador

**Problema.** El receptor puede ser más lento que la red. En nuestro caso el límite real no
es el socket: es el navegador, que tiene que decodificar cada tile y subirlo a la tarjeta
gráfica.

**Idea.** Medir la ventana de recepción donde está el cuello de botella. El visor informa
cada 50 ms cuántos bytes ya terminó de procesar. El client half calcula:

`rwnd = buffer − (lo que le pasé al visor − lo que el visor ya procesó)`

Ese valor viaja en cada `ACK`. Si el navegador se atrasa, `rwnd` baja y el servidor frena. Si
llega a cero, el servidor se detiene hasta que el navegador se ponga al día.

**El tamaño del buffer se adapta.** Es más o menos un segundo de lo que esa página procesa
(entre 128 KB y 2 MiB). Si fuera fijo y grande, una página lenta tendría muchos segundos de
datos viejos en cola, y cada vista nueva esperaría detrás de ellos.

### 7.5 Slow start: encontrar la velocidad al empezar

**Problema.** Al iniciar, el servidor no sabe si el enlace es de 2 Mbit/s o de 100. Si
empieza rápido satura un enlace lento; si empieza lento desperdicia uno rápido.

**Idea (la misma de TCP).** Empezar con poco (10 paquetes) y **duplicar en cada ida y
vuelta**: cada byte confirmado permite enviar un byte más. Crece muy rápido mientras la red
aguanta.

**Cuándo parar.** Aquí está lo delicado. Usamos la idea de **HyStart++**: observar el
retardo. Si los paquetes empiezan a tardar más, se está formando una cola en algún
enrutador: el enlace ya está lleno.

- Si el retardo sube, primero se crece más despacio un momento (*Conservative Slow Start*),
  por si solo era una variación pasajera. Si se mantiene, se termina.
- Algunos enlaces no hacen cola, simplemente descartan. Para esos se sale si hay mucha
  pérdida **y además** la entrega dejó de crecer. Cada señal por separado engaña; las dos
  juntas no.

Al salir, el servidor ya conoce la velocidad que el enlace entregó, y con esa empieza el
siguiente mecanismo.

### 7.6 Run-and-tumble: mantener la velocidad correcta

**Problema.** La capacidad de la red cambia. Hay que seguir ajustando la velocidad durante
toda la sesión. Es el trabajo que en TCP hacen Reno o Vegas.

**Inspiración.** La bacteria *E. coli* busca comida sin saber dónde está. Nada en línea recta
(*run*) mientras las cosas mejoran. Cuando empeoran, gira hacia una dirección al azar
(*tumble*) y prueba de nuevo.

**Aquí** la "dirección" es subir o bajar la velocidad de envío, y la "comida" es un puntaje:

`puntaje = velocidad enviada × castigo por retardo`

- Por debajo de la capacidad, enviar más sube el puntaje.
- Por encima, los paquetes hacen cola, el retardo sube y el castigo pesa más que la ganancia.

**Reglas:**

- Si el puntaje mejoró: seguir en la misma dirección, con pasos cada vez más grandes.
- Si no mejoró: elegir una dirección al azar y volver a pasos pequeños. Si el retardo viene
  subiendo, es más probable que elija bajar.
- Si la cola es muy grande: cortar la velocidad de inmediato.

**¿Por qué al azar?** Si todos los usuarios reaccionaran igual a la misma congestión,
bajarían y subirían juntos, y la red oscilaría. Con decisiones al azar no coinciden.

**¿Por qué mira el retardo y no la pérdida?** Porque la pérdida aleatoria (de un enlace
inalámbrico, por ejemplo) no significa congestión, y ya la repara el código de borrado. La
congestión real se nota como retardo.

### 7.7 Ritmo de envío (pacing)

Saber la velocidad correcta no basta: hay que repartir los paquetes en el tiempo y no
soltarlos en ráfagas, que llenan las colas de los enrutadores.

Se usa un **token bucket** (balde de fichas): el balde se llena a la velocidad permitida y
cada paquete gasta fichas. Hay un balde por sesión y otro global para todo el servidor.

## 8. Varios usuarios y memoria

### 8.1 Physarum: qué guarda el servidor

**Problema.** Leer una unidad del disco y empaquetarla cuesta. El servidor guarda las ya
empaquetadas en una caché compartida por todos los usuarios, pero la memoria es limitada.
¿Cuáles conservar?

**Inspiración.** El moho *Physarum polycephalum* construye una red de tubos para llevar
nutrientes. Un tubo por el que pasa mucho flujo se ensancha; uno sin flujo se adelgaza y
desaparece. Así encuentra caminos eficientes sin un plan central.

**Aquí** cada unidad en la caché es un punto de esa red. Su "grosor" sube cada vez que se
sirve a algún usuario y decae con el tiempo. Cuando falta espacio, se borra primero la más
delgada en proporción a lo que ocupa.

Con 3 usuarios, esto redujo las lecturas de disco entre 27 y 51 % frente a borrar lo menos
usado recientemente (LRU).

El mismo modelo reparte el ancho de banda cuando el servidor llega a su tope: cada usuario es
un tubo, y recibe más quien mejor aprovecha lo que se le envía.

### 8.2 Curva del olvido: qué guarda el navegador

**Problema.** El navegador no puede guardar todo lo que recibe. Hay un presupuesto fijo de
32 MB para la imagen. ¿Qué borrar?

**Inspiración.** Ebbinghaus midió cómo olvidan las personas: un recuerdo se desvanece con el
tiempo, y cada repaso lo hace durar más, sobre todo si el repaso llega cuando ya se estaba
olvidando.

**Aquí** cada unidad guardada es un recuerdo:

- Su retención baja con el tiempo que lleva fuera de la pantalla.
- Estar en pantalla es un repaso. Volver a una zona ya vista la hace más estable.
- Los niveles gruesos empiezan más estables, porque sirven para cualquier vista de su zona.

Cuando se pasa del presupuesto, sale la unidad con menor retención en proporción a lo que
ocupa. Nunca la base ni lo que está en pantalla.

Lo que sale no se pierde de inmediato: pasa a un segundo nivel de 48 MB donde se guarda
comprimido, tal como llegó. Si se vuelve a necesitar, se recupera de ahí sin usar la red.
Solo lo que sale también de ese segundo nivel se le informa al servidor.

## 9. Robustez: que el usuario no se quede esperando

| Situación | Qué hace el protocolo |
| --- | --- |
| Se pierde un mensaje de control (`HELLO`, `OPEN`, `VIEW`) | Se repite cada 300 ms hasta ver su respuesta |
| Se pierde un paquete de splats | Nada: la zona se ve un poco más suave |
| Se pierde un paquete de un tile | El código de borrado lo repara |
| El usuario hace zoom muy rápido | Las épocas cancelan lo pendiente de las vistas viejas |
| La tableta se bloquea y se corta la conexión | El visor se reconecta solo y le dice al servidor lo que ya tiene, para no recibirlo dos veces |
| Una página desaparece sin despedirse | Un latido cada 15 s la detecta y cierra su sesión |
| Un cliente envía mensajes sin control | El servidor procesa como máximo 60 por segundo y descarta el resto |
| Los dos lados tienen versiones distintas | Se informa el motivo en pantalla, en lugar de quedar en negro |

## 10. Cómo se hizo el proyecto

1. **Primera versión.** Un visor con un protocolo propio basado en los mecanismos clásicos
   (Selective Repeat, SACK, control de congestión al estilo de Reno y Vegas). Sirvió para
   entender el problema y dónde estaban los límites: la memoria del navegador y el tiempo de
   espera.
2. **Segunda versión, desde cero** (esta). Con la representación en splats más tiles y los
   algoritmos propios, porque los clásicos ya estaban tomados por otros grupos.
3. **Medir antes de decidir.** En una sola máquina nunca se pierde un paquete, así que se
   construyó un **emulador de enlace** que aplica pérdida, retardo y límite de velocidad. Con
   él se probaron tres redes: LAN, doméstica y móvil.
4. **Cambiar lo que no funcionó.** Varias ideas se probaron y se reemplazaron al medirlas:
   - El modelo de Círculos de Apolonio para varios usuarios no mostró ganancia; lo reemplazó
     Physarum.
   - El caché de "montoncito de arena" (Dhar) rendía igual que la curva del olvido. Ambos se
     cambiaron también por si otro grupo ya había tomado esos algoritmos.
   - Enviar solo por velocidad, sin ventana, desperdiciaba cientos de paquetes en enlaces
     con pérdida; se añadieron la ventana deslizante y el slow start.
5. **Probar con las imágenes reales.** Las de 17, 24, 28, 55 y 93 GB se prepararon y se
   sirven. La de 93 GB se prepara en unos 21 minutos.

## 11. Comparación rápida con TCP

| Necesidad | TCP | Protocolo SP |
| --- | --- | --- |
| Saber qué llegó | Número de secuencia por byte, ACK acumulativo | Número de secuencia por paquete, `ACK` con el mayor visto y el total |
| Recuperar lo perdido | Retransmitir el paquete perdido | Símbolos de reparación que sirven para cualquier pérdida |
| Tolerar pérdida | No: todo espera | Sí, en los splats (Confetti) |
| No saturar la red al empezar | Slow start | Slow start con salida por retardo (HyStart++) |
| No saturar la red después | Reno, Vegas, CUBIC | Run-and-tumble |
| No saturar al receptor | Ventana de recepción del socket | Ventana de recepción medida en el navegador |
| Orden de entrega | Estricto | Por importancia; las unidades son independientes |

## 12. Glosario

| Término | Significado |
| --- | --- |
| **Tile** | Cuadro de 256 × 256 px de un nivel de la imagen, guardado como JPEG o WebP |
| **Splat / blob** | Mancha gaussiana de color; muchas sumadas forman la imagen |
| **Unit** | Una pieza que se transfiere: un tile o un grupo de splats |
| **Chunk** | Una porción de los splats de una unidad, ordenados por importancia |
| **Nivel** | Una resolución de la pirámide; el 0 es la completa |
| **Época** | El número de la vista actual; cambia cada vez que el usuario se mueve |
| **Client half** | El programa local que habla UDP con el servidor por el navegador |
| **cwnd** | Ventana de congestión: cuánto puede estar en vuelo según la red |
| **rwnd** | Ventana de recepción: cuánto puede recibir el navegador ahora |
| **RTT** | Tiempo de ida y vuelta de un paquete |
| **RTO** | Tiempo de espera tras el cual un paquete se da por perdido |
| **Rateless** | Código que puede generar tantos símbolos de reparación como se necesiten |
| **GF(256)** | Aritmética sobre bytes en la que toda operación da otro byte exacto |
| **Pacing** | Repartir los envíos en el tiempo, sin ráfagas |
| **Token bucket** | Balde de fichas que limita la velocidad de envío |
| **LRU** | Política de caché simple: borrar lo usado hace más tiempo |
