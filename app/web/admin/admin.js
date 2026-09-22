// Server site: what the server can serve, and how to add more.
//
// An image is "raw" until it has been prepared; preparing converts it with the server's
// current image method (ladder tiles) and is what makes it viewable. Progress is polled
// while anything is preparing.

const $ = (id) => document.getElementById(id);
const grid = $('grid');

let polling = null;

function human(bytes) {
  if (!bytes) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  const i = Math.min(units.length - 1, Math.floor(Math.log(bytes) / Math.log(1024)));
  const n = bytes / Math.pow(1024, i);
  return `${n < 10 && i > 0 ? n.toFixed(1) : Math.round(n)} ${units[i]}`;
}

async function loadStatus() {
  try {
    const s = await (await fetch('/api/status')).json();
    $('status').textContent = `${s.method}  ·  ${s.images}`;
  } catch {
    $('status').textContent = 'server unreachable';
  }
}

async function loadImages() {
  let data;
  try {
    data = await (await fetch('/api/images')).json();
  } catch {
    return;
  }
  const images = data.images ?? [];
  $('empty').hidden = images.length > 0;
  grid.replaceChildren(...images.map(card));

  const busy = images.some((i) => i.status === 'preparing');
  if (busy && !polling) polling = setInterval(loadImages, 700);
  if (!busy && polling) {
    clearInterval(polling);
    polling = null;
  }
}

function card(image) {
  const el = document.createElement('article');
  el.className = 'card';

  const thumb = document.createElement('div');
  thumb.className = 'thumb';
  if (image.status === 'ready') {
    thumb.style.backgroundImage = `url(/api/images/${encodeURIComponent(image.name)}/preview.jpg)`;
  } else {
    thumb.textContent = 'no preview until prepared';
  }

  const body = document.createElement('div');
  body.className = 'body';

  const name = document.createElement('div');
  name.className = 'name';
  name.textContent = image.name;

  const badge = document.createElement('span');
  badge.className = `badge ${image.status}`;
  badge.textContent = image.status;

  const facts = document.createElement('dl');
  facts.className = 'facts';
  const add = (k, v) => {
    const dt = document.createElement('dt');
    dt.textContent = k;
    const dd = document.createElement('dd');
    dd.textContent = v;
    facts.append(dt, dd);
  };
  add('pixels', image.width ? `${image.width.toLocaleString()} × ${image.height.toLocaleString()}` : 'unknown');
  add('megapixels', image.megapixels ? image.megapixels.toFixed(1) : '–');
  add('source', human(image.sourceBytes));
  if (image.status === 'ready') {
    add('levels', `0 … ${image.maxLevel}`);
    add('units', image.units.toLocaleString());
    add('prepared', `${human(image.preparedBytes)} (${(image.preparedBytes / image.sourceBytes).toFixed(1)}× the source file)`);
    add('tile size', `${image.unitSize} px, ratio ${image.ratio}`);
  }

  const row = document.createElement('div');
  row.className = 'row';
  row.append(badge);
  const spacer = document.createElement('span');
  spacer.className = 'spacer';
  row.append(spacer);

  if (image.status === 'ready') {
    const open = document.createElement('a');
    open.className = 'button';
    open.href = `/viewer?image=${encodeURIComponent(image.name)}`;
    open.textContent = 'View';
    row.append(open);
    const again = document.createElement('button');
    again.textContent = 'Prepare again';
    again.onclick = () => prepare(image.name, again);
    row.append(again);
  } else if (image.status === 'preparing') {
    const bar = document.createElement('progress');
    bar.max = image.total || 1;
    bar.value = image.done || 0;
    body.append(bar);
    const pct = image.total ? Math.round((image.done / image.total) * 100) : 0;
    const label = document.createElement('span');
    label.className = 'dim';
    label.textContent = `${image.stage ?? ''} — ${pct}%`;
    row.append(label);
  } else {
    const go = document.createElement('button');
    go.className = 'primary';
    go.textContent = 'Prepare';
    go.onclick = () => prepare(image.name, go);
    row.append(go);
  }

  if (image.error) {
    const err = document.createElement('div');
    err.className = 'dim';
    err.style.color = 'var(--bad)';
    err.textContent = image.error;
    body.append(err);
  }

  body.append(name, facts, row);
  el.append(thumb, body);
  return el;
}

async function prepare(name, button) {
  button.disabled = true;
  button.textContent = 'starting…';
  await fetch(`/api/images/${encodeURIComponent(name)}/prepare`, { method: 'POST' });
  loadImages();
}

// ----------------------------------------------------------------- upload

$('file').addEventListener('change', () => {
  $('upload').disabled = !$('file').files.length;
  $('uploadStatus').textContent = '';
});

$('upload').addEventListener('click', () => {
  const file = $('file').files[0];
  if (!file) return;
  const request = new XMLHttpRequest();
  const bar = $('uploadProgress');
  bar.hidden = false;
  bar.value = 0;
  $('upload').disabled = true;
  $('uploadStatus').textContent = `sending ${human(file.size)}…`;

  request.upload.onprogress = (e) => {
    if (e.lengthComputable) bar.value = (e.loaded / e.total) * 100;
  };
  request.onload = () => {
    bar.hidden = true;
    $('upload').disabled = false;
    $('uploadStatus').textContent = request.status === 200
      ? 'uploaded — press Prepare to make it viewable'
      : `upload failed: ${request.responseText}`;
    $('file').value = '';
    loadImages();
  };
  request.onerror = () => {
    bar.hidden = true;
    $('upload').disabled = false;
    $('uploadStatus').textContent = 'upload failed';
  };
  request.open('POST', `/api/upload?name=${encodeURIComponent(file.name)}`);
  request.send(file);
});

loadStatus();
loadImages();
setInterval(loadImages, 5000);
