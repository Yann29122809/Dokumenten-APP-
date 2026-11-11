import { createVault, openVault, openVaultForWrapping, changeVaultPassword, WrongPasswordError } from './crypto.js';
import { faceIdAvailable, getFaceIdRecord, enableFaceId, unlockWithFaceId, disableFaceId } from './faceid.js';
import { getMeta, setMeta } from './db.js';
import { formatBytes, toast } from './dom.js';
import { hydrateIcons } from './icons.js';
import { initScan, clearScan } from './scan.js';
import { initArchive, refreshArchive, clearArchive, showRoot, documentCount, getDocs } from './archive.js';
import { loadFolders, clearFolders } from './folders.js';
import { stopOcr } from './ocr.js';
import { createBackup, saveBackupFile, readBackupFile, importBackup, BackupFormatError } from './backup.js';

const $ = (id) => document.getElementById(id);
const MIN_PASSWORD_LENGTH = 8;

// Der entsperrte Schlüssel lebt nur im Arbeitsspeicher, solange die App offen ist.
let vaultKey = null;
let vaultRecord = null;
let settings = { autoLockMinutes: 5, lastBackup: null, ocrAuto: true, autoCrop: true, calendar: 'neutral' };
let faceIdRecord = null;

const saveSettings = () => setMeta('settings', settings);

// =====================================================================
// Navigation zwischen den drei Bildschirmen
// =====================================================================
const tabs = document.querySelectorAll('.tab');
const screens = document.querySelectorAll('.screen');

function showScreen(name) {
  screens.forEach((screen) => {
    const active = screen.id === 'screen-' + name;
    screen.hidden = !active;
    screen.classList.toggle('is-active', active);
  });
  tabs.forEach((tab) => {
    const active = tab.dataset.screen === name;
    tab.classList.toggle('is-active', active);
    if (active) {
      tab.setAttribute('aria-current', 'page');
      $('screen-title').textContent = tab.dataset.title;
    } else {
      tab.removeAttribute('aria-current');
    }
  });
  document.querySelector('.app-main').scrollTop = 0;
  if (name === 'archive') showRoot();
  if (name === 'settings') updateInfo();
}

tabs.forEach((tab) => tab.addEventListener('click', () => showScreen(tab.dataset.screen)));

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
  } catch (err) {
    console.error(err);
  }
}

function lock() {
  if (!vaultRecord) return;
  vaultKey = null;
  // Alles Entschlüsselte aus dem Speicher und vom Bildschirm entfernen
  clearScan();
  clearArchive();
  clearFolders();
  stopOcr();
  resetBackupUi();
  clearPasswordFields();
  $('unlock-error').textContent = '';
  $('change-pw-form').hidden = true;
  $('change-pw-toggle').setAttribute('aria-expanded', 'false');
  $('faceid-form').hidden = true;
  $('faceid-error').textContent = '';
  showScreen('scan');
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
  $('faceid-unlock').hidden = !faceIdRecord;
  $('unlock-text').textContent = faceIdRecord
    ? 'Oder gib dein Passwort ein.'
    : 'Gib dein Passwort ein, um deine Dokumente zu öffnen.';
  $('faceid-status').textContent = faceIdRecord ? 'aktiv' : 'aus';
  $('faceid-toggle-label').textContent = faceIdRecord ? 'Face ID ausschalten' : 'Face ID einrichten';
}

$('faceid-unlock').addEventListener('click', async () => {
  if (!faceIdRecord) return;
  const button = $('faceid-unlock');
  $('faceid-error').textContent = '';
  setBusy(button, true, 'Face ID …');
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
    if (!confirm('Face ID ausschalten? Du entsperrst dann wieder nur mit dem Passwort.\n\nDen Passkey „Dokumente-App“ kannst du danach in der App „Passwörter“ löschen.')) return;
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

initScan({
  getKey: () => vaultKey,
  suspendAutoLock,
  resumeAutoLock,
  isOcrEnabled,
  isAutoCropEnabled,
  getDocs,
  onSaved: () => refreshArchive().catch((err) => console.error(err))
});

initArchive({
  getKey: () => vaultKey,
  suspendAutoLock,
  resumeAutoLock,
  isOcrEnabled,
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
});

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
  const label = button.querySelector('span');
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
  if (navigator.storage && navigator.storage.estimate) {
    try {
      const { usage } = await navigator.storage.estimate();
      $('storage-used').textContent = formatBytes(usage);
    } catch { /* egal */ }
  }
  updatePersistStatus();
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
if ('serviceWorker' in navigator) {
  const hadController = Boolean(navigator.serviceWorker.controller);
  let reloading = false;

  navigator.serviceWorker.addEventListener('controllerchange', () => {
    if (!hadController || reloading) return;
    if (document.body.classList.contains('locked')) {
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
