// -----------------------------------------------------------------------------
// The stops (an equipment off, a heater off) are never held back: options
// off, a stuck read, commands waiting, a controller down, lost acks, /data
// hung, the configuration not read, a restart. A stop that never left is
// never given up; one the controller acks without effect is written 3 more
// times, then held (said in the status) until the controller shows it, a new
// click, or a newer command that left.
// -----------------------------------------------------------------------------

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { memoryStore } from '../src/store.js';
import { HOST, PORT, TYPES } from './fixtures/fakeOmni.js';
import { ALLOW, CFG, ID, MINUTE, SECOND, ok, refused, setup } from './helpers.js';

const relay = (t) => t.panel.state.relays[0];
const setsOf = (omni) => omni.sets().map((r) => [r.type, r.params]);

test('an equipment off and a heater off work with every option off', async () => {
  const t = await setup({ config: CFG });
  relay(t).state = 1;
  const start = t.clock.elapsed;
  const ack = t.fire('onoff-0_27', 'off');
  let at;
  ack.then(() => (at = t.clock.elapsed));
  await t.advance(5000, 20);
  ok(await ack);
  assert.ok(at - start < 4300, `${at - start} ms`);
  assert.equal(relay(t).state, 0);
  ok(await t.press('heater-8_11', 'off'));
  assert.equal(t.panel.state.heaters[1].enable, 0);
  ok(await t.press('onoff-1_3', 'off'));
  assert.equal(t.panel.state.filters[0].state, 0);
  assert.equal(t.app.guards.size, 0);
  assert.deepEqual(t.store.data.stops, []);
  assert.deepEqual(setsOf(t.panel)[0], [
    TYPES.SET_EQUIPMENT,
    {
      poolId: 0,
      equipmentId: 27,
      isOn: 0,
      IsCountDownTimer: 0,
      StartTimeHours: 0,
      StartTimeMinutes: 0,
      EndTimeHours: 0,
      EndTimeMinutes: 0,
      DaysActive: 0,
      Recurring: 0,
    },
  ]);
  assert.deepEqual(setsOf(t.panel)[1], [
    TYPES.HEATER_ENABLE,
    { poolId: 8, HeaterID: 11, Enabled: 0 },
  ]);
});

test('a stop cuts a stuck read (not a failure) and goes on a new socket', async () => {
  const t = await setup({ config: CFG });
  relay(t).state = 1;
  t.panel.latencyMs = (type) => (type === TYPES.SET_EQUIPMENT ? 5 : 60 * SECOND);
  await t.advance(31 * SECOND, 100);
  assert.equal(t.app.lane.holder?.kind, 'read');
  t.panel.latencyMs = (type) =>
    type === TYPES.SET_EQUIPMENT ? 5 : t.app.lane.holder?.kind === 'stop' ? 5 : 60 * SECOND;
  ok(await t.press('onoff-0_27', 'off', 4300));
  assert.equal(relay(t).state, 0);
  assert.ok(t.panel.peak <= 1, 'never two sockets at once');
  assert.equal(t.app.panel.online, true, 'the cut read is not a failure');
});

test('a command clicked before a stop and not left never leaves after it', async () => {
  const t = await setup({ config: ALLOW });
  t.panel.latencyMs = 300;
  const on = t.fire('onoff-0_27', 'on');
  await t.advance(20);
  const off = t.fire('onoff-0_27', 'off');
  await t.advance(6000, 50);
  refused(await on, /arrêt a été cliqué/);
  ok(await off);
  assert.equal(relay(t).state, 0);
  assert.ok(setsOf(t.panel).every(([, p]) => p.isOn === 0));
});

test('a stop cutting a command on its way: its datagram never sent again after the stop', async () => {
  const t = await setup({ config: ALLOW });
  t.panel.latencyMs = 600;
  const on = t.fire('onoff-0_27', 'on');
  await t.advance(700);
  const off = t.fire('onoff-0_27', 'off');
  await t.advance(6000, 50);
  // It had left (its ack awaited): sent, never confirmed, never "nothing sent".
  refused(await on, /sans confirmation/);
  ok(await off);
  assert.equal(relay(t).state, 0);
  const sets = setsOf(t.panel).map(([, p]) => p.isOn);
  assert.deepEqual(sets, [1, 0], 'the command once, then the stop; nothing after it');
});

test('a controller down: the stop is kept, never given up, sent once it answers', async () => {
  const t = await setup({ config: CFG });
  relay(t).state = 1;
  t.panel.down = true;
  refused(await t.press('onoff-0_27', 'off'), /sans confirmation|pas encore/);
  assert.equal(t.store.data.stops.length, 1);
  await t.advance(10 * MINUTE, 500);
  assert.equal(t.app.guards.size, 1, 'never given up');
  assert.equal([...t.app.guards.values()][0].resends, 0, 'no ack: no resend counted');
  assert.equal(relay(t).state, 1);
  t.panel.down = false;
  await t.advance(16 * SECOND, 100);
  assert.equal(relay(t).state, 0);
  assert.equal(t.app.guards.size, 0);
  assert.deepEqual(t.store.data.stops, []);
});

test('acked without effect: written 3 more times, then held, said; let go when shown', async () => {
  const t = await setup({ config: CFG });
  relay(t).state = 1;
  t.panel.ignoreSet = true;
  refused(await t.press('onoff-0_27', 'off'), /pas encore appliqué/);
  await t.advance(2 * MINUTE, 200);
  assert.equal(t.panel.sets().length, 4, 'the click and 3 resends');
  const guard = [...t.app.guards.values()][0];
  assert.equal(guard.resends, 3);
  assert.match(t.status().text, /écrit 4 fois sans effet : tenu/);
  await t.advance(5 * MINUTE, 500);
  assert.equal(t.panel.sets().length, 4, 'held: no more writes, never let go by time');
  assert.equal(t.app.guards.size, 1);
  t.fire('onoff-0_27', 'off');
  await t.advance(5 * SECOND, 50);
  assert.equal(t.panel.sets().length, 5, 'a new click writes again');
  assert.equal(guard.resends, 0);
  relay(t).state = 0;
  await t.advance(31 * SECOND, 200);
  assert.equal(t.app.guards.size, 0);
});

test('a filter in cool-down after its stop: watched, never written again, then let go', async () => {
  const t = await setup({ config: CFG });
  t.panel.coolDownMs = 3 * MINUTE;
  refused(await t.press('onoff-1_3', 'off'), /fin de marche/);
  assert.match(t.status().text, /refroidissement/);
  await t.advance(2 * MINUTE, 500);
  assert.equal(t.panel.sets().length, 1, 'running down is not "not applied"');
  await t.advance(2 * MINUTE, 500);
  assert.equal(t.app.guards.size, 0);
});

test('a heater off while its unit still heats: watched; the state unknown is said', async () => {
  const t = await setup({ config: CFG });
  t.panel.state.heaterUnits[1].state = 1;
  t.panel.heaterRunsMs = MINUTE;
  refused(await t.press('heater-8_11', 'off'), /fin de marche/);
  await t.advance(30 * SECOND, 200);
  assert.equal(t.panel.sets().length, 1);
  assert.match(t.status().text, /Arrêt \(chauffage arrêté\)/);
  await t.advance(MINUTE, 200);
  assert.equal(t.app.guards.size, 0);
});

test('a newer command that left lets the kept stop go', async () => {
  const t = await setup({ config: ALLOW });
  relay(t).state = 1;
  t.panel.ignoreSet = true;
  refused(await t.press('onoff-0_27', 'off'), /pas encore appliqué/);
  t.panel.ignoreSet = false;
  relay(t).state = 0;
  ok(await t.press('onoff-0_27', 'on'));
  assert.equal(t.app.guards.size, 0, 'let go');
  const before = t.panel.sets().length;
  await t.advance(MINUTE, 200);
  assert.equal(t.panel.sets().length, before, 'never countered');
  assert.equal(relay(t).state, 1);
});

test('a newer command never sent does not let the stop go', async () => {
  const t = await setup({ config: { ...ALLOW, allow_equipment: false } });
  relay(t).state = 1;
  t.panel.ignoreSet = true;
  refused(await t.press('onoff-0_27', 'off'), /pas encore appliqué/);
  refused(await t.press('onoff-0_27', 'on'), /pas autorisées/);
  assert.equal(t.app.guards.size, 1);
});

test('during a heater stop not seen applied: set point and filter on refused', async () => {
  const t = await setup({ config: ALLOW });
  t.panel.ignoreSet = true;
  refused(await t.press('heater-8_11', 'off'), /pas encore appliqué/);
  refused(await t.press('setpoint-8_11', 30, SECOND), /arrêt du chauffage de ce bassin/);
  refused(await t.press('onoff-8_10', 'on', SECOND), /arrêt du chauffage de ce bassin/);
  assert.ok(
    setsOf(t.panel).every(([type]) => type === TYPES.HEATER_ENABLE),
    'only the stop is written',
  );
});

test('several stops clicked together: each sent, one datagram each', async () => {
  const t = await setup({ config: CFG });
  relay(t).state = 1;
  t.panel.state.lights[0].state = 6;
  t.panel.latencyMs = 200;
  t.app.lane.acquire('read').then((h) => t.clock.timers.setTimeout(() => h.release(), 50));
  const acks = ['onoff-0_27', 'onoff-1_23', 'onoff-1_3'].map((r) => t.fire(r, 'off'));
  await t.advance(5000, 20);
  for (const ack of acks) ok(await ack);
  assert.equal(relay(t).state, 0);
  assert.equal(t.panel.state.lights[0].state, 0);
  assert.equal(t.panel.state.filters[0].state, 0);
  assert.equal(t.panel.sets().length, 3);
});

test('a /data that hangs never holds a stop back', async () => {
  const t = await setup({ config: CFG });
  relay(t).state = 1;
  t.store.hang = new Promise(() => {});
  ok(await t.press('onoff-0_27', 'off'));
  assert.equal(relay(t).state, 0);
  t.panel.state.lights[0].state = 6;
  ok(await t.press('onoff-1_23', 'off'));
  assert.equal(t.panel.state.lights[0].state, 0);
});

test('a restart sends a kept stop before the configuration; a held one is only checked', async () => {
  const stop = (obj, attr, value, written, resends) => ({
    host: HOST,
    port: PORT,
    obj,
    attr,
    value,
    since: 0,
    written,
    resends,
  });
  const store = memoryStore({
    target: { host: HOST, port: PORT, id: ID },
    stops: [
      { ...stop('0_27', 'STATUS', 'OFF', true, 1), acked: true },
      { ...stop('1_36', 'STATUS', 'OFF', true, 3), acked: true },
      stop('8_11', 'ENABLE', '0', false, 2),
    ],
  });
  const omniState = (t) => t.panel.state;
  const t = await setup({ config: CFG, store, boot: true, getConfigHangs: true });
  const writes = setsOf(t.panel);
  assert.deepEqual(
    writes.map(([type, p]) => [type, p.equipmentId ?? p.HeaterID]),
    [
      [TYPES.SET_EQUIPMENT, 27],
      [TYPES.HEATER_ENABLE, 11],
    ],
    'sent before getConfig answered, the held one not written',
  );
  assert.equal(omniState(t).heaters[1].enable, 0);
  // The held stop (relay 36 still on) is only checked: never written by a restart.
  await t.advance(20 * SECOND, 100);
  assert.equal(setsOf(t.panel).length, 2);
  assert.equal(omniState(t).relays[1].state, 1);
  // Left: the held one, and the heater stop whose heaters are unknown without the configuration.
  assert.deepEqual([...t.app.guards.values()].map((g) => g.obj).sort(), ['1_36', '8_11']);
  assert.equal([...t.app.guards.values()].find((g) => g.obj === '8_11').heatUnknown, true);
});

test('getConfig failing: a stop still goes to the address kept in /data', async () => {
  const store = memoryStore({ target: { host: HOST, port: PORT, id: ID }, stops: [] });
  const t = await setup({ config: CFG, store, getConfigFails: 100, create: false });
  assert.match(t.status().text, /configuration ne peut pas être lue/);
  relay(t).state = 1;
  ok(await t.press('onoff-0_27', 'off'));
  assert.equal(relay(t).state, 0);
});

test('no address at all: the stop says so, and goes first once one is known', async () => {
  const t = await setup({ config: {}, create: false });
  relay(t).state = 1;
  refused(await t.press('onoff-0_27', 'off'), /Aucune adresse de contrôleur/);
  t.gladys.fake.updateConfig?.(CFG);
  await t.until(t.app.configUpdated(CFG));
  await t.advance(5 * SECOND);
  assert.equal(relay(t).state, 0);
  assert.equal(t.panel.sets()[0].params.equipmentId, 27);
});

test('a stop with a lost ack: tried again within its 3 s, confirmed by the read back', async () => {
  const t = await setup({ config: CFG });
  relay(t).state = 1;
  t.panel.dropAcks = 1;
  ok(await t.press('onoff-0_27', 'off'));
  assert.equal(relay(t).state, 0);
  assert.equal(t.app.guards.size, 0);
});

test('a heater stop not applied: a late command on its way countered', async () => {
  const t = await setup({ config: ALLOW });
  // Heating asked, no ack (it may land late), then the stop.
  t.panel.silentSet = true;
  refused(await t.press('heater-1_4', 'on'), /sans confirmation/);
  t.panel.silentSet = false;
  ok(await t.press('heater-1_4', 'off'));
  assert.equal(t.app.guards.size, 1, 'watched for the late command');
  t.panel.state.heaters[0].enable = 1;
  await t.advance(20 * SECOND, 100);
  assert.equal(t.panel.state.heaters[0].enable, 0, 'countered');
  await t.advance(40 * SECOND, 100);
  assert.equal(t.app.guards.size, 0);
});

test('a kept stop never acked goes at once on "Test the connection"', async () => {
  const t = await setup({ config: CFG });
  relay(t).state = 1;
  t.panel.down = true;
  refused(await t.press('onoff-0_27', 'off', 4400), /sans confirmation|pas encore/);
  t.panel.down = false;
  const answer = t.app.testConnection();
  await t.advance(2 * SECOND, 20);
  await answer;
  assert.equal(relay(t).state, 0, 'sent before the 15 s check');
});

test('a stop on one equipment: a command waiting for another one gives way too', async () => {
  const t = await setup({ config: ALLOW });
  t.panel.latencyMs = 300;
  const on = t.fire('onoff-0_27', 'on');
  await t.advance(10);
  const off = t.fire('onoff-1_3', 'off');
  await t.advance(6000, 50);
  refused(await on, /arrêt a été cliqué/);
  ok(await off);
  assert.equal(relay(t).state, 0);
});

test('a stop with an unknown owner (another controller answers): still sent', async () => {
  const t = await setup({ config: CFG });
  // The bodies change: the identity of the controller read no longer matches.
  t.panel.state.bodies[1].id = 9;
  relay(t).state = 1;
  await t.press('onoff-0_27', 'off');
  assert.equal(relay(t).state, 0);
});
