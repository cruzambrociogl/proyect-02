// The client half of the protocol: the same 12-byte header the server writes, over the
// WebSocket bridge. Nothing here knows about pixels or zooming.
//
// Header: 'P' '2' version type epoch(4) length(4), big-endian, then the payload.

export const MAGIC_0 = 80, MAGIC_1 = 50, VERSION = 1, HEADER = 12;
export const HELLO = 1, WELCOME = 2, OPEN = 3, CHART = 4, VIEW = 5, UNIT = 6, FAULT = 7,
  BYE = 8, STATS = 9, PATH = 16;

function header(type, epoch, payloadLength) {
  const buffer = new ArrayBuffer(HEADER + payloadLength);
  const view = new DataView(buffer);
  view.setUint8(0, MAGIC_0);
  view.setUint8(1, MAGIC_1);
  view.setUint8(2, VERSION);
  view.setUint8(3, type);
  view.setInt32(4, epoch);
  view.setInt32(8, payloadLength);
  return { buffer, view };
}

export class Connection {
  /**
   * @param {string} url        where the bridge lives
   * @param {object} handlers   onWelcome, onChart, onUnit, onStats, onPath, onFault,
   *                             onOpen, onClose
   */
  constructor(url, handlers) {
    this.handlers = handlers;
    this.bytesReceived = 0;
    this.messagesReceived = 0;
    this.messagesSent = 0;
    this.socket = new WebSocket(url);
    this.socket.binaryType = 'arraybuffer';
    this.socket.onopen = () => {
      this.send(header(HELLO, 0, 0).buffer);
      handlers.onOpen?.();
    };
    this.socket.onclose = () => handlers.onClose?.();
    this.socket.onerror = () => handlers.onClose?.();
    this.socket.onmessage = (event) => this.receive(event.data);
  }

  get ready() {
    return this.socket.readyState === WebSocket.OPEN;
  }

  send(buffer) {
    if (!this.ready) return false;
    this.socket.send(buffer);
    this.messagesSent++;
    return true;
  }

  open(imageName) {
    const bytes = new TextEncoder().encode(imageName);
    const { buffer, view } = header(OPEN, 0, bytes.length);
    new Uint8Array(buffer, HEADER).set(bytes);
    void view;
    return this.send(buffer);
  }

  /**
   * Tell the server where we are looking, and which units we have dropped since last time
   * (it assumes we keep everything it sends until we say otherwise).
   *
   * @param {number} epoch    raised by the client on every change of view
   * @param {object} viewport {cx, cy, scale, width, height}
   * @param {Array}  dropped  [{level, x, y}]
   */
  view(epoch, viewport, dropped = []) {
    const { buffer, view } = header(VIEW, epoch, 28 + 2 + dropped.length * 10);
    let at = HEADER;
    view.setFloat64(at, viewport.cx); at += 8;
    view.setFloat64(at, viewport.cy); at += 8;
    view.setFloat64(at, viewport.scale); at += 8;
    view.setUint16(at, viewport.width); at += 2;
    view.setUint16(at, viewport.height); at += 2;
    view.setUint16(at, dropped.length); at += 2;
    for (const unit of dropped) {
      view.setUint16(at, unit.level); at += 2;
      view.setUint32(at, unit.x); at += 4;
      view.setUint32(at, unit.y); at += 4;
    }
    return this.send(buffer);
  }

  bye() {
    if (this.ready) this.send(header(BYE, 0, 0).buffer);
    this.socket.close();
  }

  receive(data) {
    const view = new DataView(data);
    if (view.byteLength < HEADER || view.getUint8(0) !== MAGIC_0 || view.getUint8(1) !== MAGIC_1) return;
    const type = view.getUint8(3);
    const epoch = view.getInt32(4);
    const length = view.getInt32(8);
    this.bytesReceived += data.byteLength;
    this.messagesReceived++;

    const text = () => new TextDecoder().decode(new Uint8Array(data, HEADER, length));
    switch (type) {
      case WELCOME: this.handlers.onWelcome?.(JSON.parse(text())); break;
      case CHART: this.handlers.onChart?.(JSON.parse(text())); break;
      case STATS: this.handlers.onStats?.(JSON.parse(text())); break;
      case PATH: this.handlers.onPath?.(JSON.parse(text())); break;
      case FAULT: this.handlers.onFault?.(text()); break;
      case UNIT: {
        const level = view.getUint16(HEADER);
        const x = view.getUint32(HEADER + 2);
        const y = view.getUint32(HEADER + 6);
        const bytes = new Uint8Array(data, HEADER + 10, length - 10);
        this.handlers.onUnit?.({ level, x, y, epoch, bytes, wireBytes: data.byteLength });
        break;
      }
      default: break;
    }
  }
}
