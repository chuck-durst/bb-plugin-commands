# bb-plugin-commands

Run a project's commands (`pnpm start`, `pnpm test --watch`, …) from the
thread header, like Conductor.

## Install

```
bb plugin install git:https://github.com/chuck-durst/bb-plugin-commands.git@^0.1.0
```

Requires bb 0.45+ and Plugin SDK 0.6.15+.

## Configure

Commit a `.bb-commands.json` at the repo root:

```json
{
  "commands": [
    { "name": "Start", "command": "pnpm start" },
    { "name": "Storybook", "command": "pnpm storybook" }
  ]
}
```

The file is read from the thread's workspace, so every branch or worktree can
have its own commands.

A new worktree only contains tracked files. When a worktree has no
`.bb-commands.json`, the plugin falls back to the one in the project's source
checkout (same machine). So in a shared repo where bb config is unwelcome, you
can keep the file untracked in your main checkout (add it to
`.git/info/exclude`) and every worktree still gets the commands. Commands
always run in the thread's own workspace.

## Use

- **Thread header**: the left button runs the first command (and turns into
  *Stop* while it runs); the chevron lists every command and *Show logs*.
- **Commands tab** (thread right panel): one entry per run with its status,
  read-only colored logs, Stop / Restart / remove.
- **Sidebar**: threads with a running command show an animated indicator.

Each run is a bb terminal scoped to the thread (`bb terminal list --thread
<id>`), started in command mode so it exits with the command. Stop sends
Ctrl-C, then closes the terminal after 3 seconds.

## Develop

```
npm install --include=dev
bb plugin build .
bb plugin install .      # or: bb plugin dev .
```

- `server.ts` — reads the config, starts/stops terminals, tracks runs in
  `bb.storage.kv`, polls running ones, publishes `commands-changed`.
- `app.tsx` — header split button, logs panel, sidebar indicator.
- `lib/ansi.ts` — incremental ANSI parser for the logs view.
