import { describe, expect, it, vi } from "vitest";
import type { CommandRun } from "../server";
import {
  commandHeaderAction,
  logsHeaderAction,
  type HeaderActionHandlers,
  type ThreadCommandsSnapshot,
} from "./header-actions";

const snapshot = (overrides: Partial<ThreadCommandsSnapshot> = {}): ThreadCommandsSnapshot => ({
  commands: [
    { name: "start", command: "pnpm start" },
    { name: "test", command: "pnpm test" },
  ],
  configError: null,
  runs: [],
  ...overrides,
});

const run = (name: string, status: CommandRun["status"]) =>
  ({ name, status, terminalId: `term-${name}` }) as CommandRun;

function handlers(pending = false): HeaderActionHandlers {
  return { pending, toggle: vi.fn(async () => undefined), openLogs: vi.fn() };
}

describe("commandHeaderAction", () => {
  it("runs the command of its slot", async () => {
    const h = handlers();
    const action = commandHeaderAction(snapshot(), 1, h);
    expect(action).toMatchObject({ label: "test", detail: "pnpm test", icon: "Play", variant: "default" });
    await action?.run({});
    expect(h.toggle).toHaveBeenCalledWith("test");
  });

  it("offers Stop while the command runs", () => {
    const action = commandHeaderAction(snapshot({ runs: [run("start", "running")] }), 0, handlers());
    expect(action).toMatchObject({ label: "Stop start", icon: "Square", variant: "destructive" });
  });

  it("ignores finished runs", () => {
    const action = commandHeaderAction(snapshot({ runs: [run("start", "exited")] }), 0, handlers());
    expect(action?.label).toBe("start");
  });

  it("hides slots past the last command and before the first read", () => {
    expect(commandHeaderAction(snapshot(), 2, handlers())).toBeNull();
    expect(commandHeaderAction(undefined, 0, handlers())).toBeNull();
  });

  it("is disabled while a start or stop is in flight", () => {
    expect(commandHeaderAction(snapshot(), 0, handlers(true))?.disabled).toBe(true);
  });
});

describe("logsHeaderAction", () => {
  it("opens the logs when the thread has commands", () => {
    const h = handlers();
    const action = logsHeaderAction(snapshot(), h);
    expect(action?.label).toBe("Show logs");
    void action?.run({});
    expect(h.openLogs).toHaveBeenCalled();
  });

  it("shows nothing without a config", () => {
    expect(logsHeaderAction(snapshot({ commands: [] }), handlers())).toBeNull();
  });

  it("explains a broken config", () => {
    const action = logsHeaderAction(
      snapshot({ commands: [], configError: "Invalid .bb-commands.json" }),
      handlers(),
    );
    expect(action).toMatchObject({ label: "Commands", detail: "Invalid .bb-commands.json", icon: "TriangleAlert" });
  });
});
