# CLAUDE.md

Project rules for coding assistants (Claude Code reads this file) and for human
contributors.

## What this is

A Gladys Assistant **external integration**: a Node.js service (Node 22+, ESM,
no build step) that runs in its own sandboxed Docker container and talks to
Gladys through
[`@gladysassistant/integration-sdk`](https://github.com/GladysAssistant/integration-sdk-js),
its only runtime dependency. It started from the official JavaScript template.
It reads and drives Hayward OmniLogic pool controllers over their local UDP
protocol (port 10444).

## Commands

```bash
npm install
npm test                                  # node --test --test-timeout=60000
node --test test/stop.test.js             # one file
node --test --test-name-pattern "held"    # tests whose name matches
npm run lint                              # ESLint
npm run format:check                      # Prettier, as the CI runs it
npm run format                            # Prettier, fix in place
npx github:GladysAssistant/integration-store .   # store admission checks
```

The CI (`.github/workflows/ci.yml`) runs `format:check`, `lint` and `test` on
Node 22 and 24, and builds the Docker image: run the three commands before
pushing.

## Architecture

```
index.js                          SDK wiring only: handlers registered before connect(), stops kept in /data sent at boot
src/handlers.js                   SDK handlers -> OmniLogicApp (shared with the tests)
src/app.js                        polling, device, states, status, commands (batched), the stops and their checks
src/lane.js                       one request at a time; the stop first (it aborts the holder)
src/omni/client.js                the only network access: one request at a time, a new UDP socket each, acks, lead/blocks, bounds
src/omni/protocol.js              the datagrams (header, request bodies built from checked whole numbers)
src/omni/xml.js                   bounded XML reader (no DOCTYPE, null-prototype attributes)
src/omni/model.js                 configuration and telemetry read by name (pure): identity, values, set point bounds
src/devices.js                    device and states of the controller (pure); feature kinds are frozen
src/store.js                      /data/omnilogic-state.json: stops, last read, target; no secret; special files refused
src/publisher.js                  states to Gladys within 300 per minute, nothing older than 2 minutes
src/config.js                     DEFAULT_CONFIG (mirrors the manifest defaults) + normalization
src/i18n.js                       English and French runtime texts
scripts/cover.mjs                 cover.png generator (plain Node, no dependency)
gladys-assistant-integration.json manifest: name, config_schema, actions, image...
docs/en.md, docs/fr.md            user documentation, re-hosted by Gladys (mandatory)
test/                             node --test, against the SDK's fake Gladys and test/fixtures/fakeOmni.js
test/fixtures/captures/           real controller captures from python-omnilogic-local (Apache-2.0)
test/kit/                         gladys-testkit files, as is (clocks)
.github/scripts/release.mjs       release helpers (manifest bump, changelog), tested in test/
```

## Rules

- **External ids are forever.** Device `gladys.externalIds('omnilogic', id)`,
  `id` the hash of the bodies of water (system id and type, `panelIdOf`),
  never the address. Feature roles `<kind>-<body>_<system id>` (`KINDS` of
  `src/constants.js`), the select values (`on`/`off`), manifest keys (`host`,
  `allow_equipment`, `allow_lights`, `allow_heating`, `max_pool_setpoint`,
  `poll_interval`, `language`, the action `test_connection`), the stop
  writes of `/data` (`STATUS` OFF, `ENABLE` 0).
- **The container rootfs is read-only.** Write only under `/data`. The
  controller has no credentials; never keep a name in `/data`.
- **Protocol from python-omnilogic-local (Apache-2.0) only.** Only the six
  requests of `src/constants.js` are sent; never a valve, a group, a light
  show, a schedule, the chlorinator or the spillover.
- **One request at a time** (`src/lane.js`), each on a new socket opened only
  once the previous one is closed.
- **The stops** (an equipment off, a heater off): never behind an option, the
  bounds, a read, a command, the identity, a missing configuration; they
  abort what holds the line; a command that arrived before them and has not
  left gives way; kept in `/data` before the first datagram (200 ms at most,
  a hung disk never holds them); checked every 15 s and at every read;
  written again 3 times at most once acked (an unacked write never counts);
  let go only when the telemetry shows them or a newer command of the same
  setting clicked in Gladys left. A stop never acked is never given up.
  Never ended by time.
- **Commands** (equipment on, heater on, set point): never a switch or a
  writable binary; refused unless their option, checked on arrival, on the
  fresh telemetry and in `beforeSend`; a filter pump whose heater is not seen
  off needs heating too; identity (checksum and bodies) checked on the fresh
  telemetry; set points bounded on the whole °F written (protocol 65–104 °F,
  the heater limits, spa ≤ 40 °C, pool ≤ the ceiling); confirmed only by a
  read back equal to the value asked.
- **Clocks**: monotonic for every in-memory time; the wall clock for /data
  (and the time field of the header) only.
- **Never read sooner than the interval** (button, scan, reconnection,
  restart); only the follow-up reads after a command (5 s, 20 s).
- **Versions belong to the Release workflow** (Actions → Release). Never edit
  `version` by hand (0.1.0 was set by hand once, see TODO.md).
- **Changelog**: every user-visible change adds a line under
  `## [Unreleased]`.
- **Manifest** texts are `{ "en", "fr" }`; `test/manifest.test.js` ties the
  manifest to the code. Files are UTF-8 without BOM.
- **Style.** Prettier formats, ESLint catches mistakes. Comments explain why,
  in English. Tests never touch the network (loopback only).
