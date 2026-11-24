import { describe, expect, it } from "vitest";
import { getFiletypeFromFileName } from "./fileLanguage";

describe("getFiletypeFromFileName", () => {
  it("maps common extensions, compound suffixes, and exact filenames", () => {
    expect(getFiletypeFromFileName("src/app.tsx")).toBe("tsx");
    expect(getFiletypeFromFileName("src/main.ts")).toBe("typescript");
    expect(getFiletypeFromFileName("path/to/Dockerfile")).toBe("dockerfile");
    expect(getFiletypeFromFileName("repo/Makefile")).toBe("makefile");
    expect(getFiletypeFromFileName("views/home.blade.php")).toBe("blade");
    expect(getFiletypeFromFileName("app/foo.component.ts")).toBe("angular-ts");
    expect(getFiletypeFromFileName("scripts/run.sh")).toBe("zsh");
  });

  it("falls back to text for unknown extensions", () => {
    expect(getFiletypeFromFileName("README")).toBe("text");
    expect(getFiletypeFromFileName("archive.unknownext")).toBe("text");
    expect(getFiletypeFromFileName("C:\\repo\\file.py")).toBe("python");
  });
});
