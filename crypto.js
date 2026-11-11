// Verschlüsselung – nutzt nur die im Browser eingebaute Web Crypto API.
//
// Aufbau:
//  - Aus deinem Passwort wird mit PBKDF2 (600.000 Runden) ein
//    „Passwort-Schlüssel“ berechnet. Das dauert absichtlich etwas,
//    damit Passwort-Raten extrem langsam wird.
//  - Die eigentlichen Daten werden mit einem zufälligen „Daten-Schlüssel“
//    (AES-256-GCM) verschlüsselt.
//  - Gespeichert wird nur der Daten-Schlüssel, eingepackt (verschlüsselt)
//    mit dem Passwort-Schlüssel. Das Passwort selbst wird nie gespeichert.
//  - Beim Passwort-Wechsel wird nur der Daten-Schlüssel neu eingepackt –
//    die Dokumente müssen nicht neu verschlüsselt werden.

const PBKDF2_ITERATIONS = 600000;
const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder();

export class WrongPasswordError extends Error {
  constructor() {
    super('Falsches Passwort');
    this.name = 'WrongPasswordError';
  }
}

function randomBytes(length) {
  return crypto.getRandomValues(new Uint8Array(length));
}

async function derivePasswordKey(password, salt, iterations) {
  const baseKey = await crypto.subtle.importKey(
    'raw', textEncoder.encode(password), 'PBKDF2', false, ['deriveKey']
  );
  return crypto.subtle.deriveKey(
    { name: 'PBKDF2', salt, iterations, hash: 'SHA-256' },
    baseKey,
    { name: 'AES-GCM', length: 256 },
    false,
    ['wrapKey', 'unwrapKey']
  );
}

async function wrapDataKey(dataKey, password) {
  const salt = randomBytes(16);
  const iv = randomBytes(12);
  const passwordKey = await derivePasswordKey(password, salt, PBKDF2_ITERATIONS);
  const wrapped = await crypto.subtle.wrapKey('raw', dataKey, passwordKey, { name: 'AES-GCM', iv });
  return {
    version: 1,
    kdf: 'PBKDF2-SHA256',
    iterations: PBKDF2_ITERATIONS,
    salt,
    iv,
    wrappedKey: new Uint8Array(wrapped)
  };
}

async function unwrapDataKey(record, password, extractable) {
  const passwordKey = await derivePasswordKey(password, record.salt, record.iterations);
  try {
    return await crypto.subtle.unwrapKey(
      'raw', record.wrappedKey, passwordKey,
      { name: 'AES-GCM', iv: record.iv },
      { name: 'AES-GCM', length: 256 },
      extractable,
      ['encrypt', 'decrypt']
    );
  } catch {
    // AES-GCM prüft die Echtheit: falsches Passwort => Entpacken schlägt fehl
    throw new WrongPasswordError();
  }
}

/** Neuen Tresor anlegen. Gibt den zu speichernden Datensatz und den Schlüssel zurück. */
export async function createVault(password) {
  const dataKey = await crypto.subtle.generateKey({ name: 'AES-GCM', length: 256 }, true, ['encrypt', 'decrypt']);
  const record = await wrapDataKey(dataKey, password);
  // Für die Nutzung eine nicht-exportierbare Kopie holen
  const key = await unwrapDataKey(record, password, false);
  return { record, key };
}

/** Tresor mit Passwort öffnen. Wirft WrongPasswordError bei falschem Passwort. */
export function openVault(record, password) {
  return unwrapDataKey(record, password, false);
}

/** Passwort ändern: Daten-Schlüssel mit neuem Passwort neu einpacken. */
export async function changeVaultPassword(record, oldPassword, newPassword) {
  const dataKey = await unwrapDataKey(record, oldPassword, true);
  return wrapDataKey(dataKey, newPassword);
}

/** Bytes verschlüsseln. Ergebnis: { iv, data } */
export async function encryptBytes(key, bytes) {
  const iv = randomBytes(12);
  const data = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, bytes);
  return { iv, data: new Uint8Array(data) };
}

/** Bytes entschlüsseln. */
export async function decryptBytes(key, box) {
  const data = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: box.iv }, key, box.data);
  return new Uint8Array(data);
}

/** Beliebige Daten (Objekt, Text, Zahl) verschlüsseln. */
export function encryptJSON(key, value) {
  return encryptBytes(key, textEncoder.encode(JSON.stringify(value)));
}

export async function decryptJSON(key, box) {
  return JSON.parse(textDecoder.decode(await decryptBytes(key, box)));
}
