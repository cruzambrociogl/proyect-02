// The panel on the left.
//
// It is laid out by the questions someone actually asks while using the viewer, in the order
// they ask them: what am I waiting for, what is arriving, what is the network doing, what does
// this cost me, and what am I looking at. The protocol's own counters are a fold away rather
// than in the way - they matter when explaining how this works, not while using it.
//
// Two things carry most of the meaning. A bar says at a glance what a number cannot: how much
// of this view has arrived, and how full the cache is. And every row has a one-line
// explanation, because a name like "queue" or "discarded" means nothing on its own - it shows
// as a tooltip, and the switch at the top puts them all on screen at once, which is what you
// want when showing somebody else.

const SECTIONS = [
  {
    title: 'This view',
    meter: 'tiles',
    rows: [
      ['status', 'Whether everything this view needs has arrived yet.'],
      ['zoom', 'How much of the image one screen pixel covers.'],
      ['detail', 'Which of the prepared levels is being drawn. 0 is the finest.'],
      ['on screen', 'How much of the whole image is in view.'],
    ],
  },
  {
    title: 'Arriving',
    rows: [
      ['now', 'What is coming in at this moment.'],
      ['this session', 'Everything that has arrived since the page was opened.'],
      ['average tile', 'What one tile costs on the wire.'],
    ],
  },
  {
    title: 'The path',
    rows: [
      ['sending at', 'The rate the server has settled on, decided by how long packets are '
        + 'waiting rather than by whether they are lost.'],
      ['round trip', 'How long a packet takes to get there and back, and the floor it has when '
        + 'nothing is queued.'],
      ['queue', 'How long our own packets are waiting in buffers along the way. Keeping this '
        + 'small is the point: a queue we build is a delay the next move has to wait out.'],
      ['loss', 'The share of packets that never arrive. Repaired without asking for them again.'],
      ['repair', 'What the repair symbols cost, over the minimum these tiles would need on a '
        + 'path that lost nothing.'],
      ['cancelled', 'Tiles the server dropped unsent because the view moved away from them.'],
    ],
  },
  {
    title: 'Memory here',
    meter: 'cache',
    rows: [
      ['holding', 'Decoded tiles kept in the page, against the budget they are kept under.'],
      ['dropped', 'Tiles let go to stay inside the budget. The server is told, so they can be '
        + 'sent again when they are wanted.'],
      ['drawing', 'What the last frame cost, and how often frames are drawn.'],
    ],
  },
  {
    title: 'The image',
    rows: [
      ['file', null],
      ['size', 'The whole image, in pixels.'],
      ['method', 'How it was cut up: tiles of pixels, or fitted Gaussian blobs.'],
      ['prepared', 'How many units it was cut into, and what they take on the server.'],
    ],
  },
  {
    title: 'Protocol detail',
    fold: true,
    rows: [
      ['link', 'The connection to the client half of the protocol.'],
      ['epoch', 'Counts the viewer\'s moves. Both ends throw away work from an older one.'],
      ['views sent', 'How many times the viewer has said where it is looking.'],
      ['server queue', 'Tiles the server has chosen but not yet handed to the wire.'],
      ['symbols out', 'Packets of image data the server has sent, 1,200 bytes of payload each.'],
      ['packets in', 'Packets the client half of the protocol has received.'],
      ['tiles rebuilt', 'Whole tiles put back together out of their symbols.'],
      ['part built', 'Tiles with some symbols in, still waiting for the rest.'],
      ['wasted', 'Symbols that arrived carrying nothing new. Should stay near zero.'],
      ['discarded', 'Symbols thrown away on arrival: either for a view already left, or for a '
        + 'tile that was already complete.'],
      ['splats drawn', 'Gaussian blobs in the last frame. Only the splat method draws these.'],
    ],
  },
];

export class Panel {
  constructor(root) {
    this.cells = new Map();
    this.meters = new Map();
    root.append(explainSwitch(root));

    for (const section of SECTIONS) {
      const box = document.createElement(section.fold ? 'details' : 'section');
      if (section.fold) {
        const summary = document.createElement('summary');
        summary.textContent = section.title;
        box.append(summary);
      } else {
        const heading = document.createElement('h2');
        heading.textContent = section.title;
        box.append(heading);
      }
      if (section.meter) box.append(this.addMeter(section.meter));

      const list = document.createElement('dl');
      list.className = 'facts';
      for (const [name, hint] of section.rows) {
        const term = document.createElement('dt');
        term.textContent = name;
        const value = document.createElement('dd');
        value.textContent = '–';
        list.append(term, value);
        if (hint) {
          term.title = hint;
          term.className = 'explained';
          const note = document.createElement('p');
          note.className = 'hint';
          note.textContent = hint;
          list.append(note);
        }
        this.cells.set(name, value);
      }
      box.append(list);
      root.append(box);
    }
  }

  addMeter(id) {
    const wrap = document.createElement('div');
    const bar = document.createElement('div');
    bar.className = 'meter';
    const fill = document.createElement('i');
    bar.append(fill);
    const caption = document.createElement('div');
    caption.className = 'caption';
    caption.textContent = '–';
    wrap.append(bar, caption);
    this.meters.set(id, { bar, fill, caption });
    return wrap;
  }

  /** Set a row. `tone` marks it as worth noticing: 'waiting' or 'bad'. */
  set(row, value, tone = null) {
    const cell = this.cells.get(row);
    if (!cell) return;
    if (cell.textContent !== value) cell.textContent = value;
    const want = tone ?? '';
    if (cell.className !== want) cell.className = want;
  }

  /** Move a bar. `settled` draws it in the finished colour rather than the working one. */
  fill(id, fraction, caption, settled = false) {
    const meter = this.meters.get(id);
    if (!meter) return;
    const pct = `${Math.round(Math.max(0, Math.min(1, fraction)) * 100)}%`;
    if (meter.fill.style.width !== pct) meter.fill.style.width = pct;
    meter.bar.classList.toggle('settled', settled);
    if (meter.caption.textContent !== caption) meter.caption.textContent = caption;
  }
}

function explainSwitch(root) {
  const button = document.createElement('button');
  button.className = 'explain-switch';
  button.textContent = 'explain the rows';
  button.onclick = () => {
    const on = root.classList.toggle('explain');
    button.textContent = on ? 'hide the explanations' : 'explain the rows';
  };
  return button;
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

/** 1,234 rather than 1234, and a dash for a number that is not there yet. */
export function count(value) {
  return value == null ? '–' : Math.round(value).toLocaleString();
}
