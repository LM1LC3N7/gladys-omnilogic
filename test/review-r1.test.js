// -----------------------------------------------------------------------------
// Review r1: heating resumed only within the bounds (I1), one test per guard
// the reviewer's mutants showed untested (I2: lane priority, a heater unit
// on, an unreadable heater, a command taking the line from a check, the stop
// retried within 3 s, the XML element bound, /data never through a link),
// and the minor points (filter heater extend, test button, follow-up read
// after an identity refusal, a slow ack, the fire pit).
// -----------------------------------------------------------------------------

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, symlink, writeFile, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Lane } from '../src/lane.js';
import { parseXml } from '../src/omni/xml.js';
import { fileStore } from '../src/store.js';
import { HOST, PORT, TYPES } from './fixtures/fakeOmni.js';
import { ALLOW, CFG, SECOND, ok, refused, setup } from './helpers.js';

const pool = (t) => t.panel.state.heaters[0];

test('I1: heating on refused while the set point held is above the pool ceiling, or unreadable', async () => {
  const t = await setup({ config: { ...ALLOW, max_pool_setpoint: 30 } });
  // The Hayward app left the pool at 100 °F (37.8 °C); the ceiling is 30 °C (86 °F).
  pool(t).setpoint = 100;
  await t.advance(31 * SECOND, 100);
  assert.match(t.status().text, /consigne gardée par le contrôleur dépasse/);
  refused(
    await t.press('heater-1_4', 'on'),
    /garde une consigne de 37,78 °C, au-dessus des 30 °C.*baissez/,
  );
  assert.equal(pool(t).enable, 0);
  assert.equal(t.panel.sets().length, 0);
  // Lowered first: then heating goes.
  ok(await t.press('setpoint-1_4', 29));
  ok(await t.press('heater-1_4', 'on'));
  assert.equal(pool(t).enable, 1);
  // 86 °F is the highest whole °F under 30 °C: allowed; 87 °F refused.
  const u = await setup({ config: { ...ALLOW, max_pool_setpoint: 30 } });
  u.panel.state.heaters[0].setpoint = 87;
  await u.advance(31 * SECOND, 100);
  refused(await u.press('heater-1_4', 'on'), /au-dessus des 30 °C/);
  u.panel.state.heaters[0].setpoint = 86;
  await u.advance(31 * SECOND, 100);
  ok(await u.press('heater-1_4', 'on'));
  // Unreadable held set point: refused.
  const v = await setup({ config: ALLOW });
  v.panel.state.heaters[0].setpoint = '';
  await v.advance(31 * SECOND, 100);
  refused(
    await v.press('heater-1_4', 'on'),
    /consigne gardée par ce chauffage.*ne peut pas être lue/,
  );
});

test('I1: a filter pump whose heater may heat: refused while the held set point is above the ceiling', async () => {
  const t = await setup({ config: { ...ALLOW, max_pool_setpoint: 30 } });
  t.panel.state.filters[0].state = 0;
  pool(t).enable = 1;
  pool(t).setpoint = 100;
  await t.advance(31 * SECOND, 100);
  refused(await t.press('onoff-1_3', 'on'), /au-dessus des 30 °C/);
  assert.equal(t.panel.sets().length, 0);
  // Its heater off and cold: the held set point does not matter.
  pool(t).enable = 0;
  await t.advance(31 * SECOND, 100);
  ok(await t.press('onoff-1_3', 'on'));
  // A spa at 104 °F (40 °C) is within its bound.
  ok(await t.press('onoff-8_10', 'on'));
});

test('I2 (M8): a stop goes before a read already waiting for the line', async () => {
  const lane = new Lane();
  const command = await lane.acquire('command');
  const order = [];
  const read = lane.acquire('read').then((h) => (order.push('read'), h.release()));
  const stop = lane.acquire('stop').then((h) => (order.push('stop'), h.release()));
  assert.equal(command.signal.aborted, true, 'the stop aborts the holder');
  command.release();
  await Promise.all([read, stop]);
  assert.deepEqual(order, ['stop', 'read']);
});

test('I2 (M51): a command takes the line from the check of a dead address', async () => {
  const t = await setup({ config: ALLOW });
  const dead = { host: '192.168.1.59', port: PORT };
  const guard = t.app.newGuard(dead, { obj: '0_27', attr: 'STATUS', value: 'OFF' });
  t.app.guards.set(guard.key, guard);
  const check = t.app.runCheck(dead);
  await t.advance(100, 10);
  assert.equal(t.app.lane.holder?.kind, 'check');
  const start = t.clock.elapsed;
  let at;
  const ack = t.fire('onoff-1_23', 'on');
  ack.then(() => (at = t.clock.elapsed));
  await t.advance(5 * SECOND, 20);
  ok(await ack);
  assert.ok(at - start < 4300, `${at - start} ms`);
  await t.advance(10 * SECOND, 100);
  await check;
});

test('I2 (M49): a filter pump needs "heating" while a heater unit of its body is on', async () => {
  const t = await setup({ config: { ...ALLOW, allow_heating: false } });
  t.panel.state.filters[0].state = 0;
  // The heater is disabled, but its unit still heats.
  t.panel.state.heaterUnits[0].state = 1;
  await t.advance(31 * SECOND, 100);
  refused(await t.press('onoff-1_3', 'on'), /chauffage doit aussi/);
  t.panel.state.heaterUnits[0].state = 0;
  await t.advance(31 * SECOND, 100);
  ok(await t.press('onoff-1_3', 'on'));
});

test('I2 (M48): a heater whose state cannot be read is never turned on', async () => {
  const t = await setup({ config: ALLOW });
  pool(t).enable = 'x';
  await t.advance(31 * SECOND, 100);
  refused(await t.press('heater-1_4', 'on'), /n'affiche pas/);
  assert.equal(t.panel.sets().length, 0);
});

test('I2 (M52): a stop that cannot leave is tried again every 250 ms within its 3 s', async () => {
  const t = await setup({ config: CFG });
  t.panel.state.relays[0].state = 1;
  // Unreachable (an error at once) for 600 ms, then the controller answers.
  t.panel.hostOk = () => 'error';
  t.clock.timers.setTimeout(() => (t.panel.hostOk = (h, p) => h === HOST && p === PORT), 600);
  ok(await t.press('onoff-0_27', 'off'));
  assert.equal(t.panel.state.relays[0].state, 0);
});

test('I2 (M44): an answer of more than 50,000 elements is refused', () => {
  assert.throws(() => parseXml(`<a>${'<b/>'.repeat(50_001)}</a>`), /too many elements/);
  assert.doesNotThrow(() => parseXml(`<a>${'<b/>'.repeat(1000)}</a>`));
});

test('I2 (M32): /data is never read through a symbolic link, and a save replaces the link', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'omni-link-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const real = join(dir, 'elsewhere.json');
  const path = join(dir, 'state.json');
  await writeFile(real, '{"stops":[]}');
  await symlink(real, path);
  const store = fileStore(path);
  assert.deepEqual(await store.load(), { unreadable: true });
  await store.save({ a: 1 });
  assert.equal(await readFile(real, 'utf8'), '{"stops":[]}', 'the target is never written');
  assert.deepEqual(await store.load(), { data: { a: 1 } });
});

test('m1: a filter in heater extend (5) is on; its stop is written again, then held', async () => {
  const t = await setup({ config: CFG });
  t.panel.state.filters[0].state = 5;
  await t.advance(31 * SECOND, 100);
  assert.equal(t.state('onoff-1_3').text, 'on');
  t.panel.ignoreSet = true;
  refused(await t.press('onoff-1_3', 'off'), /pas encore appliqué/);
  await t.advance(2 * 60 * SECOND, 200);
  assert.equal(t.panel.sets().length, 4, 'the click and 3 resends');
  assert.match(t.status().text, /tenu/);
});

test('m3: after an identity refusal, the configuration is read again within seconds', async () => {
  const t = await setup({ config: { ...ALLOW, poll_interval: 600 } });
  t.panel.state.checksum += 1;
  t.panel.state.relays.push({
    id: 40,
    bow: 0,
    name: 'Fountain',
    type: 'RLY_HIGH_VOLTAGE_RELAY',
    state: 0,
  });
  const configs = t.panel.count(TYPES.CONFIG);
  refused(await t.press('onoff-0_27', 'on'), /relus dans 5 s/);
  await t.advance(6 * SECOND, 50);
  assert.equal(t.panel.count(TYPES.CONFIG), configs + 1);
  ok(await t.press('onoff-0_27', 'on'));
});

test('m4: an ack after 1.2 s: one datagram, the command confirmed', async () => {
  const t = await setup({ config: ALLOW });
  t.panel.latencyMs = (type) => (type === TYPES.SET_EQUIPMENT ? 1200 : 5);
  ok(await t.press('onoff-0_27', 'on'));
  assert.equal(t.panel.sets().length, 1);
});

test('m6: a fire pit is never lit from Gladys; turning it off works', async () => {
  const t = await setup({ config: ALLOW });
  t.panel.state.relays[0].fn = 'RLY_FIREPIT';
  t.panel.state.checksum += 1;
  await t.advance(31 * SECOND, 100);
  refused(await t.press('onoff-0_27', 'on'), /foyer/);
  t.panel.state.relays[0].state = 1;
  ok(await t.press('onoff-0_27', 'off'));
});

test('I1: the held set point bound is the one of a write (ceiling rounded down, heater maximum)', async () => {
  const { heldSetpointProblem } = await import('../src/omni/model.js');
  const heater = (setpoint, maxF = 104) => ({
    values: { SETPOINT: String(setpoint) },
    config: { minF: 65, maxF },
  });
  // 21 °C is 69.8 °F: 69 may be resumed, 70 (21.11 °C) may not.
  assert.equal(heldSetpointProblem(heater(69), 21), undefined);
  assert.deepEqual(heldSetpointProblem(heater(70), 21), { above: 21.11, ceiling: 20.56 });
  // The heater's own maximum (90 °F) bounds it too.
  assert.ok(heldSetpointProblem(heater(95, 90), 35)?.above);
  assert.equal(heldSetpointProblem(heater(90, 90), 35), undefined);
  assert.deepEqual(heldSetpointProblem({ values: {}, config: { maxF: 104 } }, 35), {
    unreadable: true,
  });
  assert.deepEqual(heldSetpointProblem(heater(80, null), 35), { unreadable: true });
  // A spa: 104 °F (40 °C) may be resumed.
  assert.equal(heldSetpointProblem(heater(104), 40), undefined);
});
