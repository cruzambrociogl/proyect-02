// The left panel: everything the viewer knows about the image, the view, the transfer and
// its own memory. Rows are created once and only their values change, so updating at 10 Hz
// costs nothing.

const SECTIONS = [
  ['Image', ['name', 'pixels', 'megapixels', 'method', 'levels', 'unit size', 'prepared', 'units total']],
  ['View', ['zoom', 'level', 'scale', 'centre', 'region', 'visible', 'units wanted', 'held', 'missing']],
  ['Transfer', ['link', 'views sent', 'units in', 'bytes in', 'rate', 'average unit',
    'server queue', 'cancelled', 'epoch']],
  ['Protocol', ['send rate', 'round trip', 'queue', 'path floor', 'loss', 'symbols out',
    'units delivered', 'units dropped', 'packets in', 'symbols wasted', 'units rebuilt',
    'units part built', 'stale']],
  ['Client memory', ['units held', 'held bytes', 'budget', 'evicted', 'unreported drops']],
  ['Rendering', ['units drawn', 'splats drawn', 'draw time', 'frames']],
];

export class Panel {
  constructor(root) {
    this.cells = new Map();
    for (const [title, rows] of SECTIONS) {
      const section = document.createElement('section');
      const h = document.createElement('h2');
      h.textContent = title;
      const dl = document.createElement('dl');
      dl.className = 'facts';
      for (const row of rows) {
        const dt = document.createElement('dt');
        dt.textContent = row;
        const dd = document.createElement('dd');
        dd.textContent = '–';
        dl.append(dt, dd);
        this.cells.set(row, dd);
      }
      section.append(h, dl);
      root.append(section);
    }
  }

  set(row, value) {
    const cell = this.cells.get(row);
    if (cell && cell.textContent !== value) cell.textContent = value;
  }
}

export function human(bytes) {
  if (!bytes) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB'];
  const i = Math.min(units.length - 1, Math.floor(Math.log(bytes) / Math.log(1024)));
  const n = bytes / Math.pow(1024, i);
  return `${n < 10 && i > 0 ? n.toFixed(1) : Math.round(n)} ${units[i]}`;
}

export function zoomLabel(scale) {
  return scale >= 1 ? `1:${scale.toFixed(2)}` : `${(1 / scale).toFixed(2)}:1`;
}
