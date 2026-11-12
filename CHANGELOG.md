# Changelog

All notable changes to this project are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the project
adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

- **Header display** setting (`display`): `auto` (default) keeps the
  plugin's own split button and logs panel while bb supports them and
  switches to bb's shared header button once bb drops them; `plugin` forces
  the plugin's own button; `bb` uses entries in bb's shared header split
  button (bb 0.49+): each command (up to eight) and *Show logs*, after Commit
  and PR Status. A display this bb cannot draw falls back to the other one,
  and the plugin log says so. The setting applies without a reload.
- Unit tests (`npm test`) for the slot detection, the three setting values
  and their fallbacks, the registrations on bb 0.46, 0.49 and a bb without
  the retired slots, the header entries, and a check that the bundled
  sources use none of the retired names the 0.49 build warns about.

### Changed

- Works on bb 0.49 without retirement warnings: the plugin detects at
  runtime which slots this bb has (no version check) and reads the retired
  ones (`experimental_threadHeaderAction`, `threadPanelAction`,
  `openThreadPanel`) only while bb still has them. The logs panel uses the
  `threadPanelAction` slot while bb has it, else an `experimental_tab`. One
  build serves bb 0.45 to 0.49, and the minimum bb version is unchanged.

### Fixed

- Commands run through an interactive login shell, so they see the same
  `PATH` (nvm, pnpm…) as the user's terminal.
- oh-my-zsh no longer asks "Would you like to update?" at the top of the
  logs: commands run with `DISABLE_AUTO_UPDATE=true`. The shell is unchanged.

## [0.1.1] - 2026-10-04

### Added

- Rows held by a running command are published for the PR Status plugin.

## [0.1.0] - 2026-10-03

### Added

- First release: run the commands of `.bb-commands.json` from the thread
  header, with live logs and a sidebar running indicator.
