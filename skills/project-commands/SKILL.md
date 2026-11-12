---
name: project-commands
description: Define the commands the Commands plugin can run from the thread header (dev server, tests, storybook…) by writing a .bb-commands.json at the repo root. Use when the user asks to add, change, or fix the project's runnable commands or the Commands button.
---

# Project commands

The Commands plugin reads `.bb-commands.json` at the root of the thread's
workspace and shows its commands in a split button in the thread header.

```json
{
  "commands": [
    { "name": "Start", "command": "pnpm start" },
    { "name": "Test", "command": "pnpm test --watch" }
  ]
}
```

- The first command is the button's main action; the chevron lists all of them.
  The plugin's **Header display** setting (`bb plugin config commands set
  display <auto|plugin|bb>`) picks the plugin's own button (`auto`, the
  default, while bb supports it) or entries in bb's shared header button
  (`bb`, bb 0.49+, after Commit and PR Status).
- `name` must be unique (1–80 characters). `command` runs in the machine's
  shell (`$SHELL` on macOS/Linux), with the workspace root as working directory.
- Commit the file: new worktrees only contain tracked files, like
  `.bb-env-setup.sh`.
- Each launch opens a bb terminal scoped to the thread. Logs show in the
  thread panel's **Commands** tab, and the sidebar marks threads with a running
  command.
