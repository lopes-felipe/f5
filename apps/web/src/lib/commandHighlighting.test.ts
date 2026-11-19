import { describe, expect, it } from "vitest";
import { commandHighlightLanguage } from "./commandHighlighting";

describe("commandHighlightLanguage", () => {
  it.each([
    'pwsh -Command "Get-Content x"',
    '"C:\\Windows\\powershell.exe" -Command "Get-Content x"',
    "$env:PATH",
    "$result = Get-Content x",
    "Get-Content x | Select-Object -First 1",
    "echo ok; Write-Host done",
    "echo ok\nWrite-Host done",
    "echo ok; $result = 1",
    "& ./script.ps1",
  ])("detects PowerShell: %s", (command) => {
    expect(commandHighlightLanguage(command)).toBe("powershell");
  });
  it.each(["echo hello", "update-grub", "python3 -c 'print(1)'", "echo 'Get-Content x'"])(
    "keeps shell syntax: %s",
    (command) => expect(commandHighlightLanguage(command)).toBe("shellscript"),
  );
});
