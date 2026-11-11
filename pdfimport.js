// PDFs lesen mit pdf.js (liegt im Projekt, wird erst bei Bedarf geladen).
//  - Seiten als Bilder (max. 2000 Pixel) für Vorschau, Suche und Anzeige
//  - Textebene direkt auslesen (keine Texterkennung nötig), inkl. Wortpositionen
//  - Passwortgeschützte PDFs: Passwort wird nur im Arbeitsspeicher benutzt

import { toJpeg, MAX_EDGE } from './images.js';

let pdfjs = null;

async function lib() {
  if (!pdfjs) {
    pdfjs = await import('./pdf.min.js');
    pdfjs.GlobalWorkerOptions.workerSrc = new URL('pdf.worker.min.js', location.href).href;
  }
  return pdfjs;
}

export class PdfPasswordError extends Error {
  constructor(wrong) {
    super(wrong ? 'Das Passwort ist falsch.' : 'Diese PDF ist mit einem Passwort geschützt.');
    this.wrong = wrong;
  }
}

/** PDF öffnen. Wirft PdfPasswordError, wenn ein (richtiges) Passwort fehlt. */
export async function openPdf(bytes, password) {
  const p = await lib();
  const task = p.getDocument({
    data: bytes.slice(), // Kopie: pdf.js übernimmt den Speicher
    password: password || undefined,
    isEvalSupported: false,
    wasmUrl: new URL('./', location.href).href,
    useSystemFonts: true,
    disableAutoFetch: true
  });
  try {
    return await task.promise;
  } catch (err) {
    if (err && err.name === 'PasswordException') {
      throw new PdfPasswordError(err.code === 2 || err.code === p.PasswordResponses?.INCORRECT_PASSWORD);
    }
    throw err;
  }
}

// Textebene einer Seite in Wörter mit Position (Bild-Pixel) umrechnen
function wordsFromText(content, viewport, Util) {
  const words = [];
  const lines = [];
  let lastY = null;
  let line = [];
  for (const item of content.items) {
    if (!item.str) { if (item.hasEOL) { lines.push(line.join(' ')); line = []; } continue; }
    const tx = Util.transform(viewport.transform, item.transform);
    const height = Math.hypot(tx[2], tx[3]);
    const x = tx[4];
    const y = tx[5];
    const width = item.width * viewport.scale;
    if (lastY !== null && Math.abs(y - lastY) > height * 0.6) { lines.push(line.join(' ')); line = []; }
    lastY = y;
    line.push(item.str);
    if (item.hasEOL) { lines.push(line.join(' ')); line = []; lastY = null; }
    // Breite gleichmäßig auf die Wörter verteilen
    const parts = item.str.split(/(\s+)/);
    const total = item.str.length || 1;
    let offset = 0;
    for (const part of parts) {
      const w = (part.length / total) * width;
      if (part.trim()) words.push([part.trim(), Math.round(x + offset), Math.round(y - height), Math.round(x + offset + w), Math.round(y + height * 0.25)]);
      offset += w;
    }
  }
  if (line.length) lines.push(line.join(' '));
  return { text: lines.join('\n').replace(/[ \t]+\n/g, '\n').trim(), words };
}

/**
 * Alle Seiten als JPEG rendern und Text auslesen.
 * Ergebnis: { pages: [{ blob, width, height, text, words }], hasText }
 */
export async function renderPdf(pdf, onProgress = () => {}) {
  const p = await lib();
  const pages = [];
  let textChars = 0;
  for (let n = 1; n <= pdf.numPages; n++) {
    onProgress(n, pdf.numPages);
    const page = await pdf.getPage(n);
    const base = page.getViewport({ scale: 1 });
    const scale = Math.min(3, MAX_EDGE / Math.max(base.width, base.height));
    const viewport = page.getViewport({ scale });
    const canvas = document.createElement('canvas');
    canvas.width = Math.round(viewport.width);
    canvas.height = Math.round(viewport.height);
    const ctx = canvas.getContext('2d');
    ctx.fillStyle = '#fff';
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    // intent 'print': zeichnet ohne Bildschirm-Takt – läuft auch weiter, wenn die App kurz im Hintergrund ist
    await page.render({ canvasContext: ctx, viewport, intent: 'print' }).promise;
    const content = await page.getTextContent();
    const { text, words } = wordsFromText(content, viewport, p.Util);
    textChars += text.replace(/\s/g, '').length;
    const width = canvas.width;
    const height = canvas.height;
    pages.push({ blob: await toJpeg(canvas), width, height, text, words });
    page.cleanup();
  }
  // Nur wenn genug echter Text da ist, gilt die Textebene (sonst Texterkennung)
  const hasText = textChars >= 20 * pdf.numPages || textChars >= 60;
  return { pages, hasText };
}

export async function closePdf(pdf) {
  try { await pdf.destroy(); } catch { /* egal */ }
}
