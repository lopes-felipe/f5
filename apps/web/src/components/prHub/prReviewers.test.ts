import { describe, expect, it } from "vitest";

import {
  prReviewerAllowsCustom,
  prReviewerChange,
  prReviewerOptions,
  prReviewerSet,
} from "./prReviewers";

describe("prReviewerSet", () => {
  it("reads logins on GitHub and the forge's ids elsewhere", () => {
    expect(
      prReviewerSet(
        { candidates: [{ login: "bob" }], currentReviewers: [{ login: "alice" }] },
        "github",
      ),
    ).toEqual({
      known: true,
      current: [{ id: "alice", label: "alice" }],
      candidates: [{ id: "bob", label: "bob" }],
      candidatesSupported: true,
    });
    expect(
      prReviewerSet(
        {
          candidates: [{ id: 2, username: "bob" }],
          currentReviewers: [{ id: 1, username: "alice" }],
        },
        "gitlab",
      ).current,
    ).toEqual([{ id: "1", label: "alice" }]);
    expect(
      prReviewerSet(
        {
          candidates: { values: [{ uuid: "u-b", nickname: "bob" }] },
          currentReviewers: [{ user: { uuid: "u-a", display_name: "Alice" }, role: "REVIEWER" }],
        },
        "bitbucket",
      ),
    ).toMatchObject({
      current: [{ id: "u-a", label: "Alice" }],
      candidates: [{ id: "u-b", label: "bob" }],
    });
  });

  it("leaves out participants that are not reviewers", () => {
    const set = prReviewerSet(
      {
        candidates: [],
        currentReviewers: [
          { user: { uuid: "u-a" }, role: "PARTICIPANT" },
          { user: { uuid: "u-b" }, role: "REVIEWER" },
        ],
      },
      "bitbucket",
    );
    expect(set.known).toBe(true);
    expect(set.current.map((reviewer) => reviewer.id)).toEqual(["u-b"]);
  });

  it("is not known when a current reviewer has no id or the list is missing", () => {
    expect(
      prReviewerSet({ candidates: [], currentReviewers: [{ username: "alice" }] }, "gitlab").known,
    ).toBe(false);
    expect(prReviewerSet({ candidates: [] }, "gitlab").known).toBe(false);
    expect(prReviewerSet(null, "gitlab").known).toBe(false);
  });

  it("reports when the forge cannot list candidates", () => {
    expect(
      prReviewerSet(
        { candidates: [], currentReviewers: [], candidatesSupported: false },
        "azure-devops",
      ).candidatesSupported,
    ).toBe(false);
  });
});

describe("prReviewerAllowsCustom", () => {
  it("allows typing a login, or an id where candidates cannot be listed", () => {
    expect(prReviewerAllowsCustom("github", true)).toBe(true);
    expect(prReviewerAllowsCustom("forgejo", true)).toBe(true);
    expect(prReviewerAllowsCustom("gitlab", true)).toBe(false);
    expect(prReviewerAllowsCustom("azure-devops", false)).toBe(true);
  });
});

describe("prReviewerOptions", () => {
  it("lists current reviewers, then candidates, then typed entries, once each", () => {
    const set = prReviewerSet(
      {
        candidates: [{ login: "alice" }, { login: "bob" }],
        currentReviewers: [{ login: "alice" }],
      },
      "github",
    );
    expect(prReviewerOptions(set, ["org/team", "bob"]).map((option) => option.id)).toEqual([
      "alice",
      "bob",
      "org/team",
    ]);
    expect(prReviewerOptions(null, ["carol"])).toEqual([{ id: "carol", label: "carol" }]);
  });
});

describe("prReviewerChange", () => {
  it("returns what to request and what to withdraw, ignoring case", () => {
    expect(prReviewerChange(["Alice", "bob"], ["alice", "carol"])).toEqual({
      add: ["carol"],
      remove: ["bob"],
    });
    expect(prReviewerChange(["alice"], ["alice"])).toEqual({ add: [], remove: [] });
  });
});
