// -----------------------------------------------------------------------------
// Start, reconnections and reads: getConfig() retried forever (also inside
// `connected`), never a read sooner than the interval (button, restart,
// Discovery), the configuration read again only on a new checksum, /data
// unreadable never overwritten, nothing stale published, another controller
// at the address said, configurations applied in order.
// -----------------------------------------------------------------------------

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { memoryStore } from '../src/store.js';
import { HOST, NOW, PORT, TYPES, fakeOmni } from './fixtures/fakeOmni.js';
import { CFG, DEVICE, ID, MINUTE, SECOND, feature, setup } from './helpers.js';
import { testClock } from './kit/clock.mjs';

const reads = (omni) => omni.count(TYPES.TELEMETRY);

test('getConfig failing inside connected: tried again every 30 s, then the controller is read', async () => {
  const t = await setup({ config: CFG, getConfigFails: 1, create: false });
  assert.equal(t.status().connected, false);
  assert.match(t.status().text, /configuration ne peut pas être lue/);
  assert.equal(reads(t.panel), 0);
  await t.advance(31 * SECOND, 100);
  assert.equal(t.status().connected, true, t.status().text);
  assert.ok(reads(t.panel) >= 1);
});

test('getConfig failing many times: retried without end', async () => {
  const t = await setup({ config: CFG, getConfigFails: 20, create: false });
  await t.advance(10 * MINUTE + 31 * SECOND, 500);
  assert.equal(t.status().connected, true);
});

test('polling: one telemetry per interval, the configuration once; the button never reads sooner', async () => {
  const t = await setup({ config: { ...CFG, poll_interval: 60 } });
  assert.equal(t.panel.count(TYPES.CONFIG), 1);
  const before = reads(t.panel);
  const answer = await t.until(t.app.testConnection());
  assert.match(answer.fr, /jamais avant l'intervalle/);
  assert.equal(reads(t.panel), before);
  await t.advance(61 * SECOND, 100);
  assert.equal(reads(t.panel), before + 1);
  assert.equal(t.panel.count(TYPES.CONFIG), 1, 'same checksum: the configuration not read again');
  await t.app.scan();
  await t.app.connected(CFG);
  assert.equal(reads(t.panel), before + 1, 'neither Discovery nor a reconnection reads');
});

test('a new checksum: the configuration read again, new equipment published', async () => {
  const t = await setup({ config: CFG });
  t.panel.state.relays.push({
    id: 40,
    bow: 0,
    name: 'Fountain',
    type: 'RLY_HIGH_VOLTAGE_RELAY',
    state: 0,
  });
  t.panel.state.checksum += 1;
  await t.advance(31 * SECOND, 100);
  assert.equal(t.panel.count(TYPES.CONFIG), 2);
  const device = t.gladys.fake.discoveredDevices.at(-1);
  assert.ok(device.features.some((f) => f.external_id === feature('onoff-0_40')));
  assert.equal(device.external_id, DEVICE, 'same bodies: same device');
});

test('a restart never reads sooner than the interval (time kept in /data before the read)', async () => {
  const store = memoryStore();
  await setup({ config: CFG, store });
  assert.ok(store.data.lastAttemptAt >= NOW);
  const clock = testClock({ start: NOW + 5 * SECOND });
  const omni = fakeOmni({ timers: clock.timers });
  const u = await setup({ config: CFG, store, clock, panel: omni, create: false });
  assert.equal(reads(omni), 0, 'not read at the restart');
  const answer = await u.until(u.app.testConnection());
  assert.match(answer.fr, /jamais avant l'intervalle/);
  assert.equal(reads(omni), 0);
  await u.advance(30 * SECOND, 200);
  assert.ok(reads(omni) > 0);
});

test('/data unreadable: never overwritten, a whole interval before the first read', async () => {
  const store = memoryStore({ x: 1 }, { unreadable: true });
  const t = await setup({ config: CFG, store, create: false });
  assert.equal(reads(t.panel), 0);
  await t.advance(31 * SECOND, 200);
  assert.ok(reads(t.panel) > 0);
  assert.equal(store.saves, 0);
  assert.deepEqual(store.data, { x: 1 });
});

test('a failed read: offline status, backoff, the badge unreachable, only the status published', async () => {
  const t = await setup({ config: CFG });
  t.panel.down = true;
  const states = t.gladys.fake.states.length;
  await t.advance(40 * SECOND, 100);
  assert.equal(t.status().connected, false);
  assert.match(t.status().text, /ne répond pas à 192\.168\.1\.60 \(UDP\)/);
  const after = t.gladys.fake.states.slice(states);
  assert.deepEqual(
    [...new Set(after.map((s) => s.device_feature_external_id))],
    [feature('status')],
  );
  assert.equal(after.at(-1).text, 'Contrôleur injoignable');
  t.panel.down = false;
  await t.advance(31 * SECOND, 100);
  assert.equal(t.status().connected, true);
});

test('nothing stale: a device created after the controller stopped answering gets no old value', async () => {
  const t = await setup({ config: CFG, create: false });
  const created = t.gladys.fake.discoveredDevices[0];
  t.panel.down = true;
  await t.advance(3 * MINUTE, 500);
  const count = t.gladys.fake.states.length;
  await t.until(t.gladys.fake.deviceCreated(created));
  await t.advance(2 * SECOND);
  const published = t.gladys.fake.states.slice(count);
  assert.ok(
    published.every((s) => s.device_feature_external_id === feature('status')),
    published.map((s) => s.device_feature_external_id).join(','),
  );
});

test('a read begun before a write left is not applied', async () => {
  const t = await setup({ config: CFG });
  t.app.lastSentAt = t.clock.monotonic() + 60 * SECOND;
  t.panel.state.relays[0].state = 1;
  const count = t.gladys.fake.states.length;
  await t.advance(31 * SECOND, 100);
  assert.ok(
    !t.gladys.fake.states
      .slice(count)
      .some((s) => s.device_feature_external_id === feature('onoff-0_27')),
  );
});

test('another controller at the address: the created device unreachable, said in the status', async () => {
  const t = await setup({ config: CFG });
  t.panel.state.bodies[1].id = 9;
  t.panel.state.checksum += 1;
  await t.advance(31 * SECOND, 100);
  assert.equal(t.status().connected, false);
  assert.match(t.status().text, /Un autre contrôleur répond/);
  assert.ok(t.gladys.fake.devices.some((d) => d.external_id === DEVICE));
  assert.notEqual(t.app.panel.id, ID);
});

test('configurations saved in a row apply one at a time, the last one wins', async () => {
  const t = await setup({ config: CFG });
  const a = t.app.configUpdated({ host: '192.168.1.61' });
  const b = t.app.configUpdated({ host: HOST, allow_lights: true });
  await t.until(Promise.all([a, b]));
  await t.advance(SECOND);
  assert.deepEqual(t.app.config.address, { host: HOST, port: PORT });
  assert.equal(t.app.config.allowLights, true);
  assert.equal(t.status().connected, true);
});

test('an invalid address is said, nothing read', async () => {
  const t = await setup({ config: { host: '255.255.255.255' }, create: false });
  assert.match(t.status().text, /n'est ni une adresse IPv4/);
  assert.equal(reads(t.panel), 0);
});

test('a controller in service mode: said in the status', async () => {
  const t = await setup({ config: CFG });
  t.panel.state.backyard.state = 2;
  await t.advance(31 * SECOND, 100);
  assert.match(t.status().text, /mode service/);
});

test('shutdown writes /data and closes the socket', async () => {
  const t = await setup({ config: CFG });
  await t.until(t.app.shutdown());
  assert.equal(t.panel.open, 0);
  assert.ok(Number.isFinite(t.store.data.lastAttemptAt));
});
