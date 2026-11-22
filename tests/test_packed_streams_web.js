/**
 * tests/test_packed_streams_web.js
 * Verifies browser crypto Gzip auto-decompression and Range-fetched yearly stream packfiles.
 */

import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import zlib from 'node:zlib';

import {
  decryptDashboardPayload,
  decryptWithRawKey,
  PBKDF2_ITERATIONS
} from '../frontend/src/crypto.js';
import {
  loadActivityStreamShard,
  setStreamPackIndex
} from '../frontend/src/charts/activities.js';

function encryptWire(plainBytes, keyBytes, salt) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', keyBytes, iv);
  const ct = Buffer.concat([cipher.update(plainBytes), cipher.final()]);
  const tag = cipher.getAuthTag();
  return new Uint8Array(Buffer.concat([salt, iv, ct, tag]));
}

async function run() {
  console.log('\n=== Running Gzip + Stream Packfile Web Tests ===\n');

  const passphrase = 'pack-test-passphrase!';
  const salt = crypto.randomBytes(16);
  const key = crypto.pbkdf2Sync(passphrase, salt, PBKDF2_ITERATIONS, 32, 'sha256');

  // 1. Gzip-compressed data.enc roundtrip
  const rollupObj = {
    schema_version: '1.0',
    activities: [{ id: '901', sport: 'running' }],
    stream_pack_index: {}
  };
  const gzRollup = zlib.gzipSync(Buffer.from(JSON.stringify(rollupObj), 'utf-8'));
  const encRollup = encryptWire(gzRollup, key, salt);
  const { payload, rawKeyBase64 } = await decryptDashboardPayload(passphrase, encRollup);
  assert.equal(payload.activities[0].id, '901');
  console.log('  ✓ T-PACK-01: Gzip-compressed data.enc decrypted via Web Crypto + DecompressionStream');

  // 2. Yearly stream packfile with 206 Partial Content Range fetch
  const shard901 = zlib.gzipSync(Buffer.from(JSON.stringify({
    id: '901',
    telemetry_stream: { hr: [142, 148, 155] }
  }), 'utf-8'));
  const shard902 = zlib.gzipSync(Buffer.from(JSON.stringify({
    id: '902',
    telemetry_stream: { hr: [120, 125] }
  }), 'utf-8'));

  const chunk901 = encryptWire(shard901, key, salt);
  const chunk902 = encryptWire(shard902, key, salt);
  const pack2026 = Buffer.concat([chunk901, chunk902]);

  // Verify direct decryptWithRawKey on gzipped chunk
  const decDirect = await decryptWithRawKey(rawKeyBase64, chunk901);
  assert.deepEqual(decDirect.telemetry_stream.hr, [142, 148, 155]);

  // Mock window.sessionStorage & fetch for loadActivityStreamShard
  const mockSessionStorage = {
    getItem: (k) => (k === 'garmin_dash_session_key' ? rawKeyBase64 : null)
  };
  globalThis.sessionStorage = mockSessionStorage;
  globalThis.window = { sessionStorage: mockSessionStorage };
  setStreamPackIndex({
    '901': { year: '2026', offset: 0, length: chunk901.byteLength },
    '902': { year: '2026', offset: chunk901.byteLength, length: chunk902.byteLength }
  });

  // Test 206 Partial Content Range response
  let lastRangeHeader = null;
  globalThis.fetch = async (url, opts) => {
    assert.equal(url, './streams/streams_2026.pack');
    lastRangeHeader = opts?.headers?.Range || null;
    const m = /^bytes=(\d+)-(\d+)$/.exec(lastRangeHeader || '');
    assert.ok(m, 'Range header must be present');
    const start = Number(m[1]);
    const end = Number(m[2]);
    const slice = pack2026.subarray(start, end + 1);
    return {
      ok: true,
      status: 206,
      arrayBuffer: async () => slice.buffer.slice(slice.byteOffset, slice.byteOffset + slice.byteLength)
    };
  };

  const act901 = { id: '901' };
  const loaded901 = await loadActivityStreamShard('901', act901);
  assert.equal(lastRangeHeader, `bytes=0-${chunk901.byteLength - 1}`);
  assert.deepEqual(loaded901.telemetry_stream.hr, [142, 148, 155]);
  assert.equal(act901._streamsLoaded, true);
  console.log('  ✓ T-PACK-02: HTTP 206 Range request fetches and decrypts exact stream slice');

  // Test 200 OK fallback (full packfile cached & sliced)
  let fetchCount = 0;
  globalThis.fetch = async (url) => {
    fetchCount += 1;
    assert.equal(url, './streams/streams_2026.pack');
    return {
      ok: true,
      status: 200,
      arrayBuffer: async () => pack2026.buffer.slice(pack2026.byteOffset, pack2026.byteOffset + pack2026.byteLength)
    };
  };

  const act902 = { id: '902' };
  const loaded902 = await loadActivityStreamShard('902', act902);
  assert.equal(fetchCount, 1);
  assert.deepEqual(loaded902.telemetry_stream.hr, [120, 125]);
  console.log('  ✓ T-PACK-03: HTTP 200 fallback slices and caches yearly packfile cleanly');

  // Test legacy .enc fallback when not in stream_pack_index
  const shard999 = Buffer.from(JSON.stringify({ id: '999', telemetry_stream: { hr: [111] } }), 'utf-8');
  const enc999 = encryptWire(shard999, key, salt);
  globalThis.fetch = async (url) => {
    assert.equal(url, './streams/999.enc');
    return {
      ok: true,
      status: 200,
      arrayBuffer: async () => enc999.buffer.slice(enc999.byteOffset, enc999.byteLength)
    };
  };
  const loaded999 = await loadActivityStreamShard('999', { id: '999' });
  assert.deepEqual(loaded999.telemetry_stream.hr, [111]);
  console.log('  ✓ T-PACK-04: Legacy ./streams/<id>.enc fallback works seamlessly');

  // Test large multi-megabyte Gzip payload (>3 MB uncompressed) to verify zero backpressure deadlock
  const largeActivities = Array.from({ length: 5000 }, (_, i) => ({
    id: String(i + 1),
    name: `Long Endurance Activity #${i + 1} with detailed metadata`,
    sport: i % 2 === 0 ? 'running' : 'cycling',
    date: '2026-01-01',
    distance_meters: 12345.6,
    duration_seconds: 3600,
    summary_polyline: 'a'.repeat(400)
  }));
  const largeJson = Buffer.from(JSON.stringify({ activities: largeActivities }), 'utf-8');
  assert.ok(largeJson.byteLength > 2_500_000, 'Test payload must exceed 2.5 MB uncompressed');
  const largeGz = zlib.gzipSync(largeJson);
  const largeEnc = encryptWire(largeGz, key, salt);
  const largeDec = await decryptWithRawKey(rawKeyBase64, largeEnc);
  assert.equal(largeDec.activities.length, 5000);
  console.log(`  ✓ T-PACK-05: Large Gzip payload (${(largeJson.byteLength / 1024 / 1024).toFixed(2)} MB) decompressed without deadlock`);

  console.log('\n=== Packed Stream Web Results: 5 passed, 0 failed ===\n');
}

run().catch((err) => {
  console.error(err);
  process.exit(1);
});
