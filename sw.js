'use strict';

// Bei jeder Änderung an den Dateien diese Nummer erhöhen,
// damit Handys die neue Version laden.
const CACHE_NAME = 'dokumente-v6';

// Die großen Dateien der Texterkennung liegen in einem eigenen Speicher.
// Er bleibt bei App-Updates erhalten, damit sie nicht jedes Mal neu
// geladen werden müssen. Nur ändern, wenn Tesseract aktualisiert wird.
const OCR_CACHE = 'dokumente-ocr-7.0.0';
const OCR_FILES = [
  'tesseract.min.js',
  'worker.min.js',
  'tesseract-core-lstm.wasm.js',
  'tesseract-core-simd-lstm.wasm.js',
  'tesseract-core-relaxedsimd-lstm.wasm.js',
  'deu.traineddata.gz'
];

// Alle Dateien, die offline verfügbar sein sollen (relative Pfade,
// damit es auch unter https://<name>.github.io/<repo>/ funktioniert).
const APP_FILES = [
  './',
  './index.html',
  './styles.css',
  './app.js',
  './crypto.js',
  './db.js',
  './dom.js',
  './docs.js',
  './folders.js',
  './images.js',
  './scan.js',
  './archive.js',
  './backup.js',
  './ocr.js',
  './suggest.js',
  './makepdf.js',
  './manifest.json',
  './icon.svg',
  './icon-192.png',
  './icon-512.png',
  './apple-touch-icon.png'
];

// Installation: Dateien in den Offline-Speicher legen
self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME)
      .then((cache) => cache.addAll(APP_FILES))
      .then(() => self.skipWaiting())
  );
});

// Aktivierung: alte Versionen aufräumen (Texterkennung behalten)
self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(
        keys.filter((key) => key !== CACHE_NAME && key !== OCR_CACHE).map((key) => caches.delete(key))
      ))
      .then(() => self.clients.claim())
  );
});

const isOcrFile = (url) => OCR_FILES.some((name) => url.pathname.endsWith('/' + name));

// Anfragen: zuerst aus dem Offline-Speicher, sonst aus dem Netz
self.addEventListener('fetch', (event) => {
  const request = event.request;
  if (request.method !== 'GET') return;
  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;

  // Texterkennung: beim ersten Gebrauch laden und dann behalten
  if (isOcrFile(url)) {
    event.respondWith(
      caches.open(OCR_CACHE).then(async (cache) => {
        const cached = await cache.match(request, { ignoreSearch: true });
        if (cached) return cached;
        const response = await fetch(request);
        if (response.ok) cache.put(request, response.clone());
        return response;
      })
    );
    return;
  }

  event.respondWith(
    caches.match(request, { ignoreSearch: true }).then((cached) => {
      if (cached) return cached;
      return fetch(request).catch(() => {
        // Offline und Seite nicht im Speicher: Startseite zeigen
        if (request.mode === 'navigate') return caches.match('./index.html');
        return Response.error();
      });
    })
  );
});
