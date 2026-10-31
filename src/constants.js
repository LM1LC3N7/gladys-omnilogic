// -----------------------------------------------------------------------------
// Hayward OmniLogic constants, manifest keys, limits and timings.
//
// An OmniLogic controller answers a local protocol on UDP port 10444, without
// credentials (as python-omnilogic-local 5.0.2 does, Apache-2.0): every
// datagram has a 24-byte header (message id, time, protocol version "1.19",
// message type, client type, a compressed flag) and an XML body ended by a
// NUL byte. Every request is acknowledged (MSP_ACK, same message id); the
// answers of the controller (the telemetry, the configuration) are
// acknowledged by the client (ACK, their message id). A long answer comes as
// a lead message (its size and block count) then blocks (an 8-byte block
// header, then the data). The telemetry is always zlib-compressed.
//
// Only these requests are ever sent:
//   - RequestConfiguration (1): the configuration (MSPConfig: bodies of
//     water, equipment, names, limits);
//   - RequestTelemetryData (300): the states;
//   - SetUIEquipmentCmd (164): a filter, pump, relay or light on or off;
//   - RunGroupCmd (317): a group (theme) on or off;
//   - SetHeaterEnable (147): a heater on or off;
//   - SetUIHeaterCmd (11): the heating set point, in °F.
// Every temperature of the protocol is in °F, whatever the display unit of
// the controller (the reference says so; its captures of a controller in
// "Metric" show °F values too).
// -----------------------------------------------------------------------------

export const DEFAULT_PORT = 10444;

export const SECOND = 1000;
export const MINUTE = 60 * SECOND;
export const HOUR = 60 * MINUTE;

/** The message types (python-omnilogic-local `MessageType`). */
export const MSG = {
  ACK: 0,
  REQUEST_CONFIGURATION: 1,
  SET_HEATER: 11,
  SET_HEATER_ENABLE: 147,
  SET_EQUIPMENT: 164,
  GET_TELEMETRY: 300,
  RUN_GROUP: 317,
  MSP_ACK: 1002,
  MSP_CONFIGURATIONUPDATE: 1003,
  MSP_TELEMETRY_UPDATE: 1004,
  MSP_LEADMESSAGE: 1998,
  MSP_BLOCKMESSAGE: 1999,
};

/** The answer awaited for each request that has one (the others: the ack only). */
export const ANSWER_OF = {
  [MSG.REQUEST_CONFIGURATION]: MSG.MSP_CONFIGURATIONUPDATE,
  [MSG.GET_TELEMETRY]: MSG.MSP_TELEMETRY_UPDATE,
};

export const PROTOCOL = {
  version: '1.19',
  headerSize: 24,
  blockHeaderSize: 8,
  namespace: 'http://nextgen.hayward.com/api',
  /** Client type: 0 (XML) for a message with a body, as the reference. */
  clientXml: 0,
};

/**
 * Feature kinds (the first part of a feature role, before the object key):
 * frozen, scenes keep them.
 */
export const KINDS = {
  ONOFF: 'onoff',
  AIR_TEMP: 'air-temp',
  WATER_TEMP: 'water-temp',
  HEATER: 'heater',
  SETPOINT: 'setpoint',
  HEATING: 'heating',
  SPEED: 'speed',
  POWER: 'power',
  SALT: 'salt',
  PH: 'ph',
  ORP: 'orp',
};

/** The one feature of the controller itself. */
export const STATUS_ROLE = 'status';

/** The values of the on/off selects (frozen). */
export const SELECT_VALUES = { on: 'on', off: 'off' };

/**
 * What a stop writes (the `attr` kept in /data, frozen): an equipment off
 * (SetUIEquipmentCmd isOn 0), a group off (RunGroupCmd 0), a heater off
 * (SetHeaterEnable 0). Each is confirmed by the telemetry: STATUS "OFF", or
 * ENABLE "0" with no heater of the body seen heating.
 */
export const STOP_ATTRS = {
  EQUIPMENT: 'STATUS',
  GROUP: 'GROUP',
  HEATER: 'ENABLE',
};
export const OFF = 'OFF';
export const ON = 'ON';

/**
 * Heating set points, on the whole °F written: the range of the protocol
 * (65 to 104 °F, python-omnilogic-local), within the limits of the heater
 * read in the configuration (Min/Max-Settable-Water-Temp), a spa never above
 * 40 °C, a pool never above the ceiling of the configuration (35 °C by
 * default, 40 °C at most).
 */
export const SETPOINT = {
  minF: 65,
  maxF: 104,
  spaMaxC: 40,
  poolCeilingDefault: 35,
  poolCeilingMin: 20,
  poolCeilingMax: 40,
};

export const ACTIONS = {
  TEST_CONNECTION: 'test_connection',
};

/** The poll interval of the configuration, in seconds. */
export const POLL_INTERVAL = {
  min: 15,
  default: 30,
  max: 600,
};

export const LIMITS = {
  /** One datagram never bigger than a UDP payload can be. */
  maxDatagram: 65_507,
  /** A whole answer (lead size), before and after decompression. */
  maxAnswerBytes: 1024 * 1024,
  maxInflated: 4 * 1024 * 1024,
  /** Blocks of one lead message. */
  maxBlocks: 256,
  /** Datagrams that are not the answer awaited, per request, before giving up. */
  maxOtherMessages: 64,
  /** XML: elements of one answer, depth. */
  maxXmlNodes: 50_000,
  maxXmlDepth: 32,
  /** The objects of one kind shown (filters, relays...). */
  maxPerKind: 32,
  /** A name of the controller shown: cut to this many characters. */
  maxName: 40,
  /** Gladys accepts 300 states per minute; 100 per request. */
  statesPerMinute: 300,
  statesPerRequest: 100,
  /** Commands of one batch. */
  maxBatch: 16,
};

/** A system id of the controller: a whole number, 0 to 65535. */
export const SYSTEM_ID = /^(?:0|[1-9]\d{0,4})$/;

/** An object key: `<body>_<system id>` (the body 0 is the backyard). */
export const OBJ_KEY = /^(?:0|[1-9]\d{0,4})_(?:0|[1-9]\d{0,4})$/;

export const TIMINGS = {
  /** An ack awaited this long before the request is sent again (a new message id). */
  ackWait: 800,
  /** One request of the polling, the answer included (the configuration may be long). */
  readTimeout: 8 * SECOND,
  /** Between two blocks of a long answer, at most this long. */
  blockWait: 3 * SECOND,
  /** Failed reads: 30 s, 1, 2, then 5 minutes, never shorter than the interval. */
  backoff: [30 * SECOND, MINUTE, 2 * MINUTE, 5 * MINUTE],
  /** The configuration is read again at least this often when the telemetry has no checksum. */
  configMaxAge: 10 * MINUTE,
  /** The time of the last read is written to /data at most this often, before the read. */
  attemptWriteEvery: MINUTE,
  /** `getConfig()` failed: tried again this often, forever. */
  configRetry: 30 * SECOND,
  /** The publisher sends what is pending every second; unchanged states again every 30 min. */
  flushInterval: SECOND,
  stateHeartbeat: 30 * MINUTE,
  /** Values older than this are never sent as new (reconnection, device created). */
  freshFor: 2 * MINUTE,
  /**
   * Commands (Gladys waits 5 s for the ack): each must leave by 3.5 s after
   * the click, or it is refused unsent; the answer comes by 4.3 s, after
   * which the command is "sent, without confirmation".
   */
  commandSendBy: 3_500,
  commandAnswerBy: 4_300,
  /** The least time a request of a command gets. */
  commandMinRequest: 250,
  /** Commands arriving together (a scene) wait this long to go in one batch. */
  commandGather: 30,
  /** After a write, the read back waits this long. */
  applyWait: 400,
  /** Reads after a command, spaced: its effect, then a check. */
  followUps: [5 * SECOND, 20 * SECOND],
  /** A command not confirmed: a new one is always sent for this long (never "already so"). */
  pendingFor: 90 * SECOND,
  /** The stop: tried again every 250 ms until 3 s after the click. */
  stopRetry: 250,
  stopRetryFor: 3_000,
  /** One try of the stop never waits longer than this for its ack. */
  stopTryTimeout: 2 * SECOND,
  /** The stop waits at most this long for /data before its first byte (a failing disk never holds it). */
  stopSaveWait: 200,
  /** /data: a load that takes longer is unreadable for now; a save is not awaited longer (reads, start). */
  loadWait: 2 * SECOND,
  saveWait: 2 * SECOND,
  /** A stop shown but still running down (cool-down, a heater still on): said as such this long. */
  coolDown: 10 * MINUTE,
  /** A stop not seen applied: checked every 15 s; never written again sooner than 15 s. */
  stopCheck: 15 * SECOND,
  /** A read begun less than this after a stop left does not judge it "not applied". */
  stopApplyDelay: 2 * SECOND,
  /** Writes of a stop the controller acked without effect before it is held (no more writes). */
  stopResends: 3,
  /** A command that left less than this before a stop may land after it: the stop watches. */
  stopWatchFor: 30 * SECOND,
};
