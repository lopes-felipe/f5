import { afterEach, expect, it } from "vitest";
import {
  closeSync,
  mkdtempSync,
  openSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { stageComputerHelper } from "./stage-computer-helper";

const roots: string[] = [];
function fixture() {
  const root = mkdtempSync(join(tmpdir(), "f5-helper-staging-test-"));
  roots.push(root);
  const binary = join(root, "helper");
  writeFileSync(binary, "previous");
  return { root, binary };
}
afterEach(() => roots.splice(0).forEach((root) => rmSync(root, { recursive: true, force: true })));

it("preserves a held helper, using replacement or an explicit Windows refusal", () => {
  const { root, binary } = fixture();
  const previous = openSync(binary, "r");
  const publish = () =>
    stageComputerHelper(binary, (staged) => {
      writeFileSync(staged, "replacement");
      return true;
    });
  try {
    if (process.platform === "win32") {
      let error: unknown;
      try {
        publish();
      } catch (caught) {
        error = caught;
      }
      expect(error).toMatchObject({ code: "EPERM", syscall: "rename" });
      expect(readFileSync(binary, "utf8")).toBe("previous");
    } else {
      expect(publish()).toBe(true);
      expect(readFileSync(binary, "utf8")).toBe("replacement");
    }
    expect(readFileSync(previous, "utf8")).toBe("previous");
    expect(readdirSync(root)).toEqual(["helper"]);
  } finally {
    closeSync(previous);
  }
  // Once the old handle is closed, both platforms must publish successfully.
  expect(publish()).toBe(true);
  expect(readFileSync(binary, "utf8")).toBe("replacement");
  expect(readdirSync(root)).toEqual(["helper"]);
});

it("keeps the old helper when the build declines publication", () => {
  const { root, binary } = fixture();
  expect(
    stageComputerHelper(binary, (staged) => {
      writeFileSync(staged, "incomplete");
      return false;
    }),
  ).toBe(false);
  expect(readFileSync(binary, "utf8")).toBe("previous");
  expect(readdirSync(root)).toEqual(["helper"]);
});

it("keeps the old helper and cleans owned staging after a build exception", () => {
  const { root, binary } = fixture();
  expect(() =>
    stageComputerHelper(binary, (staged) => {
      writeFileSync(staged, "incomplete");
      throw new Error("build failed");
    }),
  ).toThrow("build failed");
  expect(readFileSync(binary, "utf8")).toBe("previous");
  expect(readdirSync(root)).toEqual(["helper"]);
});

it("refuses a successful builder that produced no helper", () => {
  const { root, binary } = fixture();
  expect(() => stageComputerHelper(binary, () => true)).toThrow();
  expect(readFileSync(binary, "utf8")).toBe("previous");
  expect(readdirSync(root)).toEqual(["helper"]);
});
