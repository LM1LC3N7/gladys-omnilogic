// -----------------------------------------------------------------------------
// The app against the SDK's fake Gladys and a fake OmniLogic controller (a
// dgram double, no network), with the exact wiring of the container
// (src/handlers.js) and the virtual clock of the kit: every read of the clock
// moves it on by 1 µs (a decision reading it twice sees it move), timers fire
// only when the test advances the time.
// -----------------------------------------------------------------------------

import { createFakeGladys } from '@gladysassistant/integration-sdk/testing';
import { OmniLogicApp } from '../src/app.js';
import { registerHandlers } from '../src/handlers.js';
import { panelIdOf } from '../src/omni/model.js';
import { memoryStore } from '../src/store.js';
import { HOST, NOW, fakeOmni } from './fixtures/fakeOmni.js';
import { settle, testClock } from './kit/clock.mjs';

export const SECOND = 1000;
export const MINUTE = 60 * SECOND;
export const ID = panelIdOf([
  { id: 1, bowType: 'BOW_POOL' },
  { id: 8, bowType: 'BOW_SPA' },
]);
export const DEVICE = `ext:test-integration:omnilogic:${ID}`;
export const feature = (role) => `${DEVICE}:${role}`;
export const CFG = { host: HOST };
export const ALLOW = {
  host: HOST,
  allow_equipment: true,
  allow_lights: true,
  allow_heating: true,
};

export function recorder(lines) {
  return Object.fromEntries(
    ['debug', 'info', 'warn', 'error'].map((l) => [
      l,
      (...a) => lines.push(`${l}: ${a.map((x) => (x instanceof Error ? x.message : x)).join(' ')}`),
    ]),
  );
}

export async function setup({
  config = CFG,
  clock = testClock({ start: NOW }),
  panel,
  store = memoryStore(),
  create = true,
  boot = false,
  getConfigFails = 0,
  getConfigHangs = false,
  devices = [],
} = {}) {
  const dev = panel ?? fakeOmni({ timers: clock.timers });
  dev.clockNow ??= () => clock.elapsed;
  const gladys = createFakeGladys({ config, devices });
  let left = getConfigFails;
  let calls = 0;
  const original = gladys.getConfig.bind(gladys);
  gladys.getConfig = async () => {
    calls += 1;
    // The SDK reads the configuration once before 'connected'; the app's reads may fail after.
    if (calls > 1 && getConfigHangs) {
      return new Promise(() => {});
    }
    if (calls > 1 && left > 0) {
      left -= 1;
      throw new Error('Gladys unreachable');
    }
    return original();
  };
  const lines = [];
  const logger = recorder(lines);
  const app = new OmniLogicApp({
    gladys,
    logger,
    createSocket: dev.createSocket,
    now: clock.now,
    monotonic: clock.monotonic,
    timers: clock.timers,
    store,
  });
  registerHandlers(gladys, app, logger);
  const advance = async (ms, step = 10) => {
    for (let e = 0; e < ms; e += step) {
      await clock.advance(Math.min(step, ms - e));
      await settle(2);
    }
  };
  if (boot) {
    await app.boot();
  }
  // The clock moves while a handler runs (the fake controller answers on its timers).
  const until = async (promise, ms = 60 * SECOND) => {
    let done = false;
    promise.then(
      () => (done = true),
      () => (done = true),
    );
    for (let e = 0; e < ms && !done; e += 100) await advance(100);
    return promise;
  };
  if (getConfigHangs) {
    gladys.connect();
    await advance(SECOND);
  } else {
    await until(gladys.connect());
  }
  await advance(500);
  if (create && gladys.fake.discoveredDevices.length > 0) {
    await until(gladys.fake.deviceCreated(gladys.fake.discoveredDevices[0]));
    await advance(1100);
  }
  const fire = (role, value) => {
    const d = gladys.fake.devices.find((x) => x.external_id === DEVICE) ?? { external_id: DEVICE };
    return gladys.fake.setValue(d, { external_id: feature(role) }, value);
  };
  const press = async (role, value, wait = 5 * SECOND) => {
    const ack = fire(role, value);
    await advance(wait, 50);
    return ack;
  };
  const state = (role) =>
    gladys.fake.states.findLast((s) => s.device_feature_external_id === feature(role));
  const status = () => {
    const current = gladys.fake.connectionStatus;
    return { ...current, text: current?.message?.fr ?? current?.message, en: current?.message?.en };
  };
  return {
    gladys,
    app,
    panel: dev,
    clock,
    advance,
    until,
    lines,
    fire,
    press,
    store,
    state,
    status,
  };
}

/** An ack of the fake Gladys: success, else the error shown. */
export function ok(ack) {
  if (!ack?.success) throw new Error(`refused: ${ack?.error}`);
  return ack;
}

export function refused(ack, pattern) {
  if (ack?.success) throw new Error(`accepted, expected ${pattern}`);
  if (pattern && !pattern.test(String(ack?.error))) {
    throw new Error(`refused with "${ack?.error}", expected ${pattern}`);
  }
  return ack;
}
