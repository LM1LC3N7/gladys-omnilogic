// -----------------------------------------------------------------------------
// The answers of the controller -> plain values (pure), read by name from the
// XML tree of src/omni/xml.js (null-prototype attributes: a name such as
// `__proto__` is just never read). Numbers are strict ("", " ", "7,2", "1e3"
// are not numbers). From python-omnilogic-local 5.0.2 (Apache-2.0):
// `models/mspconfig.py`, `models/telemetry.py`, `omnitypes.py`.
//
// The configuration (MSPConfig) gives the bodies of water (pool, spa) and
// their equipment, with names and limits; the telemetry (STATUS) gives the
// states, by `systemId`. An object is keyed `<body>_<system id>` (body 0: the
// backyard), so that a stop knows where to go without a read.
//
// Temperatures: every temperature of the protocol is in °F (the reference;
// its capture of a controller in "Metric" shows °F values), converted exactly
// ((F − 32) × 5 / 9) and rounded to the hundredth for display only. A sensor
// whose configured unit is not °F is not published. -1 (water) and 65535 (a
// heater) mean "no reading".
//
// Identity: the protocol gives no serial number nor MAC address. The id of a
// controller is a hash of the system ids and types of its bodies of water
// (frozen rule, documented): stable across reboots, firmware updates and
// renames; a body added or removed in the configuration of the controller
// makes a new device.
// -----------------------------------------------------------------------------

import { createHash } from 'node:crypto';
import { LIMITS, OFF, ON, SETPOINT, SYSTEM_ID } from '../constants.js';
import { attrOf, childNamed, childText, childrenNamed, parseXml } from './xml.js';

/** A strict number: "72", "-4", "7.4"; never "", " ", "7,4", "1e3". */
export function numberOf(text) {
  if (typeof text !== 'string' || !/^-?\d{1,7}(?:\.\d{1,6})?$/.test(text)) {
    return undefined;
  }
  return Number(text);
}

/** A whole number only ("72"; "72.5" is not one). */
export function integerOf(text) {
  const n = numberOf(text);
  return n !== undefined && Number.isInteger(n) ? n : undefined;
}

/** A system id: a whole number 0..65535, else undefined. */
export function systemIdOf(text) {
  if (typeof text !== 'string' || !SYSTEM_ID.test(text.trim())) return undefined;
  const n = Number(text.trim());
  return n <= 0xffff ? n : undefined;
}

/** A name of the controller as shown: no control characters, trimmed, cut. */
export function cleanName(text) {
  if (typeof text !== 'string') return undefined;
  const clean = text
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u001f\u007f-\u009f]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  return clean === '' ? undefined : clean.slice(0, LIMITS.maxName).trim();
}

export const PANEL_ID = /^[0-9a-f]{16}$/;

/** The id of a controller: a hash of its bodies of water (system id and type), sorted. */
export function panelIdOf(bodies) {
  const text = bodies
    .map((b) => `${b.id}:${b.bowType}`)
    .sort()
    .join(',');
  return createHash('sha256').update(`omnilogic:${text}`).digest('hex').slice(0, 16);
}

export const keyOf = (bow, id) => `${bow}_${id}`;

/** The body and system id of an object key, else undefined. */
export function splitKey(key) {
  const match = /^(\d{1,5})_(\d{1,5})$/.exec(key ?? '');
  if (!match) return undefined;
  const bow = Number(match[1]);
  const id = Number(match[2]);
  return bow <= 0xffff && id <= 0xffff ? { bow, id } : undefined;
}

/** The relays that are valves (never shown: a valve changes where the water goes). */
const VALVE_TYPES = new Set(['RLY_VALVE_ACTUATOR', 'RLY_SMART_VALVE_ACTUATOR']);

/** Whether the temperature sensor of this type, under `node`, is in °F (or absent). */
function sensorInF(node, type) {
  const sensors = childrenNamed(node, 'Sensor').filter((s) => childText(s, 'Type') === type);
  return sensors.every((s) => (childText(s, 'Units') ?? 'UNITS_FAHRENHEIT') === 'UNITS_FAHRENHEIT');
}

/**
 * The configuration (MSPConfig XML): `{ id, name, units, objects }`, where
 * `objects` maps a key to `{ key, bow, id, type, subtype, name, config }`.
 * Undefined when it is not one (no backyard, no body of water).
 */
export function parseConfig(text) {
  let root;
  try {
    root = parseXml(text);
  } catch {
    return undefined;
  }
  if (root.name !== 'MSPConfig') return undefined;
  const backyard = childNamed(root, 'Backyard');
  if (!backyard) return undefined;
  const objects = new Map();
  const counts = Object.create(null);
  const add = (object) => {
    // One object per key; bounded per type.
    if (objects.has(object.key)) return;
    counts[object.type] = (counts[object.type] ?? 0) + 1;
    if (counts[object.type] > LIMITS.maxPerKind) return;
    objects.set(object.key, object);
  };
  const named = (node) => cleanName(childText(node, 'Name'));
  const units = childText(childNamed(root, 'System'), 'Units');
  add({
    key: keyOf(0, 0),
    bow: 0,
    id: 0,
    type: 'BACKYARD',
    name: named(backyard),
    config: { airInF: sensorInF(backyard, 'SENSOR_AIR_TEMP') },
  });
  const equipment = (parent, bow) => {
    for (const node of childrenNamed(parent, 'Relay')) {
      const id = systemIdOf(childText(node, 'System-Id'));
      const relayType = childText(node, 'Type');
      if (id === undefined || VALVE_TYPES.has(relayType)) continue;
      add({ key: keyOf(bow, id), bow, id, type: 'RELAY', name: named(node), config: {} });
    }
    for (const node of childrenNamed(parent, 'ColorLogic-Light')) {
      const id = systemIdOf(childText(node, 'System-Id'));
      if (id === undefined) continue;
      add({ key: keyOf(bow, id), bow, id, type: 'LIGHT', name: named(node), config: {} });
    }
  };
  equipment(backyard, 0);
  const bodies = [];
  for (const body of childrenNamed(backyard, 'Body-of-water')) {
    const bow = systemIdOf(childText(body, 'System-Id'));
    const bowType = childText(body, 'Type');
    if (bow === undefined || bow === 0 || typeof bowType !== 'string' || bowType.length > 40) {
      continue;
    }
    bodies.push({ id: bow, bowType });
    add({
      key: keyOf(bow, bow),
      bow,
      id: bow,
      type: 'BODY',
      subtype: bowType === 'BOW_POOL' ? 'POOL' : bowType === 'BOW_SPA' ? 'SPA' : 'OTHER',
      name: named(body),
      config: { waterInF: sensorInF(body, 'SENSOR_WATER_TEMP') },
    });
    for (const node of childrenNamed(body, 'Filter')) {
      const id = systemIdOf(childText(node, 'System-Id'));
      if (id === undefined) continue;
      add({
        key: keyOf(bow, id),
        bow,
        id,
        type: 'FILTER',
        name: named(node),
        config: {
          kind: childText(node, 'Filter-Type'),
          minPercent: integerOf(childText(node, 'Min-Pump-Speed')),
          maxPercent: integerOf(childText(node, 'Max-Pump-Speed')),
        },
      });
    }
    for (const node of childrenNamed(body, 'Pump')) {
      const id = systemIdOf(childText(node, 'System-Id'));
      if (id === undefined) continue;
      add({
        key: keyOf(bow, id),
        bow,
        id,
        type: 'PUMP',
        name: named(node),
        config: {
          kind: childText(node, 'Type'),
          minPercent: integerOf(childText(node, 'Min-Pump-Speed')),
          maxPercent: integerOf(childText(node, 'Max-Pump-Speed')),
        },
      });
    }
    equipment(body, bow);
    const heater = childNamed(body, 'Heater');
    const heaterId = systemIdOf(childText(heater, 'System-Id'));
    if (heater && heaterId !== undefined) {
      const units = [];
      for (const op of childrenNamed(heater, 'Operation')) {
        for (const equip of childrenNamed(op, 'Heater-Equipment')) {
          const id = systemIdOf(childText(equip, 'System-Id'));
          if (id !== undefined && units.length < 8) units.push(id);
        }
      }
      add({
        key: keyOf(bow, heaterId),
        bow,
        id: heaterId,
        type: 'HEATER',
        name: named(body),
        config: {
          minF: integerOf(childText(heater, 'Min-Settable-Water-Temp')),
          maxF: integerOf(childText(heater, 'Max-Settable-Water-Temp')),
          units,
        },
      });
    }
    const chlor = childNamed(body, 'Chlorinator');
    const chlorId = systemIdOf(childText(chlor, 'System-Id'));
    if (chlor && chlorId !== undefined) {
      add({
        key: keyOf(bow, chlorId),
        bow,
        id: chlorId,
        type: 'CHLOR',
        name: named(chlor),
        config: {},
      });
    }
    const csad = childNamed(body, 'CSAD');
    const csadId = systemIdOf(childText(csad, 'System-Id'));
    if (csad && csadId !== undefined) {
      add({
        key: keyOf(bow, csadId),
        bow,
        id: csadId,
        type: 'CSAD',
        name: named(csad),
        config: {},
      });
    }
  }
  if (bodies.length === 0) return undefined;
  return {
    id: panelIdOf(bodies),
    bodies: bodies.map((b) => b.id).sort((a, b) => a - b),
    name: cleanName(childText(backyard, 'Name')),
    units: units === 'Metric' ? 'Metric' : units === 'Standard' ? 'Standard' : undefined,
    objects,
  };
}

/**
 * The telemetry (STATUS XML): `{ checksum, version, state, items }`, where
 * `items` maps a system id to `{ tag, attrs }` (the first of each id).
 * Undefined when it is not one.
 */
export function parseTelemetry(text) {
  let root;
  try {
    root = parseXml(text);
  } catch {
    return undefined;
  }
  if (root.name !== 'STATUS') return undefined;
  const backyard = childNamed(root, 'Backyard');
  if (!backyard) return undefined;
  const items = new Map();
  const bodies = [];
  for (const child of root.children) {
    const id = systemIdOf(attrOf(child, 'systemId'));
    if (id === undefined || items.has(id)) continue;
    items.set(id, { tag: child.name, attrs: child.attrs });
    if (child.name === 'BodyOfWater' && id !== 0) bodies.push(id);
  }
  const checksum = integerOf(attrOf(backyard, 'ConfigChksum'));
  return {
    checksum: checksum !== undefined && checksum > 0 ? checksum : undefined,
    version: cleanName(attrOf(backyard, 'mspVersion')),
    bodies: bodies.sort((a, b) => a - b),
    items,
  };
}

const FILTER_STATUS = new Map([
  [0, OFF],
  [1, ON],
  [2, ON],
  [8, ON],
  [9, ON],
  [10, ON],
  // Waiting to turn off, heater extend, cool-down, waiting for the pump: running down.
  [3, 'STOPPING'],
  [4, 'STOPPING'],
  [5, 'STOPPING'],
  [6, 'STOPPING'],
  [11, 'STOPPING'],
]);
const PUMP_STATUS = new Map([
  [0, OFF],
  [1, ON],
  [2, ON],
  [4, ON],
]);
const RELAY_STATUS = new Map([
  [0, OFF],
  [1, ON],
  [2, ON],
]);
const LIGHT_STATUS = new Map([
  [0, OFF],
  [6, ON],
  [2, ON],
  [3, ON],
  [4, ON],
  [1, 'STOPPING'],
  [7, 'STOPPING'],
]);

/** The telemetry entry of an object, when its tag is the expected one. */
const itemOf = (telemetry, id, tag) => {
  const item = telemetry?.items.get(id);
  return item && item.tag === tag ? item.attrs : undefined;
};
const intAttr = (attrs, name) => (attrs ? integerOf(attrOf({ attrs }, name)) : undefined);
const statusOf = (table, value) => (value === undefined ? undefined : table.get(value));
const text = (value) => (value === undefined ? undefined : String(value));

/**
 * The values of one object in a telemetry (texts, null prototype): STATUS
 * ("ON", "OFF", "STOPPING"), SPEED, POWER, LAST (percent), ENABLE ("0"/"1"),
 * SETPOINT (°F), HEATING ("0"/"1"), TEMP / AIR (°F), STATE, SALT, PH, ORP.
 * A value absent or out of its type is left out.
 */
export function valuesOf(object, telemetry) {
  const v = Object.create(null);
  const set = (key, value) => {
    if (value !== undefined) v[key] = value;
  };
  switch (object.type) {
    case 'BACKYARD': {
      const a = itemOf(telemetry, 0, 'Backyard');
      set('AIR', text(intAttr(a, 'airTemp')));
      set('STATE', text(intAttr(a, 'state')));
      break;
    }
    case 'BODY': {
      const a = itemOf(telemetry, object.id, 'BodyOfWater');
      set('TEMP', text(intAttr(a, 'waterTemp')));
      break;
    }
    case 'FILTER': {
      const a = itemOf(telemetry, object.id, 'Filter');
      set('STATUS', statusOf(FILTER_STATUS, intAttr(a, 'filterState')));
      set('SPEED', text(intAttr(a, 'reportedFilterSpeed')));
      set('POWER', text(intAttr(a, 'power')));
      set('LAST', text(intAttr(a, 'lastSpeed')));
      break;
    }
    case 'PUMP': {
      const a = itemOf(telemetry, object.id, 'Pump');
      set('STATUS', statusOf(PUMP_STATUS, intAttr(a, 'pumpState')));
      set('SPEED', text(intAttr(a, 'pumpSpeed')));
      set('LAST', text(intAttr(a, 'lastSpeed')));
      break;
    }
    case 'RELAY': {
      const a = itemOf(telemetry, object.id, 'Relay');
      set('STATUS', statusOf(RELAY_STATUS, intAttr(a, 'relayState')));
      break;
    }
    case 'LIGHT': {
      const a = itemOf(telemetry, object.id, 'ColorLogic-Light');
      set('STATUS', statusOf(LIGHT_STATUS, intAttr(a, 'lightState')));
      break;
    }
    case 'HEATER': {
      const a = itemOf(telemetry, object.id, 'VirtualHeater');
      const enable = intAttr(a, 'enable');
      set('ENABLE', enable === 0 || enable === 1 ? String(enable) : undefined);
      set('SETPOINT', text(intAttr(a, 'Current-Set-Point')));
      // Heating: a heater of the body seen on (heaterState 1); unknown if one cannot be read.
      // `units` undefined (no configuration read): the heating state is unknown.
      const units = object.config?.units;
      if (units === undefined) {
        // Unknown: HEATING left out.
      } else if (units.length > 0) {
        const states = units.map((id) => intAttr(itemOf(telemetry, id, 'Heater'), 'heaterState'));
        if (states.some((s) => s === 1)) set('HEATING', '1');
        else if (states.every((s) => s !== undefined)) set('HEATING', '0');
      } else if (a) {
        set('HEATING', '0');
      }
      break;
    }
    case 'CHLOR': {
      const a = itemOf(telemetry, object.id, 'Chlorinator');
      set('SALT', text(intAttr(a, 'avgSaltLevel')));
      break;
    }
    case 'CSAD': {
      const a = itemOf(telemetry, object.id, 'CSAD');
      const ph = a ? numberOf(attrOf({ attrs: a }, 'ph')) : undefined;
      set('PH', text(ph));
      set('ORP', text(intAttr(a, 'orp')));
      break;
    }
    default:
      break;
  }
  return v;
}

/**
 * The objects of a configuration with the values of a telemetry: a new map
 * (the configuration is never changed), each object with its `values`.
 */
export function mergeObjects(config, telemetry) {
  const objects = new Map();
  for (const [key, object] of config.objects) {
    objects.set(key, { ...object, values: valuesOf(object, telemetry) });
  }
  return objects;
}

/**
 * Whether a telemetry belongs to the controller of this configuration: its
 * checksum (when it has one) is the one the configuration was read with, and
 * its bodies of water are those of the configuration. `false` also when it
 * cannot be told (identity unreadable is never "the same").
 */
export function sameController(config, checksum, telemetry) {
  if (!config || !telemetry) return false;
  if (telemetry.checksum !== undefined && telemetry.checksum !== checksum) return false;
  return JSON.stringify(telemetry.bodies) === JSON.stringify(config.bodies);
}

const round2 = (value) => Math.round(value * 100) / 100;

/** A °F reading in °C (exact conversion, rounded to the hundredth), else undefined. */
export function celsiusOf(textF) {
  const value = numberOf(textF);
  if (value === undefined) return undefined;
  return round2(((value - 32) * 5) / 9);
}

/** Groups the objects for Gladys, in key order, bounded per kind. */
export function groupObjects(objects) {
  const sorted = [...(objects?.values() ?? [])].sort(
    (a, b) => a.bow - b.bow || a.id - b.id || (a.type < b.type ? -1 : 1),
  );
  const take = (type) => sorted.filter((o) => o.type === type).slice(0, LIMITS.maxPerKind);
  return {
    backyard: take('BACKYARD'),
    bodies: take('BODY'),
    heaters: take('HEATER'),
    filters: take('FILTER'),
    pumps: take('PUMP'),
    relays: take('RELAY'),
    lights: take('LIGHT'),
    chlors: take('CHLOR'),
    csads: take('CSAD'),
  };
}

/** The ceiling of the heating set point of a body, °C: a spa 40, a pool the configuration's. */
export function ceilingOf(body, poolCeiling) {
  const pool = Math.min(SETPOINT.spaMaxC, poolCeiling);
  if (body?.subtype === 'SPA') return SETPOINT.spaMaxC;
  if (body?.subtype === 'POOL') return pool;
  // A body of another kind: the lower of both.
  return Math.min(SETPOINT.spaMaxC, pool);
}

/**
 * The whole °F to write for a set point asked in °C: `{ value, celsius }`, or
 * `{ low, high }` (°C) when out of bounds, or undefined when the limits of the
 * heater are not known (never written without them). The bounds: the
 * protocol's 65..104 °F within the heater's Min/Max-Settable-Water-Temp, and
 * the ceiling (°C, converted to °F rounded down); a final check refuses a
 * written degree above the ceiling once converted back.
 */
export function setpointToWrite(celsius, heaterConfig, ceilingC) {
  const { minF, maxF } = heaterConfig ?? {};
  if (!Number.isFinite(celsius) || !Number.isInteger(minF) || !Number.isInteger(maxF)) {
    return undefined;
  }
  const ceiling = Math.min(ceilingC, SETPOINT.spaMaxC);
  const lowF = Math.max(SETPOINT.minF, minF);
  const highF = Math.min(SETPOINT.maxF, maxF, Math.floor((ceiling * 9) / 5 + 32));
  const lowC = round2(((lowF - 32) * 5) / 9);
  const highC = round2(((highF - 32) * 5) / 9);
  if (highF < lowF) return { low: lowC, high: highC, none: true };
  const wanted = (celsius * 9) / 5 + 32;
  if (wanted < lowF - 0.5 || wanted > highF + 0.5) {
    return { low: lowC, high: highC };
  }
  const value = Math.min(highF, Math.max(lowF, Math.round(wanted)));
  const back = ((value - 32) * 5) / 9;
  // The written degree, converted back, is never above the ceiling (final check).
  if (value > SETPOINT.maxF || back > ceiling + 1e-9 || back > SETPOINT.spaMaxC + 1e-9) {
    return { low: lowC, high: highC };
  }
  return { value, celsius: round2(back) };
}

/**
 * The speed to turn a filter or pump on with (the reference's rule): its last
 * speed when within its limits, else its maximum (single speed: its maximum),
 * else 100; always a whole percent 1..100.
 */
export function onSpeedOf(object) {
  const { kind, minPercent, maxPercent } = object.config;
  const max =
    Number.isInteger(maxPercent) && maxPercent >= 1 && maxPercent <= 100 ? maxPercent : 100;
  const min = Number.isInteger(minPercent) && minPercent >= 1 && minPercent <= max ? minPercent : 1;
  const last = integerOf(object.values?.LAST);
  const variable =
    kind === 'FMT_VARIABLE_SPEED_PUMP' ||
    kind === 'FMT_DUAL_SPEED' ||
    kind === 'PMP_VARIABLE_SPEED_PUMP';
  if (variable && last !== undefined && last >= min && last <= max) return last;
  return max;
}

/** The object type of a telemetry tag (for a stop read without a configuration). */
const TYPE_OF_TAG = {
  Filter: 'FILTER',
  Pump: 'PUMP',
  Relay: 'RELAY',
  'ColorLogic-Light': 'LIGHT',
  VirtualHeater: 'HEATER',
};

/**
 * The values a stop is judged on, for the object `key`, from a telemetry
 * alone: its type comes from the telemetry tag; the heaters of a body from
 * the configuration when one is known (else the heating state is unknown).
 */
export function stopValuesOf(key, telemetry, config) {
  const parts = splitKey(key);
  const item = parts && telemetry?.items.get(parts.id);
  const type = item && TYPE_OF_TAG[item.tag];
  if (!type) return undefined;
  const known = config?.objects.get(key);
  const object = { type, id: parts.id, config: known?.type === type ? known.config : {} };
  return valuesOf(object, telemetry);
}
