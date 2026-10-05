// bb-plugin-commands — run a project's commands (`pnpm start`, …) from the
// thread header, the way Conductor does.
//
// Commands come from `.bb-commands.json` at the root of the thread's
// workspace. Each launch is a bb terminal scoped to the thread, started in
// command mode so the terminal exits with the command. The plugin keeps one
// record per launch in kv storage, polls the running ones, and publishes
// COMMANDS_CHANGED so the header button, the logs tab, and the sidebar
// indicator stay current.
import { defineRpcContract, type BbPluginApi } from "@get-bb/plugin-sdk";
import { z } from "zod";

export const CONFIG_FILE_NAME = ".bb-commands.json";

/** Realtime channel; the payload is `{ threadId }`. */
export const COMMANDS_CHANGED = "commands-changed";

const commandSchema = z.object({
  name: z.string().trim().min(1).max(80),
  command: z.string().trim().min(1).max(4000),
});
export type CommandDefinition = z.infer<typeof commandSchema>;

const configSchema = z.object({
  commands: z.array(commandSchema).min(1).max(50),
});

const runStatusSchema = z.enum(["starting", "running", "exited", "stopped"]);
export type RunStatus = z.infer<typeof runStatusSchema>;

const runSchema = z.object({
  terminalId: z.string(),
  threadId: z.string(),
  name: z.string(),
  command: z.string(),
  status: runStatusSchema,
  exitCode: z.number().nullable(),
  startedAt: z.number(),
  endedAt: z.number().nullable(),
});
export type CommandRun = z.infer<typeof runSchema>;

const outputChunkSchema = z.object({ seq: z.number(), dataBase64: z.string() });

export const rpcContract = defineRpcContract({
  commands_get: {
    input: z.object({ threadId: z.string().min(1) }),
    output: z.object({
      commands: z.array(commandSchema),
      configError: z.string().nullable(),
      runs: z.array(runSchema),
    }),
  },
  commands_start: {
    input: z.object({ threadId: z.string().min(1), name: z.string().min(1) }),
    output: runSchema,
  },
  commands_stop: {
    input: z.object({ terminalId: z.string().min(1) }),
    output: runSchema,
  },
  commands_dismiss: {
    input: z.object({ terminalId: z.string().min(1) }),
    output: z.object({ removed: z.boolean() }),
  },
  commands_output: {
    input: z.object({
      terminalId: z.string().min(1),
      sinceSeq: z.number().int().nonnegative().nullable(),
    }),
    output: z.object({
      chunks: z.array(outputChunkSchema),
      nextSeq: z.number().nullable(),
      truncated: z.boolean(),
      unavailable: z.boolean(),
    }),
  },
  commands_running_threads: {
    input: z.null(),
    output: z.object({ threadIds: z.array(z.string()) }),
  },
});

const RUNS_KEY = "runs";
const MAX_RUNS_PER_THREAD = 20;
const POLL_INTERVAL_MS = 2_000;
const STOP_GRACE_MS = 3_000;
const INITIAL_OUTPUT_BYTES = 256 * 1024;
const CTRL_C_BASE64 = Buffer.from("\x03").toString("base64");

function isActive(run: CommandRun): boolean {
  return run.status === "starting" || run.status === "running";
}

function errorMessage(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}

function trimSlashes(path: string): string {
  return path.replace(/[\\/]+$/, "");
}

/**
 * `command` run through an interactive login shell, so it sees the same
 * environment as the user's own terminal.
 *
 * A bb terminal in command mode runs `$SHELL -c`, which skips `~/.zshrc`
 * (or `~/.bashrc`): version managers loaded there (nvm, fnm, asdf…) never
 * kick in, and `node` resolves to whatever sits on the bare PATH, which is
 * often not the version the project pins. `-i -l` loads both rc and profile.
 * `exec` hands the PTY to that shell, so Ctrl-C and the exit code still
 * reach the command. Windows shells have no such split: left untouched.
 */
export function inUserShell(command: string, platform = process.platform): string {
  if (platform === "win32") return command;
  const quoted = `'${command.replaceAll("'", `'\\''`)}'`;
  return `exec "\${SHELL:-/bin/sh}" -ilc ${quoted}`;
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener(
      "abort",
      () => {
        clearTimeout(timer);
        resolve();
      },
      { once: true },
    );
  });
}

export default async function plugin(bb: BbPluginApi) {
  // Every read-modify-write of the run list goes through this chain so the
  // poller and RPC handlers never overwrite each other's changes.
  let queue: Promise<unknown> = Promise.resolve();
  function withRuns<T>(update: (runs: CommandRun[]) => Promise<T> | T): Promise<T> {
    const next = queue.then(async () => {
      const stored = (await bb.storage.kv.get<unknown>(RUNS_KEY)) ?? [];
      const parsed = z.array(runSchema).safeParse(stored);
      const runs = parsed.success ? parsed.data : [];
      const before = JSON.stringify(runs);
      const result = await update(runs);
      if (JSON.stringify(runs) !== before) {
        await bb.storage.kv.set(RUNS_KEY, runs);
      }
      return result;
    });
    queue = next.catch(() => undefined);
    return next;
  }

  function publish(threadId: string): void {
    bb.realtime.publish(COMMANDS_CHANGED, { threadId });
  }

  async function workspaceOf(threadId: string) {
    const thread = await bb.sdk.threads.get({ threadId });
    if (thread.environmentId === null) {
      throw new Error("This thread has no workspace yet.");
    }
    const environment = await bb.sdk.environments.get({
      environmentId: thread.environmentId,
    });
    if (environment.path === null) {
      throw new Error("This thread's workspace has no path yet.");
    }
    return {
      hostId: environment.hostId,
      path: environment.path,
      projectId: thread.projectId,
    };
  }

  /** The config file's text in `dir` on `hostId`, or null when it is absent. */
  async function readConfigFile(hostId: string, dir: string): Promise<string | null> {
    try {
      const file = await bb.sdk.files.read({
        hostId,
        path: `${trimSlashes(dir)}/${CONFIG_FILE_NAME}`,
      });
      return file.contentEncoding === "base64"
        ? Buffer.from(file.content, "base64").toString("utf8")
        : file.content;
    } catch {
      return null;
    }
  }

  /**
   * The config from the project's source checkout, for a worktree that has
   * none. A new worktree only holds tracked files, so a `.bb-commands.json`
   * kept out of git (a shared repo where bb config is unwelcome) would never
   * reach it. Commands still run in the worktree; only the list is borrowed.
   */
  async function readSourceConfig(workspace: {
    hostId: string;
    path: string;
    projectId: string;
  }): Promise<string | null> {
    let sources: { hostId: string; path: string; isDefault: boolean }[];
    try {
      sources = (await bb.sdk.projects.get({ projectId: workspace.projectId })).sources;
    } catch {
      return null;
    }
    // Same machine only: the source checkout of another host is not where the
    // worktree lives, and its file may not match what is checked out here.
    const candidates = sources
      .filter((source) => source.hostId === workspace.hostId)
      .filter((source) => trimSlashes(source.path) !== trimSlashes(workspace.path))
      .sort((a, b) => Number(b.isDefault) - Number(a.isDefault));
    for (const source of candidates) {
      const content = await readConfigFile(source.hostId, source.path);
      if (content !== null) return content;
    }
    return null;
  }

  /** Commands for a thread, or a readable reason why there are none. */
  async function readCommands(
    threadId: string,
  ): Promise<{ commands: CommandDefinition[]; configError: string | null }> {
    let workspace: { hostId: string; path: string; projectId: string };
    try {
      workspace = await workspaceOf(threadId);
    } catch (cause) {
      return { commands: [], configError: errorMessage(cause) };
    }
    const content =
      (await readConfigFile(workspace.hostId, workspace.path)) ??
      (await readSourceConfig(workspace));
    if (content === null) {
      return {
        commands: [],
        configError: `No ${CONFIG_FILE_NAME} at the root of this workspace or of the project's source checkout.`,
      };
    }
    let json: unknown;
    try {
      json = JSON.parse(content);
    } catch (cause) {
      return {
        commands: [],
        configError: `${CONFIG_FILE_NAME} is not valid JSON: ${errorMessage(cause)}`,
      };
    }
    const parsed = configSchema.safeParse(json);
    if (!parsed.success) {
      const issue = parsed.error.issues[0];
      const where = issue?.path.length ? ` at ${issue.path.join(".")}` : "";
      return {
        commands: [],
        configError: `${CONFIG_FILE_NAME} is invalid${where}: ${issue?.message ?? "unknown error"}`,
      };
    }
    const seen = new Set<string>();
    for (const command of parsed.data.commands) {
      if (seen.has(command.name)) {
        return {
          commands: [],
          configError: `${CONFIG_FILE_NAME} declares "${command.name}" twice.`,
        };
      }
      seen.add(command.name);
    }
    return { commands: parsed.data.commands, configError: null };
  }

  /**
   * Refresh one active run from its terminal. Returns true when it changed.
   * A terminal bb no longer knows about counts as exited.
   */
  async function refreshRun(run: CommandRun): Promise<boolean> {
    if (!isActive(run)) return false;
    let status: RunStatus;
    let exitCode: number | null = null;
    try {
      const session = await bb.sdk.terminals.get({ terminalId: run.terminalId });
      exitCode = session.exitCode;
      if (session.status === "starting" || session.status === "running") {
        status = session.status;
      } else {
        status = session.closeReason === "user" ? "stopped" : "exited";
      }
    } catch {
      status = "exited";
    }
    if (status === run.status && exitCode === run.exitCode) return false;
    run.status = status;
    run.exitCode = exitCode;
    if (!isActive(run)) run.endedAt ??= Date.now();
    return true;
  }

  async function pollActiveRuns(): Promise<void> {
    const changedThreads = await withRuns(async (runs) => {
      const changed = new Set<string>();
      for (const run of runs) {
        if (await refreshRun(run)) changed.add(run.threadId);
      }
      return changed;
    });
    for (const threadId of changedThreads) publish(threadId);
  }

  async function startCommand(threadId: string, name: string): Promise<CommandRun> {
    const { commands, configError } = await readCommands(threadId);
    const definition = commands.find((command) => command.name === name);
    if (definition === undefined) {
      throw new Error(configError ?? `No command named "${name}".`);
    }
    const run = await withRuns(async (runs) => {
      const running = runs.find(
        (candidate) =>
          candidate.threadId === threadId && candidate.name === name && isActive(candidate),
      );
      if (running !== undefined) {
        throw new Error(`"${name}" is already running in this thread.`);
      }
      const session = await bb.sdk.terminals.create({
        scope: { kind: "thread", threadId },
        start: { mode: "command", command: inUserShell(definition.command) },
        title: `▶ ${definition.name}`,
        cols: 160,
        rows: 40,
      });
      const created: CommandRun = {
        terminalId: session.id,
        threadId,
        name: definition.name,
        command: definition.command,
        status: session.status === "starting" ? "starting" : "running",
        exitCode: null,
        startedAt: Date.now(),
        endedAt: null,
      };
      // A relaunch replaces the finished run of the same command; the list
      // keeps only the most recent runs per thread.
      const kept = runs.filter(
        (candidate) => !(candidate.threadId === threadId && candidate.name === name),
      );
      const forThread = kept.filter((candidate) => candidate.threadId === threadId);
      const overflow = new Set(
        forThread
          .filter((candidate) => !isActive(candidate))
          .slice(0, Math.max(0, forThread.length + 1 - MAX_RUNS_PER_THREAD)),
      );
      runs.splice(0, runs.length, ...kept.filter((candidate) => !overflow.has(candidate)), created);
      return created;
    });
    publish(threadId);
    return run;
  }

  async function findRun(terminalId: string): Promise<CommandRun> {
    const run = await withRuns((runs) =>
      runs.find((candidate) => candidate.terminalId === terminalId),
    );
    if (run === undefined) throw new Error("Unknown command run.");
    return run;
  }

  async function stopCommand(terminalId: string): Promise<CommandRun> {
    const run = await findRun(terminalId);
    const wasActive = isActive(run);
    if (wasActive) {
      // Ctrl-C first so dev servers shut down cleanly; close the terminal if
      // the command ignores it.
      try {
        await bb.sdk.terminals.input({ terminalId, dataBase64: CTRL_C_BASE64 });
      } catch {
        // The terminal may already be gone; the refresh below settles it.
      }
      const deadline = Date.now() + STOP_GRACE_MS;
      while (Date.now() < deadline) {
        await sleep(250);
        const session = await bb.sdk.terminals.get({ terminalId }).catch(() => null);
        if (session === null || (session.status !== "running" && session.status !== "starting")) {
          break;
        }
      }
      await bb.sdk.terminals.close({ terminalId, mode: "force" }).catch(() => undefined);
    }
    const updated = await withRuns(async (runs) => {
      const current = runs.find((candidate) => candidate.terminalId === terminalId);
      if (current === undefined) throw new Error("Unknown command run.");
      await refreshRun(current);
      if (wasActive) {
        // Interrupted by the user, not a crash: show it as stopped.
        current.status = "stopped";
        current.endedAt ??= Date.now();
      }
      return { ...current };
    });
    publish(updated.threadId);
    return updated;
  }

  bb.rpc.register(rpcContract, {
    commands_get: async ({ threadId }) => {
      const [{ commands, configError }, runs] = await Promise.all([
        readCommands(threadId),
        withRuns((all) => all.filter((run) => run.threadId === threadId)),
      ]);
      return { commands, configError, runs };
    },
    commands_start: ({ threadId, name }) => startCommand(threadId, name),
    commands_stop: ({ terminalId }) => stopCommand(terminalId),
    commands_dismiss: async ({ terminalId }) => {
      const removed = await withRuns((runs) => {
        const index = runs.findIndex(
          (run) => run.terminalId === terminalId && !isActive(run),
        );
        if (index === -1) return null;
        return runs.splice(index, 1)[0] ?? null;
      });
      if (removed !== null) publish(removed.threadId);
      return { removed: removed !== null };
    },
    commands_output: async ({ terminalId, sinceSeq }) => {
      try {
        const output = await bb.sdk.terminals.output(
          sinceSeq === null
            ? { terminalId, tailBytes: INITIAL_OUTPUT_BYTES }
            : { terminalId, sinceSeq },
        );
        return {
          chunks: output.chunks,
          nextSeq: output.nextSeq,
          truncated: output.truncated,
          unavailable: false,
        };
      } catch {
        return { chunks: [], nextSeq: null, truncated: false, unavailable: true };
      }
    },
    commands_running_threads: async () => {
      const threadIds = await withRuns((runs) => [
        ...new Set(runs.filter(isActive).map((run) => run.threadId)),
      ]);
      return { threadIds };
    },
  });

  // Commands exit on their own (crash, Ctrl-C in another client, thread
  // archived). Poll only while something is running.
  bb.background.service("run-poller", {
    async start(signal) {
      while (!signal.aborted) {
        try {
          await pollActiveRuns();
        } catch (cause) {
          bb.log.warn(`poll failed: ${errorMessage(cause)}`);
        }
        await sleep(POLL_INTERVAL_MS, signal);
      }
    },
  });
}
