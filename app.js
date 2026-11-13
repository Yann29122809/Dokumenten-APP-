import { createVault, openVault, openVaultForWrapping, changeVaultPassword, WrongPasswordError } from './crypto.js';
import { faceIdAvailable, getFaceIdRecord, enableFaceId, unlockWithFaceId, disableFaceId } from './faceid.js';
import { getMeta, setMeta } from './db.js';
import { formatBytes, toast, el } from './dom.js';
import { hydrateIcons, icon } from './icons.js';
import { initScan, clearScan, addCapturedFile, hasDraft } from './scan.js';
import { openLiveScan, closeLiveScan } from './livescan.js';
import { initArchive, refreshArchive, clearArchive, showRoot, documentCount, getDocs, pageTextReady, getTrashed, renderTrash, openDoc, updateDupBanner, renderSearchScreen, clearSearchScreen, openDocFrom, openCollection } from './archive.js';
import { loadFolders, clearFolders } from './folders.js';
import { stopOcr, setOcrLanguages } from './ocr.js';
import { buildIndex, clearSearch, setPageText, hasText, getPageTextsFor } from './search.js';
import { initOcrQueue, enqueue, kick as kickOcr, pauseQueue, onQueueChange } from './ocrqueue.js';
import { needsMigration, runMigrations, markSchemaCurrent } from './migrations.js';
import { initImport, loadInbox, clearInbox, importFiles } from './importer.js';
import { initToday, renderToday, clearToday } from './today.js';
import { initDupCheck, checkBeforeSave, findAllPairs, scanAllDuplicates, reviewPending, revalidatePending } from './dupcheck.js';
import { loadDecisions, clearDecisions, loadPending, clearPending, onPendingChange, getPending } from './duplicates.js';
import { createBackup, saveBackupFile, readBackupFile, importBackup, BackupFormatError } from './backup.js';
import { exportFolderZip, ExportLockedError } from './zipexport.js';

const $ = (id) => document.getElementById(id);
const MIN_PASSWORD_LENGTH = 8;

// Der entsperrte Schlüssel lebt nur im Arbeitsspeicher, solange die App offen ist.
let vaultKey = null;
let vaultRecord = null;
let settings = { autoLockMinutes: 5, lastBackup: null, ocrAuto: true, autoCrop: true, calendar: 'neutral', ocrLangs: 'deu' };
let faceIdRecord = null;

const saveSettings = () => setMeta('settings', settings);

// =====================================================================
// Navigation zwischen den drei Bildschirmen
// =====================================================================
const tabs = document.querySelectorAll('.f-tab');
const screens = document.querySelectorAll('.screen');
let currentScreen = 'today';

function showScreen(name) {
  currentScreen = name;
  document.body.classList.remove('doc-open');
  screens.forEach((screen) => {
    const active = screen.id === 'screen-' + name;
    screen.hidden = !active;
    screen.classList.toggle('is-active', active);
  });
  tabs.forEach((tab) => {
    const active = tab.dataset.screen === name;
    tab.classList.toggle('is-active', active);
    if (active) tab.setAttribute('aria-current', 'page');
    else tab.removeAttribute('aria-current');
  });
  document.querySelector('.app-main').scrollTop = 0;
  if (name === 'archive') showRoot();
  if (name === 'today' && vaultKey) renderToday();
  $('draft-banner').hidden = !(name === 'today' && hasDraft());
  if (name === 'search' && vaultKey) renderSearchScreen();
  if (name === 'settings') updateInfo();
}

tabs.forEach((tab) => tab.addEventListener('click', () => showScreen(tab.dataset.screen)));

// Runder Scan-Button in der Mitte: eigene Live-Kamera (02).
// Ohne Kamera-Zugriff → bisherige iPhone-Kamera über die Dateiauswahl.
function startScan() {
  if (!vaultKey) return;
  openLiveScan({
    onCapture: (file) => { addCapturedFile(file); },
    onDone: (count) => { if (count) showScreen('scan'); },
    onFallback: () => $('scan-camera').click()
  });
}
document.querySelector('[data-action="live-scan"]').addEventListener('click', startScan);
$('scan-back').addEventListener('click', () => showScreen('today'));
$('draft-banner').addEventListener('click', () => showScreen('scan'));
$('lock-now-top').addEventListener('click', () => lock());

function openDocument(id) {
  showScreen('archive');
  openDoc(id);
}

// =====================================================================
// Hilfsfunktionen für Formulare
// =====================================================================
// Knopf-Inhalt (Text + Symbol) merken, solange „Wird geladen …“ angezeigt wird
const savedContent = new WeakMap();
function setBusy(button, busy, busyText) {
  if (busy) {
    if (!button.disabled) savedContent.set(button, [...button.childNodes]);
    button.textContent = busyText;
    button.disabled = true;
  } else {
    const saved = savedContent.get(button);
    if (saved) button.replaceChildren(...saved);
    button.disabled = false;
  }
}

function checkNewPassword(pw1, pw2) {
  if (pw1.length < MIN_PASSWORD_LENGTH) return `Das Passwort muss mindestens ${MIN_PASSWORD_LENGTH} Zeichen haben.`;
  if (pw1 !== pw2) return 'Die beiden Passwörter stimmen nicht überein.';
  return '';
}

function clearPasswordFields() {
  document.querySelectorAll('input[type="password"]').forEach((input) => { input.value = ''; });
}

// =====================================================================
// Sperren / Entsperren
// =====================================================================
function showLockView(view) {
  $('lock-loading').hidden = view !== 'loading';
  $('setup-form').hidden = view !== 'setup';
  $('unlock-form').hidden = view !== 'unlock';
}

async function unlocked(key) {
  vaultKey = key;
  clearPasswordFields();
  document.body.classList.remove('locked');
  resetInactivityTimer();
  try {
    await loadFolders(key);
    await refreshArchive();
    renderToday();
    await buildIndex(key, getDocs());
    if (await needsMigration()) {
      if (getDocs().length) showMigrationDialog();
      else await runMigrations(key);
    }
    kickOcr();
    await loadInbox();
    await loadDecisions(key);
    await loadPending(key, new Set(getDocs().map((d) => d.id)));
    // Fingerabdrücke älterer Dokumente nachholen und Bestand auf neue Paare prüfen
    setTimeout(() => revalidatePending().then(() => findAllPairs()).catch((err) => console.warn(err)), 3000);
  } catch (err) {
    console.error(err);
  }
}

// „Heute“ aktualisieren, wenn sich Dokumente ändern
document.addEventListener('dokumente:changed', () => { if (currentScreen === 'today') renderToday(); });
initToday({
  getKey: () => vaultKey,
  getDocs,
  openDoc: (id) => openDocument(id),
  openCollection: (id) => { showScreen('archive'); openCollection(id); },
  startScan
});

// ---------- Umstellung des Datenmodells (mit Backup-Angebot) ----------
let migrationBackup = null;

function showMigrationDialog() {
  migrationBackup = null;
  $('migration-info').textContent = '';
  $('migration-backup').disabled = false;
  $('migration-backup').lastChild.textContent = 'Erst Backup sichern';
  $('migration-run').textContent = 'Ohne Backup umstellen';
  $('migration-dialog').hidden = false;
}

async function finishMigration() {
  const button = $('migration-run');
  button.disabled = true;
  button.textContent = 'Wird umgestellt …';
  try {
    await runMigrations(vaultKey);
    await buildIndex(vaultKey, getDocs());
    $('migration-dialog').hidden = true;
    toast('Umstellung abgeschlossen');
  } catch (err) {
    console.error(err);
    $('migration-info').textContent = 'Umstellung fehlgeschlagen – deine Daten sind unverändert. Beim nächsten Entsperren wird es erneut versucht.';
  } finally {
    button.disabled = false;
  }
}

$('migration-backup').addEventListener('click', async () => {
  const button = $('migration-backup');
  // 1. Tipp: Backup erstellen · 2. Tipp: Datei sichern (iPhone erlaubt Teilen nur direkt nach einem Tipp)
  if (!migrationBackup) {
    button.disabled = true;
    button.lastChild.textContent = 'Backup wird erstellt …';
    try {
      migrationBackup = await createBackup(vaultKey);
      $('migration-info').textContent = `Backup ist bereit (${formatBytes(migrationBackup.blob.size)}). Jetzt sichern, z. B. in „Dateien“.`;
      button.lastChild.textContent = 'Backup-Datei sichern …';
    } catch (err) {
      console.error(err);
      $('migration-info').textContent = 'Backup konnte nicht erstellt werden.';
      button.lastChild.textContent = 'Erst Backup sichern';
    } finally {
      button.disabled = false;
    }
    return;
  }
  suspendAutoLock();
  try {
    const result = await saveBackupFile(migrationBackup);
    if (result !== 'cancelled') {
      settings.lastBackup = Date.now();
      await saveSettings();
      $('migration-info').textContent = 'Backup gesichert. Jetzt kannst du umstellen.';
      $('migration-run').textContent = 'Jetzt umstellen';
      button.disabled = true;
    }
  } catch (err) {
    console.error(err);
  } finally {
    resumeAutoLock();
  }
});

$('migration-run').addEventListener('click', async () => {
  const backedUp = $('migration-backup').disabled && migrationBackup !== null;
  if (!backedUp && !confirm('Ohne Backup umstellen?\n\nDie Umstellung ändert keine bestehenden Daten – ein Backup ist aber immer die sicherste Wahl.')) return;
  await finishMigration();
});

function lock() {
  if (!vaultRecord) return;
  vaultKey = null;
  closeLiveScan();
  // Alles Entschlüsselte aus dem Speicher und vom Bildschirm entfernen
  clearScan();
  clearArchive();
  clearFolders();
  clearSearch();
  clearInbox();
  clearDecisions();
  clearPending();
  clearToday();
  clearSearchScreen();
  document.querySelectorAll('.dup-overlay').forEach((n) => n.remove());
  $('trash-list').hidden = true;
  pauseQueue();
  stopOcr();
  $('migration-dialog').hidden = true;
  resetBackupUi();
  resetZipUi();
  clearPasswordFields();
  $('unlock-error').textContent = '';
  $('change-pw-form').hidden = true;
  $('change-pw-toggle').setAttribute('aria-expanded', 'false');
  $('faceid-form').hidden = true;
  $('faceid-error').textContent = '';
  updateFaceIdUi();
  showScreen('today');
  showLockView('unlock');
  document.body.classList.add('locked');
  clearTimeout(inactivityTimer);
}

// ---------- Ersteinrichtung ----------
$('setup-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  const pw1 = $('setup-password').value;
  const pw2 = $('setup-password2').value;
  const error = $('setup-error');

  error.textContent = checkNewPassword(pw1, pw2);
  if (!error.textContent && !$('setup-understood').checked) {
    error.textContent = 'Bitte bestätige, dass du den Hinweis verstanden hast.';
  }
  if (error.textContent) return;

  const button = $('setup-submit');
  setBusy(button, true, 'Wird eingerichtet …');
  try {
    const { record, key } = await createVault(pw1);
    await setMeta('vault', record);
    await markSchemaCurrent();
    await saveSettings();
    vaultRecord = record;
    await requestPersistentStorage();
    await unlocked(key);
  } catch (err) {
    console.error(err);
    error.textContent = 'Einrichtung fehlgeschlagen. Bitte versuche es erneut.';
  } finally {
    setBusy(button, false);
  }
});

// ---------- Entsperren ----------
let failedAttempts = 0;

$('unlock-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  const input = $('unlock-password');
  const error = $('unlock-error');
  const button = $('unlock-submit');
  if (!input.value) return;

  error.textContent = '';
  setBusy(button, true, 'Wird entsperrt …');
  try {
    const key = await openVault(vaultRecord, input.value);
    failedAttempts = 0;
    setBusy(button, false);
    await unlocked(key);
  } catch (err) {
    input.value = '';
    if (!(err instanceof WrongPasswordError)) {
      console.error(err);
      error.textContent = 'Entsperren fehlgeschlagen.';
      setBusy(button, false);
      return;
    }
    failedAttempts += 1;
    // Ab dem 3. Fehlversuch zunehmend länger warten
    const waitSeconds = failedAttempts >= 3 ? Math.min(60, 2 ** (failedAttempts - 2)) : 0;
    if (waitSeconds === 0) {
      error.textContent = 'Falsches Passwort.';
      setBusy(button, false);
      input.focus();
      return;
    }
    let remaining = waitSeconds;
    const tick = () => {
      if (remaining <= 0) {
        error.textContent = 'Falsches Passwort.';
        setBusy(button, false);
        return;
      }
      error.textContent = `Falsches Passwort. Bitte ${remaining} s warten.`;
      remaining -= 1;
      setTimeout(tick, 1000);
    };
    tick();
  }
});

// ---------- Face ID ----------
function updateFaceIdUi() {
  // Sperrbildschirm: mit Face ID großer Knopf, Passwort erst auf Wunsch
  $('faceid-block').hidden = !faceIdRecord;
  $('show-password').hidden = !faceIdRecord;
  $('password-panel').hidden = Boolean(faceIdRecord);
  $('unlock-text').textContent = faceIdRecord
    ? 'Deine Dokumente sind verschlüsselt. Entsperre sie mit Face ID.'
    : 'Deine Dokumente sind verschlüsselt. Entsperre sie mit deinem Passwort.';
  $('faceid-status').textContent = faceIdRecord ? 'aktiv' : 'aus';
  $('faceid-toggle-label').textContent = faceIdRecord ? 'Face ID ausschalten' : 'Face ID einrichten';
}

$('show-password').addEventListener('click', () => {
  $('password-panel').hidden = false;
  $('show-password').hidden = true;
  $('unlock-password').focus();
});

$('faceid-unlock').addEventListener('click', async () => {
  if (!faceIdRecord) return;
  const button = $('faceid-unlock');
  $('faceid-error').textContent = '';
  setBusy(button, true, '…');
  try {
    const key = await unlockWithFaceId(faceIdRecord);
    setBusy(button, false);
    await unlocked(key);
  } catch (err) {
    setBusy(button, false);
    if (err.code !== 'cancelled') $('faceid-error').textContent = err.message;
  }
});

$('faceid-toggle').addEventListener('click', async () => {
  if (faceIdRecord) {
    if (!confirm('Face ID ausschalten? Du entsperrst dann wieder nur mit dem Passwort.\n\nDen Passkey „Dokumente-App“ bzw. „Folio“ kannst du danach in der App „Passwörter“ löschen.')) return;
    await disableFaceId();
    faceIdRecord = null;
    updateFaceIdUi();
    return;
  }
  const form = $('faceid-form');
  form.hidden = !form.hidden;
  $('faceid-setup-error').textContent = '';
  if (!form.hidden) $('faceid-password').focus();
});

$('faceid-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  const error = $('faceid-setup-error');
  const password = $('faceid-password').value;
  if (!password) { error.textContent = 'Bitte gib dein Passwort ein.'; return; }
  const button = $('faceid-submit');
  setBusy(button, true, 'Wird eingerichtet …');
  error.textContent = '';
  try {
    const dataKey = await openVaultForWrapping(vaultRecord, password);
    $('faceid-password').value = '';
    await enableFaceId(dataKey);
    faceIdRecord = await getFaceIdRecord();
    $('faceid-form').hidden = true;
    updateFaceIdUi();
    toast('Face ID ist eingerichtet');
  } catch (err) {
    $('faceid-password').value = '';
    if (err instanceof WrongPasswordError) error.textContent = 'Das Passwort ist falsch.';
    else if (err.code === 'cancelled') error.textContent = 'Abgebrochen.';
    else { console.error(err); error.textContent = err.message || 'Face ID konnte nicht eingerichtet werden.'; }
  } finally {
    setBusy(button, false);
  }
});

// ---------- Automatisch sperren ----------
let inactivityTimer = null;
let hiddenSince = null;
let hiddenForExternal = false;
// Während Kamera, Fotoauswahl oder Teilen-Menü offen sind, verlässt man die
// App kurz. Dann soll nicht sofort gesperrt werden (sonst wäre das Foto weg).
let externalUntil = 0;
const EXTERNAL_GRACE_MS = 10 * 60 * 1000;

function suspendAutoLock() {
  externalUntil = Date.now() + EXTERNAL_GRACE_MS;
}

function resumeAutoLock() {
  externalUntil = 0;
  resetInactivityTimer();
}

function resetInactivityTimer() {
  clearTimeout(inactivityTimer);
  if (!vaultKey || settings.autoLockMinutes <= 0) return;
  inactivityTimer = setTimeout(() => {
    if (Date.now() < externalUntil) resetInactivityTimer();
    else lock();
  }, settings.autoLockMinutes * 60 * 1000);
}

['pointerdown', 'keydown', 'scroll'].forEach((type) => {
  document.addEventListener(type, resetInactivityTimer, { passive: true, capture: true });
});

document.addEventListener('visibilitychange', () => {
  if (!vaultKey) return;
  if (document.visibilityState === 'hidden') {
    closeLiveScan();   // Kamera nie im Hintergrund laufen lassen
    hiddenSince = Date.now();
    hiddenForExternal = Date.now() < externalUntil;
    if (!hiddenForExternal && settings.autoLockMinutes <= 0) lock();
  } else if (hiddenSince !== null) {
    const away = Date.now() - hiddenSince;
    hiddenSince = null;
    const limit = hiddenForExternal ? EXTERNAL_GRACE_MS : settings.autoLockMinutes * 60 * 1000;
    hiddenForExternal = false;
    if (away >= limit) lock();
    else resetInactivityTimer();
  }
});

// =====================================================================
// Bildschirme Scannen und Ablage
// =====================================================================
const isOcrEnabled = () => settings.ocrAuto !== false;
const isAutoCropEnabled = () => settings.autoCrop !== false;
const calendarWithTitle = () => settings.calendar === 'title';

// Texterkennung im Hintergrund (dauerhafte Warteschlange)
initOcrQueue({
  getKey: () => vaultKey,
  isEnabled: isOcrEnabled,
  onPageDone: (docId, index, text) => {
    setPageText(docId, index, text);
    pageTextReady(docId);
  }
});
onQueueChange(() => updateQueueStatus());

initScan({
  getKey: () => vaultKey,
  suspendAutoLock,
  resumeAutoLock,
  isOcrEnabled,
  isAutoCropEnabled,
  getDocs,
  enqueueOcr: enqueue,
  checkDuplicate: checkBeforeSave,
  openCamera: startScan,
  sendToInbox: async (file) => {
    showScreen('today');
    await importFiles([file]);
  },
  // Erkannt-Bildschirm zeigen, sobald Seiten da sind; danach zurück zu „Heute“
  onDraftChange: (hasPages) => {
    if (hasPages && currentScreen !== 'scan') showScreen('scan');
    if (!hasPages && currentScreen === 'scan') showScreen('today');
  },
  onSaved: async (docId, texts) => {
    try {
      await refreshArchive();
      (texts || []).forEach((t, i) => { if (t) setPageText(docId, i, t.text); });
    } catch (err) {
      console.error(err);
    }
  }
});

// Duplikate
initDupCheck({
  getKey: () => vaultKey,
  getDocs,
  getPageTexts: getPageTextsFor,
  refresh: () => refreshArchive(),
  openReview: () => { showScreen('archive'); reviewPending(); }
});

// Markierung am Reiter „Ablage“ und Hinweis in der Ablage
onPendingChange((n) => {
  const badge = $('archive-badge');
  badge.hidden = !n;
  badge.textContent = n > 9 ? '9+' : String(n);
  updateDupBanner();
});

// Import (Eingang)
initImport({
  checkDuplicate: checkBeforeSave,
  getKey: () => vaultKey,
  suspendAutoLock,
  resumeAutoLock,
  isOcrEnabled,
  getDocs,
  enqueueOcr: enqueue,
  onImported: async (docId, texts) => {
    try {
      await refreshArchive();
      (texts || []).forEach((t, i) => { if (t) setPageText(docId, i, t.text); });
    } catch (err) {
      console.error(err);
    }
  }
});

initArchive({
  openSearch: (opts = {}) => { showScreen('search'); renderSearchScreen({ focus: opts.focus !== false }); },
  openDocFromSearch: (id, page, terms) => { showScreen('archive'); openDocFrom(id, page, terms); },
  openCollectionSoon: () => { showScreen('archive'); openCollection('soon'); },
  getPendingCount: () => getPending().length,
  openReview: () => reviewPending(),
  getKey: () => vaultKey,
  suspendAutoLock,
  resumeAutoLock,
  isOcrEnabled,
  enqueueOcr: enqueue,
  calendarWithTitle,
  getLastBackup: () => settings.lastBackup,
  goToBackup: () => {
    showScreen('settings');
    $('backup-group').scrollIntoView({ block: 'start' });
  }
});

// =====================================================================
// Einstellungen: Sicherheit
// =====================================================================
$('lock-now').addEventListener('click', lock);

$('autocrop-toggle').addEventListener('change', async (event) => {
  settings.autoCrop = event.target.checked;
  await saveSettings();
});

$('calendar-select').addEventListener('change', async (event) => {
  settings.calendar = event.target.value;
  await saveSettings();
});

$('ocr-toggle').addEventListener('change', async (event) => {
  settings.ocrAuto = event.target.checked;
  await saveSettings();
  if (settings.ocrAuto) kickOcr();
});

$('ocr-lang').addEventListener('change', async (event) => {
  settings.ocrLangs = event.target.value;
  setOcrLanguages(settings.ocrLangs);
  await saveSettings();
  toast('Sprachen geändert');
});

// Ältere Dokumente ohne Text in die Warteschlange
$('ocr-backfill').addEventListener('click', async () => {
  if (!vaultKey) return;
  const missing = getDocs().filter((d) => !d.meta.trashedAt && !hasText(d.id));
  if (!missing.length) { toast('Alle Dokumente haben schon Text'); return; }
  for (const doc of missing) await enqueue(doc.id, Array.from({ length: doc.meta.pageCount }, (_, i) => i));
  toast(`${missing.length} Dokument(e) vorgemerkt`);
});

// ---------- Aufräumen: Duplikate und Papierkorb ----------
let dupRunning = false;
$('dup-scan').addEventListener('click', async () => {
  if (!vaultKey || dupRunning) return;
  dupRunning = true;
  try {
    await scanAllDuplicates((text) => { $('dup-status').textContent = text; });
  } catch (err) {
    console.error(err);
    $('dup-status').textContent = 'Fehler bei der Suche';
  } finally {
    dupRunning = false;
    updateTrashUi();
  }
});

function updateTrashUi() {
  const n = getTrashed().length;
  $('trash-count').textContent = n ? (n === 1 ? '1 Dokument' : `${n} Dokumente`) : 'leer';
  if (!$('trash-list').hidden) renderTrash($('trash-list'), updateTrashUi);
}

$('trash-toggle').addEventListener('click', () => {
  const list = $('trash-list');
  list.hidden = !list.hidden;
  $('trash-toggle').setAttribute('aria-expanded', String(!list.hidden));
  if (!list.hidden) renderTrash(list, updateTrashUi);
});

async function updateQueueStatus() {
  const { queueState } = await import('./ocrqueue.js');
  const q = queueState();
  $('ocr-queue-status').textContent = q.pending ? `${q.pending} in Arbeit` : q.errors ? `${q.errors} Fehler` : '';
}

$('autolock-select').addEventListener('change', async (event) => {
  settings.autoLockMinutes = Number(event.target.value);
  await saveSettings();
  resetInactivityTimer();
});

$('change-pw-toggle').addEventListener('click', () => {
  const form = $('change-pw-form');
  form.hidden = !form.hidden;
  $('change-pw-toggle').setAttribute('aria-expanded', String(!form.hidden));
  $('change-pw-error').textContent = '';
  $('change-pw-success').textContent = '';
  if (!form.hidden) $('old-password').focus();
});

$('change-pw-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  const error = $('change-pw-error');
  const success = $('change-pw-success');
  const oldPw = $('old-password').value;
  const pw1 = $('new-password').value;
  const pw2 = $('new-password2').value;
  success.textContent = '';

  error.textContent = oldPw ? checkNewPassword(pw1, pw2) : 'Bitte gib dein aktuelles Passwort ein.';
  if (error.textContent) return;

  const button = $('change-pw-submit');
  setBusy(button, true, 'Wird geändert …');
  try {
    const newRecord = await changeVaultPassword(vaultRecord, oldPw, pw1);
    await setMeta('vault', newRecord);
    vaultRecord = newRecord;
    clearPasswordFields();
    success.textContent = 'Passwort wurde geändert. Ältere Backups öffnest du weiterhin mit dem alten Passwort.';
    toast('Passwort geändert');
  } catch (err) {
    if (err instanceof WrongPasswordError) {
      error.textContent = 'Das aktuelle Passwort ist falsch.';
    } else {
      console.error(err);
      error.textContent = 'Ändern fehlgeschlagen.';
    }
    $('old-password').value = '';
  } finally {
    setBusy(button, false);
  }
});

// =====================================================================
// Einstellungen: Backup
// =====================================================================
let pendingBackup = null; // erstellte, noch nicht gesicherte Backup-Datei
let pendingImport = null; // eingelesene Backup-Datei, wartet auf Passwort

function resetBackupUi() {
  pendingBackup = null;
  pendingImport = null;
  $('backup-ready').hidden = true;
  $('import-form').hidden = true;
  $('import-result').hidden = true;
  $('import-error').textContent = '';
  $('backup-create').disabled = false;
}

$('backup-create').addEventListener('click', async () => {
  if (!vaultKey) return;
  resetBackupUi();
  const button = $('backup-create');
  const label = button.querySelector('span:not(.f-row-icon)');
  label.textContent = 'Backup wird erstellt …';
  button.disabled = true;
  try {
    pendingBackup = await createBackup(vaultKey);
    const size = formatBytes(pendingBackup.blob.size);
    $('backup-ready-text').textContent = pendingBackup.count === 1
      ? `Backup mit 1 Dokument ist bereit (${size}).`
      : `Backup mit ${pendingBackup.count} Dokumenten ist bereit (${size}).`;
    $('backup-ready').hidden = false;
  } catch (err) {
    console.error(err);
    alert('Backup konnte nicht erstellt werden.');
  } finally {
    label.textContent = 'Backup erstellen';
    button.disabled = false;
  }
});

// Eigener Fingertipp nötig: das iPhone öffnet „Teilen“ nur direkt nach einer Berührung
$('backup-save').addEventListener('click', async () => {
  if (!pendingBackup) return;
  suspendAutoLock();
  try {
    const result = await saveBackupFile(pendingBackup);
    if (result !== 'cancelled') {
      settings.lastBackup = Date.now();
      await saveSettings();
      $('backup-ready').hidden = true;
      pendingBackup = null;
      updateInfo();
      toast('Backup gesichert');
    }
  } catch (err) {
    console.error(err);
    alert('Die Backup-Datei konnte nicht gesichert werden.');
  } finally {
    resumeAutoLock();
  }
});

$('backup-import').addEventListener('click', () => {
  resetBackupUi();
  suspendAutoLock();
  $('backup-file').click();
});

$('backup-file').addEventListener('cancel', resumeAutoLock);
$('backup-file').addEventListener('change', async () => {
  resumeAutoLock();
  const file = $('backup-file').files[0];
  $('backup-file').value = '';
  if (!file) return;
  try {
    pendingImport = await readBackupFile(file);
    const { header } = pendingImport;
    const created = new Date(header.created).toLocaleDateString('de-DE');
    $('import-summary').textContent = header.docs.length === 1
      ? `Backup vom ${created} mit 1 Dokument.`
      : `Backup vom ${created} mit ${header.docs.length} Dokumenten.`;
    $('import-form').hidden = false;
    $('import-password').focus();
  } catch (err) {
    console.error(err);
    alert(err instanceof BackupFormatError ? err.message : 'Die Datei konnte nicht gelesen werden.');
  }
});

$('import-cancel').addEventListener('click', resetBackupUi);

// =====================================================================
// Ordner-Export (ZIP) – liest nur, verändert nichts
// =====================================================================
let pendingZip = null;
let zipRunning = false;

function resetZipUi() {
  pendingZip = null;
  $('zip-progress').hidden = true;
  $('zip-ready').hidden = true;
  $('zip-error').hidden = true;
  $('zip-export').disabled = zipRunning;
  document.querySelectorAll('.zip-dialog').forEach((n) => n.remove());
}

/**
 * Hinweis „nicht verschlüsselt“ + Bestätigung mit Face ID oder Passwort.
 * Ergebnis: true, wenn bestätigt; false bei „Abbrechen“.
 */
function confirmZipExport() {
  return new Promise((resolve) => {
    const usesFaceId = Boolean(faceIdRecord);
    const password = el('input', { type: 'password', autocomplete: 'current-password', 'aria-label': 'Passwort' });
    const user = el('input', { class: 'sr-only', type: 'text', name: 'username', autocomplete: 'username', value: 'Dokumente-App', tabindex: '-1', 'aria-hidden': 'true' });
    const pwLabel = el('label', { class: 'zip-pw' }, 'Passwort zur Bestätigung', password);
    pwLabel.hidden = usesFaceId;
    const error = el('p', { class: 'error', role: 'alert' });
    const go = el('button', { type: 'submit', class: 'btn-primary' }, usesFaceId ? 'Mit Face ID exportieren' : 'Exportieren');
    const cancel = el('button', { type: 'button', class: 'btn-ghost' }, 'Abbrechen');
    const usePw = el('button', { type: 'button', class: 'btn-text' }, 'Stattdessen Passwort eingeben');
    usePw.hidden = !usesFaceId;

    const form = el('form', { class: 'dialog zip-confirm', role: 'dialog', 'aria-modal': 'true', 'aria-labelledby': 'zip-dialog-title', novalidate: true },
      el('span', { class: 'dialog-icon is-warn' }, icon('lock')),
      el('h2', { id: 'zip-dialog-title', text: 'Unverschlüsselt exportieren?' }),
      el('p', { text: 'Die ZIP enthält alle Dokumente als normale PDFs. Jeder, der die Datei hat, kann sie öffnen.' }),
      el('p', { class: 'hint', text: 'Bewahre sie nur an einem sicheren Ort auf und lösche Kopien, die du nicht mehr brauchst.' }),
      user, pwLabel, error, go, usePw, cancel
    );
    const backdrop = el('div', { class: 'dialog-backdrop zip-dialog' }, form);
    document.body.append(backdrop);
    (usesFaceId ? go : password).focus();

    const close = (ok) => { backdrop.remove(); resolve(ok); };
    cancel.addEventListener('click', () => close(false));
    usePw.addEventListener('click', () => {
      pwLabel.hidden = false;
      usePw.hidden = true;
      go.textContent = 'Exportieren';
      password.focus();
    });
    form.addEventListener('submit', async (event) => {
      event.preventDefault();
      error.textContent = '';
      go.disabled = true;
      try {
        if (pwLabel.hidden) {
          await unlockWithFaceId(faceIdRecord);
        } else {
          if (!password.value) { error.textContent = 'Bitte Passwort eingeben.'; return; }
          await openVault(vaultRecord, password.value);
        }
        password.value = '';
        close(true);
      } catch (err) {
        if (err instanceof WrongPasswordError) error.textContent = 'Falsches Passwort.';
        else if (pwLabel.hidden) {
          error.textContent = (err && err.message) || 'Face ID hat nicht geklappt.';
          pwLabel.hidden = false;
          usePw.hidden = true;
          go.textContent = 'Exportieren';
        } else error.textContent = 'Bestätigung fehlgeschlagen.';
      } finally {
        go.disabled = false;
      }
    });
  });
}

$('zip-export').addEventListener('click', async () => {
  if (!vaultKey || zipRunning) return;
  resetZipUi();
  if (!(await confirmZipExport())) return;
  if (!vaultKey) return;

  zipRunning = true;
  $('zip-export').disabled = true;
  $('zip-progress').hidden = false;
  const fill = $('zip-bar-fill');
  const text = $('zip-progress-text');
  fill.style.width = '0%';
  text.textContent = 'Export wird vorbereitet …';
  // Bildschirm anlassen, damit iOS die App während des Exports nicht sperrt
  let wakeLock = null;
  try { wakeLock = navigator.wakeLock ? await navigator.wakeLock.request('screen') : null; } catch { wakeLock = null; }

  try {
    const result = await exportFolderZip({
      getKey: () => vaultKey,
      onProgress: ({ done, total }) => {
        resetInactivityTimer(); // Export zählt als Benutzung
        fill.style.width = total ? `${Math.round((done / total) * 100)}%` : '100%';
        text.textContent = total ? `${Math.min(done + 1, total)} von ${total} Dokumenten …` : 'Keine Dokumente vorhanden …';
        if (done >= total) text.textContent = 'ZIP-Datei wird fertiggestellt …';
      }
    });
    if (!vaultKey) return;
    pendingZip = result;
    $('zip-progress').hidden = true;
    const docs = result.docCount === 1 ? '1 Dokument' : `${result.docCount} Dokumente`;
    const folders = result.folderCount === 1 ? '1 Ordner' : `${result.folderCount} Ordner`;
    $('zip-ready-text').textContent = `Fertig: ${docs} in ${folders} (${formatBytes(result.blob.size)}).`;
    $('zip-ready-failed').textContent = result.failed.length
      ? `Übersprungen (${result.failed.length}): ${result.failed.map((f) => `„${f.title}“`).join(', ')} – steht auch in LIESMICH.txt.`
      : '';
    $('zip-ready').hidden = false;
    $('zip-save').focus();
  } catch (err) {
    console.error(err);
    $('zip-progress').hidden = true;
    if (err instanceof ExportLockedError) return; // gesperrt: Oberfläche ist schon geleert
    $('zip-error').textContent = `Export fehlgeschlagen: ${(err && err.message) || 'unbekannter Fehler'}. Es wurde nichts verändert.`;
    $('zip-error').hidden = false;
  } finally {
    zipRunning = false;
    $('zip-export').disabled = false;
    if (wakeLock) wakeLock.release().catch(() => {});
  }
});

$('zip-save').addEventListener('click', async () => {
  if (!pendingZip) return;
  const file = new File([pendingZip.blob], pendingZip.fileName, { type: 'application/zip' });
  suspendAutoLock();
  try {
    if (navigator.canShare && navigator.canShare({ files: [file] })) {
      try {
        await navigator.share({ files: [file], title: pendingZip.fileName });
      } catch (err) {
        if (err.name === 'AbortError') return;
        throw err;
      }
    } else {
      const url = URL.createObjectURL(file);
      const link = el('a', { href: url, download: pendingZip.fileName });
      document.body.append(link);
      link.click();
      link.remove();
      setTimeout(() => URL.revokeObjectURL(url), 60000);
    }
    toast('ZIP-Datei gesichert');
    resetZipUi();
  } catch (err) {
    console.error(err);
    toast('Sichern hat nicht geklappt', 'error');
  } finally {
    resumeAutoLock();
  }
});

$('import-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  if (!pendingImport || !vaultKey) return;
  const error = $('import-error');
  const password = $('import-password').value;
  if (!password) { error.textContent = 'Bitte gib das Passwort des Backups ein.'; return; }
  error.textContent = '';

  const button = $('import-submit');
  setBusy(button, true, 'Wird geprüft …');
  try {
    const result = await importBackup(vaultKey, pendingImport, password, (done, total) => {
      button.textContent = `Dokument ${done} von ${total} …`;
    });
    clearPasswordFields();
    resetBackupUi();
    const parts = [`${result.imported} Dokument(e) übernommen.`];
    if (result.foldersAdded) parts.push(`${result.foldersAdded} Ablageort(e) ergänzt.`);
    if (result.skipped) parts.push(`${result.skipped} waren schon vorhanden.`);
    $('import-result').textContent = parts.join(' ');
    $('import-result').hidden = false;
    await refreshArchive();
    updateInfo();
    toast('Backup eingelesen');
  } catch (err) {
    $('import-password').value = '';
    if (err instanceof WrongPasswordError) error.textContent = 'Das Passwort passt nicht zu diesem Backup.';
    else if (err instanceof BackupFormatError) error.textContent = err.message;
    else { console.error(err); error.textContent = 'Einlesen fehlgeschlagen. Ist der Speicher voll?'; }
  } finally {
    setBusy(button, false);
  }
});

// =====================================================================
// Einstellungen: Info
// =====================================================================
async function updateInfo() {
  $('last-backup').textContent = settings.lastBackup
    ? new Date(settings.lastBackup).toLocaleDateString('de-DE')
    : 'noch nie';
  $('doc-count').textContent = String(documentCount());
  updateTrashUi();
  if (navigator.storage && navigator.storage.estimate) {
    try {
      const { usage } = await navigator.storage.estimate();
      $('storage-used').textContent = formatBytes(usage);
    } catch { /* egal */ }
  }
  updatePersistStatus();
  showInstalledVersion();
}

// Bittet den Browser, die Daten nicht automatisch zu löschen, wenn der Platz knapp wird.
async function requestPersistentStorage() {
  if (!navigator.storage || !navigator.storage.persist) return;
  try {
    await navigator.storage.persist();
  } catch { /* nicht schlimm */ }
}

async function updatePersistStatus() {
  const label = $('persist-status');
  if (!navigator.storage || !navigator.storage.persisted) {
    label.textContent = 'nicht unterstützt';
    return;
  }
  label.textContent = (await navigator.storage.persisted()) ? 'aktiv' : 'nicht aktiv';
}

// =====================================================================
// Start
// =====================================================================
async function start() {
  hydrateIcons();
  if (!window.crypto || !crypto.subtle || !window.indexedDB) {
    showLockView('loading');
    $('lock-loading').textContent = 'Dieser Browser unterstützt keine sichere Verschlüsselung. Bitte nutze Safari über https.';
    return;
  }
  try {
    const savedSettings = await getMeta('settings');
    if (savedSettings) settings = { ...settings, ...savedSettings };
    $('autolock-select').value = String(settings.autoLockMinutes);
    $('ocr-toggle').checked = isOcrEnabled();
    $('autocrop-toggle').checked = isAutoCropEnabled();
    $('calendar-select').value = settings.calendar === 'title' ? 'title' : 'neutral';
    $('ocr-lang').value = settings.ocrLangs || 'deu';
    setOcrLanguages(settings.ocrLangs);

    vaultRecord = await getMeta('vault');
    faceIdRecord = vaultRecord ? (await getFaceIdRecord()) || null : null;
    $('faceid-toggle').hidden = !(await faceIdAvailable());
    updateFaceIdUi();
    if ($('faceid-toggle').hidden) $('faceid-status').textContent = 'auf diesem Gerät nicht verfügbar';
    showLockView(vaultRecord ? 'unlock' : 'setup');
    if (vaultRecord) requestPersistentStorage();
  } catch (err) {
    console.error(err);
    $('lock-loading').textContent = 'Der lokale Speicher konnte nicht geöffnet werden.';
  }
}

start();

// =====================================================================
// Updates: Bei jedem Öffnen der App wird geprüft, ob es eine neue
// Version gibt. Ist eine da, lädt die App sich neu – im gesperrten
// Zustand sofort, sonst nach Tippen auf den Hinweis oben.
// =====================================================================
const APP_VERSION = '2.1.0';
let updateRequested = false; // „Nach Updates suchen“ gedrückt → nach dem Update sofort neu laden

if ('serviceWorker' in navigator) {
  const hadController = Boolean(navigator.serviceWorker.controller);
  let reloading = false;

  navigator.serviceWorker.addEventListener('controllerchange', () => {
    if (!hadController || reloading) return;
    if (updateRequested || document.body.classList.contains('locked')) {
      reloading = true;
      location.reload();
    } else {
      $('update-banner').hidden = false;
    }
  });

  $('update-banner').addEventListener('click', () => {
    reloading = true;
    location.reload();
  });

  navigator.serviceWorker.register('sw.js', { updateViaCache: 'none' })
    .then((registration) => {
      const checkForUpdate = () => registration.update().catch(() => {});
      document.addEventListener('visibilitychange', () => {
        if (document.visibilityState === 'visible') checkForUpdate();
      });
      window.addEventListener('online', checkForUpdate);
    })
    .catch((err) => {
      console.warn('Service Worker konnte nicht registriert werden:', err);
    });
}

// ---------------------------------------------------------------------
// Knopf „Nach Updates suchen“ (Mehr → Info)
// ---------------------------------------------------------------------
async function showInstalledVersion() {
  let build = '';
  try {
    const name = (await caches.keys()).find((k) => /^dokumente-v\d+$/.test(k));
    if (name) build = ` · ${name.replace('dokumente-', '')}`;
  } catch { /* egal */ }
  $('app-version').textContent = `${APP_VERSION}${build}`;
}
showInstalledVersion();

$('update-check').addEventListener('click', async () => {
  const status = $('update-status');
  const button = $('update-check');
  if (!('serviceWorker' in navigator)) { status.textContent = 'Auf diesem Gerät nicht möglich'; return; }
  if (!navigator.onLine) { status.textContent = 'Kein Internet – Updates gibt es nur online'; return; }
  // Nichts Ungespeichertes verlieren: Neu laden würde Scan bzw. Export abbrechen
  if (hasDraft()) { status.textContent = 'Erst den offenen Scan ablegen'; return; }
  if (zipRunning) { status.textContent = 'Erst den Export abwarten'; return; }
  button.disabled = true;
  status.textContent = 'Suche …';
  try {
    const registration = await navigator.serviceWorker.getRegistration();
    if (!registration) throw new Error('kein Service Worker');
    await registration.update();
    const incoming = registration.installing || registration.waiting;
    if (!incoming) {
      status.textContent = 'Du hast die neueste Version';
      button.disabled = false;
      return;
    }
    status.textContent = 'Update wird installiert …';
    updateRequested = true;
    // Der neue Service Worker übernimmt selbst (skipWaiting) → controllerchange lädt neu.
    // Falls das ausbleibt: nach der Aktivierung bzw. spätestens nach 30 Sekunden neu laden.
    incoming.addEventListener('statechange', () => {
      if (incoming.state === 'activated') setTimeout(() => location.reload(), 300);
      if (incoming.state === 'redundant') { status.textContent = 'Update fehlgeschlagen – später erneut versuchen'; button.disabled = false; updateRequested = false; }
    });
    setTimeout(() => { if (updateRequested) location.reload(); }, 30000);
  } catch (err) {
    console.error(err);
    status.textContent = 'Suche nicht möglich – später erneut versuchen';
    button.disabled = false;
  }
});
