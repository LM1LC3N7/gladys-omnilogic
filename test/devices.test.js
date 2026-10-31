// -----------------------------------------------------------------------------
// The device of the controller: ids parsed strictly, the units and options
// the core accepts (its own normalizeSupportedOptions when the clone is
// there, else the same rules), no switch, the states of one read (never a
// text nor an unavailable value as a measure), features of the created
// device kept.
// -----------------------------------------------------------------------------

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import {
  COMMAND_KINDS,
  buildDevice,
  deviceStates,
  parseDeviceId,
  parseFeatureId,
} from '../src/devices.js';
import { mergeObjects, parseConfig, parseTelemetry } from '../src/omni/model.js';
import { configXml, initialState, telemetryXml } from './fixtures/fakeOmni.js';

const CORE = '/home/claude/code/Gladys/server/utils';
const require = createRequire(import.meta.url);
const core = existsSync(`${CORE}/constants.js`) ? require(`${CORE}/constants.js`) : undefined;
let normalizeSupportedOptions;
try {
  normalizeSupportedOptions = require(
    `${CORE}/normalizeSupportedOptions.js`,
  ).normalizeSupportedOptions;
} catch {
  normalizeSupportedOptions = undefined;
}

const gladys = {
  externalIds: (type, id) => ({
    device: `ext:test:${type}:${id}`,
    feature: (key) => `ext:test:${type}:${id}:${key}`,
  }),
};
const ID = '0123456789abcdef';
const ids = gladys.externalIds('omnilogic', ID);
const panel = (state = initialState()) => {
  const config = parseConfig(configXml(state));
  return {
    id: ID,
    name: 'Home',
    version: 'R0408000',
    objects: mergeObjects(config, parseTelemetry(telemetryXml(state))),
  };
};
const devices = ['en', 'fr'].map((language) => buildDevice(gladys, panel(), { language }));
const byRole = (states) =>
  Object.fromEntries(states.map((s) => [s.device_feature_external_id.split(':').at(-1), s]));

test('ids: the controller id, the kind and the object key; parsed back strictly', () => {
  assert.equal(devices[0].external_id, `ext:test:omnilogic:${ID}`);
  assert.deepEqual(parseFeatureId(`ext:test:omnilogic:${ID}:water-temp-1_1`), {
    id: ID,
    role: 'water-temp-1_1',
    kind: 'water-temp',
    obj: '1_1',
  });
  for (const bad of [
    'nope-1_1',
    'onoff-../x',
    'onoff-1.3',
    'onoff-01_3',
    'onoff-1_3:x',
    'onoff-1_999999',
  ]) {
    assert.equal(parseFeatureId(`ext:test:omnilogic:${ID}:${bad}`), undefined, bad);
  }
  assert.equal(parseFeatureId(`ext:test:omnilogic:XYZ:onoff-1_3`), undefined);
  assert.equal(parseFeatureId(42), undefined);
  assert.equal(parseDeviceId(`ext:test:omnilogic:${ID}`), ID);
  assert.equal(parseDeviceId(`ext:test:omnilogic:${ID}:status`), undefined);
});

test('no switch, no writable binary; the writable features are the commands; no valve', () => {
  for (const f of devices[0].features) {
    if (f.type === 'binary') assert.equal(f.read_only, true, f.name);
    assert.notEqual(f.category, 'switch', f.name);
    const kind = parseFeatureId(f.external_id).kind;
    assert.equal(f.read_only, !COMMAND_KINDS.includes(kind), f.name);
  }
  const roles = devices[0].features.map((f) => f.external_id.split(':').at(-1));
  assert.ok(!roles.includes('onoff-1_22'), 'the valve actuator is never shown');
  assert.ok(!roles.some((r) => r.endsWith('_33')), 'no group');
});

const PAIRS = [
  ['temperature-sensor', 'celsius'],
  ['thermostat', 'celsius'],
  ['energy-sensor', 'watt'],
  ['ph-sensor', 'ph'],
  ['orp-sensor', 'millivolt'],
];

test('units: only the frozen pairs (checked against the core when its clone is there)', () => {
  for (const f of devices[0].features) {
    if (f.unit === undefined) continue;
    assert.ok(
      PAIRS.some(([c, u]) => c === f.category && u === f.unit),
      `${f.name}: ${f.category} ${f.unit}`,
    );
  }
  if (core) {
    for (const [c, u] of PAIRS) {
      assert.ok(core.DEVICE_FEATURE_UNITS_BY_CATEGORY[c]?.includes(u), `${c} ${u}`);
    }
    for (const f of devices[0].features) {
      assert.ok(Object.values(core.DEVICE_FEATURE_CATEGORIES).includes(f.category), f.category);
    }
  }
});

test('supported options: the rules of the core (label, value, unique, no other key)', () => {
  let count = 0;
  for (const d of devices) {
    for (const f of d.features.filter((x) => x.supported_options)) {
      count += 1;
      const values = new Set();
      const labels = new Set();
      for (const o of f.supported_options) {
        assert.deepEqual(Object.keys(o).sort(), ['label', 'value']);
        assert.equal(typeof o.label, 'string');
        assert.ok(o.label.length > 0 && o.label === o.label.trim(), o.label);
        assert.ok(
          Number.isInteger(o.value) || (typeof o.value === 'string' && o.value.trim() !== ''),
        );
        assert.ok(!values.has(String(o.value)), 'unique value');
        assert.ok(!labels.has(o.label), 'unique label');
        values.add(String(o.value));
        labels.add(o.label);
      }
      if (normalizeSupportedOptions) {
        const allowStringValues = f.category === 'text' && f.type === 'select';
        assert.doesNotThrow(() =>
          normalizeSupportedOptions(f.supported_options, { allowStringValues }),
        );
      }
    }
  }
  assert.ok(count > 4);
});

test('states: °F converted exactly, unavailable values and texts never published as measures', () => {
  const s = byRole(deviceStates(ids, panel(), { online: true, language: 'en' }));
  assert.equal(s['air-temp-0_0'].state, 25);
  assert.equal(s['water-temp-1_1'].state, 27.78);
  assert.equal(s['water-temp-8_8'], undefined, '-1: no reading');
  assert.equal(s['setpoint-8_11'].state, 37.22);
  assert.equal(s['heater-8_11'].text, 'on');
  assert.equal(s['onoff-1_3'].text, 'on');
  assert.equal(s['speed-1_3'].state, 50);
  assert.equal(s['power-1_3'].state, 400);
  assert.equal(s['salt-1_30'].state, 3200);
  assert.equal(s['ph-1_31'].state, 7.4);
  const state = initialState();
  state.chlor.salt = 0;
  state.csad.ph = 0;
  state.filters[0].state = 99;
  state.heaterUnits[0].state = 'x';
  const t = byRole(deviceStates(ids, panel(state), { online: true, language: 'en' }));
  assert.equal(t['salt-1_30'], undefined, '0 salt is no reading');
  assert.equal(t['ph-1_31'], undefined);
  assert.equal(t['onoff-1_3'], undefined, 'an unknown state is not published');
  assert.equal(t['heating-1_4'], undefined, 'a heater state unreadable: unknown');
  const offline = deviceStates(ids, panel(), { online: false, language: 'en' });
  assert.deepEqual(
    offline.map((x) => x.text),
    ['Controller unreachable'],
  );
});

test('a republished device keeps the features of the created one', () => {
  const state = initialState();
  state.relays.shift();
  const created = devices[0];
  const again = buildDevice(gladys, panel(state), { language: 'en', created });
  const ext = (d) => d.features.map((f) => f.external_id).sort();
  assert.deepEqual(ext(again), ext(created));
  const kept = again.features.find((f) => f.external_id.endsWith('onoff-0_27'));
  assert.equal(kept.name, 'Yard Lights - On / off');
  assert.equal(kept.supported_options.length, 2);
});
