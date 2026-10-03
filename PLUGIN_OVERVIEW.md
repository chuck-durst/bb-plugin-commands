Run your project's commands — dev server, tests, storybook — from the thread
header, and follow their logs without leaving the thread.

## What you get

- A split button in the thread header: one click runs the project's main
  command, the menu lists the others. While a command runs, the button stops it.
- A **Commands** tab in the thread panel with each run's status and live,
  colored logs.
- An indicator in the sidebar on every thread with a running command.

## How it works

Commands are defined per repository in a `.bb-commands.json` file at the repo
root. Each launch runs in a bb terminal attached to the thread, in the thread's
workspace. Nothing leaves the machine.
