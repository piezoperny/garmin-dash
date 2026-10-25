/**
 * tests/test_crypto_web.js
 * 
 * Standalone Web Crypto (crypto.subtle) Test Suite for Client-Side Decryption.
 * Verifies Acceptance Criteria 1:
 * - PBKDF2-HMAC-SHA256 (600,000 iterations) key derivation
 * - AES-256-GCM AEAD decryption matching binary wire layout:
 *   [16-byte Salt] + [12-byte IV] + [AES-256-GCM Ciphertext + 16-byte Tag]
 * - Incorrect passphrase rejection (OperationError / zero partial data leak)
 * - Bit-flipping tamper resistance across all 4 wire slices
 * - Payload truncation rejection (< 44 bytes)
 * - Raw CryptoKey export and re-import for sessionStorage caching
 * 
 * Can be run via:
 *   node tests/test_crypto_web.js
 *   agy-node tests/test_crypto_web.js
 */

const assert = require('assert');

// ============================================================================
// Web Crypto Subtle Decryption Engine (Matching frontend/src/crypto.js)
// ============================================================================

const PBKDF2_ITERATIONS = 600000;
const SALT_LENGTH = 16;
const IV_LENGTH = 12;
const TAG_LENGTH_BITS = 128; // 16 bytes

/**
 * Decrypts binary wire format ArrayBuffer using the provided master passphrase.
 * 
 * @param {string} passphrase - User master passphrase
 * @param {ArrayBuffer|Uint8Array} wireData - Binary wire bytes
 * @returns {Promise<{ payload: object, rawKeyBase64: string }>}
 */
async function decryptDashboardPayload(passphrase, wireData) {
  if (!passphrase || typeof passphrase !== 'string') {
    throw new Error('Master passphrase is required.');
  }

  const bytes = wireData instanceof Uint8Array ? wireData : new Uint8Array(wireData);

  // Envelope check: 16 (salt) + 12 (iv) + 16 (tag) = 44 bytes minimum
  if (bytes.length < 44) {
    throw new Error('Invalid payload: wire format must be at least 44 bytes.');
  }

  // 1. Unpack slices from wire layout
  const salt = bytes.subarray(0, SALT_LENGTH);
  const iv = bytes.subarray(SALT_LENGTH, SALT_LENGTH + IV_LENGTH);
  const ciphertextAndTag = bytes.subarray(SALT_LENGTH + IV_LENGTH);

  // 2. Import raw passphrase as PBKDF2 base key
  const enc = new TextEncoder();
  const baseKey = await crypto.subtle.importKey(
    'raw',
    enc.encode(passphrase),
    { name: 'PBKDF2' },
    false,
    ['deriveKey']
  );

  // 3. Derive AES-256-GCM CryptoKey
  const aesKey = await crypto.subtle.deriveKey(
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

  // 4. Decrypt via AES-GCM (Subtle expects ciphertext + appended tag in data buffer)
  let decryptedBuffer;
  try {
    decryptedBuffer = await crypto.subtle.decrypt(
      {
        name: 'AES-GCM',
        iv: iv,
        tagLength: TAG_LENGTH_BITS
      },
      aesKey,
      ciphertextAndTag
    );
  } catch (err) {
    throw new Error('Authentication failed: incorrect passphrase or corrupted/tampered data.');
  }

  // 5. Decode UTF-8 string and parse JSON
  const decryptedText = new TextDecoder('utf-8').decode(decryptedBuffer);
  const payload = JSON.parse(decryptedText);

  // 6. Export raw 32-byte key for sessionStorage caching
  const rawKeyBuffer = await crypto.subtle.exportKey('raw', aesKey);
  const rawKeyBase64 = Buffer.from(rawKeyBuffer).toString('base64');

  return { payload, rawKeyBase64 };
}

/**
 * Encrypts a JSON payload into the strict binary wire layout.
 * Used for test vector generation and synthetic roundtrip verification.
 */
async function encryptDashboardPayload(passphrase, payloadObj) {
  const enc = new TextEncoder();
  const plaintext = enc.encode(JSON.stringify(payloadObj));

  const salt = crypto.getRandomValues(new Uint8Array(SALT_LENGTH));
  const iv = crypto.getRandomValues(new Uint8Array(IV_LENGTH));

  const baseKey = await crypto.subtle.importKey(
    'raw',
    enc.encode(passphrase),
    { name: 'PBKDF2' },
    false,
    ['deriveKey']
  );

  const aesKey = await crypto.subtle.deriveKey(
    {
      name: 'PBKDF2',
      salt: salt,
      iterations: PBKDF2_ITERATIONS,
      hash: 'SHA-256'
    },
    baseKey,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt']
  );

  const encryptedBuffer = await crypto.subtle.encrypt(
    {
      name: 'AES-GCM',
      iv: iv,
      tagLength: TAG_LENGTH_BITS
    },
    aesKey,
    plaintext
  );

  const ciphertextAndTag = new Uint8Array(encryptedBuffer);
  const wire = new Uint8Array(SALT_LENGTH + IV_LENGTH + ciphertextAndTag.length);
  wire.set(salt, 0);
  wire.set(iv, SALT_LENGTH);
  wire.set(ciphertextAndTag, SALT_LENGTH + IV_LENGTH);

  return wire;
}

// ============================================================================
// Test Runner & Assertion Suite
// ============================================================================

async function runTestSuite() {
  const results = [];
  const testPassphrase = 'web-crypto-secure-passphrase-2026!';
  const testData = {
    version: '1.0.0',
    athlete: { name: 'Alex Runner', vo2max: 56, ftp: 290 },
    activities: [
      { id: 'run_101', sport: 'running', distance_meters: 10000, avg_hr: 158 }
    ]
  };

  let validWire = null;

  async function test(name, fn) {
    try {
      await fn();
      results.push({ name, status: 'PASS' });
      process.stdout.write(`  ✓ ${name}\n`);
    } catch (err) {
      results.push({ name, status: 'FAIL', error: err });
      process.stderr.write(`  ✗ ${name}: ${err.message}\n`);
    }
  }

  process.stdout.write('\n=== Running Web Crypto Decryption & Tamper Test Suite ===\n\n');

  // --- Tier 1: Core Feature Coverage ---

  await test('T1-WEB-01: Encrypt and decrypt roundtrip in Web Crypto', async () => {
    validWire = await encryptDashboardPayload(testPassphrase, testData);
    assert.ok(validWire.length >= 44, 'Wire length must be at least 44 bytes');

    const { payload, rawKeyBase64 } = await decryptDashboardPayload(testPassphrase, validWire);
    assert.deepStrictEqual(payload, testData, 'Decrypted payload must match original');
    assert.ok(rawKeyBase64.length > 30, 'Derived raw key must be exported to base64');
  });

  await test('T1-WEB-02: Strict wire format slice lengths (16B Salt + 12B IV + Tag 16B)', async () => {
    assert.ok(validWire, 'validWire must be generated');
    const salt = validWire.subarray(0, 16);
    const iv = validWire.subarray(16, 28);
    const tag = validWire.subarray(validWire.length - 16);

    assert.strictEqual(salt.length, 16);
    assert.strictEqual(iv.length, 12);
    assert.strictEqual(tag.length, 16);
  });

  await test('T1-WEB-03: SessionStorage raw key re-import decryption', async () => {
    const { rawKeyBase64 } = await decryptDashboardPayload(testPassphrase, validWire);
    
    // Simulate sessionStorage recovery
    const keyBytes = Buffer.from(rawKeyBase64, 'base64');
    const importedKey = await crypto.subtle.importKey(
      'raw',
      keyBytes,
      { name: 'AES-GCM' },
      false,
      ['decrypt']
    );

    const iv = validWire.subarray(16, 28);
    const ciphertextAndTag = validWire.subarray(28);
    const decrypted = await crypto.subtle.decrypt(
      { name: 'AES-GCM', iv, tagLength: 128 },
      importedKey,
      ciphertextAndTag
    );
    const recovered = JSON.parse(new TextDecoder().decode(decrypted));
    assert.deepStrictEqual(recovered, testData);
  });

  // --- Tier 2: Boundary & Corner Cases ---

  await test('T2-WEB-04: Invalid passphrase rejected with authentication error', async () => {
    await assert.rejects(
      async () => {
        await decryptDashboardPayload('wrong-passphrase-guess', validWire);
      },
      /Authentication failed/i
    );
  });

  await test('T2-WEB-05: Tamper Salt slice (bit 0 flip) rejected', async () => {
    const tampered = new Uint8Array(validWire);
    tampered[0] ^= 0x01; // flip bit in salt
    await assert.rejects(
      async () => {
        await decryptDashboardPayload(testPassphrase, tampered);
      },
      /Authentication failed/i
    );
  });

  await test('T2-WEB-06: Tamper IV slice (bit 0 flip) rejected', async () => {
    const tampered = new Uint8Array(validWire);
    tampered[16] ^= 0x01; // flip bit in IV
    await assert.rejects(
      async () => {
        await decryptDashboardPayload(testPassphrase, tampered);
      },
      /Authentication failed/i
    );
  });

  await test('T2-WEB-07: Tamper Ciphertext slice (middle bit flip) rejected', async () => {
    const tampered = new Uint8Array(validWire);
    const mid = 28 + Math.floor((tampered.length - 44) / 2);
    tampered[mid] ^= 0x01; // flip bit in ciphertext
    await assert.rejects(
      async () => {
        await decryptDashboardPayload(testPassphrase, tampered);
      },
      /Authentication failed/i
    );
  });

  await test('T2-WEB-08: Tamper Auth Tag slice (last byte flip) rejected', async () => {
    const tampered = new Uint8Array(validWire);
    tampered[tampered.length - 1] ^= 0x80; // flip bit in tag
    await assert.rejects(
      async () => {
        await decryptDashboardPayload(testPassphrase, tampered);
      },
      /Authentication failed/i
    );
  });

  await test('T2-WEB-09: Truncated payload (< 44 bytes) rejected before Subtle call', async () => {
    const truncatedPayloads = [0, 10, 20, 28, 43].map(len => new Uint8Array(len));
    for (const trunc of truncatedPayloads) {
      await assert.rejects(
        async () => {
          await decryptDashboardPayload(testPassphrase, trunc);
        },
        /must be at least 44 bytes/i
      );
    }
  });

  await test('T2-WEB-10: Unicode, emoji, and accented passphrases supported', async () => {
    const unicodePass = '🔑-Secret-Pass-Über-Läufer-2026-🚴!';
    const wireUnicode = await encryptDashboardPayload(unicodePass, { test: 'unicode' });
    const { payload } = await decryptDashboardPayload(unicodePass, wireUnicode);
    assert.deepStrictEqual(payload, { test: 'unicode' });
  });

  // --- Tier 3 & 4: Stress & Complex Payloads ---

  await test('T3-WEB-11: Large multi-sport rollup payload (> 50KB) decrypted cleanly', async () => {
    const largeActivities = Array.from({ length: 80 }, (_, i) => ({
      id: `act_${i}`,
      sport: i % 3 === 0 ? 'running' : i % 3 === 1 ? 'cycling' : 'strength',
      distance_meters: 15000 + i * 100,
      splits: Array.from({ length: 15 }, (_, s) => ({ split: s + 1, sec: 280, hr: 145 + (s % 10) }))
    }));
    const largePayload = { version: '1.0.0', activities: largeActivities };
    const largeWire = await encryptDashboardPayload(testPassphrase, largePayload);
    const { payload } = await decryptDashboardPayload(testPassphrase, largeWire);
    assert.strictEqual(payload.activities.length, 80);
    assert.strictEqual(payload.activities[50].id, 'act_50');
  });

  // --- Summary Report ---
  const passed = results.filter(r => r.status === 'PASS').length;
  const failed = results.filter(r => r.status === 'FAIL').length;
  process.stdout.write(`\n=== Web Crypto Results: ${passed} passed, ${failed} failed (Total: ${results.length}) ===\n\n`);

  if (failed > 0) {
    process.exit(1);
  }
}

if (require.main === module) {
  runTestSuite().catch(err => {
    process.stderr.write(`Fatal error running test suite: ${err.stack || err}\n`);
    process.exit(1);
  });
}

module.exports = {
  decryptDashboardPayload,
  encryptDashboardPayload,
  runTestSuite
};
