'use strict';

/**
 * MessageStore
 * ---------------------------------------------------------------
 * Persists outgoing chat messages to a JSON log file so the system can
 * survive a server crash (or at least not lose *new* messages when a
 * server restarts).
 *
 * The store is an append-only JSON Lines file. Every message the server
 * broadcasts is appended to `data/messages.jsonl`. On restart the server
 * re-validates the log. Clients replay persisted messages from the peer
 * they connect to, so the broadcast history is recoverable after a crash.
 *
 * Limitations (called out in the report):
 *  - JSON Lines is fine for a low-to-moderate write volume but is not a
 *    replacement for a real database (e.g. PostgreSQL / Redis).
 *  - We do NOT guarantee "write-ahead" semantics before we acknowledge a
 *    broadcast, so a crash mid-write could drop at most one message per
 *    process. For stronger guarantees, the append should be atomic (fsync
 *    before ack) — see the report for production notes.
 */

const fs = require('fs');
const path = require('path');

const DATA_DIR = path.join(__dirname, '..', 'data');
const LOG_FILE = path.join(DATA_DIR, 'messages.jsonl');

let fileFd = null;

/** Ensure data directory and file exist without throwing. */
function ensureFile() {
  if (fs.existsSync(DATA_DIR)) {
    if (fs.existsSync(LOG_FILE)) {
      return;
    }
  } else {
    fs.mkdirSync(DATA_DIR, { recursive: true });
  }
  fs.writeFileSync(LOG_FILE, '', 'utf8');
}

/** Lazy-open the log file. */
function open() {
  if (fileFd === null) {
    ensureFile();
    fileFd = fs.openSync(LOG_FILE, 'a', 0o644);
  }
}

/**
 * Append a message to the log.
 * Returns true on success; false if the write failed.
 */
function append(message) {
  try {
    open();
    const line = `${JSON.stringify(message)}\n`;
    fs.writeSync(fileFd, line);
    fs.fsyncSync(fileFd); // call before ack so a restart loses at most 1 message
    return true;
  } catch (err) {
    // Log to console instead of throwing (a corrupted disk shouldn't
    // crash the chat server).
    console.error('[MessageStore] append failed:', err.message);
    return false;
  }
}

/**
 * Read all persisted messages, oldest first.
 * Used by clients after reconnection to replay history.
 */
function readAll() {
  try {
    if (!fs.existsSync(LOG_FILE)) {
      return [];
    }
    const raw = fs.readFileSync(LOG_FILE, 'utf8');
    if (!raw.trim()) {
      return [];
    }
    return raw
      .split('\n')
      .map((line) => {
        try {
          return JSON.parse(line);
        } catch (err) {
          // Skip malformed lines so a bad write doesn't kill the replay.
          return null;
        }
      })
      .filter(Boolean);
  } catch (err) {
    console.error('[MessageStore] readAll failed:', err.message);
    return [];
  }
}

/** Delete the log file (useful for testing / rotating data). */
function deleteLog() {
  try {
    if (fs.existsSync(LOG_FILE)) {
      fs.unlinkSync(LOG_FILE);
    }
  } catch (err) {
    console.error('[MessageStore] deleteLog failed:', err.message);
  }
}

/** Close the file descriptor on shutdown. */
function close() {
  if (fileFd !== null) {
    try {
      fs.closeSync(fileFd);
    } catch (err) {
      /* ignore */
    }
    fileFd = null;
  }
}

module.exports = {
  append,
  readAll,
  deleteLog,
  close,
};
