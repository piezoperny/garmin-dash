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
 * Saves authenticated session key and decrypted payload to sessionStorage.
 * @param {string} rawKeyBase64 - Base64 encoded 32-byte AES key
 * @param {object} payload - Decrypted dashboard rollup payload
 */
export function saveSession(rawKeyBase64, payload) {
  if (!isSessionStorageAvailable()) return;
  try {
    if (rawKeyBase64) {
      window.sessionStorage.setItem(STORAGE_KEY_NAME, rawKeyBase64);
    }
    if (payload) {
      window.sessionStorage.setItem(STORAGE_VAULT_NAME, JSON.stringify(payload));
    }
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
 * Retrieves cached decrypted payload from sessionStorage.
 * @returns {object|null}
 */
export function getStoredPayload() {
  if (!isSessionStorageAvailable()) return null;
  try {
    const raw = window.sessionStorage.getItem(STORAGE_VAULT_NAME);
    if (!raw) return null;
    return JSON.parse(raw);
  } catch (err) {
    window.sessionStorage.removeItem(STORAGE_VAULT_NAME);
    return null;
  }
}

/**
 * Checks whether an active session is persisted in sessionStorage.
 * @returns {boolean}
 */
export function hasActiveSession() {
  if (!isSessionStorageAvailable()) return false;
  return Boolean(
    window.sessionStorage.getItem(STORAGE_KEY_NAME) || 
    window.sessionStorage.getItem(STORAGE_VAULT_NAME)
  );
}

/**
 * Completely purges all session keys and decrypted payload from sessionStorage.
 */
export function clearSession() {
  if (!isSessionStorageAvailable()) return;
  try {
    window.sessionStorage.removeItem(STORAGE_KEY_NAME);
    window.sessionStorage.removeItem(STORAGE_VAULT_NAME);
    window.sessionStorage.clear();
  } catch (err) {
    console.warn('Failed to clear sessionStorage:', err);
  }
}
