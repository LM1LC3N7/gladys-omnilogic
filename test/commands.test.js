// -----------------------------------------------------------------------------
// The commands that start something: refused by default, each behind its
// option, decided on a fresh telemetry, set points bounded after the °F
// conversion, confirmed only by the read back.
// -----------------------------------------------------------------------------

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { TYPES } from './fixtures/fakeOmni.js';
import { ALLOW, CFG, MINUTE, SECOND, ok, refused, setup } from './helpers.js';

test('every command that starts something is refused by default; nothing sent', async () => {
  const t = await setup({ config: CFG });
  for (const [role, value] of [
    ['onoff-0_27', 'on'],
    ['onoff-1_23', 'on'],
    ['onoff-8_10', 'on'],
    ['heater-1_4', 'on'],
    ['setpoint-1_4', 28],
  ]) {
    refused(await t.press(role, value, SECOND), /pas autorisées/);
  }
  assert.equal(t.panel.sets().length, 0);
});

test('a light needs "lights" only, a relay or pump "pumps and relays" only', async () => {
  const t = await setup({ config: { ...CFG, allow_lights: true } });
  ok(await t.press('onoff-1_23', 'on'));
  assert.equal(t.panel.state.lights[0].state, 6);
  refused(await t.press('onoff-0_27', 'on', SECOND), /pompes et relais/);
  const u = await setup({ config: { ...CFG, allow_equipment: true } });
  ok(await u.press('onoff-0_27', 'on'));
  ok(await u.press('onoff-8_14', 'on'));
  assert.equal(u.panel.state.pumps[0].speed, 100, 'its last speed');
  refused(await u.press('onoff-1_23', 'on', SECOND), /éclairages/);
});

test('a filter pump whose heater is not seen off needs "heating" too', async () => {
  // The spa heater (11) is on: its filter (10) may start the heating.
  const t = await setup({ config: { ...CFG, allow_equipment: true } });
  refused(await t.press('onoff-8_10', 'on', SECOND), /chauffage doit aussi/);
  assert.equal(t.panel.sets().length, 0);
  // The pool heater (4) is off and not heating: the pool filter needs only its option.
  t.panel.state.filters[0].state = 0;
  await t.advance(31 * SECOND, 100);
  ok(await t.press('onoff-1_3', 'on'));
  assert.equal(t.panel.state.filters[0].state, 1);
  assert.equal(t.panel.sets().at(-1).params.isOn, 50, 'its last speed, within its limits');
  const u = await setup({ config: ALLOW });
  ok(await u.press('onoff-8_10', 'on'));
});

test('an option turned off between the fresh read and the datagram: nothing sent', async () => {
  const t = await setup({ config: ALLOW });
  t.panel.latencyMs = 400;
  const ack = t.fire('onoff-0_27', 'on');
  await t.advance(200);
  await t.app.configUpdated({ ...ALLOW, allow_equipment: false });
  await t.advance(4000, 50);
  refused(await ack, /pompes et relais.*pas autorisées/);
  assert.equal(t.panel.sets().length, 0);
});

test('set points: a spa up to 40 °C (104 °F), a pool up to its ceiling, bounded after conversion', async () => {
  const t = await setup({ config: ALLOW });
  ok(await t.press('setpoint-8_11', 40));
  assert.equal(t.panel.state.heaters[1].setpoint, 104);
  refused(await t.press('setpoint-8_11', 40.5, SECOND), /hors bornes : 18,33 à 40 °C/);
  ok(await t.press('setpoint-1_4', 35));
  assert.equal(t.panel.state.heaters[0].setpoint, 95);
  refused(await t.press('setpoint-1_4', 35.5, SECOND), /hors bornes : 18,33 à 35 °C/);
  refused(await t.press('setpoint-1_4', 15, SECOND), /hors bornes/);
  const u = await setup({ config: { ...ALLOW, max_pool_setpoint: 30.7 } });
  refused(await u.press('setpoint-1_4', 30.5, SECOND), /hors bornes : 18,33 à 30 °C/);
  ok(await u.press('setpoint-1_4', 29.5));
  assert.equal(u.panel.state.heaters[0].setpoint, 85);
  assert.ok(u.panel.sets().every((r) => r.type !== TYPES.SET_HEATER || r.params.Temp <= 86));
});

test('the limits of the heater are bounds too; unknown limits: nothing sent', async () => {
  const t = await setup({ config: ALLOW });
  t.panel.state.heaters[1].max = 100;
  t.panel.state.checksum += 1;
  await t.advance(31 * SECOND, 100);
  refused(await t.press('setpoint-8_11', 38.5, SECOND), /hors bornes : 18,33 à 37,78 °C/);
  t.panel.configText = (await import('./fixtures/fakeOmni.js'))
    .configXml(t.panel.state)
    .replace(/<Max-Settable-Water-Temp>\d+<\/Max-Settable-Water-Temp>/g, '');
  t.panel.state.checksum += 1;
  await t.advance(31 * SECOND, 100);
  refused(await t.press('setpoint-8_11', 30, SECOND), /limites de consigne/);
  assert.ok(t.panel.sets().every((r) => r.type !== TYPES.SET_HEATER));
});

test('heater on: behind "heating"; an unknown value refused', async () => {
  const t = await setup({ config: ALLOW });
  ok(await t.press('heater-1_4', 'on'));
  assert.equal(t.panel.state.heaters[0].enable, 1);
  refused(await t.press('heater-1_4', 'boost', SECOND), /Valeur invalide/);
  refused(await t.press('onoff-0_27', 'ON ', SECOND), /Valeur invalide/);
});

test('confirmed only by the read back: not applied, no ack, no read back', async () => {
  const t = await setup({ config: ALLOW });
  t.panel.ignoreSet = true;
  refused(await t.press('onoff-0_27', 'on'), /pas encore appliqué/);
  t.panel.ignoreSet = false;
  t.panel.silentSet = 'applied';
  refused(await t.press('onoff-1_23', 'on'), /sans confirmation/);
  t.panel.silentSet = false;
  // The read back (every telemetry after the command) never answers in time.
  let slow = false;
  t.panel.onRequest = (type) => {
    if (type === TYPES.SET_EQUIPMENT && t.panel.sets().length >= 3) slow = true;
  };
  t.panel.latencyMs = (type) => (type === TYPES.TELEMETRY && slow ? 10 * SECOND : 5);
  await t.advance(MINUTE, 500);
  refused(await t.press('onoff-8_14', 'on'), /sans confirmation/);
});

test('already so: success without sending; the same setting twice in one batch: the last wins', async () => {
  const t = await setup({ config: ALLOW });
  ok(await t.press('onoff-1_36', 'on'));
  assert.equal(t.panel.sets().length, 0);
  // 29 °C is 84 °F (already so), 28 °C is 82 °F: the later one wins either way.
  const a = t.fire('setpoint-1_4', 28);
  const b = t.fire('setpoint-1_4', 29);
  await t.advance(5000, 50);
  refused(await a, /plus récente/);
  ok(await b);
  assert.equal(t.panel.sets().length, 0, 'the earlier one never sent');
  const c = t.fire('setpoint-1_4', 29);
  const d = t.fire('setpoint-1_4', 28);
  await t.advance(5000, 50);
  refused(await c, /plus récente/);
  ok(await d);
  assert.equal(t.panel.sets().length, 1);
  assert.equal(t.panel.state.heaters[0].setpoint, 82);
});

test('a scene on 5 settings, a slow controller (500-900 ms): all set', async () => {
  const t = await setup({ config: ALLOW });
  let k = 0;
  t.panel.latencyMs = () => 500 + ((k += 1) % 5) * 100;
  // A scene: one batch, each a datagram; a slow answer is slower than 3.5 s in total.
  const acks = [
    t.fire('onoff-0_27', 'on'),
    t.fire('onoff-1_23', 'on'),
    t.fire('onoff-8_14', 'on'),
    t.fire('setpoint-1_4', 30),
    t.fire('heater-1_4', 'on'),
  ];
  await t.advance(6000, 50);
  const results = await Promise.all(acks);
  const sent = t.panel.sets().length;
  // Each either set, or refused unsent at its deadline: never a datagram after it.
  for (const r of results) {
    assert.ok(r.success || /rien envoyé|à temps|sans confirmation/.test(r.error), r.error);
  }
  assert.ok(sent >= 2, `${sent} sent`);
  // On a controller answering within 50 ms, all five are set.
  const u = await setup({ config: ALLOW });
  u.panel.latencyMs = 50;
  const all = [
    u.fire('onoff-0_27', 'on'),
    u.fire('onoff-1_23', 'on'),
    u.fire('onoff-8_14', 'on'),
    u.fire('setpoint-1_4', 30),
    u.fire('heater-1_4', 'on'),
  ];
  await u.advance(6000, 50);
  for (const r of await Promise.all(all)) ok(r);
});

test('a controller that never gives the turn in time: nothing sent, answered by 4.3 s', async () => {
  const t = await setup({ config: ALLOW });
  const hold = await t.app.lane.acquire('read');
  const start = t.clock.elapsed;
  const ack = t.fire('onoff-0_27', 'on');
  let at;
  ack.then(() => (at = t.clock.elapsed));
  await t.advance(5000, 50);
  refused(await ack, /à temps : rien envoyé/);
  assert.ok(at - start <= 4300, `${at - start}`);
  hold.release();
  assert.equal(t.panel.sets().length, 0);
});

test('another controller or a changed configuration at the address: nothing sent', async () => {
  const t = await setup({ config: ALLOW });
  t.panel.state.checksum += 1;
  refused(await t.press('onoff-0_27', 'on', SECOND * 5), /autre contrôleur|configuration a changé/);
  assert.equal(t.panel.sets().length, 0);
});

test('service mode or a backyard state unreadable: commands refused, stops sent', async () => {
  const t = await setup({ config: ALLOW });
  t.panel.state.backyard.state = 2;
  refused(await t.press('onoff-0_27', 'on'), /mode service/);
  t.panel.state.relays[1].state = 1;
  ok(await t.press('onoff-1_36', 'off'));
  assert.equal(t.panel.state.relays[1].state, 0);
});

test('a read-only feature and an unknown feature take no command', async () => {
  const t = await setup({ config: ALLOW });
  refused(await t.press('water-temp-1_1', 30, SECOND), /aucune commande/);
  refused(await t.press('onoff-1_22', 'on', SECOND), /aucune commande|n'affiche pas/);
  refused(await t.press('onoff-1_99', 'on', SECOND), /n'affiche pas/);
});
