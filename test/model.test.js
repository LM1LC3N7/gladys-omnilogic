// -----------------------------------------------------------------------------
// The answers read (pure): the captures of real controllers kept by the
// reference (python-omnilogic-local tests/fixtures, Apache-2.0: issues 60,
// 144 and 163), strict numbers, the identity rule, °F converted exactly,
// set points bounded on the °F written.
// -----------------------------------------------------------------------------

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  celsiusOf,
  integerOf,
  mergeObjects,
  numberOf,
  onSpeedOf,
  panelIdOf,
  parseConfig,
  parseTelemetry,
  sameController,
  setpointToWrite,
  stopValuesOf,
} from '../src/omni/model.js';

const capture = (name) =>
  JSON.parse(readFileSync(new URL(`./fixtures/captures/${name}.json`, import.meta.url), 'utf8'));

test('numbers are strict: empty, spaces, commas, exponents are not numbers', () => {
  for (const bad of ['', ' ', '7,2', '1e3', 'Infinity', undefined, null, '0x10']) {
    assert.equal(numberOf(bad), undefined, String(bad));
  }
  assert.equal(numberOf('-1'), -1);
  assert.equal(integerOf('7.5'), undefined);
});

test('a real capture (issue 60): pool and spa, their equipment, the valve left out', () => {
  const { mspconfig, telemetry } = capture('issue-60');
  const config = parseConfig(mspconfig);
  const tele = parseTelemetry(telemetry);
  assert.deepEqual(config.bodies, [1, 8]);
  assert.equal(
    config.id,
    panelIdOf([
      { id: 1, bowType: 'BOW_POOL' },
      { id: 8, bowType: 'BOW_SPA' },
    ]),
  );
  const types = Object.fromEntries([...config.objects.values()].map((o) => [o.key, o.type]));
  assert.equal(types['1_3'], 'FILTER');
  assert.equal(types['1_4'], 'HEATER');
  assert.equal(types['0_27'], 'RELAY');
  assert.equal(types['1_22'], undefined, 'valve actuator');
  assert.equal(types['8_14'], 'PUMP');
  assert.deepEqual(config.objects.get('1_4').config, { minF: 65, maxF: 104, units: [5, 18] });
  assert.equal(tele.checksum, 5483444);
  assert.equal(tele.version, 'R0408000');
  assert.ok(sameController(config, 5483444, tele));
  const objects = mergeObjects(config, tele);
  assert.equal(objects.get('1_3').values.STATUS, 'ON');
  assert.equal(objects.get('1_3').values.SPEED, '31');
  assert.equal(objects.get('1_4').values.ENABLE, '0');
  assert.equal(objects.get('1_4').values.HEATING, '0');
  assert.equal(objects.get('0_27').values.STATUS, 'ON');
  assert.equal(objects.get('1_1').values.TEMP, '74');
  assert.equal(objects.get('8_8').values.TEMP, '-1');
});

test('real captures 144 (Metric display: values still °F) and 163 (no heater)', () => {
  const metric = capture('issue-144');
  const config = parseConfig(metric.mspconfig);
  assert.equal(config.units, 'Metric');
  const tele = parseTelemetry(metric.telemetry);
  const objects = mergeObjects(config, tele);
  const heater = [...objects.values()].find((o) => o.type === 'HEATER');
  // Set point 65 with limits 55..104: plain °F, whatever the display.
  assert.equal(heater.values.SETPOINT, '65');
  assert.equal(heater.config.minF, 55);
  const other = capture('issue-163');
  const c163 = parseConfig(other.mspconfig);
  const t163 = parseTelemetry(other.telemetry);
  assert.ok(sameController(c163, t163.checksum, t163));
  assert.ok(![...c163.objects.values()].some((o) => o.type === 'HEATER'));
  assert.notEqual(c163.id, config.id);
});

test('identity: another set of bodies or another checksum is not the same controller', () => {
  const { mspconfig, telemetry } = capture('issue-60');
  const config = parseConfig(mspconfig);
  const tele = parseTelemetry(telemetry);
  assert.equal(sameController(config, 1, tele), false);
  assert.equal(
    sameController(
      config,
      5483444,
      parseTelemetry(telemetry.replace('systemId="8" waterTemp', 'systemId="9" waterTemp')),
    ),
    false,
  );
  assert.equal(sameController(undefined, 5483444, tele), false);
  assert.equal(
    parseConfig('<MSPConfig><Backyard><System-Id>0</System-Id></Backyard></MSPConfig>'),
    undefined,
    'no body',
  );
  assert.equal(parseTelemetry('<NOPE/>'), undefined);
});

test('stop values from a telemetry alone: the tag gives the type; heaters unknown without the configuration', () => {
  const { mspconfig, telemetry } = capture('issue-60');
  const tele = parseTelemetry(telemetry);
  assert.equal(stopValuesOf('1_3', tele, undefined).STATUS, 'ON');
  assert.equal(stopValuesOf('1_4', tele, undefined).ENABLE, '0');
  assert.equal(stopValuesOf('1_4', tele, undefined).HEATING, undefined);
  assert.equal(stopValuesOf('1_4', tele, parseConfig(mspconfig)).HEATING, '0');
  assert.equal(stopValuesOf('1_99', tele, undefined), undefined);
});

test('temperatures: °F converted exactly', () => {
  assert.equal(celsiusOf('77'), 25);
  assert.equal(celsiusOf('84'), 28.89);
  assert.equal(celsiusOf('x'), undefined);
});

test('set points: the protocol range, the heater limits, the ceiling after conversion', () => {
  const heater = { minF: 65, maxF: 104 };
  assert.deepEqual(setpointToWrite(40, heater, 40), { value: 104, celsius: 40 });
  assert.deepEqual(setpointToWrite(35, heater, 35), { value: 95, celsius: 35 });
  assert.equal(setpointToWrite(34.9, heater, 35).value, 95);
  assert.equal(
    setpointToWrite(35.2, heater, 35).value,
    95,
    'rounded to a degree within the ceiling',
  );
  assert.equal(setpointToWrite(35.4, heater, 35).value, undefined, 'above the ceiling');
  assert.ok(setpointToWrite(35.5, heater, 35).value === undefined);
  // A ceiling that is no whole °F: rounded down, never above once converted back.
  assert.equal(setpointToWrite(30.5, heater, 30.7).value, 87);
  assert.equal(setpointToWrite(30.9, heater, 30.7).value, undefined);
  assert.ok(((87 - 32) * 5) / 9 <= 30.7);
  assert.equal(setpointToWrite(30, { minF: 65 }, 35), undefined, 'limits unknown');
  assert.equal(
    setpointToWrite(36, { minF: 65, maxF: 90 }, 40).value,
    undefined,
    'the heater maximum',
  );
  assert.equal(setpointToWrite(15, heater, 35).value, undefined, 'below 65 °F');
  // 21 °C is 69.8 °F: the highest whole °F is 69 (20.56 °C), rounded down.
  assert.deepEqual(setpointToWrite(21, heater, 21), { low: 18.33, high: 20.56 });
  for (let c = 10; c <= 45; c += 0.1) {
    const w = setpointToWrite(c, heater, 40);
    if (w.value !== undefined) assert.ok(w.value >= 65 && w.value <= 104 && w.celsius <= 40);
  }
});

test('the speed to turn on: the last speed within limits, else the maximum', () => {
  const object = (kind, last) => ({
    config: { kind, minPercent: 18, maxPercent: 100 },
    values: { LAST: last },
  });
  assert.equal(onSpeedOf(object('FMT_VARIABLE_SPEED_PUMP', '50')), 50);
  assert.equal(onSpeedOf(object('FMT_VARIABLE_SPEED_PUMP', '5')), 100);
  assert.equal(onSpeedOf(object('FMT_SINGLE_SPEED', '50')), 100);
  assert.equal(
    onSpeedOf({ config: { kind: 'PMP_VARIABLE_SPEED_PUMP', maxPercent: 500 }, values: {} }),
    100,
  );
});
