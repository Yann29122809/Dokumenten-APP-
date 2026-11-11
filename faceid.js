// Entsperren mit Face ID über einen Passkey (WebAuthn mit „PRF“-Erweiterung).
//
// So funktioniert es:
//  - Beim Einrichten legt das iPhone einen Passkey im iCloud-Schlüsselbund an.
//  - Nach jedem Face-ID-Scan liefert der Passkey ein geheimes Ergebnis (PRF),
//    das nur dieses Passkey + Face ID erzeugen kann.
//  - Daraus wird ein Schlüssel berechnet, der den Daten-Schlüssel einpackt –
//    genau wie das Passwort. Das geheime Ergebnis wird nie gespeichert.
//  - Das Passwort bleibt immer als zweiter Weg zum Entsperren erhalten.
//
// Voraussetzung: iOS 18 oder neuer, iCloud-Schlüsselbund eingeschaltet.

import { getMeta, setMeta } from './db.js';

const INFO = new TextEncoder().encode('dokumente-faceid-v1');
const rand = (n) => crypto.getRandomValues(new Uint8Array(n));

export class FaceIdError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}

export async function faceIdAvailable() {
  if (!window.PublicKeyCredential || !navigator.credentials) return false;
  try {
    return await PublicKeyCredential.isUserVerifyingPlatformAuthenticatorAvailable();
  } catch {
    return false;
  }
}

export const getFaceIdRecord = () => getMeta('faceid');

async function keyFromPrf(prfOutput, salt) {
  const base = await crypto.subtle.importKey('raw', prfOutput, 'HKDF', false, ['deriveKey']);
  return crypto.subtle.deriveKey(
    { name: 'HKDF', hash: 'SHA-256', salt, info: INFO },
    base,
    { name: 'AES-GCM', length: 256 },
    false,
    ['wrapKey', 'unwrapKey']
  );
}

function translateError(err) {
  if (err instanceof FaceIdError) return err;
  if (err && err.name === 'NotAllowedError') return new FaceIdError('cancelled', 'Face ID wurde abgebrochen.');
  if (err && err.name === 'InvalidStateError') return new FaceIdError('exists', 'Für diese App gibt es schon einen Passkey.');
  if (err && err.name === 'SecurityError') return new FaceIdError('security', 'Face ID geht nur auf der richtigen Internetadresse (https).');
  return new FaceIdError('failed', 'Face ID hat nicht funktioniert.');
}

async function readPrf(credentialId, prfSalt) {
  const assertion = await navigator.credentials.get({
    publicKey: {
      challenge: rand(32),
      rpId: location.hostname,
      allowCredentials: [{ type: 'public-key', id: credentialId }],
      userVerification: 'required',
      timeout: 60000,
      extensions: { prf: { eval: { first: prfSalt } } }
    }
  });
  const results = assertion.getClientExtensionResults();
  const first = results && results.prf && results.prf.results && results.prf.results.first;
  if (!first) throw new FaceIdError('unsupported', 'Dieses iPhone unterstützt Face ID für Web-Apps noch nicht (iOS 18 nötig).');
  return new Uint8Array(first);
}

/**
 * Face ID einrichten. dataKey muss eine exportierbare Kopie des
 * Daten-Schlüssels sein (dafür wird vorher das Passwort abgefragt).
 */
export async function enableFaceId(dataKey) {
  try {
    const prfSalt = rand(32);
    const credential = await navigator.credentials.create({
      publicKey: {
        rp: { name: 'Folio', id: location.hostname },
        user: { id: rand(16), name: 'Folio', displayName: 'Folio' },
        challenge: rand(32),
        pubKeyCredParams: [{ type: 'public-key', alg: -7 }, { type: 'public-key', alg: -257 }],
        authenticatorSelection: { authenticatorAttachment: 'platform', residentKey: 'required', userVerification: 'required' },
        timeout: 60000,
        extensions: { prf: { eval: { first: prfSalt } } }
      }
    });
    const ext = credential.getClientExtensionResults();
    if (!ext.prf || ext.prf.enabled === false) {
      throw new FaceIdError('unsupported', 'Dieses iPhone unterstützt Face ID für Web-Apps noch nicht (iOS 18 nötig).');
    }
    const credentialId = new Uint8Array(credential.rawId);
    // Manche Geräte liefern das Ergebnis schon beim Anlegen, sonst einmal Face ID bestätigen
    const prfOutput = ext.prf.results && ext.prf.results.first
      ? new Uint8Array(ext.prf.results.first)
      : await readPrf(credentialId, prfSalt);

    const hkdfSalt = rand(16);
    const iv = rand(12);
    const wrapKey = await keyFromPrf(prfOutput, hkdfSalt);
    const wrapped = await crypto.subtle.wrapKey('raw', dataKey, wrapKey, { name: 'AES-GCM', iv });
    await setMeta('faceid', { v: 1, credentialId, prfSalt, hkdfSalt, iv, wrappedKey: new Uint8Array(wrapped), created: Date.now() });
  } catch (err) {
    throw translateError(err);
  }
}

/** Mit Face ID entsperren. Gibt den (nicht exportierbaren) Daten-Schlüssel zurück. */
export async function unlockWithFaceId(record) {
  try {
    const prfOutput = await readPrf(record.credentialId, record.prfSalt);
    const wrapKey = await keyFromPrf(prfOutput, record.hkdfSalt);
    try {
      return await crypto.subtle.unwrapKey(
        'raw', record.wrappedKey, wrapKey, { name: 'AES-GCM', iv: record.iv },
        { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']
      );
    } catch {
      throw new FaceIdError('mismatch', 'Face ID passt nicht mehr – bitte mit Passwort entsperren und Face ID neu einrichten.');
    }
  } catch (err) {
    throw translateError(err);
  }
}

export function disableFaceId() {
  return setMeta('faceid', null);
}
