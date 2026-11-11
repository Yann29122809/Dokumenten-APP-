// Zuschneiden: Blatt im Foto finden und gerade „entzerren“.
//
// Automatik: Das Foto wird verkleinert, in Hell/Dunkel geteilt, und die
// größte helle Fläche (das Papier) gesucht. Ihre vier äußersten Punkte
// sind die Ecken. Klappt am besten mit Papier auf dunklem Untergrund.
//
// Entzerren: Die vier Ecken werden auf ein Rechteck abgebildet
// (Perspektiv-Korrektur), damit schräg fotografierte Blätter gerade werden.

import { loadImage, toJpeg, MAX_EDGE } from './images.js';

const DETECT_EDGE = 360;

/** Ecken des ganzen Bildes: oben links, oben rechts, unten rechts, unten links */
export const fullQuad = (w, h) => [[0, 0], [w, 0], [w, h], [0, h]];

function polygonArea(q) {
  let a = 0;
  for (let i = 0; i < 4; i++) {
    const [x1, y1] = q[i];
    const [x2, y2] = q[(i + 1) % 4];
    a += x1 * y2 - x2 * y1;
  }
  return Math.abs(a) / 2;
}

function isConvex(q) {
  let sign = 0;
  for (let i = 0; i < 4; i++) {
    const [ax, ay] = q[i];
    const [bx, by] = q[(i + 1) % 4];
    const [cx, cy] = q[(i + 2) % 4];
    const cross = (bx - ax) * (cy - by) - (by - ay) * (cx - bx);
    if (Math.abs(cross) < 1e-6) continue;
    if (sign === 0) sign = Math.sign(cross);
    else if (Math.sign(cross) !== sign) return false;
  }
  return true;
}

export const quadIsValid = (q) => isConvex(q) && polygonArea(q) > 100;

function otsu(histogram, total) {
  let sum = 0;
  for (let i = 0; i < 256; i++) sum += i * histogram[i];
  let sumB = 0;
  let weightB = 0;
  let best = 0;
  let threshold = 127;
  for (let t = 0; t < 256; t++) {
    weightB += histogram[t];
    if (!weightB) continue;
    const weightF = total - weightB;
    if (!weightF) break;
    sumB += t * histogram[t];
    const meanB = sumB / weightB;
    const meanF = (sum - sumB) / weightF;
    const between = weightB * weightF * (meanB - meanF) ** 2;
    if (between > best) { best = between; threshold = t; }
  }
  return threshold;
}

/**
 * Blatt im Bild suchen. Ergebnis: vier Ecken in Bild-Pixeln oder null,
 * wenn kein Blatt sicher erkannt wurde (dann bleibt das ganze Bild).
 */
export async function detectDocument(blob) {
  const img = await loadImage(blob);
  const W = img.naturalWidth;
  const H = img.naturalHeight;
  const scale = Math.min(1, DETECT_EDGE / Math.max(W, H));
  const w = Math.max(1, Math.round(W * scale));
  const h = Math.max(1, Math.round(H * scale));

  const canvas = document.createElement('canvas');
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  ctx.drawImage(img, 0, 0, w, h);
  const px = ctx.getImageData(0, 0, w, h).data;
  canvas.width = 0;

  // Graustufen + leichtes Weichzeichnen (gegen Schrift und Rauschen)
  let gray = new Float32Array(w * h);
  for (let i = 0; i < w * h; i++) gray[i] = px[i * 4] * 0.299 + px[i * 4 + 1] * 0.587 + px[i * 4 + 2] * 0.114;
  for (let pass = 0; pass < 2; pass++) {
    const out = new Float32Array(w * h);
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        let s = 0;
        let n = 0;
        for (let dy = -2; dy <= 2; dy++) {
          const yy = y + dy;
          if (yy < 0 || yy >= h) continue;
          for (let dx = -2; dx <= 2; dx++) {
            const xx = x + dx;
            if (xx < 0 || xx >= w) continue;
            s += gray[yy * w + xx];
            n++;
          }
        }
        out[y * w + x] = s / n;
      }
    }
    gray = out;
  }

  const histogram = new Uint32Array(256);
  for (let i = 0; i < gray.length; i++) histogram[Math.min(255, gray[i] | 0)]++;
  const threshold = otsu(histogram, gray.length);
  const mask = new Uint8Array(w * h);
  let bright = 0;
  for (let i = 0; i < gray.length; i++) if (gray[i] > threshold) { mask[i] = 1; bright++; }
  const total = w * h;
  if (bright < total * 0.08 || bright > total * 0.95) return null;

  // Größte zusammenhängende helle Fläche finden
  const label = new Int32Array(total);
  const queue = new Int32Array(total);
  let bestLabel = 0;
  let bestSize = 0;
  let next = 0;
  for (let start = 0; start < total; start++) {
    if (!mask[start] || label[start]) continue;
    next++;
    let head = 0;
    let tail = 0;
    queue[tail++] = start;
    label[start] = next;
    while (head < tail) {
      const p = queue[head++];
      const x = p % w;
      const y = (p - x) / w;
      if (x > 0 && mask[p - 1] && !label[p - 1]) { label[p - 1] = next; queue[tail++] = p - 1; }
      if (x < w - 1 && mask[p + 1] && !label[p + 1]) { label[p + 1] = next; queue[tail++] = p + 1; }
      if (y > 0 && mask[p - w] && !label[p - w]) { label[p - w] = next; queue[tail++] = p - w; }
      if (y < h - 1 && mask[p + w] && !label[p + w]) { label[p + w] = next; queue[tail++] = p + w; }
    }
    if (tail > bestSize) { bestSize = tail; bestLabel = next; }
  }
  if (bestSize < total * 0.15) return null;

  // Äußerste Punkte der Fläche = Ecken
  let tl = null; let tr = null; let br = null; let bl = null;
  let minSum = Infinity; let maxSum = -Infinity; let minDiff = Infinity; let maxDiff = -Infinity;
  for (let p = 0; p < total; p++) {
    if (label[p] !== bestLabel) continue;
    const x = p % w;
    const y = (p - x) / w;
    const s = x + y;
    const d = x - y;
    if (s < minSum) { minSum = s; tl = [x, y]; }
    if (s > maxSum) { maxSum = s; br = [x, y]; }
    if (d > maxDiff) { maxDiff = d; tr = [x, y]; }
    if (d < minDiff) { minDiff = d; bl = [x, y]; }
  }
  const quad = [tl, tr, br, bl].map(([x, y]) => [
    Math.min(W, Math.max(0, (x + 0.5) / scale)),
    Math.min(H, Math.max(0, (y + 0.5) / scale))
  ]);
  if (!isConvex(quad)) return null;
  const area = polygonArea(quad);
  if (area < W * H * 0.2) return null;
  if (area > W * H * 0.97) return null; // füllt schon das ganze Bild
  return quad;
}

// ---------------------------------------------------------------------
// Perspektiv-Korrektur
// ---------------------------------------------------------------------
function solve(A, b) {
  const n = b.length;
  for (let col = 0; col < n; col++) {
    let pivot = col;
    for (let r = col + 1; r < n; r++) if (Math.abs(A[r][col]) > Math.abs(A[pivot][col])) pivot = r;
    [A[col], A[pivot]] = [A[pivot], A[col]];
    [b[col], b[pivot]] = [b[pivot], b[col]];
    if (Math.abs(A[col][col]) < 1e-12) throw new Error('Ecken liegen auf einer Linie');
    for (let r = col + 1; r < n; r++) {
      const f = A[r][col] / A[col][col];
      for (let c = col; c < n; c++) A[r][c] -= f * A[col][c];
      b[r] -= f * b[col];
    }
  }
  const x = new Array(n).fill(0);
  for (let r = n - 1; r >= 0; r--) {
    let s = b[r];
    for (let c = r + 1; c < n; c++) s -= A[r][c] * x[c];
    x[r] = s / A[r][r];
  }
  return x;
}

// Abbildung Zielrechteck → Foto (für jedes Ziel-Pixel: woher im Foto?)
function homography(from, to) {
  const A = [];
  const b = [];
  for (let i = 0; i < 4; i++) {
    const [x, y] = from[i];
    const [u, v] = to[i];
    A.push([x, y, 1, 0, 0, 0, -u * x, -u * y]); b.push(u);
    A.push([0, 0, 0, x, y, 1, -v * x, -v * y]); b.push(v);
  }
  return solve(A, b);
}

const dist = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1]);

/** Bild auf die vier Ecken zuschneiden und gerade ziehen. */
export async function warpImage(blob, quad) {
  const img = await loadImage(blob);
  const W = img.naturalWidth;
  const H = img.naturalHeight;
  const [tl, tr, br, bl] = quad;

  let outW = Math.max(dist(tl, tr), dist(bl, br));
  let outH = Math.max(dist(tl, bl), dist(tr, br));
  const scale = Math.min(1, MAX_EDGE / Math.max(outW, outH));
  outW = Math.max(1, Math.round(outW * scale));
  outH = Math.max(1, Math.round(outH * scale));

  const src = document.createElement('canvas');
  src.width = W;
  src.height = H;
  const sctx = src.getContext('2d', { willReadFrequently: true });
  sctx.drawImage(img, 0, 0);
  const s = sctx.getImageData(0, 0, W, H).data;
  src.width = 0;

  const out = document.createElement('canvas');
  out.width = outW;
  out.height = outH;
  const octx = out.getContext('2d');
  const target = octx.createImageData(outW, outH);
  const d = target.data;

  const m = homography([[0, 0], [outW, 0], [outW, outH], [0, outH]], quad);
  for (let y = 0; y < outH; y++) {
    const yc = y + 0.5;
    for (let x = 0; x < outW; x++) {
      const xc = x + 0.5;
      const den = m[6] * xc + m[7] * yc + 1;
      let sx = (m[0] * xc + m[1] * yc + m[2]) / den - 0.5;
      let sy = (m[3] * xc + m[4] * yc + m[5]) / den - 0.5;
      sx = Math.min(W - 1.001, Math.max(0, sx));
      sy = Math.min(H - 1.001, Math.max(0, sy));
      const x0 = sx | 0;
      const y0 = sy | 0;
      const fx = sx - x0;
      const fy = sy - y0;
      const i00 = (y0 * W + x0) * 4;
      const i10 = i00 + 4;
      const i01 = i00 + W * 4;
      const i11 = i01 + 4;
      const o = (y * outW + x) * 4;
      for (let c = 0; c < 3; c++) {
        const top = s[i00 + c] + (s[i10 + c] - s[i00 + c]) * fx;
        const bottom = s[i01 + c] + (s[i11 + c] - s[i01 + c]) * fx;
        d[o + c] = top + (bottom - top) * fy;
      }
      d[o + 3] = 255;
    }
  }
  octx.putImageData(target, 0, 0);
  return { blob: await toJpeg(out), width: outW, height: outH };
}
