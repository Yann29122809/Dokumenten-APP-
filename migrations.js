// Versionierte Umstellungen des Datenmodells.
//
// Regeln:
//  - Jede Umstellung hat eine Nummer und läuft genau einmal.
//  - Vorher bietet die App an, ein Backup zu sichern (siehe app.js).
//  - Umstellungen fügen nur hinzu, sie löschen oder überschreiben nie
//    bestehende Daten. Schlägt eine fehl, bleibt die alte Version stehen
//    und es wird beim nächsten Entsperren erneut versucht.
//
// Schema 2 → 3: Der bisher pro Dokument gespeicherte Text (meta.text) wird
// zusätzlich als Seiten-Text abgelegt, damit die neue Suche ihn findet.
// meta.text selbst bleibt unverändert erhalten.

import { getMeta, setMeta, getAllDocs, getPageTexts, putPageText } from './db.js';
import { decryptJSON, encryptJSON } from './crypto.js';

export const SCHEMA_VERSION = 3;

const MIGRATIONS = {
  3: async (key) => {
    for (const record of await getAllDocs()) {
      let meta;
      try { meta = await decryptJSON(key, record.meta); } catch { continue; }
      if (!meta.text || !meta.text.trim()) continue;
      const existing = await getPageTexts(record.id, meta.pageCount || 1);
      if (existing.some(Boolean)) continue;
      await putPageText(record.id, 0, await encryptJSON(key, { text: meta.text, source: 'alt' }), null);
    }
  }
};

export async function currentSchema() {
  const stored = await getMeta('schema');
  if (stored) return stored;
  // Ohne Eintrag: Gibt es schon einen Tresor, ist es der Stand vor Version 3.
  return (await getMeta('vault')) ? 2 : SCHEMA_VERSION;
}

export async function needsMigration() {
  return (await currentSchema()) < SCHEMA_VERSION;
}

/** Alle fehlenden Umstellungen nacheinander ausführen. */
export async function runMigrations(key) {
  let version = await currentSchema();
  while (version < SCHEMA_VERSION) {
    const next = version + 1;
    if (MIGRATIONS[next]) await MIGRATIONS[next](key);
    await setMeta('schema', next);
    version = next;
  }
}

/** Für neu eingerichtete Tresore: gleich die aktuelle Version eintragen. */
export const markSchemaCurrent = () => setMeta('schema', SCHEMA_VERSION);
