# Third-party notices

This integration is licensed under the Apache License 2.0 (see `LICENSE`).

## python-omnilogic-local

The OmniLogic protocol as used here (`src/constants.js`, `src/omni/protocol.js`,
`src/omni/client.js`, `src/omni/model.js`) is ported from
**python-omnilogic-local** 5.0.2
(<https://github.com/cryptk/python-omnilogic-local>, commit `0ef5672` of
2026-09-07, Apache License, Version 2.0; authors listed in its
`pyproject.toml`: Chris Jowett, djtimca, garionphx): UDP port 10444, the
24-byte header (message id, time, protocol version "1.19", message type,
client type, compressed flag), the XML bodies ended by a NUL byte, the acks
(MSP_ACK, ACK), the lead and block messages, the zlib-compressed telemetry,
the message types and request names (RequestConfiguration,
RequestTelemetryData, SetUIEquipmentCmd, SetHeaterEnable, SetUIHeaterCmd),
the MSPConfig and telemetry elements and attributes, the state codes of
filters, pumps, relays, lights and heaters, the 65–104 °F set point range
and the "last speed" rule for turning a pump on. No Python code runs here and
python-omnilogic-local is not a dependency. This port was modified: written
in JavaScript, every read and write bounded in time and size, one request at
a time on a new socket each, a bounded XML reader of its own, only six
requests, stops never held back, commands behind options, set points bounded.

The tests use three captures of real controllers from its repository
(`tests/fixtures/issue-60.json`, `issue-144.json`, `issue-163.json`), copied
unchanged into `test/fixtures/captures/`, and its fake controller follows
those captures.

python-omnilogic-local is distributed under the Apache License, Version 2.0,
whose full text is in `LICENSE` (the same license as this integration). It has
no NOTICE file.

## gladys-testkit

`test/kit/` holds files of gladys-testkit (Apache-2.0, the clocks used by the
tests), unchanged. They are not part of the image.
