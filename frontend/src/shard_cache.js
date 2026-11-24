/**
 * frontend/src/shard_cache.js
 *
 * Lightweight IndexedDB LRU cache for decrypted stream pack chunks.
 * - Database: 'garmin-dash-pack-cache', store: 'chunks'
 * - Key format: `${year}:${activityId}:${offset}:${length}`
 * - Eviction cap: 100 entries or 25 MB total byteLength
 * - Graceful no-op fallback when indexedDB is unavailable (Node.js / private browsing)
 */

export const SHARD_CACHE_DB_NAME = 'garmin-dash-pack-cache';
export const SHARD_CACHE_STORE_NAME = 'chunks';
export const SHARD_CACHE_MAX_ENTRIES = 100;
export const SHARD_CACHE_MAX_BYTES = 25 * 1024 * 1024;

/**
 * Builds canonical cache key for a stream pack chunk.
 * @param {string|number} year
 * @param {string|number} activityId
 * @param {number} offset
 * @param {number} length
 * @returns {string}
 */
export function makeChunkCacheKey(year, activityId, offset, length) {
  return `${year}:${activityId}:${offset}:${length}`;
}

function estimateByteLength(data) {
  if (data === null || data === undefined) return 0;
  if (data instanceof ArrayBuffer) return data.byteLength;
  if (ArrayBuffer.isView(data)) return data.byteLength;
  if (typeof data === 'string') return data.length * 2;
  try {
    return JSON.stringify(data).length;
  } catch {
    return 0;
  }
}

function openCacheDb() {
  if (typeof indexedDB === 'undefined' || !indexedDB || typeof indexedDB.open !== 'function') {
    return Promise.resolve(null);
  }
  return new Promise((resolve) => {
    try {
      const req = indexedDB.open(SHARD_CACHE_DB_NAME, 1);
      req.onupgradeneeded = (event) => {
        const db = event?.target?.result || req.result;
        if (db && !db.objectStoreNames.contains(SHARD_CACHE_STORE_NAME)) {
          const store = db.createObjectStore(SHARD_CACHE_STORE_NAME, { keyPath: 'key' });
          if (typeof store.createIndex === 'function') {
            store.createIndex('lastAccessed', 'lastAccessed', { unique: false });
          }
        }
      };
      req.onsuccess = () => resolve(req.result || null);
      req.onerror = () => resolve(null);
      req.onblocked = () => resolve(null);
    } catch {
      resolve(null);
    }
  });
}

function idbRequestToPromise(req) {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error || new Error('IndexedDB request failed'));
  });
}

function waitForTransaction(tx) {
  return new Promise((resolve, reject) => {
    if (!tx) {
      resolve();
      return;
    }
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error || new Error('IndexedDB transaction failed'));
    tx.onabort = () => reject(tx.error || new Error('IndexedDB transaction aborted'));
  });
}

/**
 * Retrieves a cached chunk from IndexedDB and updates its LRU timestamp.
 * @param {string} key
 * @returns {Promise<any|null>}
 */
export async function getCachedChunk(key) {
  if (!key) return null;
  const db = await openCacheDb();
  if (!db) return null;

  try {
    const tx = db.transaction(SHARD_CACHE_STORE_NAME, 'readwrite');
    const store = tx.objectStore(SHARD_CACHE_STORE_NAME);
    const record = await idbRequestToPromise(store.get(key));
    if (!record) {
      await waitForTransaction(tx);
      return null;
    }
    record.lastAccessed = Date.now();
    store.put(record);
    await waitForTransaction(tx);
    return record.data ?? null;
  } catch {
    return null;
  } finally {
    try {
      if (typeof db.close === 'function') db.close();
    } catch {
      // ignore
    }
  }
}

/**
 * Stores a chunk in IndexedDB and enforces LRU eviction (100 entries / 25 MB).
 * @param {string} key
 * @param {any} data
 * @param {{ maxEntries?: number, maxBytes?: number }} [limits]
 * @returns {Promise<void>}
 */
export async function putCachedChunk(key, data, limits = null) {
  if (!key || data === undefined || data === null) return;
  const db = await openCacheDb();
  if (!db) return;

  const maxEntries = limits?.maxEntries ?? SHARD_CACHE_MAX_ENTRIES;
  const maxBytes = limits?.maxBytes ?? SHARD_CACHE_MAX_BYTES;
  const byteLength = estimateByteLength(data);
  const now = Date.now();

  try {
    const tx = db.transaction(SHARD_CACHE_STORE_NAME, 'readwrite');
    const store = tx.objectStore(SHARD_CACHE_STORE_NAME);
    store.put({
      key,
      data,
      byteLength,
      lastAccessed: now
    });

    const allRecords = await idbRequestToPromise(store.getAll());
    if (Array.isArray(allRecords) && allRecords.length > 0) {
      let totalBytes = 0;
      for (const rec of allRecords) {
        totalBytes += Number(rec?.byteLength || 0);
      }
      let remainingCount = allRecords.length;

      if (remainingCount > maxEntries || totalBytes > maxBytes) {
        const evictable = allRecords
          .filter((rec) => rec && rec.key !== key)
          .sort((a, b) => (a.lastAccessed || 0) - (b.lastAccessed || 0));

        for (const victim of evictable) {
          if (remainingCount <= maxEntries && totalBytes <= maxBytes) break;
          store.delete(victim.key);
          remainingCount -= 1;
          totalBytes -= Number(victim.byteLength || 0);
        }
      }
    }

    await waitForTransaction(tx);
  } catch {
    // Graceful no-op on quota or private browsing errors
  } finally {
    try {
      if (typeof db.close === 'function') db.close();
    } catch {
      // ignore
    }
  }
}

/**
 * Clears all cached chunks from IndexedDB (called on Lock Vault).
 * @returns {Promise<void>}
 */
export async function clearIndexedDbCache() {
  const db = await openCacheDb();
  if (!db) return;

  try {
    const tx = db.transaction(SHARD_CACHE_STORE_NAME, 'readwrite');
    const store = tx.objectStore(SHARD_CACHE_STORE_NAME);
    store.clear();
    await waitForTransaction(tx);
  } catch {
    // Graceful no-op
  } finally {
    try {
      if (typeof db.close === 'function') db.close();
    } catch {
      // ignore
    }
  }
}
