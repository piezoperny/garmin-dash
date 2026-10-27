/**
 * tests/test_frontend_modules.js
 * 
 * Verifies frontend/src modules (crypto.js, session.js) and dist/ DOM contract.
 */

const assert = require('assert');
const fs = require('fs');
const path = require('path');

async function runFrontendModuleTests() {
  process.stdout.write('\n=== Running Frontend Modules & DOM Contract Verification Suite ===\n\n');
  const results = [];

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

  // Dynamically import ES modules from frontend/src/crypto.js
  const cryptoModulePath = path.resolve(__dirname, '../frontend/src/crypto.js');
  const cryptoUrl = 'file:///' + cryptoModulePath.replace(/\\/g, '/');
  const cryptoModule = await import(cryptoUrl);

  // TC-01: Crypto functions exist and have correct signatures
  await test('TC-01: frontend/src/crypto.js exports required cryptographic primitives', async () => {
    assert.strictEqual(typeof cryptoModule.decryptDashboardPayload, 'function');
    assert.strictEqual(typeof cryptoModule.decryptWithRawKey, 'function');
    assert.strictEqual(typeof cryptoModule.arrayBufferToBase64, 'function');
    assert.strictEqual(typeof cryptoModule.base64ToUint8Array, 'function');
    assert.strictEqual(cryptoModule.PBKDF2_ITERATIONS, 600000);
    assert.strictEqual(cryptoModule.SALT_LENGTH, 16);
    assert.strictEqual(cryptoModule.IV_LENGTH, 12);
  });

  // TC-02: Decrypt actual dist/data.enc with demo passphrase
  await test('TC-02: frontend/src/crypto.js decrypts dist/data.enc successfully', async () => {
    const encPath = path.resolve(__dirname, '../dist/data.enc');
    assert.ok(fs.existsSync(encPath), 'dist/data.enc must exist');
    const encBuffer = fs.readFileSync(encPath);
    assert.ok(encBuffer.length >= 44, 'data.enc must be at least 44 bytes');

    const demoPassphrase = 'demo-passphrase-2026!';
    const { payload, rawKeyBase64 } = await cryptoModule.decryptDashboardPayload(demoPassphrase, encBuffer);
    assert.ok(payload);
    assert.strictEqual(payload.version, '1.0.0');
    assert.ok(Array.isArray(payload.activities));
    assert.strictEqual(payload.activities.length, 49);
    assert.ok(payload.athlete);
    assert.ok(payload.training_load);
    assert.ok(payload.physiological);
    assert.ok(rawKeyBase64 && rawKeyBase64.length > 30);

    // Also verify decryptWithRawKey (sessionStorage bypass)
    const bypassPayload = await cryptoModule.decryptWithRawKey(rawKeyBase64, encBuffer);
    assert.deepStrictEqual(bypassPayload, payload);
  });

  // TC-03: Invalid passphrase rejects
  await test('TC-03: frontend/src/crypto.js rejects invalid passphrase', async () => {
    const encPath = path.resolve(__dirname, '../dist/data.enc');
    const encBuffer = fs.readFileSync(encPath);
    await assert.rejects(
      async () => {
        await cryptoModule.decryptDashboardPayload('wrong-password-1234', encBuffer);
      },
      /Authentication failed/i
    );
  });

  // TC-04: Tampered ciphertext byte rejects
  await test('TC-04: frontend/src/crypto.js rejects tampered ciphertext byte', async () => {
    const encPath = path.resolve(__dirname, '../dist/data.enc');
    const encBuffer = Buffer.from(fs.readFileSync(encPath));
    encBuffer[30] ^= 0xff; // corrupt ciphertext byte

    await assert.rejects(
      async () => {
        await cryptoModule.decryptDashboardPayload('demo-passphrase-2026!', encBuffer);
      },
      /Authentication failed/i
    );
  });

  // TC-05: Truncated payload (<44 bytes) rejects before subtle
  await test('TC-05: frontend/src/crypto.js rejects truncated payload (<44 bytes)', async () => {
    const truncated = new Uint8Array(43);
    await assert.rejects(
      async () => {
        await cryptoModule.decryptDashboardPayload('demo-passphrase-2026!', truncated);
      },
      /wire format must be at least 44 bytes/i
    );
  });

  // TC-06: DOM Contract Verification for dist/index.html
  await test('TC-06: dist/index.html contains all required E2E IDs and attributes', async () => {
    const indexPath = path.resolve(__dirname, '../dist/index.html');
    assert.ok(fs.existsSync(indexPath), 'dist/index.html must exist');
    const html = fs.readFileSync(indexPath, 'utf-8');

    const requiredIDs = [
      'passphrase-modal',
      'passphrase-input',
      'passphrase-submit',
      'auth-error-message',
      'dashboard-content',
      'weekly-volume-chart',
      'training-load-chart',
      'kpi-total-distance',
      'kpi-total-time',
      'kpi-weekly-load',
      'kpi-status',
      'hr-zone-chart',
      'power-zone-chart',
      'pace-zone-chart',
      'threshold-trends-chart',
      'activity-table',
      'btn-lock-dashboard',
      'filter-btn-running',
      'activity-drawer'
    ];

    for (const id of requiredIDs) {
      assert.ok(
        html.includes(`id="${id}"`),
        `dist/index.html missing required element id="${id}"`
      );
    }

    // Verify initial locked attributes
    assert.ok(html.includes('id="dashboard-content" class="hidden'), 'dashboard-content must have class="hidden" initially');
    assert.ok(html.includes('aria-hidden="true"'), 'dashboard-content must have aria-hidden="true" initially');

    // Verify all relative stylesheet and script asset links resolve to existing files
    assert.ok(!html.includes('./src/'), 'dist/index.html must not contain un-transformed ./src/ links');
    assert.ok(html.includes('href="./assets/style.css"'), 'dist/index.html must link to ./assets/style.css');
    assert.ok(fs.existsSync(path.resolve(__dirname, '../dist/assets/style.css')), 'dist/assets/style.css must exist on disk');
    assert.ok(html.includes('src="./assets/main.js"'), 'dist/index.html must link to ./assets/main.js');
    assert.ok(fs.existsSync(path.resolve(__dirname, '../dist/assets/main.js')), 'dist/assets/main.js must exist on disk');
  });

  const passed = results.filter(r => r.status === 'PASS').length;
  const failed = results.filter(r => r.status === 'FAIL').length;
  process.stdout.write(`\n=== Frontend Modules Results: ${passed} passed, ${failed} failed (Total: ${results.length}) ===\n\n`);

  if (failed > 0) {
    process.exit(1);
  }
}

if (require.main === module) {
  runFrontendModuleTests().catch(err => {
    process.stderr.write(`Fatal error: ${err.stack || err}\n`);
    process.exit(1);
  });
}

module.exports = { runFrontendModuleTests };
