// Texterkennung (OCR) mit Tesseract – läuft komplett auf dem Gerät.
// Die Bilder werden NICHT an einen Server geschickt. Programm und
// Sprachdaten liegen im Projekt und werden beim ersten Mal von deiner
// eigenen GitHub-Seite geladen und danach offline zwischengespeichert.
//
// Sprachen: deu (immer), fra und eng wahlweise (Einstellungen).

let workerPromise = null;
let workerLangs = null;
let progressHandler = null;
let wantedLangs = 'deu';

export const LANGUAGE_OPTIONS = {
  deu: 'Deutsch',
  'deu+fra': 'Deutsch + Französisch',
  'deu+eng': 'Deutsch + Englisch',
  'deu+fra+eng': 'Deutsch + Französisch + Englisch'
};

export function setOcrLanguages(langs) {
  wantedLangs = LANGUAGE_OPTIONS[langs] ? langs : 'deu';
}

function loadScript(src) {
  return new Promise((resolve, reject) => {
    const script = document.createElement('script');
    script.src = src;
    script.onload = resolve;
    script.onerror = () => reject(new Error('Texterkennung konnte nicht geladen werden'));
    document.head.append(script);
  });
}

async function getWorker() {
  // Sprache geändert → alten Worker beenden
  if (workerPromise && workerLangs !== wantedLangs) await stopOcr();
  if (!workerPromise) {
    workerLangs = wantedLangs;
    workerPromise = (async () => {
      if (!window.Tesseract) await loadScript('tesseract.min.js');
      const base = new URL('./', location.href).href;
      return window.Tesseract.createWorker(wantedLangs.split('+'), 1, {
        workerPath: `${base}worker.min.js`,
        corePath: base,
        langPath: base,
        workerBlobURL: false,
        gzip: true,
        logger: (message) => { if (progressHandler) progressHandler(message); }
      });
    })().catch((err) => {
      workerPromise = null;
      throw err;
    });
  }
  return workerPromise;
}

// Alle Wörter mit Position aus der Tesseract-Ausgabe sammeln
function collectWords(blocks) {
  const words = [];
  const walk = (node) => {
    if (!node || typeof node !== 'object') return;
    if (Array.isArray(node)) { node.forEach(walk); return; }
    if (Array.isArray(node.words)) {
      for (const w of node.words) {
        const text = (w.text || '').trim();
        if (text && w.bbox) words.push([text, w.bbox.x0, w.bbox.y0, w.bbox.x1, w.bbox.y1]);
      }
      return;
    }
    walk(node.blocks); walk(node.paragraphs); walk(node.lines);
  };
  walk(blocks);
  return words;
}

let queue = Promise.resolve();

/**
 * Text aus einem Bild lesen. Ergebnis: { text, words: [[wort, x0, y0, x1, y1], …] }
 * onProgress bekommt { phase: 'loading' | 'reading', progress }.
 */
export function recognizePage(blob, onProgress = () => {}) {
  const job = queue.then(async () => {
    progressHandler = (m) => {
      const phase = m.status === 'recognizing text' ? 'reading' : 'loading';
      onProgress({ phase, progress: typeof m.progress === 'number' ? m.progress : 0 });
    };
    try {
      const worker = await getWorker();
      const { data } = await worker.recognize(blob, {}, { text: true, blocks: true });
      return {
        text: (data.text || '').replace(/[ \t]+\n/g, '\n').trim(),
        words: collectWords(data.blocks)
      };
    } finally {
      progressHandler = null;
    }
  });
  queue = job.catch(() => {});
  return job;
}

/** Nur den Text (für ältere Aufrufer). */
export async function recognizeText(blob, onProgress) {
  return (await recognizePage(blob, onProgress)).text;
}

/** Beim Sperren: Texterkennung beenden und Speicher freigeben. */
export async function stopOcr() {
  if (!workerPromise) return;
  const pending = workerPromise;
  workerPromise = null;
  workerLangs = null;
  try {
    (await pending).terminate();
  } catch { /* egal */ }
}
