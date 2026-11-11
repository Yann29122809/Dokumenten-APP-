// Lokaler Speicher im Browser (IndexedDB). Bleibt auf dem Gerät.
//
// Speicherbereiche (alle Inhalte verschlüsselt, nur IDs und Zähler im Klartext):
//  - "meta":      Tresor-Datensatz, Einstellungen, Ordner, Schema-Version …
//  - "docs":      ein Eintrag pro Dokument (Angaben + Vorschaubild)
//  - "pages":     Seiten-Bilder, Schlüssel "<id>/<nr>"
//  - "pagetext":  erkannter Text je Seite, Schlüssel "<id>/<nr>"        (ab Version 3)
//  - "pagewords": Wörter mit Position je Seite, Schlüssel "<id>/<nr>"   (ab Version 3)
//  - "jobs":      Warteschlange der Texterkennung (nur IDs und Status)   (ab Version 3)
//  - "files":     Originaldatei (z. B. PDF), Schlüssel "<id>"            (ab Version 3)
//  - "inbox":     Eingang für importierte, noch nicht bestätigte Dateien (ab Version 3)
//
// Versionen der Datenbank:
//  1: meta, docs
//  2: + pages
//  3: + pagetext, pagewords, jobs, files, inbox  (nur neue Bereiche, nichts umgebaut)

const DB_NAME = 'dokumente';
const DB_VERSION = 3;
let dbPromise = null;

function openDb() {
  if (!dbPromise) {
    dbPromise = new Promise((resolve, reject) => {
      const request = indexedDB.open(DB_NAME, DB_VERSION);
      request.onupgradeneeded = () => {
        const db = request.result;
        const ensure = (name, options) => { if (!db.objectStoreNames.contains(name)) db.createObjectStore(name, options); };
        ensure('meta');
        ensure('docs', { keyPath: 'id' });
        ensure('pages');
        ensure('pagetext');
        ensure('pagewords');
        ensure('jobs', { keyPath: 'id' });
        ensure('files');
        ensure('inbox', { keyPath: 'id' });
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

export const pageKey = (docId, index) => `${docId}/${index}`;

// ---------- Einstellungen / Tresor ----------
export const getMeta = (key) => transact('meta', 'readonly', (s) => s.meta.get(key));
export const setMeta = (key, value) => transact('meta', 'readwrite', (s) => s.meta.put(value, key));

// ---------- Dokumente ----------
export const getAllDocs = () => transact('docs', 'readonly', (s) => s.docs.getAll());
export const getAllDocIds = () => transact('docs', 'readonly', (s) => s.docs.getAllKeys());
export const getDoc = (id) => transact('docs', 'readonly', (s) => s.docs.get(id));
export const putDoc = (record) => transact('docs', 'readwrite', (s) => s.docs.put(record));

/** Dokument und alle Seiten in einem Schritt speichern (ganz oder gar nicht). */
export function putDocWithPages(record, pages, extra = {}) {
  return transact(['docs', 'pages', 'pagetext', 'pagewords', 'files'], 'readwrite', (s) => {
    s.docs.put(record);
    pages.forEach((page, i) => s.pages.put(page, pageKey(record.id, i)));
    (extra.texts || []).forEach((box, i) => { if (box) s.pagetext.put(box, pageKey(record.id, i)); });
    (extra.words || []).forEach((box, i) => { if (box) s.pagewords.put(box, pageKey(record.id, i)); });
    if (extra.file) s.files.put(extra.file, record.id);
  });
}

function getMany(storeName, docId, count) {
  return transact(storeName, 'readonly', (s) => {
    const out = new Array(count);
    for (let i = 0; i < count; i++) {
      const request = s[storeName].get(pageKey(docId, i));
      request.onsuccess = () => { out[i] = request.result; };
    }
    return out;
  });
}

export const getPages = (docId, count) => getMany('pages', docId, count);
export const getPageTexts = (docId, count) => getMany('pagetext', docId, count);
export const getPageWords = (docId, index) => transact('pagewords', 'readonly', (s) => s.pagewords.get(pageKey(docId, index)));
export const getFile = (docId) => transact('files', 'readonly', (s) => s.files.get(docId));

/** Alle Seiten-Texte (für den Suchindex): [{ key, box }] */
export function getAllPageTexts() {
  return transact('pagetext', 'readonly', (s) => {
    const out = [];
    const request = s.pagetext.openCursor();
    request.onsuccess = () => {
      const cursor = request.result;
      if (!cursor) return;
      out.push({ key: cursor.key, box: cursor.value });
      cursor.continue();
    };
    return out;
  });
}

export function putPageText(docId, index, textBox, wordsBox) {
  return transact(['pagetext', 'pagewords'], 'readwrite', (s) => {
    s.pagetext.put(textBox, pageKey(docId, index));
    if (wordsBox) s.pagewords.put(wordsBox, pageKey(docId, index));
  });
}

/** Dokument endgültig löschen – inklusive Text, Originaldatei und offenen Aufträgen. */
export function deleteDoc(docId, pageCount) {
  return transact(['docs', 'pages', 'pagetext', 'pagewords', 'files', 'jobs'], 'readwrite', (s) => {
    s.docs.delete(docId);
    s.files.delete(docId);
    for (let i = 0; i < pageCount; i++) {
      const key = pageKey(docId, i);
      s.pages.delete(key);
      s.pagetext.delete(key);
      s.pagewords.delete(key);
      s.jobs.delete(key);
    }
  });
}

// ---------- Warteschlange der Texterkennung ----------
export const getAllJobs = () => transact('jobs', 'readonly', (s) => s.jobs.getAll());
export const putJob = (job) => transact('jobs', 'readwrite', (s) => s.jobs.put(job));
export const deleteJob = (id) => transact('jobs', 'readwrite', (s) => s.jobs.delete(id));
export function putJobs(jobs) {
  return transact('jobs', 'readwrite', (s) => { jobs.forEach((job) => s.jobs.put(job)); });
}

// ---------- Eingang (Import) ----------
export const getAllInbox = () => transact('inbox', 'readonly', (s) => s.inbox.getAll());
export const putInbox = (item) => transact('inbox', 'readwrite', (s) => s.inbox.put(item));
export const deleteInbox = (id) => transact('inbox', 'readwrite', (s) => s.inbox.delete(id));
