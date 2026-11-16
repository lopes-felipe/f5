import { Terminal } from "@xterm/xterm";
import { expect, it } from "vitest";
import { createTerminalOutputWriter } from "./terminalSelection";

it("preserves a real xterm selection through redraws and tracks scrollback trimming", async () => {
  const mount = document.createElement("div");
  document.body.append(mount);
  const terminal = new Terminal({ cols: 80, rows: 5, scrollback: 0 });
  terminal.open(mount);
  const writer = createTerminalOutputWriter(terminal);
  const parsed = (data: string) => new Promise<void>((resolve) => terminal.write(data, resolve));
  try {
    await parsed("row 0\r\nrow 1\r\nrow 2\r\nrow 3\r\nrow 4");
    terminal.select(0, 2, 5);
    expect(terminal.getSelection()).toBe("row 2");
    // Erase and repaint the selected row, then return to the bottom line.
    writer.write("\x1b[3;1H\x1b[2Krow 2\x1b[5;6H");
    // A sentinel write waits until the writer's asynchronous comparison completes.
    await parsed("");
    expect(terminal.getSelection()).toBe("row 2");
    writer.write("\r\nrow 5");
    await parsed("");
    expect(terminal.getSelection()).toBe("row 2");
    expect(terminal.getSelectionPosition()?.start.y).toBe(1);
    writer.write("\x1b[2;1H\x1b[2Kchanged");
    await parsed("");
    expect(terminal.hasSelection()).toBe(false);
  } finally {
    writer.dispose();
    terminal.dispose();
    mount.remove();
  }
});

it.each([false, true])(
  "keeps xterm's drag anchor when output scrolls (alternate screen: %s)",
  async (alternate) => {
    const mount = document.createElement("div");
    document.body.append(mount);
    const terminal = new Terminal({ cols: 80, rows: 10, scrollback: 0 });
    terminal.open(mount);
    const writer = createTerminalOutputWriter(terminal);
    const parsed = (data: string) => new Promise<void>((resolve) => terminal.write(data, resolve));
    try {
      if (alternate) await parsed("\x1b[?1049h");
      await parsed(Array.from({ length: 10 }, (_, i) => "row " + i).join("\r\n"));
      const screen = mount.querySelector<HTMLElement>(".xterm-screen")!;
      const bounds = screen.getBoundingClientRect();
      const mouse = (type: string, column: number) => {
        screen.dispatchEvent(
          new MouseEvent(type, {
            bubbles: true,
            button: 0,
            detail: 1,
            buttons: type === "mouseup" ? 0 : 1,
            clientX: bounds.left + ((column + 0.5) * bounds.width) / terminal.cols,
            clientY: bounds.top + (6.5 * bounds.height) / terminal.rows,
          }),
        );
      };
      mouse("mousedown", 0);
      mouse("mousemove", 4);
      expect(terminal.getSelection()).toBe("row ");
      // Move before xterm parses the write. It does not emit onSelectionChange
      // for this extension until mouseup.
      writer.write("\x1b[1;1Hunrelated\x1b[10;6H");
      mouse("mousemove", 5);
      await parsed("");
      expect(terminal.getSelection()).toBe("row 6");
      writer.write("\r\nrow 10\r\nrow 11");
      await parsed("");
      mouse("mousemove", 6);
      expect(terminal.getSelection()).toBe("row 6\nrow 7\nrow 8");
      mouse("mouseup", 6);
    } finally {
      writer.dispose();
      terminal.dispose();
      mount.remove();
    }
  },
);

it("keeps selectAll copyable while output streams beyond the comparison cap", async () => {
  const mount = document.createElement("div");
  document.body.append(mount);
  const terminal = new Terminal({ cols: 80, rows: 10, scrollback: 100 });
  terminal.open(mount);
  const writer = createTerminalOutputWriter(terminal);
  const parsed = (data: string) => new Promise<void>((resolve) => terminal.write(data, resolve));
  try {
    await parsed(Array.from({ length: 60 }, (_, i) => "row " + i).join("\r\n"));
    terminal.selectAll();
    const text = terminal.getSelection();
    for (let i = 0; i < 5; i++) writer.write("\r\nstream " + i);
    await parsed("");
    expect(terminal.hasSelection()).toBe(true);
    expect(terminal.getSelection()).toContain(text);
  } finally {
    writer.dispose();
    terminal.dispose();
    mount.remove();
  }
});
