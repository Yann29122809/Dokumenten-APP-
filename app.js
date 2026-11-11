import { createVault, openVault, changeVaultPassword, WrongPasswordError } from './crypto.js';
import { getMeta, setMeta } from './db.js';

const $ = (id) => document.getElementById(id);
const MIN_PASSWORD_LENGTH = 8;

// Der entsperrte Schlüssel lebt nur im Arbeitsspeicher, solange die App offen ist.
let vaultKey = null;
let vaultRecord = null;
let settings = { autoLockMinutes: 5 };

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
}

tabs.forEach((tab) => tab.addEventListener('click', () => showScreen(tab.dataset.screen)));

// =====================================================================
// Hilfsfunktionen für Formulare
// =====================================================================
function setBusy(button, busy, busyText) {
  if (busy) {
    button.dataset.label = button.textContent;
    button.textContent = busyText;
    button.disabled = true;
  } else {
    button.textContent = button.dataset.label || button.textContent;
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

function unlocked(key) {
  vaultKey = key;
  clearPasswordFields();
  document.body.classList.remove('locked');
  resetInactivityTimer();
}

function lock() {
  if (!vaultRecord) return;
  vaultKey = null;
  clearPasswordFields();
  $('unlock-error').textContent = '';
  $('change-pw-form').hidden = true;
  $('change-pw-toggle').setAttribute('aria-expanded', 'false');
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
    await setMeta('settings', settings);
    vaultRecord = record;
    await requestPersistentStorage();
    unlocked(key);
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
    unlocked(key);
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

// ---------- Automatisch sperren ----------
let inactivityTimer = null;
let hiddenSince = null;

function resetInactivityTimer() {
  clearTimeout(inactivityTimer);
  if (!vaultKey || settings.autoLockMinutes <= 0) return;
  inactivityTimer = setTimeout(lock, settings.autoLockMinutes * 60 * 1000);
}

['pointerdown', 'keydown', 'scroll'].forEach((type) => {
  document.addEventListener(type, resetInactivityTimer, { passive: true, capture: true });
});

document.addEventListener('visibilitychange', () => {
  if (!vaultKey) return;
  if (document.visibilityState === 'hidden') {
    hiddenSince = Date.now();
    if (settings.autoLockMinutes <= 0) lock();
  } else if (hiddenSince !== null) {
    const away = Date.now() - hiddenSince;
    hiddenSince = null;
    if (away >= settings.autoLockMinutes * 60 * 1000) lock();
    else resetInactivityTimer();
  }
});

// =====================================================================
// Einstellungen
// =====================================================================
$('lock-now').addEventListener('click', lock);

$('autolock-select').addEventListener('change', async (event) => {
  settings.autoLockMinutes = Number(event.target.value);
  await setMeta('settings', settings);
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
    success.textContent = 'Passwort wurde geändert.';
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

// ---------- Dauerhafter Speicher ----------
// Bittet den Browser, die Daten nicht automatisch zu löschen, wenn der Platz knapp wird.
async function requestPersistentStorage() {
  if (!navigator.storage || !navigator.storage.persist) return;
  try {
    await navigator.storage.persist();
  } catch { /* nicht schlimm */ }
  updatePersistStatus();
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
  if (!window.crypto || !crypto.subtle || !window.indexedDB) {
    showLockView('loading');
    $('lock-loading').textContent = 'Dieser Browser unterstützt keine sichere Verschlüsselung. Bitte nutze Safari über https.';
    return;
  }
  try {
    const savedSettings = await getMeta('settings');
    if (savedSettings) settings = { ...settings, ...savedSettings };
    $('autolock-select').value = String(settings.autoLockMinutes);

    vaultRecord = await getMeta('vault');
    showLockView(vaultRecord ? 'unlock' : 'setup');
    updatePersistStatus();
  } catch (err) {
    console.error(err);
    $('lock-loading').textContent = 'Der lokale Speicher konnte nicht geöffnet werden.';
  }
}

start();

// =====================================================================
// Service Worker (macht die App offline-fähig)
// =====================================================================
// Updates: Bei jedem Öffnen der App wird geprüft, ob es eine neue
// Version gibt. Ist eine da, lädt die App sich neu – im gesperrten
// Zustand sofort, sonst nach Tippen auf den Hinweis oben.
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
