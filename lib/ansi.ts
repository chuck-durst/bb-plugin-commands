// A small, incremental ANSI log parser for read-only command output.
//
// It models just enough of a terminal for logs: SGR colors and attributes,
// `\r` (progress bars overwrite their line), `\b`, and erase-in-line. Cursor
// movement, screen clears, and OSC/DCS sequences are dropped, so a dev server
// that clears the screen keeps its history instead of wiping the view.

export interface CellStyle {
  fg: string | null;
  bg: string | null;
  bold: boolean;
  dim: boolean;
  italic: boolean;
  underline: boolean;
  inverse: boolean;
}

export interface LogSegment {
  text: string;
  style: CellStyle;
}

export interface LogLine {
  id: number;
  /** Bumped on every change so renderers can memoize unchanged lines. */
  version: number;
  chars: string[];
  styles: CellStyle[];
}

const PLAIN: CellStyle = {
  fg: null,
  bg: null,
  bold: false,
  dim: false,
  italic: false,
  underline: false,
  inverse: false,
};

// Readable on both light and dark themes.
const BASE_COLORS = [
  "#6b7280", // black → gray, so it stays visible on dark backgrounds
  "#dc2626",
  "#16a34a",
  "#ca8a04",
  "#2563eb",
  "#c026d3",
  "#0891b2",
  "#9ca3af",
];
const BRIGHT_COLORS = [
  "#9ca3af",
  "#ef4444",
  "#22c55e",
  "#eab308",
  "#3b82f6",
  "#d946ef",
  "#06b6d4",
  "#e5e7eb",
];

function color256(index: number): string | null {
  if (index < 0 || index > 255) return null;
  if (index < 8) return BASE_COLORS[index] ?? null;
  if (index < 16) return BRIGHT_COLORS[index - 8] ?? null;
  if (index < 232) {
    const value = index - 16;
    const steps = [0, 95, 135, 175, 215, 255];
    const r = steps[Math.floor(value / 36)] ?? 0;
    const g = steps[Math.floor(value / 6) % 6] ?? 0;
    const b = steps[value % 6] ?? 0;
    return `rgb(${r},${g},${b})`;
  }
  const gray = 8 + (index - 232) * 10;
  return `rgb(${gray},${gray},${gray})`;
}

function applySgr(style: CellStyle, params: number[]): CellStyle {
  const next = { ...style };
  const codes = params.length === 0 ? [0] : params;
  for (let i = 0; i < codes.length; i++) {
    const code = codes[i] ?? 0;
    if (code === 0) Object.assign(next, PLAIN);
    else if (code === 1) next.bold = true;
    else if (code === 2) next.dim = true;
    else if (code === 3) next.italic = true;
    else if (code === 4) next.underline = true;
    else if (code === 7) next.inverse = true;
    else if (code === 22) {
      next.bold = false;
      next.dim = false;
    } else if (code === 23) next.italic = false;
    else if (code === 24) next.underline = false;
    else if (code === 27) next.inverse = false;
    else if (code >= 30 && code <= 37) next.fg = BASE_COLORS[code - 30] ?? null;
    else if (code === 39) next.fg = null;
    else if (code >= 40 && code <= 47) next.bg = BASE_COLORS[code - 40] ?? null;
    else if (code === 49) next.bg = null;
    else if (code >= 90 && code <= 97) next.fg = BRIGHT_COLORS[code - 90] ?? null;
    else if (code >= 100 && code <= 107) next.bg = BRIGHT_COLORS[code - 100] ?? null;
    else if (code === 38 || code === 48) {
      const mode = codes[i + 1];
      let value: string | null = null;
      if (mode === 5) {
        value = color256(codes[i + 2] ?? -1);
        i += 2;
      } else if (mode === 2) {
        const [r, g, b] = [codes[i + 2] ?? 0, codes[i + 3] ?? 0, codes[i + 4] ?? 0];
        value = `rgb(${r},${g},${b})`;
        i += 4;
      }
      if (code === 38) next.fg = value;
      else next.bg = value;
    }
  }
  return next;
}

type ParserState = "text" | "escape" | "csi" | "osc" | "osc-escape" | "string";

export class AnsiLog {
  readonly lines: LogLine[] = [];
  private nextId = 0;
  private col = 0;
  private style: CellStyle = PLAIN;
  private state: ParserState = "text";
  private csi = "";
  private readonly maxLines: number;

  constructor(maxLines = 5000) {
    this.maxLines = maxLines;
    this.newLine();
  }

  write(text: string): void {
    for (const ch of text) this.feed(ch);
    if (this.lines.length > this.maxLines) {
      this.lines.splice(0, this.lines.length - this.maxLines);
    }
  }

  private get current(): LogLine {
    return this.lines[this.lines.length - 1]!;
  }

  private newLine(): void {
    this.lines.push({ id: this.nextId++, version: 0, chars: [], styles: [] });
    this.col = 0;
  }

  private put(ch: string): void {
    const line = this.current;
    while (line.chars.length < this.col) {
      line.chars.push(" ");
      line.styles.push(PLAIN);
    }
    line.chars[this.col] = ch;
    line.styles[this.col] = this.style;
    line.version++;
    this.col++;
  }

  private feed(ch: string): void {
    switch (this.state) {
      case "text":
        if (ch === "\x1b") this.state = "escape";
        else if (ch === "\n") this.newLine();
        else if (ch === "\r") this.col = 0;
        else if (ch === "\b") this.col = Math.max(0, this.col - 1);
        else if (ch === "\t") {
          const spaces = 8 - (this.col % 8);
          for (let i = 0; i < spaces; i++) this.put(" ");
        } else if (ch >= " " && ch !== "\x7f") this.put(ch);
        return;
      case "escape":
        if (ch === "[") {
          this.state = "csi";
          this.csi = "";
        } else if (ch === "]") this.state = "osc";
        else if (ch === "P" || ch === "X" || ch === "^" || ch === "_") this.state = "string";
        else this.state = "text";
        return;
      case "csi":
        if (ch >= "@" && ch <= "~") {
          this.runCsi(ch);
          this.state = "text";
        } else if (this.csi.length < 64) this.csi += ch;
        return;
      case "osc":
      case "string":
        if (ch === "\x07") this.state = "text";
        else if (ch === "\x1b") this.state = "osc-escape";
        return;
      case "osc-escape":
        this.state = ch === "\\" ? "text" : "osc";
        return;
    }
  }

  private runCsi(final: string): void {
    if (this.csi.startsWith("?") || this.csi.startsWith(">")) return;
    const params = this.csi
      .split(";")
      .filter((part) => part !== "")
      .map((part) => Number.parseInt(part, 10))
      .filter((value) => Number.isFinite(value));
    if (final === "m") {
      this.style = applySgr(this.style, params);
    } else if (final === "K") {
      const line = this.current;
      const mode = params[0] ?? 0;
      if (mode === 0) {
        line.chars.length = Math.min(line.chars.length, this.col);
        line.styles.length = line.chars.length;
      } else if (mode === 2) {
        line.chars = [];
        line.styles = [];
      }
      line.version++;
    } else if (final === "G") {
      this.col = Math.max(0, (params[0] ?? 1) - 1);
    } else if (final === "C") {
      this.col += params[0] ?? 1;
    } else if (final === "D") {
      this.col = Math.max(0, this.col - (params[0] ?? 1));
    }
  }
}

function sameStyle(a: CellStyle, b: CellStyle): boolean {
  return (
    a === b ||
    (a.fg === b.fg &&
      a.bg === b.bg &&
      a.bold === b.bold &&
      a.dim === b.dim &&
      a.italic === b.italic &&
      a.underline === b.underline &&
      a.inverse === b.inverse)
  );
}

export function lineSegments(line: LogLine): LogSegment[] {
  const segments: LogSegment[] = [];
  for (let i = 0; i < line.chars.length; i++) {
    const style = line.styles[i] ?? PLAIN;
    const last = segments[segments.length - 1];
    if (last !== undefined && sameStyle(last.style, style)) last.text += line.chars[i];
    else segments.push({ text: line.chars[i] ?? " ", style });
  }
  return segments;
}
