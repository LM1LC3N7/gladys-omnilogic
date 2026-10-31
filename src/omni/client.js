// -----------------------------------------------------------------------------
// The only network access: ONE request to the controller at a time (the lane
// of src/lane.js gives the turns; this client refuses a second request
// anyway), each on a NEW UDP socket connected to the controller (the kernel
// drops datagrams from any other address), closed before the request ends:
// a late datagram of an old request lands on a closed port, never in a newer
// one, and a new socket only opens once the old one is closed.
//
// A request (python-omnilogic-local 5.0.2, `api/protocol.py`): sent, then its
// ack awaited (MSP_ACK carrying one of the message ids of this request); no
// ack within 1.5 s: sent again with a new id, until the timeout. A request
// with an answer (the telemetry, the configuration) then waits for it: one
// message of the awaited type, or a lead message (that type, its size and
// block count) and its blocks. Every message of the controller that is not an
// ack is acknowledged (ACK, its id), as the controller expects.
//
// Bounds: a datagram never over 65,507 bytes, an answer never over 1 MiB
// (the lead size, checked before the blocks are gathered, and every block
// against it), 4 MiB once inflated (zlib stops there), 256 blocks, 64
// datagrams that are not the answer, 3 s between two blocks, a request never
// longer than its timeout. The XML is read by src/omni/xml.js.
// -----------------------------------------------------------------------------

import { createSocket as dgramSocket } from 'node:dgram';
import { inflateSync } from 'node:zlib';
import { ANSWER_OF, LIMITS, MSG, PROTOCOL, TIMINGS } from '../constants.js';
import { ACK_BODY, decode, encode } from './protocol.js';
import { attrOf, childNamed, childrenNamed, parseXml } from './xml.js';

export const ERROR_KINDS = {
  /** The datagram could not be sent (no route, DNS). */
  UNREACHABLE: 'unreachable',
  /** No ack or no answer in time. */
  TIMEOUT: 'timeout',
  /** Not the protocol (a datagram too big, too many that are not the answer, a bad lead). */
  PROTOCOL: 'protocol',
  /** The turn was taken (a stop), or the configuration changed. */
  ABORTED: 'aborted',
  /** `beforeSend` refused (an option turned off, a stop, too late): nothing left. */
  YIELDED: 'yielded',
  /** Too late to start. */
  LATE: 'late',
};

export class PanelError extends Error {
  constructor(kind, message, extra = {}) {
    super(message);
    this.name = 'PanelError';
    this.kind = kind;
    /** Whether the request may have reached the controller (a datagram left). */
    this.sent = false;
    Object.assign(this, extra);
  }
}

/** A short reason for a status or a log, never the content of an answer. */
export function errorReason(err) {
  return err instanceof PanelError ? err.kind : 'error';
}

/** The fields of a lead message: { source, size, blocks }, else undefined. */
export function parseLead(text) {
  let root;
  try {
    root = parseXml(text);
  } catch {
    return undefined;
  }
  const values = Object.create(null);
  for (const p of childrenNamed(childNamed(root, 'Parameters'), 'Parameter')) {
    const name = attrOf(p, 'name');
    if (typeof name === 'string' && /^\d{1,9}$/.test(p.text)) values[name] = Number(p.text);
  }
  const { SourceOpId: source, MsgSize: size, MsgBlockCount: blocks } = values;
  if (![source, size, blocks].every(Number.isInteger)) return undefined;
  return { source, size, blocks };
}

/** The text of an answer: inflated when flagged or when it starts like zlib, NULs trimmed. */
export function answerText(data, compressed) {
  let bytes = data;
  if (compressed || bytes[0] === 0x78) {
    try {
      bytes = inflateSync(bytes, { maxOutputLength: LIMITS.maxInflated });
    } catch {
      throw new PanelError(ERROR_KINDS.PROTOCOL, 'Bad compressed answer');
    }
  }
  // eslint-disable-next-line no-control-regex
  return bytes.toString('utf8').replace(/^\u0000+|\u0000+$/g, '');
}

export class PanelClient {
  /**
   * `createSocket()` returns a UDP socket (node:dgram 'udp4', or a test
   * double): `connect(port, host)`, `send(buffer, callback)`, `close(callback)`,
   * events 'connect', 'message', 'error'. `wallNow`: only for the time field
   * of the header (never a decision).
   */
  constructor({
    createSocket = () => dgramSocket('udp4'),
    timers = globalThis,
    now = () => performance.now(),
    wallNow = Date.now,
  } = {}) {
    this.createSocket = createSocket;
    this.timers = timers;
    this.now = now;
    this.wallNow = wallNow;
    this.busy = false;
    this.seq = Math.floor(Math.random() * 0xffff) + 1;
    this.socket = undefined;
  }

  nextId() {
    this.seq = (this.seq % 0x7fffffff) + 1;
    return this.seq;
  }

  /** Closes the socket of the request in flight, if any; resolves once it is closed. */
  close() {
    return this.socket ? this.socket.close() : Promise.resolve();
  }

  /**
   * One request. `spec`: `{ type, body }`, or a function called right after
   * `beforeSend` (its result is what is sent). `beforeSend()` runs right
   * before the first datagram: when it throws, nothing is sent (a YIELDED
   * error carrying it as `cause`). Resolves the text of the answer (or
   * undefined for a request answered by its ack only); rejects a PanelError
   * whose `sent` says if a datagram left.
   */
  async request(address, spec, { timeoutMs, signal, beforeSend } = {}) {
    if (this.busy) {
      throw new PanelError(ERROR_KINDS.PROTOCOL, 'A request is already in flight');
    }
    if (signal?.aborted) {
      throw new PanelError(ERROR_KINDS.ABORTED, 'Aborted');
    }
    this.busy = true;
    const started = this.now();
    const until = started + Math.max(1, timeoutMs);
    const socket = this.open();
    try {
      await this.connect(socket, address, { until, signal });
      if (beforeSend) {
        try {
          beforeSend();
        } catch (cause) {
          throw new PanelError(ERROR_KINDS.YIELDED, 'Not sent', { cause });
        }
      }
      if (signal?.aborted) {
        throw new PanelError(ERROR_KINDS.ABORTED, 'Aborted');
      }
      const request = typeof spec === 'function' ? spec() : spec;
      return await this.exchange(socket, request, { until, signal });
    } finally {
      await socket.close();
      this.busy = false;
    }
  }

  /** A new socket, wrapped: its datagrams queued for the request, its close awaited. */
  open() {
    const raw = this.createSocket();
    const socket = {
      raw,
      listener: undefined,
      error: undefined,
      closed: undefined,
      close: () => {
        if (!socket.closed) {
          socket.closed = new Promise((resolve) => {
            try {
              raw.close(() => resolve());
            } catch {
              resolve();
            }
          });
          if (this.socket === socket) this.socket = undefined;
        }
        return socket.closed;
      },
    };
    raw.on('error', (err) => {
      socket.error = err;
      socket.listener?.({ error: err });
    });
    raw.on('message', (data) => socket.listener?.({ data }));
    this.socket = socket;
    return socket;
  }

  /** Connects the socket (a host name is looked up here), within the time left. */
  connect(socket, address, { until, signal }) {
    return new Promise((resolve, reject) => {
      let settled = false;
      const done = (err) => {
        if (settled) return;
        settled = true;
        this.timers.clearTimeout(timer);
        signal?.removeEventListener('abort', onAbort);
        socket.listener = undefined;
        if (err) reject(err);
        else resolve();
      };
      const onAbort = () => done(new PanelError(ERROR_KINDS.ABORTED, 'Aborted'));
      const timer = this.timers.setTimeout(
        () => done(new PanelError(ERROR_KINDS.TIMEOUT, 'No route in time')),
        Math.max(1, until - this.now()),
      );
      signal?.addEventListener('abort', onAbort, { once: true });
      socket.listener = (event) => {
        if (event.error) done(new PanelError(ERROR_KINDS.UNREACHABLE, 'Cannot reach'));
      };
      try {
        socket.raw.once('connect', () => done());
        socket.raw.connect(address.port, address.host);
      } catch {
        done(new PanelError(ERROR_KINDS.UNREACHABLE, 'Cannot reach'));
      }
    });
  }

  /** Sends the request (again every 1.5 s without its ack), then waits for its answer. */
  exchange(socket, { type, body }, { until, signal }) {
    const answerType = ANSWER_OF[type];
    return new Promise((resolve, reject) => {
      const ids = new Set();
      let acked = false;
      let sent = false;
      let others = 0;
      let lead;
      let blocks;
      let blockIds;
      let size = 0;
      let resendTimer;
      let blockTimer;
      let settled = false;
      const finish = (err, value) => {
        if (settled) return;
        settled = true;
        this.timers.clearTimeout(timer);
        this.timers.clearTimeout(resendTimer);
        this.timers.clearTimeout(blockTimer);
        signal?.removeEventListener('abort', onAbort);
        socket.listener = undefined;
        if (err) {
          const failure = new PanelError(err.kind ?? ERROR_KINDS.PROTOCOL, err.message);
          failure.sent = sent;
          reject(failure);
        } else {
          resolve(value);
        }
      };
      const fail = (kind, message) => finish(new PanelError(kind, message));
      const onAbort = () => fail(ERROR_KINDS.ABORTED, 'Aborted');
      const timer = this.timers.setTimeout(
        () => fail(ERROR_KINDS.TIMEOUT, acked ? 'No answer' : 'No ack'),
        Math.max(1, until - this.now()),
      );
      signal?.addEventListener('abort', onAbort, { once: true });

      const send = () => {
        if (settled || acked) return;
        const id = this.nextId();
        ids.add(id);
        const datagram = encode({ id, type, body, time: this.wallNow() / 1000 });
        sent = true;
        try {
          socket.raw.send(datagram, (err) => {
            if (err && !acked) fail(ERROR_KINDS.UNREACHABLE, 'Send failed');
          });
        } catch {
          fail(ERROR_KINDS.UNREACHABLE, 'Send failed');
          return;
        }
        resendTimer = this.timers.setTimeout(send, TIMINGS.ackWait);
      };
      const ackIt = (id) => {
        try {
          socket.raw.send(encode({ id, type: MSG.ACK, body: ACK_BODY }), () => {});
        } catch {
          // The answer is still read; the controller sends it again at worst.
        }
      };
      const other = () => {
        others += 1;
        if (others > LIMITS.maxOtherMessages)
          fail(ERROR_KINDS.PROTOCOL, 'No answer among the datagrams');
      };
      const done = (data, compressed) => {
        try {
          finish(undefined, answerText(data, compressed));
        } catch (err) {
          finish(err);
        }
      };
      const armBlockWait = () => {
        this.timers.clearTimeout(blockTimer);
        blockTimer = this.timers.setTimeout(
          () => fail(ERROR_KINDS.TIMEOUT, 'Blocks stopped'),
          TIMINGS.blockWait,
        );
      };

      socket.listener = (event) => {
        if (settled) return;
        if (event.error) {
          // An ICMP unreachable shows here: the next try may still pass.
          return;
        }
        const { data } = event;
        if (data.length > LIMITS.maxDatagram) {
          fail(ERROR_KINDS.PROTOCOL, 'Datagram too big');
          return;
        }
        const message = decode(data);
        if (!message) {
          other();
          return;
        }
        if (message.type === MSG.MSP_ACK || message.type === MSG.ACK) {
          if (!ids.has(message.id)) {
            other();
            return;
          }
          if (!acked) {
            acked = true;
            this.timers.clearTimeout(resendTimer);
            if (answerType === undefined) finish(undefined, undefined);
          }
          return;
        }
        // Every message of the controller is acknowledged, wanted or not.
        ackIt(message.id);
        if (answerType === undefined) {
          other();
          return;
        }
        if (message.type === MSG.MSP_LEADMESSAGE) {
          if (lead) {
            // The same lead again (our ack was lost): already counted.
            return;
          }
          const parsed = parseLead(answerText(message.payload, false));
          if (!parsed || parsed.source !== answerType) {
            other();
            return;
          }
          if (
            parsed.size < 1 ||
            parsed.size > LIMITS.maxAnswerBytes ||
            parsed.blocks < 1 ||
            parsed.blocks > LIMITS.maxBlocks
          ) {
            fail(ERROR_KINDS.PROTOCOL, 'Answer too big');
            return;
          }
          lead = { ...parsed, compressed: message.compressed };
          blocks = [];
          blockIds = new Set();
          armBlockWait();
          return;
        }
        if (message.type === MSG.MSP_BLOCKMESSAGE) {
          if (!lead || blockIds.has(message.id)) {
            if (!lead) other();
            return;
          }
          blockIds.add(message.id);
          const part = message.payload.subarray(PROTOCOL.blockHeaderSize);
          size += part.length;
          // Never gathered past the size the lead announced (plus one datagram of padding).
          if (size > lead.size + LIMITS.maxDatagram) {
            fail(ERROR_KINDS.PROTOCOL, 'Answer bigger than announced');
            return;
          }
          blocks.push(part);
          if (blocks.length < lead.blocks) {
            armBlockWait();
            return;
          }
          const all = Buffer.concat(blocks).subarray(0, lead.size);
          done(all, lead.compressed);
          return;
        }
        if (message.type === answerType && !lead) {
          // The telemetry is always compressed (the reference's rule).
          done(message.payload, message.compressed || answerType === MSG.MSP_TELEMETRY_UPDATE);
          return;
        }
        other();
      };
      send();
    });
  }
}
