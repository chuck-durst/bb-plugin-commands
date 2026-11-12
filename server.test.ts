import { describe, expect, it } from "vitest";
import { inUserShell } from "./server";

describe("inUserShell", () => {
  it("runs the command in an interactive login shell", () => {
    expect(inUserShell("pnpm start", "darwin")).toBe(
      `exec env DISABLE_AUTO_UPDATE=true "\${SHELL:-/bin/sh}" -ilc 'pnpm start'`,
    );
  });

  it("turns off oh-my-zsh's update prompt for that shell only", () => {
    expect(inUserShell("date", "linux")).toContain("env DISABLE_AUTO_UPDATE=true ");
  });

  it("quotes single quotes in the command", () => {
    expect(inUserShell("echo 'hi'", "darwin")).toContain(`-ilc 'echo '\\''hi'\\'''`);
  });

  it("leaves Windows commands untouched", () => {
    expect(inUserShell("npm start", "win32")).toBe("npm start");
  });
});
