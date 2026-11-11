// Backup: alle Dokumente in eine einzige, verschlüsselte Datei packen –
// und wieder einlesen (z. B. auf einem neuen iPhone).
//
// Die Dokumente bleiben im Backup verschlüsselt. Zum Öffnen braucht man
// das Passwort, das beim Erstellen des Backups gültig war.
//
// Dateiaufbau (.dokbak):
//   8 Byte  "DOKBAK01"
//   4 Byte  Länge des Kopfteils
//   Kopfteil (JSON): Tresor-Datensatz + Verzeichnis der Inhalte
//   Datenteil: die verschlüsselten Inhalte direkt hintereinander

import { openVault, encryptBytes, decryptBytes, encryptJSON, decryptJSON } from './crypto.js';
import * as db from './db.js';
import { todayISO } from './dom.js';
import { mergeFolders } from './folders.js';

const MAGIC = 'DOKBAK01';
const FORMAT = 'dokumente-backup';

// ---------- Base64 für kleine Werte im Kopfteil ----------
function toB64(bytes) {
  let s = '';
  for (let i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]);
  return btoa(s);
}

function fromB64(text) {
  const s = atob(text);
  const bytes = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) bytes[i] = s.charCodeAt(i);
  return bytes;
}

export class BackupFormatError extends Error {}

// ---------------------------------------------------------------------
// Erstellen
// ---------------------------------------------------------------------
export async function createBackup(key) {
  const vault = await db.getMeta('vault');
  const records = await db.getAllDocs();
  const parts = [];
  let offset = 0;

  const addBox = (box) => {
    parts.push(box.data);
    const ref = { iv: toB64(box.iv), off: offset, len: box.data.byteLength };
    offset += box.data.byteLength;
    return ref;
  };

  const entries = [];
  for (const record of records) {
    const meta = await decryptJSON(key, record.meta); // nur um die Seitenzahl zu kennen
    const pages = await db.getPages(record.id, meta.pageCount);
    if (pages.some((p) => !p)) throw new Error(`Seiten von „${meta.title}“ fehlen`);
    // Ab Version 3: erkannter Text, Wortpositionen und Originaldatei (alles weiterhin verschlüsselt)
    const texts = await db.getPageTexts(record.id, meta.pageCount);
    const words = [];
    for (let i = 0; i < meta.pageCount; i++) words.push(await db.getPageWords(record.id, i));
    const file = await db.getFile(record.id);
    entries.push({
      id: record.id,
      meta: addBox(record.meta),
      thumb: addBox(record.thumb),
      pages: pages.map(addBox),
      texts: texts.map((b) => (b ? addBox(b) : null)),
      words: words.map((b) => (b ? addBox(b) : null)),
      file: file ? { data: addBox(file), info: addBox(file.info) } : null
    });
  }

  // Eigene Ablageorte (verschlüsselt) mitsichern
  const foldersBox = await db.getMeta('folders');

  const header = {
    format: FORMAT,
    version: 3,
    folders: foldersBox ? addBox(foldersBox) : null,
    created: new Date().toISOString(),
    vault: {
      kdf: vault.kdf,
      iterations: vault.iterations,
      salt: toB64(vault.salt),
      iv: toB64(vault.iv),
      wrappedKey: toB64(vault.wrappedKey)
    },
    docs: entries
  };
  const headerBytes = new TextEncoder().encode(JSON.stringify(header));
  const lengthBytes = new Uint8Array(4);
  new DataView(lengthBytes.buffer).setUint32(0, headerBytes.length);

  const blob = new Blob([new TextEncoder().encode(MAGIC), lengthBytes, headerBytes, ...parts], { type: 'application/octet-stream' });
  return { blob, count: entries.length, fileName: `dokumente-backup-${todayISO()}.dokbak` };
}

/**
 * Backup-Datei sichern. Muss direkt aus einem Fingertipp heraus aufgerufen
 * werden, sonst erlaubt das iPhone das Teilen-Menü nicht.
 * Ergebnis: 'shared' | 'downloaded' | 'cancelled'
 */
export async function saveBackupFile(backup) {
  const file = new File([backup.blob], backup.fileName, { type: 'application/octet-stream' });
  if (navigator.canShare && navigator.canShare({ files: [file] })) {
    try {
      await navigator.share({ files: [file], title: 'Dokumente-Backup' });
      return 'shared';
    } catch (err) {
      if (err.name === 'AbortError') return 'cancelled';
      throw err;
    }
  }
  const url = URL.createObjectURL(backup.blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = backup.fileName;
  document.body.append(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 60000);
  return 'downloaded';
}

// ---------------------------------------------------------------------
// Einlesen
// ---------------------------------------------------------------------
export async function readBackupFile(file) {
  const buffer = await file.arrayBuffer();
  const bytes = new Uint8Array(buffer);
  const magic = new TextDecoder().decode(bytes.subarray(0, 8));
  if (bytes.length < 12 || magic !== MAGIC) throw new BackupFormatError('Das ist keine Backup-Datei dieser App.');

  const headerLength = new DataView(buffer).getUint32(8);
  if (12 + headerLength > bytes.length) throw new BackupFormatError('Die Backup-Datei ist beschädigt.');

  let header;
  try {
    header = JSON.parse(new TextDecoder().decode(bytes.subarray(12, 12 + headerLength)));
  } catch {
    throw new BackupFormatError('Die Backup-Datei ist beschädigt.');
  }
  if (header.format !== FORMAT || ![1, 2, 3].includes(header.version) || !Array.isArray(header.docs)) {
    throw new BackupFormatError('Diese Backup-Version wird nicht unterstützt.');
  }
  return { header, body: bytes.subarray(12 + headerLength) };
}

/**
 * Dokumente aus dem Backup übernehmen. Sie werden mit dem Schlüssel des
 * Backups entschlüsselt und mit dem aktuellen Schlüssel neu verschlüsselt.
 * Bereits vorhandene Dokumente werden übersprungen.
 */
export async function importBackup(currentKey, backup, backupPassword, onProgress = () => {}) {
  const { header, body } = backup;
  const vault = {
    iterations: header.vault.iterations,
    salt: fromB64(header.vault.salt),
    iv: fromB64(header.vault.iv),
    wrappedKey: fromB64(header.vault.wrappedKey)
  };
  const backupKey = await openVault(vault, backupPassword); // wirft WrongPasswordError

  const box = (ref) => {
    if (ref.off < 0 || ref.off + ref.len > body.length) throw new BackupFormatError('Die Backup-Datei ist beschädigt.');
    return { iv: fromB64(ref.iv), data: body.subarray(ref.off, ref.off + ref.len) };
  };

  // Zuerst die Ablageorte übernehmen, damit die Dokumente ihren Ordner finden
  let foldersAdded = 0;
  if (header.folders) {
    foldersAdded = await mergeFolders(currentKey, await decryptJSON(backupKey, box(header.folders)));
  }

  const existing = new Set(await db.getAllDocIds());
  let imported = 0;
  let skipped = 0;
  for (const [index, entry] of header.docs.entries()) {
    onProgress(index + 1, header.docs.length);
    if (existing.has(entry.id)) { skipped++; continue; }

    const meta = await decryptJSON(backupKey, box(entry.meta));
    const thumb = await decryptBytes(backupKey, box(entry.thumb));
    const pages = [];
    for (const ref of entry.pages) pages.push(await encryptBytes(currentKey, await decryptBytes(backupKey, box(ref))));

    const reencrypt = async (ref) => (ref ? encryptBytes(currentKey, await decryptBytes(backupKey, box(ref))) : null);
    const texts = [];
    const words = [];
    for (const ref of entry.texts || []) texts.push(await reencrypt(ref));
    for (const ref of entry.words || []) words.push(await reencrypt(ref));
    let file = null;
    if (entry.file) file = { ...(await reencrypt(entry.file.data)), info: await reencrypt(entry.file.info) };

    await db.putDocWithPages({
      id: entry.id,
      v: 1,
      meta: await encryptJSON(currentKey, { ...meta, pageCount: pages.length }),
      thumb: await encryptBytes(currentKey, thumb)
    }, pages, { texts, words, file });
    imported++;
  }
  return { imported, skipped, foldersAdded };
}
