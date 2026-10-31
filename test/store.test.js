// -----------------------------------------------------------------------------
// /data: repaired and bounded when read; only stops (an equipment off, a
// heater off) are kept; a count that cannot be read is 0; a stop never acked
// has no resend; a date in the future counts as now; a special file is never
// read nor written.
// -----------------------------------------------------------------------------

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { constants } from 'node:fs';
import { mkdtemp, open, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileStore, normalizeMemory } from '../src/store.js';

const NOW = 1_800_000_000_000;
const stop = (extra) => ({
  host: '192.168.1.60',
  port: 10444,
  obj: '1_3',
  attr: 'STATUS',
  value: 'OFF',
  since: NOW - 1000,
  written: true,
  acked: true,
  resends: 2,
  ...extra,
});

test('stops: only offs, repaired, deduplicated; unreadable counts are 0', () => {
  const m = normalizeMemory(
    {
      stops: [
        stop(),
        stop(),
        stop({ obj: '1_23', value: 'ON' }),
        stop({ obj: '1_4', attr: 'ENABLE', value: '1' }),
        stop({ obj: '1_4', attr: 'ENABLE', value: '0', resends: 'x' }),
        stop({ obj: '0_27', written: false, resends: 3 }),
        stop({ obj: '8_14', acked: false, resends: 3 }),
        stop({ obj: '../x' }),
        stop({ obj: '1_3.1' }),
        stop({ host: 'a b' }),
        stop({ obj: '1_36', since: NOW + 1e9 }),
      ],
      lastAttemptAt: NOW + 5000,
      target: { host: '192.168.1.60', port: 10444, id: 'nothex' },
    },
    NOW,
  );
  assert.deepEqual(
    m.stops.map((s) => [s.obj, s.attr, s.value, s.resends, s.acked]),
    [
      ['1_3', 'STATUS', 'OFF', 2, true],
      ['1_4', 'ENABLE', '0', 0, true],
      ['0_27', 'STATUS', 'OFF', 0, false],
      ['8_14', 'STATUS', 'OFF', 0, false],
      ['1_36', 'STATUS', 'OFF', 2, true],
    ],
  );
  assert.equal(m.stops[4].since, NOW);
  assert.equal(m.lastAttemptAt, NOW);
  assert.equal(m.target.id, null);
  assert.deepEqual(normalizeMemory('garbage', NOW), {
    target: null,
    lastAttemptAt: null,
    stops: [],
  });
});

test('the file: 0600, unreadable is not empty; a FIFO never blocks', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'omni-store-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const path = join(dir, 'state.json');
  const store = fileStore(path);
  assert.deepEqual(await store.load(), { data: null });
  await store.save({ a: 1 });
  assert.equal((await stat(path)).mode & 0o777, 0o600);
  assert.deepEqual(await store.load(), { data: { a: 1 } });
  await writeFile(path, '{oops');
  assert.deepEqual(await store.load(), { unreadable: true });
  assert.equal(await readFile(path, 'utf8'), '{oops');
  // A FIFO in place of the file and of its temporary: never read nor written into.
  const fifo = join(dir, 'fifo.json');
  execFileSync('mkfifo', [fifo]);
  execFileSync('mkfifo', [`${fifo}.tmp`]);
  const special = fileStore(fifo);
  assert.deepEqual(await special.load(), { unreadable: true });
  // A FIFO holding JSON (a writer behind it): still never read.
  const writer = await open(fifo, constants.O_RDWR | constants.O_NONBLOCK);
  await writer.write('{"x":1}');
  assert.deepEqual(await special.load(), { unreadable: true });
  await writer.close();
  await special.save({ b: 2 });
  assert.deepEqual(await special.load(), { data: { b: 2 } });
});
