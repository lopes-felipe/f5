import { describe, expect, it } from "vitest";

import {
  parsePrQueueSearch,
  prQueueIsFiltered,
  prQueueListInput,
  prQueueQuery,
  prQueueSuggestions,
} from "./prQueueSearch";

describe("parsePrQueueSearch", () => {
  it("keeps what it knows and drops everything else", () => {
    expect(
      parsePrQueueSearch({
        pr: "github:github.com/octo/repo#7",
        view: "page",
        tab: "files",
        q: "layout ",
        repo: "octo/repo",
        author: "alice",
        label: "needs design",
        ci: "failure",
        review: "approved",
        draft: "hide",
        status: "snoozed",
        unknown: "x",
      }),
    ).toEqual({
      pr: "github:github.com/octo/repo#7",
      view: "page",
      tab: "files",
      q: "layout ",
      repo: "octo/repo",
      author: "alice",
      label: "needs design",
      ci: "failure",
      review: "approved",
      draft: "hide",
      status: "snoozed",
    });
  });

  it("leaves defaults and invalid values out of the URL", () => {
    expect(
      parsePrQueueSearch({
        pr: "  ",
        view: "page",
        tab: "files",
        q: "   ",
        ci: "green",
        review: 3,
        draft: "all",
        status: "active",
      }),
    ).toEqual({});
    expect(parsePrQueueSearch({ status: "archived", q: "x".repeat(501) })).toEqual({});
  });

  it("opens the peek unless the page is asked for, and tabs belong to the page", () => {
    const pr = "github:github.com/octo/repo#7";
    expect(parsePrQueueSearch({ pr, view: "peek", tab: "files" })).toEqual({ pr });
    expect(parsePrQueueSearch({ pr, view: "page", tab: "overview" })).toEqual({ pr, view: "page" });
    expect(parsePrQueueSearch({ pr, view: "page", tab: "checks" })).toEqual({ pr, view: "page" });
    expect(parsePrQueueSearch({ view: "page" })).toEqual({});
  });
});

describe("prQueueSuggestions", () => {
  const facets = {
    repositories: ["octo/web", "octo/api", "acme/tools"],
    authors: ["alice", "bob"],
    labels: ["bug", "needs design"],
  };
  const labels = (text: string) => prQueueSuggestions(text, facets).map((item) => item.label);

  it("completes qualifier names for the word being typed", () => {
    expect(labels("re")).toEqual(["repo:", "review:"]);
    expect(labels("fix -la")).toEqual(["-label:"]);
    expect(prQueueSuggestions("fix au", facets)[0]).toEqual({
      label: "author:",
      detail: "Author, or me",
      text: "fix author:",
    });
    expect(labels("")).toEqual([]);
    expect(labels("fix ")).toEqual([]);
    expect(labels("#12")).toEqual([]);
  });

  it("completes a qualifier's values from the queue", () => {
    expect(labels("repo:")).toEqual(["repo:octo/web", "repo:octo/api", "repo:acme/tools"]);
    expect(labels("repo:API")).toEqual(["repo:octo/api"]);
    expect(labels("author:")).toEqual(["author:me", "author:alice", "author:bob"]);
    expect(labels("status:f")).toEqual(["status:failing"]);
    expect(labels("draft:")).toEqual(["draft:true", "draft:false"]);
    // A complete value needs no completion, and unknown qualifiers offer nothing.
    expect(labels("author:bob")).toEqual([]);
    expect(labels("is:open")).toEqual([]);
  });

  it("quotes values with spaces and keeps the rest of the search", () => {
    expect(prQueueSuggestions("crash label:need", facets)).toEqual([
      { label: "label:needs design", text: 'crash label:"needs design" ' },
    ]);
    expect(labels('label:"needs des')).toEqual([]);
  });

  it("works before the queue has reported its values", () => {
    expect(prQueueSuggestions("repo:", undefined)).toEqual([]);
    expect(prQueueSuggestions("author:", undefined).map((item) => item.label)).toEqual([
      "author:me",
    ]);
  });
});

describe("queue list requests", () => {
  it("asks for one section of the active queue", () => {
    expect(prQueueListInput({}, "review")).toEqual({
      limit: 25,
      visibility: "active",
      section: "review",
    });
    // A search reads the whole active queue in section order.
    expect(prQueueListInput({ q: "fix" })).toEqual({
      limit: 25,
      visibility: "active",
      query: "fix",
    });
  });

  it("sends filters as fields and the author and label as search qualifiers", () => {
    const search = {
      q: " fix crash ",
      repo: "octo/repo",
      author: "alice",
      label: "needs design",
      ci: "failure",
      review: "approved",
      draft: "only",
    } as const;
    expect(prQueueQuery(search)).toBe('fix crash author:alice label:"needs design"');
    expect(prQueueListInput(search, "action")).toEqual({
      limit: 25,
      visibility: "active",
      section: "action",
      query: 'fix crash author:alice label:"needs design"',
      repository: "octo/repo",
      ci: "failure",
      review: "approved",
      draft: "only",
    });
  });

  it("quotes a label with a comma so it is not read as two labels", () => {
    expect(prQueueQuery({ label: 'a,"b' })).toBe('label:"a,b"');
  });

  it("reads other statuses as one list, newest first", () => {
    expect(prQueueListInput({ status: "closed" }, "review")).toEqual({
      limit: 25,
      visibility: "resolved",
      sort: "updated",
    });
    expect(prQueueListInput({ status: "ignored" }).visibility).toBe("ignored");
    expect(prQueueListInput({ status: "snoozed" }).visibility).toBe("snoozed");
  });

  it("knows when the queue is narrowed", () => {
    expect(prQueueIsFiltered({})).toBe(false);
    expect(prQueueIsFiltered({ pr: "x", status: "closed", q: "  " })).toBe(false);
    expect(prQueueIsFiltered({ q: "fix" })).toBe(true);
    expect(prQueueIsFiltered({ draft: "hide" })).toBe(true);
  });
});
