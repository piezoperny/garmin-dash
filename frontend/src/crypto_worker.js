/**
 * frontend/src/crypto_worker.js
 *
 * Dedicated ES module Web Worker for off-thread PBKDF2 key derivation,
 * AES-256-GCM decryption, and backpressure-safe gzip decompression.
 */

const PBKDF2_ITERATIONS = 600000;
const SALT_LENGTH = 16;
const IV_LENGTH = 12;
const TAG_LENGTH_BITS = 128;

function getWorkerSubtle() {
  if (typeof self !== 'undefined' && self.crypto && self.crypto.subtle) {
    return self.crypto.subtle;
  }
  if (typeof globalThis !== 'undefined' && globalThis.crypto && globalThis.crypto.subtle) {
    return globalThis.crypto.subtle;
  }
  throw new Error('Web Crypto subtle API is not supported in this worker.');
}

function toUint8Array(bufOrView) {
  if (bufOrView instanceof Uint8Array) return bufOrView;
  if (bufOrView instanceof ArrayBuffer) return new Uint8Array(bufOrView);
  if (ArrayBuffer.isView(bufOrView)) {
    return new Uint8Array(bufOrView.buffer, bufOrView.byteOffset, bufOrView.byteLength);
  }
  throw new Error('Expected ArrayBuffer or TypedArray.');
}

function base64ToBytes(base64) {
  if (typeof Buffer !== 'undefined') {
    const buf = Buffer.from(base64, 'base64');
    return new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength);
  }
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
}

function normalizeAad(aad) {
  if (aad === null || aad === undefined) return null;
  if (typeof aad === 'string') {
    return new TextEncoder().encode(aad);
  }
  return toUint8Array(aad);
}

/**
 * Backpressure-safe DecompressionStream('gzip') reader loop.
 * Drains readable concurrently while writing to writable so multi-MB payloads never deadlock.
 * @param {Uint8Array} rawBytes
 * @returns {Promise<Uint8Array>}
 */
async function gunzipBytes(rawBytes) {
  if (typeof DecompressionStream !== 'undefined') {
    const ds = new DecompressionStream('gzip');
    const reader = ds.readable.getReader();
    const writer = ds.writable.getWriter();

    const readAll = async () => {
      const chunks = [];
      let totalLength = 0;
      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        if (value && value.byteLength > 0) {
          chunks.push(value);
          totalLength += value.byteLength;
        }
      }
      const out = new Uint8Array(totalLength);
      let offset = 0;
      for (const chunk of chunks) {
        out.set(chunk, offset);
        offset += chunk.byteLength;
      }
      return out;
    };

    const writeAll = async () => {
      await writer.write(rawBytes);
      await writer.close();
    };

    const [plainBytes] = await Promise.all([readAll(), writeAll()]);
    return plainBytes;
  }

  if (typeof process !== 'undefined' && process.versions?.node) {
    const zlib = await import('node:zlib');
    return new Uint8Array(zlib.gunzipSync(rawBytes));
  }

  throw new Error('Gzip decompression is not supported in this browser.');
}

async function decodeMaybeGzipJson(decryptedBuffer) {
  const rawBytes = toUint8Array(decryptedBuffer);
  let plainBytes = rawBytes;

  if (rawBytes.length >= 2 && rawBytes[0] === 0x1f && rawBytes[1] === 0x8b) {
    plainBytes = await gunzipBytes(rawBytes);
  }

  const jsonText = new TextDecoder('utf-8').decode(plainBytes);
  return JSON.parse(jsonText);
}

/**
 * Derives AES-256-GCM key via PBKDF2-HMAC-SHA256 (600,000 iterations) and decrypts rollup.
 * @param {ArrayBuffer|Uint8Array} encryptedBuffer
 * @param {string} passphrase
 * @returns {Promise<{ rollup: object, rawKeyBytes: Uint8Array }>}
 */
export async function deriveAndDecryptRollup(encryptedBuffer, passphrase) {
  if (!passphrase || typeof passphrase !== 'string') {
    throw new Error('Master passphrase is required.');
  }
  const bytes = toUint8Array(encryptedBuffer);
  if (bytes.length < 44) {
    throw new Error('Invalid payload: wire format must be at least 44 bytes.');
  }

  const subtle = getWorkerSubtle();
  const salt = bytes.subarray(0, SALT_LENGTH);
  const iv = bytes.subarray(SALT_LENGTH, SALT_LENGTH + IV_LENGTH);
  const ciphertextAndTag = bytes.subarray(SALT_LENGTH + IV_LENGTH);

  const baseKey = await subtle.importKey(
    'raw',
    new TextEncoder().encode(passphrase),
    { name: 'PBKDF2' },
    false,
    ['deriveKey']
  );

  const aesKey = await subtle.deriveKey(
    {
      name: 'PBKDF2',
      salt,
      iterations: PBKDF2_ITERATIONS,
      hash: 'SHA-256'
    },
    baseKey,
    { name: 'AES-GCM', length: 256 },
    true,
    ['decrypt']
  );

  let decryptedBuffer;
  try {
    decryptedBuffer = await subtle.decrypt(
      {
        name: 'AES-GCM',
        iv,
        tagLength: TAG_LENGTH_BITS
      },
      aesKey,
      ciphertextAndTag
    );
  } catch (_err) {
    throw new Error('Authentication failed. Invalid passphrase or corrupted data.');
  }

  let rollup;
  try {
    rollup = await decodeMaybeGzipJson(decryptedBuffer);
  } catch (_err) {
    throw new Error('Authentication failed. Invalid passphrase or corrupted data.');
  }

  const rawKeyBuffer = await subtle.exportKey('raw', aesKey);
  const rawKeyBytes = new Uint8Array(rawKeyBuffer);
  return { rollup, rawKeyBytes };
}

/**
 * Decrypts a stream chunk or raw-key payload using AES-256-GCM and optional AAD.
 * @param {ArrayBuffer|Uint8Array} encryptedBuffer
 * @param {Uint8Array|ArrayBuffer|string} rawKeyBytes
 * @param {Uint8Array|ArrayBuffer|string|null} [aad]
 * @returns {Promise<object>}
 */
export async function decryptStreamChunk(encryptedBuffer, rawKeyBytes, aad = null) {
  if (!rawKeyBytes) {
    throw new Error('Raw session key is required.');
  }
  const bytes = toUint8Array(encryptedBuffer);
  if (bytes.length < 44) {
    throw new Error('Invalid payload: wire format must be at least 44 bytes.');
  }

  const keyBytes = typeof rawKeyBytes === 'string'
    ? base64ToBytes(rawKeyBytes)
    : toUint8Array(rawKeyBytes);

  const subtle = getWorkerSubtle();
  const aesKey = await subtle.importKey(
    'raw',
    keyBytes,
    { name: 'AES-GCM' },
    false,
    ['decrypt']
  );

  const iv = bytes.subarray(SALT_LENGTH, SALT_LENGTH + IV_LENGTH);
  const ciphertextAndTag = bytes.subarray(SALT_LENGTH + IV_LENGTH);
  const aadBytes = normalizeAad(aad);

  const decryptParams = {
    name: 'AES-GCM',
    iv,
    tagLength: TAG_LENGTH_BITS
  };
  if (aadBytes) {
    decryptParams.additionalData = aadBytes;
  }

  let decryptedBuffer;
  try {
    decryptedBuffer = await subtle.decrypt(decryptParams, aesKey, ciphertextAndTag);
  } catch (_err) {
    throw new Error('Authentication failed. Invalid passphrase or corrupted data.');
  }

  return await decodeMaybeGzipJson(decryptedBuffer);
}

if (typeof self !== 'undefined' && typeof self.addEventListener === 'function') {
  self.addEventListener('message', async (event) => {
    const msg = event?.data;
    if (!msg || typeof msg !== 'object') return;
    const { id, type } = msg;

    try {
      if (type === 'deriveAndDecryptRollup') {
        const result = await deriveAndDecryptRollup(msg.encryptedBuffer, msg.passphrase);
        self.postMessage({ id, ok: true, result }, [result.rawKeyBytes.buffer]);
        return;
      }

      if (type === 'decryptStreamChunk') {
        const result = await decryptStreamChunk(msg.encryptedBuffer, msg.rawKeyBytes, msg.aad);
        self.postMessage({ id, ok: true, result });
        return;
      }

      self.postMessage({ id, ok: false, error: `Unknown worker message type: ${type}` });
    } catch (err) {
      self.postMessage({
        id,
        ok: false,
        error: err?.message || 'Worker decryption failed.'
      });
    }
  });
}
