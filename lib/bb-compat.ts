// Picks between bb's thread UI APIs at runtime, so one bundle runs everywhere.
//
// The plugin has two header displays:
// - "plugin": its own split button, a React component in the
//   `experimental_threadHeaderAction` slot (colors, running dot, menu);
// - "bb": header thread actions (`experimental_threadAction` with
//   `placement: "header"`), entries of bb's shared header split button.
// bb 0.49 (SDK 0.6.132) retired the slot from the SDK typings but still
// accepts it ("existing plugins remain supported"), so the plugin keeps its
// own display while the slot exists (setting "auto"), and switches to bb's
// once a bb no longer has it. The `display` setting can force either.
//
// Header placement is detected through the `experimental_ThreadRowMetadata`
// export, which shipped with it in SDK 0.6.94. Testing the slot is not
// enough: bb 0.46 (SDK 0.6.49) has `experimental_threadAction` without
// `placement`, and the actions would land in the thread menus.
//
// The logs panel follows the same rule: the `threadPanelAction` slot while bb
// has it, else an `experimental_tab` with `context: { kind: "thread" },
// availability: "action"` (bb 0.49 maps the first onto the second).
//
// The legacy names are read with brackets: `bb plugin build` scans every
// source file, comments included, for a dot followed by a retired name and
// logs a retirement warning for each match, even in a branch that never runs
// on that bb. Keep these names out of dotted access, here and in app.tsx.
//
// The SDK is pinned to 0.6.15 so the plugin still builds on older bb, so the
// new shapes are declared here, reduced to what this plugin uses.
import type { ComponentType } from "react";

/** The marker export that shipped with header thread actions (SDK 0.6.94). */
export const HEADER_PLACEMENT_MARKER = "experimental_ThreadRowMetadata";
const LEGACY_HEADER_ACTION = "experimental_threadHeaderAction";
const LEGACY_PANEL_ACTION = "threadPanelAction";
const LEGACY_OPEN_PANEL = "openThreadPanel";

// ---------------------------------------------------------------------------
// What this bb supports, and which display to use
// ---------------------------------------------------------------------------

export interface ThreadUiCapabilities {
  /** The plugin's own header component (`experimental_threadHeaderAction`). */
  pluginHeader: boolean;
  /** Header thread actions in bb's shared split button. */
  bbHeader: boolean;
  /** The `threadPanelAction` slot for the logs panel. */
  legacyPanel: boolean;
}

/**
 * `slots` is `app.slots`; `sdkApp` is the `@get-bb/plugin-sdk/app` namespace
 * (`import * as`).
 */
export function detectCapabilities(slots: object, sdkApp: object): ThreadUiCapabilities {
  const s = slots as Record<string, unknown>;
  return {
    pluginHeader: typeof s[LEGACY_HEADER_ACTION] === "function",
    bbHeader:
      (sdkApp as Record<string, unknown>)[HEADER_PLACEMENT_MARKER] !== undefined &&
      typeof s.experimental_threadAction === "function",
    legacyPanel: typeof s[LEGACY_PANEL_ACTION] === "function",
  };
}

export const DISPLAY_SETTINGS = ["auto", "plugin", "bb"] as const;
export type DisplaySetting = (typeof DISPLAY_SETTINGS)[number];
export type Display = "plugin" | "bb";

/** The stored setting; anything else (unset, an old value) reads as "auto". */
export function parseDisplaySetting(value: unknown): DisplaySetting {
  return DISPLAY_SETTINGS.find((setting) => setting === value) ?? "auto";
}

export interface DisplayChoice {
  display: Display;
  /** Set when the requested display is not available on this bb. */
  fallbackFrom: Display | null;
}

export function resolveDisplay(
  setting: DisplaySetting,
  capabilities: ThreadUiCapabilities,
): DisplayChoice {
  const available = (display: Display) =>
    display === "plugin" ? capabilities.pluginHeader : capabilities.bbHeader;
  if (setting === "auto") {
    // The plugin's own display while bb accepts it. A bb with neither keeps
    // "plugin": no registration renders anything then.
    return {
      display: available("plugin") || !available("bb") ? "plugin" : "bb",
      fallbackFrom: null,
    };
  }
  const other: Display = setting === "plugin" ? "bb" : "plugin";
  if (available(setting) || !available(other)) {
    return { display: setting, fallbackFrom: null };
  }
  return { display: other, fallbackFrom: setting };
}

// ---------------------------------------------------------------------------
// New API shapes (SDK 0.6.94+)
// ---------------------------------------------------------------------------

export interface TabReference {
  id: string;
  context: { kind: "thread" };
  availability: "action";
}

export interface PanelController {
  openTab(options: { tab: TabReference; params?: unknown; title?: string }): boolean;
}

export interface HeaderThreadAction {
  label: string;
  detail?: string;
  icon: string;
  variant?: "default" | "destructive";
  disabled?: boolean;
  run(input: unknown): void | Promise<void>;
}

export interface HeaderThreadActionItemInput<Data> {
  thread: { id: string };
  data: Data;
  experimental_panel: PanelController;
}

export interface HeaderThreadActionRegistration<Data> {
  id: string;
  title: string;
  icon: string;
  group: string;
  order?: number;
  placement: "header";
  useData?(input: { threadIds: readonly string[] }): Data;
  item(input: HeaderThreadActionItemInput<Data>): HeaderThreadAction | null;
}

// ---------------------------------------------------------------------------
// Registration
// ---------------------------------------------------------------------------

export interface LogsTab {
  id: string;
  title: string;
  icon: string;
  layout: "flush" | "padded";
  component: ComponentType<{ threadId: string }>;
}

export interface ThreadUiRegistrations<Data> {
  logsTab: LogsTab;
  /** The "plugin" display: one component that draws the whole control. */
  pluginHeader: { id: string; title: string; component: ComponentType<never> };
  /** The "bb" display: header thread actions in bb's split button. */
  bbHeader: readonly HeaderThreadActionRegistration<Data>[];
}

type Slots = Record<string, unknown>;

function slot(slots: Slots, name: string): (registration: unknown) => void {
  const register = slots[name];
  if (typeof register !== "function") {
    throw new Error(`This bb has no app.slots.${name}.`);
  }
  return (registration) => register.call(slots, registration);
}

/**
 * Registers every header display this bb supports (each one renders only
 * while it is the chosen display, so the setting applies without a reload)
 * and the logs panel with the slot this bb prefers.
 */
export function registerThreadUi<Data>(
  capabilities: ThreadUiCapabilities,
  slots: object,
  registrations: ThreadUiRegistrations<Data>,
): void {
  const s = slots as Slots;
  if (capabilities.pluginHeader) {
    slot(s, LEGACY_HEADER_ACTION)(registrations.pluginHeader);
  }
  if (capabilities.bbHeader) {
    for (const action of registrations.bbHeader) {
      slot(s, "experimental_threadAction")(action);
    }
  }
  const { logsTab } = registrations;
  if (capabilities.legacyPanel) {
    slot(s, LEGACY_PANEL_ACTION)(logsTab);
    return;
  }
  slot(s, "experimental_tab")({
    ...logsTab,
    context: { kind: "thread" },
    availability: "action",
    // The launcher in the panel's Actions list: open (or reselect) the one
    // instance rather than a new one per click.
    run: ({ experimental_panel }: { experimental_panel: PanelController }) => {
      openLogsTab(experimental_panel, logsTab);
    },
  });
}

export function logsTabReference(id: string): TabReference {
  return { id, context: { kind: "thread" }, availability: "action" };
}

/** Opens the logs tab in a panel controller (SDK 0.6.73+). */
export function openLogsTab(panel: PanelController, tab: { id: string; title: string }): boolean {
  return panel.openTab({ tab: logsTabReference(tab.id), title: tab.title });
}

/**
 * Opens the logs through `useBbNavigate()` on a bb that still has
 * `openThreadPanel`; false when it does not.
 */
export function openLegacyLogsPanel(navigate: object, tab: { id: string; title: string }): boolean {
  const open = (navigate as Record<string, unknown>)[LEGACY_OPEN_PANEL];
  if (typeof open !== "function") return false;
  open.call(navigate, { actionId: tab.id, title: tab.title });
  return true;
}
