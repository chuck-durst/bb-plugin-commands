// The "bb" header display (bb 0.49+): one header thread action per command,
// plus "Show logs". bb draws them as one split button (the first command is its
// main action), so registrations are static slots filled from the thread's
// `.bb-commands.json`, and a slot past the last command hides itself.
import type { CommandDefinition, CommandRun } from "../server";
import type { HeaderThreadAction } from "./bb-compat";

/** Header slots registered for commands; later commands are in the logs panel. */
export const MAX_HEADER_COMMANDS = 8;

export interface ThreadCommandsSnapshot {
  commands: CommandDefinition[];
  configError: string | null;
  runs: CommandRun[];
}

export interface HeaderActionHandlers {
  /** Starts the command, or stops its active run. */
  toggle(name: string): Promise<void>;
  openLogs(): void;
  /** True while a start or stop for this thread is in flight. */
  pending: boolean;
}

export function isActive(run: CommandRun): boolean {
  return run.status === "starting" || run.status === "running";
}

export function activeRunFor(runs: readonly CommandRun[], name: string): CommandRun | undefined {
  return runs.find((run) => run.name === name && isActive(run));
}

export function commandHeaderAction(
  snapshot: ThreadCommandsSnapshot | undefined,
  index: number,
  handlers: HeaderActionHandlers,
): HeaderThreadAction | null {
  const command = snapshot?.commands[index];
  if (snapshot === undefined || command === undefined) return null;
  const active = activeRunFor(snapshot.runs, command.name) !== undefined;
  return {
    label: active ? `Stop ${command.name}` : command.name,
    detail: command.command,
    icon: active ? "Square" : "Play",
    variant: active ? "destructive" : "default",
    disabled: handlers.pending,
    run: () => handlers.toggle(command.name),
  };
}

export function logsHeaderAction(
  snapshot: ThreadCommandsSnapshot | undefined,
  handlers: HeaderActionHandlers,
): HeaderThreadAction | null {
  if (snapshot === undefined) return null;
  if (snapshot.commands.length > 0) {
    return { label: "Show logs", icon: "ScrollText", run: handlers.openLogs };
  }
  // A thread without a config shows nothing; a broken config says why.
  if (snapshot.configError === null) return null;
  return {
    label: "Commands",
    detail: snapshot.configError,
    icon: "TriangleAlert",
    run: handlers.openLogs,
  };
}
