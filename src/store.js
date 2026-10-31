// -----------------------------------------------------------------------------
// What must survive a restart, in /data (the only writable place of the
// container), with wall dates (a monotonic instant belongs to its process):
//   - `target`: the address and id of the last controller read, where a stop
//     goes while the configuration is not read yet;
//   - `lastAttemptAt`: the time of the last read (written at most once a
//     minute, BEFORE the read), so a restart never reads sooner than the
//     interval;
//   - `stops`: the stops not seen applied (address, object, what it writes,
//     since, written, acked, resends): a restart sends them again at once, before
//     the configuration is read (those already held are only checked).
// No secret (the controller has none), no personal data (no name is kept).
// The file is readable by the container user only (0600), bounded and
// repaired when read. A file that cannot be read is not an empty one:
// `load()` says so, and the app then never overwrites it with a guess. A
// special file (a FIFO, a device) is never read nor written: opened without
// blocking, refused when it is not a plain file; the temporary file of a
// save is created anew (never an existing one).
// -----------------------------------------------------------------------------

import { constants } from 'node:fs';
import { open, rename, rm } from 'node:fs/promises';
import { OBJ_KEY, OFF, STOP_ATTRS } from './constants.js';
import { PANEL_ID } from './omni/model.js';

export const STATE_FILE = '/data/omnilogic-state.json';
const MAX_BYTES = 64 * 1024;
const MAX_STOPS = 64;

/** Reads a plain file of at most MAX_BYTES; `undefined` when it is not one. */
async function readPlain(path) {
  const handle = await open(path, constants.O_RDONLY | constants.O_NONBLOCK | constants.O_NOFOLLOW);
  try {
    const info = await handle.stat();
    if (!info.isFile() || info.size > MAX_BYTES) return undefined;
    const buffer = Buffer.alloc(MAX_BYTES + 1);
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
    if (bytesRead > MAX_BYTES) return undefined;
    return buffer.subarray(0, bytesRead).toString('utf8');
  } finally {
    await handle.close();
  }
}

export function fileStore(path = STATE_FILE) {
  // One write at a time: two saves never share the temporary file.
  let chain = Promise.resolve();
  return {
    /** `{ data }`, `{ data: null }` (no file) or `{ unreadable: true }`. */
    async load() {
      let text;
      try {
        text = await readPlain(path);
      } catch (err) {
        return err?.code === 'ENOENT' ? { data: null } : { unreadable: true };
      }
      if (text === undefined) return { unreadable: true };
      try {
        return { data: JSON.parse(text) };
      } catch {
        return { unreadable: true };
      }
    },
    save(data) {
      const text = JSON.stringify(data);
      const write = chain.then(async () => {
        const temporary = `${path}.tmp`;
        // Never an existing file (it could be a FIFO): removed, then created exclusively.
        await rm(temporary, { force: true });
        const handle = await open(
          temporary,
          constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
          0o600,
        );
        try {
          await handle.writeFile(text);
        } finally {
          await handle.close();
        }
        await rename(temporary, path);
      });
      chain = write.catch(() => {});
      return write;
    },
  };
}

/** For the tests: the same JSON round trip as the file. */
export function memoryStore(initial = null, { unreadable = false, failSave = false } = {}) {
  return {
    data: initial === null ? null : JSON.parse(JSON.stringify(initial)),
    saves: 0,
    unreadable,
    failSave,
    /** A promise that holds every save until resolved (a hung disk), or undefined. */
    hang: undefined,
    /** A promise that holds the load until resolved (a slow disk), or undefined. */
    hangLoad: undefined,
    async load() {
      if (this.hangLoad) await this.hangLoad;
      if (this.unreadable) return { unreadable: true };
      return { data: this.data === null ? null : JSON.parse(JSON.stringify(this.data)) };
    },
    async save(data) {
      if (this.hang) await this.hang;
      if (this.failSave) throw new Error('disk full');
      this.data = JSON.parse(JSON.stringify(data));
      this.saves += 1;
    },
  };
}

const intIn = (value, min, max) =>
  Number.isInteger(value) && value >= min && value <= max ? value : undefined;

/** An address kept: a host name or IPv4 address in lower case, and a port. */
export function addressOf(raw) {
  if (!raw || typeof raw !== 'object') return undefined;
  const host =
    typeof raw.host === 'string' && raw.host.length <= 253 && /^[a-z0-9.-]+$/.test(raw.host)
      ? raw.host
      : undefined;
  const port = intIn(raw.port, 1, 65535);
  return host && port ? { host, port } : undefined;
}

/** The writes a stop is: an equipment off, a heater off. Nothing else is ever kept. */
export const STOP_WRITES = [
  { attr: STOP_ATTRS.EQUIPMENT, value: OFF },
  { attr: STOP_ATTRS.HEATER, value: '0' },
];

function normalizeStop(raw, now) {
  const address = addressOf(raw);
  if (!address || typeof raw.obj !== 'string' || !OBJ_KEY.test(raw.obj)) return undefined;
  if (!STOP_WRITES.some((w) => w.attr === raw.attr && w.value === raw.value)) return undefined;
  // `since` only dates the status: a date in the future (a clock set back,
  // NTP not there yet) or none keeps the stop, dated now.
  const since = Number.isFinite(raw.since) && raw.since <= now ? raw.since : now;
  const written = raw.written === true;
  // Acked only if written: a datagram never sent was never acked.
  const acked = written && raw.acked === true;
  return {
    ...address,
    obj: raw.obj,
    attr: raw.attr,
    value: raw.value,
    since,
    written,
    acked,
    // Never acked: no resend can have been counted (a stop that never reached the
    // controller is never held). A count that cannot be read is 0.
    resends: acked ? (intIn(raw.resends, 0, 100) ?? 0) : 0,
  };
}

/**
 * The persisted state, repaired and bounded (see the header). A time in the
 * future for `lastAttemptAt` counts as now: never a longer wait than the interval.
 */
export function normalizeMemory(raw, now) {
  const data = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
  const target = addressOf(data.target);
  const id =
    typeof data.target?.id === 'string' && PANEL_ID.test(data.target.id) ? data.target.id : null;
  const stops = [];
  for (const entry of Array.isArray(data.stops) ? data.stops.slice(0, MAX_STOPS) : []) {
    const stop = normalizeStop(entry, now);
    if (
      stop &&
      !stops.some(
        (s) =>
          s.host === stop.host &&
          s.port === stop.port &&
          s.obj === stop.obj &&
          s.attr === stop.attr,
      )
    ) {
      stops.push(stop);
    }
  }
  return {
    target: target ? { ...target, id } : null,
    lastAttemptAt: Number.isFinite(data.lastAttemptAt) ? Math.min(data.lastAttemptAt, now) : null,
    stops,
  };
}
