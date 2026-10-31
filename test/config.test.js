// -----------------------------------------------------------------------------
// The configuration: addresses checked, options strictly true, the pool
// ceiling bounded (40 °C at most, rounded down).
// -----------------------------------------------------------------------------

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { normalizeConfig, parseAddress } from '../src/config.js';

test('addresses: IPv4 or host name, port 10444 by default; never broadcast, multicast, any', () => {
  assert.deepEqual(parseAddress('192.168.1.60'), { host: '192.168.1.60', port: 10444 });
  assert.deepEqual(parseAddress(' Omni.local:7000 '), { host: 'omni.local', port: 7000 });
  for (const bad of [
    '',
    '0.0.0.0',
    '255.255.255.255',
    '224.0.0.1',
    '239.1.2.3',
    '1.2.3',
    'a b',
    'x\r\ny',
    'http://x',
    'user@x',
    'x:0',
    'x:70000',
    '-x.local',
  ]) {
    assert.equal(parseAddress(bad), undefined, bad);
  }
});

test('options: only true allows; off by default', () => {
  const c = normalizeConfig({});
  assert.equal(c.allowEquipment, false);
  assert.equal(c.allowLights, false);
  assert.equal(c.allowHeating, false);
  assert.equal(normalizeConfig({ allow_heating: 'yes' }).allowHeating, false);
  assert.equal(normalizeConfig({ allow_heating: 'true' }).allowHeating, true);
  assert.equal(normalizeConfig({ allow_equipment: 1 }).allowEquipment, false);
});

test('the pool ceiling: 35 °C by default, 20 to 40, rounded down; the interval bounded', () => {
  assert.equal(normalizeConfig({}).poolCeiling, 35);
  assert.equal(normalizeConfig({ max_pool_setpoint: 45 }).poolCeiling, 40);
  assert.equal(normalizeConfig({ max_pool_setpoint: 10 }).poolCeiling, 20);
  assert.equal(normalizeConfig({ max_pool_setpoint: 32.9 }).poolCeiling, 32);
  assert.equal(normalizeConfig({ max_pool_setpoint: '' }).poolCeiling, 35);
  assert.equal(normalizeConfig({ max_pool_setpoint: true }).poolCeiling, 35);
  assert.equal(normalizeConfig({ poll_interval: 1 }).pollInterval, 15);
  assert.equal(normalizeConfig({ poll_interval: 'x' }).pollInterval, 30);
  assert.equal(normalizeConfig({ language: 'de' }).language, 'fr');
});
