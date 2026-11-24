/**
 * frontend/src/session.js
 * 
 * Session Storage & State Persistence Manager.
 * 
 * Complies with Interface Contracts:
 * - sessionStorage key: "garmin_dash_session_key" (Base64 raw 32-byte derived AES key)
 * - sessionStorage key: "garmin_vault_session" (Decrypted JSON string)
 * - Complete purge upon user lock action.
 */

export const STORAGE_KEY_NAME = 'garmin_dash_session_key';
export const STORAGE_VAULT_NAME = 'garmin_vault_session';
export const STORAGE_META_NAME = 'garmin_dash_session_meta';

/**
 * Checks if sessionStorage is available.
 * @returns {boolean}
 */
function isSessionStorageAvailable() {
  try {
    return typeof window !== 'undefined' && typeof window.sessionStorage !== 'undefined';
  } catch (e) {
    return false;
  }
}

/**
 * Saves authenticated session key and lightweight metadata to sessionStorage.
 * Never writes full decrypted payload JSON to sessionStorage (avoids 5 MB quota limit).
 * @param {string} rawKeyBase64 - Base64 encoded 32-byte AES key
 * @param {object} [_payload] - Ignored (retained for call-site compatibility)
 */
export function saveSession(rawKeyBase64, _payload) {
  if (!isSessionStorageAvailable()) return;
  try {
    if (rawKeyBase64) {
      window.sessionStorage.setItem(STORAGE_KEY_NAME, rawKeyBase64);
      window.sessionStorage.setItem(
        STORAGE_META_NAME,
        JSON.stringify({ savedAt: Date.now() })
      );
    }
    window.sessionStorage.removeItem(STORAGE_VAULT_NAME);
  } catch (err) {
    console.warn('Failed to save session state to sessionStorage:', err);
  }
}

/**
 * Retrieves cached raw 32-byte key from sessionStorage.
 * @returns {string|null}
 */
export function getStoredKey() {
  if (!isSessionStorageAvailable()) return null;
  return window.sessionStorage.getItem(STORAGE_KEY_NAME);
}

/**
 * Returns null (full payload is no longer persisted to sessionStorage).
 * Retained for backward API compatibility.
 * @returns {null}
 */
export function getStoredPayload() {
  return null;
}

/**
 * Checks whether an active session is persisted in sessionStorage.
 * @returns {boolean}
 */
export function hasActiveSession() {
  if (!isSessionStorageAvailable()) return false;
  return Boolean(window.sessionStorage.getItem(STORAGE_KEY_NAME));
}

/**
 * Completely purges all session keys and metadata from sessionStorage.
 */
export function clearSession() {
  if (!isSessionStorageAvailable()) return;
  try {
    window.sessionStorage.removeItem(STORAGE_KEY_NAME);
    window.sessionStorage.removeItem(STORAGE_VAULT_NAME);
    window.sessionStorage.removeItem(STORAGE_META_NAME);
    window.sessionStorage.clear();
  } catch (err) {
    console.warn('Failed to clear sessionStorage:', err);
  }
}
