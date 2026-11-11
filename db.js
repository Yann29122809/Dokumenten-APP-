// Lokaler Speicher im Browser (IndexedDB). Bleibt auf dem Gerät.
//
// Speicherbereiche:
//  - "meta": Tresor-Datensatz (eingepackter Schlüssel) und Einstellungen
//  - "docs": später die verschlüsselten Dokumente

const DB_NAME = 'dokumente';
const DB_VERSION = 1;
let dbPromise = null;

function openDb() {
  if (!dbPromise) {
    dbPromise = new Promise((resolve, reject) => {
      const request = indexedDB.open(DB_NAME, DB_VERSION);
      request.onupgradeneeded = () => {
        const db = request.result;
        if (!db.objectStoreNames.contains('meta')) db.createObjectStore('meta');
        if (!db.objectStoreNames.contains('docs')) db.createObjectStore('docs', { keyPath: 'id' });
      };
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
  }
  return dbPromise;
}

function run(storeName, mode, action) {
  return openDb().then((db) => new Promise((resolve, reject) => {
    const tx = db.transaction(storeName, mode);
    const request = action(tx.objectStore(storeName));
    tx.oncomplete = () => resolve(request.result);
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error);
  }));
}

export function getMeta(key) {
  return run('meta', 'readonly', (store) => store.get(key));
}

export function setMeta(key, value) {
  return run('meta', 'readwrite', (store) => store.put(value, key));
}
