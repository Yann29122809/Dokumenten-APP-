// Bildverarbeitung: verkleinern, drehen, Scan-Filter, Vorschaubilder.

export const MAX_EDGE = 2000;    // längste Seite in Pixeln (gut lesbar, nicht zu groß)
const JPEG_QUALITY = 0.82;
const THUMB_EDGE = 320;

export function loadImage(blob) {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(blob);
    const img = new Image();
    img.onload = () => { URL.revokeObjectURL(url); resolve(img); };
    img.onerror = () => { URL.revokeObjectURL(url); reject(new Error('Bild konnte nicht gelesen werden')); };
    img.src = url;
  });
}

export function toJpeg(canvas, quality = JPEG_QUALITY) {
  return new Promise((resolve, reject) => {
    canvas.toBlob((blob) => {
      // Speicher auf dem iPhone sofort freigeben
      canvas.width = 0;
      canvas.height = 0;
      if (blob) resolve(blob); else reject(new Error('Bild konnte nicht erstellt werden'));
    }, 'image/jpeg', quality);
  });
}

function drawScaled(img, maxEdge) {
  const scale = Math.min(1, maxEdge / Math.max(img.naturalWidth, img.naturalHeight));
  const canvas = document.createElement('canvas');
  canvas.width = Math.round(img.naturalWidth * scale);
  canvas.height = Math.round(img.naturalHeight * scale);
  const ctx = canvas.getContext('2d');
  // Weißer Hintergrund: durchsichtige Bereiche (z. B. bei PNG) würden in JPEG sonst schwarz
  ctx.fillStyle = '#fff';
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
  return canvas;
}

/** Foto von Kamera oder Mediathek einlesen und verkleinern. */
export async function prepareImage(file) {
  const img = await loadImage(file);
  const canvas = drawScaled(img, MAX_EDGE);
  const width = canvas.width;
  const height = canvas.height;
  return { blob: await toJpeg(canvas), width, height };
}

// Schwarz-Weiß + Kontrast automatisch strecken (wirkt wie ein Scanner)
function applyScanFilter(ctx, width, height) {
  const image = ctx.getImageData(0, 0, width, height);
  const px = image.data;
  const histogram = new Uint32Array(256);
  for (let i = 0; i < px.length; i += 4) {
    const y = (px[i] * 299 + px[i + 1] * 587 + px[i + 2] * 114) / 1000;
    px[i] = y;
    histogram[y | 0]++;
  }
  const total = px.length / 4;
  let low = 0;
  let high = 255;
  for (let sum = 0; low < 255 && (sum += histogram[low]) < total * 0.02; low++);
  for (let sum = 0; high > 0 && (sum += histogram[high]) < total * 0.15; high--);
  if (high - low < 30) { low = 0; high = 255; }
  const range = high - low;
  for (let i = 0; i < px.length; i += 4) {
    const v = Math.max(0, Math.min(255, ((px[i] - low) * 255) / range));
    px[i] = px[i + 1] = px[i + 2] = v;
  }
  ctx.putImageData(image, 0, 0);
}

/** Endgültige Seite erzeugen: Drehung und optional Scan-Filter anwenden. */
export async function renderPage(blob, rotation = 0, scanFilter = false) {
  const turn = ((rotation % 360) + 360) % 360;
  if (turn === 0 && !scanFilter) return blob;
  const img = await loadImage(blob);
  const w = img.naturalWidth;
  const h = img.naturalHeight;
  const sideways = turn === 90 || turn === 270;
  const canvas = document.createElement('canvas');
  canvas.width = sideways ? h : w;
  canvas.height = sideways ? w : h;
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = '#fff';
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  ctx.translate(canvas.width / 2, canvas.height / 2);
  ctx.rotate((turn * Math.PI) / 180);
  ctx.drawImage(img, -w / 2, -h / 2);
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  if (scanFilter) applyScanFilter(ctx, canvas.width, canvas.height);
  return toJpeg(canvas);
}

/** Kleines Vorschaubild für die Ablage. */
export async function makeThumb(blob) {
  const img = await loadImage(blob);
  return toJpeg(drawScaled(img, THUMB_EDGE), 0.7);
}
