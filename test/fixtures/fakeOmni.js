// -----------------------------------------------------------------------------
// A fake Hayward OmniLogic controller, built from python-omnilogic-local
// 5.0.2 (its protocol, its models and the captures of its test fixtures):
// UDP datagrams with the 24-byte header, every request acked (MSP_ACK, same
// id), the telemetry zlib-compressed (flag left at 0, as the reference says
// the controller does), the configuration as a lead message and blocks of
// 1 KiB (compressed, flag set), the commands applied to its state. Two ways in:
//   - `createSocket()`: a dgram double on the virtual clock of the tests (no
//     network); latencies, silences, lost acks, applied late, ignored;
//   - `listen()`: a real UDP socket on 127.0.0.1 (the real-clock tests).
// -----------------------------------------------------------------------------

import { createSocket as dgramSocket } from 'node:dgram';
import { EventEmitter } from 'node:events';
import { deflateSync } from 'node:zlib';

export const HOST = '192.168.1.60';
export const PORT = 10444;
export const NOW = Date.UTC(2026, 6, 15, 10, 0, 0);

const TYPES = {
  ACK: 0,
  CONFIG: 1,
  SET_HEATER: 11,
  HEATER_ENABLE: 147,
  SET_EQUIPMENT: 164,
  TELEMETRY: 300,
  MSP_ACK: 1002,
  CONFIG_UPDATE: 1003,
  TELEMETRY_UPDATE: 1004,
  LEAD: 1998,
  BLOCK: 1999,
};
export { TYPES };

export function header(id, type, { compressed = 0, client = 0 } = {}) {
  const h = Buffer.alloc(24);
  h.writeUInt32BE(id >>> 0, 0);
  h.writeBigUInt64BE(0n, 4);
  h.write('1.19', 12, 4, 'ascii');
  h.writeUInt32BE(type, 16);
  h.writeUInt8(client, 20);
  h.writeUInt8(compressed, 22);
  return h;
}

export const datagram = (id, type, payload = Buffer.alloc(0), options) =>
  Buffer.concat([header(id, type, options), payload]);

/** The initial state: a pool (1) and a spa (8), as the capture of issue 60 of the reference. */
export function initialState() {
  return {
    backyard: { name: 'Backyard', state: 1, air: 77 },
    bodies: [
      { id: 1, name: 'Pool', type: 'BOW_POOL', temp: 82 },
      { id: 8, name: 'Spa', type: 'BOW_SPA', temp: -1 },
    ],
    filters: [
      { id: 3, bow: 1, name: 'Filter Pump', state: 1, speed: 50, last: 50, power: 400 },
      { id: 10, bow: 8, name: 'Spa Filter', state: 0, speed: 0, last: 60, power: 0 },
    ],
    heaters: [
      { id: 4, bow: 1, enable: 0, setpoint: 84, min: 65, max: 104, units: [5] },
      { id: 11, bow: 8, enable: 1, setpoint: 99, min: 65, max: 104, units: [12] },
    ],
    heaterUnits: [
      { id: 5, name: 'Gas', state: 0 },
      { id: 12, name: 'Spa Gas', state: 0 },
    ],
    pumps: [{ id: 14, bow: 8, name: 'Jet', state: 0, speed: 0, last: 100 }],
    relays: [
      { id: 27, bow: 0, name: 'Yard Lights', type: 'RLY_HIGH_VOLTAGE_RELAY', state: 0 },
      { id: 36, bow: 1, name: 'UV Ozone', type: 'RLY_HIGH_VOLTAGE_RELAY', state: 1 },
      { id: 22, bow: 1, name: 'Water Ft', type: 'RLY_VALVE_ACTUATOR', state: 0 },
    ],
    lights: [{ id: 23, bow: 1, name: 'Pool Light', state: 0 }],
    chlor: { id: 30, bow: 1, salt: 3200 },
    csad: { id: 31, bow: 1, ph: 7.4, orp: 690 },
    checksum: 5483444,
    version: 'R0408000',
  };
}

const esc = (t) => String(t).replace(/&/g, '&amp;').replace(/</g, '&lt;');

export function configXml(s) {
  const relay = (r) =>
    `<Relay><System-Id>${r.id}</System-Id><Name>${esc(r.name)}</Name><Type>${r.type}</Type><Function>RLY_ACCESSORY</Function></Relay>`;
  const light = (l) =>
    `<ColorLogic-Light><System-Id>${l.id}</System-Id><Name>${esc(l.name)}</Name><Type>COLOR_LOGIC_UCL</Type></ColorLogic-Light>`;
  const bodies = s.bodies
    .map((b) => {
      const filters = s.filters
        .filter((f) => f.bow === b.id)
        .map(
          (f) =>
            `<Filter><System-Id>${f.id}</System-Id><Name>${esc(f.name)}</Name><Filter-Type>FMT_VARIABLE_SPEED_PUMP</Filter-Type><Max-Pump-Speed>100</Max-Pump-Speed><Min-Pump-Speed>18</Min-Pump-Speed><Max-Pump-RPM>3450</Max-Pump-RPM><Min-Pump-RPM>600</Min-Pump-RPM><Priming-Enabled>yes</Priming-Enabled></Filter>`,
        )
        .join('');
      const heaters = s.heaters
        .filter((h) => h.bow === b.id)
        .map(
          (h) =>
            `<Heater><System-Id>${h.id}</System-Id><Enabled>${h.enable ? 'yes' : 'no'}</Enabled><Current-Set-Point>${h.setpoint}</Current-Set-Point><Min-Settable-Water-Temp>${h.min}</Min-Settable-Water-Temp><Max-Settable-Water-Temp>${h.max}</Max-Settable-Water-Temp><Operation>PEO_INIT<Action><Action-Function>ACT_FNC_HEATER_STARTUP</Action-Function></Action></Operation>${h.units
              .map((u) => {
                const unit = s.heaterUnits.find((x) => x.id === u);
                return `<Operation>PEO_HEATER_EQUIPMENT<Heater-Equipment><System-Id>${u}</System-Id><Name>${esc(unit?.name ?? 'Heater')}</Name><Type>PET_HEATER</Type><Heater-Type>HTR_GAS</Heater-Type><Enabled>yes</Enabled></Heater-Equipment></Operation>`;
              })
              .join('')}</Heater>`,
        )
        .join('');
      const pumps = s.pumps
        .filter((p) => p.bow === b.id)
        .map(
          (p) =>
            `<Pump><System-Id>${p.id}</System-Id><Name>${esc(p.name)}</Name><Type>PMP_VARIABLE_SPEED_PUMP</Type><Function>PMP_JETS</Function><Max-Pump-Speed>100</Max-Pump-Speed><Min-Pump-Speed>18</Min-Pump-Speed></Pump>`,
        )
        .join('');
      const chlor =
        s.chlor?.bow === b.id
          ? `<Chlorinator><System-Id>${s.chlor.id}</System-Id><Name>Chlorinator</Name><Enabled>yes</Enabled></Chlorinator>`
          : '';
      const csad =
        s.csad?.bow === b.id
          ? `<CSAD><System-Id>${s.csad.id}</System-Id><Name>pH</Name><Type>ACID</Type></CSAD>`
          : '';
      return `<Body-of-water>01<System-Id>${b.id}</System-Id><Name>${esc(b.name)}</Name><Type>${b.type}</Type><Size-In-Gallons>14000</Size-In-Gallons>${filters}${heaters}<Sensor><System-Id>${b.id + 100}</System-Id><Name>WaterSensor</Name><Type>SENSOR_WATER_TEMP</Type><Units>UNITS_FAHRENHEIT</Units></Sensor>${s.relays
        .filter((r) => r.bow === b.id)
        .map(relay)
        .join('')}${s.lights
        .filter((l) => l.bow === b.id)
        .map(light)
        .join('')}${pumps}${chlor}${csad}</Body-of-water>`;
    })
    .join('');
  return `<?xml version="1.0" encoding="UTF-8" ?>
<!--Settings for MSP-->
<MSPConfig><System><Msp-Vsp-Speed-Format>Percent</Msp-Vsp-Speed-Format><Units>Standard</Units></System><Backyard>MSP Configuration<System-Id>0</System-Id><Name>${esc(s.backyard.name)}</Name><Sensor><System-Id>16</System-Id><Name>AirSensor</Name><Type>SENSOR_AIR_TEMP</Type><Units>UNITS_FAHRENHEIT</Units></Sensor>${s.relays
    .filter((r) => r.bow === 0)
    .map(relay)
    .join(
      '',
    )}${bodies}</Backyard><Groups><Group><System-Id>33</System-Id><Name>All Off</Name></Group></Groups></MSPConfig>`;
}

export function telemetryXml(s) {
  const lines = [
    `<Backyard systemId="0" statusVersion="11" airTemp="${s.backyard.air}" state="${s.backyard.state}" ConfigChksum="${s.checksum}" mspVersion="${s.version}" />`,
  ];
  for (const b of s.bodies) {
    lines.push(`<BodyOfWater systemId="${b.id}" waterTemp="${b.temp}" flow="255" />`);
    for (const f of s.filters.filter((x) => x.bow === b.id)) {
      lines.push(
        `<Filter systemId="${f.id}" filterState="${f.state}" filterSpeed="${f.speed}" valvePosition="1" whyFilterIsOn="0" fpOverride="0" reportedFilterSpeed="${f.speed}" power="${f.power}" lastSpeed="${f.last}" />`,
      );
    }
    for (const h of s.heaters.filter((x) => x.bow === b.id)) {
      lines.push(
        `<VirtualHeater systemId="${h.id}" Current-Set-Point="${h.setpoint}" enable="${h.enable}" SolarSetPoint="90" Mode="0" SilentMode="0" whyHeaterIsOn="1" />`,
      );
      for (const u of h.units) {
        const unit = s.heaterUnits.find((x) => x.id === u);
        if (unit) {
          lines.push(
            `<Heater systemId="${u}" heaterState="${unit.state}" temp="79" enable="1" priority="0" maintainFor="24" />`,
          );
        }
      }
    }
  }
  for (const p of s.pumps) {
    lines.push(
      `<Pump systemId="${p.id}" pumpState="${p.state}" pumpSpeed="${p.speed}" lastSpeed="${p.last}" whyOn="0" />`,
    );
  }
  for (const r of s.relays) {
    lines.push(
      r.type === 'RLY_VALVE_ACTUATOR'
        ? `<ValveActuator systemId="${r.id}" valveActuatorState="${r.state}" whyOn="0" />`
        : `<Relay systemId="${r.id}" relayState="${r.state}" whyOn="0" />`,
    );
  }
  for (const l of s.lights) {
    lines.push(
      `<ColorLogic-Light systemId="${l.id}" lightState="${l.state}" currentShow="0" speed="4" brightness="4" specialEffect="0" />`,
    );
  }
  if (s.chlor) {
    lines.push(
      `<Chlorinator systemId="${s.chlor.id}" status="68" instantSaltLevel="${s.chlor.salt}" avgSaltLevel="${s.chlor.salt}" chlrAlert="0" chlrError="0" scMode="0" operatingState="2" Timed-Percent="100" operatingMode="1" enable="1" />`,
    );
  }
  if (s.csad) {
    lines.push(
      `<CSAD systemId="${s.csad.id}" status="0" ph="${s.csad.ph}" orp="${s.csad.orp}" mode="1" />`,
    );
  }
  lines.push('<Group systemId="33" groupState="0" />');
  return `<?xml version="1.0" encoding="UTF-8" ?>\n<STATUS version="1.11">\n${lines.join('\n')}\n</STATUS>`;
}

/** The parameters of a request body, by name (numbers). */
export function paramsOf(text) {
  const params = {};
  for (const m of text.matchAll(/<Parameter name="([^"]+)"[^>]*>([^<]*)<\/Parameter>/g)) {
    params[m[1]] = Number(m[2]);
  }
  return params;
}

/**
 * The controller. Options (all may be changed later on the object):
 * `timers`, `latencyMs` (number or (type) => number), `applyDelayMs` (a
 * command applied that long after its ack), `ignoreSet` (acked, never
 * applied), `silent` (nothing answered), `silentSet` (commands: no ack;
 * 'applied': no ack but applied), `noAnswer` (reads acked, never answered),
 * `dropAcks` (that many acks lost), `coolDownMs` (a filter turned off runs
 * down that long, state 6), `heaterRunsMs` (a heater turned off keeps its
 * unit on that long), `down` (every datagram lost), `hostOk(host, port)`,
 * `blockSize`.
 */
export function fakeOmni(options = {}) {
  const omni = {
    timers: globalThis,
    latencyMs: 5,
    applyDelayMs: 0,
    ignoreSet: false,
    silent: false,
    silentSet: false,
    noAnswer: false,
    down: false,
    dropAcks: 0,
    coolDownMs: 0,
    heaterRunsMs: 0,
    blockSize: 1024,
    hostOk: (host, port) => host === HOST && port === PORT,
    ...options,
    state: initialState(),
    /** Every request: { type, params, id, at, socket }. */
    requests: [],
    /** Acks received from the client (message ids). */
    clientAcks: [],
    sockets: 0,
    open: 0,
    peak: 0,
    seq: 1000,
  };
  omni.now = () => (omni.timers === globalThis ? performance.now() : omni.clockNow?.());
  omni.sets = () =>
    omni.requests.filter((r) =>
      [TYPES.SET_EQUIPMENT, TYPES.HEATER_ENABLE, TYPES.SET_HEATER].includes(r.type),
    );
  omni.count = (type) => omni.requests.filter((r) => r.type === type).length;

  const find = (id) => {
    const s = omni.state;
    for (const [kind, list] of [
      ['filter', s.filters],
      ['pump', s.pumps],
      ['relay', s.relays],
      ['light', s.lights],
      ['heater', s.heaters],
    ]) {
      const item = list.find((x) => x.id === id);
      if (item) return { kind, item };
    }
    return undefined;
  };

  const later = (fn) => {
    if (omni.applyDelayMs > 0) omni.timers.setTimeout(fn, omni.applyDelayMs);
    else fn();
  };

  /** Applies a command to the state. */
  omni.apply = (type, p) => {
    if (omni.ignoreSet) return;
    const s = omni.state;
    if (type === TYPES.SET_EQUIPMENT) {
      const target = find(p.equipmentId);
      if (!target) return;
      const { kind, item } = target;
      if (kind === 'filter' || kind === 'pump') {
        if (p.isOn > 0) {
          item.state = 1;
          item.speed = p.isOn;
          item.last = p.isOn;
          if (kind === 'filter') item.power = 400;
        } else if (kind === 'filter' && omni.coolDownMs > 0 && item.state !== 0) {
          item.state = 6;
          omni.timers.setTimeout(() => {
            item.state = 0;
            item.speed = 0;
            item.power = 0;
          }, omni.coolDownMs);
        } else {
          item.state = 0;
          item.speed = 0;
          if (kind === 'filter') item.power = 0;
        }
      } else if (kind === 'relay') {
        item.state = p.isOn ? 1 : 0;
      } else if (kind === 'light') {
        item.state = p.isOn ? 6 : 0;
      }
    } else if (type === TYPES.HEATER_ENABLE) {
      const heater = s.heaters.find((h) => h.id === p.HeaterID);
      if (!heater) return;
      heater.enable = p.Enabled ? 1 : 0;
      if (!p.Enabled && omni.heaterRunsMs > 0) {
        omni.timers.setTimeout(() => {
          for (const u of heater.units) {
            const unit = s.heaterUnits.find((x) => x.id === u);
            if (unit) unit.state = 0;
          }
        }, omni.heaterRunsMs);
      } else if (!p.Enabled) {
        for (const u of heater.units) {
          const unit = s.heaterUnits.find((x) => x.id === u);
          if (unit) unit.state = 0;
        }
      }
    } else if (type === TYPES.SET_HEATER) {
      const heater = s.heaters.find((h) => h.id === p.HeaterID);
      if (heater) heater.setpoint = p.Temp;
    }
  };

  /** The datagrams answering one datagram of the client (each sent after the latency). */
  omni.handle = (buf, socket) => {
    if (buf.length < 24) return [];
    const id = buf.readUInt32BE(0);
    const type = buf.readUInt32BE(16);
    const body = buf.subarray(24).toString('utf8').replace(/\0+$/, '');
    if (type === TYPES.ACK) {
      omni.clientAcks.push(id);
      return [];
    }
    const params = paramsOf(body);
    omni.requests.push({ type, params, id, body, at: omni.now(), socket });
    omni.onRequest?.(type, params);
    if (omni.silent) return [];
    const isSet = [TYPES.SET_EQUIPMENT, TYPES.HEATER_ENABLE, TYPES.SET_HEATER].includes(type);
    if (isSet && omni.silentSet) {
      if (omni.silentSet === 'applied') later(() => omni.apply(type, params));
      return [];
    }
    const out = [];
    if (omni.dropAcks > 0) {
      omni.dropAcks -= 1;
    } else {
      out.push(datagram(id, TYPES.MSP_ACK));
    }
    if (isSet) {
      if (out.length > 0 || omni.applyLostAck) later(() => omni.apply(type, params));
      return out;
    }
    if (omni.noAnswer) return out;
    if (type === TYPES.TELEMETRY) {
      omni.seq += 1;
      const xml = omni.telemetryText ?? telemetryXml(omni.state);
      out.push(datagram(omni.seq, TYPES.TELEMETRY_UPDATE, deflateSync(Buffer.from(`${xml}\0`))));
      return out;
    }
    if (type === TYPES.CONFIG) {
      const data = deflateSync(Buffer.from(omni.configText ?? configXml(omni.state)));
      const blocks = [];
      for (let at = 0; at < data.length; at += omni.blockSize) {
        blocks.push(data.subarray(at, at + omni.blockSize));
      }
      omni.seq += 1;
      const lead = `<?xml version="1.0" encoding="UTF-8" ?><Response xmlns="http://nextgen.hayward.com/api"><Name>LeadMessage</Name><Parameters><Parameter name="SourceOpId" dataType="int">1003</Parameter><Parameter name="MsgSize" dataType="int">${data.length}</Parameter><Parameter name="MsgBlockCount" dataType="int">${blocks.length}</Parameter><Parameter name="Type" dataType="int">0</Parameter></Parameters></Response>\0`;
      out.push(datagram(omni.seq, TYPES.LEAD, Buffer.from(lead), { compressed: 1 }));
      for (const block of blocks) {
        omni.seq += 1;
        out.push(datagram(omni.seq, TYPES.BLOCK, Buffer.concat([Buffer.alloc(8), block])));
      }
      return out;
    }
    return out;
  };

  const latency = (type) =>
    typeof omni.latencyMs === 'function' ? omni.latencyMs(type) : omni.latencyMs;

  /** A node:dgram double on `omni.timers`. */
  omni.createSocket = () => {
    const socket = new EventEmitter();
    socket.closed = false;
    socket.connected = false;
    omni.sockets += 1;
    socket.connect = (port, host) => {
      omni.timers.setTimeout(() => {
        if (socket.closed) return;
        const ok = omni.hostOk(host, port);
        if (ok === 'error') {
          socket.emit('error', new Error('EHOSTUNREACH'));
          return;
        }
        socket.connected = true;
        socket.host = host;
        socket.port = port;
        omni.open += 1;
        omni.peak = Math.max(omni.peak, omni.open);
        socket.emit('connect');
      }, 1);
    };
    socket.send = (buf, callback) => {
      if (socket.closed) throw new Error('Not running');
      omni.timers.setTimeout(() => callback?.(), 0);
      // A datagram to an address where no controller is: lost.
      if (omni.down || omni.hostOk(socket.host, socket.port) !== true) return;
      const replies = omni.handle(Buffer.from(buf), socket);
      replies.forEach((reply, index) => {
        omni.timers.setTimeout(
          () => {
            if (!socket.closed)
              socket.emit('message', reply, { address: socket.host, port: socket.port });
          },
          latency(buf.readUInt32BE(16)) + index,
        );
      });
    };
    socket.close = (callback) => {
      if (socket.closed) throw new Error('Not running');
      socket.closed = true;
      if (socket.connected) omni.open -= 1;
      omni.timers.setTimeout(() => callback?.(), 0);
    };
    return socket;
  };

  /** A real UDP socket on 127.0.0.1 (the real-clock tests); resolves its port. */
  omni.listen = () =>
    new Promise((resolve) => {
      const server = dgramSocket('udp4');
      omni.server = server;
      server.on('message', (buf, rinfo) => {
        const replies = omni.handle(buf, rinfo);
        replies.forEach((reply, index) => {
          setTimeout(
            () => server.send(reply, rinfo.port, rinfo.address),
            latency(buf.readUInt32BE(16)) + index,
          );
        });
      });
      server.bind(0, '127.0.0.1', () => resolve(server.address().port));
    });
  omni.close = () =>
    new Promise((resolve) => (omni.server ? omni.server.close(resolve) : resolve()));

  return omni;
}
