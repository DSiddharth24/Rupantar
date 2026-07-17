'use strict';

/**
 * services/ephemeralStore.js
 *
 * One-time, in-memory token → buffer map used for outbound file serving.
 *
 * Because Twilio must fetch the converted file from a public URL, we expose
 * a short-lived GET /file/:token endpoint. The buffer lives in this map for
 * at most FILE_TTL_MS (~2 minutes). It is deleted immediately after the
 * first successful fetch (one-time delivery), or by the background sweep
 * if Twilio never retrieves it (failed delivery, user blocked bot, etc.).
 *
 * Nothing is written to disk. Process restart = everything gone.
 */

const crypto = require('crypto');

const FILE_TTL_MS      = 2 * 60 * 1000; // 2 minutes
const SWEEP_INTERVAL_MS = 30 * 1000;    // sweep every 30 seconds

/**
 * @typedef {{ buffer: Buffer, mimeType: string, filename: string, expiresAt: number }} StoreEntry
 * @type {Map<string, StoreEntry>}
 */
const store = new Map();

let sweepTimer = null;

/**
 * Store a converted buffer and return a one-time token.
 *
 * @param {Buffer} buffer
 * @param {string} mimeType   — e.g. 'application/pdf'
 * @param {string} filename   — suggested download filename, e.g. 'converted.pdf'
 * @returns {string} token    — 48 hex chars, unguessable
 */
function storeFile(buffer, mimeType, filename) {
  const token = crypto.randomBytes(24).toString('hex');
  store.set(token, {
    buffer,
    mimeType,
    filename,
    expiresAt: Date.now() + FILE_TTL_MS
  });
  return token;
}

/**
 * Retrieve and immediately delete a stored file by token.
 * Returns null if the token is unknown or has expired.
 *
 * @param {string} token
 * @returns {{ buffer: Buffer, mimeType: string, filename: string } | null}
 */
function consumeFile(token) {
  const entry = store.get(token);
  if (!entry) return null;

  // Always delete before returning — one-time use
  store.delete(token);

  if (Date.now() > entry.expiresAt) return null;

  return { buffer: entry.buffer, mimeType: entry.mimeType, filename: entry.filename };
}

/**
 * Evict all entries whose TTL has passed.
 * Covers the case where the file was stored but never fetched.
 */
function sweepExpired() {
  const now = Date.now();
  for (const [token, entry] of store) {
    if (now > entry.expiresAt) {
      store.delete(token);
    }
  }
}

/**
 * Start the background sweep. Safe to call multiple times.
 */
function startSweep() {
  if (sweepTimer) return;
  sweepTimer = setInterval(sweepExpired, SWEEP_INTERVAL_MS);
  if (sweepTimer.unref) sweepTimer.unref();
}

/**
 * Stop the background sweep (useful in tests).
 */
function stopSweep() {
  if (sweepTimer) {
    clearInterval(sweepTimer);
    sweepTimer = null;
  }
}

/** Exposed for diagnostics / tests only. */
function _size() {
  return store.size;
}

module.exports = { storeFile, consumeFile, startSweep, stopSweep, _size };
