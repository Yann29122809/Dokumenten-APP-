// Vorschläge aus dem erkannten Text: Ablageort, Datum, Titel, Notiz.
// Alles passiert auf dem Gerät mit einfachen Regeln – und lernt aus deinen
// bisherigen Dokumenten (gleicher Absender → gleicher Ablageort).

import { allFolders, folderById, folderSingular } from './folders.js';
import { formatDate } from './dom.js';

const MONTHS = {
  januar: 1, jan: 1, februar: 2, feb: 2, märz: 3, maerz: 3, mär: 3, april: 4, apr: 4, mai: 5,
  juni: 6, jun: 6, juli: 7, jul: 7, august: 8, aug: 8, september: 9, sep: 9, sept: 9,
  oktober: 10, okt: 10, november: 11, nov: 11, dezember: 12, dez: 12,
  // Französisch
  janvier: 1, février: 2, fevrier: 2, mars: 3, avril: 4, juin: 6, juillet: 7, août: 8, aout: 8,
  septembre: 9, octobre: 10, novembre: 11, décembre: 12, decembre: 12,
  // Englisch
  january: 1, february: 2, march: 3, may: 5, june: 6, july: 7, october: 10, december: 12, dec: 12, oct: 10
};
const MONTH_RE = 'januar|februar|märz|maerz|april|mai|juni|juli|august|september|oktober|november|dezember|janvier|février|fevrier|mars|avril|juin|juillet|août|aout|septembre|octobre|novembre|décembre|decembre|january|february|march|may|june|july|october|december|jan|feb|mär|apr|jun|jul|aug|sept?|okt|oct|nov|dez|dec';

// Schlüsselwörter → Start-Ordner (mit Gewicht)
const RULES = {
  invoice: [['rechnungsnummer', 4], ['rechnungsbetrag', 4], ['rechnungsdatum', 4], ['rechnung', 3], ['zahlbar bis', 2],
    ['umsatzsteuer', 2], ['mwst', 2], ['ust-id', 2], ['nettobetrag', 1], ['gesamtbetrag', 1], ['kundennummer', 1], ['quittung', 2]],
  bank: [['kontoauszug', 5], ['kontostand', 4], ['saldo', 3], ['depot', 3], ['sparkasse', 3], ['volksbank', 3], ['raiffeisen', 2],
    ['kreditkarte', 2], ['girokonto', 3], ['dispo', 2], ['überweisung', 1], ['kontoinhaber', 2], ['zinsen', 1]],
  insurance: [['versicherungsschein', 5], ['versicherungsnummer', 4], ['versicherungsbeginn', 4], ['police', 3],
    ['versicherung', 3], ['schadennummer', 4], ['haftpflicht', 3], ['hausrat', 3], ['beitragsrechnung', 3], ['versicherungsnehmer', 4]],
  payslip: [['entgeltabrechnung', 6], ['gehaltsabrechnung', 6], ['lohnabrechnung', 6], ['auszahlungsbetrag', 4],
    ['lohnsteuer', 3], ['sozialversicherung', 2], ['personalnummer', 3], ['brutto', 2], ['netto', 1], ['steuerklasse', 3]],
  letter: [['sehr geehrte', 1], ['mit freundlichen grüßen', 1]]
};

// Themen für eigene Ordner: steht eines dieser Wörter im Text UND der
// Ordnername passt zum Thema, wird der Ordner vorgeschlagen.
const TOPICS = [
  { folder: /kranken|arzt|ärzt|gesundheit|medizin|klinik|patient|befund/, text: ['krankenhaus', 'klinik', 'klinikum', 'arzt', 'ärztin', 'praxis', 'diagnose', 'befund', 'patient', 'entlass', 'therapie', 'rezept', 'behandlung', 'arbeitsunfähigkeit'] },
  { folder: /steuer|finanzamt/, text: ['finanzamt', 'steuerbescheid', 'einkommensteuer', 'steuernummer', 'steuer-id'] },
  { folder: /auto|kfz|fahrzeug|wagen/, text: ['kfz', 'fahrzeug', 'kennzeichen', 'tüv', 'zulassung', 'werkstatt'] },
  { folder: /wohnung|miete|haus|vermiet/, text: ['miete', 'mietvertrag', 'nebenkosten', 'vermieter', 'wohnung', 'hausverwaltung'] },
  { folder: /schule|kita|kinder|kind/, text: ['schule', 'kita', 'kindergarten', 'zeugnis', 'elternbrief'] },
  { folder: /arbeit|job|beruf/, text: ['arbeitsvertrag', 'arbeitgeber', 'kündigung', 'zeugnis'] },
  { folder: /vertrag|verträge|abo/, text: ['vertrag', 'vertragsnummer', 'laufzeit', 'kündigungsfrist'] }
];

const COMPANY_HINT = /(?:^|[^\p{L}])(gmbh|ag|kg|ohg|gbr|e\.\s?v\.|mbh|bank|sparkasse|versicherung|versicherungen|stadtwerke|klinik|klinikum|krankenhaus|praxis|dr\.|amt|finanzamt|krankenkasse|aok|barmer|dak|telekom|vodafone)(?=[^\p{L}]|$)/iu;

const normalize = (text) => text.toLowerCase().replace(/\s+/g, ' ');

// ---------------------------------------------------------------------
// Datum
// ---------------------------------------------------------------------
function validDate(y, m, d, maxFutureDays = 60) {
  if (y < 100) y += y > 50 ? 1900 : 2000;
  const date = new Date(y, m - 1, d);
  if (date.getFullYear() !== y || date.getMonth() !== m - 1 || date.getDate() !== d) return null;
  if (y < 1990 || date.getTime() > Date.now() + maxFutureDays * 86400000) return null;
  const pad = (n) => String(n).padStart(2, '0');
  return `${y}-${pad(m)}-${pad(d)}`;
}

function findDates(text, maxFutureDays = 60) {
  const found = [];
  // TT.MM.JJJJ, TT.MM.JJ und TT/MM/JJJJ (französisch)
  const numeric = /(\d{1,2})\s?[./]\s?(\d{1,2})\s?[./]\s?(\d{4}|\d{2})(?!\d)/g;
  // 25. November 2026 · 25 novembre 2026 · 25 November 2026
  const written = new RegExp(`(\\d{1,2})(?:\\.|er)?\\s+(${MONTH_RE})\\.?\\s+(\\d{4})`, 'giu');
  // November 25, 2026 (englisch)
  const writtenEn = new RegExp(`(${MONTH_RE})\\.?\\s+(\\d{1,2}),?\\s+(\\d{4})`, 'giu');
  const iso = /(\d{4})-(\d{2})-(\d{2})/g;
  let m;
  while ((m = numeric.exec(text))) {
    const date = validDate(+m[3], +m[2], +m[1], maxFutureDays);
    if (date) found.push({ date, index: m.index });
  }
  while ((m = written.exec(text))) {
    const date = validDate(+m[3], MONTHS[m[2].toLowerCase()], +m[1], maxFutureDays);
    if (date) found.push({ date, index: m.index });
  }
  while ((m = writtenEn.exec(text))) {
    const month = MONTHS[m[1].toLowerCase()];
    const date = month ? validDate(+m[3], month, +m[2], maxFutureDays) : null;
    if (date && !found.some((f) => Math.abs(f.index - m.index) < 4)) found.push({ date, index: m.index });
  }
  while ((m = iso.exec(text))) {
    const date = validDate(+m[1], +m[2], +m[3], maxFutureDays);
    if (date) found.push({ date, index: m.index });
  }
  return found.sort((a, b) => a.index - b.index);
}

function pickDate(text) {
  const dates = findDates(text);
  if (!dates.length) return null;
  // Bevorzugt Daten direkt hinter „Datum“, „Rechnungsdatum“, „vom“ …
  const lower = text.toLowerCase();
  for (const d of dates) {
    const before = lower.slice(Math.max(0, d.index - 25), d.index);
    if (/(datum|vom|ausgestellt|erstellt|den|date|le|du|dated)\s*:?\s*$/.test(before)) return d.date;
  }
  // Sonst: Daten bei Geburtstag/Zeitraum meiden – das erste übrige nehmen
  for (const d of dates) {
    const before = lower.slice(Math.max(0, d.index - 25), d.index);
    if (!/(geb|geboren|né|born|bis|jusqu|until|zeitraum|fällig|zahlbar|avant|due|échéance)/.test(before)) return d.date;
  }
  return dates[0].date;
}

// Erinnerung: Datum hinter Schlüsselwörtern (Deutsch, Französisch, Englisch)
// samt Art der Frist. Gewicht: je weiter oben die Regel, desto eindeutiger.
const REMINDER_RULES = [
  { kind: 'Kündigung', re: /(kündigungsfrist|kündigung bis|kündbar bis|kuendigungsfrist|date limite de résiliation|résiliation avant|cancel(?:lation)? by|notice period)/ },
  { kind: 'Widerspruch', re: /(widerspruch bis|widerspruchsfrist|einspruch bis|einspruchsfrist|einspruch ist bis|widerspruch ist bis|recours avant|objection by)/ },
  { kind: 'Ablauf', re: /(gültig bis|gueltig bis|ablauf|läuft ab|laeuft ab|ablaufdatum|valable jusqu'?au|date d'expiration|expire le|expires?|expiry date|valid until|valid through)/ },
  { kind: 'Zahlung', re: /(zahlbar bis|zahlen bis|zahlen sie bis|bezahlen bis|begleichen bis|zahlbar am|zahlungsziel|fällig am|faellig am|fällig bis|fälligkeit|faelligkeit|zahlung bis|zu zahlen bis|bitte überweisen sie bis|überweisen sie bis|abbuchung am|wird abgebucht am|mahnung|zahlungserinnerung|à payer avant le|a payer avant le|à régler avant le|date d'échéance|échéance|avant le|payment due|due date|due by|pay by|payable by|amount due by)/ },
  { kind: 'Frist', re: /(frist|spätestens|spaetestens|einzureichen bis|bis zum|deadline|date limite)/ }
];

function addDays(iso, days) {
  const [y, m, d] = iso.split('-').map(Number);
  const date = new Date(y, m - 1, d + days);
  const pad = (n) => String(n).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

/** Erinnerung finden: { date, kind } oder null. */
export function findReminder(text, docDate) {
  const lower = text.toLowerCase();
  const candidates = [];
  for (const d of findDates(text, 3 * 365)) {
    if (docDate && d.date < docDate) continue;
    // nur im selben Satz bzw. in derselben Zeile zurückschauen
    const before = lower.slice(Math.max(0, d.index - 60), d.index).split(/\.\s|\n|;/).pop();
    const rule = REMINDER_RULES.findIndex((r) => r.re.test(before));
    if (rule !== -1) candidates.push({ date: d.date, kind: REMINDER_RULES[rule].kind, rank: rule });
  }
  if (candidates.length) {
    // Die früheste Frist ist die dringendste; bei gleichem Datum gewinnt die eindeutigere Art
    candidates.sort((a, b) => a.date.localeCompare(b.date) || a.rank - b.rank);
    return { date: candidates[0].date, kind: candidates[0].kind, others: candidates.slice(1).map(({ date, kind }) => ({ date, kind })) };
  }
  // „innerhalb von 14 Tagen“ · „within 14 days“ · „sous 14 jours“ → ab Dokumentdatum
  const within = lower.match(/(?:innerhalb (?:von |der nächsten )?|within |sous |dans un délai de )(\d{1,3}) (?:tag|day|jour)/);
  if (within && docDate) {
    const kind = /(zahl|überweis|payment|pay|payer|régler)/.test(lower) ? 'Zahlung' : 'Frist';
    return { date: addDays(docDate, Number(within[1])), kind };
  }
  return null;
}

// ---------------------------------------------------------------------
// Absender, Betrag, Nummern
// ---------------------------------------------------------------------
function findSender(text) {
  const lines = text.split('\n').map((l) => l.trim()).filter((l) => l.length >= 3).slice(0, 12);
  for (const line of lines) {
    if (COMPANY_HINT.test(line)) {
      let part = line.split(/\s[·•|\-–—]\s|,\s|\s{3,}/)[0].trim();
      // Nach der Rechtsform abschneiden („… GmbH Hauptstraße 1“ → „… GmbH“)
      const legal = part.match(/^(.*?(?:^|\s)(?:gmbh(?:\s?&\s?co\.?\s?kg)?|ag|kg|ohg|gbr|e\.\s?v\.|mbh))(?=[^\p{L}]|$)/iu);
      if (legal) part = legal[1];
      const clean = part.replace(/[^\p{L}\p{N}&.\-' ]/gu, '').replace(/\s+/g, ' ').trim();
      if (clean.length >= 3) return clean.slice(0, 50);
    }
  }
  return null;
}

function findAmount(text) {
  const lines = text.split('\n');
  const amounts = [];
  const money = /(\d{1,3}(?:[.\s]\d{3})*,\d{2})\s?(?:€|eur)?/gi;
  for (const line of lines) {
    if (!/(gesamt|summe|betrag|zu zahlen|endbetrag|total|auszahlung)/i.test(line)) continue;
    let m;
    while ((m = money.exec(line))) {
      const value = parseFloat(m[1].replace(/[.\s]/g, '').replace(',', '.'));
      if (value > 0) amounts.push({ value, raw: m[1].replace(/\s/g, '.') });
    }
  }
  if (!amounts.length) return null;
  return amounts.sort((a, b) => b.value - a.value)[0].raw + ' €';
}

const DOC_TYPES = [
  'Entlassbrief', 'Entlassungsbericht', 'Arztbrief', 'Befund', 'Rezept', 'Arbeitsunfähigkeitsbescheinigung', 'Heil- und Kostenplan',
  'Mahnung', 'Zahlungserinnerung', 'Rechnung', 'Gutschrift', 'Quittung', 'Angebot', 'Auftragsbestätigung', 'Lieferschein',
  'Kontoauszug', 'Depotauszug', 'Kreditkartenabrechnung', 'Versicherungsschein', 'Beitragsrechnung', 'Nachtrag',
  'Entgeltabrechnung', 'Gehaltsabrechnung', 'Lohnabrechnung', 'Lohnsteuerbescheinigung',
  'Steuerbescheid', 'Bescheid', 'Kündigungsbestätigung', 'Kündigung', 'Vertrag', 'Mietvertrag', 'Nebenkostenabrechnung',
  'Jahresabrechnung', 'Abschlagsplan', 'Preisänderung', 'Vertragsbestätigung',
  'Zeugnis', 'Bescheinigung', 'Einladung'
];

// Die Dokumentart, die im Text am weitesten oben steht
function findDocType(text) {
  const lower = text.toLowerCase();
  let best = null;
  for (const type of DOC_TYPES) {
    const re = new RegExp(`(?:^|[^\\p{L}])${type.toLowerCase()}(?=[^\\p{L}]|$)`, 'u');
    const m = re.exec(lower);
    if (m && (!best || m.index < best.index)) best = { type, index: m.index };
  }
  return best ? best.type : null;
}

function findNumber(text, label, pattern) {
  const m = text.match(pattern);
  return m ? `${label}: ${m[1]}` : null;
}

// ---------------------------------------------------------------------
// Ablageort
// ---------------------------------------------------------------------
function pickFolder(text, sender, previousDocs) {
  const lower = normalize(text);

  // 1. Gelernt: gleicher Absender wie bei einem früheren Dokument
  if (sender) {
    const s = sender.toLowerCase();
    const match = previousDocs.find((d) => d.meta.sender && d.meta.sender.toLowerCase() === s && folderById(d.meta.category));
    if (match) return { id: match.meta.category, reason: 'gleicher Absender wie früher' };
  }

  // 2. Eigene Ordner, deren Thema oder Name im Text vorkommt
  let best = null;
  for (const folder of allFolders()) {
    const name = folder.name.toLowerCase();
    let score = 0;
    // Wörter aus dem Ordnernamen im Text (z. B. „Krankenhausaufenthalt XYZ“ → „xyz“)
    for (const word of name.split(/[^\p{L}\p{N}]+/u).filter((w) => w.length >= 4)) {
      if (lower.includes(word)) score += 3;
    }
    for (const topic of TOPICS) {
      if (topic.folder.test(name)) score += topic.text.filter((w) => lower.includes(w)).length * 2;
    }
    // Unterordner leicht bevorzugen, wenn sie genauso gut passen
    if (score > 0 && folder.parentId) score += 0.5;
    if (score > 0 && (!best || score > best.score)) best = { id: folder.id, score };
  }

  // 3. Start-Ordner über Schlüsselwörter
  for (const [id, words] of Object.entries(RULES)) {
    if (!folderById(id)) continue;
    const score = words.reduce((sum, [word, weight]) => sum + (lower.includes(word) ? weight : 0), 0);
    if (score > 0 && (!best || score > best.score)) best = { id, score };
  }

  return best && best.score >= 2 ? { id: best.id, reason: 'Schlüsselwörter im Text' } : null;
}

// ---------------------------------------------------------------------
// Alles zusammen
// ---------------------------------------------------------------------
export function suggestFromText(text, previousDocs = []) {
  if (!text || text.replace(/\s/g, '').length < 15) return null;

  const sender = findSender(text);
  const date = pickDate(text);
  const folder = pickFolder(text, sender, previousDocs);
  const folderId = folder ? folder.id : null;

  // Art des Dokuments aus dem Text („Entlassbrief“), sonst Wort des Ordners
  const docType = findDocType(text);
  const folder0 = folderId ? folderById(folderId) : null;
  const typeWord = docType || (folder0 && folder0.singular) || (sender ? null : (folder0 ? folderSingular(folderId) : 'Dokument'));
  let title = null;
  if (sender && typeWord && !sender.toLowerCase().includes(typeWord.toLowerCase())) title = `${typeWord} ${sender}`;
  else if (sender) title = sender;
  else if (typeWord && date) title = `${typeWord} ${formatDate(date)}`;
  else if (typeWord) title = typeWord;

  const noteParts = [
    findAmount(text) ? `Betrag: ${findAmount(text)}` : null,
    findNumber(text, 'Rechnungsnr.', /rechnungs-?\s?(?:nummer|nr\.?)\s*:?\s*([A-Z0-9][A-Z0-9\-/]{2,})/i),
    findNumber(text, 'Kundennr.', /kunden-?\s?(?:nummer|nr\.?)\s*:?\s*([A-Z0-9][A-Z0-9\-/]{2,})/i),
    findNumber(text, 'Vertragsnr.', /(?:vertrags|versicherungs)-?\s?(?:nummer|nr\.?)\s*:?\s*([A-Z0-9][A-Z0-9\-/]{2,})/i)
  ].filter(Boolean);

  return {
    folderId,
    folderReason: folder ? folder.reason : null,
    date,
    title,
    note: noteParts.join('\n') || null,
    ...(() => {
      const r = findReminder(text, date);
      return { dueDate: r ? r.date : null, dueKind: r ? r.kind : null, amount: findAmount(text) };
    })(),
    sender
  };
}

// ---------------------------------------------------------------------
// Schlüsselfelder für die Duplikat-Erkennung
// ---------------------------------------------------------------------
// Unterscheiden sich Datum, Betrag, Belegnummer oder Abrechnungszeitraum,
// sind zwei ähnliche Dokumente (z. B. Gehaltsabrechnungen) KEINE Duplikate.
export function extractKeys(text) {
  if (!text || text.replace(/\s/g, '').length < 15) return {};
  const amount = findAmount(text);
  const ref = text.match(/(?:rechnungs|beleg|auszugs?|abrechnungs|bescheid|vorgangs|bestell|auftrags)-?\s?(?:nummer|nr\.?)\s*:?\s*([A-Z0-9][A-Z0-9\-/.]{1,})/i);
  const period = text.match(/(januar|februar|märz|maerz|april|mai|juni|juli|august|september|oktober|november|dezember)\s+(\d{4})/i);
  return {
    date: pickDate(text) || null,
    amount: amount ? amount.replace(/[^\d,]/g, '') : null,
    ref: ref ? ref[1].toUpperCase().replace(/[^A-Z0-9]/g, '') : null,
    period: period ? `${period[1].toLowerCase().replace('ä', 'ae')}${period[2]}` : null
  };
}
