/**
 * frontend/src/crypto.js
 * 
 * Native Web Crypto Subtle Decryption Engine for Garmin Encrypted Dashboard.
 * 
 * Cryptographic Specifications:
 * - KDF: PBKDF2-HMAC-SHA256 (600,000 iterations)
 * - Cipher: AES-256-GCM (12-byte IV, 16-byte GCM authentication tag)
 * - Binary Wire Layout: [16-byte Salt] + [12-byte IV] + [Ciphertext + 16-byte Tag]
 * - Minimum Wire Length: 44 bytes
 */

export const PBKDF2_ITERATIONS = 600000;
export const SALT_LENGTH = 16;
export const IV_LENGTH = 12;
export const TAG_LENGTH_BITS = 128; // 16 bytes

/**
 * Converts ArrayBuffer or Uint8Array to Base64 string.
 * Compatible across browser and Node.js runtimes.
 * @param {ArrayBuffer|Uint8Array} buffer
 * @returns {string}
 */
export function arrayBufferToBase64(buffer) {
  const bytes = buffer instanceof Uint8Array ? buffer : new Uint8Array(buffer);
  if (typeof Buffer !== 'undefined') {
    return Buffer.from(bytes).toString('base64');
  }
  let binary = '';
  const len = bytes.byteLength;
  for (let i = 0; i < len; i++) {
    binary += String.fromCharCode(bytes[i]);
  }
  return window.btoa(binary);
}

/**
 * Converts Base64 string to Uint8Array.
 * Compatible across browser and Node.js runtimes.
 * @param {string} base64
 * @returns {Uint8Array}
 */
export function base64ToUint8Array(base64) {
  if (typeof Buffer !== 'undefined') {
    const buf = Buffer.from(base64, 'base64');
    return new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength);
  }
  const binaryString = window.atob(base64);
  const len = binaryString.length;
  const bytes = new Uint8Array(len);
  for (let i = 0; i < len; i++) {
    bytes[i] = binaryString.charCodeAt(i);
  }
  return bytes;
}

/**
 * Resolves subtle crypto object across browser and Node.js.
 * @returns {SubtleCrypto}
 */
function getSubtleCrypto() {
  if (typeof window !== 'undefined' && window.crypto && window.crypto.subtle) {
    return window.crypto.subtle;
  }
  if (typeof globalThis !== 'undefined' && globalThis.crypto && globalThis.crypto.subtle) {
    return globalThis.crypto.subtle;
  }
  throw new Error('Web Crypto subtle API is not supported in this environment.');
}

/**
 * Decrypts a binary data.enc payload using user-provided master passphrase.
 * 
 * @param {string} passphrase - User master passphrase
 * @param {ArrayBuffer|Uint8Array} wireData - Binary wire bytes
 * @returns {Promise<{ payload: object, rawKeyBase64: string }>}
 */
export async function decryptDashboardPayload(passphrase, wireData) {
  if (!passphrase || typeof passphrase !== 'string') {
    throw new Error('Master passphrase is required.');
  }

  const bytes = wireData instanceof Uint8Array ? wireData : new Uint8Array(wireData);

  // Wire format envelope validation: 16 (salt) + 12 (iv) + 16 (tag) = 44 bytes minimum
  if (bytes.length < 44) {
    throw new Error('Invalid payload: wire format must be at least 44 bytes.');
  }

  const subtle = getSubtleCrypto();

  // 1. Unpack slices from wire layout
  const salt = bytes.subarray(0, SALT_LENGTH);
  const iv = bytes.subarray(SALT_LENGTH, SALT_LENGTH + IV_LENGTH);
  const ciphertextAndTag = bytes.subarray(SALT_LENGTH + IV_LENGTH);

  // 2. Import raw passphrase as PBKDF2 base key
  const enc = new TextEncoder();
  const baseKey = await subtle.importKey(
    'raw',
    enc.encode(passphrase),
    { name: 'PBKDF2' },
    false,
    ['deriveKey']
  );

  // 3. Derive AES-256-GCM CryptoKey using 600,000 iterations
  const aesKey = await subtle.deriveKey(
    {
      name: 'PBKDF2',
      salt: salt,
      iterations: PBKDF2_ITERATIONS,
      hash: 'SHA-256'
    },
    baseKey,
    { name: 'AES-GCM', length: 256 },
    true, // extractable for session caching
    ['decrypt']
  );

  // 4. In-memory AES-GCM decryption & auth tag verification
  let decryptedBuffer;
  try {
    decryptedBuffer = await subtle.decrypt(
      {
        name: 'AES-GCM',
        iv: iv,
        tagLength: TAG_LENGTH_BITS
      },
      aesKey,
      ciphertextAndTag
    );
  } catch (err) {
    throw new Error('Authentication failed. Invalid passphrase or corrupted data.');
  }

  // 5. Decode UTF-8 and parse JSON rollup
  const dec = new TextDecoder('utf-8');
  const jsonText = dec.decode(decryptedBuffer);
  let payload;
  try {
    payload = JSON.parse(jsonText);
  } catch (err) {
    throw new Error('Authentication failed. Invalid passphrase or corrupted data.');
  }

  // 6. Export raw 32-byte key for sessionStorage caching
  const rawKeyBuffer = await subtle.exportKey('raw', aesKey);
  const rawKeyBase64 = arrayBufferToBase64(rawKeyBuffer);

  return { payload, rawKeyBase64 };
}

/**
 * Decrypts a binary data.enc payload using cached raw 32-byte key (sessionStorage reload bypass).
 * 
 * @param {string} rawKeyBase64 - Base64 encoded 32-byte AES key
 * @param {ArrayBuffer|Uint8Array} wireData - Binary wire bytes
 * @returns {Promise<object>} Decrypted payload JSON
 */
export async function decryptWithRawKey(rawKeyBase64, wireData) {
  if (!rawKeyBase64 || typeof rawKeyBase64 !== 'string') {
    throw new Error('Raw session key is required.');
  }

  const bytes = wireData instanceof Uint8Array ? wireData : new Uint8Array(wireData);
  if (bytes.length < 44) {
    throw new Error('Invalid payload: wire format must be at least 44 bytes.');
  }

  const subtle = getSubtleCrypto();
  const keyBytes = base64ToUint8Array(rawKeyBase64);

  const aesKey = await subtle.importKey(
    'raw',
    keyBytes,
    { name: 'AES-GCM' },
    false,
    ['decrypt']
  );

  const iv = bytes.subarray(SALT_LENGTH, SALT_LENGTH + IV_LENGTH);
  const ciphertextAndTag = bytes.subarray(SALT_LENGTH + IV_LENGTH);

  let decryptedBuffer;
  try {
    decryptedBuffer = await subtle.decrypt(
      {
        name: 'AES-GCM',
        iv: iv,
        tagLength: TAG_LENGTH_BITS
      },
      aesKey,
      ciphertextAndTag
    );
  } catch (err) {
    throw new Error('Authentication failed. Invalid passphrase or corrupted data.');
  }

  const dec = new TextDecoder('utf-8');
  const jsonText = dec.decode(decryptedBuffer);
  return JSON.parse(jsonText);
}
