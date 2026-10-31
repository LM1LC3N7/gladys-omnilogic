# Changelog

All notable changes to this integration are documented in this file. The format
follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project
uses [semantic versioning](https://semver.org/).

Describe each change under `## [Unreleased]` as you make it. The Release
workflow moves that section under the version it ships, and the section becomes
the notes of the version's GitHub Release.

## [Unreleased]

### Added

- Hayward OmniLogic pool controllers read over their local protocol (UDP port
  10444, no cloud, no credentials): one device per controller, keyed by its
  bodies of water.
- Air and water temperatures (°F converted exactly to °C), heaters (on / off,
  set point, heating now), filter pumps (on / off, speed, power), pumps,
  relays and ColorLogic lights (on / off), salt, pH and ORP.
- Turning equipment or a heater off never held back (options, reads,
  commands, identity, configuration not read, restart), kept in `/data` until
  seen applied, written again 3 times at most once acked.
- Turning pumps and relays on, lights on, and heating (heater on, set point)
  behind three options, off by default; a spa never above 40 °C, a pool never
  above its ceiling (35 °C by default), on the whole °F written, within the
  heater's limits.
- Turning a heater on (or a filter pump whose heater may heat) refused while
  the set point the controller holds is above the bounds or unreadable.
- A fire pit relay is never turned on; turning it off works.
- "Test the connection" button, docs in English and French.
