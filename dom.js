// Kleine Hilfen zum Erzeugen von Bildschirm-Elementen (ohne innerHTML,
// damit nie fremder Text als Code ausgeführt werden kann).

export function el(tag, props = {}, ...children) {
  const node = document.createElement(tag);
  for (const [name, value] of Object.entries(props)) {
    if (value === undefined || value === null || value === false) continue;
    if (name === 'class') node.className = value;
    else if (name === 'text') node.textContent = value;
    // Stile nur über JavaScript setzen – die Sicherheitsregel blockiert style="…"
    else if (name === 'style') {
      for (const [prop, v] of Object.entries(value)) {
        if (prop.startsWith('--')) node.style.setProperty(prop, v);
        else node.style[prop] = v;
      }
    }
    else if (name.startsWith('on')) node.addEventListener(name.slice(2), value);
    else if (name in node && typeof value !== 'string') node[name] = value;
    else node.setAttribute(name, value === true ? '' : value);
  }
  for (const child of children.flat()) {
    if (child === null || child === undefined || child === false) continue;
    node.append(child instanceof Node ? child : String(child));
  }
  return node;
}

/** Kurze Bestätigung unten am Bildschirm, z. B. „Gespeichert“. */
let toastTimer = null;
/**
 * action: { label: 'Rückgängig', onClick } – dann bleibt die Meldung 5 Sekunden
 * stehen und hat einen Knopf.
 */
export function toast(text, kind = 'ok', action = null) {
  let node = document.getElementById('toast');
  if (!node) {
    node = el('div', { id: 'toast', class: 'toast', role: 'status', 'aria-live': 'polite' });
    document.body.append(node);
  }
  node.replaceChildren(el('span', { text }));
  node.className = `toast is-${kind}${action ? ' has-action' : ''}`;
  if (action) {
    node.append(el('button', { type: 'button', class: 'toast-action', text: action.label, onclick: () => {
      node.classList.remove('is-visible');
      clearTimeout(toastTimer);
      action.onClick();
    } }));
  }
  // erst im nächsten Bild einblenden, damit die Animation läuft (mit Ersatz, falls kein Bild-Takt)
  const showIt = () => node.classList.add('is-visible');
  requestAnimationFrame(showIt);
  setTimeout(showIt, 50);
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => node.classList.remove('is-visible'), action ? 5000 : 2600);
}

/** Heutiges Datum als JJJJ-MM-TT (Ortszeit). */
export function todayISO() {
  const d = new Date();
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

/** JJJJ-MM-TT → TT.MM.JJJJ */
export function formatDate(iso) {
  if (!iso || !/^\d{4}-\d{2}-\d{2}$/.test(iso)) return iso || '';
  const [y, m, d] = iso.split('-');
  return `${d}.${m}.${y}`;
}

export function formatBytes(bytes) {
  if (!Number.isFinite(bytes)) return '–';
  if (bytes < 1024 * 1024) return `${Math.max(1, Math.round(bytes / 1024))} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1).replace('.', ',')} MB`;
  return `${(bytes / 1024 / 1024 / 1024).toFixed(2).replace('.', ',')} GB`;
}
