// -----------------------------------------------------------------------------
// The integration: the OmniLogic controller typed in the configuration (one
// address, no credentials), one read of it every poll interval, its Gladys
// device and states, the transport badge, the "Test the connection" button,
// the commands (pumps and relays, lights, heating: each only when the
// configuration allows it) and the stops (never held back). index.js only
// wires the SDK handlers to it.
//
// One request at a time (src/lane.js), each on a new UDP socket
// (src/omni/client.js): the reads of a poll, a batch of commands (its fresh
// read, its writes, its read back), the stops and their checks.
//
// Reads:
//   - never sooner than the interval after the last one: not for the test
//     button, a Discovery scan, a reconnection to Gladys, a configuration
//     saved unchanged, nor a restart (the time of the last read is kept in
//     /data, written at most once a minute, BEFORE the read); only the reads
//     that follow a command (5 s, 20 s);
//   - the telemetry first; the configuration (MSPConfig) only when none is
//     known or the checksum of the telemetry changed (then the telemetry
//     again, which must match it);
//   - a read begun before a write left is not applied (ordered by the time
//     requests start, never by the time answers come); values older than 2
//     minutes are never sent as new.
//
// Commands (an equipment on, a heater on, a heating set point):
//   - refused unless the configuration allows them ("pumps and relays",
//     "lights", "heating"), checked on arrival and again right before each
//     datagram (in `beforeSend`, nothing in between); turning on a filter
//     pump whose body's heater is not seen off also needs "heating";
//   - decided on a fresh telemetry (identity: the checksum and the bodies of
//     the configuration; the backyard not in service mode; the object),
//     never on the state in memory; refused when a value they need is missing;
//   - set points bounded on the whole °F written: the heater's limits, the
//     protocol's 65..104 °F, a spa 40 °C, a pool the ceiling of the
//     configuration (35 °C by default);
//   - commands arriving together (a scene) go in one batch, one datagram
//     each; each leaves by 3.5 s after its click or not at all, is answered
//     by 4.3 s, and is confirmed only by a read back showing what was asked
//     ("sent, not applied yet" when it shows what was there before).
//
// The stops (an equipment off, a heater off) protect: never held back by the
// options, a read or a command in progress (they end them), a failed read, a
// controller never read, an unknown identity, nor a configuration not read
// yet (they go to the address of the last read kept in /data, and the stops
// kept there are sent again at the start of the container, before the
// configuration). A command that arrived before a stop and has not left
// gives way. Tried again every 250 ms for 3 s; not seen applied, a stop is
// kept in /data and checked every 15 s: written again while the controller
// does not show it (3 acked writes at most, then held and said in the
// status), let go when the controller shows it, or when a newer command for
// the same setting clicked in Gladys left. Never by time.
//
// Clocks: `monotonic` paces everything in memory (reads, retries, waits,
// deadlines), so that a wall clock moved by NTP never stops nor hurries
// them; the wall clock only dates what /data keeps for the next process.
// -----------------------------------------------------------------------------

import { DEVICE_TRANSPORTS, createLogger } from '@gladysassistant/integration-sdk';
import { addressKey, normalizeConfig, sameAddress } from './config.js';
import { KINDS, LIMITS, OFF, ON, SECOND, SELECT_VALUES, STOP_ATTRS, TIMINGS } from './constants.js';
import {
  COMMAND_KINDS,
  buildDevice,
  deviceName,
  deviceStates,
  objectName,
  panelIds,
  parseDeviceId,
  parseFeatureId,
  shownObjects,
} from './devices.js';
import { ERRORS, T, age, join, word } from './i18n.js';
import { ERROR_KINDS, PanelClient, PanelError, errorReason } from './omni/client.js';
import {
  ceilingOf,
  heldSetpointProblem,
  mergeObjects,
  onSpeedOf,
  parseConfig,
  parseTelemetry,
  sameController,
  setpointToWrite,
  splitKey,
  stopValuesOf,
} from './omni/model.js';
import { REQUESTS } from './omni/protocol.js';
import { Lane } from './lane.js';
import { StatePublisher } from './publisher.js';
import { fileStore, normalizeMemory } from './store.js';

/** The key of a stop: its address and what it writes. */
const stopKey = (target, obj, attr) => `${target.host}:${target.port}|${obj}|${attr}`;
const settingKey = (obj, attr) => `${obj}|${attr}`;

/** The heater of a body (its object), from the objects read, else undefined. */
const heaterOfBody = (bow, objects) =>
  [...(objects?.values() ?? [])].find((o) => o.type === 'HEATER' && o.bow === bow);

/** Whether a heater may heat: not seen off (ENABLE "0") with no heater seen on. */
const mayHeat = (heater) =>
  !heater || heater.values.ENABLE !== '0' || heater.values.HEATING !== '0';

/** The request of a stop (never a read first): an equipment off, a heater off. */
function stopRequest(guard) {
  const { bow, id } = splitKey(guard.obj);
  return guard.attr === STOP_ATTRS.HEATER
    ? REQUESTS.heaterEnable(bow, id, 0)
    : REQUESTS.equipment(bow, id, 0);
}

/** The option names of the status and the errors. */
const OPTION_TEXTS = {
  equipment: T.optionEquipment,
  lights: T.optionLights,
  heating: T.optionHeating,
};

/** A value of a select command: a short string, trimmed; else undefined. */
function selectValue(value) {
  return typeof value === 'string' && value.length <= 40 ? value.trim() : undefined;
}

/** A set point asked: a finite number, or a strict decimal text ("28", "28.5"); never "", true, null. */
function setpointValue(value) {
  if (typeof value === 'number') return Number.isFinite(value) ? value : undefined;
  if (typeof value === 'string' && /^\s*-?\d{1,3}(?:\.\d{1,3})?\s*$/.test(value)) {
    return Number(value.trim());
  }
  return undefined;
}

const freshPanel = () => ({
  id: undefined,
  name: undefined,
  version: undefined,
  /** The configuration read (MSPConfig), the checksum it goes with, when (monotonic). */
  config: undefined,
  checksum: undefined,
  configAt: -Infinity,
  service: false,
  objects: undefined,
  /** Monotonic time the last applied read started (-Infinity: none). */
  readAt: -Infinity,
  online: undefined,
  failures: 0,
  wait: undefined,
  error: undefined,
  timer: undefined,
  running: undefined,
  followUps: new Set(),
});

export class OmniLogicApp {
  constructor({
    gladys,
    logger = createLogger({ name: 'omnilogic' }),
    createSocket,
    now = Date.now,
    monotonic = () => performance.now(),
    timers = globalThis,
    store = fileStore(),
  }) {
    this.gladys = gladys;
    this.logger = logger;
    this.now = now;
    this.monotonic = monotonic;
    this.timers = timers;
    this.store = store;
    this.client = new PanelClient({ createSocket, timers, now: monotonic, wallNow: now });
    this.publisher = new StatePublisher({ gladys, logger, now: monotonic, timers });
    this.lane = new Lane();
    this.config = normalizeConfig();
    this.memory = normalizeMemory(null, now());
    /** /data could not be read: never overwritten (a guess would lose what it holds). */
    this.memoryUnreadable = false;
    this.memoryLoaded = undefined;
    this.panel = freshPanel();
    this.generation = 0;
    this.started = false;
    this.configRead = false;
    this.configSeq = 0;
    this.savedRaw = undefined;
    this.configChain = Promise.resolve();
    this.configTimer = undefined;
    /** Monotonic time of the last read sent (never sooner than the interval). */
    this.lastAttemptAt = -Infinity;
    this.attemptSavedAt = -Infinity;
    this.lastStatus = undefined;
    this.published = undefined;
    this.badge = undefined;
    /** Monotonic time the last write left (a read begun before it is not applied). */
    this.lastSentAt = -Infinity;
    /** object key -> monotonic time a command (not a stop) last left for it. */
    this.lastOnSentAt = new Map();
    /** setting key -> monotonic end: a command sent and not confirmed (never "already so" meanwhile). */
    this.pending = new Map();
    /**
     * Stop keys (address and setting) a command of this run left for (acked,
     * or no ack): newer than any stop kept in /data, which
     * never undoes it (a /data read late, src: adoptStops).
     */
    this.commandsLeft = new Set();
    /** Commands waiting for their batch, and the worker running the batches. */
    this.commandQueue = [];
    this.commandWorker = undefined;
    /** Counts the stops: a command that arrived before the current count gives way. */
    this.protectSeq = 0;
    this.stops = [];
    this.stopWorker = undefined;
    /** stop key -> the stop not seen applied. */
    this.guards = new Map();
    /** address key -> { timer, dueAt }: the check of the stops of each address. */
    this.checks = new Map();
    /** The address keys whose check runs now. */
    this.checking = new Set();
    /** The stops clicked while no address was known: sent first once one is. */
    this.addressless = [];
    /** The JSON of the stops last saved to /data with success. */
    this.savedStops = '[]';
  }

  /** The monotonic clock (every in-memory time). */
  mono() {
    return this.monotonic();
  }

  /** Waits `ms`; ends at once when `signal` aborts (a stop takes the line). */
  sleep(ms, signal) {
    return new Promise((resolve) => {
      if (signal?.aborted) {
        resolve();
        return;
      }
      const done = () => {
        this.timers.clearTimeout(timer);
        signal?.removeEventListener('abort', done);
        resolve();
      };
      const timer = this.timers.setTimeout(done, Math.max(0, ms));
      signal?.addEventListener('abort', done, { once: true });
    });
  }

  /**
   * `promise` raced against `ms`: `{ done: true, value }`, or `{ done: false }`
   * when the time ran out. Never an unbounded wait on the path of a stop.
   */
  async bounded(promise, ms) {
    let timer;
    const late = new Promise((resolve) => {
      timer = this.timers.setTimeout(() => resolve({ done: false }), Math.max(0, ms));
    });
    try {
      return await Promise.race([
        promise.then(
          (value) => ({ done: true, value }),
          () => ({ done: true, value: undefined }),
        ),
        late,
      ]);
    } finally {
      this.timers.clearTimeout(timer);
    }
  }

  refusal(text) {
    return new Error(word(text, this.config.language));
  }

  // --- /data -------------------------------------------------------------------

  /**
   * Loads /data once (the stops kept there belong to the whole run). Nothing
   * waits for it more than 2 s: past that, /data counts as unreadable (never
   * overwritten) until the load ends; a load that ends late is applied then
   * (its stops sent, the flag lifted). Only a real read error or invalid
   * JSON is unreadable for good.
   */
  loadMemory() {
    if (!this.memoryLoaded) {
      const load = (async () => {
        try {
          return (await this.store.load()) ?? { unreadable: true };
        } catch {
          return { unreadable: true };
        }
      })();
      this.memoryLoaded = (async () => {
        const first = await this.bounded(load, TIMINGS.loadWait);
        if (!first.done) {
          // Slow disk: go on as unreadable for now, apply the load when it ends.
          this.memoryUnreadable = true;
          this.logger.warn('OmniLogic: /data is slow to read: not written until it is read');
          load.then((result) => this.lateLoad(result)).catch(() => {});
          return;
        }
        this.applyLoad(first.value);
      })().finally(() => this.flushAddressless());
    }
    return this.memoryLoaded;
  }

  /** The content of /data read in time. */
  applyLoad(result) {
    if (result?.unreadable) {
      this.memoryUnreadable = true;
      this.logger.warn(
        'OmniLogic: /data/omnilogic-state.json cannot be read: it is never overwritten',
      );
      this.memory = normalizeMemory(null, this.now());
      return;
    }
    this.memory = normalizeMemory(result?.data ?? null, this.now());
    this.savedStops = JSON.stringify(this.memory.stops);
  }

  /**
   * /data read after the 2 s: merged into what this run already knows (a stop
   * kept in memory wins over the one of the file, a command of this run that
   * left drops the stop of its setting), its stops sent as at a start, and
   * /data written again from now on.
   */
  lateLoad(result) {
    if (result?.unreadable) {
      this.logger.warn('OmniLogic: /data cannot be read: it is never overwritten');
      return;
    }
    const loaded = normalizeMemory(result?.data ?? null, this.now());
    // The controller read in this run, if any (only a read sets the target).
    const known = this.memory.target;
    this.memoryUnreadable = false;
    this.memory.target = this.memory.target ?? loaded.target;
    if (loaded.lastAttemptAt !== null) {
      this.memory.lastAttemptAt = Math.max(
        this.memory.lastAttemptAt ?? -Infinity,
        loaded.lastAttemptAt,
      );
      this.lastAttemptAt = Math.max(
        this.lastAttemptAt,
        this.mono() - (this.now() - loaded.lastAttemptAt),
      );
    }
    this.savedStops = JSON.stringify(loaded.stops);
    this.memory.stops = loaded.stops;
    this.logger.warn('OmniLogic: /data read late: applied now');
    this.adoptStops(this.followPanel(loaded.stops, loaded.target, known));
    this.flushAddressless();
    this.persistStops().catch(() => {});
    this.saveMemory().catch(() => {});
  }

  async saveMemory() {
    if (this.memoryUnreadable) {
      return false;
    }
    try {
      await this.store.save(this.memory);
      return true;
    } catch (err) {
      this.logger.warn(`OmniLogic: saving the state to /data failed: ${err.message}`);
      return false;
    }
  }

  /** The stops not seen applied, in /data. */
  persistStops() {
    const stops = [...this.guards.values()].map((g) => ({
      host: g.target.host,
      port: g.target.port,
      obj: g.obj,
      attr: g.attr,
      value: g.value,
      since: g.since,
      written: g.written,
      acked: g.acked,
      resends: g.resends,
    }));
    // Compared with the last save that succeeded: a failed one is tried again.
    const json = JSON.stringify(stops);
    if (json === this.savedStops) {
      return Promise.resolve(true);
    }
    this.memory.stops = stops;
    return this.saveMemory().then((ok) => {
      if (ok && JSON.stringify(this.memory.stops) === json) this.savedStops = json;
      return ok;
    });
  }

  /**
   * At the start of the container, before the configuration is read: the
   * stops kept in /data (not seen applied before the restart) are sent again
   * at once to the address they were sent to, without a read first. Those
   * held (written 4 times without effect) are only checked.
   */
  async boot() {
    await this.loadMemory();
    this.adoptStops(this.memory.stops);
  }

  /**
   * The stops of a /data read late, when this run already read the same
   * controller (same id) at another address: those of its old address follow it
   * (as `retargetStops` does for a read after the load).
   */
  followPanel(stops, from, known) {
    if (!known || !from?.id || known.id !== from.id || sameAddress(known, from)) {
      return stops;
    }
    return stops.map((s) =>
      sameAddress(s, from) ? { ...s, host: known.host, port: known.port } : s,
    );
  }

  /** Stops read from /data: kept as guards (never over one this run holds), the unheld sent now. */
  adoptStops(stops) {
    const send = new Map();
    let dropped = false;
    for (const kept of stops) {
      const target = { host: kept.host, port: kept.port };
      const key = stopKey(target, kept.obj, kept.attr);
      if (this.guards.has(key)) continue;
      if (this.commandsLeft.has(key)) {
        // Clicked before the restart; a command of this setting left since
        // (a /data read late): the newer intent, never undone.
        this.logger.warn(
          `OmniLogic: a stop kept in /data for ${kept.obj} let go (a newer command left)`,
        );
        dropped = true;
        continue;
      }
      const guard = this.newGuard(target, kept);
      guard.since = kept.since;
      guard.written = kept.written;
      guard.acked = kept.acked;
      guard.resends = kept.resends;
      this.guards.set(key, guard);
      if (guard.acked && guard.resends >= TIMINGS.stopResends) {
        this.logger.warn('OmniLogic: a stop held in /data is checked again');
        continue;
      }
      const at = addressKey(target);
      if (!send.has(at)) send.set(at, { target, specs: [] });
      send.get(at).specs.push(kept);
    }
    for (const target of this.stopAddresses()) {
      this.armStopCheck(send.has(addressKey(target)) ? TIMINGS.stopCheck : 0, target);
    }
    for (const { target, specs } of send.values()) {
      this.logger.warn(`OmniLogic: ${specs.length} stop(s) kept in /data sent again`);
      this.queueStop({ target, specs, received: this.mono(), fromBoot: true });
    }
    // /data without the stops let go (a restart never sends them again).
    if (dropped) this.persistStops().catch(() => {});
  }

  // --- Lifecycle -------------------------------------------------------------

  /**
   * `fresh`: started for a new address while running (a read may go at
   * once); otherwise (container start) the first read waits for the interval
   * after the last read kept in /data.
   */
  async start(raw = {}, { fresh = false } = {}) {
    this.stop();
    this.config = normalizeConfig(raw);
    const generation = this.generation;
    // A stop clicked before any address was known goes now, first.
    this.flushAddressless();
    await this.panel.running;
    await this.loadMemory();
    if (generation !== this.generation) {
      return;
    }
    this.panel = freshPanel();
    // The controller last read at this address: its id, shown offline until it is read again.
    const kept = this.memory.target;
    if (this.config.address && sameAddress(kept, this.config.address) && kept.id) {
      this.panel.id = kept.id;
    }
    this.published = undefined;
    this.badge = undefined;
    this.lastStatus = undefined;
    this.publisher.start();
    // The configuration is known now: the stops are checked at once.
    for (const target of this.stopAddresses()) this.armStopCheck(0, target);
    if (!this.config.address) {
      await this.publishAll();
      return;
    }
    await this.setStatus(false, this.status()[1], generation);
    if (generation !== this.generation) {
      return;
    }
    const wait = fresh ? 0 : this.firstWait();
    if (wait > 0) {
      this.schedule(wait);
      await this.publishAll();
      return;
    }
    await this.tick();
  }

  /** The wait before the first read after a container start, from the time kept in /data. */
  firstWait() {
    if (this.memoryUnreadable) {
      // The time of the last read is unknown: a whole interval.
      return this.interval;
    }
    const stored = this.memory.lastAttemptAt;
    if (stored === null) {
      return 0;
    }
    this.lastAttemptAt = Math.max(this.lastAttemptAt, this.mono() - (this.now() - stored));
    // A read may have left up to a minute after the time kept (written at most once a minute).
    const due = stored + TIMINGS.attemptWriteEvery + this.interval;
    return Math.min(this.interval, Math.max(0, due - this.now()));
  }

  stop() {
    this.generation += 1;
    this.clearTimer();
    if (this.configTimer) {
      this.timers.clearTimeout(this.configTimer);
      this.configTimer = undefined;
    }
    for (const handle of this.panel.followUps) {
      this.timers.clearTimeout(handle);
    }
    this.panel.followUps.clear();
    // A read of this configuration ends (a stop or its check has its own target).
    if (this.lane.holder?.kind === 'read') {
      this.lane.holder.controller.abort();
    }
    this.publisher.stop();
  }

  /** The container stops: every timer (the stops are in /data), /data written, the socket closed. */
  async shutdown() {
    this.stop();
    for (const check of this.checks.values()) this.timers.clearTimeout(check.timer);
    this.checks.clear();
    this.memory.lastAttemptAt = Number.isFinite(this.lastAttemptAt)
      ? this.now() - (this.mono() - this.lastAttemptAt)
      : this.memory.lastAttemptAt;
    await this.bounded(this.saveMemory(), 2 * SECOND);
    await this.client.close();
  }

  clearTimer() {
    if (this.panel.timer) {
      this.timers.clearTimeout(this.panel.timer);
      this.panel.timer = undefined;
    }
  }

  /**
   * Connected to Gladys: reads the configuration, tried again every 30 s
   * while it fails (with a status), forever, then `connected`.
   */
  async onConnected(getConfig) {
    if (this.configTimer) {
      this.timers.clearTimeout(this.configTimer);
      this.configTimer = undefined;
    }
    // A configuration saved after this request left wins over its answer.
    const seq = this.configSeq;
    let raw;
    try {
      raw = await getConfig();
    } catch (err) {
      this.logger.warn(`OmniLogic: reading the configuration failed: ${err.message}`);
      await this.loadMemory();
      this.lastStatus = undefined;
      await this.setStatus(false, T.configUnreadable);
      this.configTimer = this.timers.setTimeout(() => {
        this.configTimer = undefined;
        this.onConnected(getConfig).catch(() => {});
      }, TIMINGS.configRetry);
      return;
    }
    await this.inOrder(() => this.connected(seq !== this.configSeq ? this.savedRaw : raw));
  }

  /** Configurations (read or saved) applied one at a time, in their order of arrival. */
  inOrder(fn) {
    const run = this.configChain.then(fn);
    this.configChain = run.catch(() => {});
    return run;
  }

  /**
   * Connected to Gladys. The first time, start; after a reconnection (Gladys
   * restarted), resend what Gladys keeps in memory only (status, Discovery
   * list, badge), without reading the controller nor sending old values.
   */
  async connected(raw = {}) {
    this.configRead = true;
    if (!this.started) {
      this.started = true;
      await this.start(raw);
      return;
    }
    if (this.needsRestart(raw)) {
      await this.start(raw, { fresh: true });
      return;
    }
    const previous = this.config;
    this.config = normalizeConfig(raw);
    this.published = undefined;
    this.badge = undefined;
    this.lastStatus = undefined;
    this.gladys.forgetPublishedStates?.();
    this.rescheduleOnNewInterval(previous);
    await this.publishAll();
  }

  /** Only a new address restarts (an interval only reschedules). */
  needsRestart(raw) {
    const next = normalizeConfig(raw);
    return (
      JSON.stringify(next.address ?? null) !== JSON.stringify(this.config.address ?? null) ||
      next.invalidHost !== this.config.invalidHost
    );
  }

  rescheduleOnNewInterval(previous) {
    const p = this.panel;
    if (
      this.config.pollInterval !== previous.pollInterval &&
      this.config.address &&
      !p.running &&
      p.online !== false &&
      p.timer
    ) {
      this.schedule(this.dueIn());
    }
  }

  /** The configuration saved: applied in order of arrival, the last one wins. */
  configUpdated(raw = {}) {
    this.configSeq += 1;
    this.savedRaw = raw;
    return this.inOrder(() => this.applyConfig(raw));
  }

  async applyConfig(raw) {
    this.configRead = true;
    if (!this.started || this.needsRestart(raw)) {
      this.started = true;
      await this.start(raw, { fresh: true });
      return;
    }
    const previous = this.config;
    this.config = normalizeConfig(raw);
    this.rescheduleOnNewInterval(previous);
    if (this.config.language !== previous.language) {
      this.published = undefined;
    }
    await this.publishAll();
  }

  async setStatus(connected, message, generation = this.generation) {
    if (generation !== this.generation) {
      return;
    }
    const key = JSON.stringify([connected, message ?? null]);
    if (key === this.lastStatus) {
      return;
    }
    this.lastStatus = key;
    await this.gladys
      .setConnectionStatus(connected, message)
      .catch((err) => this.logger.warn(`setConnectionStatus failed: ${err.message}`));
  }

  // --- Polling ---------------------------------------------------------------

  get interval() {
    return this.config.pollInterval * SECOND;
  }

  /** The time until the next read may go (never sooner than the interval). */
  dueIn(mono = this.mono()) {
    return Math.max(0, this.lastAttemptAt + this.interval - mono);
  }

  /** The next read: after its backoff, else the interval. */
  schedule(delay) {
    const p = this.panel;
    this.clearTimer();
    const wait = delay ?? (p.online === false ? p.wait : this.interval);
    const generation = this.generation;
    p.timer = this.timers.setTimeout(
      () => {
        p.timer = undefined;
        if (generation === this.generation) {
          this.tick().catch((err) => this.logger.error(`OmniLogic refresh failed: ${err.message}`));
        }
      },
      Math.max(0, wait ?? this.interval),
    );
  }

  /** One read at a time: a tick during a read joins it. */
  tick() {
    const p = this.panel;
    if (!p.running) {
      p.running = this.run().finally(() => {
        p.running = undefined;
      });
    }
    return p.running;
  }

  /** The time of this read, in memory and (at most once a minute) in /data, BEFORE it. */
  async noteAttempt() {
    const mono = this.mono();
    this.lastAttemptAt = mono;
    if (mono - this.attemptSavedAt >= TIMINGS.attemptWriteEvery) {
      this.attemptSavedAt = mono;
      this.memory.lastAttemptAt = this.now();
      // Bounded: a hung disk never stops the reads (nor a new configuration waiting for them).
      await this.bounded(this.saveMemory(), TIMINGS.saveWait);
    }
  }

  async run() {
    const generation = this.generation;
    let delay;
    await this.noteAttempt();
    const startedAt = this.mono();
    try {
      const read = await this.readAll(generation);
      if (generation !== this.generation) {
        return;
      }
      if (startedAt <= this.lastSentAt) {
        // Begun before a write left: it may show the state before it.
        this.logger.debug('OmniLogic: read begun before a write, not applied');
      } else {
        this.applyRead(read, startedAt);
        await this.saveTarget();
        this.observeStops(read.telemetry, startedAt, this.config.address);
      }
    } catch (err) {
      if (generation !== this.generation) {
        return;
      }
      if (err?.kind === ERROR_KINDS.ABORTED) {
        // The line was taken (a stop): not a failure, nothing applied.
        this.logger.debug('OmniLogic: read ended by a stop');
      } else {
        delay = this.failed(err);
      }
    }
    if (generation !== this.generation) {
      return;
    }
    await this.publishAll();
    if (generation === this.generation) {
      this.schedule(delay);
    }
  }

  /** One request on the line (a turn of its own: a command or a stop may pass between two). */
  async read(spec, generation) {
    const holder = await this.lane.acquire('read');
    try {
      if (generation !== this.generation) {
        throw new PanelError(ERROR_KINDS.ABORTED, 'Configuration changed');
      }
      return await this.client.request(this.config.address, spec, {
        timeoutMs: TIMINGS.readTimeout,
        signal: holder.signal,
      });
    } finally {
      holder.release();
    }
  }

  /** The telemetry, read and parsed (a PROTOCOL error when it is not one). */
  async readTelemetry(generation) {
    const telemetry = parseTelemetry(await this.read(REQUESTS.telemetry(), generation));
    if (!telemetry) {
      throw new PanelError(ERROR_KINDS.PROTOCOL, 'Not a controller', { notPanel: true });
    }
    return telemetry;
  }

  /** Whether the configuration must be read again for this telemetry. */
  needsConfig(telemetry) {
    const p = this.panel;
    if (!p.config) return true;
    if (telemetry.checksum === undefined) {
      return this.mono() - p.configAt > TIMINGS.configMaxAge;
    }
    return telemetry.checksum !== p.checksum;
  }

  /**
   * The telemetry; the configuration too when it is needed (none, a new
   * checksum), then the telemetry again, which must match it.
   */
  async readAll(generation) {
    const first = await this.readTelemetry(generation);
    if (!this.needsConfig(first)) {
      const p = this.panel;
      if (!sameController(p.config, p.checksum, first)) {
        throw new PanelError(ERROR_KINDS.PROTOCOL, 'Bodies changed');
      }
      return { config: p.config, checksum: p.checksum, telemetry: first, configAt: p.configAt };
    }
    const configAt = this.mono();
    const config = parseConfig(await this.read(REQUESTS.configuration(), generation));
    if (!config) {
      throw new PanelError(ERROR_KINDS.PROTOCOL, 'Not a controller', { notPanel: true });
    }
    const telemetry = await this.readTelemetry(generation);
    if (!sameController(config, first.checksum, telemetry)) {
      // The configuration changed while it was read: again at the next read.
      throw new PanelError(ERROR_KINDS.PROTOCOL, 'Configuration changing');
    }
    return { config, checksum: first.checksum, telemetry, configAt };
  }

  /** A read answered: the controller as read. */
  applyRead({ config, checksum, telemetry, configAt }, startedAt) {
    const p = this.panel;
    if (p.id && p.id !== config.id) {
      this.logger.warn('OmniLogic: another controller answers at this address');
    }
    p.online = true;
    p.failures = 0;
    p.wait = undefined;
    p.error = undefined;
    p.id = config.id;
    p.name = config.name;
    p.version = telemetry.version;
    p.config = config;
    p.checksum = checksum;
    p.configAt = configAt;
    p.objects = mergeObjects(config, telemetry);
    p.service = p.objects.get('0_0')?.values.STATE !== '1';
    p.readAt = startedAt;
  }

  /** Keeps in /data the address and id of the controller read, when they changed. */
  async saveTarget() {
    const p = this.panel;
    const address = this.config.address;
    const kept = this.memory.target;
    if (!p.id || (sameAddress(kept, address) && kept.id === p.id)) {
      return;
    }
    if (kept && kept.id === p.id && !sameAddress(kept, address)) {
      // The same controller at a new address (DHCP, a host name typed): its kept
      // stops follow it.
      this.retargetStops(kept, address);
    }
    this.memory.target = { host: address.host, port: address.port, id: p.id };
    await this.bounded(this.saveMemory(), TIMINGS.saveWait);
  }

  /** A failed read: the delay before the next one (never sooner than the interval). */
  failed(err) {
    const p = this.panel;
    const reason = errorReason(err);
    const wait = Math.max(
      this.interval,
      TIMINGS.backoff[Math.min(p.failures, TIMINGS.backoff.length - 1)],
    );
    p.failures += 1;
    p.online = false;
    p.wait = wait;
    p.error = err?.notPanel ? 'not_panel' : (err?.kind ?? reason);
    this.logger.warn(`OmniLogic: ${reason}; next try in ${Math.round(wait / 1000)} s`);
    return wait;
  }

  // --- Status ------------------------------------------------------------------

  /** The name of an object of the controller for the status. */
  nameOf(obj) {
    return objectName(this.panel.objects?.get(obj), obj, this.config.language);
  }

  /** Where each stop not seen applied is, exactly (5 at most, then their count). */
  stopNotes() {
    const notes = [];
    for (const g of this.guards.values()) {
      let state;
      if (!g.written) state = 'notSent';
      else if (!g.acked) state = 'noAck';
      else if (g.applied) state = 'watch';
      else if (g.heatingSince !== undefined && g.heatUnknown) state = 'heatUnknown';
      else if (g.heatingSince !== undefined) {
        state = this.mono() - g.heatingSince < TIMINGS.coolDown ? 'coolDown' : 'stillHeating';
      } else if (g.resends >= TIMINGS.stopResends) state = 'held';
      else state = 'waiting';
      notes.push(T.stopState(this.nameOf(g.obj), g.attr, state));
    }
    if (notes.length > 5) {
      const more = notes.length - 5;
      return [...notes.slice(0, 5), { en: `(+${more})`, fr: `(+${more})` }];
    }
    return notes;
  }

  withNotes(message) {
    let text = message;
    for (const note of this.stopNotes()) {
      text = join(text, note);
    }
    return text;
  }

  /** The options turned off, for the status. */
  optionsOff() {
    const off = [];
    if (!this.config.allowEquipment) off.push(OPTION_TEXTS.equipment);
    if (!this.config.allowLights) off.push(OPTION_TEXTS.lights);
    if (!this.config.allowHeating) off.push(OPTION_TEXTS.heating);
    return off;
  }

  /** `[connected, message, plain]`; `plain`: the summary without "Connected". */
  status() {
    const p = this.panel;
    if (!this.config.address) {
      const message = this.config.invalidHost ? T.invalidHost(this.config.invalidHost) : T.noHost;
      return [false, this.withNotes(message)];
    }
    if (p.online === false) {
      const wait = age(p.wait ?? this.interval);
      let message;
      if (p.error === 'not_panel') message = T.notPanel;
      else if ([ERROR_KINDS.UNREACHABLE, ERROR_KINDS.TIMEOUT].includes(p.error)) {
        message = T.unreachable(addressKey(this.config.address), wait);
      } else message = T.failing(p.error ?? 'error', wait);
      return [false, this.withNotes(message)];
    }
    if (p.online === undefined || !p.objects) {
      return [false, this.withNotes(T.connecting)];
    }
    const equipment = shownObjects(p.objects).filter((o) =>
      ['FILTER', 'PUMP', 'RELAY', 'LIGHT', 'HEATER'].includes(o.type),
    ).length;
    let summary = T.summary({ name: deviceName(p), equipment, service: p.service });
    for (const heater of shownObjects(p.objects).filter((o) => o.type === 'HEATER')) {
      const body = p.objects.get(`${heater.bow}_${heater.bow}`);
      if (heldSetpointProblem(heater, ceilingOf(body, this.config.poolCeiling))?.above) {
        summary = join(summary, T.heldNote(objectName(heater, heater.key, this.config.language)));
      }
    }
    const off = this.optionsOff();
    if (off.length > 0) {
      summary = join(summary, T.commandsOff(off));
    }
    summary = this.withNotes(summary);
    return [true, T.connected(summary), summary];
  }

  /** The connection status of the configuration screen. */
  async updateStatus(generation = this.generation) {
    const [connected, message, plain] = this.status();
    const orphans = this.orphans();
    if (orphans.length === 0) {
      await this.setStatus(connected, message, generation);
      return;
    }
    const names = orphans
      .map((id) => {
        const device = this.createdDevice(id);
        return typeof device?.name === 'string' && device.name !== ''
          ? `${device.name.slice(0, 60)} (${id.slice(0, 6)})`
          : id.slice(0, 6);
      })
      .join(', ');
    // Not connected: the message never starts with "Connected".
    await this.setStatus(false, join(plain ?? message, T.otherPanel(names)), generation);
  }

  // --- Gladys ----------------------------------------------------------------

  /** Whether the values of the last read may be sent as current (2 minutes at most). */
  fresh(mono = this.mono()) {
    return mono - this.panel.readAt <= TIMINGS.freshFor;
  }

  /** The controller to show and whether it is reachable; undefined while nothing is known. */
  shown() {
    const p = this.panel;
    if (p.id && p.objects && p.online !== false) {
      return { panel: p, online: true };
    }
    if (p.id && p.online === false) {
      return { panel: p, online: false };
    }
    return undefined;
  }

  /** The created device of a controller id, as Gladys has it. */
  createdDevice(id) {
    const external = panelIds(this.gladys, id).device;
    return (this.gladys.devices ?? []).find((d) => d?.external_id === external);
  }

  /**
   * The ids of the devices created in Gladys that the controller read is not
   * (another controller at this address, or an address changed). Empty until a
   * read succeeded since the start (a controller down is not "another controller"),
   * unless there is no address at all.
   */
  orphans() {
    const p = this.panel;
    if (this.config.address && p.readAt === -Infinity) {
      return [];
    }
    const ids = [];
    for (const device of this.gladys.devices ?? []) {
      const id = parseDeviceId(device?.external_id);
      if (id && id !== p.id && panelIds(this.gladys, id).device === device.external_id) {
        ids.push(id);
      }
    }
    return ids;
  }

  async publishAll() {
    const generation = this.generation;
    await this.publishDevices();
    this.queueStates();
    await this.flush();
    await this.publishBadge();
    await this.updateStatus(generation);
  }

  async flush() {
    await this.publisher
      .flush()
      .catch((err) => this.logger.warn(`Sending to Gladys failed: ${err.message}`));
  }

  async publishDevices() {
    const p = this.panel;
    if (!p.id || !p.objects || p.readAt === -Infinity) {
      return;
    }
    const devices = [
      buildDevice(this.gladys, p, {
        language: this.config.language,
        created: this.createdDevice(p.id),
      }),
    ];
    const json = JSON.stringify(devices);
    if (json === this.published) {
      return;
    }
    try {
      await this.gladys.publishDiscoveredDevices(devices);
      this.published = json;
    } catch (err) {
      this.logger.warn(`Publishing the discovered devices failed: ${err.message}`);
    }
  }

  createdFeatures() {
    return new Set(
      (this.gladys.devices ?? []).flatMap((d) => (d.features ?? []).map((f) => f.external_id)),
    );
  }

  /** The states to send: those of a fresh read only (offline: the status). */
  queueStates(created = this.createdFeatures()) {
    const push = (id, panel, online) => {
      const states = deviceStates(panelIds(this.gladys, id), panel, {
        online,
        language: this.config.language,
      });
      for (const { device_feature_external_id: featureId, ...value } of states) {
        if (created.has(featureId)) {
          this.publisher.push(featureId, value);
        }
      }
    };
    const shown = this.shown();
    if (shown && (!shown.online || this.fresh())) {
      push(shown.panel.id, shown.panel, shown.online);
    }
    // A created device the controller read is not: unreachable.
    for (const id of this.orphans()) {
      push(id, {}, false);
    }
  }

  async publishBadge() {
    const created = new Set((this.gladys.devices ?? []).map((d) => d.external_id));
    const entries = [];
    const shown = this.shown();
    const id = shown && panelIds(this.gladys, shown.panel.id).device;
    if (shown && created.has(id)) {
      entries.push({
        external_id: id,
        transport: shown.online ? DEVICE_TRANSPORTS.LOCAL : DEVICE_TRANSPORTS.UNREACHABLE,
      });
    }
    for (const orphan of this.orphans()) {
      entries.push({
        external_id: panelIds(this.gladys, orphan).device,
        transport: DEVICE_TRANSPORTS.UNREACHABLE,
      });
    }
    const json = JSON.stringify(entries);
    if (entries.length === 0 || json === this.badge) {
      return;
    }
    try {
      await this.gladys.publishTransports(entries);
      this.badge = json;
    } catch (err) {
      this.logger.warn(`Transport badge failed: ${err.message}`);
    }
  }

  /** A device was created (or updated): its last values at once, if fresh. */
  async deviceCreated(device) {
    this.badge = undefined;
    this.published = undefined;
    const created = this.createdFeatures();
    for (const f of device?.features ?? []) {
      created.add(f.external_id);
    }
    this.queueStates(created);
    await this.flush();
    await this.publishBadge();
  }

  /** A device was deleted: what is pending for it is dropped. */
  async deviceDeleted(device) {
    this.badge = undefined;
    this.published = undefined;
    if (typeof device?.external_id === 'string') {
      this.publisher.forget(device.external_id);
    }
  }

  /** The Discovery tab asks for a scan: the device of the last read, sent again (no read). */
  async scan() {
    this.published = undefined;
    await this.publishDevices();
  }

  /** Reads the controller now if the interval allows it, else the last status (never sooner). */
  async testConnection() {
    if (this.guards.size > 0) {
      // Stops kept: checked now; those never acked are written again at once,
      // the others at their own pace (15 s after a write, never sooner).
      this.armStopCheck(0);
    }
    if (!this.config.address) {
      return this.status()[1];
    }
    const wait = this.dueIn();
    if (wait > 0 || this.panel.running) {
      await this.panel.running;
      const [, message] = this.status();
      return join(message, T.test.notSooner(age(this.dueIn())));
    }
    await this.tick();
    return this.status()[1];
  }

  // --- Commands --------------------------------------------------------------------

  async setValue(_device, feature, value) {
    // The deadlines count from the arrival of the command, before any wait.
    const received = this.mono();
    const parsed = parseFeatureId(feature?.external_id);
    if (!parsed || !COMMAND_KINDS.includes(parsed.kind)) {
      throw this.refusal(ERRORS.readOnly);
    }
    const { kind, obj, id } = parsed;
    if (kind === KINDS.ONOFF || kind === KINDS.HEATER) {
      const v = selectValue(value);
      const attr = kind === KINDS.HEATER ? STOP_ATTRS.HEATER : STOP_ATTRS.EQUIPMENT;
      if (v === SELECT_VALUES.off) {
        // Never held back: whatever the option, a read, a command or the identity.
        return this.protect(received, {
          obj,
          attr,
          value: kind === KINDS.HEATER ? '0' : OFF,
        });
      }
      if (v !== SELECT_VALUES.on) throw this.refusal(ERRORS.badValue);
      return this.command(
        { kind, obj, id, attr, wanted: kind === KINDS.HEATER ? '1' : ON },
        received,
      );
    }
    const celsius = setpointValue(value);
    if (celsius === undefined) throw this.refusal(ERRORS.badValue);
    return this.command({ kind, obj, id, attr: 'SETPOINT', celsius }, received);
  }

  /**
   * The options a command needs, from what is known of its object (the fresh
   * read when given, else the last read): `[...]` of 'equipment', 'lights',
   * 'heating'. `heats`: a filter pump whose body's heater is not seen off.
   */
  optionsFor(entry, object, heats) {
    if (entry.kind !== KINDS.ONOFF) return ['heating'];
    const options = [];
    if (object?.type === 'LIGHT') options.push('lights');
    else if (object) options.push('equipment');
    else
      options.push(this.config.allowLights && !this.config.allowEquipment ? 'lights' : 'equipment');
    if (heats) options.push('heating');
    return options;
  }

  /** The first option of `options` the configuration does not allow, else undefined. */
  missingOption(options) {
    const allowed = {
      equipment: this.config.allowEquipment,
      lights: this.config.allowLights,
      heating: this.config.allowHeating,
    };
    return options.find((o) => !allowed[o]);
  }

  /** The checks of a command, on arrival, before its batch, and right before its datagram. */
  admit(entry, options) {
    if (entry.seq !== this.protectSeq) {
      return ERRORS.stopMeanwhile;
    }
    if (entry.generation !== this.generation || !this.config.address) {
      return ERRORS.unknownPanel;
    }
    const missing = this.missingOption(options ?? entry.options);
    if (missing) {
      return missing === 'heating' && entry.kind === KINDS.ONOFF
        ? ERRORS.wouldHeat
        : ERRORS.disabled(OPTION_TEXTS[missing]);
    }
    if (this.mono() > entry.sendBy) {
      return ERRORS.tooSlow;
    }
    return undefined;
  }

  /** A command: queued for the next batch, answered by 4.3 s after its click. */
  async command(spec, received) {
    const entry = {
      ...spec,
      received,
      sendBy: received + TIMINGS.commandSendBy,
      answerBy: received + TIMINGS.commandAnswerBy,
      seq: this.protectSeq,
      generation: this.generation,
      sent: false,
      finished: false,
    };
    entry.options = this.optionsFor(entry, this.panel.objects?.get(spec.obj), false);
    const early = this.admit(entry);
    if (early) {
      throw this.refusal(early);
    }
    if (!this.configRead) {
      throw this.refusal(ERRORS.notReadYet);
    }
    if (this.panel.id && spec.id !== this.panel.id) {
      throw this.refusal(ERRORS.unknownPanel);
    }
    const outcome = new Promise((resolve) => {
      entry.finish = (result) => {
        if (entry.finished) return;
        entry.finished = true;
        resolve(result);
      };
    });
    this.commandQueue.push(entry);
    this.kickCommands();
    let timer;
    const late = new Promise((resolve) => {
      timer = this.timers.setTimeout(
        () => resolve({ late: true }),
        Math.max(0, entry.answerBy - this.mono()),
      );
    });
    const result = await Promise.race([outcome, late]);
    this.timers.clearTimeout(timer);
    if (result.late) {
      // Not left by now: it never will (`admit` refuses it after 3.5 s).
      throw this.refusal(entry.sent ? ERRORS.sentUnconfirmed('no answer yet') : ERRORS.tooSlow);
    }
    if (result.error) {
      throw result.error;
    }
    return undefined;
  }

  kickCommands() {
    if (this.commandWorker) {
      return;
    }
    this.commandWorker = (async () => {
      try {
        while (this.commandQueue.length > 0) {
          // Commands arriving together (a scene) go in one batch.
          await this.sleep(TIMINGS.commandGather);
          const batch = this.commandQueue.splice(0, LIMITS.maxBatch);
          try {
            await this.runBatch(batch);
          } catch (err) {
            this.logger.warn(`OmniLogic: commands failed: ${err.message}`);
          }
          for (const entry of batch) {
            entry.finish({ error: this.refusal(ERRORS.unknownState('error')) });
          }
        }
      } finally {
        this.commandWorker = undefined;
      }
    })();
  }

  finishWith(entry, text) {
    entry.finish({ error: this.refusal(text) });
  }

  isPending(obj, attr) {
    return (this.pending.get(settingKey(obj, attr)) ?? -Infinity) > this.mono();
  }

  markPending(obj, attr) {
    this.pending.set(settingKey(obj, attr), this.mono() + TIMINGS.pendingFor);
  }

  /** A stop of this setting not seen applied, at the configured address. */
  guardOf(obj, attr) {
    return this.config.address
      ? this.guards.get(stopKey(this.config.address, obj, attr))
      : undefined;
  }

  /**
   * What to send for one command, from the fresh read: `{ write }`,
   * `{ skip: true }` (already so), or `{ refuse: text }`. `write.request`
   * builds the datagram; `write.value` is what the read back must show.
   */
  plan(entry, objects) {
    const object = objects.get(entry.obj);
    if (objects.get('0_0')?.values.STATE !== '1') {
      // Service or configuration mode, or not readable: only the stops go.
      return { refuse: ERRORS.serviceMode };
    }
    if (entry.kind === KINDS.ONOFF) {
      if (!['FILTER', 'PUMP', 'RELAY', 'LIGHT'].includes(object?.type) || !object.values.STATUS) {
        return { refuse: ERRORS.unknownObject };
      }
      if (object.type === 'RELAY' && object.config.function === 'RLY_FIREPIT') {
        // A gas fire pit: never lit from Gladys in this version (turning it off works).
        return { refuse: ERRORS.firePit };
      }
      let heats = false;
      if (object.type === 'FILTER') {
        // Its body circulates, and the heater of the body may start unless seen off.
        const heater = heaterOfBody(object.bow, objects);
        if (heater && this.guardOf(heater.key, STOP_ATTRS.HEATER)) {
          return { refuse: ERRORS.stopInProgress };
        }
        heats = mayHeat(heater) && Boolean(heater);
        // Its heater may resume the set point it holds: bounded like a write.
        const held = heats ? this.heldProblem(heater, objects) : undefined;
        if (held) return { refuse: held };
      }
      const options = this.optionsFor(entry, object, heats);
      const refused = this.admit(entry, options);
      if (refused) return { refuse: refused };
      if (
        object.values.STATUS === ON &&
        !this.isPending(entry.obj, entry.attr) &&
        !this.guardOf(entry.obj, entry.attr)
      ) {
        return { skip: true };
      }
      const isOn = object.type === 'FILTER' || object.type === 'PUMP' ? onSpeedOf(object) : 1;
      return {
        write: {
          value: ON,
          before: object.values.STATUS,
          options,
          request: () => REQUESTS.equipment(object.bow, object.id, isOn),
        },
      };
    }
    if (object?.type !== 'HEATER') {
      return { refuse: ERRORS.unknownObject };
    }
    const options = ['heating'];
    const refused = this.admit(entry, options);
    if (refused) return { refuse: refused };
    if (entry.kind === KINDS.HEATER) {
      if (!object.values.ENABLE) return { refuse: ERRORS.unknownObject };
      if (
        object.values.ENABLE === entry.wanted &&
        !this.isPending(entry.obj, entry.attr) &&
        !this.guardOf(entry.obj, entry.attr)
      ) {
        return { skip: true };
      }
      // Heating resumes the set point the controller holds: bounded like a write.
      const held = this.heldProblem(object, objects);
      if (held) return { refuse: held };
      return {
        write: {
          value: entry.wanted,
          before: object.values.ENABLE,
          options,
          request: () => REQUESTS.heaterEnable(object.bow, object.id, 1),
        },
      };
    }
    // The set point: a side effect that may restart the heating, refused during its stop.
    if (this.guardOf(entry.obj, STOP_ATTRS.HEATER)) {
      return { refuse: ERRORS.stopInProgress };
    }
    const body = objects.get(`${object.bow}_${object.bow}`);
    const target = setpointToWrite(
      entry.celsius,
      object.config,
      ceilingOf(body, this.config.poolCeiling),
    );
    if (!target) return { refuse: ERRORS.unknownLimits };
    if (target.value === undefined) {
      return { refuse: ERRORS.outOfBounds(target.low, target.high) };
    }
    const value = String(target.value);
    if (object.values.SETPOINT === value && !this.isPending(entry.obj, 'SETPOINT')) {
      return { skip: true };
    }
    return {
      write: {
        value,
        before: object.values.SETPOINT,
        options,
        request: () => REQUESTS.setpoint(object.bow, object.id, target.value),
      },
    };
  }

  /** Why the set point a heater holds may not be resumed (an error text), else undefined. */
  heldProblem(heater, objects) {
    const body = objects.get(`${heater.bow}_${heater.bow}`);
    const problem = heldSetpointProblem(heater, ceilingOf(body, this.config.poolCeiling));
    if (!problem) return undefined;
    return problem.unreadable
      ? ERRORS.heldUnreadable
      : ERRORS.heldAbove(problem.above, problem.ceiling);
  }

  /**
   * One batch of commands on the line: a fresh telemetry (identity checked),
   * the plans, one datagram per command, one read back.
   */
  async runBatch(batch) {
    let live = [];
    for (const entry of batch) {
      const refused = this.admit(entry);
      if (refused) this.finishWith(entry, refused);
      else live.push(entry);
    }
    if (live.length === 0) return;
    const address = this.config.address;
    const latest = Math.max(...live.map((e) => e.sendBy));
    // The line, or nothing sent: a turn that never comes by 3.5 s is given up.
    const giveUp = new AbortController();
    const giveUpTimer = this.timers.setTimeout(
      () => giveUp.abort(),
      Math.max(0, latest - TIMINGS.commandMinRequest - this.mono()),
    );
    let holder;
    try {
      holder = await this.lane.acquire('command', { signal: giveUp.signal });
    } catch {
      for (const entry of live) this.finishWith(entry, ERRORS.tooSlow);
      return;
    } finally {
      this.timers.clearTimeout(giveUpTimer);
    }
    try {
      await this.batchOnLine(live, address, holder, latest);
    } finally {
      holder.release();
    }
  }

  /** A failure before any datagram: every entry gets its reason. */
  failBeforeWrite(entries, err) {
    for (const entry of entries) {
      if (err?.kind === ERROR_KINDS.ABORTED && entry.seq !== this.protectSeq) {
        this.finishWith(entry, ERRORS.stopMeanwhile);
      } else if (err?.kind === ERROR_KINDS.LATE || this.mono() > entry.sendBy) {
        this.finishWith(entry, ERRORS.tooSlow);
      } else {
        this.finishWith(entry, ERRORS.unknownState(errorReason(err)));
      }
    }
  }

  /** The telemetry of the controller on the line held, parsed, within `until`. */
  async telemetryOnLine(target, holder, until) {
    const answer = await this.client.request(target, REQUESTS.telemetry(), {
      timeoutMs: Math.max(TIMINGS.commandMinRequest, until - this.mono()),
      signal: holder.signal,
    });
    const telemetry = parseTelemetry(answer);
    if (!telemetry) throw new PanelError(ERROR_KINDS.PROTOCOL, 'No telemetry');
    return telemetry;
  }

  async batchOnLine(entries, address, holder, latest) {
    let live = entries.filter((entry) => {
      const refused = this.admit(entry);
      if (refused) this.finishWith(entry, refused);
      return !refused;
    });
    if (live.length === 0) return;
    const p = this.panel;
    const readUntil = latest - TIMINGS.commandMinRequest;
    let objects;
    try {
      const telemetry = await this.telemetryOnLine(address, holder, readUntil);
      if (this.mono() >= readUntil) throw new PanelError(ERROR_KINDS.LATE, 'Too slow');
      if (!p.config) {
        for (const entry of live) this.finishWith(entry, ERRORS.panelNotRead);
        return;
      }
      // The identity read again: the configuration known and this telemetry agree.
      if (!sameController(p.config, p.checksum, telemetry)) {
        for (const entry of live) this.finishWith(entry, ERRORS.otherPanel);
        // The configuration is read again, at the follow-up read (5 s).
        p.checksum = undefined;
        this.followUp();
        return;
      }
      objects = mergeObjects(p.config, telemetry);
    } catch (err) {
      this.failBeforeWrite(live, err);
      return;
    }
    // The controller of each command: the one that answers, or nothing.
    live = live.filter((entry) => {
      if (entry.id !== p.config.id) this.finishWith(entry, ERRORS.otherPanel);
      return entry.id === p.config.id;
    });
    // The plans, in the order of arrival: a later command of the same setting replaces an earlier one.
    const planned = [];
    const lastOf = new Map(live.map((e) => [settingKey(e.obj, e.attr), e]));
    for (const entry of live) {
      if (lastOf.get(settingKey(entry.obj, entry.attr)) !== entry) {
        this.finishWith(entry, ERRORS.replaced);
        continue;
      }
      const plan = this.plan(entry, objects);
      if (plan.refuse) {
        this.finishWith(entry, plan.refuse);
        continue;
      }
      if (plan.skip) {
        entry.finish({});
        continue;
      }
      planned.push({ entry, address, ...plan.write });
    }
    if (planned.length === 0) return;
    const answerBy = Math.min(...planned.map((q) => q.entry.answerBy));
    // One datagram per command, one at a time; each checked right before it leaves.
    const sent = [];
    for (const q of planned) {
      try {
        await this.client.request(address, q.request, {
          timeoutMs: Math.max(
            TIMINGS.commandMinRequest,
            Math.min(q.entry.sendBy, answerBy - TIMINGS.applyWait) - this.mono(),
          ),
          signal: holder.signal,
          beforeSend: () => {
            // The options, the stops and the deadline checked again right before the datagram.
            const refused = this.admit(q.entry, q.options);
            if (refused) {
              this.finishWith(q.entry, refused);
              throw new Error('refused');
            }
            const at = this.mono();
            this.lastSentAt = at;
            q.entry.sent = true;
            if (q.entry.kind !== KINDS.SETPOINT) this.lastOnSentAt.set(q.entry.obj, at);
          },
        });
        sent.push(q);
      } catch (err) {
        this.commandFailed(err, q);
        if (err.kind === ERROR_KINDS.ABORTED) {
          // A stop took the line: the commands not sent yet give way.
          for (const rest of planned.slice(planned.indexOf(q) + 1)) {
            this.finishWith(rest.entry, ERRORS.stopMeanwhile);
          }
          return;
        }
      }
    }
    if (sent.length === 0) return;
    this.newerThanStops(sent);
    for (const q of sent) this.markPending(q.entry.obj, q.entry.attr);
    // The read back alone confirms them.
    await this.sleep(
      Math.min(TIMINGS.applyWait, answerBy - TIMINGS.commandMinRequest - this.mono()),
      holder.signal,
    );
    let back;
    try {
      back = mergeObjects(p.config, await this.telemetryOnLine(address, holder, answerBy));
    } catch {
      back = undefined;
    }
    this.followUp();
    for (const q of sent) {
      const values = back?.get(q.entry.obj)?.values;
      const value = values?.[q.entry.attr];
      if (!back) {
        this.finishWith(q.entry, ERRORS.sentUnconfirmed('no read back'));
      } else if (value === q.value) {
        this.pending.delete(settingKey(q.entry.obj, q.entry.attr));
        this.logger.info(`OmniLogic: ${q.entry.kind} ${q.entry.obj} confirmed by the controller`);
        q.entry.finish({});
      } else {
        this.finishWith(q.entry, value === q.before ? ERRORS.notApplied : ERRORS.sentDiffers);
      }
    }
  }

  /**
   * Commands that left (acked, or no ack: they may be applied) for a setting
   * with a stop kept: the newer intent wins, the stop is let go, never one
   * clicked while they were on their way. Newer than any stop of /data too
   * (clicked before this run): noted for a /data read late.
   */
  newerThanStops(sent) {
    for (const q of sent) {
      if (q.entry.kind !== KINDS.SETPOINT) {
        this.commandsLeft.add(stopKey(q.address, q.entry.obj, q.entry.attr));
      }
      if (q.entry.kind === KINDS.SETPOINT || q.entry.seq !== this.protectSeq) continue;
      const guard = this.guardOf(q.entry.obj, q.entry.attr);
      if (guard) this.dropGuard(guard, 'newer command');
    }
  }

  /** A datagram that failed: never "nothing sent" once it may have left. */
  commandFailed(err, q) {
    const reason = errorReason(err);
    if (err.kind === ERROR_KINDS.YIELDED) {
      // Refused in beforeSend: it got its own words.
      return;
    }
    this.logger.warn(`OmniLogic: command failed (${reason})`);
    if (!q.entry.sent) {
      this.failBeforeWrite([q.entry], err);
      return;
    }
    // No ack, a cut: it may have reached the controller.
    this.followUp();
    this.newerThanStops([q]);
    this.markPending(q.entry.obj, q.entry.attr);
    this.finishWith(q.entry, ERRORS.sentUnconfirmed(reason));
  }

  /**
   * Spaced reads after a command: its effect, then a check (each a new read).
   * The reads of an earlier command not done yet are replaced.
   */
  followUp() {
    const generation = this.generation;
    const p = this.panel;
    for (const handle of p.followUps) {
      this.timers.clearTimeout(handle);
    }
    p.followUps.clear();
    for (const delay of TIMINGS.followUps) {
      const handle = this.timers.setTimeout(() => {
        p.followUps.delete(handle);
        if (generation === this.generation && this.config.address) {
          Promise.resolve(p.running)
            .then(() => this.tick())
            .catch(() => this.logger.error('OmniLogic refresh failed'));
        }
      }, delay);
      p.followUps.add(handle);
    }
  }

  // --- The stops (protective) ---------------------------------------------------

  /** Where a stop goes: the configured address, else the last one read (in /data). */
  stopTarget() {
    if (this.config.address) {
      return { host: this.config.address.host, port: this.config.address.port };
    }
    const kept = this.memory.target;
    return kept ? { host: kept.host, port: kept.port } : undefined;
  }

  /** The addresses that have stops kept, one each. */
  stopAddresses() {
    const seen = new Map();
    for (const g of this.guards.values()) {
      const key = addressKey(g.target);
      if (!seen.has(key)) seen.set(key, g.target);
    }
    return [...seen.values()];
  }

  /** The stops clicked while no address was known: sent first, now that one is. */
  flushAddressless() {
    if (this.addressless.length === 0) return;
    const target = this.stopTarget();
    if (!target) return;
    const specs = this.addressless.splice(0);
    this.logger.warn(`OmniLogic: ${specs.length} stop(s) clicked without an address sent now`);
    this.queueStop({ target, specs, received: this.mono() });
  }

  /** The same controller answers at a new address: its kept stops go there. */
  retargetStops(from, to) {
    let moved = 0;
    for (const guard of [...this.guards.values()]) {
      if (!sameAddress(guard.target, from)) continue;
      this.guards.delete(guard.key);
      guard.target = { host: to.host, port: to.port };
      guard.key = stopKey(guard.target, guard.obj, guard.attr);
      if (!this.guards.has(guard.key)) {
        this.guards.set(guard.key, guard);
        moved += 1;
      }
    }
    if (moved > 0) {
      this.logger.warn(`OmniLogic: ${moved} stop(s) kept follow the controller to its new address`);
      this.armStopCheck(0, to);
      this.persistStops().catch(() => {});
    }
  }

  /**
   * A stop clicked: queued before anything (it ends a read or a command on the
   * line), answered by 4.3 s after the click.
   */
  async protect(received, spec) {
    // Every command that arrived before this stop and has not left gives way.
    this.protectSeq += 1;
    for (const entry of this.commandQueue.splice(0)) {
      this.finishWith(entry, ERRORS.stopMeanwhile);
    }
    // /data holds the address of the last read: known even before the
    // configuration (a hung disk never holds the stop back: 200 ms at most).
    await this.bounded(this.loadMemory(), TIMINGS.stopSaveWait);
    const target = this.stopTarget();
    if (!target) {
      // Kept in memory: sent first as soon as an address is known.
      if (!this.addressless.some((s) => s.obj === spec.obj && s.attr === spec.attr)) {
        this.addressless.push(spec);
      }
      throw this.refusal(ERRORS.noAddress);
    }
    const job = this.queueStop({ target, specs: [spec], received });
    // By setting, not by address: the stop may follow the controller to a new address meanwhile.
    const key = settingKey(spec.obj, spec.attr);
    const answerIn = Math.max(0, received + TIMINGS.commandAnswerBy - this.mono());
    let timer;
    const done = await Promise.race([
      job.done.then(() => true),
      new Promise((resolve) => {
        timer = this.timers.setTimeout(() => resolve(false), answerIn);
      }),
    ]);
    this.timers.clearTimeout(timer);
    if (!done) {
      const guard = [...this.guards.values()].find(
        (g) => g.obj === spec.obj && g.attr === spec.attr,
      );
      throw this.refusal(
        guard?.written ? ERRORS.stopUnconfirmed : ERRORS.stopNotSent('no turn yet'),
      );
    }
    const result = job.results.get(key);
    if (result?.error) {
      throw result.error;
    }
    return undefined;
  }

  /** Queues a stop, in the order of the clicks; a job for the same address still waiting is joined. */
  queueStop({ target, specs, received, fromBoot = false }) {
    let job = this.stops.find((j) => !j.running && sameAddress(j.target, target));
    if (job) {
      for (const spec of specs) {
        if (!job.specs.some((s) => s.obj === spec.obj && s.attr === spec.attr)) {
          job.specs.push(spec);
        }
      }
      // A click joining a job from /data: counted as a new click.
      job.fromBoot = job.fromBoot && fromBoot;
      return job;
    }
    job = { target, specs: [...specs], received, fromBoot, running: false, results: new Map() };
    job.done = new Promise((resolve) => {
      job.resolve = resolve;
    });
    this.stops.push(job);
    // Whatever holds the line ends when the stop asks for it (src/lane.js aborts it).
    this.runStops();
    return job;
  }

  runStops() {
    if (this.stopWorker) {
      return;
    }
    this.stopWorker = (async () => {
      try {
        while (this.stops.length > 0) {
          const job = this.stops[0];
          job.running = true;
          try {
            await this.sendStop(job);
          } catch (err) {
            this.logger.warn(`OmniLogic: stop failed: ${err.message}`);
            this.armStopCheck(SECOND, job.target);
          }
          this.stops.shift();
          job.resolve();
        }
      } finally {
        this.stopWorker = undefined;
      }
    })();
  }

  newGuard(target, spec) {
    return {
      key: stopKey(target, spec.obj, spec.attr),
      target: { host: target.host, port: target.port },
      obj: spec.obj,
      attr: spec.attr,
      value: spec.value,
      since: this.now(),
      written: false,
      /** The controller acked one of its datagrams (only then a resend counts). */
      acked: false,
      sentAt: undefined,
      resends: 0,
      /** Never written again before this (monotonic): 15 s after a write. */
      nextTryAt: -Infinity,
      /** Seen applied by the last read (a late command may still undo it). */
      applied: false,
      /** Shown off but still running down (cool-down, a heater on), since (monotonic). */
      heatingSince: undefined,
      /** ... and the state of the heaters could not be read. */
      heatUnknown: false,
      /** What the last read said of it (src: decideStop). */
      decision: undefined,
      /** Until then, a command that left before the stop may still land: watched. */
      watchUntil: -Infinity,
    };
  }

  /** Whether this guard is still the one kept for its key. */
  current(guard) {
    return this.guards.get(guard.key) === guard;
  }

  /**
   * What a read says of a stop (`values`: the object read, or undefined):
   * 'done' (the controller shows it), 'watch' (shown, but a command sent
   * shortly before the stop may still land: read again), 'heating' (shown
   * off but still running down: a filter in cool-down, a heater still on;
   * watched, nothing written), 'wait' (read too soon after the stop left),
   * 'later' (not shown, but written less than 15 s ago), 'resend' (not shown,
   * or not readable: written again, in doubt), 'hold' (written 4 times
   * without effect: held, said in the status, no more writes until a new
   * click).
   */
  decideStop(guard, values, readStartedAt) {
    guard.decision = this.decide(guard, values, readStartedAt);
    return guard.decision;
  }

  decide(guard, values, readStartedAt) {
    const mono = this.mono();
    const shown =
      guard.attr === STOP_ATTRS.HEATER
        ? values?.ENABLE === '0'
        : values?.STATUS === OFF || values?.STATUS === 'STOPPING';
    if (shown) {
      // Applied only once nothing runs any more: no heater of the body on,
      // the equipment off (not running down).
      const runningDown =
        guard.attr === STOP_ATTRS.HEATER ? values.HEATING !== '0' : values.STATUS === 'STOPPING';
      if (runningDown) {
        guard.applied = false;
        guard.heatingSince ??= mono;
        guard.heatUnknown = guard.attr === STOP_ATTRS.HEATER && values.HEATING === undefined;
        return 'heating';
      }
      guard.applied = true;
      guard.heatingSince = undefined;
      return mono < guard.watchUntil ? 'watch' : 'done';
    }
    guard.applied = false;
    guard.heatingSince = undefined;
    if (!guard.acked) {
      // Never acked (never left, or no ack): written again at every check, never held.
      return 'resend';
    }
    if (guard.sentAt !== undefined && readStartedAt < guard.sentAt + TIMINGS.stopApplyDelay) {
      return 'wait';
    }
    if (guard.resends >= TIMINGS.stopResends) {
      return 'hold';
    }
    return mono < guard.nextTryAt ? 'later' : 'resend';
  }

  /** A stop written (its datagram left): never written again before 15 s. */
  noteWritten(guard, at) {
    guard.written = true;
    guard.sentAt = at;
    guard.nextTryAt = at + TIMINGS.stopCheck;
  }

  /** The values a stop is judged on, from a telemetry. */
  stopValues(guard, telemetry) {
    return telemetry ? stopValuesOf(guard.obj, telemetry, this.panel.config) : undefined;
  }

  /** A read (poll) seen by the stops of its address: applied, or checked now when one is due. */
  observeStops(telemetry, startedAt, address) {
    let check = false;
    for (const guard of [...this.guards.values()]) {
      if (!sameAddress(guard.target, address)) continue;
      const decision = this.decideStop(guard, this.stopValues(guard, telemetry), startedAt);
      if (decision === 'done') this.dropGuard(guard, 'applied');
      else if (decision === 'resend') check = true;
    }
    if (check && !this.checking.has(addressKey(address))) this.armStopCheck(0, address);
  }

  /**
   * Writes these stops, one datagram each, on the line held: each checked
   * right before it leaves (`ok(g)`: still to write). Resolves the guards
   * acked by the controller; rejects only an ABORTED error (the line taken),
   * after the guards that left were noted. `failure` holds the last error.
   */
  async writeStops(target, guards, holder, { timeoutMs, ok, result }) {
    const acked = [];
    for (const g of guards) {
      try {
        await this.client.request(target, () => stopRequest(g), {
          timeoutMs,
          signal: holder.signal,
          beforeSend: () => {
            if (!ok(g)) throw new Error('nothing to write');
            const at = this.mono();
            this.lastSentAt = at;
            this.noteWritten(g, at);
            result.sent.push(g);
          },
        });
        g.acked = true;
        acked.push(g);
      } catch (err) {
        if (err.kind === ERROR_KINDS.YIELDED) continue;
        result.failure = err;
        if (err.kind === ERROR_KINDS.ABORTED) throw err;
      }
    }
    return acked;
  }

  /**
   * One stop job (one or more settings, one address): one datagram each,
   * without a read first, then the telemetry that alone confirms them. No
   * ack, a send error: tried again every 250 ms until 3 s after the click
   * (the write is idempotent). Not confirmed: kept (in /data) and checked
   * every 15 s.
   */
  async sendStop(job) {
    const { target } = job;
    const retryUntil = Math.max(job.received, this.mono()) + TIMINGS.stopRetryFor;
    const guards = job.specs.map((spec) => {
      const key = stopKey(target, spec.obj, spec.attr);
      let guard = this.guards.get(key);
      if (!guard) {
        guard = this.newGuard(target, spec);
        this.guards.set(key, guard);
      }
      if (!job.fromBoot) {
        // A new click: its writes are counted anew, written now.
        guard.since = this.now();
        guard.resends = 0;
        guard.nextTryAt = -Infinity;
      }
      // A command that left shortly before this click may land after it: watched.
      guard.watchUntil = Math.max(
        guard.watchUntil,
        (this.lastOnSentAt.get(spec.obj) ?? -Infinity) + TIMINGS.stopWatchFor,
      );
      return guard;
    });
    // In /data before the first datagram, so a restart sends it again; a save
    // that fails or hangs never holds the stop back (200 ms at most).
    await this.bounded(this.persistStops(), TIMINGS.stopSaveWait);
    // A restart sending a stop already written before: a resend once the controller acks it.
    const resendOnBoot = new Set(guards.filter((g) => job.fromBoot && g.acked));
    let back;
    const result = { sent: [], failure: undefined };
    const ackedAll = new Set();
    this.logger.info(`OmniLogic: stop of ${guards.length} setting(s)`);
    for (;;) {
      const live = guards.filter((g) => this.current(g) && !ackedAll.has(g));
      if (live.length === 0) break;
      const holder = await this.lane.acquire('stop');
      let again;
      try {
        const timeoutMs = Math.max(
          TIMINGS.stopRetry,
          Math.min(TIMINGS.stopTryTimeout, retryUntil - this.mono()),
        );
        result.failure = undefined;
        const acked = await this.writeStops(target, live, holder, {
          timeoutMs,
          // Let go while it waited for the line (a command of the setting
          // that left, the controller showing it): nothing to write for it.
          ok: (g) => this.current(g),
          result,
        });
        for (const g of acked) {
          ackedAll.add(g);
          if (resendOnBoot.has(g)) g.resends += 1;
        }
        again = live.some((g) => this.current(g) && !ackedAll.has(g));
        if (!again) {
          // Read back once the controller had time to apply it (within the ack budget).
          await this.sleep(
            Math.min(TIMINGS.applyWait, job.received + TIMINGS.commandAnswerBy - 600 - this.mono()),
          );
          try {
            back = await this.telemetryOnLine(
              target,
              holder,
              job.received + TIMINGS.commandAnswerBy,
            );
          } catch (err) {
            this.logger.debug(`OmniLogic: read back of the stop failed (${errorReason(err)})`);
          }
        }
      } catch (err) {
        // The line taken (another stop): tried again.
        result.failure = err;
        again = true;
      } finally {
        holder.release();
      }
      if (!again || this.mono() + TIMINGS.stopRetry >= retryUntil) break;
      await this.sleep(TIMINGS.stopRetry);
    }
    let keep = false;
    const { failure } = result;
    for (const guard of guards) {
      const key = settingKey(guard.obj, guard.attr);
      if (!this.current(guard)) {
        // Let go meanwhile (a newer command left): nothing more to say.
        job.results.set(key, {});
        continue;
      }
      const decision = back
        ? this.decideStop(guard, this.stopValues(guard, back), Infinity)
        : undefined;
      if (decision === 'done') {
        this.dropGuard(guard, 'applied', { quiet: true });
        job.results.set(key, {});
        continue;
      }
      keep = true;
      if (decision === 'watch') {
        job.results.set(key, {});
      } else if (decision === 'heating') {
        job.results.set(key, { error: this.refusal(ERRORS.stopStillRunning) });
      } else if (!result.sent.includes(guard)) {
        job.results.set(key, {
          error: this.refusal(ERRORS.stopNotSent(failure ? errorReason(failure) : 'no turn')),
        });
      } else if (!ackedAll.has(guard)) {
        job.results.set(key, {
          error: this.refusal(ERRORS.sentUnconfirmed(failure ? errorReason(failure) : 'no ack')),
        });
      } else {
        job.results.set(key, {
          error: this.refusal(back ? ERRORS.stopNotApplied : ERRORS.stopUnconfirmed),
        });
      }
    }
    // Armed before /data is written, never awaited: a hung disk never stops
    // the checks nor holds the next click behind this one.
    if (keep) this.armStopCheck(this.nextCheckDelay(target), target);
    this.persistStops().catch(() => {});
    if (result.sent.length > 0) this.followUp();
    if (!failure && back) this.logger.info('OmniLogic: stop sent and read back');
    this.updateStatus().catch(() => {});
  }

  /** Whether a click or a command waits or runs: a check gives way to them. */
  checkMustYield() {
    return (
      this.stops.length > 0 ||
      Boolean(this.stopWorker) ||
      Boolean(this.commandWorker) ||
      this.commandQueue.length > 0
    );
  }

  /** The delay of the next check of an address, from what its stops wait for (15 s at most). */
  nextCheckDelay(target) {
    let delay = TIMINGS.stopCheck;
    const mono = this.mono();
    for (const g of this.guards.values()) {
      if (!sameAddress(g.target, target)) continue;
      // Only what the last read said: 'watch' (read again at the end of the
      // watch), 'wait' (read too soon after the write), 'later' (written again
      // at its time); else every 15 s.
      if (g.decision === 'watch' && mono < g.watchUntil) {
        delay = Math.min(delay, Math.max(0, g.watchUntil - mono + 1));
      } else if (g.decision === 'wait' && g.sentAt !== undefined) {
        delay = Math.min(delay, Math.max(0, g.sentAt + TIMINGS.stopApplyDelay - mono));
      } else if (g.decision === 'later') {
        delay = Math.min(delay, Math.max(SECOND, g.nextTryAt - mono));
      }
    }
    return delay;
  }

  /**
   * The periodic check of the stops of one address: reads the telemetry,
   * then writes again only those `decideStop` says, one datagram each. Each
   * address has its own check and its own pace. It gives its turn up to a
   * click or a command (tried again a second later), and checks once more
   * right before each datagram. It arms no follow-up read.
   */
  async runCheck(target) {
    const at = addressKey(target);
    const guards = [...this.guards.values()].filter((g) => sameAddress(g.target, target));
    if (guards.length === 0) return;
    if (this.checkMustYield() || this.checking.has(at)) {
      this.armStopCheck(SECOND, target);
      return;
    }
    this.checking.add(at);
    const decisions = new Map();
    let yielded = false;
    let holder;
    try {
      // Every exit of the check ends below: let go on 'done', the next check armed, /data.
      await (async () => {
        holder = await this.lane.acquire('check');
        if (this.checkMustYield()) {
          yielded = true;
          return;
        }
        const startedAt = this.mono();
        let read;
        // A command arriving takes the line from a check (src/lane.js): a
        // check of a dead address never makes a command miss its turn.
        const wait = TIMINGS.readTimeout;
        try {
          read = await this.telemetryOnLine(target, holder, this.mono() + wait);
        } catch (err) {
          if (err.kind === ERROR_KINDS.ABORTED) throw err;
          // Nothing readable: written again when due, in doubt (the write is the stop).
          read = undefined;
        }
        for (const g of guards) {
          if (!this.current(g)) continue;
          decisions.set(g, this.decideStop(g, this.stopValues(g, read), startedAt));
        }
        const resend = guards.filter((g) => decisions.get(g) === 'resend');
        if (resend.length === 0) return;
        const wasAcked = new Set(resend.filter((g) => g.acked));
        const result = { sent: [], failure: undefined };
        this.logger.warn(
          `OmniLogic: ${resend.length} stop(s) not shown by the controller: written again`,
        );
        const acked = await this.writeStops(target, resend, holder, {
          timeoutMs: TIMINGS.stopTryTimeout,
          ok: (g) => {
            if (this.checkMustYield()) {
              yielded = true;
              return false;
            }
            return this.current(g);
          },
          result,
        });
        // Acked by the controller: a resend (a silence is not one).
        for (const g of acked) {
          if (wasAcked.has(g)) g.resends += 1;
        }
        if (result.sent.length === 0) return;
        await this.sleep(TIMINGS.applyWait, holder.signal);
        try {
          const back = await this.telemetryOnLine(target, holder, this.mono() + wait);
          for (const g of result.sent) {
            if (!this.current(g)) continue;
            decisions.set(g, this.decideStop(g, this.stopValues(g, back), Infinity));
          }
        } catch (err) {
          if (err.kind === ERROR_KINDS.ABORTED) throw err;
        }
      })();
    } catch (err) {
      if (err?.kind === ERROR_KINDS.ABORTED) {
        // Its turn taken by a stop or a command: again a second later.
        yielded = true;
      } else {
        this.logger.warn(`OmniLogic: check of the stops failed (${errorReason(err)})`);
      }
    } finally {
      holder?.release();
      this.checking.delete(at);
    }
    for (const [g, decision] of decisions) {
      if (decision === 'done' && this.current(g)) this.dropGuard(g, 'applied', { quiet: true });
    }
    // Armed before /data is written (a hung disk never stops the checks).
    this.armStopCheck(yielded ? SECOND : this.nextCheckDelay(target), target);
    this.persistStops().catch(() => {});
    this.updateStatus().catch(() => {});
  }

  dropGuard(guard, reason, { quiet = false } = {}) {
    if (!this.current(guard)) return;
    this.guards.delete(guard.key);
    this.logger.info(`OmniLogic: stop of ${guard.obj} let go (${reason})`);
    const at = addressKey(guard.target);
    const check = this.checks.get(at);
    if (check && !this.stopAddresses().some((t) => addressKey(t) === at)) {
      this.timers.clearTimeout(check.timer);
      this.checks.delete(at);
    }
    if (!quiet) {
      this.persistStops().catch(() => {});
      this.updateStatus().catch(() => {});
    }
  }

  /**
   * The next check of the stops of `target` (every address with stops when
   * omitted): every 15 s, whatever the interval or the failures; a check
   * already due sooner is never pushed back.
   */
  armStopCheck(delay = TIMINGS.stopCheck, target = undefined) {
    if (!target) {
      for (const t of this.stopAddresses()) this.armStopCheck(delay, t);
      return;
    }
    if (!this.guards.size || !this.stopAddresses().some((t) => sameAddress(t, target))) return;
    const at = addressKey(target);
    const dueAt = this.mono() + delay;
    const current = this.checks.get(at);
    if (current) {
      if (current.dueAt <= dueAt) return;
      this.timers.clearTimeout(current.timer);
    }
    const check = { dueAt, timer: undefined };
    check.timer = this.timers.setTimeout(() => {
      if (this.checks.get(at) === check) this.checks.delete(at);
      this.runCheck(target).catch((err) => this.logger.warn(`OmniLogic: check: ${err.message}`));
    }, delay);
    this.checks.set(at, check);
  }
}
