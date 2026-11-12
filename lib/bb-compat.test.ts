import { readFileSync, readdirSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import {
  detectCapabilities,
  openLegacyLogsPanel,
  openLogsTab,
  parseDisplaySetting,
  registerThreadUi,
  resolveDisplay,
  type HeaderThreadActionRegistration,
  type PanelController,
  type ThreadUiCapabilities,
  type ThreadUiRegistrations,
} from "./bb-compat";

function LogsPanel() {
  return null;
}
function PluginHeader() {
  return null;
}

const headerAction: HeaderThreadActionRegistration<undefined> = {
  id: "run-command-0",
  title: "Run first command",
  icon: "Play",
  group: "run-commands",
  placement: "header",
  item: () => null,
};

const registrations: ThreadUiRegistrations<undefined> = {
  pluginHeader: { id: "run-command", title: "Commands", component: PluginHeader },
  bbHeader: [headerAction],
  logsTab: { id: "logs", title: "Commands", icon: "SquareTerminal", layout: "flush", component: LogsPanel },
};

const noop = () => undefined;

/** The slots of a bb, recording what was registered where. */
function fakeSlots(names: string[]) {
  const calls: Array<{ slot: string; registration: Record<string, unknown> }> = [];
  const slots: Record<string, unknown> = {};
  for (const name of names) {
    slots[name] = function (this: unknown, registration: Record<string, unknown>) {
      expect(this).toBe(slots);
      calls.push({ slot: name, registration });
    };
  }
  return { slots, calls };
}

// What each bb exposes, from its SDK's app collector.
const BB_046 = {
  slots: ["experimental_threadHeaderAction", "threadPanelAction", "experimental_threadAction"],
  sdkApp: { definePluginApp: noop, experimental_useAppPanel: noop },
};
const BB_049 = {
  slots: [
    "experimental_threadHeaderAction",
    "threadPanelAction",
    "experimental_threadAction",
    "experimental_tab",
  ],
  sdkApp: { definePluginApp: noop, experimental_ThreadRowMetadata: noop },
};
/** A future bb that dropped the retired slots. */
const BB_NEXT = {
  slots: ["experimental_threadAction", "experimental_tab"],
  sdkApp: { definePluginApp: noop, experimental_ThreadRowMetadata: noop },
};

function capabilitiesOf(bb: { slots: string[]; sdkApp: object }): ThreadUiCapabilities {
  return detectCapabilities(fakeSlots(bb.slots).slots, bb.sdkApp);
}

describe("detectCapabilities", () => {
  it("bb 0.46: the plugin's header and panel, no header thread actions", () => {
    expect(capabilitiesOf(BB_046)).toEqual({ pluginHeader: true, bbHeader: false, legacyPanel: true });
  });

  it("bb 0.49: both headers, and the legacy panel slot it still accepts", () => {
    expect(capabilitiesOf(BB_049)).toEqual({ pluginHeader: true, bbHeader: true, legacyPanel: true });
  });

  it("a bb without the retired slots: only bb's header and the tab", () => {
    expect(capabilitiesOf(BB_NEXT)).toEqual({ pluginHeader: false, bbHeader: true, legacyPanel: false });
  });

  it("experimental_threadAction alone does not mean header placement (SDK < 0.6.94)", () => {
    const slots = fakeSlots(["experimental_threadAction", "experimental_tab"]).slots;
    expect(detectCapabilities(slots, { experimental_useAppPanel: noop }).bbHeader).toBe(false);
  });
});

describe("parseDisplaySetting", () => {
  it.each(["auto", "plugin", "bb"] as const)("keeps %s", (value) => {
    expect(parseDisplaySetting(value)).toBe(value);
  });

  it.each([undefined, null, "", "Plugin", 3])("reads %s as auto", (value) => {
    expect(parseDisplaySetting(value)).toBe("auto");
  });
});

describe("resolveDisplay", () => {
  const cases = [
    // setting, bb, display, fallbackFrom
    ["auto", BB_046, "plugin", null],
    ["auto", BB_049, "plugin", null],
    ["auto", BB_NEXT, "bb", null],
    ["plugin", BB_046, "plugin", null],
    ["plugin", BB_049, "plugin", null],
    ["plugin", BB_NEXT, "bb", "plugin"],
    ["bb", BB_046, "plugin", "bb"],
    ["bb", BB_049, "bb", null],
    ["bb", BB_NEXT, "bb", null],
  ] as const;

  it.each(cases)("%s on %#", (setting, bb, display, fallbackFrom) => {
    expect(resolveDisplay(setting, capabilitiesOf(bb))).toEqual({ display, fallbackFrom });
  });

  it("does not report a fallback when neither display exists", () => {
    const none = { pluginHeader: false, bbHeader: false, legacyPanel: false };
    expect(resolveDisplay("bb", none)).toEqual({ display: "bb", fallbackFrom: null });
    expect(resolveDisplay("plugin", none)).toEqual({ display: "plugin", fallbackFrom: null });
  });
});

describe("registerThreadUi", () => {
  it("bb 0.46: the plugin's header component and the thread panel action", () => {
    const { slots, calls } = fakeSlots(BB_046.slots);
    registerThreadUi(capabilitiesOf(BB_046), slots, registrations);
    expect(calls.map((call) => call.slot)).toEqual([
      "experimental_threadHeaderAction",
      "threadPanelAction",
    ]);
    expect(calls[0]?.registration).toBe(registrations.pluginHeader);
    expect(calls[1]?.registration).toBe(registrations.logsTab);
  });

  it("bb 0.49: both header displays (the setting picks one at render) and the panel slot", () => {
    const { slots, calls } = fakeSlots(BB_049.slots);
    registerThreadUi(capabilitiesOf(BB_049), slots, registrations);
    expect(calls.map((call) => call.slot)).toEqual([
      "experimental_threadHeaderAction",
      "experimental_threadAction",
      "threadPanelAction",
    ]);
    expect(calls[1]?.registration).toBe(headerAction);
  });

  it("without the retired slots: header thread actions and a thread action tab", () => {
    const { slots, calls } = fakeSlots(BB_NEXT.slots);
    registerThreadUi(capabilitiesOf(BB_NEXT), slots, registrations);
    expect(calls.map((call) => call.slot)).toEqual(["experimental_threadAction", "experimental_tab"]);
    expect(calls[1]?.registration).toMatchObject({
      id: "logs",
      title: "Commands",
      icon: "SquareTerminal",
      layout: "flush",
      component: LogsPanel,
      context: { kind: "thread" },
      availability: "action",
    });
  });

  it("the tab's launcher opens the logs tab", () => {
    const { slots, calls } = fakeSlots(BB_NEXT.slots);
    registerThreadUi(capabilitiesOf(BB_NEXT), slots, registrations);
    const run = calls[1]?.registration.run as (context: { experimental_panel: PanelController }) => void;
    const openTab = vi.fn(() => true);
    run({ experimental_panel: { openTab } });
    expect(openTab).toHaveBeenCalledWith({
      tab: { id: "logs", context: { kind: "thread" }, availability: "action" },
      title: "Commands",
    });
  });
});

describe("opening the logs", () => {
  it("through a panel controller", () => {
    const openTab = vi.fn(() => true);
    expect(openLogsTab({ openTab }, { id: "logs", title: "Commands" })).toBe(true);
    expect(openTab).toHaveBeenCalledWith({
      tab: { id: "logs", context: { kind: "thread" }, availability: "action" },
      title: "Commands",
    });
  });

  it("through useBbNavigate() while bb has openThreadPanel", () => {
    const navigate = { openThreadPanel: vi.fn() };
    expect(openLegacyLogsPanel(navigate, { id: "logs", title: "Commands" })).toBe(true);
    expect(navigate.openThreadPanel).toHaveBeenCalledWith({ actionId: "logs", title: "Commands" });
  });

  it("reports false when bb no longer has openThreadPanel", () => {
    expect(openLegacyLogsPanel({}, { id: "logs", title: "Commands" })).toBe(false);
  });
});

describe("bundled sources", () => {
  // The patterns `bb plugin build` (bb 0.49) warns about; it scans every
  // bundled file, comments included.
  const retired = [
    /\.\s*threadPanelAction\s*\(/u,
    /\.\s*experimental_threadHeaderAction\b/u,
    /\.\s*openThreadPanel\s*\(/u,
    /\{[^{}]*\bopenThreadPanel\b(?!\s*:)[^{}]*\}\s*(?:\)|=(?!=))/u,
  ];
  const root = new URL("..", import.meta.url);
  const files = [
    "app.tsx",
    "server.ts",
    ...readdirSync(new URL("lib/", root))
      .filter((name) => /\.tsx?$/u.test(name) && !name.includes(".test."))
      .map((name) => `lib/${name}`),
  ];

  it.each(files)("%s uses no retired API name the 0.49 build warns about", (file) => {
    const source = readFileSync(new URL(file, root), "utf8");
    for (const pattern of retired) expect(source).not.toMatch(pattern);
  });
});
