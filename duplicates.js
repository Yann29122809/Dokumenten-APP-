// Duplikate erkennen – drei Stufen, die günstigste zuerst:
//  1. Gleiche Datei (SHA-256 der Originaldatei bzw. der ersten Seite)
//  2. Gleiches Seitenbild (Bild-Fingerabdruck „dHash“, 256 Bit, alle 4 Drehungen)
//  3. Gleicher Inhalt (Ähnlichkeit der Wörter) – nur zusammen mit Stufe 2
//     oder bei sehr hoher Ähnlichkeit
//
// Schutz vor Fehlalarm bei Serien (Gehalt, Kontoauszug, Stromrechnung):
// Unterscheiden sich Datum, Betrag, Belegnummer oder Abrechnungszeitraum,
// gilt es NIE als Duplikat. Lieber ein Treffer zu wenig als ein falscher.
//
// Fingerabdrücke liegen nur verschlüsselt in den Angaben (meta.fp).
// „Kein Duplikat“-Entscheidungen werden pro Paar verschlüsselt gespeichert.

import { loadImage } from './images.js';
import { extractKeys } from './suggest.js';
import { fold } from './search.js';
import { encryptJSON, decryptJSON, decryptBytes } from './crypto.js';
import { getMeta, setMeta } from './db.js';

const HASH_SIZE = 16;                 // 16 × 16 = 256 Bit
const IMAGE_CLOSE = 0.12;             // ≤ 12 % abweichende Bits: sehr ähnliches Bild
const IMAGE_VERY_CLOSE = 0.05;        // ≤ 5 %: praktisch dasselbe Bild
const TEXT_SIMILAR = 0.7;
const TEXT_VERY_SIMILAR = 0.9;

// ---------------------------------------------------------------------
// Fingerabdrücke
// ---------------------------------------------------------------------
export async function sha256(bytes) {
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

// dHash: Bild verkleinern, Helligkeit benachbarter Punkte vergleichen
function dhashFromCanvas(canvas) {
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  const { data } = ctx.getImageData(0, 0, HASH_SIZE + 1, HASH_SIZE);
  let bits = '';
  for (let y = 0; y < HASH_SIZE; y++) {
    for (let x = 0; x < HASH_SIZE; x++) {
      const i = (y * (HASH_SIZE + 1) + x) * 4;
      const a = data[i] * 0.299 + data[i + 1] * 0.587 + data[i + 2] * 0.114;
      const b = data[i + 4] * 0.299 + data[i + 5] * 0.587 + data[i + 6] * 0.114;
      bits += a > b ? '1' : '0';
    }
  }
  let hex = '';
  for (let i = 0; i < bits.length; i += 4) hex += parseInt(bits.slice(i, i + 4), 2).toString(16);
  return hex;
}

/** Bild-Fingerabdrücke für 0°, 90°, 180°, 270° (Drehung normalisieren). */
export async function imageHashes(blob) {
  const img = await loadImage(blob);
  const hashes = [];
  for (let turn = 0; turn < 4; turn++) {
    const canvas = document.createElement('canvas');
    canvas.width = HASH_SIZE + 1;
    canvas.height = HASH_SIZE;
    const ctx = canvas.getContext('2d', { willReadFrequently: true });
    ctx.translate(canvas.width / 2, canvas.height / 2);
    ctx.rotate((turn * Math.PI) / 2);
    const sideways = turn % 2 === 1;
    const w = sideways ? canvas.height : canvas.width;
    const h = sideways ? canvas.width : canvas.height;
    ctx.drawImage(img, -w / 2, -h / 2, w, h);
    hashes.push(dhashFromCanvas(canvas));
  }
  return hashes;
}

function hamming(a, b) {
  let d = 0;
  for (let i = 0; i < a.length; i++) {
    let x = parseInt(a[i], 16) ^ parseInt(b[i], 16);
    while (x) { d += x & 1; x >>= 1; }
  }
  return d / (a.length * 4);
}

/** Kleinste Abweichung zwischen zwei Bildern über alle Drehungen. */
function imageDistance(a, b) {
  if (!a || !b || !a.length || !b.length) return 1;
  return Math.min(...b.map((h) => hamming(a[0], h)));
}

function wordSet(text) {
  return new Set(fold(text).split(/[^\p{L}\p{N}]+/u).filter((w) => w.length >= 3).slice(0, 800));
}

function textSimilarity(a, b) {
  if (!a || !b) return null;
  const A = wordSet(a);
  const B = wordSet(b);
  if (A.size < 8 || B.size < 8) return null;
  let common = 0;
  for (const w of A) if (B.has(w)) common++;
  return common / (A.size + B.size - common);
}

/**
 * Fingerabdruck eines Dokuments.
 * input: { fileBytes?, firstPage (Blob), thumb (Blob), text, meta }
 */
export async function makeFingerprint({ fileBytes, firstPage, thumb, text, meta = {} }) {
  const keys = extractKeys(text || '');
  return {
    v: 1,
    sha: fileBytes ? await sha256(fileBytes) : (firstPage ? await sha256(new Uint8Array(await firstPage.arrayBuffer())) : null),
    img: thumb ? await imageHashes(thumb) : null,
    keys: { date: keys.date || null, amount: keys.amount || null, ref: keys.ref || null, period: keys.period || null },
    words: text ? [...wordSet(text)].slice(0, 400) : null
  };
}

// Abweichende Schlüsselfelder (beide vorhanden, aber verschieden)
function conflicts(a, b) {
  const out = [];
  for (const field of ['date', 'amount', 'ref', 'period']) {
    if (a.keys[field] && b.keys[field] && a.keys[field] !== b.keys[field]) out.push(field);
  }
  return out;
}

/**
 * Zwei Fingerabdrücke vergleichen.
 * Ergebnis: null (kein Duplikat) oder { level: 'datei'|'bild'|'inhalt', score, differences }
 */
export function compareFingerprints(a, b, metaA = {}, metaB = {}) {
  if (!a || !b) return null;
  if (a.sha && b.sha && a.sha === b.sha) return { level: 'datei', score: 1, differences: [] };

  const keyConflicts = conflicts(a, b);
  if (keyConflicts.length) return null; // Serie, nicht doppelt

  const imgDist = imageDistance(a.img, b.img);
  const textSim = a.words && b.words ? textSimilarity(a.words.join(' '), b.words.join(' ')) : null;

  let level = null;
  if (imgDist <= IMAGE_CLOSE && textSim !== null && textSim >= TEXT_SIMILAR) level = 'inhalt';
  else if (textSim !== null && textSim >= TEXT_VERY_SIMILAR) level = 'inhalt';
  else if (imgDist <= IMAGE_VERY_CLOSE && (textSim === null || textSim >= TEXT_SIMILAR)) level = 'bild';
  if (!level) return null;

  // Unterschiede in den Angaben (zur farbigen Markierung)
  const differences = [];
  if (metaA.title !== metaB.title) differences.push('title');
  if (metaA.category !== metaB.category) differences.push('category');
  if (metaA.date !== metaB.date) differences.push('date');
  if (metaA.pageCount !== metaB.pageCount) differences.push('pageCount');
  return { level, score: textSim !== null ? textSim : 1 - imgDist, differences };
}

// ---------------------------------------------------------------------
// „Kein Duplikat“-Entscheidungen
// ---------------------------------------------------------------------
let decisions = new Set();

export const pairKey = (a, b) => [a, b].sort().join('|');

export async function loadDecisions(key) {
  try {
    const box = await getMeta('dupDecisions');
    decisions = new Set(box ? await decryptJSON(key, box) : []);
  } catch {
    decisions = new Set();
  }
}

export const isDecided = (a, b) => decisions.has(pairKey(a, b));

export async function rememberNotDuplicate(key, a, b) {
  decisions.add(pairKey(a, b));
  await setMeta('dupDecisions', await encryptJSON(key, [...decisions]));
}

export async function forgetDecision(key, a, b) {
  decisions.delete(pairKey(a, b));
  await setMeta('dupDecisions', await encryptJSON(key, [...decisions]));
}

export const clearDecisions = () => { decisions = new Set(); };

// ---------------------------------------------------------------------
// Fingerabdrücke für den Bestand nachholen (in kleinen Portionen)
// ---------------------------------------------------------------------
export async function fingerprintFor(key, doc, text, getOriginal) {
  if (doc.meta.fp && doc.meta.fp.v === 1) return doc.meta.fp;
  const thumb = new Blob([await decryptBytes(key, doc.thumb)], { type: 'image/jpeg' });
  const original = getOriginal ? await getOriginal(doc) : null;
  return makeFingerprint({ fileBytes: original, thumb, text, meta: doc.meta });
}

/** Neues Dokument gegen den Bestand prüfen. */
export function findMatches(fp, meta, docs, excludeId = null) {
  const out = [];
  for (const doc of docs) {
    if (doc.id === excludeId || doc.meta.trashedAt || !doc.meta.fp) continue;
    const result = compareFingerprints(fp, doc.meta.fp, meta, doc.meta);
    if (result) out.push({ doc, ...result });
  }
  return out.sort((a, b) => b.score - a.score);
}
