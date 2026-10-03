// bb-plugin-commands — frontend.
//
// - Thread header: a split button. The left half runs (or stops) the first
//   command of `.bb-commands.json`; the chevron lists every command.
// - Thread panel tab "Commands": run list + read-only, colored logs.
// - Sidebar: a running indicator on threads with an active command. Row
//   statuses can only be set from a content script, which has no hooks, so an
//   invisible app overlay fetches the running threads and hands them over.
import { memo, useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { CSSProperties } from "react";
import {
  definePluginApp,
  useBbNavigate,
  useRealtime,
  useRealtimeConnectionState,
  useRpc,
  useSdk,
  type PluginComposerThreadRowStatus,
  type PluginRpcClient,
  type PluginThreadHeaderActionProps,
  type PluginThreadPanelProps,
} from "@get-bb/plugin-sdk/app";
import type { CommandDefinition, CommandRun, rpcContract } from "./server";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Icon } from "@/components/ui/icon";
import { AnsiLog, lineSegments, type LogLine } from "@/lib/ansi";
import { cn } from "@/lib/utils";

// Duplicated from server.ts: importing values from it would bundle the
// backend into the app.
const COMMANDS_CHANGED = "commands-changed";
const CONFIG_FILE_NAME = ".bb-commands.json";
const LOGS_PANEL_ID = "logs";

function isActive(run: CommandRun): boolean {
  return run.status === "starting" || run.status === "running";
}

function errorMessage(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}

function changedThreadId(payload: unknown): string | null {
  if (typeof payload !== "object" || payload === null) return null;
  const threadId = (payload as { threadId?: unknown }).threadId;
  return typeof threadId === "string" ? threadId : null;
}

/** Commands and runs of one thread, refreshed by the server's signal. */
function useThreadCommands(threadId: string) {
  const rpc = useRpc<typeof rpcContract>();
  const [commands, setCommands] = useState<CommandDefinition[] | null>(null);
  const [configError, setConfigError] = useState<string | null>(null);
  const [runs, setRuns] = useState<CommandRun[]>([]);
  const [error, setError] = useState<string | null>(null);

  const refetch = useCallback(() => {
    rpc.call("commands_get", { threadId }).then(
      (result) => {
        setCommands(result.commands);
        setConfigError(result.configError);
        setRuns(result.runs);
      },
      (cause) => setError(errorMessage(cause)),
    );
  }, [rpc, threadId]);

  useEffect(() => {
    refetch();
  }, [refetch]);
  useRealtime(COMMANDS_CHANGED, (payload) => {
    if (changedThreadId(payload) === threadId) refetch();
  });
  const connection = useRealtimeConnectionState();
  useEffect(() => {
    if (connection === "connected") refetch();
  }, [connection, refetch]);

  // A new thread mounts this header before bb has provisioned its workspace,
  // so the first read finds no config and nothing else would ever ask again:
  // COMMANDS_CHANGED only fires for runs. While the list is empty, re-read on
  // thread and environment changes, which is when the workspace appears.
  // Unsubscribed once commands load, so a busy thread does not re-read the
  // file on every message.
  const sdk = useSdk();
  const waitingForConfig = commands === null || commands.length === 0;
  useEffect(() => {
    if (!waitingForConfig) return;
    const unsubscribeThread = sdk.subscribe({
      event: "thread:changed",
      threadId,
      callback: refetch,
    });
    const unsubscribeEnvironment = sdk.subscribe({
      event: "environment:changed",
      callback: refetch,
    });
    return () => {
      unsubscribeThread();
      unsubscribeEnvironment();
    };
  }, [sdk, threadId, waitingForConfig, refetch]);

  const start = useCallback(
    async (name: string) => {
      setError(null);
      try {
        await rpc.call("commands_start", { threadId, name });
      } catch (cause) {
        setError(errorMessage(cause));
      }
      refetch();
    },
    [rpc, threadId, refetch],
  );
  const stop = useCallback(
    async (terminalId: string) => {
      setError(null);
      try {
        await rpc.call("commands_stop", { terminalId });
      } catch (cause) {
        setError(errorMessage(cause));
      }
      refetch();
    },
    [rpc, refetch],
  );
  const dismiss = useCallback(
    async (terminalId: string) => {
      await rpc.call("commands_dismiss", { terminalId }).catch(() => undefined);
      refetch();
    },
    [rpc, refetch],
  );

  return { rpc, commands, configError, runs, error, setError, start, stop, dismiss };
}

// ---------------------------------------------------------------------------
// Thread header split button
// ---------------------------------------------------------------------------

function CommandsHeaderAction({ threadId, isCompactViewport }: PluginThreadHeaderActionProps) {
  const { commands, configError, runs, error, setError, start, stop } =
    useThreadCommands(threadId);
  const navigate = useBbNavigate();
  const [pending, setPending] = useState(false);

  const openLogs = useCallback(() => {
    navigate.openThreadPanel({ actionId: LOGS_PANEL_ID, title: "Commands" });
  }, [navigate]);

  const activeRunFor = useCallback(
    (name: string) => runs.find((run) => run.name === name && isActive(run)),
    [runs],
  );

  const toggle = useCallback(
    async (name: string) => {
      if (pending) return;
      setPending(true);
      try {
        const active = activeRunFor(name);
        if (active !== undefined) {
          await stop(active.terminalId);
        } else {
          await start(name);
          openLogs();
        }
      } finally {
        setPending(false);
      }
    },
    [pending, activeRunFor, start, stop, openLogs],
  );

  if (commands === null) return null;

  const primary = commands[0];
  const primaryRun = primary === undefined ? undefined : activeRunFor(primary.name);
  const anyActive = runs.some(isActive);
  const primaryLabel =
    primary === undefined
      ? "Commands"
      : primaryRun !== undefined
        ? `Stop ${primary.name}`
        : primary.name;
  const primaryTitle =
    primary === undefined
      ? (configError ?? `Add a ${CONFIG_FILE_NAME} file to define commands.`)
      : primaryRun !== undefined
        ? `Stop "${primary.command}"`
        : `Run "${primary.command}"`;

  return (
    <div className="flex h-7 items-center">
      <span title={primaryTitle} className="flex">
        <Button
          variant="ghost"
          size="sm"
          className={cn(
            "h-7 gap-1.5 rounded-r-none border border-r-0 border-border px-2",
            primaryRun !== undefined && "text-destructive hover:text-destructive",
          )}
          disabled={primary === undefined || pending}
          aria-label={primaryLabel}
          onClick={() => {
            if (primary !== undefined) void toggle(primary.name);
          }}
        >
          <Icon
            name={primaryRun !== undefined ? "Square" : "Play"}
            className="size-3.5"
          />
          {isCompactViewport ? null : (
            <span className="max-w-32 truncate">{primaryLabel}</span>
          )}
        </Button>
      </span>
      <DropdownMenu onOpenChange={(open) => open && setError(null)}>
        <DropdownMenuTrigger asChild>
          <Button
            variant="ghost"
            size="sm"
            className="relative h-7 w-6 rounded-l-none border border-border px-0"
            aria-label="More commands"
          >
            <Icon name="ChevronDown" className="size-3.5" />
            {anyActive ? (
              <span
                aria-hidden
                className="absolute right-0.5 top-0.5 size-1.5 animate-pulse rounded-full bg-green-500"
              />
            ) : null}
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" className="min-w-56" mobileTitle="Commands">
          {commands.length === 0 ? (
            <DropdownMenuLabel className="max-w-72 whitespace-normal font-normal text-muted-foreground">
              {configError ?? `Add a ${CONFIG_FILE_NAME} file to define commands.`}
            </DropdownMenuLabel>
          ) : (
            commands.map((command) => {
              const active = activeRunFor(command.name);
              return (
                <DropdownMenuItem
                  key={command.name}
                  disabled={pending}
                  onSelect={() => void toggle(command.name)}
                >
                  <Icon
                    name={active !== undefined ? "Square" : "Play"}
                    className={cn("size-3.5", active !== undefined && "text-destructive")}
                  />
                  <span className="flex min-w-0 flex-1 flex-col gap-0.5">
                    <span className="truncate">
                      {active !== undefined ? `Stop ${command.name}` : command.name}
                    </span>
                    {/* The item is already text-xs, so the command needs an
                        explicit smaller size to read as secondary. The width
                        cap keeps one long command from stretching the menu;
                        the title shows it whole on hover. */}
                    <span
                      title={command.command}
                      className="max-w-72 truncate font-mono text-[10px] leading-tight text-muted-foreground"
                    >
                      {command.command}
                    </span>
                  </span>
                  {active !== undefined ? (
                    <span aria-hidden className="size-1.5 animate-pulse rounded-full bg-green-500" />
                  ) : null}
                </DropdownMenuItem>
              );
            })
          )}
          <DropdownMenuSeparator />
          <DropdownMenuItem onSelect={openLogs}>
            <Icon name="ScrollText" className="size-3.5" />
            Show logs
          </DropdownMenuItem>
          {error !== null ? (
            <DropdownMenuLabel className="max-w-72 whitespace-normal font-normal text-destructive">
              {error}
            </DropdownMenuLabel>
          ) : null}
        </DropdownMenuContent>
      </DropdownMenu>
      {error !== null ? (
        <span role="alert" className="ml-1 text-destructive" title={error}>
          <Icon name="TriangleAlert" className="size-3.5" />
        </span>
      ) : null}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Logs panel
// ---------------------------------------------------------------------------

function decodeBase64(data: string): Uint8Array {
  const binary = atob(data);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

/** Streams one terminal's output into an AnsiLog while the run is active. */
function useRunLog(
  rpc: PluginRpcClient<typeof rpcContract>,
  run: CommandRun | undefined,
) {
  const [log, setLog] = useState<{ lines: LogLine[]; tick: number; unavailable: boolean }>({
    lines: [],
    tick: 0,
    unavailable: false,
  });
  const terminalId = run?.terminalId;
  const active = run !== undefined && isActive(run);

  // Parser state lives per terminal so switching runs starts fresh.
  const stateRef = useRef<{
    terminalId: string;
    parser: AnsiLog;
    decoder: TextDecoder;
    nextSeq: number | null;
    done: boolean;
  } | null>(null);

  useEffect(() => {
    if (terminalId === undefined) {
      stateRef.current = null;
      setLog({ lines: [], tick: 0, unavailable: false });
      return;
    }
    if (stateRef.current?.terminalId !== terminalId) {
      stateRef.current = {
        terminalId,
        parser: new AnsiLog(),
        decoder: new TextDecoder(),
        nextSeq: null,
        done: false,
      };
      setLog({ lines: [], tick: 0, unavailable: false });
    }
    const state = stateRef.current;
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;

    const pull = async () => {
      try {
        const output = await rpc.call("commands_output", {
          terminalId,
          sinceSeq: state.nextSeq,
        });
        if (cancelled) return;
        if (output.unavailable) {
          state.done = true;
          setLog((prev) => ({ ...prev, unavailable: prev.lines.length <= 1 }));
          return;
        }
        for (const chunk of output.chunks) {
          state.parser.write(state.decoder.decode(decodeBase64(chunk.dataBase64), { stream: true }));
        }
        if (output.nextSeq !== null) state.nextSeq = output.nextSeq;
        if (output.chunks.length > 0) {
          setLog((prev) => ({
            lines: [...state.parser.lines],
            tick: prev.tick + 1,
            unavailable: false,
          }));
        }
      } catch {
        // Retried on the next tick.
      }
      if (!cancelled && active) timer = setTimeout(pull, 700);
    };
    // One final read after the run ends picks up its last lines.
    if (!state.done) void pull();
    if (!active) state.done = true;

    return () => {
      cancelled = true;
      if (timer !== undefined) clearTimeout(timer);
    };
  }, [rpc, terminalId, active]);

  return log;
}

const COLOR_STYLE_CACHE = new WeakMap<object, CSSProperties>();

const LogLineView = memo(
  function LogLineView({ line }: { line: LogLine; version: number }) {
    const segments = lineSegments(line);
    if (segments.length === 0) return <div className="min-h-[1.25em]">{"​"}</div>;
    return (
      <div className="min-h-[1.25em] whitespace-pre-wrap break-all">
        {segments.map((segment, index) => {
          let style = COLOR_STYLE_CACHE.get(segment.style);
          if (style === undefined) {
            const { fg, bg, bold, dim, italic, underline, inverse } = segment.style;
            style = {
              color: (inverse ? bg : fg) ?? (inverse ? "var(--background)" : undefined),
              backgroundColor: (inverse ? (fg ?? "var(--foreground)") : bg) ?? undefined,
              fontWeight: bold ? 600 : undefined,
              opacity: dim ? 0.7 : undefined,
              fontStyle: italic ? "italic" : undefined,
              textDecoration: underline ? "underline" : undefined,
            };
            COLOR_STYLE_CACHE.set(segment.style, style);
          }
          return (
            <span key={index} style={style}>
              {segment.text}
            </span>
          );
        })}
      </div>
    );
  },
  (prev, next) => prev.line === next.line && prev.version === next.version,
);

function StatusDot({ run }: { run: CommandRun }) {
  return (
    <span
      aria-hidden
      className={cn(
        "size-2 shrink-0 rounded-full",
        isActive(run)
          ? "animate-pulse bg-green-500"
          : run.status === "stopped"
            ? "bg-muted-foreground"
            : run.exitCode === 0
              ? "bg-blue-500"
              : "bg-destructive",
      )}
    />
  );
}

function statusText(run: CommandRun): string {
  if (run.status === "starting") return "Starting…";
  if (run.status === "running") return "Running";
  if (run.status === "stopped") return "Stopped";
  return run.exitCode === null ? "Exited" : `Exited with code ${run.exitCode}`;
}

function CommandsLogsPanel({ threadId }: PluginThreadPanelProps) {
  const { rpc, commands, configError, runs, error, start, stop, dismiss } =
    useThreadCommands(threadId);
  const [selectedId, setSelectedId] = useState<string | null>(null);

  // Follow the newest run: select it when a new one appears.
  const newest = useMemo(
    () => [...runs].sort((a, b) => b.startedAt - a.startedAt)[0],
    [runs],
  );
  const lastNewestRef = useRef<string | null>(null);
  useEffect(() => {
    const newestId = newest?.terminalId ?? null;
    if (newestId !== lastNewestRef.current) {
      lastNewestRef.current = newestId;
      if (newestId !== null) setSelectedId(newestId);
    }
  }, [newest]);

  const selected =
    runs.find((run) => run.terminalId === selectedId) ?? newest ?? undefined;
  const log = useRunLog(rpc, selected);

  // Stick to the bottom unless the user scrolled up.
  const scrollRef = useRef<HTMLDivElement>(null);
  const stickRef = useRef(true);
  useEffect(() => {
    const element = scrollRef.current;
    if (element !== null && stickRef.current) element.scrollTop = element.scrollHeight;
  }, [log.tick, selected?.terminalId]);

  const runnable = (commands ?? []).filter(
    (command) => !runs.some((run) => run.name === command.name && isActive(run)),
  );

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex flex-wrap items-center gap-1.5 border-b border-border px-3 py-2">
        {runs.length === 0 ? (
          <span className="text-sm text-muted-foreground">
            {commands !== null && commands.length === 0
              ? (configError ?? `Add a ${CONFIG_FILE_NAME} file to define commands.`)
              : "No command has run in this thread yet."}
          </span>
        ) : (
          runs.map((run) => (
            <button
              key={run.terminalId}
              type="button"
              onClick={() => {
                setSelectedId(run.terminalId);
                stickRef.current = true;
              }}
              className={cn(
                "flex h-7 items-center gap-1.5 rounded-md border px-2 text-xs",
                run.terminalId === selected?.terminalId
                  ? "border-border bg-state-active text-foreground"
                  : "border-transparent text-muted-foreground hover:bg-state-hover",
              )}
            >
              <StatusDot run={run} />
              {run.name}
            </button>
          ))
        )}
        {runnable.length > 0 ? (
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button variant="ghost" size="sm" className="ml-auto h-7 gap-1 px-2 text-xs">
                <Icon name="Play" className="size-3.5" />
                Run
                <Icon name="ChevronDown" className="size-3" />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" mobileTitle="Run a command">
              {runnable.map((command) => (
                <DropdownMenuItem key={command.name} onSelect={() => void start(command.name)}>
                  <span className="flex min-w-0 flex-col">
                    <span className="truncate">{command.name}</span>
                    <span className="truncate font-mono text-xs text-muted-foreground">
                      {command.command}
                    </span>
                  </span>
                </DropdownMenuItem>
              ))}
            </DropdownMenuContent>
          </DropdownMenu>
        ) : null}
      </div>

      {selected !== undefined ? (
        <div className="flex items-center gap-2 border-b border-border px-3 py-1.5 text-xs">
          <StatusDot run={selected} />
          <span className="text-muted-foreground">{statusText(selected)}</span>
          <code className="min-w-0 flex-1 truncate font-mono text-muted-foreground" title={selected.command}>
            $ {selected.command}
          </code>
          {isActive(selected) ? (
            <Button
              variant="ghost"
              size="sm"
              className="h-6 gap-1 px-2 text-xs text-destructive hover:text-destructive"
              onClick={() => void stop(selected.terminalId)}
            >
              <Icon name="Square" className="size-3" />
              Stop
            </Button>
          ) : (
            <>
              <Button
                variant="ghost"
                size="sm"
                className="h-6 gap-1 px-2 text-xs"
                disabled={!commands?.some((command) => command.name === selected.name)}
                onClick={() => void start(selected.name)}
              >
                <Icon name="RotateCcw" className="size-3" />
                Restart
              </Button>
              <Button
                variant="ghost"
                size="sm"
                className="h-6 px-2 text-xs"
                aria-label="Remove from list"
                onClick={() => void dismiss(selected.terminalId)}
              >
                <Icon name="X" className="size-3" />
              </Button>
            </>
          )}
        </div>
      ) : null}

      {error !== null ? (
        <p role="alert" className="border-b border-border px-3 py-1.5 text-xs text-destructive">
          {error}
        </p>
      ) : null}

      <div
        ref={scrollRef}
        onScroll={(event) => {
          const element = event.currentTarget;
          stickRef.current =
            element.scrollHeight - element.scrollTop - element.clientHeight < 24;
        }}
        className="min-h-0 flex-1 overflow-auto px-3 py-2 font-mono text-xs leading-5"
      >
        {selected === undefined ? null : log.unavailable ? (
          <p className="text-muted-foreground">The output of this run is no longer available.</p>
        ) : (
          log.lines.map((line) => <LogLineView key={line.id} line={line} version={line.version} />)
        )}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Sidebar running indicator
// ---------------------------------------------------------------------------

type RowStatusSetter = (threadId: string, status: PluginComposerThreadRowStatus | null) => void;

const RUNNING_STATUS: PluginComposerThreadRowStatus = {
  icon: "Play",
  label: "A command is running",
  tone: "running",
};

/** Bridges the hook-based overlay to the content script's row setter. */
const rowStatusBridge = {
  setter: null as RowStatusSetter | null,
  wanted: new Set<string>(),
  applied: new Set<string>(),
  sync() {
    const setter = this.setter;
    if (setter === null) return;
    for (const threadId of this.applied) {
      if (!this.wanted.has(threadId)) setter(threadId, null);
    }
    for (const threadId of this.wanted) {
      if (!this.applied.has(threadId)) setter(threadId, RUNNING_STATUS);
    }
    this.applied = new Set(this.wanted);
  },
};

function RunningThreadsSync() {
  const rpc = useRpc<typeof rpcContract>();
  const refetch = useCallback(() => {
    rpc.call("commands_running_threads", null).then(
      ({ threadIds }) => {
        rowStatusBridge.wanted = new Set(threadIds);
        rowStatusBridge.sync();
      },
      () => undefined,
    );
  }, [rpc]);
  useEffect(() => {
    refetch();
  }, [refetch]);
  useRealtime(COMMANDS_CHANGED, refetch);
  const connection = useRealtimeConnectionState();
  useEffect(() => {
    if (connection === "connected") refetch();
  }, [connection, refetch]);
  return null;
}

export default definePluginApp((app) => {
  app.slots.experimental_threadHeaderAction({
    id: "run-command",
    title: "Commands",
    component: CommandsHeaderAction,
  });

  app.slots.threadPanelAction({
    id: LOGS_PANEL_ID,
    title: "Commands",
    icon: "SquareTerminal",
    layout: "flush",
    component: CommandsLogsPanel,
  });

  app.contentScripts.register({
    id: "running-indicator",
    mount(context) {
      const setter = context.experimental_setThreadRowStatus;
      if (setter === undefined) return;
      rowStatusBridge.setter = setter;
      rowStatusBridge.applied = new Set();
      rowStatusBridge.sync();
      return () => {
        // The host clears this generation's statuses itself.
        rowStatusBridge.setter = null;
        rowStatusBridge.applied = new Set();
      };
    },
  });

  app.slots.experimental_appOverlay({
    id: "running-sync",
    component: RunningThreadsSync,
  });
});
