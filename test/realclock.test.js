// -----------------------------------------------------------------------------
// The app on the REAL clock, sped up 20 times (30 s of the interval are 1.5 s,
// but it is the real clock: it moves between any two reads of it), against a
// real local UDP socket answering like the fake controller: the reads really
// start at the interval, never sooner, one socket at a time, and a stop goes
// at once.
// -----------------------------------------------------------------------------

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createFakeGladys } from '@gladysassistant/integration-sdk/testing';
import { OmniLogicApp } from '../src/app.js';
import { memoryStore } from '../src/store.js';
import { fakeOmni } from './fixtures/fakeOmni.js';
import { ID } from './helpers.js';
import { measurePeriod, realClock, spyOn } from './kit/clock.mjs';

const SPEED = 20;
const INTERVAL = 30_000;

test('real clock x20: a read every interval, a stop at once', async () => {
  const omni = fakeOmni({ timers: globalThis, latencyMs: 2 });
  omni.state.relays[0].state = 1;
  const port = await omni.listen();
  const clock = realClock({ speed: SPEED });
  const gladys = createFakeGladys({ config: {} });
  await gladys.connect();
  const quiet = () => {};
  const app = new OmniLogicApp({
    gladys,
    logger: { debug: quiet, info: quiet, warn: quiet, error: quiet },
    now: clock.now,
    monotonic: clock.monotonic,
    timers: clock.timers,
    store: memoryStore(),
  });
  const spy = spyOn(app, 'run', clock);
  try {
    await app.connected({ host: `127.0.0.1:${port}`, poll_interval: INTERVAL / 1000 });
    const gaps = await measurePeriod(spy, { count: 3, period: INTERVAL });
    assert.equal(gaps.length, 2);
    assert.equal(gladys.fake.connectionStatus.connected, true);
    assert.equal(omni.count(1), 1, 'the configuration read once');
    const started = clock.monotonic();
    await app.setValue(
      undefined,
      { external_id: `ext:test-integration:omnilogic:${ID}:onoff-0_27` },
      'off',
    );
    assert.equal(omni.state.relays[0].state, 0);
    assert.ok(clock.monotonic() - started < 4_300, 'within the ack budget');
  } finally {
    spy.restore();
    await app.shutdown();
    clock.close();
    await omni.close();
  }
  assert.ok(clock.timersSet < 600, `${clock.timersSet} timers`);
});
