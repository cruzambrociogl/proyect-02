// Catalog page: lists what the server can serve, and uploads new images to it.
//
// Upload is a plain POST with the file as the raw body (?name=...), so the server needs no
// multipart parser - it just writes Content-Length bytes to the images directory.

const grid = document.getElementById('grid');
const fileInput = document.getElementById('file');
const drop = document.getElementById('drop');
const progress = document.getElementById('progress');
const bar = document.getElementById('bar');
const msg = document.getElementById('uploadMsg');

function human(bytes) {
  if (bytes >= 1073741824) return (bytes / 1073741824).toFixed(1) + ' GB';
  if (bytes >= 1048576) return (bytes / 1048576).toFixed(1) + ' MB';
  return (bytes / 1024).toFixed(0) + ' KB';
}

function megapixels(w, h) {
  const mp = (w * h) / 1e6;
  return mp >= 1000 ? (mp / 1000).toFixed(2) + ' GP' : mp.toFixed(1) + ' MP';
}

async function loadCatalog() {
  try {
    const list = await (await fetch('/api/images')).json();
    if (!list.length) {
      grid.innerHTML = '<p class="empty">No images yet — drop one above.</p>';
      return;
    }
    grid.innerHTML = '';
    for (const img of list) {
      // Images too large to decode live are shown but not clickable: opening one would
      // stall the server. They become clickable once ingested into a tile store.
      const card = document.createElement(img.ready ? 'a' : 'div');
      card.className = 'card' + (img.ready ? '' : ' notready');
      if (img.ready) card.href = 'viewer.html?image=' + encodeURIComponent(img.name);
      card.innerHTML = `
        <div class="thumb" style="aspect-ratio:${img.width}/${img.height}">
          <span class="mp">${megapixels(img.width, img.height)}</span>
        </div>
        <div class="meta">
          <b title="${img.name}">${img.name}</b>
          <span>${img.width.toLocaleString()} × ${img.height.toLocaleString()} · ${human(img.bytes)}</span>
          ${img.ready ? '' : `<span class="needs">needs ingest &middot; <code>./ingest.sh images/${img.name}</code></span>`}
        </div>`;
      grid.appendChild(card);
    }
  } catch (e) {
    grid.innerHTML = '<p class="empty">could not reach the server</p>';
  }
}

function upload(file) {
  if (!/\.(jpe?g|png|tiff?)$/i.test(file.name)) {
    msg.textContent = 'only JPG, PNG and TIFF are supported';
    return;
  }
  progress.hidden = false;
  bar.style.width = '0%';
  msg.textContent = 'uploading ' + file.name + ' (' + human(file.size) + ')…';

  // XHR rather than fetch: it reports upload progress, which matters for a 250 MB file.
  const xhr = new XMLHttpRequest();
  xhr.open('POST', '/api/upload?name=' + encodeURIComponent(file.name));
  xhr.upload.onprogress = (e) => {
    if (e.lengthComputable) bar.style.width = (100 * e.loaded / e.total).toFixed(1) + '%';
  };
  xhr.onload = () => {
    progress.hidden = true;
    let ok = false;
    try { ok = JSON.parse(xhr.responseText).ok; } catch (_) { }
    msg.textContent = ok ? 'uploaded ' + file.name : 'upload failed: ' + xhr.responseText;
    if (ok) loadCatalog();
  };
  xhr.onerror = () => { progress.hidden = true; msg.textContent = 'upload failed'; };
  xhr.send(file);
}

document.getElementById('browse').addEventListener('click', () => fileInput.click());
fileInput.addEventListener('change', () => { if (fileInput.files[0]) upload(fileInput.files[0]); });

['dragenter', 'dragover'].forEach(ev =>
  drop.addEventListener(ev, (e) => { e.preventDefault(); drop.classList.add('over'); }));
['dragleave', 'drop'].forEach(ev =>
  drop.addEventListener(ev, (e) => { e.preventDefault(); drop.classList.remove('over'); }));
drop.addEventListener('drop', (e) => {
  const f = e.dataTransfer.files[0];
  if (f) upload(f);
});

loadCatalog();
