/**
 * tests/test_opt_m5_worker_cache.js
 *
 * Milestone M5 Unit Tests:
 * - decryptWithRawKey / decryptPayloadWithKey with AAD (valid AAD succeeds, wrong AAD rejects)
 * - decryptRollupOffThread / decryptChunkOffThread transparent fallback in Node.js
 * - session.js saveSession() not writing large payload JSON to sessionStorage
 * - shard_cache.js graceful no-op when indexedDB is undefined + mock IDB LRU eviction
 * - handleLockVault() invoking cache clearers, worker termination, and IDB wipe
 */

const assert = require('assert');
const path = require('path');
const zlib = require('zlib');
const { pathToFileURL } = require('url');
const { webcrypto } = require('crypto');

if (typeof globalThis.crypto === 'undefined') {
  globalThis.crypto = webcrypto;
}

const rootDir = path.resolve(__dirname, '..');

async function encryptWithAesGcm({ payloadObj, rawKeyBytes, passphrase = null, aad = null, gzip = false }) {
  const salt = webcrypto.getRandomValues(new Uint8Array(16));
  const iv = webcrypto.getRandomValues(new Uint8Array(12));

  let aesKey;
  let exportedKeyBytes = rawKeyBytes;
  if (passphrase) {
    const baseKey = await webcrypto.subtle.importKey(
      'raw',
      new TextEncoder().encode(passphrase),
      { name: 'PBKDF2' },
      false,
      ['deriveKey']
    );
    aesKey = await webcrypto.subtle.deriveKey(
      { name: 'PBKDF2', salt, iterations: 600000, hash: 'SHA-256' },
      baseKey,
      { name: 'AES-GCM', length: 256 },
      true,
      ['encrypt', 'decrypt']
    );
    exportedKeyBytes = new Uint8Array(await webcrypto.subtle.exportKey('raw', aesKey));
  } else {
    aesKey = await webcrypto.subtle.importKey(
      'raw',
      rawKeyBytes,
      { name: 'AES-GCM' },
      false,
      ['encrypt', 'decrypt']
    );
  }

  let plaintext = Buffer.from(JSON.stringify(payloadObj), 'utf8');
  if (gzip) {
    plaintext = zlib.gzipSync(plaintext);
  }

  const params = { name: 'AES-GCM', iv, tagLength: 128 };
  if (aad !== null && aad !== undefined) {
    params.additionalData = typeof aad === 'string' ? new TextEncoder().encode(aad) : aad;
  }

  const ct = new Uint8Array(await webcrypto.subtle.encrypt(params, aesKey, plaintext));
  const wire = new Uint8Array(16 + 12 + ct.length);
  wire.set(salt, 0);
  wire.set(iv, 16);
  wire.set(ct, 28);

  return { wire, rawKeyBytes: exportedKeyBytes };
}

function createMockIndexedDB() {
  const databases = new Map();

  function makeReq(executor) {
    const req = {
      result: undefined,
      error: null,
      onsuccess: null,
      onerror: null,
      onupgradeneeded: null,
      onblocked: null
    };
    queueMicrotask(() => executor(req));
    return req;
  }

  return {
    _databases: databases,
    open(name, _version) {
      return makeReq((req) => {
        let isNew = false;
        let dbState = databases.get(name);
        if (!dbState) {
          isNew = true;
          dbState = { stores: new Map() };
          databases.set(name, dbState);
        }

        const db = {
          objectStoreNames: {
            contains: (storeName) => dbState.stores.has(storeName)
          },
          createObjectStore(storeName, { keyPath } = {}) {
            const storeMap = new Map();
            dbState.stores.set(storeName, { keyPath, map: storeMap });
            return {
              createIndex: () => {}
            };
          },
          transaction(storeName, _mode) {
            const tx = {
              oncomplete: null,
              onerror: null,
              onabort: null,
              objectStore() {
                const st = dbState.stores.get(storeName);
                return {
                  get(key) {
                    return makeReq((r) => {
                      r.result = st.map.has(key) ? structuredClone(st.map.get(key)) : undefined;
                      if (r.onsuccess) r.onsuccess({ target: r });
                    });
                  },
                  put(record) {
                    return makeReq((r) => {
                      st.map.set(record[st.keyPath], structuredClone(record));
                      r.result = record[st.keyPath];
                      if (r.onsuccess) r.onsuccess({ target: r });
                    });
                  },
                  getAll() {
                    return makeReq((r) => {
                      r.result = Array.from(st.map.values()).map((v) => structuredClone(v));
                      if (r.onsuccess) r.onsuccess({ target: r });
                    });
                  },
                  delete(key) {
                    return makeReq((r) => {
                      st.map.delete(key);
                      if (r.onsuccess) r.onsuccess({ target: r });
                    });
                  },
                  clear() {
                    return makeReq((r) => {
                      st.map.clear();
                      if (r.onsuccess) r.onsuccess({ target: r });
                    });
                  }
                };
              }
            };
            setTimeout(() => {
              if (tx.oncomplete) tx.oncomplete();
            }, 0);
            return tx;
          },
          close() {}
        };

        req.result = db;
        if (isNew && req.onupgradeneeded) {
          req.onupgradeneeded({ target: req });
        }
        if (req.onsuccess) req.onsuccess({ target: req });
      });
    }
  };
}

async function runTests() {
  process.stdout.write('\n=== Running M5 Worker, AAD, Session & IndexedDB Cache Tests ===\n\n');

  const cryptoMod = await import(pathToFileURL(path.join(rootDir, 'frontend/src/crypto.js')).href);
  const workerMod = await import(pathToFileURL(path.join(rootDir, 'frontend/src/crypto_worker.js')).href);
  const sessionMod = await import(pathToFileURL(path.join(rootDir, 'frontend/src/session.js')).href);
  const shardCacheMod = await import(pathToFileURL(path.join(rootDir, 'frontend/src/shard_cache.js')).href);

  let passed = 0;
  async function test(name, fn) {
    await fn();
    passed += 1;
    process.stdout.write(`  ✓ ${name}\n`);
  }

  // 1. decryptWithRawKey / decryptPayloadWithKey with AAD
  await test('T-M5-01: decryptWithRawKey & decryptPayloadWithKey succeed with valid AAD and reject wrong/missing AAD', async () => {
    const rawKey = webcrypto.getRandomValues(new Uint8Array(32));
    const rawKeyB64 = cryptoMod.arrayBufferToBase64(rawKey);
    const sample = { activity_id: 'act-42', hr: [120, 125, 130] };
    const aad = 'stream:act-42:v1';

    const { wire } = await encryptWithAesGcm({ payloadObj: sample, rawKeyBytes: rawKey, aad, gzip: true });

    const out1 = await cryptoMod.decryptWithRawKey(rawKeyB64, wire, { aad });
    assert.deepStrictEqual(out1, sample);

    const out2 = await cryptoMod.decryptPayloadWithKey(wire, rawKey, { aad: new TextEncoder().encode(aad) });
    assert.deepStrictEqual(out2, sample);

    await assert.rejects(
      () => cryptoMod.decryptWithRawKey(rawKeyB64, wire, { aad: 'stream:act-999:v1' }),
      /Authentication failed/
    );

    await assert.rejects(
      () => cryptoMod.decryptWithRawKey(rawKeyB64, wire),
      /Authentication failed/
    );

    // 2-arg backward compatibility without AAD
    const { wire: wireNoAad } = await encryptWithAesGcm({ payloadObj: sample, rawKeyBytes: rawKey });
    const outNoAad = await cryptoMod.decryptWithRawKey(rawKeyB64, wireNoAad);
    assert.deepStrictEqual(outNoAad, sample);
  });

  // 2. decryptRollupOffThread / decryptChunkOffThread fallback in Node + worker functions
  await test('T-M5-02: decryptRollupOffThread and decryptChunkOffThread fall back cleanly in Node.js', async () => {
    const passphrase = 'm5-worker-test-pass!';
    const rollup = { version: '2.0.0', activities: [{ id: '1', sport: 'running' }], aad_version: 1 };
    const { wire, rawKeyBytes } = await encryptWithAesGcm({ payloadObj: rollup, passphrase, gzip: true });

    const unlocked = await cryptoMod.decryptRollupOffThread(wire, passphrase);
    assert.deepStrictEqual(unlocked.payload, rollup);
    assert.strictEqual(unlocked.rawKeyBase64, cryptoMod.arrayBufferToBase64(rawKeyBytes));

    // Session-key reload mode
    const reloaded = await cryptoMod.decryptRollupOffThread(wire, { rawKeyBase64: unlocked.rawKeyBase64 });
    assert.deepStrictEqual(reloaded.payload, rollup);

    // Chunk decryption off-thread fallback with DEK + AAD
    const dek = webcrypto.getRandomValues(new Uint8Array(32));
    const chunkObj = { telemetry_stream: { time: [0, 1, 2], hr: [110, 112, 115] } };
    const aad = 'stream:1:v1';
    const { wire: chunkWire } = await encryptWithAesGcm({ payloadObj: chunkObj, rawKeyBytes: dek, aad, gzip: true });

    const decryptedChunk = await cryptoMod.decryptChunkOffThread(chunkWire, dek, { aad });
    assert.deepStrictEqual(decryptedChunk, chunkObj);

    // Direct worker module exports
    const workerRollup = await workerMod.deriveAndDecryptRollup(wire, passphrase);
    assert.deepStrictEqual(workerRollup.rollup, rollup);
    assert.strictEqual(workerRollup.rawKeyBytes.length, 32);

    const workerChunk = await workerMod.decryptStreamChunk(chunkWire, dek, aad);
    assert.deepStrictEqual(workerChunk, chunkObj);

    cryptoMod.terminateCryptoWorker();
  });

  // 3. session.js saveSession() not writing large payload JSON to sessionStorage
  await test('T-M5-03: session.js saveSession() stores only key + lightweight metadata, never large payload JSON', async () => {
    const store = new Map();
    const origWindow = global.window;
    global.window = {
      sessionStorage: {
        getItem: (k) => (store.has(k) ? store.get(k) : null),
        setItem: (k, v) => store.set(k, String(v)),
        removeItem: (k) => store.delete(k),
        clear: () => store.clear()
      }
    };

    try {
      const largePayload = {
        activities: Array.from({ length: 500 }, (_, i) => ({ id: i, name: 'Long Workout ' + 'x'.repeat(500) }))
      };
      sessionMod.saveSession('AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=', largePayload);

      assert.strictEqual(store.get('garmin_dash_session_key'), 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=');
      assert.strictEqual(store.has('garmin_vault_session'), false, 'garmin_vault_session must NOT be written');
      assert.strictEqual(sessionMod.getStoredPayload(), null);
      assert.strictEqual(sessionMod.hasActiveSession(), true);

      const metaRaw = store.get('garmin_dash_session_meta');
      assert.ok(metaRaw, 'Lightweight metadata should be stored');
      const meta = JSON.parse(metaRaw);
      assert.strictEqual(typeof meta.savedAt, 'number');

      sessionMod.clearSession();
      assert.strictEqual(store.size, 0);
      assert.strictEqual(sessionMod.hasActiveSession(), false);
    } finally {
      global.window = origWindow;
    }
  });

  // 4. shard_cache.js graceful no-op when indexedDB is undefined + mock IDB LRU eviction
  await test('T-M5-04: shard_cache.js no-ops when indexedDB is undefined and evicts LRU entries under mock IDB', async () => {
    const origIdb = globalThis.indexedDB;
    delete globalThis.indexedDB;

    try {
      assert.strictEqual(await shardCacheMod.getCachedChunk('2024:1:0:100'), null);
      await shardCacheMod.putCachedChunk('2024:1:0:100', { ok: true });
      await shardCacheMod.clearIndexedDbCache();
    } finally {
      if (origIdb !== undefined) globalThis.indexedDB = origIdb;
    }

    // Now test with mock IndexedDB
    globalThis.indexedDB = createMockIndexedDB();
    try {
      const k1 = shardCacheMod.makeChunkCacheKey('2024', '1', 0, 100);
      const k2 = shardCacheMod.makeChunkCacheKey('2024', '2', 100, 100);
      const k3 = shardCacheMod.makeChunkCacheKey('2024', '3', 200, 100);

      await shardCacheMod.putCachedChunk(k1, new Uint8Array(60), { maxEntries: 2, maxBytes: 1024 });
      await new Promise((r) => setTimeout(r, 5));
      await shardCacheMod.putCachedChunk(k2, new Uint8Array(60), { maxEntries: 2, maxBytes: 1024 });
      await new Promise((r) => setTimeout(r, 5));

      // Touch k1 so k2 becomes the LRU victim
      const got1 = await shardCacheMod.getCachedChunk(k1);
      assert.ok(got1 && got1.byteLength === 60, 'k1 must be retrieved');
      await new Promise((r) => setTimeout(r, 5));

      // Insert k3 with maxEntries=2 -> k2 should be evicted, k1 and k3 retained
      await shardCacheMod.putCachedChunk(k3, new Uint8Array(60), { maxEntries: 2, maxBytes: 1024 });
      assert.strictEqual(await shardCacheMod.getCachedChunk(k2), null, 'LRU victim k2 must be evicted');
      assert.ok(await shardCacheMod.getCachedChunk(k1), 'Recently accessed k1 must remain');
      assert.ok(await shardCacheMod.getCachedChunk(k3), 'Newly inserted k3 must remain');

      // Test byte cap eviction (maxBytes = 100, inserting 60B k4 evicts oldest)
      await shardCacheMod.putCachedChunk('2024:4:300:100', new Uint8Array(60), { maxEntries: 100, maxBytes: 100 });
      assert.strictEqual(await shardCacheMod.getCachedChunk(k1), null, 'Older k1 must be evicted by byte limit');
      assert.ok(await shardCacheMod.getCachedChunk('2024:4:300:100'), 'k4 must remain');

      await shardCacheMod.clearIndexedDbCache();
      assert.strictEqual(await shardCacheMod.getCachedChunk('2024:4:300:100'), null);
    } finally {
      if (origIdb !== undefined) globalThis.indexedDB = origIdb;
      else delete globalThis.indexedDB;
    }
  });

  // 5. handleLockVault() invoking cache clearers & wiping IndexedDB
  await test('T-M5-05: handleLockVault() clears session, chart caches, worker, and IndexedDB', async () => {
    const { createHeadlessEnv } = require('./e2e/test_dashboard_runner.js');
    const env = createHeadlessEnv();
    const mockIdb = createMockIndexedDB();
    const origIdb = globalThis.indexedDB;
    globalThis.indexedDB = mockIdb;

    try {
      await shardCacheMod.putCachedChunk('2024:99:0:50', { test: 1 });
      assert.ok(await shardCacheMod.getCachedChunk('2024:99:0:50'));

      env.sessionStorage.setItem('garmin_dash_session_key', 'TEST_KEY');
      const mainMod = await import(pathToFileURL(path.join(rootDir, 'frontend/src/main.js')).href);
      await mainMod.handleLockVault();

      assert.strictEqual(env.sessionStorage.getItem('garmin_dash_session_key'), null);
      assert.strictEqual(await shardCacheMod.getCachedChunk('2024:99:0:50'), null);
      assert.strictEqual(env.doc.getElementById('passphrase-modal').classList.contains('hidden'), false);
      assert.strictEqual(env.doc.getElementById('dashboard-content').classList.contains('hidden'), true);
    } finally {
      if (origIdb !== undefined) globalThis.indexedDB = origIdb;
      else delete globalThis.indexedDB;
    }
  });

  process.stdout.write(`\n=== M5 Worker & Cache Results: ${passed} passed, 0 failed ===\n\n`);
}

runTests().catch((err) => {
  process.stderr.write(`Test suite failed: ${err.stack || err.message}\n`);
  process.exit(1);
});
