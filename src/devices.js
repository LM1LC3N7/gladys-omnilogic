// -----------------------------------------------------------------------------
// The controller -> one Gladys device and its states (pure).
//
// `ext:<selector>:omnilogic:<id>`: one device per controller, keyed by a hash
// of its bodies of water (src/omni/model.js), never by its IP address. A
// feature role is `<kind>-<body>_<system id>` (`onoff-1_3`, `setpoint-1_4`):
// the kinds and the system ids of the controller are published forever,
// never renamed. A device republished keeps every feature the created device
// has (`created`), even an object the controller no longer shows.
//
// No switch, no writable binary: a "turn everything off" (Google Home, Alexa,
// HomeKit, MCP, `switch.*` scenes) must never reach a pump, a heater or a
// light. A filter, pump, relay or light is a `text/select` (on, off), a heater
// a `text/select` (on, off), its set point a `thermostat/target-temperature`
// in °C. "Off" always works; the rest refuses unless the configuration allows
// it (src/app.js).
//
// Categories and units are those the core lists
// (DEVICE_FEATURE_UNITS_BY_CATEGORY): °C, pH, mV, W. The speed (percent) and
// the salt (ppm) have no category of their own: `unknown`, the unit in the name.
// -----------------------------------------------------------------------------

import {
  DEVICE_FEATURE_CATEGORIES as C,
  DEVICE_FEATURE_TYPES as T,
  DEVICE_FEATURE_UNITS as U,
} from '@gladysassistant/integration-sdk';
import { KINDS, OBJ_KEY, SELECT_VALUES, SETPOINT, STATUS_ROLE } from './constants.js';
import { FEATURE_NAMES, OBJECT_NAMES, SELECT_LABELS, STATE_TEXTS, word } from './i18n.js';
import { PANEL_ID, celsiusOf, groupObjects, integerOf, numberOf } from './omni/model.js';

const sensor = (definition) => ({
  read_only: true,
  has_feedback: false,
  keep_history: true,
  ...definition,
});
const select = {
  category: C.TEXT,
  type: T.TEXT.SELECT,
  min: 0,
  max: 0,
  read_only: false,
  has_feedback: true,
  keep_history: false,
};

/** The features of each kind (the select options are added in buildDevice). */
export const DEFINITIONS = {
  [STATUS_ROLE]: sensor({
    category: C.TEXT,
    type: T.TEXT.TEXT,
    min: 0,
    max: 0,
    keep_history: false,
  }),
  [KINDS.ONOFF]: select,
  [KINDS.HEATER]: select,
  [KINDS.AIR_TEMP]: sensor({
    category: C.TEMPERATURE_SENSOR,
    type: T.SENSOR.DECIMAL,
    unit: U.CELSIUS,
    min: -40,
    max: 70,
  }),
  [KINDS.WATER_TEMP]: sensor({
    category: C.TEMPERATURE_SENSOR,
    type: T.SENSOR.DECIMAL,
    unit: U.CELSIUS,
    min: -10,
    max: 60,
  }),
  [KINDS.SETPOINT]: {
    category: C.THERMOSTAT,
    type: T.THERMOSTAT.TARGET_TEMPERATURE,
    unit: U.CELSIUS,
    min: 18,
    max: SETPOINT.spaMaxC,
    read_only: false,
    has_feedback: true,
    keep_history: true,
  },
  [KINDS.HEATING]: sensor({ category: C.UNKNOWN, type: T.SENSOR.BINARY, min: 0, max: 1 }),
  [KINDS.SPEED]: sensor({ category: C.UNKNOWN, type: T.SENSOR.INTEGER, min: 0, max: 100 }),
  [KINDS.POWER]: sensor({
    category: C.ENERGY_SENSOR,
    type: T.ENERGY_SENSOR.POWER,
    unit: U.WATT,
    min: 0,
    max: 10000,
  }),
  [KINDS.SALT]: sensor({ category: C.UNKNOWN, type: T.SENSOR.INTEGER, min: 0, max: 20000 }),
  [KINDS.PH]: sensor({
    category: C.PH_SENSOR,
    type: T.PH_SENSOR.DECIMAL,
    unit: U.PH,
    min: 0,
    max: 14,
  }),
  [KINDS.ORP]: sensor({
    category: C.ORP_SENSOR,
    type: T.ORP_SENSOR.DECIMAL,
    unit: U.MILLI_VOLT,
    min: 0,
    max: 2000,
  }),
};

const KIND_LIST = Object.values(KINDS);

/** The kinds that take a command. */
export const COMMAND_KINDS = [KINDS.ONOFF, KINDS.HEATER, KINDS.SETPOINT];

export const panelIds = (gladys, id) => gladys.externalIds('omnilogic', id);

export const roleOf = (kind, key) => `${kind}-${key}`;

/** The role of a feature: `status`, or `{ kind, obj }`; undefined when not ours. */
export function parseRole(role) {
  if (role === STATUS_ROLE) {
    return { kind: STATUS_ROLE };
  }
  if (typeof role !== 'string') return undefined;
  const cut = role.lastIndexOf('-');
  if (cut <= 0) return undefined;
  const kind = role.slice(0, cut);
  const obj = role.slice(cut + 1);
  return KIND_LIST.includes(kind) && OBJ_KEY.test(obj) ? { kind, obj } : undefined;
}

/** The controller id and the role of one of our feature external ids, else undefined. */
export function parseFeatureId(externalId) {
  if (typeof externalId !== 'string' || externalId.length > 300) {
    return undefined;
  }
  const match = /:omnilogic:([0-9a-f]{16}):([a-z0-9_-]{1,40})$/.exec(externalId);
  if (!match) return undefined;
  const role = parseRole(match[2]);
  return role ? { id: match[1], role: match[2], ...role } : undefined;
}

/** The controller id of one of our device external ids, else undefined. */
export function parseDeviceId(externalId) {
  if (typeof externalId !== 'string' || externalId.length > 300) {
    return undefined;
  }
  const match = /:omnilogic:([0-9a-f]{16})$/.exec(externalId);
  return match && PANEL_ID.test(match[1]) ? match[1] : undefined;
}

export const selectOptions = (language) =>
  Object.values(SELECT_VALUES).map((value) => ({
    value,
    label: word(SELECT_LABELS[value], language),
  }));

/** The name of an object as shown: its own, else its kind and system id. */
export function objectName(object, key, language) {
  if (object?.name) return object.name;
  const kind = OBJECT_NAMES[object?.type] ?? OBJECT_NAMES.RELAY;
  return `${word(kind, language)} ${key}`;
}

/** The kinds of features of one object of the controller. */
export function kindsOf(object) {
  switch (object.type) {
    case 'BACKYARD':
      return [KINDS.AIR_TEMP];
    case 'BODY':
      return [KINDS.WATER_TEMP];
    case 'HEATER':
      return [KINDS.HEATER, KINDS.SETPOINT, KINDS.HEATING];
    case 'FILTER':
      return [KINDS.ONOFF, KINDS.SPEED, KINDS.POWER];
    case 'PUMP':
      return [KINDS.ONOFF, KINDS.SPEED];
    case 'RELAY':
    case 'LIGHT':
      return [KINDS.ONOFF];
    case 'CHLOR':
      return [KINDS.SALT];
    case 'CSAD':
      return [KINDS.PH, KINDS.ORP];
    default:
      return [];
  }
}

function featureOf(ids, kind, key, name, language) {
  const options =
    kind === KINDS.ONOFF || kind === KINDS.HEATER
      ? { supported_options: selectOptions(language) }
      : {};
  return {
    name,
    external_id: ids.feature(key === undefined ? kind : roleOf(kind, key)),
    ...DEFINITIONS[kind],
    ...options,
  };
}

export const deviceName = (panel) =>
  panel.name && panel.name !== 'Backyard'
    ? `OmniLogic ${panel.name}`
    : `OmniLogic ${panel.id.slice(0, 6)}`;

/** The objects shown, in the order of the features. */
export function shownObjects(objects) {
  const g = groupObjects(objects);
  return [
    ...g.backyard,
    ...g.bodies,
    ...g.heaters,
    ...g.filters,
    ...g.pumps,
    ...g.relays,
    ...g.lights,
    ...g.chlors,
    ...g.csads,
  ];
}

/**
 * The Gladys device of the controller: the status, then the features of
 * every object shown, then those of the created device the controller no
 * longer shows (kept with their name). `created`: the device as Gladys has
 * it, or undefined.
 */
export function buildDevice(gladys, panel, { language, created } = {}) {
  const ids = panelIds(gladys, panel.id);
  const features = [
    featureOf(ids, STATUS_ROLE, undefined, word(FEATURE_NAMES[STATUS_ROLE], language), language),
  ];
  for (const object of shownObjects(panel.objects)) {
    const name = objectName(object, object.key, language);
    for (const kind of kindsOf(object)) {
      features.push(
        featureOf(
          ids,
          kind,
          object.key,
          `${name} - ${word(FEATURE_NAMES[kind], language)}`,
          language,
        ),
      );
    }
  }
  const have = new Set(features.map((f) => f.external_id));
  for (const f of created?.features ?? []) {
    const parsed = parseFeatureId(f?.external_id);
    if (!parsed || parsed.id !== panel.id || have.has(f.external_id) || !parsed.obj) continue;
    const name =
      typeof f.name === 'string' && f.name.trim() !== '' ? f.name.slice(0, 100) : parsed.role;
    features.push(featureOf(ids, parsed.kind, parsed.obj, name, language));
    have.add(f.external_id);
  }
  const params = [];
  if (panel.version) params.push({ name: 'firmware', value: panel.version });
  return {
    name: deviceName(panel),
    external_id: ids.device,
    model: 'OmniLogic',
    should_poll: false,
    features,
    params,
  };
}

/** The value of one feature, from the objects read: `{ state }`, `{ text }` or undefined. */
export function valueOf(kind, object) {
  const v = object.values ?? {};
  const inRange = (value) => {
    const { min, max } = DEFINITIONS[kind];
    return value !== undefined && Number.isFinite(value) && value >= min && value <= max
      ? { state: value }
      : undefined;
  };
  const positive = (value) => (value !== undefined && value > 0 ? inRange(value) : undefined);
  switch (kind) {
    case KINDS.ONOFF:
      // Running down (cool-down, waiting to turn off) still runs.
      return v.STATUS === 'ON' || v.STATUS === 'STOPPING'
        ? { text: 'on' }
        : v.STATUS === 'OFF'
          ? { text: 'off' }
          : undefined;
    case KINDS.HEATER:
      return v.ENABLE === '1' ? { text: 'on' } : v.ENABLE === '0' ? { text: 'off' } : undefined;
    case KINDS.AIR_TEMP:
      return object.config?.airInF ? inRange(celsiusOf(v.AIR)) : undefined;
    case KINDS.WATER_TEMP: {
      // -1: no reading (no flow, no sensor).
      const f = integerOf(v.TEMP);
      return object.config?.waterInF && f !== undefined && f !== -1
        ? inRange(celsiusOf(v.TEMP))
        : undefined;
    }
    case KINDS.SETPOINT:
      return inRange(celsiusOf(v.SETPOINT));
    case KINDS.HEATING:
      return v.HEATING === '1' ? { state: 1 } : v.HEATING === '0' ? { state: 0 } : undefined;
    case KINDS.SPEED:
      return inRange(integerOf(v.SPEED));
    case KINDS.POWER:
      return inRange(integerOf(v.POWER));
    case KINDS.SALT:
      return positive(integerOf(v.SALT));
    case KINDS.PH:
      return positive(numberOf(v.PH));
    case KINDS.ORP:
      return positive(integerOf(v.ORP));
    default:
      return undefined;
  }
}

/**
 * The current values of the controller's device, from one read. Offline:
 * only the status (Gladys keeps the last value of the others). A value that
 * is not known (or a text where a number is expected) is never published.
 */
export function deviceStates(ids, panel, { online, language }) {
  const states = [
    {
      device_feature_external_id: ids.feature(STATUS_ROLE),
      text: word(online ? STATE_TEXTS.online : STATE_TEXTS.offline, language),
    },
  ];
  if (!online) return states;
  for (const object of shownObjects(panel.objects)) {
    for (const kind of kindsOf(object)) {
      const value = valueOf(kind, object);
      if (value) {
        states.push({
          device_feature_external_id: ids.feature(roleOf(kind, object.key)),
          ...value,
        });
      }
    }
  }
  return states;
}
