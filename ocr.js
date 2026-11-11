// Texterkennung (OCR) mit Tesseract – läuft komplett auf dem Gerät.
// Die Bilder werden NICHT an einen Server geschickt. Nur das Programm und
// die deutschen Sprachdaten werden beim ersten Mal (ca. 5 MB) von deiner
// eigenen GitHub-Seite geladen und danach zwischengespeichert.

let workerPromise = null;
let progressHandler = null;

function loadScript(src) {
  return new Promise((resolve, reject) => {
    const script = document.createElement('script');
    script.src = src;
    script.onload = resolve;
    script.onerror = () => reject(new Error('Texterkennung konnte nicht geladen werden'));
    document.head.append(script);
  });
}

function getWorker() {
  if (!workerPromise) {
    workerPromise = (async () => {
      if (!window.Tesseract) await loadScript('tesseract.min.js');
      const base = new URL('./', location.href).href;
      return window.Tesseract.createWorker('deu', 1, {
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

let queue = Promise.resolve();

/**
 * Text aus einem Bild lesen. onProgress bekommt { phase, progress }:
 * phase = 'loading' (Programm/Sprachdaten laden) oder 'reading'.
 */
export function recognizeText(blob, onProgress = () => {}) {
  const job = queue.then(async () => {
    progressHandler = (m) => {
      const phase = m.status === 'recognizing text' ? 'reading' : 'loading';
      onProgress({ phase, progress: typeof m.progress === 'number' ? m.progress : 0 });
    };
    try {
      const worker = await getWorker();
      const { data } = await worker.recognize(blob);
      return (data.text || '').replace(/[ \t]+\n/g, '\n').trim();
    } finally {
      progressHandler = null;
    }
  });
  queue = job.catch(() => {});
  return job;
}

/** Beim Sperren: Texterkennung beenden und Speicher freigeben. */
export async function stopOcr() {
  if (!workerPromise) return;
  const pending = workerPromise;
  workerPromise = null;
  try {
    (await pending).terminate();
  } catch { /* egal */ }
}
