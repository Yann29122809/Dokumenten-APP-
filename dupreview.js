// Prüf-Bildschirm für mögliche Duplikate.
//  - Zwei Karten (im Hochformat übereinander) mit Vorschau, Titel, Ordner,
//    Datum, Seitenzahl und Größe. Abweichungen sind farbig markiert.
//  - Nach links wischen = „Kein Duplikat, beide behalten“
//  - Nach rechts wischen = „Duplikat“
//  - Dazu Knöpfe und „Überspringen“.

import { el, formatDate, formatBytes } from './dom.js';
import { icon } from './icons.js';

const SWIPE = 90;

/**
 * a, b: { label, title, folder, date, pages, size, pixels, thumbUrl }
 * mode 'new':    a = neues Dokument, b = vorhandenes
 * mode 'stored': beide gespeichert; Nutzer wählt, welches bleibt
 * Ergebnis: { action: 'keep' | 'duplicate' | 'skip', keep: 'a' | 'b' }
 */
export function openDuplicateReview({ mode, a, b, level, differences = [], progress = '' }) {
  return new Promise((resolve) => {
    // Vorauswahl: mehr Seiten, sonst höhere Auflösung/Dateigröße
    let keep = 'a';
    if (mode === 'stored') {
      const score = (x) => (x.pages || 0) * 1e9 + (x.pixels || 0) * 10 + (x.size || 0) / 1e6;
      keep = score(b) > score(a) ? 'b' : 'a';
    }
    const diff = (field) => (differences.includes(field) ? 'is-diff' : '');

    const card = (x, id) => el('div', { class: `dup-card ${mode === 'stored' && keep === id ? 'is-keep' : ''}`, 'data-id': id },
      el('span', { class: 'dup-label', text: x.label }),
      el('span', { class: 'dup-thumb' }, x.thumbUrl ? el('img', { src: x.thumbUrl, alt: '' }) : icon('file')),
      el('span', { class: 'dup-info' },
        el('strong', { class: `dup-title ${diff('title')}`, text: x.title }),
        el('span', { class: diff('category'), text: x.folder }),
        el('span', { class: diff('date'), text: formatDate(x.date) }),
        el('span', { class: diff('pageCount'), text: x.pages === 1 ? '1 Seite' : `${x.pages} Seiten` }),
        x.size ? el('span', { text: formatBytes(x.size) }) : null,
        mode === 'stored' ? el('label', { class: 'dup-keep' },
          el('input', { type: 'radio', name: 'dup-keep', value: id, checked: keep === id, onchange: () => { keep = id; update(); } }),
          'Dieses behalten') : null
      )
    );

    const cardA = card(a, 'a');
    const cardB = card(b, 'b');
    const stack = el('div', { class: 'dup-stack' }, cardA, el('span', { class: 'dup-vs', text: '≈' }), cardB);
    const hintLeft = el('span', { class: 'dup-hint left', text: '← Kein Duplikat' });
    const hintRight = el('span', { class: 'dup-hint right', text: 'Duplikat →' });

    const levelText = { datei: 'Identische Datei', bild: 'Gleiches Seitenbild', inhalt: 'Gleicher Inhalt' }[level] || 'Ähnlich';
    const finish = (action) => {
      overlay.classList.add(action === 'keep' ? 'fly-left' : action === 'duplicate' ? 'fly-right' : 'fly-down');
      setTimeout(() => { overlay.remove(); resolve({ action, keep }); }, 180);
    };

    const dupLabel = mode === 'new' ? 'Duplikat – neues nicht speichern' : 'Duplikat – nur ausgewähltes behalten';
    const overlay = el('div', { class: 'dup-overlay', role: 'dialog', 'aria-label': 'Mögliches Duplikat prüfen' },
      el('div', { class: 'dup-head' },
        el('strong', { text: 'Mögliches Duplikat' }),
        el('span', { class: 'hint', text: [levelText, progress].filter(Boolean).join(' · ') })
      ),
      el('div', { class: 'dup-swipe' }, hintLeft, hintRight, stack),
      el('p', { class: 'hint center dup-help', text: 'Wischen: nach links = beide behalten · nach rechts = Duplikat' }),
      el('div', { class: 'dup-actions' },
        el('button', { type: 'button', class: 'btn-secondary with-icon', onclick: () => finish('keep') }, icon('check'), 'Kein Duplikat – beide behalten'),
        el('button', { type: 'button', class: 'btn-secondary danger with-icon', onclick: () => finish('duplicate') }, icon('trash'), dupLabel),
        el('button', { type: 'button', class: 'btn-text', text: 'Überspringen', onclick: () => finish('skip') })
      )
    );

    function update() {
      cardA.classList.toggle('is-keep', mode === 'stored' && keep === 'a');
      cardB.classList.toggle('is-keep', mode === 'stored' && keep === 'b');
    }

    // Wischen
    let startX = null;
    let dx = 0;
    stack.addEventListener('pointerdown', (e) => {
      if (e.target.closest('input, label')) return;
      startX = e.clientX;
      dx = 0;
      stack.setPointerCapture(e.pointerId);
      stack.classList.add('is-dragging');
    });
    stack.addEventListener('pointermove', (e) => {
      if (startX === null) return;
      dx = e.clientX - startX;
      stack.style.transform = `translateX(${dx}px) rotate(${dx / 30}deg)`;
      hintLeft.classList.toggle('is-active', dx < -SWIPE / 2);
      hintRight.classList.toggle('is-active', dx > SWIPE / 2);
    });
    const release = () => {
      if (startX === null) return;
      startX = null;
      stack.classList.remove('is-dragging');
      hintLeft.classList.remove('is-active');
      hintRight.classList.remove('is-active');
      if (dx < -SWIPE) finish('keep');
      else if (dx > SWIPE) finish('duplicate');
      else stack.style.transform = '';
    };
    stack.addEventListener('pointerup', release);
    stack.addEventListener('pointercancel', release);

    document.body.append(overlay);
  });
}
