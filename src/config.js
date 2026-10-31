// -----------------------------------------------------------------------------
// The configuration: the manifest `config_schema` values, normalized so the
// rest of the code never deals with strings typed in a form. The controller has no
// credentials: nothing secret is configured.
// -----------------------------------------------------------------------------

import { isIP } from 'node:net';
import { DEFAULT_PORT, POLL_INTERVAL, SETPOINT } from './constants.js';

/** Defaults, mirrored by the manifest (checked by test/manifest.test.js). */
export const DEFAULT_CONFIG = {
  host: '',
  allow_equipment: false,
  allow_lights: false,
  allow_heating: false,
  max_pool_setpoint: SETPOINT.poolCeilingDefault,
  poll_interval: POLL_INTERVAL.default,
  language: 'fr',
};

const LABEL = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/i;

/** Addresses that are never one controller: broadcast, multicast, "any". */
function unusableIpv4(host) {
  const [a, b, c, d] = host.split('.').map(Number);
  return a === 0 || (a === 255 && b === 255 && c === 255 && d === 255) || (a >= 224 && a <= 239);
}

/**
 * The address of the controller typed by the user: an IPv4 address or a host
 * name, with an optional port (10444 by default).
 * @returns {{ host: string, port: number } | undefined} undefined when invalid or empty.
 */
export function parseAddress(raw) {
  const text = String(raw ?? '')
    .trim()
    .toLowerCase();
  // Spaces and control characters (CR, LF...) are never part of an address.
  // eslint-disable-next-line no-control-regex
  if (text === '' || text.length > 260 || /[\s\u0000-\u001f\u007f]/.test(text)) {
    return undefined;
  }
  const match = text.match(/^([^:/@?#]+)(?::(\d{1,5}))?$/);
  if (!match) {
    return undefined;
  }
  const host = match[1];
  const port = match[2] === undefined ? DEFAULT_PORT : Number(match[2]);
  if (!Number.isInteger(port) || port < 1 || port > 65535 || host.length > 253) {
    return undefined;
  }
  if (isIP(host) === 4) {
    return unusableIpv4(host) ? undefined : { host, port };
  }
  if (/^[\d.]+$/.test(host)) {
    return undefined;
  }
  return host.split('.').every((label) => LABEL.test(label)) ? { host, port } : undefined;
}

export const addressKey = ({ host, port }) => (port === DEFAULT_PORT ? host : `${host}:${port}`);

export const sameAddress = (a, b) => Boolean(a && b) && a.host === b.host && a.port === b.port;

/** Only `true` (or the text "true") allows: anything else, missing included, refuses. */
const strictTrue = (value) => value === true || value === 'true';

/** A whole number typed in the form, bounded; the default when missing or not a number. */
function bounded(value, { min, max, fallback, round = Math.round }) {
  if (value === null || value === undefined || typeof value === 'boolean') {
    return fallback;
  }
  const text = String(value).trim();
  const n = typeof value === 'number' ? value : text === '' ? NaN : Number(text);
  if (!Number.isFinite(n)) {
    return fallback;
  }
  return Math.min(max, Math.max(min, round(n)));
}

export function normalizeConfig(raw = {}) {
  const c = { ...DEFAULT_CONFIG };
  for (const [key, value] of Object.entries(raw ?? {})) {
    if (Object.hasOwn(DEFAULT_CONFIG, key) && value != null) {
      c[key] = value;
    }
  }
  const host = String(c.host ?? '').trim();
  const address = parseAddress(host);
  return {
    address,
    /** The text typed when it is not an address (shown in the status, cut). */
    invalidHost: host !== '' && !address ? host.slice(0, 100) : undefined,
    allowEquipment: strictTrue(c.allow_equipment),
    allowLights: strictTrue(c.allow_lights),
    allowHeating: strictTrue(c.allow_heating),
    /** The highest heating set point of a pool, °C (a spa: 40 °C, fixed). Rounded down. */
    poolCeiling: bounded(c.max_pool_setpoint, {
      min: SETPOINT.poolCeilingMin,
      max: SETPOINT.poolCeilingMax,
      fallback: SETPOINT.poolCeilingDefault,
      round: Math.floor,
    }),
    pollInterval: bounded(c.poll_interval, {
      min: POLL_INTERVAL.min,
      max: POLL_INTERVAL.max,
      fallback: POLL_INTERVAL.default,
    }),
    language: c.language === 'en' ? 'en' : 'fr',
  };
}
