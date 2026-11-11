// Manuelles Zuschneiden: vier Ecken mit dem Finger an die Blattränder ziehen.
// Beim Ziehen zeigt eine Lupe den Bereich unter dem Finger vergrößert.

import { el } from './dom.js';
import { fullQuad, quadIsValid } from './crop.js';

const SVG = 'http://www.w3.org/2000/svg';
const svgEl = (tag, attrs = {}) => {
  const node = document.createElementNS(SVG, tag);
  for (const [k, v] of Object.entries(attrs)) node.setAttribute(k, v);
  return node;
};

/**
 * Öffnet den Zuschneide-Bildschirm.
 * page: { url, width, height, quad, autoQuad }  (url = Originalfoto)
 * Ergebnis: neue Ecken oder null (abgebrochen)
 */
export function openCropper(page) {
  return new Promise((resolve) => {
    const W = page.width;
    const H = page.height;
    let quad = (page.quad || fullQuad(W, H)).map((p) => [...p]);
    let scale = 1;
    let offsetX = 0;
    let offsetY = 0;

    const img = el('img', { src: page.url, alt: 'Foto zum Zuschneiden', class: 'crop-img', draggable: 'false' });
    const svg = svgEl('svg', { class: 'crop-svg', viewBox: `0 0 ${W} ${H}`, preserveAspectRatio: 'none' });
    const shade = svgEl('path', { class: 'crop-shade', 'fill-rule': 'evenodd' });
    const outline = svgEl('polygon', { class: 'crop-outline' });
    svg.append(shade, outline);

    const loupe = el('canvas', { class: 'crop-loupe', width: '240', height: '240' });
    loupe.hidden = true;
    const handles = quad.map((_, i) => el('div', { class: 'crop-handle', 'aria-label': `Ecke ${i + 1}`, role: 'slider' }, el('span')));
    const stage = el('div', { class: 'crop-stage' }, img, svg, ...handles, loupe);
    const message = el('p', { class: 'crop-message', text: 'Ziehe die vier Ecken an die Ränder des Blattes.' });

    const finish = (result) => {
      overlay.remove();
      window.removeEventListener('resize', layout);
      resolve(result);
    };

    const overlay = el('div', { class: 'cropper', role: 'dialog', 'aria-label': 'Zuschneiden' },
      message,
      stage,
      el('div', { class: 'crop-tools' },
        el('button', { type: 'button', class: 'crop-btn', text: 'Ganzes Bild', onclick: () => { quad = fullQuad(W, H); draw(); } }),
        el('button', { type: 'button', class: 'crop-btn', text: 'Automatisch', disabled: !page.autoQuad, onclick: () => { quad = page.autoQuad.map((p) => [...p]); draw(); } })
      ),
      el('div', { class: 'crop-actions' },
        el('button', { type: 'button', class: 'crop-btn', text: 'Abbrechen', onclick: () => finish(null) }),
        el('button', { type: 'button', class: 'crop-btn primary', text: 'Fertig', onclick: () => {
          if (!quadIsValid(quad)) {
            message.textContent = 'Die Ecken überkreuzen sich – bitte so legen, dass ein Viereck entsteht.';
            message.classList.add('is-error');
            return;
          }
          finish(quad.map(([x, y]) => [Math.round(x), Math.round(y)]));
        } })
      )
    );

    function layout() {
      const rect = stage.getBoundingClientRect();
      const pad = 24;
      scale = Math.min((rect.width - pad * 2) / W, (rect.height - pad * 2) / H);
      const w = W * scale;
      const h = H * scale;
      offsetX = (rect.width - w) / 2;
      offsetY = (rect.height - h) / 2;
      for (const node of [img, svg]) {
        Object.assign(node.style, { left: `${offsetX}px`, top: `${offsetY}px`, width: `${w}px`, height: `${h}px` });
      }
      draw();
    }

    function draw() {
      const pts = quad.map(([x, y]) => `${x},${y}`).join(' ');
      outline.setAttribute('points', pts);
      shade.setAttribute('d', `M0 0H${W}V${H}H0Z M${quad.map(([x, y]) => `${x} ${y}`).join(' L')}Z`);
      handles.forEach((handle, i) => {
        Object.assign(handle.style, { left: `${offsetX + quad[i][0] * scale}px`, top: `${offsetY + quad[i][1] * scale}px` });
      });
      const width = Math.max(4, Math.round(3 / scale));
      outline.setAttribute('stroke-width', String(width));
    }

    function drawLoupe(i) {
      const ctx = loupe.getContext('2d');
      const zoom = 2.5;
      const size = 240;
      const srcSize = size / (scale * zoom);
      const [x, y] = quad[i];
      ctx.fillStyle = '#000';
      ctx.fillRect(0, 0, size, size);
      ctx.drawImage(img, x - srcSize / 2, y - srcSize / 2, srcSize, srcSize, 0, 0, size, size);
      ctx.strokeStyle = '#34c759';
      ctx.lineWidth = 3;
      ctx.beginPath();
      ctx.moveTo(size / 2, size / 2 - 22); ctx.lineTo(size / 2, size / 2 + 22);
      ctx.moveTo(size / 2 - 22, size / 2); ctx.lineTo(size / 2 + 22, size / 2);
      ctx.stroke();
      // Lupe auf die andere Seite, damit sie nicht unter dem Finger liegt
      const left = x < W / 2;
      Object.assign(loupe.style, { left: left ? 'auto' : '12px', right: left ? '12px' : 'auto' });
    }

    handles.forEach((handle, i) => {
      let grab = null;
      handle.addEventListener('pointerdown', (event) => {
        event.preventDefault();
        handle.setPointerCapture(event.pointerId);
        const rect = stage.getBoundingClientRect();
        grab = {
          dx: event.clientX - (rect.left + offsetX + quad[i][0] * scale),
          dy: event.clientY - (rect.top + offsetY + quad[i][1] * scale)
        };
        handle.classList.add('is-active');
        loupe.hidden = false;
        drawLoupe(i);
      });
      handle.addEventListener('pointermove', (event) => {
        if (!grab) return;
        const rect = stage.getBoundingClientRect();
        const x = (event.clientX - grab.dx - rect.left - offsetX) / scale;
        const y = (event.clientY - grab.dy - rect.top - offsetY) / scale;
        quad[i] = [Math.min(W, Math.max(0, x)), Math.min(H, Math.max(0, y))];
        message.classList.remove('is-error');
        draw();
        drawLoupe(i);
      });
      const release = () => {
        grab = null;
        handle.classList.remove('is-active');
        loupe.hidden = true;
      };
      handle.addEventListener('pointerup', release);
      handle.addEventListener('pointercancel', release);
      handle.addEventListener('lostpointercapture', release);
      window.addEventListener('pointerup', () => { if (grab) release(); });
    });

    document.body.append(overlay);
    window.addEventListener('resize', layout);
    if (img.complete) layout(); else img.addEventListener('load', layout, { once: true });
  });
}
