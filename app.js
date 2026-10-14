'use strict';

/* ============ Config y estado ============ */
const PAGE = 20;
const CACHE_KEY = 'dp_cache';

const $ = (s, r = document) => r.querySelector(s);
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const norm = s => String(s ?? '').toLowerCase().replace(/[^a-z0-9]/g, '');
const ls = {
  get: k => { try { return localStorage.getItem(k); } catch { return null; } },
  set: (k, v) => { try { localStorage.setItem(k, v); } catch { } },
  del: k => { try { localStorage.removeItem(k); } catch { } }
};

const CFG = window.DEPO_CONFIG || {};
let API_URL = ls.get('dp_api') || CFG.API_URL || '';
let API_KEY = ls.get('dp_key') || CFG.API_KEY || '';
let db = { version: 1, records: [] };
let editing = null;          // registro que se está editando (null = nuevo)
let pending = [];            // fotos nuevas sin subir [{blob,url}]
let removed = new Set();     // fileIds de fotos existentes marcadas para borrar
let current = null;          // registro abierto en el informe
let shown = PAGE;
let installEvt = null;

/* ============ Utilidades de interfaz ============ */
function show(v) {
  document.querySelectorAll('.view').forEach(e => e.hidden = e.id !== 'v-' + v);
  const inApp = ['form', 'search', 'detail'].includes(v);
  $('#nav').hidden = !inApp;
  document.querySelectorAll('#nav button').forEach(b => b.classList.toggle('on', b.dataset.go === (v === 'detail' ? 'search' : v)));
  window.scrollTo(0, 0);
}
function busy(msg) {
  const b = $('#busy');
  if (msg) { $('#busyTx').textContent = msg; b.hidden = false; } else b.hidden = true;
}
let toastT;
function toast(msg, err) {
  const t = $('#toast');
  t.textContent = msg; t.className = err ? 'err' : ''; t.hidden = false;
  clearTimeout(toastT); toastT = setTimeout(() => t.hidden = true, err ? 5000 : 2600);
}
async function guard(fn) {
  try { return await fn(); }
  catch (e) {
    console.error(e);
    if (e && e.auth) { fillSetup(); show('setup'); $('#setupMsg').textContent = e.message || 'Revisa la dirección y la clave.'; }
    else toast((e && e.message) || 'Ha ocurrido un error', true);
  } finally { busy(false); }
}
const nowLocal = () => { const d = new Date(); d.setMinutes(d.getMinutes() - d.getTimezoneOffset()); return d.toISOString().slice(0, 16); };
function stampTxt(iso) { // 'YYYY-MM-DDTHH:mm' -> 'dd/mm/yyyy HH:mm'
  const m = /^(\d{4})-(\d\d)-(\d\d)T(\d\d):(\d\d)/.exec(iso || '');
  return m ? `${m[3]}/${m[2]}/${m[1]} ${m[4]}:${m[5]}` : '';
}
const fmt = iso => stampTxt(iso) || '—';
const safeName = s => String(s).replace(/[^\w.-]+/g, '_').slice(0, 40) || 'patin';

/* ============ Conexión con Drive (a través del script de Google) ============ */
// La app no inicia sesión en Google: habla con un script de Google Apps Script
// que se ejecuta con la cuenta del depósito. Se configura una vez por dispositivo.
const NO_SCRIPT = 'No se pudo hablar con el script de Google. Revisa que en «Implementar» esté «Quién tiene acceso: Cualquier usuario» y que hayas autorizado los permisos. Prueba a abrir la dirección /exec en el navegador: debe salir {"ok":true,"app":"DepoPatin"}.';
async function api(action, data = {}) {
  if (!API_URL || !API_KEY) throw { auth: true, message: 'Falta configurar la conexión.' };
  let r;
  try {
    r = await fetch(API_URL, {
      method: 'POST', redirect: 'follow', cache: 'no-store',
      headers: { 'Content-Type': 'text/plain;charset=utf-8' },
      body: JSON.stringify({ ...data, action, key: API_KEY })
    });
  } catch {
    if (navigator.onLine === false) throw new Error('Sin conexión. Comprueba internet.');
    throw { auth: action === 'ping', message: NO_SCRIPT };
  }
  let j;
  try { j = await r.json(); } catch { throw { auth: action === 'ping', message: NO_SCRIPT }; }
  if (j.error) throw (j.auth ? { auth: true, message: j.error } : new Error(j.error));
  return j;
}
function setDB(d) {
  db = d && Array.isArray(d.records) ? d : { version: 1, records: [] };
  ls.set(CACHE_KEY, JSON.stringify(db));
}
const readDB = async () => (await api('read')).db;

const blobToB64 = b => new Promise((ok, ko) => {
  const fr = new FileReader();
  fr.onload = () => ok(String(fr.result).split(',')[1]);
  fr.onerror = ko; fr.readAsDataURL(b);
});
async function uploadPhoto(blob, name) {
  return (await api('upload', { name, data: await blobToB64(blob) })).fileId;
}
async function deleteFile(id) { try { await api('deleteFile', { id }); } catch (e) { console.warn('No se pudo borrar', id, e); } }

// Descarga de fotos con un máximo de 4 a la vez
let active = 0; const queue = [];
function limited(fn) {
  return new Promise((ok, ko) => {
    const run = () => { active++; fn().then(ok, ko).finally(() => { active--; if (queue.length) queue.shift()(); }); };
    active < 4 ? run() : queue.push(run);
  });
}
const photoCache = new Map();
function photoURL(id, thumb) {
  const k = id + (thumb ? ':t' : '');
  if (!photoCache.has(k)) {
    const p = limited(() => api('photo', { id, thumb: !!thumb })).then(j => {
      const bin = atob(j.data), u8 = new Uint8Array(bin.length);
      for (let i = 0; i < bin.length; i++) u8[i] = bin.charCodeAt(i);
      return URL.createObjectURL(new Blob([u8], { type: j.mime || 'image/jpeg' }));
    });
    p.catch(() => photoCache.delete(k));
    photoCache.set(k, p);
  }
  return photoCache.get(k);
}
function setImg(img, id) {
  const thumb = img.dataset.thumb === '1';
  photoURL(id, thumb).then(u => {
    img.src = u;
    if (thumb) img.dataset.full = id; else img.classList.add('zoom');
  }).catch(() => { img.alt = 'No disponible'; });
}
const io = 'IntersectionObserver' in window
  ? new IntersectionObserver(es => es.forEach(e => { if (e.isIntersecting) { io.unobserve(e.target); setImg(e.target, e.target.dataset.fid); } }), { rootMargin: '200px' })
  : null;
const lazy = img => io ? io.observe(img) : setImg(img, img.dataset.fid);

/* ============ Foto con etiqueta de fecha ============ */
async function stampPhoto(file, text) {
  const url = URL.createObjectURL(file);
  try {
    const img = new Image(); img.src = url; await img.decode();
    const max = 1600, s = Math.min(1, max / Math.max(img.naturalWidth, img.naturalHeight));
    const c = document.createElement('canvas');
    c.width = Math.round(img.naturalWidth * s); c.height = Math.round(img.naturalHeight * s);
    const x = c.getContext('2d');
    x.drawImage(img, 0, 0, c.width, c.height);
    const fs = Math.max(14, Math.round(c.width * 0.021));
    x.font = `600 ${fs}px system-ui,-apple-system,Segoe UI,Roboto,sans-serif`;
    const tw = x.measureText(text).width, px = fs * .6, py = fs * .45, m = fs * .6;
    const bw = tw + px * 2, bh = fs + py * 2, bx = m, by = c.height - bh - m;
    x.fillStyle = 'rgba(0,0,0,.62)';
    if (x.roundRect) { x.beginPath(); x.roundRect(bx, by, bw, bh, fs * .3); x.fill(); } else x.fillRect(bx, by, bw, bh);
    x.fillStyle = '#fff'; x.textBaseline = 'middle';
    x.fillText(text, bx + px, by + bh / 2 + 1);
    return await new Promise(r => c.toBlob(r, 'image/jpeg', 0.82));
  } finally { URL.revokeObjectURL(url); }
}
async function addFiles(files) {
  const list = [...files]; if (!list.length) return;
  await guard(async () => {
    busy('Procesando foto…');
    const stamp = 'ENTRADA ' + (stampTxt($('#fDate').value) || stampTxt(nowLocal()));
    for (const f of list) {
      const blob = await stampPhoto(f, stamp);
      pending.push({ blob, url: URL.createObjectURL(blob) });
    }
    renderFormPhotos();
  });
}

/* ============ Formulario (nuevo / editar) ============ */
function tile(src, fid, onRemove) {
  const d = document.createElement('div'); d.className = 'tile';
  const im = document.createElement('img');
  if (src) { im.src = src; im.className = 'zoom'; } else { im.dataset.fid = fid; lazy(im); }
  const x = document.createElement('button'); x.type = 'button'; x.className = 'x'; x.textContent = '✕'; x.title = 'Quitar';
  x.onclick = onRemove;
  d.append(im, x); return d;
}
function renderFormPhotos() {
  const box = $('#fPhotos'); box.innerHTML = '';
  if (editing) editing.fotos.filter(f => !removed.has(f.fileId)).forEach(f =>
    box.append(tile(null, f.fileId, () => { removed.add(f.fileId); renderFormPhotos(); })));
  pending.forEach((p, i) => box.append(tile(p.url, null, () => { URL.revokeObjectURL(p.url); pending.splice(i, 1); renderFormPhotos(); })));
}
function resetForm() {
  editing = null; pending.forEach(p => URL.revokeObjectURL(p.url)); pending = []; removed = new Set();
  $('#frm').reset(); $('#fDate').value = nowLocal();
  $('#formTitle').textContent = 'Nuevo registro'; $('#btnCancel').hidden = true;
  renderFormPhotos();
}
function startEdit(r) {
  resetForm(); editing = r;
  $('#fId').value = r.patinId; $('#fCh').value = r.chasis; $('#fDate').value = r.fecha; $('#fNotes').value = r.notas || '';
  $('#formTitle').textContent = 'Editar registro'; $('#btnCancel').hidden = false;
  renderFormPhotos(); show('form');
}

async function saveForm(ev) {
  ev.preventDefault();
  const patinId = $('#fId').value.trim(), chasis = $('#fCh').value.trim().toUpperCase();
  const fecha = $('#fDate').value, notas = $('#fNotes').value.trim();
  if (!patinId || !chasis || !fecha) return toast('Rellena ID, chasis/matrícula y fecha', true);

  const dup = db.records.find(r => norm(r.chasis) === norm(chasis) && (!editing || r.id !== editing.id));
  if (dup && !confirm(`Ya existe un registro con ese chasis/matrícula (entrada ${fmt(dup.fecha)}). ¿Guardar igualmente?`)) return;

  await guard(async () => {
    const uploaded = [];
    let saved = false;
    try {
      let i = 0;
      for (const p of pending) {
        busy(`Subiendo foto ${++i} de ${pending.length}…`);
        const fileId = await uploadPhoto(p.blob, `${safeName(patinId)}_${Date.now()}_${i}.jpg`);
        uploaded.push({ fileId, name: `${safeName(patinId)}_${i}.jpg` });
      }
      busy('Guardando registro…');
      // El servidor lee la última versión, aplica el cambio y guarda (con bloqueo)
      const res = await api('save', {
        record: { id: editing ? editing.id : null, patinId, chasis, fecha, notas },
        add: uploaded, remove: [...removed]
      });
      setDB(res.db);
      saved = true;
      toast(editing ? 'Registro actualizado ✔' : 'Registro guardado ✔');
      const wasEdit = !!editing;
      resetForm();
      if (wasEdit) { runSearch(); show('search'); }
    } catch (e) {
      if (!saved) for (const u of uploaded) await deleteFile(u.fileId);
      throw e;
    }
  });
}

/* ============ Buscador ============ */
function filtered() {
  const q = norm($('#sQ').value), d1 = $('#sFrom').value, d2 = $('#sTo').value;
  return db.records.filter(r => {
    if (q && !(norm(r.chasis).includes(q) || norm(r.patinId).includes(q))) return false;
    const d = (r.fecha || '').slice(0, 10);
    if (d1 && d < d1) return false;
    if (d2 && d > d2) return false;
    return true;
  }).sort((a, b) => (b.fecha || '').localeCompare(a.fecha || ''));
}
function runSearch(keepPage) {
  if (!keepPage) shown = PAGE;
  const list = filtered();
  $('#sCount').textContent = db.records.length
    ? `${list.length} resultado${list.length === 1 ? '' : 's'} (de ${db.records.length} registros)`
    : 'Todavía no hay registros.';
  const box = $('#sList'); box.innerHTML = '';
  list.slice(0, shown).forEach(r => {
    const d = document.createElement('div'); d.className = 'item';
    const th = document.createElement('div'); th.className = 'thumb';
    if (r.fotos && r.fotos[0]) { const im = document.createElement('img'); im.dataset.fid = r.fotos[0].fileId; im.dataset.thumb = '1'; th.append(im); lazy(im); } else th.textContent = 'sin foto';
    const tx = document.createElement('div');
    tx.innerHTML = `<b>${esc(r.patinId)} · ${esc(r.chasis)}</b><span>Entrada: ${esc(fmt(r.fecha))}</span><span>${(r.fotos || []).length} foto(s)</span>`;
    d.append(th, tx); d.onclick = () => openDetail(r.id);
    box.append(d);
  });
  $('#btnMore').hidden = list.length <= shown;
}

/* ============ Informe / detalle ============ */
function openDetail(id) {
  const r = db.records.find(x => x.id === id); if (!r) return;
  current = r;
  $('#dBody').innerHTML = `
    <div class="rhead"><img src="logo-simbolo.png" alt="">
      <div><h3>Informe de entrada de patín</h3>
      <div class="mut small">DepoPatín · generado el ${esc(new Date().toLocaleString('es-ES'))}</div></div></div>
    <table>
      <tr><td>ID del patín</td><td><b>${esc(r.patinId)}</b></td></tr>
      <tr><td>Chasis / matrícula</td><td><b>${esc(r.chasis)}</b></td></tr>
      <tr><td>Fecha de entrada</td><td>${esc(fmt(r.fecha))}</td></tr>
      <tr><td>Notas</td><td>${esc(r.notas || '—').replace(/\n/g, '<br>')}</td></tr>
      <tr><td>Registrado</td><td>${esc(new Date(r.creado).toLocaleString('es-ES'))}</td></tr>
      <tr><td>Última modificación</td><td>${esc(new Date(r.modificado).toLocaleString('es-ES'))}</td></tr>
    </table>
    <div class="sub">Fotos (${(r.fotos || []).length})</div>
    <div class="grid" id="dPhotos"></div>`;
  const g = $('#dPhotos');
  (r.fotos || []).forEach(f => { const t = document.createElement('div'); t.className = 'tile'; const im = document.createElement('img'); im.dataset.fid = f.fileId; t.append(im); g.append(t); setImg(im, f.fileId); });
  show('detail');
}
async function deleteRecord(r) {
  if (!confirm(`¿Eliminar el registro ${r.patinId} · ${r.chasis} y sus fotos? No se puede deshacer.`)) return;
  await guard(async () => {
    busy('Eliminando…');
    setDB((await api('delete', { id: r.id })).db);
    toast('Registro eliminado');
    runSearch(); show('search');
  });
}

/* ============ Arranque ============ */
// La conexión se configura UNA vez por dispositivo y queda guardada.
// Al abrir, se muestran al instante los datos guardados y se actualizan en segundo plano.
async function refresh(silent) {
  try {
    setDB(await readDB());
    runSearch(true);
    if (!silent) toast('Lista actualizada');
  } catch (e) {
    if (e && e.auth) throw e;
    if (!silent) throw e;
    toast('Sin conexión: mostrando los últimos datos guardados', true);
  }
}
function boot() {
  // Configuración por enlace: ...?api=URL&key=CLAVE (se guarda y se borra de la barra)
  const q = new URLSearchParams(location.search);
  if (q.get('api') && q.get('key')) {
    API_URL = q.get('api').trim(); API_KEY = q.get('key').trim();
    ls.set('dp_api', API_URL); ls.set('dp_key', API_KEY);
    history.replaceState(null, '', location.pathname);
  }
  if (!API_URL || !API_KEY) { fillSetup(); return show('setup'); }
  try { const c = JSON.parse(ls.get(CACHE_KEY) || 'null'); if (c && Array.isArray(c.records)) db = c; } catch { }
  $('#who').textContent = ls.get('dp_email') || '';
  resetForm(); runSearch(); show('form');
  guard(() => refresh(true));
}
function fillSetup() { $('#setApi').value = API_URL; $('#setKey').value = API_KEY; }
async function saveSetup() {
  $('#setupMsg').textContent = '';
  let url = $('#setApi').value.trim(), key = $('#setKey').value.trim();
  // También se puede pegar el enlace completo del atajo (…?api=…&key=…)
  try {
    const u = new URL(url);
    if (u.searchParams.get('api')) { key = u.searchParams.get('key') || key; url = u.searchParams.get('api'); $('#setKey').value = key; }
  } catch { }
  if (!/^https:\/\/script\.google\.com\/.+\/exec$/.test(url)) {
    $('#setupMsg').textContent = /\/dev$/.test(url)
      ? 'Esa es la dirección de prueba (/dev). Usa la de «Implementar → Gestionar implementaciones», la que termina en /exec.'
      : /\/edit/.test(url) ? 'Esa es la dirección del editor del script. Necesitas la de la aplicación web, que termina en /exec (Implementar → Gestionar implementaciones).'
      : 'La dirección debe ser la de la aplicación web del script de Google: empieza por https://script.google.com/ y termina en /exec.';
    return;
  }
  if (!key) return toast('Escribe la clave', true);
  API_URL = url; API_KEY = key;
  await guard(async () => {
    busy('Comprobando conexión…');
    const p = await api('ping');
    ls.set('dp_api', url); ls.set('dp_key', key); ls.set('dp_email', p.email || '');
    $('#setupMsg').textContent = '';
    toast('Conectado ✔ Ya no tendrás que hacerlo más en este dispositivo');
    boot();
  });
}

/* ============ Eventos ============ */
document.addEventListener('DOMContentLoaded', () => {
  $('#btnSetup').onclick = saveSetup;
  $('#btnSettings').onclick = () => { fillSetup(); $('#setupMsg').textContent = ''; show('setup'); };
  document.querySelectorAll('#nav button').forEach(b => b.onclick = () => {
    if (b.dataset.go === 'form' && editing) resetForm();
    if (b.dataset.go === 'search') runSearch(true);
    show(b.dataset.go);
  });

  $('#frm').addEventListener('submit', saveForm);
  $('#btnCam').onclick = () => $('#inCam').click();
  $('#btnGal').onclick = () => $('#inGal').click();
  $('#inCam').onchange = e => { addFiles(e.target.files); e.target.value = ''; };
  $('#inGal').onchange = e => { addFiles(e.target.files); e.target.value = ''; };
  $('#btnCancel').onclick = () => { resetForm(); show('search'); };

  ['sQ', 'sFrom', 'sTo'].forEach(id => $('#' + id).addEventListener('input', () => runSearch()));
  $('#btnClear').onclick = () => { $('#sQ').value = ''; $('#sFrom').value = ''; $('#sTo').value = ''; runSearch(); };
  $('#btnReload').onclick = () => guard(async () => { busy('Actualizando…'); await refresh(false); });
  $('#btnMore').onclick = () => { shown += PAGE; runSearch(true); };

  $('#dBack').onclick = () => show('search');
  $('#dEdit').onclick = () => current && startEdit(current);
  $('#dPrint').onclick = () => window.print();
  $('#dDel').onclick = () => current && deleteRecord(current);

  // Ver fotos a pantalla completa
  document.body.addEventListener('click', e => {
    const im = e.target.closest('img.zoom');
    if (im && im.src && !e.target.closest('#lightbox')) { $('#lightbox').innerHTML = `<img src="${im.src}" alt="">`; $('#lightbox').hidden = false; }
  });
  $('#lightbox').onclick = () => $('#lightbox').hidden = true;

  // Instalación
  window.addEventListener('beforeinstallprompt', e => { e.preventDefault(); installEvt = e; $('#btnInstall').hidden = false; });
  $('#btnInstall').onclick = async () => { if (!installEvt) return; installEvt.prompt(); await installEvt.userChoice; installEvt = null; $('#btnInstall').hidden = true; };
  window.addEventListener('appinstalled', () => $('#btnInstall').hidden = true);

  if ('serviceWorker' in navigator) navigator.serviceWorker.register('sw.js').catch(() => { });

  boot();
});
