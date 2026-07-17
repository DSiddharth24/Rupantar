'use strict';

/**
 * services/session.js
 *
 * In-memory session store, keyed by phone number.
 * Holds the pending upload (buffer + detectedType) while the user is
 * deciding which format to convert to.
 *
 * TTL: SESSION_TTL_MS (default 10 minutes).
 * A background sweep runs every SWEEP_INTERVAL_MS to evict stale entries,
 * so memory doesn't grow unbounded on long-running servers.
 *
 * Nothing is ever written to disk. If the process restarts, all sessions
 * are gone — users simply resend their file.
 */

const SESSION_TTL_MS    = 10 * 60 * 1000; // 10 minutes
const SWEEP_INTERVAL_MS = 60 * 1000;      // sweep every 60 seconds

/** @type {Map<string, { buffer: Buffer, detectedType: string, expiresAt: number }>} */
const sessions = new Map();

let sweepTimer = null;

/**
 * Store a pending upload session for a phone number.
 * Overwrites any previous session for the same number.
 *
 * @param {string} phoneNumber
 * @param {Buffer} buffer        — file content, held in RAM only
 * @param {string} detectedType  — 'docx' | 'xlsx' | 'pptx' | 'pdf'
 */
function setSession(phoneNumber, buffer, detectedType) {
  sessions.set(phoneNumber, {
    buffer,
    detectedType,
    expiresAt: Date.now() + SESSION_TTL_MS
  });
}

/**
 * Retrieve a pending session. Returns null if not found or expired.
 *
 * @param {string} phoneNumber
 * @returns {{ buffer: Buffer, detectedType: string } | null}
 */
function getSession(phoneNumber) {
  const entry = sessions.get(phoneNumber);
  if (!entry) return null;
  if (Date.now() > entry.expiresAt) {
    sessions.delete(phoneNumber);
    return null;
  }
  return { buffer: entry.buffer, detectedType: entry.detectedType };
}

/**
 * Remove a session immediately — call this after a successful conversion
 * so the buffer is released from memory as early as possible.
 *
 * @param {string} phoneNumber
 */
function clearSession(phoneNumber) {
  sessions.delete(phoneNumber);
}

/**
 * Evict all sessions whose TTL has passed.
 * Called automatically by the background sweep.
 */
function sweepExpired() {
  const now = Date.now();
  for (const [phone, entry] of sessions) {
    if (now > entry.expiresAt) {
      sessions.delete(phone);
    }
  }
}

/**
 * Start the background sweep interval.
 * Safe to call multiple times — won't start a second timer.
 */
function startSweep() {
  if (sweepTimer) return;
  sweepTimer = setInterval(sweepExpired, SWEEP_INTERVAL_MS);
  // Don't keep the process alive just for sweeping
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

/** Exposed for diagnostics / tests only — not for application logic. */
function _size() {
  return sessions.size;
}

module.exports = { setSession, getSession, clearSession, startSweep, stopSweep, _size };
