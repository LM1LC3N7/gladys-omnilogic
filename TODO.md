# TODO — Hayward OmniLogic v1

Handoff document: what is done, what was decided, what comes next. Keep it
up to date at the end of every milestone.

## Working method

- One milestone at a time, one commit per milestone, tests green before moving on.
- After each milestone: `gi ci` (Prettier, ESLint, Node 22 and 24, Docker,
  store validator), `npm run audit`, then update README, `docs/en.md`,
  `docs/fr.md`, `CHANGELOG.md` and this file.
- No forum post from a module session (lot 19, wave 3).
- The `gladys-assistant-integration` topic is added at the first real release
  only. No `keywords` nor `countries` in the manifest yet (the core has not
  shipped them).

## Status

- [x] **Milestone 1 — core** (2026-10-31): one controller by address, one
      device per controller (hash of its bodies of water), air and water
      temperatures, heaters (on/off, set point, heating now), filter pumps,
      pumps, relays (never valves), ColorLogic lights, salt, pH, ORP; stops
      never held back (kept in `/data`, checked every 15 s, 3 acked resends
      at most); equipment, lights and heating behind three options; set
      points bounded on the whole °F; never read sooner than the interval;
      docs en/fr, cover. Tested against a fake built from
      python-omnilogic-local and its captures of real controllers.
- [ ] **Milestone 2 — real controller**: run against a real OmniLogic (see
      "To check"), turn the answers (anonymized) into fixtures.
- [ ] **Milestone 3 — more**: pump and filter speeds (behind the option,
      bounded by the configured min/max), light shows, groups (themes: their
      "on" may enable heaters and turn things off), the body volume (gallons
      converted to litres; the unit in "Metric" mode to check), the
      chlorinator (enable, superchlorination: sensitive), solar set point,
      spillover.

## To check on a real controller

- Does a controller answer several clients at once (the Hayward app, Home
  Assistant)? The module opens one socket per request, one at a time.
- The time a command takes to show in the telemetry (read back at 400 ms,
  then 5 s and 20 s).
- `SetHeaterEnable` 0: does the virtual heater show `enable="0"` right after,
  and do the heater units stop (`heaterState`)?
- `ConfigChksum` (status version ≥ 11): does it change on every
  configuration change, and only then? Older firmware has none: the
  configuration is then read again every 10 minutes.
- The filter states during a stop (3, 4, 6, 11 read as "running down"), the
  freeze protection (a stop not applied while it runs: held after 4 writes).
- Is the telemetry ever split into a lead and blocks, and with which flag?

## Decisions

- **Version 0.1.0 set by hand** in `package.json`, `package-lock.json`, the
  manifest and the `docker_image` tag
  (`ghcr.io/lm1lc3n7/gladys-omnilogic:0.1.0`): the first Release (patch)
  gives 0.1.1. SDK `^0.16.0` (latest published, checked 2026-10-31 on the
  registry).
- **Reference**: python-omnilogic-local 5.0.2 (Apache-2.0, `0ef5672` of
  2026-09-07), cloned read only in `~/code/ref/lot19/python-omnilogic-local`;
  its captures of real controllers (issues 60, 144, 163) copied as fixtures.
  The Home Assistant integration cryptk/haomnilogic-local was not read.
- **Categories** `appliances`, `environment` (as gladys-intellicenter).
- **Identity**: the protocol gives no MAC nor serial number. The id is a hash
  of the bodies of water (system id and type, sorted): stable across
  reboots, firmware and renames; a body added or removed makes a new device
  (said in the docs). Before every command, the fresh telemetry must carry
  the checksum the configuration was read with and its bodies; else nothing
  is sent and the configuration is read again. Stops never check it (sent to
  the address typed, or the last one read).
- **UDP**: a new socket per request, connected to the controller (the kernel
  drops other senders), closed before the next one opens; an ack awaited
  800 ms, the request sent again with a new id until its timeout; every
  message of the controller acked. "Sent" = a datagram left; a request
  without an ack is "sent, without confirmation", never "nothing sent".
- **The stops**: an equipment off (SetUIEquipmentCmd isOn 0) and a heater off
  (SetHeaterEnable 0), one datagram each, no read first. Tried every 250 ms
  for 3 s, then kept in `/data`, checked every 15 s and at every read. A
  write counts as a resend only when the controller acked it and an earlier
  write was acked too: a stop never acked is written again at every check,
  without end, never held. Acked without effect: 3 resends, then held until
  a new click, the telemetry showing it, or a newer command of the setting
  that left. "Running down" (filter states 3, 4, 5, 6, 11; light 1, 7; a
  heater unit still on after its heater shows off) is watched, not
  rewritten; said "check on the controller" after 10 minutes. Without the
  configuration, the heater units are unknown: the heater stop stays
  watched until the configuration is read. "Test the connection" writes
  every kept stop again at once.
- **Commands batched**: commands arriving within 30 ms go in one turn of the
  line, after one fresh telemetry, one datagram each, then one read back;
  only the last command of a setting in a batch is planned (the earlier
  ones answer "replaced"). Each leaves by 3.5 s after its click or never,
  answered by 4.3 s. The backyard must read state 1 (not service or
  configuration mode).
- **Filter pump on**: its last speed when within its min/max, else its
  maximum (the reference's rule); needs "heating" too unless the heater of
  its body is seen off with no unit on; refused during the heater stop of its
  body.
- **Set points**: always behind "Allow heating", including a decrease (the
  protective path is the heater off); refused during the heater stop. Whole
  °F within 65–104 (protocol), the heater's Min/Max-Settable-Water-Temp
  (refused when unreadable), a spa 40 °C, a pool the ceiling (35 °C by
  default, 20–40, °F rounded down); a final check on the value converted
  back.
- **Temperatures**: always °F on the protocol (the reference, and the
  capture of a controller in "Metric" display). A sensor configured in
  another unit is not published.
- **Not published**: the body volume (gallons; unit in metric mode not
  checked), the flow (255 vs 1 meaning unclear), groups, valve actuators,
  chlorinator settings.
- **/data**: opened without blocking, refused when not a plain file (a FIFO
  never blocks a read); the temporary file of a save created anew
  (`O_EXCL`). Every wait on /data on the path of a stop is bounded (200 ms);
  the check is armed before any save.
- **Mutation check** (2026-10-31): 37 mutants of the guards (stop before a
  command, options on arrival and before each datagram, deadline, heating
  side effect, heater stop in progress, identity, service mode, read back,
  read begun before a write, unacked stops, hold count, running down, resend
  count, /data bounded wait, gathering answered at once, test button,
  last command of a setting, first wait, late /data, set point bounds,
  checksum, spa ceiling, heater units, ack ids, answer and block sizes, ack
  resend, inflate bound, DOCTYPE, acked only if written, broadcast address),
  run one at a time in a private temporary copy: all killed but one
  equivalent (`isFile()` in `src/store.js`: every special file already reads
  as unreadable through the positional read or the JSON; the guard stays).
- **Test files**: `test/kit/` holds gladys-testkit files as is (excluded from
  Prettier).
