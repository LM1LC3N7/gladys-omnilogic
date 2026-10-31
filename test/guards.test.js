// -----------------------------------------------------------------------------
// The guards checked twice (on the fresh read and right before the datagram),
// the counts of a stop, its retries, the reads that judge it, and /data slow,
// hung, failing or late: each proven by a case where it alone decides.
// -----------------------------------------------------------------------------

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { memoryStore } from '../src/store.js';
import { HOST, PORT, TYPES, fakeOmni } from './fixtures/fakeOmni.js';
import { ALLOW, CFG, ID, MINUTE, SECOND, feature, ok, refused, setup } from './helpers.js';
import { testClock } from './kit/clock.mjs';

const relay = (t) => t.panel.state.relays[0];

/** A stop as /data keeps it. */
const kept = (obj, extra = {}) => ({
  host: HOST,
  port: PORT,
  obj,
  attr: 'STATUS',
  value: 'OFF',
  since: 0,
  written: false,
  resends: 0,
  ...extra,
});

/** A store whose load ends `ms` after it is asked (a slow disk). */
function slowStore(clock, data, ms) {
  const store = memoryStore(data);
  const load = store.load.bind(store);
  store.load = () =>
    new Promise((resolve) => {
      store.release = () => resolve(load());
      if (Number.isFinite(ms)) clock.timers.setTimeout(store.release, ms);
    });
  return store;
}

test('the deadline passed while the fresh read is slow: nothing sent', async () => {
  const t = await setup({ config: ALLOW });
  t.panel.latencyMs = (type) => (type === TYPES.TELEMETRY ? 3300 : 5);
  const ack = t.fire('onoff-0_27', 'on');
  await t.advance(6000, 50);
  refused(await ack, /rien envoyé/);
  assert.equal(t.panel.sets().length, 0);
});

test('a command waiting for the line when a stop is clicked never leaves after it', async () => {
  const t = await setup({ config: ALLOW });
  relay(t).state = 1;
  const read = await t.app.lane.acquire('read');
  const on = t.fire('onoff-1_23', 'on');
  await t.advance(100);
  const off = t.fire('onoff-0_27', 'off');
  await t.advance(50);
  read.release();
  await t.advance(5000, 50);
  refused(await on, /arrêt a été cliqué/);
  ok(await off);
  assert.equal(t.panel.state.lights[0].state, 0);
  assert.ok(t.panel.sets().every((r) => r.params.isOn === 0));
});

test('a stop retried within its 3 s: the controller back after 600 ms, confirmed in the ack', async () => {
  const t = await setup({ config: CFG });
  relay(t).state = 1;
  t.panel.down = true;
  t.clock.timers.setTimeout(() => (t.panel.down = false), 600);
  ok(await t.press('onoff-0_27', 'off'));
  assert.equal(relay(t).state, 0);
});

test('a stop first acked by a check counts no resend for that write', async () => {
  const t = await setup({ config: CFG });
  relay(t).state = 1;
  t.panel.down = true;
  refused(await t.press('onoff-0_27', 'off'), /sans confirmation|pas encore/);
  t.panel.down = false;
  t.panel.ignoreSet = true;
  await t.advance(3 * MINUTE, 200);
  const acked = t.panel.sets().length;
  assert.ok(acked >= 4, `${acked}`);
  assert.equal([...t.app.guards.values()][0].resends, 3, 'the unacked writes not counted');
  assert.match(t.status().text, /tenu/);
});

test('a restart writing a stop written before counts it as a resend', async () => {
  const store = memoryStore({
    target: { host: HOST, port: PORT, id: ID },
    stops: [kept('0_27', { written: true, acked: true, resends: 1 })],
  });
  const clock = testClock();
  const omni = fakeOmni({ timers: clock.timers });
  omni.state.relays[0].state = 1;
  omni.ignoreSet = true;
  const t = await setup({
    config: CFG,
    store,
    boot: true,
    clock,
    panel: omni,
    getConfigHangs: true,
  });
  assert.equal(omni.sets().length, 1);
  assert.equal([...t.app.guards.values()][0].resends, 2);
});

test('a stop not applied: written again 15 s apart at least, held after 4 writes', async () => {
  const t = await setup({ config: CFG });
  relay(t).state = 1;
  t.panel.ignoreSet = true;
  refused(await t.press('onoff-0_27', 'off', 4400), /pas encore appliqué/);
  await t.advance(3 * MINUTE, 200);
  const times = t.panel.sets().map((r) => r.at);
  assert.equal(times.length, 4);
  for (let k = 1; k < times.length; k += 1) {
    assert.ok(times[k] - times[k - 1] >= 15 * SECOND, `${times[k] - times[k - 1]} ms`);
  }
  assert.match(t.status().text, /tenu/);
});

test('a stop never sent goes at the first read that reaches the controller', async () => {
  const store = memoryStore({ target: { host: HOST, port: PORT, id: ID }, stops: [] });
  const t = await setup({ config: CFG, store });
  relay(t).state = 1;
  // The line held: the stop never leaves in its 3 s.
  const hold = await t.app.lane.acquire('check');
  hold.controller.signal.addEventListener('abort', () => {});
  t.app.lane.holder.kind = 'stop';
  refused(await t.press('onoff-0_27', 'off', 4400), /pas encore envoyé/);
  hold.release();
  await t.advance(3 * SECOND, 50);
  assert.equal(relay(t).state, 0);
});

test('a read begun less than 2 s after a write never judges the stop held', async () => {
  const t = await setup({ config: CFG });
  const guard = t.app.newGuard(
    { host: HOST, port: PORT },
    { obj: '0_27', attr: 'STATUS', value: 'OFF' },
  );
  const now = t.clock.monotonic();
  Object.assign(guard, { written: true, acked: true, resends: 3, sentAt: now - 1000 });
  assert.equal(t.app.decideStop(guard, { STATUS: 'ON' }, now), 'wait');
  assert.equal(t.app.decideStop(guard, { STATUS: 'ON' }, now + 1500), 'hold');
  assert.equal(t.app.decideStop(guard, { STATUS: 'STOPPING' }, now + 1500), 'heating');
  assert.equal(t.app.decideStop(guard, undefined, now + 1500), 'hold', 'unreadable is not shown');
});

test('values read more than 2 minutes ago are not sent to a device created now', async () => {
  const t = await setup({ config: { ...CFG, poll_interval: 600 }, create: false });
  await t.advance(3 * MINUTE, 1000);
  const count = t.gladys.fake.states.length;
  await t.until(t.gladys.fake.deviceCreated(t.gladys.fake.discoveredDevices[0]));
  await t.advance(2 * SECOND);
  const sent = t.gladys.fake.states.slice(count).map((s) => s.device_feature_external_id);
  assert.ok(!sent.includes(feature('onoff-1_3')), sent.join(','));
});

test('a check gives way, right before its write, to a command clicked during its read', async () => {
  const t = await setup({ config: ALLOW });
  relay(t).state = 1;
  t.panel.ignoreSet = true;
  refused(await t.press('onoff-0_27', 'off', 4400), /pas encore appliqué/);
  let on;
  let mark;
  t.panel.latencyMs = 300;
  t.panel.onRequest = (type) => {
    if (on || type !== TYPES.TELEMETRY || t.app.lane.holder?.kind !== 'check') return;
    t.panel.ignoreSet = false;
    mark = t.panel.sets().length;
    on = t.fire('onoff-0_27', 'on');
  };
  await t.advance(20 * SECOND, 50);
  ok(await on);
  const after = t.panel
    .sets()
    .slice(mark)
    .map((r) => r.params.isOn);
  assert.deepEqual(after, [1], 'the old stop never written after the command was clicked');
  assert.equal(relay(t).state, 1);
  assert.equal(t.app.guards.size, 0);
});

test('a /data whose load never ends: the stop still goes at once, start and reads go on', async () => {
  const store = memoryStore();
  store.load = () => new Promise(() => {});
  const t = await setup({ config: CFG, store, create: false });
  relay(t).state = 1;
  const start = t.clock.elapsed;
  const ack = t.fire('onoff-0_27', 'off');
  let at;
  ack.then(() => (at = t.clock.elapsed));
  await t.advance(5 * SECOND, 20);
  ok(await ack);
  assert.ok(at - start < SECOND, `${at - start} ms`);
  await t.advance(32 * SECOND, 100);
  assert.equal(t.status().connected, true, 'start not frozen');
  assert.equal(store.saves, 0, 'an unreadable /data is never overwritten');
});

test('the configuration not read and /data hanging: the stop answers at once, kept', async () => {
  const store = memoryStore();
  store.load = () => new Promise(() => {});
  const t = await setup({ config: CFG, store, create: false, getConfigHangs: true });
  const start = t.clock.elapsed;
  const ack = t.fire('onoff-0_27', 'off');
  let at;
  ack.then(() => (at = t.clock.elapsed));
  await t.advance(3 * SECOND, 20);
  refused(await ack, /gardé, envoyé en premier/);
  assert.ok(at - start < SECOND, `${at - start} ms: never waits for /data`);
  assert.equal(t.app.addressless.length, 1);
});

test('a save that hangs never stops the reads nor a new configuration', async () => {
  const t = await setup({ config: CFG });
  t.store.hang = new Promise(() => {});
  const reads = t.panel.count(TYPES.TELEMETRY);
  await t.advance(2 * MINUTE, 200);
  assert.ok(t.panel.count(TYPES.TELEMETRY) >= reads + 3);
  await t.until(t.app.configUpdated({ host: '192.168.1.61' }));
  assert.deepEqual(t.app.config.address, { host: '192.168.1.61', port: PORT });
});

test('a /data frozen: several stops in a row all leave, the checks still armed', async () => {
  const t = await setup({ config: CFG });
  t.store.hang = new Promise(() => {});
  t.panel.ignoreSet = true;
  relay(t).state = 1;
  t.panel.state.lights[0].state = 6;
  refused(await t.press('onoff-0_27', 'off'), /pas encore appliqué/);
  refused(await t.press('onoff-1_23', 'off'), /pas encore appliqué/);
  refused(await t.press('onoff-1_3', 'off'), /pas encore appliqué/);
  assert.equal(t.panel.sets().length, 3);
  t.panel.ignoreSet = false;
  await t.advance(20 * SECOND, 100);
  assert.equal(relay(t).state, 0);
  assert.equal(t.panel.state.lights[0].state, 0);
  assert.equal(t.app.guards.size, 0);
});

test('a save of a stop that failed is tried again', async () => {
  const t = await setup({ config: CFG });
  relay(t).state = 1;
  t.panel.ignoreSet = true;
  t.store.failSave = true;
  refused(await t.press('onoff-0_27', 'off'), /pas encore appliqué/);
  assert.deepEqual(t.store.data.stops ?? [], []);
  t.store.failSave = false;
  await t.advance(16 * SECOND, 100);
  assert.equal(t.store.data.stops.length, 1, 'saved at the next check');
});

test('a save that fails never blocks a stop', async () => {
  const t = await setup({ config: CFG });
  relay(t).state = 1;
  t.store.failSave = true;
  ok(await t.press('onoff-0_27', 'off'));
  assert.equal(relay(t).state, 0);
});

test('a /data read in 3 s: applied when it arrives, its stop sent, /data written again', async () => {
  const clock = testClock();
  const omni = fakeOmni({ timers: clock.timers });
  omni.state.relays[0].state = 1;
  const store = slowStore(
    clock,
    { target: { host: HOST, port: PORT, id: ID }, stops: [kept('0_27')] },
    3000,
  );
  const t = await setup({ config: { host: HOST }, clock, panel: omni, store, create: false });
  const booted = t.app.boot();
  await t.advance(4 * SECOND, 20);
  await booted;
  assert.equal(omni.state.relays[0].state, 0, 'the stop of /data sent');
  assert.equal(t.app.memoryUnreadable, false);
  await t.advance(2 * SECOND, 20);
  assert.ok(store.saves > 0, '/data written again');
  assert.deepEqual(store.data.stops, []);
});

test('a /data read late never undoes a command of this run that left', async () => {
  const clock = testClock();
  const omni = fakeOmni({ timers: clock.timers });
  const store = slowStore(clock, {
    target: { host: HOST, port: PORT, id: ID },
    stops: [kept('0_27')],
  });
  const t = await setup({ config: ALLOW, clock, panel: omni, store, create: false });
  // /data unreadable for now: a whole interval before the first read.
  await t.advance(31 * SECOND, 100);
  ok(await t.press('onoff-0_27', 'on'));
  store.release();
  await t.advance(30 * SECOND, 100);
  assert.equal(omni.state.relays[0].state, 1, 'the older stop of /data let go');
  assert.equal(omni.sets().filter((r) => r.params.isOn === 0).length, 0);
});

test('the same controller read at a new address: its kept stops follow it', async () => {
  const clock = testClock();
  const omni = fakeOmni({ timers: clock.timers });
  omni.state.relays[0].state = 1;
  omni.hostOk = (host, port) => host === '192.168.1.61' && port === PORT;
  const store = memoryStore({
    target: { host: HOST, port: PORT, id: ID },
    stops: [kept('0_27', { written: true })],
  });
  const t = await setup({
    config: { host: '192.168.1.61' },
    clock,
    panel: omni,
    store,
    boot: true,
  });
  await t.advance(40 * SECOND, 100);
  assert.equal(omni.state.relays[0].state, 0);
  assert.equal(t.app.guards.size, 0);
});

test('an option turned off while the first datagram of a batch waits for its ack: the next one never leaves', async () => {
  const t = await setup({ config: ALLOW });
  t.panel.latencyMs = (type) => (type === TYPES.SET_EQUIPMENT ? 600 : 5);
  t.panel.onRequest = (type) => {
    if (type === TYPES.SET_EQUIPMENT && t.panel.sets().length === 1) {
      t.app.configUpdated({ ...ALLOW, allow_equipment: false });
    }
  };
  const a = t.fire('onoff-0_27', 'on');
  const b = t.fire('onoff-8_14', 'on');
  await t.advance(6000, 50);
  await a;
  refused(await b, /pompes et relais.*pas autorisées/);
  assert.deepEqual(
    t.panel.sets().map((r) => r.params.equipmentId),
    [27],
  );
});

test('the deadline passed while the first datagram of a batch waits for its ack: the next one never leaves', async () => {
  const t = await setup({ config: ALLOW });
  t.panel.silentSet = true;
  const a = t.fire('onoff-0_27', 'on');
  const b = t.fire('onoff-8_14', 'on');
  await t.advance(6000, 50);
  refused(await a, /sans confirmation/);
  refused(await b, /rien envoyé/);
  assert.ok(t.panel.sets().every((r) => r.params.equipmentId === 27));
});

test('a stop never acked goes at the first read that reaches the controller, before its check', async () => {
  const t = await setup({ config: CFG });
  relay(t).state = 1;
  t.panel.down = true;
  refused(await t.press('onoff-0_27', 'off', 4400), /sans confirmation|pas encore/);
  t.panel.down = false;
  // The last read was more than an interval ago: a read may go now; the check is not due.
  t.app.lastAttemptAt = -Infinity;
  const read = t.app.tick();
  await t.advance(SECOND, 20);
  await read;
  assert.equal(relay(t).state, 0, 'written at the read, not at the 15 s check');
});

test('a command still in its gathering when a stop is clicked is answered at once', async () => {
  const t = await setup({ config: ALLOW });
  const on = t.fire('onoff-0_27', 'on');
  await t.advance(5, 1);
  const clicked = t.clock.elapsed;
  let at;
  on.then(() => (at = t.clock.elapsed));
  t.fire('onoff-1_3', 'off');
  await t.advance(100, 1);
  refused(await on, /arrêt a été cliqué/);
  assert.ok(at - clicked < 20, `${at - clicked} ms`);
  assert.equal(t.panel.sets().filter((r) => r.params.isOn === 1).length, 0);
});

test('"Test the connection" never rewrites an acked stop before 15 s nor counts a resend', async () => {
  const t = await setup({ config: CFG });
  relay(t).state = 1;
  t.panel.ignoreSet = true;
  refused(await t.press('onoff-0_27', 'off', 4400), /pas encore appliqué/);
  for (let k = 0; k < 3; k += 1) {
    const answer = t.app.testConnection();
    await t.advance(2 * SECOND, 20);
    await answer;
  }
  assert.equal(t.panel.sets().length, 1, 'no write sooner than 15 s after the last one');
  assert.equal([...t.app.guards.values()][0].resends, 0);
});

test('a check gives way, right before each datagram, to a command clicked while it writes', async () => {
  const t = await setup({ config: ALLOW });
  relay(t).state = 1;
  t.panel.state.lights[0].state = 6;
  t.panel.ignoreSet = true;
  // Two kept stops, both due: the same check writes them, one datagram each.
  const target = { host: HOST, port: PORT };
  for (const obj of ['0_27', '1_23']) {
    const guard = t.app.newGuard(target, { obj, attr: 'STATUS', value: 'OFF' });
    guard.written = true;
    t.app.guards.set(guard.key, guard);
  }
  let on;
  let mark;
  t.panel.onRequest = (type) => {
    if (on || type !== TYPES.SET_EQUIPMENT || t.app.lane.holder?.kind !== 'check') return;
    // The first datagram of the check: a command arrives (not on the line yet).
    mark = t.panel.sets().length;
    t.panel.ignoreSet = false;
    on = t.fire('onoff-8_14', 'on');
  };
  const check = t.app.runCheck(target);
  await t.advance(SECOND, 1);
  await check;
  await t.advance(5 * SECOND, 10);
  ok(await on);
  const after = t.panel
    .sets()
    .slice(mark)
    .map((r) => [r.params.equipmentId, r.params.isOn]);
  assert.deepEqual(after[0], [14, 100], 'the second stop of the check not written after the click');
});
