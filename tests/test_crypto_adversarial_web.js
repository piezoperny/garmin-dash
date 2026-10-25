/**
 * tests/test_crypto_adversarial_web.js
 * 
 * Adversarial Challenger Web Crypto (crypto.subtle) Test Engine.
 * Provides bidirectional Web Crypto encryption, decryption, and tamper
 * stress-testing for extreme passphrases, null bytes, long strings,
 * multi-byte Unicode, and zero-byte boundaries.
 */

const assert = require('assert');

const PBKDF2_DEFAULT_ITERATIONS = 600000;
const SALT_SIZE = 16;
const IV_SIZE = 12;
const TAG_BITS = 128; // 16 bytes
const MIN_WIRE_SIZE = 44;

/**
 * Derives an AES-GCM 256-bit CryptoKey from passphrase using Web Crypto PBKDF2-HMAC-SHA256.
 */
async function deriveAesKey(passphrase, salt, iterations = PBKDF2_DEFAULT_ITERATIONS, keyUsages = ['decrypt']) {
  if (typeof passphrase !== 'string') {
    throw new TypeError(`Passphrase must be a string, got ${typeof passphrase}`);
  }
  if (!(salt instanceof Uint8Array) || salt.length !== SALT_SIZE) {
    throw new ValueError(`Salt must be a Uint8Array of exactly ${SALT_SIZE} bytes`);
  }

  const enc = new TextEncoder();
  const baseKey = await crypto.subtle.importKey(
    'raw',
    enc.encode(passphrase),
    { name: 'PBKDF2' },
    false,
    ['deriveKey']
  );

  return await crypto.subtle.deriveKey(
    {
      name: 'PBKDF2',
      salt: salt,
      iterations: iterations,
      hash: 'SHA-256'
    },
    baseKey,
    { name: 'AES-GCM', length: 256 },
    true, // extractable
    keyUsages
  );
}

/**
 * Decrypts a binary wire format payload using Web Crypto.
 * Wire layout: [16B Salt] + [12B IV] + [Ciphertext + 16B Tag]
 */
async function decryptPayload(passphrase, wireBuffer, iterations = PBKDF2_DEFAULT_ITERATIONS) {
  const bytes = wireBuffer instanceof Uint8Array ? wireBuffer : new Uint8Array(wireBuffer);

  if (bytes.length < MIN_WIRE_SIZE) {
    throw new Error(`Invalid wire format: payload is ${bytes.length} bytes, minimum required is ${MIN_WIRE_SIZE} bytes.`);
  }

  const salt = bytes.subarray(0, SALT_SIZE);
  const iv = bytes.subarray(SALT_SIZE, SALT_SIZE + IV_SIZE);
  const ciphertextAndTag = bytes.subarray(SALT_SIZE + IV_SIZE);

  const aesKey = await deriveAesKey(passphrase, salt, iterations, ['decrypt']);

  let decryptedBuffer;
  try {
    decryptedBuffer = await crypto.subtle.decrypt(
      {
        name: 'AES-GCM',
        iv: iv,
        tagLength: TAG_BITS
      },
      aesKey,
      ciphertextAndTag
    );
  } catch (err) {
    throw new Error(`AuthenticationError: AES-GCM tag verification failed (${err.name || err.message}).`);
  }

  return Buffer.from(decryptedBuffer);
}

/**
 * Encrypts data in Web Crypto producing the exact binary wire layout:
 * [16B Salt] + [12B IV] + [Ciphertext + 16B Tag]
 */
async function encryptPayload(passphrase, plaintext, iterations = PBKDF2_DEFAULT_ITERATIONS) {
  let plaintextBytes;
  if (typeof plaintext === 'string') {
    plaintextBytes = new TextEncoder().encode(plaintext);
  } else if (plaintext instanceof Uint8Array || Buffer.isBuffer(plaintext)) {
    plaintextBytes = new Uint8Array(plaintext);
  } else if (typeof plaintext === 'object' && plaintext !== null) {
    plaintextBytes = new TextEncoder().encode(JSON.stringify(plaintext));
  } else {
    throw new TypeError(`Unsupported plaintext type: ${typeof plaintext}`);
  }

  const salt = crypto.getRandomValues(new Uint8Array(SALT_SIZE));
  const iv = crypto.getRandomValues(new Uint8Array(IV_SIZE));

  const aesKey = await deriveAesKey(passphrase, salt, iterations, ['encrypt']);

  const ciphertextAndTag = await crypto.subtle.encrypt(
    {
      name: 'AES-GCM',
      iv: iv,
      tagLength: TAG_BITS
    },
    aesKey,
    plaintextBytes
  );

  return Buffer.concat([
    Buffer.from(salt),
    Buffer.from(iv),
    Buffer.from(ciphertextAndTag)
  ]);
}

/**
 * Export raw 32-byte key hex for KDF vector comparison.
 */
async function deriveRawKeyHex(passphrase, salt, iterations) {
  const aesKey = await deriveAesKey(passphrase, salt, iterations, ['decrypt']);
  const rawBuf = await crypto.subtle.exportKey('raw', aesKey);
  return Buffer.from(rawBuf).toString('hex');
}

// ----------------------------------------------------------------------------
// CLI Dispatcher (When executed directly by Python subprocess or terminal)
// ----------------------------------------------------------------------------

async function main() {
  const args = process.argv.slice(2);
  const command = args[0];

  if (!command) {
    // Run self-test suite
    console.log('Running Web Crypto Adversarial Self-Test Suite...');
    await runSelfTests();
    console.log('All Web Crypto Adversarial Self-Tests PASSED.');
    return;
  }

  if (command === 'decrypt') {
    // Read JSON input from stdin: { passphrase, wireHex, iterations }
    const inputChunks = [];
    for await (const chunk of process.stdin) {
      inputChunks.push(chunk);
    }
    const input = JSON.parse(Buffer.concat(inputChunks).toString('utf-8'));
    const wire = Buffer.from(input.wireHex, 'hex');
    const iterations = input.iterations || PBKDF2_DEFAULT_ITERATIONS;

    try {
      const decrypted = await decryptPayload(input.passphrase, wire, iterations);
      process.stdout.write(JSON.stringify({
        status: 'OK',
        decryptedUtf8: decrypted.toString('utf-8'),
        decryptedHex: decrypted.toString('hex')
      }));
    } catch (err) {
      process.stdout.write(JSON.stringify({
        status: 'ERROR',
        errorName: err.name,
        errorMessage: err.message
      }));
    }
  } else if (command === 'encrypt') {
    // Read JSON input from stdin: { passphrase, plaintextUtf8, plaintextHex, iterations }
    const inputChunks = [];
    for await (const chunk of process.stdin) {
      inputChunks.push(chunk);
    }
    const input = JSON.parse(Buffer.concat(inputChunks).toString('utf-8'));
    const plaintext = input.plaintextHex
      ? Buffer.from(input.plaintextHex, 'hex')
      : input.plaintextUtf8;
    const iterations = input.iterations || PBKDF2_DEFAULT_ITERATIONS;

    const wire = await encryptPayload(input.passphrase, plaintext, iterations);
    process.stdout.write(JSON.stringify({
      status: 'OK',
      wireHex: wire.toString('hex')
    }));
  } else if (command === 'derive_kdf') {
    // Read JSON input: { passphrase, saltHex, iterations }
    const inputChunks = [];
    for await (const chunk of process.stdin) {
      inputChunks.push(chunk);
    }
    const input = JSON.parse(Buffer.concat(inputChunks).toString('utf-8'));
    const salt = new Uint8Array(Buffer.from(input.saltHex, 'hex'));
    const keyHex = await deriveRawKeyHex(input.passphrase, salt, input.iterations);
    process.stdout.write(JSON.stringify({
      status: 'OK',
      keyHex: keyHex
    }));
  } else {
    throw new Error(`Unknown command: ${command}`);
  }
}

async function runSelfTests() {
  // Test 1: Empty passphrase
  const w1 = await encryptPayload('', 'Test empty pass', 1000);
  const d1 = await decryptPayload('', w1, 1000);
  assert.strictEqual(d1.toString('utf-8'), 'Test empty pass');

  // Test 2: 10,000 char passphrase
  const pLong = 'X'.repeat(10000);
  const w2 = await encryptPayload(pLong, 'Test long pass', 1000);
  const d2 = await decryptPayload(pLong, w2, 1000);
  assert.strictEqual(d2.toString('utf-8'), 'Test long pass');

  // Test 3: Japanese + Emojis
  const pJap = 'パスワード🔑🏃‍♂️東京2026';
  const w3 = await encryptPayload(pJap, 'Test unicode pass', 1000);
  const d3 = await decryptPayload(pJap, w3, 1000);
  assert.strictEqual(d3.toString('utf-8'), 'Test unicode pass');

  // Test 4: Rejection on wrong passphrase
  let rejected = false;
  try {
    await decryptPayload('wrong-pass', w3, 1000);
  } catch (e) {
    rejected = true;
  }
  assert.strictEqual(rejected, true, 'Wrong passphrase must be rejected');
}

if (require.main === module) {
  main().catch(err => {
    console.error('Fatal Web Crypto Challenger error:', err);
    process.exit(1);
  });
}

module.exports = {
  deriveAesKey,
  decryptPayload,
  encryptPayload,
  deriveRawKeyHex,
  PBKDF2_DEFAULT_ITERATIONS,
  SALT_SIZE,
  IV_SIZE,
  MIN_WIRE_SIZE
};
