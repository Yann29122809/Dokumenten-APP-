// Einheitliche Linien-Symbole (24 × 24), selbst gezeichnet – keine fremden Dateien.

const PATHS = {
  camera: 'M4 8.5A2.5 2.5 0 0 1 6.5 6h1.6l1.3-2h5.2l1.3 2h1.6A2.5 2.5 0 0 1 20 8.5v8A2.5 2.5 0 0 1 17.5 19h-11A2.5 2.5 0 0 1 4 16.5z M12 15.8a3.3 3.3 0 1 0 0-6.6 3.3 3.3 0 0 0 0 6.6z',
  photos: 'M4.5 5h15A1.5 1.5 0 0 1 21 6.5v11a1.5 1.5 0 0 1-1.5 1.5h-15A1.5 1.5 0 0 1 3 17.5v-11A1.5 1.5 0 0 1 4.5 5z M3.5 16l5-5 4 4 2.5-2.5L20.5 17 M15.5 9.5a1 1 0 1 0 0-2 1 1 0 0 0 0 2z',
  scan: 'M4 8V6a2 2 0 0 1 2-2h2 M16 4h2a2 2 0 0 1 2 2v2 M20 16v2a2 2 0 0 1-2 2h-2 M8 20H6a2 2 0 0 1-2-2v-2 M4 12h16',
  crop: 'M6 2v14a2 2 0 0 0 2 2h14 M2 6h14a2 2 0 0 1 2 2v14',
  rotate: 'M20 11a8 8 0 1 0-2.3 5.7 M20 4v7h-7',
  trash: 'M4 7h16 M9.5 7V4.5h5V7 M6 7l1 12.5A1.5 1.5 0 0 0 8.5 21h7a1.5 1.5 0 0 0 1.5-1.5L18 7 M10 11v6 M14 11v6',
  left: 'M15 5l-7 7 7 7',
  right: 'M9 5l7 7-7 7',
  back: 'M15 6l-6 6 6 6',
  folder: 'M3 7.5A2.5 2.5 0 0 1 5.5 5h3.6l2 2.2h7.4A2.5 2.5 0 0 1 21 9.7v7.8a2.5 2.5 0 0 1-2.5 2.5h-13A2.5 2.5 0 0 1 3 17.5z',
  folderPlus: 'M3 7.5A2.5 2.5 0 0 1 5.5 5h3.6l2 2.2h7.4A2.5 2.5 0 0 1 21 9.7v7.8a2.5 2.5 0 0 1-2.5 2.5h-13A2.5 2.5 0 0 1 3 17.5z M12 10.5v6 M9 13.5h6',
  stack: 'M12 3l9 4.5-9 4.5-9-4.5z M3 12l9 4.5 9-4.5 M3 16.5l9 4.5 9-4.5',
  file: 'M6.5 3h7.5l4.5 4.5v12A1.5 1.5 0 0 1 17 21H6.5A1.5 1.5 0 0 1 5 19.5v-15A1.5 1.5 0 0 1 6.5 3z M14 3v4.5h4.5 M8.5 12.5h7 M8.5 16h5',
  share: 'M12 15V3.5 M7.5 7.5L12 3l4.5 4.5 M6 11H5.5A1.5 1.5 0 0 0 4 12.5v7A1.5 1.5 0 0 0 5.5 21h13a1.5 1.5 0 0 0 1.5-1.5v-7a1.5 1.5 0 0 0-1.5-1.5H18',
  edit: 'M14.5 5.5l4 4 M4 20l1-4.5L15.8 4.7a1.8 1.8 0 0 1 2.5 0l1 1a1.8 1.8 0 0 1 0 2.5L8.5 19z',
  clock: 'M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18z M12 7v5l3.5 2',
  calendar: 'M5.5 5h13A1.5 1.5 0 0 1 20 6.5v12a1.5 1.5 0 0 1-1.5 1.5h-13A1.5 1.5 0 0 1 4 18.5v-12A1.5 1.5 0 0 1 5.5 5z M4 10h16 M8.5 3v4 M15.5 3v4',
  check: 'M5 12.5l4.5 4.5L19 7.5',
  checkCircle: 'M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18z M8 12.3l2.8 2.8L16.5 9.5',
  lock: 'M6.5 10.5h11A1.5 1.5 0 0 1 19 12v7.5a1.5 1.5 0 0 1-1.5 1.5h-11A1.5 1.5 0 0 1 5 19.5V12a1.5 1.5 0 0 1 1.5-1.5z M8 10.5V7.5a4 4 0 0 1 8 0v3',
  faceid: 'M4 8V6a2 2 0 0 1 2-2h2 M16 4h2a2 2 0 0 1 2 2v2 M20 16v2a2 2 0 0 1-2 2h-2 M8 20H6a2 2 0 0 1-2-2v-2 M9 9v1.5 M15 9v1.5 M12 9v4h-1 M9 15.5c1.8 1.4 4.2 1.4 6 0',
  search: 'M11 17.5a6.5 6.5 0 1 0 0-13 6.5 6.5 0 0 0 0 13z M20 20l-4.2-4.2',
  plus: 'M12 5v14 M5 12h14',
  x: 'M6 6l12 12 M18 6L6 18',
  device: 'M8 3h8a1.5 1.5 0 0 1 1.5 1.5v15A1.5 1.5 0 0 1 16 21H8a1.5 1.5 0 0 1-1.5-1.5v-15A1.5 1.5 0 0 1 8 3z M11 18h2',
  cloudOff: 'M3 3l18 18 M8.5 8.4A5 5 0 0 0 6.5 18h10 M10.5 6.2A5.5 5.5 0 0 1 17.6 10 4 4 0 0 1 20 16.5',
  text: 'M5 6h14 M5 10h14 M5 14h9 M5 18h6',
  home: 'M4 11l8-7 8 7v8a1 1 0 0 1-1 1h-4v-6H9v6H5a1 1 0 0 1-1-1z',
  bell: 'M6 16v-5a6 6 0 0 1 12 0v5l1.5 2h-15z M10 20a2 2 0 0 0 4 0',
  sliders: 'M4 7h9 M19 7h1 M4 17h3 M13 17h7 M16 5a2 2 0 1 0 0 4 2 2 0 0 0 0-4z M10 15a2 2 0 1 0 0 4 2 2 0 0 0 0-4z',
  down: 'M6 9l6 6 6-6',
  zap: 'M13 3L5 14h6l-1 7 8-11h-6z',
  euro: 'M17 7.5A6 6 0 1 0 17 16.5 M5 10.5h8 M5 13.5h8',
  calendar2: 'M6 5h12a2 2 0 0 1 2 2v11a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V7a2 2 0 0 1 2-2z M4 10h16 M9 3v4 M15 3v4',
  sparkle: 'M12 3l1.8 5.2L19 10l-5.2 1.8L12 17l-1.8-5.2L5 10l5.2-1.8z M18.5 15.5l.8 2.2 2.2.8-2.2.8-.8 2.2-.8-2.2-2.2-.8 2.2-.8z'
};

const SVG_NS = 'http://www.w3.org/2000/svg';

/** Symbol als SVG-Element. */
export function icon(name, className = 'icon') {
  const svg = document.createElementNS(SVG_NS, 'svg');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('class', className);
  svg.setAttribute('aria-hidden', 'true');
  const path = document.createElementNS(SVG_NS, 'path');
  path.setAttribute('d', PATHS[name] || PATHS.file);
  svg.append(path);
  return svg;
}

/** Elemente mit data-icon="…" im HTML mit Symbolen füllen. */
export function hydrateIcons(root = document) {
  root.querySelectorAll('[data-icon]').forEach((node) => {
    if (node.querySelector('svg')) return;
    node.prepend(icon(node.dataset.icon));
  });
}
