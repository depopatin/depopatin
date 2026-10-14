/**
 * DepoPatín · servidor en Google Apps Script
 * ------------------------------------------
 * Se ejecuta con la cuenta de Google del depósito y guarda todo en su Drive,
 * en la carpeta "DepoPatin". Así los móviles y ordenadores NO tienen que
 * iniciar sesión en Google: solo necesitan la dirección de este script y la clave.
 *
 * 1) Cambia CLAVE por una contraseña larga inventada por ti.
 * 2) Implementar → Nueva implementación → Aplicación web
 *    · Ejecutar como: Yo
 *    · Quién tiene acceso: Cualquier usuario
 * 3) Copia la URL que termina en /exec.
 */
const CLAVE = 'CAMBIA-ESTA-CLAVE';

const CARPETA = 'DepoPatin';
const BD = 'depopatin_db.json';

function doGet() {
  return salida({ ok: true, app: 'DepoPatin' });
}

function doPost(e) {
  try {
    const req = JSON.parse((e && e.postData && e.postData.contents) || '{}');
    if (CLAVE === 'CAMBIA-ESTA-CLAVE') return salida({ error: 'Falta poner la CLAVE en el script de Google.' });
    if (req.key !== CLAVE) return salida({ error: 'Clave incorrecta', auth: true });

    switch (req.action) {
      case 'ping':
        return salida({ ok: true, email: Session.getEffectiveUser().getEmail() });
      case 'read':
        return salida({ db: leerBD() });
      case 'upload':
        return salida({ fileId: subirFoto(req.name, req.data) });
      case 'photo':
        return salida(foto(req.id, req.thumb));
      case 'deleteFile':
        papelera(req.id);
        return salida({ ok: true });
      case 'save':
        return salida(conBloqueo(() => guardar(req)));
      case 'delete':
        return salida(conBloqueo(() => eliminar(req.id)));
      default:
        return salida({ error: 'Acción desconocida' });
    }
  } catch (err) {
    return salida({ error: String(err && err.message || err) });
  }
}

/* ---------- utilidades ---------- */
function salida(o) {
  return ContentService.createTextOutput(JSON.stringify(o)).setMimeType(ContentService.MimeType.JSON);
}
function conBloqueo(fn) {
  const lock = LockService.getScriptLock();
  lock.waitLock(30000); // si dos personas guardan a la vez, una espera a la otra
  try { return fn(); } finally { lock.releaseLock(); }
}
function carpeta() {
  const props = PropertiesService.getScriptProperties();
  const id = props.getProperty('folderId');
  if (id) {
    try { const f = DriveApp.getFolderById(id); if (!f.isTrashed()) return f; } catch (e) { }
  }
  const it = DriveApp.getFoldersByName(CARPETA);
  let f = null;
  while (it.hasNext()) { const x = it.next(); if (!x.isTrashed()) { f = x; break; } }
  if (!f) f = DriveApp.createFolder(CARPETA);
  props.setProperty('folderId', f.getId());
  return f;
}
function archivoBD() {
  const it = carpeta().getFilesByName(BD);
  while (it.hasNext()) { const x = it.next(); if (!x.isTrashed()) return x; }
  return carpeta().createFile(BD, JSON.stringify({ version: 1, records: [] }), 'application/json');
}
function leerBD() {
  const d = JSON.parse(archivoBD().getBlob().getDataAsString('UTF-8') || '{}');
  if (!Array.isArray(d.records)) d.records = [];
  if (!d.version) d.version = 1;
  return d;
}
function escribirBD(d) {
  archivoBD().setContent(JSON.stringify(d));
}
function papelera(id) {
  try { DriveApp.getFileById(id).setTrashed(true); } catch (e) { }
}
function subirFoto(nombre, base64) {
  const blob = Utilities.newBlob(Utilities.base64Decode(base64), 'image/jpeg', nombre || 'foto.jpg');
  return carpeta().createFile(blob).getId();
}
function foto(id, thumb) {
  const f = DriveApp.getFileById(id);
  let b = null;
  if (thumb) { try { b = f.getThumbnail(); } catch (e) { } }
  if (!b) b = f.getBlob();
  return { mime: b.getContentType() || 'image/jpeg', data: Utilities.base64Encode(b.getBytes()) };
}

/* ---------- registros ---------- */
function guardar(req) {
  const d = leerBD();
  const r0 = req.record || {};
  const ahora = new Date().toISOString();
  const quitar = req.remove || [];
  const nuevas = req.add || [];
  let r;
  if (r0.id) {
    r = d.records.find(x => x.id === r0.id);
    if (!r) throw new Error('El registro ya no existe (¿lo borraron desde otro dispositivo?)');
    r.patinId = r0.patinId; r.chasis = r0.chasis; r.fecha = r0.fecha; r.notas = r0.notas || '';
    r.fotos = (r.fotos || []).filter(f => quitar.indexOf(f.fileId) < 0).concat(nuevas);
    r.modificado = ahora;
  } else {
    r = {
      id: Utilities.getUuid(), patinId: r0.patinId, chasis: r0.chasis, fecha: r0.fecha,
      notas: r0.notas || '', fotos: nuevas, creado: ahora, modificado: ahora
    };
    d.records.push(r);
  }
  escribirBD(d);
  quitar.forEach(papelera);
  return { db: d, record: r };
}
function eliminar(id) {
  const d = leerBD();
  const r = d.records.find(x => x.id === id);
  d.records = d.records.filter(x => x.id !== id);
  escribirBD(d);
  if (r) (r.fotos || []).forEach(f => papelera(f.fileId));
  return { db: d };
}
