# bb-plugin-commands

Run a project's commands (`pnpm start`, `pnpm test --watch`, …) from the
thread header, like Conductor.

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
have its own commands. Like `.bb-env-setup.sh`, it must be tracked by git to
exist in new worktrees.

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
