# gladys-omnilogic

A [Gladys Assistant](https://gladysassistant.com) external integration for
**Hayward OmniLogic** pool controllers, over their local protocol (UDP port
10444): no cloud, no account. Unofficial, not affiliated with Hayward.
**Never tested with a real controller.**

- One device per controller: air and water temperatures, heaters (on / off,
  set point, heating now), filter pumps (on / off, speed, power), pumps,
  relays and ColorLogic lights (on / off), salt, pH and ORP.
- Turning off (equipment, heater) always works, whatever the options, a read
  in progress or the configuration; kept in `/data` until the controller
  shows it.
- Turning on (pumps and relays, lights) and heating (heater on, set point)
  are each behind an option, off by default; set points bounded on the whole
  °F written (a spa at most 40 °C, a pool at most 35 °C by default, within
  the heater's limits).

User guide: [English](docs/en.md), [français](docs/fr.md).

## Development

```bash
npm install
npm test             # node --test --test-timeout=60000
npm run lint
npm run format:check
```

Tests run against a fake controller built from python-omnilogic-local 5.0.2
(`test/fixtures/fakeOmni.js`) and the captures of real controllers its
repository publishes (`test/fixtures/captures/`). See `CLAUDE.md` for the
architecture and the rules, `TODO.md` for the decisions.

## License

Apache-2.0 (see `LICENSE` and `THIRD_PARTY_NOTICES.md`).
