// -----------------------------------------------------------------------------
// The UDP client against the fake controller (a dgram double on the virtual
// clock): acks, resends with a new id, answers in one message or in a lead
// and blocks, every bound (size, blocks, other datagrams, zlib), aborts,
// beforeSend, one request at a time, a new socket per request; and the
// protocol and XML readers on their own.
// -----------------------------------------------------------------------------

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { deflateSync } from 'node:zlib';
import { MSG } from '../src/constants.js';
import { ERROR_KINDS, PanelClient, answerText, parseLead } from '../src/omni/client.js';
import { REQUESTS, decode, encode } from '../src/omni/protocol.js';
import { parseXml } from '../src/omni/xml.js';
import { HOST, PORT, TYPES, datagram, fakeOmni } from './fixtures/fakeOmni.js';
import { settle, testClock } from './kit/clock.mjs';

const ADDRESS = { host: HOST, port: PORT };

function bench(options = {}) {
  const clock = testClock();
  const omni = fakeOmni({ timers: clock.timers, ...options });
  omni.clockNow = () => clock.elapsed;
  const client = new PanelClient({
    createSocket: omni.createSocket,
    timers: clock.timers,
    now: clock.monotonic,
    wallNow: clock.now,
  });
  /** Runs `promise` while the clock moves, up to `ms`. */
  const run = async (promise, ms = 20_000) => {
    let done = false;
    const settled = promise.then(
      (value) => ((done = true), { value }),
      (error) => ((done = true), { error }),
    );
    for (let e = 0; e < ms && !done; e += 10) {
      await clock.advance(10);
      await settle(2);
    }
    return settled;
  };
  return { clock, omni, client, run };
}

test('the header: 24 bytes, version 1.19, the body ended by a NUL', () => {
  const buf = encode({ id: 7, type: MSG.GET_TELEMETRY, body: '<x/>', time: 1000 });
  assert.equal(buf.length, 24 + 5);
  assert.equal(buf.readUInt32BE(0), 7);
  assert.equal(buf.subarray(12, 16).toString('ascii'), '1.19');
  assert.equal(buf.readUInt32BE(16), 300);
  assert.equal(buf.readUInt8(20), 0, 'client type XML with a body');
  assert.equal(buf.at(-1), 0);
  assert.deepEqual(decode(buf).id, 7);
  assert.equal(decode(Buffer.alloc(10)), undefined);
});

test('requests are built from checked whole numbers only', () => {
  assert.throws(() => REQUESTS.equipment(1, 3, 101));
  assert.throws(() => REQUESTS.equipment(1, '3<x>', 0));
  assert.throws(() => REQUESTS.setpoint(1, 4, 105));
  assert.throws(() => REQUESTS.setpoint(1, 4, 64));
  assert.throws(() => REQUESTS.setpoint(1, 4, 80.5));
  assert.match(
    REQUESTS.setpoint(1, 4, 86).body,
    /<Parameter name="Temp" dataType="int" unit="F" alias="Data">86<\/Parameter>/,
  );
});

test('telemetry: acked, answered compressed without the flag; each answer acked back', async () => {
  const { omni, client, run } = bench();
  const { value } = await run(client.request(ADDRESS, REQUESTS.telemetry(), { timeoutMs: 5000 }));
  assert.match(value, /^<\?xml[\s\S]*<STATUS/);
  assert.equal(omni.clientAcks.length, 1, 'the answer acked');
  assert.equal(omni.open, 0, 'the socket closed');
});

test('the configuration: a lead and its blocks, gathered, inflated', async () => {
  const { omni, client, run } = bench({ blockSize: 300 });
  const { value } = await run(
    client.request(ADDRESS, REQUESTS.configuration(), { timeoutMs: 5000 }),
  );
  assert.match(value, /<MSPConfig>/);
  assert.ok(omni.clientAcks.length > 3, 'the lead and every block acked');
});

test('no ack: sent again with a new id every 800 ms; a late ack of an earlier id counts', async () => {
  const { omni, client, run } = bench({ dropAcks: 2 });
  const { value, error } = await run(
    client.request(ADDRESS, REQUESTS.equipment(0, 27, 1), { timeoutMs: 5000 }),
  );
  assert.equal(error, undefined);
  assert.equal(value, undefined);
  const ids = omni.requests.map((r) => r.id);
  assert.equal(ids.length, 3);
  assert.equal(new Set(ids).size, 3, 'a new id each time');
});

test('an ack for another id is not ours; silence is a timeout, marked sent', async () => {
  const { omni, client, run } = bench({ silent: true });
  const { error } = await run(
    client.request(ADDRESS, REQUESTS.equipment(0, 27, 1), { timeoutMs: 2000 }),
  );
  assert.equal(error.kind, ERROR_KINDS.TIMEOUT);
  assert.equal(error.sent, true);
  assert.equal(omni.open, 0);
});

test('an answer bigger than 1 MiB announced, or blocks past the size: refused', async () => {
  const { omni, client, run } = bench();
  omni.handle = (buf) => {
    const id = buf.readUInt32BE(0);
    if (buf.readUInt32BE(16) === 0) return [];
    const lead = `<Response><Name>LeadMessage</Name><Parameters><Parameter name="SourceOpId">1003</Parameter><Parameter name="MsgSize">${2 * 1024 * 1024}</Parameter><Parameter name="MsgBlockCount">2</Parameter></Parameters></Response>`;
    return [datagram(id, TYPES.MSP_ACK), datagram(9, TYPES.LEAD, Buffer.from(lead))];
  };
  const { error } = await run(
    client.request(ADDRESS, REQUESTS.configuration(), { timeoutMs: 5000 }),
  );
  assert.equal(error.kind, ERROR_KINDS.PROTOCOL);
  omni.handle = (buf) => {
    const id = buf.readUInt32BE(0);
    if (buf.readUInt32BE(16) === 0) return [];
    const lead = `<Response><Name>LeadMessage</Name><Parameters><Parameter name="SourceOpId">1003</Parameter><Parameter name="MsgSize">10</Parameter><Parameter name="MsgBlockCount">200</Parameter></Parameters></Response>`;
    const blocks = Array.from({ length: 5 }, (_, k) =>
      datagram(20 + k, TYPES.BLOCK, Buffer.alloc(30_000)),
    );
    return [datagram(id, TYPES.MSP_ACK), datagram(9, TYPES.LEAD, Buffer.from(lead)), ...blocks];
  };
  const second = await run(client.request(ADDRESS, REQUESTS.configuration(), { timeoutMs: 5000 }));
  assert.equal(second.error.kind, ERROR_KINDS.PROTOCOL, 'cut before every block is gathered');
});

test('too many datagrams that are not the answer, or a bad zlib stream: refused', async () => {
  const { omni, client, run } = bench();
  omni.handle = (buf) => {
    const id = buf.readUInt32BE(0);
    if (buf.readUInt32BE(16) === 0) return [];
    return [
      datagram(id, TYPES.MSP_ACK),
      ...Array.from({ length: 80 }, (_, k) => datagram(50 + k, 1304, Buffer.from('x'))),
    ];
  };
  const { error } = await run(client.request(ADDRESS, REQUESTS.telemetry(), { timeoutMs: 5000 }));
  assert.equal(error.kind, ERROR_KINDS.PROTOCOL);
  omni.handle = (buf) => {
    const id = buf.readUInt32BE(0);
    if (buf.readUInt32BE(16) === 0) return [];
    return [
      datagram(id, TYPES.MSP_ACK),
      datagram(99, TYPES.TELEMETRY_UPDATE, Buffer.from('xx not zlib')),
    ];
  };
  const bad = await run(client.request(ADDRESS, REQUESTS.telemetry(), { timeoutMs: 5000 }));
  assert.equal(bad.error.kind, ERROR_KINDS.PROTOCOL);
});

test('a zlib bomb is stopped at 4 MiB', () => {
  const bomb = deflateSync(Buffer.alloc(8 * 1024 * 1024, 0x41));
  assert.throws(
    () => answerText(bomb, true),
    (err) => err.kind === ERROR_KINDS.PROTOCOL,
  );
});

test('an abort ends the request and closes the socket before rejecting', async () => {
  const { omni, client, run } = bench({ latencyMs: 10_000 });
  const controller = new AbortController();
  const pending = client.request(ADDRESS, REQUESTS.telemetry(), {
    timeoutMs: 20_000,
    signal: controller.signal,
  });
  const result = run(pending);
  setTimeout(() => controller.abort(), 0);
  const { error } = await result;
  assert.equal(error.kind, ERROR_KINDS.ABORTED);
  assert.equal(omni.open, 0);
});

test('beforeSend refusing: nothing sent; the request built after it', async () => {
  const { omni, client, run } = bench();
  const { error } = await run(
    client.request(ADDRESS, () => assert.fail('built'), {
      timeoutMs: 5000,
      beforeSend: () => {
        throw new Error('no');
      },
    }),
  );
  assert.equal(error.kind, ERROR_KINDS.YIELDED);
  assert.equal(error.sent, false);
  assert.equal(omni.requests.length, 0);
  let built = false;
  await run(
    client.request(ADDRESS, () => ((built = true), REQUESTS.telemetry()), {
      timeoutMs: 5000,
      beforeSend: () => assert.equal(built, false),
    }),
  );
  assert.equal(built, true);
});

test('one request at a time; a new socket for each', async () => {
  const { omni, client, run } = bench({ latencyMs: 50 });
  const first = client.request(ADDRESS, REQUESTS.telemetry(), { timeoutMs: 5000 });
  await assert.rejects(
    client.request(ADDRESS, REQUESTS.telemetry(), { timeoutMs: 5000 }),
    /already in flight/,
  );
  await run(first);
  await run(client.request(ADDRESS, REQUESTS.telemetry(), { timeoutMs: 5000 }));
  assert.equal(omni.sockets, 2);
  assert.equal(omni.peak, 1);
});

test('the lead message: its fields strict', () => {
  const lead = (size) =>
    `<Response><Parameters><Parameter name="SourceOpId">1003</Parameter><Parameter name="MsgSize">${size}</Parameter><Parameter name="MsgBlockCount">2</Parameter></Parameters></Response>`;
  assert.deepEqual(parseLead(lead(100)), { source: 1003, size: 100, blocks: 2 });
  assert.equal(parseLead(lead('1e3')), undefined);
  assert.equal(parseLead('<oops'), undefined);
});

test('XML: no DOCTYPE, bounded depth, no prototype pollution, entities decoded', () => {
  assert.throws(() => parseXml('<!DOCTYPE x [<!ENTITY a "b">]><x/>'), /DOCTYPE refused/);
  assert.throws(() => parseXml('<a>'.repeat(40) + '</a>'.repeat(40)));
  assert.throws(() => parseXml('<a><b></a></b>'));
  assert.throws(() => parseXml('<a x="1" x="2"/>'));
  const root = parseXml('<a __proto__="x" constructor="y"><b>&lt;1&amp;2&#33;</b></a>');
  assert.equal(root.attrs.__proto__, 'x');
  assert.equal(Object.getPrototypeOf(root.attrs), null);
  assert.equal({}.polluted, undefined);
  assert.equal(root.children[0].text, '<1&2!');
});

test('an ack carrying another id is not ours: no ack, a timeout', async () => {
  const { omni, client, run } = bench();
  omni.handle = (buf) => {
    if (buf.readUInt32BE(16) === 0) return [];
    return [datagram(buf.readUInt32BE(0) + 1, TYPES.MSP_ACK)];
  };
  const { error } = await run(
    client.request(ADDRESS, REQUESTS.equipment(0, 27, 0), { timeoutMs: 2000 }),
  );
  assert.equal(error?.kind, ERROR_KINDS.TIMEOUT);
});
