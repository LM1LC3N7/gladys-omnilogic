// -----------------------------------------------------------------------------
// The datagrams of the OmniLogic protocol (pure), from python-omnilogic-local
// 5.0.2 (Apache-2.0: `api/message.py`, `api/protocol.py`, `api/api.py`):
//
//   header, 24 bytes, big endian ("!LQ4sLBBBB"):
//     message id (u32), time in seconds (u64), protocol version (4 ASCII
//     bytes, "1.19"), message type (u32), client type (u8: 0 when there is a
//     body, else 1), reserved (u8), compressed (u8), reserved (u8);
//   body: the XML text, ended by a NUL byte.
//
// The requests are built here, value by value, from whole numbers checked
// by the caller (never a text of Gladys): no injection is possible.
// -----------------------------------------------------------------------------

import { MSG, PROTOCOL } from '../constants.js';

/** A whole number 0..max, else throws (a request is never built from a bad value). */
function whole(value, max = 0xffff) {
  if (!Number.isInteger(value) || value < 0 || value > max) {
    throw new Error('Bad value for a request');
  }
  return String(value);
}

/** One datagram: the header, then the body (with its NUL), if any. */
export function encode({ id, type, body, time = 0 }) {
  const payload = body === undefined ? Buffer.alloc(0) : Buffer.from(`${body}\u0000`, 'utf8');
  const header = Buffer.alloc(PROTOCOL.headerSize);
  header.writeUInt32BE(id >>> 0, 0);
  header.writeBigUInt64BE(BigInt(Math.max(0, Math.floor(time))), 4);
  header.write(PROTOCOL.version, 12, 4, 'ascii');
  header.writeUInt32BE(type >>> 0, 16);
  header.writeUInt8(body === undefined ? 1 : PROTOCOL.clientXml, 20);
  header.writeUInt8(0, 21);
  header.writeUInt8(0, 22);
  header.writeUInt8(0, 23);
  return Buffer.concat([header, payload]);
}

/** The header and payload of a datagram, or undefined when it is not one. */
export function decode(buffer) {
  if (!Buffer.isBuffer(buffer) || buffer.length < PROTOCOL.headerSize) {
    return undefined;
  }
  return {
    id: buffer.readUInt32BE(0),
    type: buffer.readUInt32BE(16),
    compressed: buffer.readUInt8(22) === 1,
    payload: buffer.subarray(PROTOCOL.headerSize),
  };
}

/** The XML of a request; `extra`: the attributes the reference adds (alias, unit). */
const request = (name, params = []) => {
  const lines = params.map(
    ([pname, type, value, extra = '']) =>
      `<Parameter name="${pname}" dataType="${type}"${extra}>${value}</Parameter>`,
  );
  const parameters = lines.length > 0 ? `<Parameters>${lines.join('')}</Parameters>` : '';
  return `<?xml version="1.0" encoding="UTF-8"?><Request xmlns="${PROTOCOL.namespace}"><Name>${name}</Name>${parameters}</Request>`;
};

/** The acknowledgement the client sends for each answer of the controller. */
export const ACK_BODY = `<Request xmlns="${PROTOCOL.namespace}"><Name>Ack</Name></Request>`;

export const REQUESTS = {
  configuration: () => ({ type: MSG.REQUEST_CONFIGURATION, body: request('RequestConfiguration') }),
  telemetry: () => ({ type: MSG.GET_TELEMETRY, body: request('RequestTelemetryData') }),
  /** A filter, pump, relay or light: `isOn` 0 (off), 1 (on) or a speed in percent. */
  equipment: (bow, id, isOn) => ({
    type: MSG.SET_EQUIPMENT,
    body: request('SetUIEquipmentCmd', [
      ['poolId', 'int', whole(bow)],
      ['equipmentId', 'int', whole(id)],
      ['isOn', 'int', whole(isOn, 100), ' alias="Data"'],
      ['IsCountDownTimer', 'bool', '0'],
      ['StartTimeHours', 'int', '0'],
      ['StartTimeMinutes', 'int', '0'],
      ['EndTimeHours', 'int', '0'],
      ['EndTimeMinutes', 'int', '0'],
      ['DaysActive', 'int', '0'],
      ['Recurring', 'bool', '0'],
    ]),
  }),
  /** A group (theme): 0 off, 1 on. */
  group: (id, on) => ({
    type: MSG.RUN_GROUP,
    body: request('RunGroupCmd', [
      ['GroupID', 'int', whole(id)],
      ['Data', 'int', whole(on, 1)],
      ['IsCountDownTimer', 'bool', '0'],
      ['StartTimeHours', 'int', '0'],
      ['StartTimeMinutes', 'int', '0'],
      ['EndTimeHours', 'int', '0'],
      ['EndTimeMinutes', 'int', '0'],
      ['DaysActive', 'int', '0'],
      ['Recurring', 'bool', '0'],
    ]),
  }),
  /** A (virtual) heater: 0 off, 1 on. */
  heaterEnable: (bow, id, on) => ({
    type: MSG.SET_HEATER_ENABLE,
    body: request('SetHeaterEnable', [
      ['poolId', 'int', whole(bow)],
      ['HeaterID', 'int', whole(id), ' alias="EquipmentID"'],
      ['Enabled', 'bool', whole(on, 1), ' alias="Data"'],
    ]),
  }),
  /** The heating set point, a whole °F (bounded by the caller, checked again here). */
  setpoint: (bow, id, fahrenheit) => {
    if (!Number.isInteger(fahrenheit) || fahrenheit < 65 || fahrenheit > 104) {
      throw new Error('Set point out of the protocol range');
    }
    return {
      type: MSG.SET_HEATER,
      body: request('SetUIHeaterCmd', [
        ['poolId', 'int', whole(bow)],
        ['HeaterID', 'int', whole(id), ' alias="EquipmentID"'],
        ['Temp', 'int', whole(fahrenheit, 104), ' unit="F" alias="Data"'],
      ]),
    };
  },
};
