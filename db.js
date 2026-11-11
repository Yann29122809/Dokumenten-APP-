// Lokaler Speicher im Browser (IndexedDB). Bleibt auf dem Gerät.
//
// Speicherbereiche:
//  - "meta":  Tresor-Datensatz (eingepackter Schlüssel) und Einstellungen
//  - "docs":  ein Eintrag pro Dokument (Angaben + Vorschaubild, verschlüsselt)
//  - "pages": die einzelnen Seiten-Bilder (verschlüsselt), Schlüssel "<id>/<nr>"

const DB_NAME = 'dokumente';
const DB_VERSION = 2;
let dbPromise = null;

function openDb() {
  if (!dbPromise) {
    dbPromise = new Promise((resolve, reject) => {
      const request = indexedDB.open(DB_NAME, DB_VERSION);
      request.onupgradeneeded = () => {
        const db = request.result;
        if (!db.objectStoreNames.contains('meta')) db.createObjectStore('meta');
        if (!db.objectStoreNames.contains('docs')) db.createObjectStore('docs', { keyPath: 'id' });
        if (!db.objectStoreNames.contains('pages')) db.createObjectStore('pages');
      };
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
      request.onblocked = () => reject(new Error('Speicher ist blockiert – bitte App neu öffnen.'));
    });
  }
  return dbPromise;
}

// Führt eine Transaktion aus. "work" bekommt die Speicherbereiche und darf
// nur IndexedDB-Befehle ausführen (kein await dazwischen!).
async function transact(storeNames, mode, work) {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const names = [].concat(storeNames);
    const tx = db.transaction(names, mode);
    const stores = Object.fromEntries(names.map((name) => [name, tx.objectStore(name)]));
    const result = work(stores);
    tx.oncomplete = () => resolve(result instanceof IDBRequest ? result.result : result);
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error || new Error('Speichern abgebrochen'));
  });
}

const pageKey = (docId, index) => `${docId}/${index}`;

// ---------- Einstellungen / Tresor ----------
export const getMeta = (key) => transact('meta', 'readonly', (s) => s.meta.get(key));
export const setMeta = (key, value) => transact('meta', 'readwrite', (s) => s.meta.put(value, key));

// ---------- Dokumente ----------
export const getAllDocs = () => transact('docs', 'readonly', (s) => s.docs.getAll());
export const getAllDocIds = () => transact('docs', 'readonly', (s) => s.docs.getAllKeys());
export const getDoc = (id) => transact('docs', 'readonly', (s) => s.docs.get(id));
export const putDoc = (record) => transact('docs', 'readwrite', (s) => s.docs.put(record));

/** Dokument und alle Seiten in einem Schritt speichern (ganz oder gar nicht). */
export function putDocWithPages(record, pages) {
  return transact(['docs', 'pages'], 'readwrite', (s) => {
    s.docs.put(record);
    pages.forEach((page, i) => s.pages.put(page, pageKey(record.id, i)));
  });
}

export function getPages(docId, count) {
  return transact('pages', 'readonly', (s) => {
    const out = new Array(count);
    for (let i = 0; i < count; i++) {
      const request = s.pages.get(pageKey(docId, i));
      request.onsuccess = () => { out[i] = request.result; };
    }
    return out;
  });
}

export function deleteDoc(docId, pageCount) {
  return transact(['docs', 'pages'], 'readwrite', (s) => {
    s.docs.delete(docId);
    for (let i = 0; i < pageCount; i++) s.pages.delete(pageKey(docId, i));
  });
}
