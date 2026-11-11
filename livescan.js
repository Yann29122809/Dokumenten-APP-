// Live-Scan (Bild 02): eigene Kamera im Vollbild.
//  - Rahmen zeigt in Echtzeit, wo die vorhandene Kantenerkennung das Blatt sieht
//  - „Dokument erkannt“, sobald das Blatt mehrmals hintereinander gefunden wird
//  - Modi: Dokument (eine Seite), Mehrseitig (mehrere Seiten, dann „Fertig“), Karte
//  - Seitenstapel mit Anzahl, Auslöser, „Fertig“
//  - Blitz nur, wenn das Gerät ihn für Web-Apps freigibt
// Automatisches Auslösen gibt es noch nicht (siehe ROADMAP.md).
// Ohne Kamera-Erlaubnis wird die bisherige iPhone-Kamera (Dateiauswahl) benutzt.

import { el } from './dom.js';
import { icon } from './icons.js';
import { detectInSource } from './crop.js';

let state = null;

export const liveScanSupported = () => Boolean(navigator.mediaDevices && navigator.mediaDevices.getUserMedia);

/**
 * opts: { onCapture(file) → Promise, onDone(count), onFallback() }
 */
export async function openLiveScan(opts) {
  if (state) return;
  if (!liveScanSupported()) { opts.onFallback(); return; }

  let stream;
  try {
    stream = await navigator.mediaDevices.getUserMedia({
      video: { facingMode: { ideal: 'environment' }, width: { ideal: 1920 }, height: { ideal: 1440 } },
      audio: false
    });
  } catch (err) {
    console.warn('Kamera nicht verfügbar:', err);
    opts.onFallback();
    return;
  }

  const video = el('video', { class: 'ls-video', playsinline: true, muted: true, autoplay: true });
  video.setAttribute('playsinline', '');
  video.muted = true;
  video.srcObject = stream;

  const SVG = 'http://www.w3.org/2000/svg';
  const svg = document.createElementNS(SVG, 'svg');
  svg.setAttribute('class', 'ls-frame');
  const path = document.createElementNS(SVG, 'path');
  svg.append(path);

  const status = el('span', { class: 'ls-status', role: 'status' }, el('span', { class: 'ls-status-text', text: 'Blatt ins Bild halten' }));
  const track = stream.getVideoTracks()[0];
  const caps = track && track.getCapabilities ? track.getCapabilities() : {};
  let torchOn = false;
  const flash = el('button', { type: 'button', class: 'f-icon-btn is-dark ls-flash', 'aria-label': 'Blitz ein- oder ausschalten', 'aria-pressed': 'false', hidden: !caps.torch }, icon('zap'));
  flash.addEventListener('click', async () => {
    torchOn = !torchOn;
    try { await track.applyConstraints({ advanced: [{ torch: torchOn }] }); } catch { torchOn = false; }
    flash.classList.toggle('is-on', torchOn);
    flash.setAttribute('aria-pressed', String(torchOn));
  });

  let mode = 'document';
  const modes = el('div', { class: 'ls-modes', role: 'radiogroup', 'aria-label': 'Art des Scans' },
    ...[['document', 'Dokument'], ['multi', 'Mehrseitig'], ['card', 'Karte']].map(([id, label]) =>
      el('button', { type: 'button', role: 'radio', 'aria-checked': String(id === mode), class: id === mode ? 'is-active' : '', 'data-mode': id, text: label, onclick: () => {
        mode = id;
        modes.querySelectorAll('button').forEach((b) => { const on = b.dataset.mode === mode; b.classList.toggle('is-active', on); b.setAttribute('aria-checked', String(on)); });
      } })
    ));

  let count = 0;
  const badge = el('span', { class: 'ls-badge', hidden: true });
  const stackImg = el('img', { alt: '' });
  const stack = el('span', { class: 'ls-stack', 'aria-label': 'Aufgenommene Seiten' }, stackImg, badge);
  const shutter = el('button', { type: 'button', class: 'ls-shutter', 'aria-label': 'Foto aufnehmen' }, el('span'));
  const done = el('button', { type: 'button', class: 'ls-done', text: 'Fertig' });

  const overlay = el('div', { class: 'livescan', role: 'dialog', 'aria-label': 'Dokument scannen' },
    el('div', { class: 'ls-stage' }, video, svg),
    el('div', { class: 'ls-top' },
      el('button', { type: 'button', class: 'f-icon-btn is-dark', 'aria-label': 'Schließen', onclick: () => close(true) }, icon('x')),
      status,
      flash.hidden ? el('span', { class: 'ls-spacer' }) : flash
    ),
    el('div', { class: 'ls-bottom' },
      modes,
      el('div', { class: 'ls-controls' }, stack, shutter, done)
    )
  );
  document.body.append(overlay);
  document.body.classList.add('ls-open');
  try { await video.play(); } catch { /* iOS startet über autoplay */ }

  // ---------- Live-Erkennung (alle 450 ms, verkleinert) ----------
  let found = 0;
  let lastQuad = null;
  const timer = setInterval(() => {
    if (!video.videoWidth) return;
    try {
      const quad = detectInSource(video, video.videoWidth, video.videoHeight);
      if (quad) { found = Math.min(found + 1, 5); lastQuad = quad; } else { found = Math.max(found - 1, 0); if (!found) lastQuad = null; }
      drawFrame(lastQuad);
      const ok = found >= 2;
      status.classList.toggle('is-ok', ok);
      status.querySelector('.ls-status-text').textContent = ok ? 'Dokument erkannt' : 'Blatt ins Bild halten';
      if (ok && !status.querySelector('svg')) status.prepend(icon('check'));
      if (!ok) status.querySelector('svg')?.remove();
    } catch (err) {
      console.warn(err);
    }
  }, 450);

  // Ecken des Blattes als Rahmen zeichnen (Videobild → Bildschirm, object-fit: cover)
  function drawFrame(quad) {
    const rect = video.getBoundingClientRect();
    svg.setAttribute('viewBox', `0 0 ${rect.width} ${rect.height}`);
    if (!quad) { path.setAttribute('d', ''); return; }
    const s = Math.max(rect.width / video.videoWidth, rect.height / video.videoHeight);
    const ox = (rect.width - video.videoWidth * s) / 2;
    const oy = (rect.height - video.videoHeight * s) / 2;
    const p = quad.map(([x, y]) => [ox + x * s, oy + y * s]);
    const arm = 0.18;
    let d = '';
    for (let i = 0; i < 4; i++) {
      const c = p[i];
      const prev = p[(i + 3) % 4];
      const next = p[(i + 1) % 4];
      const a = [c[0] + (prev[0] - c[0]) * arm, c[1] + (prev[1] - c[1]) * arm];
      const b = [c[0] + (next[0] - c[0]) * arm, c[1] + (next[1] - c[1]) * arm];
      d += `M${a[0]} ${a[1]} L${c[0]} ${c[1]} L${b[0]} ${b[1]} `;
    }
    path.setAttribute('d', d);
  }

  // ---------- Aufnehmen ----------
  shutter.addEventListener('click', async () => {
    if (!video.videoWidth || shutter.disabled) return;
    shutter.disabled = true;
    overlay.classList.add('is-flash');
    setTimeout(() => overlay.classList.remove('is-flash'), 180);
    const canvas = document.createElement('canvas');
    canvas.width = video.videoWidth;
    canvas.height = video.videoHeight;
    canvas.getContext('2d').drawImage(video, 0, 0);
    const blob = await new Promise((r) => canvas.toBlob(r, 'image/jpeg', 0.92));
    canvas.width = 0;
    const file = new File([blob], `scan-${Date.now()}.jpg`, { type: 'image/jpeg' });
    count++;
    if (stackImg.src) URL.revokeObjectURL(stackImg.src);
    stackImg.src = URL.createObjectURL(blob);
    badge.hidden = false;
    badge.textContent = String(count);
    // Dokument/Karte: eine Seite, dann weiter zu „Erkannt“
    if (mode !== 'multi') {
      close(false);
      await opts.onCapture(file);
      opts.onDone(count);
      return;
    }
    await opts.onCapture(file);
    shutter.disabled = false;
  });
  done.addEventListener('click', () => {
    const n = count;
    close(false);
    opts.onDone(n);
  });

  function close(cancelled) {
    clearInterval(timer);
    stream.getTracks().forEach((t) => t.stop());
    if (stackImg.src) URL.revokeObjectURL(stackImg.src);
    overlay.remove();
    document.body.classList.remove('ls-open');
    state = null;
    if (cancelled && opts.onCancel) opts.onCancel(count);
  }
  state = { close };
}

/** Beim Sperren oder Verlassen: Kamera sofort aus. */
export function closeLiveScan() {
  if (state) state.close(false);
}
