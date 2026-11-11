// Bildschirm „Heute“: Begrüßung, nächste Frist als große Karte, „Bald fällig“,
// zuletzt hinzugefügt. Es werden nur echte Daten gezeigt – ohne Fristen
// erscheint ein leerer Zustand statt Beispieldaten.

import { el, formatDate, toast } from './dom.js';
import { icon } from './icons.js';
import { openDeadlines, reminderOf, reminderChanges, daysUntil } from './deadlines.js';
import { updateMeta, loadThumb } from './docs.js';
import { folderById, existingFolderId } from './folders.js';

const $ = (id) => document.getElementById(id);
const MONTHS = ['JAN', 'FEB', 'MÄR', 'APR', 'MAI', 'JUN', 'JUL', 'AUG', 'SEP', 'OKT', 'NOV', 'DEZ'];

let ctx = null;
let urls = [];

export function initToday(context) {
  ctx = context;
}

function release() {
  urls.forEach((u) => URL.revokeObjectURL(u));
  urls = [];
}

export function clearToday() {
  release();
  ['today-hero', 'today-recent'].forEach((id) => $(id).replaceChildren());
  $('soon-section').hidden = true;
  $('soon-section').replaceChildren();
}

function greeting(date = new Date()) {
  const h = date.getHours();
  if (h < 5) return 'Gute Nacht';
  if (h < 11) return 'Guten Morgen';
  if (h < 18) return 'Guten Tag';
  return 'Guten Abend';
}

/** Farbe nach Dringlichkeit: bis 3 Tage rot, bis 14 Tage gelb */
function urgency(iso) {
  const d = daysUntil(iso);
  if (d <= 3) return 'is-danger';
  if (d <= 14) return 'is-warn';
  return '';
}

function daysText(iso) {
  const d = daysUntil(iso);
  if (d < -1) return `${-d} Tage drüber`;
  if (d === -1) return 'gestern';
  if (d === 0) return 'heute';
  if (d === 1) return 'morgen';
  return `${d} Tage`;
}

function inDaysText(iso) {
  const d = daysUntil(iso);
  if (d < 0) return 'überfällig';
  if (d === 0) return 'heute';
  if (d === 1) return 'morgen';
  return `in ${d} Tagen`;
}

const shortDate = (iso) => formatDate(iso).slice(0, 6);
const sourceOf = (doc) => doc.meta.sender || (folderById(existingFolderId(doc.meta.category)) || {}).name || '';

export function renderToday() {
  if (!ctx || !ctx.getKey()) return;
  release();
  const now = new Date();
  $('today-date').textContent = now.toLocaleDateString('de-DE', { weekday: 'long', day: 'numeric', month: 'long' });
  $('today-greeting').textContent = greeting(now);

  const docs = ctx.getDocs();
  const open = openDeadlines(docs);
  renderHero(open[0] || null);
  renderSoonList(open);
  renderRecent(docs);
}

// ---------------------------------------------------------------------
// Große Karte: als Nächstes fällig
// ---------------------------------------------------------------------
function renderHero(doc) {
  const box = $('today-hero');
  if (!doc) {
    box.replaceChildren(el('div', { class: 'hero is-empty' },
      el('span', { class: 'hero-chip', text: 'Keine offenen Fristen' }),
      el('div', {},
        el('div', { class: 'hero-big', text: 'Alles erledigt' }),
        el('div', { class: 'hero-sub', text: 'Scanne ein Dokument – Folio erkennt Fristen und schlägt Erinnerungen vor.' })
      ),
      el('button', { type: 'button', class: 'hero-btn', onclick: () => ctx.startScan() }, icon('scan'), 'Dokument scannen')
    ));
    return;
  }
  const r = reminderOf(doc.meta);
  const paid = r.kind === 'Zahlung';
  box.replaceChildren(el('div', { class: 'hero' },
    el('div', { class: 'hero-top' },
      el('span', { class: 'hero-chip', text: 'Als Nächstes fällig' }),
      el('span', { class: 'f-grow' }),
      el('span', { text: inDaysText(r.date) })
    ),
    el('div', {},
      el('div', { class: 'hero-big', text: r.amount || r.kind }),
      el('div', { class: 'hero-sub', text: `${doc.meta.title} · bis ${shortDate(r.date)}` })
    ),
    el('div', { class: 'hero-actions' },
      el('button', { type: 'button', class: 'hero-btn', onclick: () => markDone(doc) }, paid ? 'Als bezahlt markieren' : 'Als erledigt markieren'),
      el('button', { type: 'button', class: 'hero-icon', 'aria-label': 'Dokument öffnen', onclick: () => ctx.openDoc(doc.id) }, icon('right'))
    )
  ));
}

async function markDone(doc) {
  const r = reminderOf(doc.meta);
  doc.meta = await updateMeta(ctx.getKey(), doc, reminderChanges({ ...r, done: true }));
  toast(r.kind === 'Zahlung' ? 'Als bezahlt markiert' : 'Erledigt', 'ok', {
    label: 'Rückgängig',
    onClick: async () => {
      doc.meta = await updateMeta(ctx.getKey(), doc, reminderChanges({ ...r, done: false }));
      renderToday();
    }
  });
  renderToday();
}

// ---------------------------------------------------------------------
// Bald fällig
// ---------------------------------------------------------------------
function renderSoonList(open) {
  const box = $('soon-section');
  box.hidden = !open.length;
  if (!open.length) { box.replaceChildren(); return; }
  box.replaceChildren(
    el('div', { class: 'f-section-head' },
      el('h2', { class: 'f-section f-grow', text: 'Bald fällig' }),
      el('button', { type: 'button', class: 'f-link', onclick: () => ctx.openCollection('soon') }, 'Alle ansehen')
    ),
    el('div', { class: 'f-card is-list' }, open.slice(0, 4).map((doc) => {
      const r = reminderOf(doc.meta);
      const [, m, d] = r.date.split('-');
      const u = urgency(r.date);
      return el('button', { type: 'button', class: 'f-row', onclick: () => ctx.openDoc(doc.id) },
        el('span', { class: `f-date-tile ${u}` }, el('b', { text: String(Number(d)) }), el('span', { text: MONTHS[Number(m) - 1] })),
        el('span', { class: 'f-grow' },
          el('div', { class: 'f-row-title', text: doc.meta.title }),
          el('div', { class: 'f-row-sub', text: [sourceOf(doc), r.amount || r.kind].filter(Boolean).join(' · ') })
        ),
        el('span', { class: `f-chip ${u || ''}`, text: daysText(r.date) })
      );
    }))
  );
}

// ---------------------------------------------------------------------
// Zuletzt hinzugefügt
// ---------------------------------------------------------------------
function renderRecent(docs) {
  const box = $('today-recent');
  const recent = [...docs].sort((a, b) => (b.meta.created || 0) - (a.meta.created || 0)).slice(0, 8);
  if (!recent.length) { box.replaceChildren(); return; }
  box.replaceChildren(
    el('h2', { class: 'f-section', text: 'Zuletzt hinzugefügt' }),
    el('div', { class: 'recent-row' }, recent.map((doc) => {
      const img = el('img', { alt: '' });
      loadThumb(ctx.getKey(), doc).then((blob) => {
        const url = URL.createObjectURL(blob);
        urls.push(url);
        img.src = url;
      }).catch(() => {});
      return el('button', { type: 'button', class: 'recent-card', onclick: () => ctx.openDoc(doc.id), 'aria-label': doc.meta.title },
        el('span', { class: 'recent-thumb' }, img),
        el('span', { class: 'recent-label', text: sourceOf(doc) || doc.meta.title })
      );
    }))
  );
}
