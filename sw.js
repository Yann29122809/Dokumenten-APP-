'use strict';

// Bei jeder Änderung an den Dateien diese Nummer erhöhen,
// damit Handys die neue Version laden.
const CACHE_NAME = 'dokumente-v2';

// Alle Dateien, die offline verfügbar sein sollen (relative Pfade,
// damit es auch unter https://<name>.github.io/<repo>/ funktioniert).
const APP_FILES = [
  './',
  './index.html',
  './styles.css',
  './app.js',
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

// Aktivierung: alte Versionen aufräumen
self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(
        keys.filter((key) => key !== CACHE_NAME).map((key) => caches.delete(key))
      ))
      .then(() => self.clients.claim())
  );
});

// Anfragen: zuerst aus dem Offline-Speicher, sonst aus dem Netz
self.addEventListener('fetch', (event) => {
  const request = event.request;
  if (request.method !== 'GET') return;
  if (new URL(request.url).origin !== self.location.origin) return;

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
