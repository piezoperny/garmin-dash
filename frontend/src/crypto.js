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
 * Decodes decrypted bytes (auto-detecting Gzip magic header 0x1f 0x8b) and parses JSON.
 * @param {ArrayBuffer|Uint8Array} decryptedBuffer
 * @returns {Promise<object>}
 */
export async function decodeMaybeGzipJson(decryptedBuffer) {
  const rawBytes = decryptedBuffer instanceof Uint8Array ? decryptedBuffer : new Uint8Array(decryptedBuffer);
  let plainBytes = rawBytes;

  if (rawBytes.length >= 2 && rawBytes[0] === 0x1f && rawBytes[1] === 0x8b) {
    if (typeof DecompressionStream !== 'undefined') {
      const ds = new DecompressionStream('gzip');
      const readPromise = new Response(ds.readable).arrayBuffer();
      const writer = ds.writable.getWriter();
      const writePromise = writer.write(rawBytes).then(() => writer.close());
      const [outBuf] = await Promise.all([readPromise, writePromise]);
      plainBytes = new Uint8Array(outBuf);
    } else if (typeof process !== 'undefined' && process.versions?.node) {
      const zlib = await import('node:zlib');
      plainBytes = new Uint8Array(zlib.gunzipSync(rawBytes));
    } else {
      throw new Error('Gzip decompression is not supported in this browser.');
    }
  }

  const dec = new TextDecoder('utf-8');
  const jsonText = dec.decode(plainBytes);
  return JSON.parse(jsonText);
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

  // 5. Decompress (if gzip) & parse JSON rollup
  let payload;
  try {
    payload = await decodeMaybeGzipJson(decryptedBuffer);
  } catch (err) {
    throw new Error('Authentication failed. Invalid passphrase or corrupted data.');
  }

  // 6. Export raw 32-byte key for sessionStorage caching
  const rawKeyBuffer = await subtle.exportKey('raw', aesKey);
  const rawKeyBase64 = arrayBufferToBase64(rawKeyBuffer);

  return { payload, rawKeyBase64 };
}

function toUint8Array(bufOrView) {
  if (bufOrView instanceof Uint8Array) return bufOrView;
  if (bufOrView instanceof ArrayBuffer) return new Uint8Array(bufOrView);
  if (ArrayBuffer.isView(bufOrView)) {
    return new Uint8Array(bufOrView.buffer, bufOrView.byteOffset, bufOrView.byteLength);
  }
  throw new Error('Expected ArrayBuffer or TypedArray.');
}

function resolveKeyBytes(keyInput) {
  if (!keyInput) {
    throw new Error('Raw session key is required.');
  }
  if (typeof keyInput === 'string') {
    return base64ToUint8Array(keyInput);
  }
  return toUint8Array(keyInput);
}

function normalizeAad(aad) {
  if (aad === null || aad === undefined) return null;
  if (typeof aad === 'string') {
    return new TextEncoder().encode(aad);
  }
  return toUint8Array(aad);
}

/**
 * Decrypts a binary data.enc or stream chunk payload using a raw 32-byte key.
 * Preserves 2-arg backward compatibility: decryptWithRawKey(rawKeyBase64, wireData).
 *
 * @param {string|Uint8Array|ArrayBuffer} rawKeyBase64 - Base64 encoded or raw 32-byte AES key
 * @param {ArrayBuffer|Uint8Array} wireData - Binary wire bytes
 * @param {{ aad?: Uint8Array|ArrayBuffer|string|null, dek?: string|Uint8Array|ArrayBuffer|null }|null} [options]
 * @returns {Promise<object>} Decrypted payload JSON
 */
export async function decryptWithRawKey(rawKeyBase64, wireData, options = null) {
  const effectiveKey = options?.dek ?? rawKeyBase64;
  if (!effectiveKey) {
    throw new Error('Raw session key is required.');
  }

  const bytes = wireData instanceof Uint8Array ? wireData : new Uint8Array(wireData);
  if (bytes.length < 44) {
    throw new Error('Invalid payload: wire format must be at least 44 bytes.');
  }

  const subtle = getSubtleCrypto();
  const keyBytes = resolveKeyBytes(effectiveKey);

  const aesKey = await subtle.importKey(
    'raw',
    keyBytes,
    { name: 'AES-GCM' },
    false,
    ['decrypt']
  );

  const iv = bytes.subarray(SALT_LENGTH, SALT_LENGTH + IV_LENGTH);
  const ciphertextAndTag = bytes.subarray(SALT_LENGTH + IV_LENGTH);
  const aadBytes = normalizeAad(options?.aad);

  const decryptParams = {
    name: 'AES-GCM',
    iv: iv,
    tagLength: TAG_LENGTH_BITS
  };
  if (aadBytes) {
    decryptParams.additionalData = aadBytes;
  }

  let decryptedBuffer;
  try {
    decryptedBuffer = await subtle.decrypt(
      decryptParams,
      aesKey,
      ciphertextAndTag
    );
  } catch (err) {
    throw new Error('Authentication failed. Invalid passphrase or corrupted data.');
  }

  return await decodeMaybeGzipJson(decryptedBuffer);
}

/**
 * Alias matching (buffer, rawKeyBytes, options) parameter order.
 * @param {ArrayBuffer|Uint8Array} buffer
 * @param {string|Uint8Array|ArrayBuffer} rawKeyBytes
 * @param {{ aad?: Uint8Array|ArrayBuffer|string|null, dek?: string|Uint8Array|ArrayBuffer|null }|null} [options]
 * @returns {Promise<object>}
 */
export async function decryptPayloadWithKey(buffer, rawKeyBytes, options = null) {
  return decryptWithRawKey(rawKeyBytes, buffer, options);
}

// ============================================================================
// Web Worker Off-Thread Crypto Bridge (with transparent main-thread fallback)
// ============================================================================

let cryptoWorker = null;
let cryptoWorkerFailed = false;
let workerRequestSeq = 0;
const pendingWorkerRequests = new Map();

class WorkerInitError extends Error {
  constructor(message) {
    super(message);
    this.name = 'WorkerInitError';
  }
}

function canUseCryptoWorker() {
  return (
    !cryptoWorkerFailed &&
    typeof Worker !== 'undefined' &&
    typeof window !== 'undefined'
  );
}

function rejectAllPendingWorkerRequests(reason) {
  for (const [, pending] of pendingWorkerRequests) {
    pending.reject(reason);
  }
  pendingWorkerRequests.clear();
}

function getOrCreateCryptoWorker() {
  if (!canUseCryptoWorker()) {
    throw new WorkerInitError('Web Worker unavailable in this environment.');
  }
  if (cryptoWorker) return cryptoWorker;

  try {
    const workerUrl = new URL('./crypto_worker.js', import.meta.url);
    const worker = new Worker(workerUrl, { type: 'module' });

    worker.addEventListener('message', (event) => {
      const msg = event?.data;
      if (!msg || typeof msg !== 'object') return;
      const pending = pendingWorkerRequests.get(msg.id);
      if (!pending) return;
      pendingWorkerRequests.delete(msg.id);
      if (msg.ok) {
        pending.resolve(msg.result);
      } else {
        pending.reject(new Error(msg.error || 'Worker decryption failed.'));
      }
    });

    worker.addEventListener('error', (err) => {
      cryptoWorkerFailed = true;
      cryptoWorker = null;
      rejectAllPendingWorkerRequests(
        new WorkerInitError(err?.message || 'Crypto worker failed to initialize.')
      );
    });

    cryptoWorker = worker;
    return cryptoWorker;
  } catch (err) {
    cryptoWorkerFailed = true;
    throw new WorkerInitError(err?.message || 'Crypto worker initialization failed.');
  }
}

function callCryptoWorker(payload, transferList = []) {
  const worker = getOrCreateCryptoWorker();
  const id = ++workerRequestSeq;
  return new Promise((resolve, reject) => {
    pendingWorkerRequests.set(id, { resolve, reject });
    try {
      worker.postMessage({ id, ...payload }, transferList);
    } catch (err) {
      pendingWorkerRequests.delete(id);
      reject(new WorkerInitError(err?.message || 'Failed to post message to crypto worker.'));
    }
  });
}

/**
 * Terminates the active crypto Web Worker (called on Lock Vault).
 */
export function terminateCryptoWorker() {
  if (cryptoWorker) {
    try {
      cryptoWorker.terminate();
    } catch {
      // ignore
    }
    cryptoWorker = null;
  }
  cryptoWorkerFailed = false;
  rejectAllPendingWorkerRequests(new Error('Crypto worker terminated.'));
}

/**
 * Decrypts the dashboard rollup off-thread in crypto_worker.js when Worker is available,
 * falling back transparently to main-thread SubtleCrypto in Node.js or if Worker init fails.
 *
 * Supports both initial passphrase unlock:
 *   decryptRollupOffThread(encryptedBuffer, passphrase)
 * and cached raw-key reload:
 *   decryptRollupOffThread(encryptedBuffer, { rawKeyBase64 })
 *
 * @param {ArrayBuffer|Uint8Array} encryptedBuffer
 * @param {string|{ rawKeyBase64?: string, rawKeyBytes?: Uint8Array|ArrayBuffer }} passphraseOrOptions
 * @returns {Promise<{ payload: object, rawKeyBase64: string }>}
 */
export async function decryptRollupOffThread(encryptedBuffer, passphraseOrOptions) {
  const isRawKeyMode =
    passphraseOrOptions &&
    typeof passphraseOrOptions === 'object' &&
    (passphraseOrOptions.rawKeyBase64 || passphraseOrOptions.rawKeyBytes);

  if (isRawKeyMode) {
    const rawKeyInput = passphraseOrOptions.rawKeyBase64 || passphraseOrOptions.rawKeyBytes;
    const rawKeyBase64 = typeof rawKeyInput === 'string'
      ? rawKeyInput
      : arrayBufferToBase64(rawKeyInput);

    if (canUseCryptoWorker()) {
      try {
        const bytesCopy = toUint8Array(encryptedBuffer).slice();
        const keyBytes = resolveKeyBytes(rawKeyInput).slice();
        const payload = await callCryptoWorker(
          {
            type: 'decryptStreamChunk',
            encryptedBuffer: bytesCopy.buffer,
            rawKeyBytes: keyBytes.buffer,
            aad: null
          },
          [bytesCopy.buffer, keyBytes.buffer]
        );
        return { payload, rawKeyBase64 };
      } catch (err) {
        if (!(err instanceof WorkerInitError)) throw err;
      }
    }

    const payload = await decryptWithRawKey(rawKeyInput, encryptedBuffer);
    return { payload, rawKeyBase64 };
  }

  const passphrase = passphraseOrOptions;
  if (canUseCryptoWorker()) {
    try {
      const bytesCopy = toUint8Array(encryptedBuffer).slice();
      const { rollup, rawKeyBytes } = await callCryptoWorker(
        {
          type: 'deriveAndDecryptRollup',
          encryptedBuffer: bytesCopy.buffer,
          passphrase
        },
        [bytesCopy.buffer]
      );
      return {
        payload: rollup,
        rawKeyBase64: arrayBufferToBase64(rawKeyBytes)
      };
    } catch (err) {
      if (!(err instanceof WorkerInitError)) throw err;
    }
  }

  return await decryptDashboardPayload(passphrase, encryptedBuffer);
}

/**
 * Decrypts a stream chunk off-thread in crypto_worker.js when Worker is available,
 * falling back transparently to main-thread decryptWithRawKey().
 *
 * @param {ArrayBuffer|Uint8Array} encryptedBuffer
 * @param {string|Uint8Array|ArrayBuffer} rawKeyBytes
 * @param {{ aad?: Uint8Array|ArrayBuffer|string|null, dek?: string|Uint8Array|ArrayBuffer|null }|null} [options]
 * @returns {Promise<object>}
 */
export async function decryptChunkOffThread(encryptedBuffer, rawKeyBytes, options = null) {
  const effectiveKey = options?.dek ?? rawKeyBytes;
  if (canUseCryptoWorker()) {
    try {
      const bytesCopy = toUint8Array(encryptedBuffer).slice();
      const keyBytes = resolveKeyBytes(effectiveKey).slice();
      return await callCryptoWorker(
        {
          type: 'decryptStreamChunk',
          encryptedBuffer: bytesCopy.buffer,
          rawKeyBytes: keyBytes.buffer,
          aad: options?.aad ?? null
        },
        [bytesCopy.buffer, keyBytes.buffer]
      );
    } catch (err) {
      if (!(err instanceof WorkerInitError)) throw err;
    }
  }

  return await decryptWithRawKey(rawKeyBytes, encryptedBuffer, options);
}
