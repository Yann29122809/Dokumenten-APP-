// Kleiner ZIP-Schreiber ohne fremde Bibliothek.
//
// - Dateien werden „gespeichert“ (ohne zusätzliche Kompression). PDFs mit
//   JPEG-Bildern sind schon komprimiert – Kompression würde nur Zeit kosten.
// - Dateinamen in UTF-8 (Umlaute funktionieren auf iPhone, Mac und Windows).
// - Speicher schonen: Fertige Teile werden regelmäßig zu einem Blob
//   zusammengefasst, damit nicht alles gleichzeitig als JavaScript-Speicher
//   vorgehalten wird.

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

export function crc32(bytes) {
  let crc = 0xffffffff;
  for (let i = 0; i < bytes.length; i++) crc = CRC_TABLE[(crc ^ bytes[i]) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

const FLUSH_BYTES = 16 * 1024 * 1024; // alle 16 MB zu einem Blob zusammenfassen
const MAX_ZIP = 0xffffffff - 1024 * 1024; // klassisches ZIP: höchstens 4 GB

export class ZipTooLargeError extends Error {}

// Datum/Uhrzeit im DOS-Format, wie ZIP es erwartet
function dosTime(date) {
  return {
    time: (date.getHours() << 11) | (date.getMinutes() << 5) | Math.floor(date.getSeconds() / 2),
    date: ((Math.max(1980, date.getFullYear()) - 1980) << 9) | ((date.getMonth() + 1) << 5) | date.getDate()
  };
}

export class ZipWriter {
  constructor() {
    this.blobs = [];      // bereits zusammengefasste Teile
    this.pending = [];    // noch einzelne Uint8Arrays
    this.pendingBytes = 0;
    this.offset = 0;
    this.central = [];
    this.encoder = new TextEncoder();
    this.stamp = dosTime(new Date());
  }

  push(bytes) {
    this.pending.push(bytes);
    this.pendingBytes += bytes.length;
    this.offset += bytes.length;
    if (this.pendingBytes >= FLUSH_BYTES) this.flush();
  }

  flush() {
    if (!this.pending.length) return;
    this.blobs.push(new Blob(this.pending));
    this.pending = [];
    this.pendingBytes = 0;
  }

  /** Leeren Ordner anlegen (Pfad endet mit „/“). */
  addFolder(path) {
    this.addEntry(path.endsWith('/') ? path : `${path}/`, new Uint8Array(0), true);
  }

  /** Datei hinzufügen: Uint8Array, String oder Blob. */
  async addFile(path, data) {
    let bytes;
    if (typeof data === 'string') bytes = this.encoder.encode(data);
    else if (data instanceof Blob) bytes = new Uint8Array(await data.arrayBuffer());
    else bytes = data;
    this.addEntry(path, bytes, false);
  }

  addEntry(path, bytes, isFolder) {
    const name = this.encoder.encode(path);
    if (this.offset + bytes.length + name.length * 2 + 200 > MAX_ZIP) {
      throw new ZipTooLargeError('Die ZIP-Datei würde größer als 4 GB.');
    }
    const crc = isFolder ? 0 : crc32(bytes);
    const local = new Uint8Array(30 + name.length);
    const v = new DataView(local.buffer);
    v.setUint32(0, 0x04034b50, true);       // Kennung lokaler Kopf
    v.setUint16(4, 20, true);                // benötigte Version
    v.setUint16(6, 0x0800, true);            // Bit 11: Name in UTF-8
    v.setUint16(8, 0, true);                 // ohne Kompression
    v.setUint16(10, this.stamp.time, true);
    v.setUint16(12, this.stamp.date, true);
    v.setUint32(14, crc, true);
    v.setUint32(18, bytes.length, true);
    v.setUint32(22, bytes.length, true);
    v.setUint16(26, name.length, true);
    v.setUint16(28, 0, true);
    local.set(name, 30);

    const headerOffset = this.offset;
    this.push(local);
    if (bytes.length) this.push(bytes);
    this.central.push({ name, crc, size: bytes.length, offset: headerOffset, isFolder });
  }

  /** Inhaltsverzeichnis anhängen und die fertige ZIP als Blob liefern. */
  finish() {
    const start = this.offset;
    for (const e of this.central) {
      const c = new Uint8Array(46 + e.name.length);
      const v = new DataView(c.buffer);
      v.setUint32(0, 0x02014b50, true);      // Kennung Verzeichniseintrag
      v.setUint16(4, (3 << 8) | 20, true);   // erstellt unter „Unix“, Version 2.0
      v.setUint16(6, 20, true);
      v.setUint16(8, 0x0800, true);
      v.setUint16(10, 0, true);
      v.setUint16(12, this.stamp.time, true);
      v.setUint16(14, this.stamp.date, true);
      v.setUint32(16, e.crc, true);
      v.setUint32(20, e.size, true);
      v.setUint32(24, e.size, true);
      v.setUint16(28, e.name.length, true);
      v.setUint16(30, 0, true);
      v.setUint16(32, 0, true);
      v.setUint16(34, 0, true);
      v.setUint16(36, 0, true);
      // Zugriffsrechte: Ordner 755, Dateien 644 (damit Mac/Linux sie normal öffnen)
      v.setUint32(38, ((e.isFolder ? 0o40755 : 0o100644) << 16) | (e.isFolder ? 0x10 : 0), true);
      v.setUint32(42, e.offset, true);
      c.set(e.name, 46);
      this.push(c);
    }
    const size = this.offset - start;
    const end = new Uint8Array(22);
    const v = new DataView(end.buffer);
    v.setUint32(0, 0x06054b50, true);
    v.setUint16(8, this.central.length, true);
    v.setUint16(10, this.central.length, true);
    v.setUint32(12, size, true);
    v.setUint32(16, start, true);
    this.push(end);
    this.flush();
    if (this.central.length > 0xffff) throw new ZipTooLargeError('Zu viele Einträge für eine ZIP-Datei (über 65.000).');
    const blob = new Blob(this.blobs, { type: 'application/zip' });
    this.blobs = [];
    this.central = [];
    return blob;
  }
}
