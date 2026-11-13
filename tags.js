// Tags (Schlagwörter) quer zu den Ordnern, z. B. „Strom“, „Wohnung“.
// Gespeichert verschlüsselt in den Angaben des Dokuments: meta.tags = ['Strom', …]
// Ältere Dokumente haben kein Feld – das zählt als „keine Tags“.
//
// Garantie: meta.warrantyUntil = 'JJJJ-MM-TT' (optional)

import { el } from './dom.js';
import { icon } from './icons.js';

export const MAX_TAGS = 12;
export const MAX_TAG_LENGTH = 30;

/** Tag säubern: Leerzeichen glätten, „#“ vorne weg, kürzen. */
export function cleanTag(text) {
  return Array.from(String(text || '').replace(/^#+/, '').replace(/\s+/g, ' ').trim())
    .slice(0, MAX_TAG_LENGTH).join('').trim();
}

const sameTag = (a, b) => a.localeCompare(b, 'de', { sensitivity: 'base' }) === 0;

/** Tags eines Dokuments (immer eine Liste). */
export const tagsOf = (meta) => (Array.isArray(meta && meta.tags) ? meta.tags.filter(Boolean) : []);

/** Alle vorhandenen Tags mit Anzahl, häufigste zuerst. */
export function allTags(docs) {
  const counts = new Map();
  for (const doc of docs) {
    for (const tag of tagsOf(doc.meta)) {
      const known = [...counts.keys()].find((k) => sameTag(k, tag)) || tag;
      counts.set(known, (counts.get(known) || 0) + 1);
    }
  }
  return [...counts.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0], 'de'))
    .map(([tag, count]) => ({ tag, count }));
}

export const hasTag = (meta, tag) => tagsOf(meta).some((t) => sameTag(t, tag));

let editorCount = 0;

/**
 * Eingabe für Tags: Chips mit ×, dazu „+ Tag“.
 * suggestions: vorhandene Tags (für die Vorschlagsliste)
 * Ergebnis: { node, read(), set(tags), onChange(fn) }
 */
export function tagEditor(initial = [], suggestions = []) {
  let tags = [];
  const listeners = [];
  const listId = `tag-suggestions-${++editorCount}`;
  const datalist = el('datalist', { id: listId });
  const box = el('div', { class: 'tag-editor', role: 'group', 'aria-label': 'Tags' });
  const input = el('input', {
    type: 'text', class: 'tag-input', list: listId, maxlength: String(MAX_TAG_LENGTH),
    placeholder: 'Tag eingeben', 'aria-label': 'Neuer Tag', enterkeyhint: 'done', autocomplete: 'off'
  });
  const addBtn = el('button', { type: 'button', class: 'tag-add' }, '+ Tag');
  let editing = false;

  const fillSuggestions = () => {
    datalist.replaceChildren(...suggestions
      .filter((s) => !tags.some((t) => sameTag(t, s)))
      .slice(0, 30)
      .map((s) => el('option', { value: s })));
  };

  const render = () => {
    const chips = tags.map((tag, i) => el('span', { class: 'tag-chip' },
      el('span', { text: tag }),
      el('button', { type: 'button', class: 'tag-remove', 'aria-label': `Tag ${tag} entfernen`, onclick: () => {
        tags.splice(i, 1);
        changed();
      } }, icon('x'))
    ));
    const full = tags.length >= MAX_TAGS;
    box.replaceChildren(...[...chips, editing && !full ? input : null, !editing && !full ? addBtn : null, datalist].filter(Boolean));
    fillSuggestions();
  };
  const changed = () => { render(); listeners.forEach((fn) => fn(tags.slice())); };

  const commit = () => {
    const parts = input.value.split(/[,;]/).map(cleanTag).filter(Boolean);
    input.value = '';
    let added = false;
    for (const tag of parts) {
      if (tags.length >= MAX_TAGS) break;
      if (!tags.some((t) => sameTag(t, tag))) {
        // Schreibweise eines vorhandenen Tags übernehmen („strom“ → „Strom“)
        tags.push(suggestions.find((s) => sameTag(s, tag)) || tag);
        added = true;
      }
    }
    return added;
  };

  addBtn.addEventListener('click', () => {
    editing = true;
    render();
    input.focus();
  });
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' || e.key === ',') {
      e.preventDefault();
      if (commit()) changed();
      input.focus();
    } else if (e.key === 'Escape') {
      input.value = '';
      editing = false;
      render();
    }
  });
  // Auswahl aus der Vorschlagsliste übernimmt sofort
  input.addEventListener('input', () => {
    if (suggestions.some((s) => s === input.value)) { commit(); changed(); input.focus(); }
  });
  input.addEventListener('blur', () => {
    setTimeout(() => {
      if (document.activeElement === input) return;
      const added = commit();
      editing = false;
      if (added) changed(); else render();
    }, 120);
  });

  const set = (list) => {
    tags = [];
    for (const t of list || []) {
      const tag = cleanTag(t);
      if (tag && !tags.some((x) => sameTag(x, tag)) && tags.length < MAX_TAGS) tags.push(tag);
    }
    editing = false;
    input.value = '';
    render();
  };
  set(initial);

  return {
    node: box,
    read: () => { commit(); return tags.slice(); },
    set,
    setSuggestions: (list) => { suggestions = list; fillSuggestions(); },
    onChange: (fn) => listeners.push(fn)
  };
}

// ---------------------------------------------------------------------
// Garantie
// ---------------------------------------------------------------------
function daysTo(iso) {
  const [y, m, d] = iso.split('-').map(Number);
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  return Math.round((new Date(y, m - 1, d) - today) / 86400000);
}

/** Text und Farbe für „Garantie bis …“ */
export function warrantyStatus(iso) {
  if (!iso) return null;
  const days = daysTo(iso);
  if (days < 0) return { text: 'abgelaufen', cls: 'is-danger', days };
  if (days === 0) return { text: 'endet heute', cls: 'is-danger', days };
  if (days <= 60) return { text: `noch ${days} ${days === 1 ? 'Tag' : 'Tage'}`, cls: 'is-warn', days };
  const months = Math.round(days / 30.4);
  return { text: months >= 24 ? `noch ${Math.round(months / 12)} Jahre` : `noch ${months} Monate`, cls: 'is-ok', days };
}
