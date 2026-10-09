import { assert, describe, it } from "@effect/vitest";

import {
  matchesPreviewHostPolicy,
  normalizePreviewUrl,
  parsePreviewHostPattern,
  PreviewUrlNormalizationError,
  validatePreviewHostPatterns,
} from "./preview";

describe("preview URL helpers", () => {
  it("normalizes bare loopback URLs to http", () => {
    assert.equal(normalizePreviewUrl("localhost:5173"), "http://localhost:5173/");
    assert.equal(normalizePreviewUrl("127.0.0.1:3000/app"), "http://127.0.0.1:3000/app");
    assert.equal(normalizePreviewUrl("0.0.0.0:4173"), "http://0.0.0.0:4173/");
    assert.equal(normalizePreviewUrl("[::1]:8080"), "http://[::1]:8080/");
  });

  it("rejects non-loopback hosts", () => {
    assert.throws(() => normalizePreviewUrl("example.com/path"), PreviewUrlNormalizationError);
  });

  it("rejects unsupported protocols", () => {
    assert.throws(
      () => normalizePreviewUrl("file:///tmp/index.html"),
      PreviewUrlNormalizationError,
    );
  });

  it("treats *.localhost as loopback", () => {
    assert.equal(normalizePreviewUrl("app.localhost:3000"), "http://app.localhost:3000/");
    assert.equal(matchesPreviewHostPolicy("https://a.b.localhost/", undefined), true);
  });

  it("rejects credentials even on loopback", () => {
    assert.throws(
      () => normalizePreviewUrl("http://user:pw@localhost:3000"),
      PreviewUrlNormalizationError,
    );
    assert.equal(
      matchesPreviewHostPolicy("https://u:p@example.com/", { externalHosts: ["example.com"] }),
      false,
    );
  });
});

describe("preview host allowlist grammar", () => {
  const policy = (...externalHosts: string[]) => ({ externalHosts });

  it("matches exact hosts over https only", () => {
    assert.equal(
      normalizePreviewUrl("example.com/path", policy("example.com")),
      "https://example.com/path",
    );
    assert.equal(
      matchesPreviewHostPolicy("https://example.com:8443/", policy("example.com")),
      true,
    );
    assert.equal(matchesPreviewHostPolicy("http://example.com/", policy("example.com")), false);
    assert.equal(
      matchesPreviewHostPolicy("https://www.example.com/", policy("example.com")),
      false,
    );
  });

  it("matches *.domain subdomains only", () => {
    const allow = policy("*.example.com");
    assert.equal(matchesPreviewHostPolicy("https://app.example.com/", allow), true);
    assert.equal(matchesPreviewHostPolicy("https://a.b.example.com/", allow), true);
    assert.equal(matchesPreviewHostPolicy("https://example.com/", allow), false);
    assert.equal(matchesPreviewHostPolicy("https://evilexample.com/", allow), false);
    assert.equal(matchesPreviewHostPolicy("http://app.example.com/", allow), false);
  });

  it("matches any DNS host for * but never IP literals", () => {
    const allow = policy("*");
    assert.equal(matchesPreviewHostPolicy("https://anything.dev/", allow), true);
    assert.equal(matchesPreviewHostPolicy("http://anything.dev/", allow), false);
    assert.equal(matchesPreviewHostPolicy("https://169.254.169.254/", allow), false);
    assert.equal(matchesPreviewHostPolicy("https://10.0.0.1/", allow), false);
    assert.equal(matchesPreviewHostPolicy("https://[2001:db8::1]/", allow), false);
  });

  it("requires IP literals to be listed exactly", () => {
    assert.equal(matchesPreviewHostPolicy("https://10.0.0.1/", policy("10.0.0.1")), true);
    assert.equal(
      matchesPreviewHostPolicy("http://192.168.1.5:8080/", policy("http://192.168.1.5")),
      true,
    );
    assert.equal(
      matchesPreviewHostPolicy("https://192.168.1.5/", policy("http://192.168.1.5")),
      false,
    );
    assert.equal(parsePreviewHostPattern("*.10.0.0.1").ok, false);
  });

  it("matches http://host exactly", () => {
    const allow = policy("http://app.test");
    assert.equal(matchesPreviewHostPolicy("http://app.test/", allow), true);
    assert.equal(matchesPreviewHostPolicy("http://sub.app.test/", allow), false);
    assert.equal(parsePreviewHostPattern("http://*.app.test").ok, false);
  });

  it("normalizes hosts through punycode", () => {
    const allow = policy("bücher.example");
    assert.equal(matchesPreviewHostPolicy("https://xn--bcher-kva.example/", allow), true);
    assert.equal(matchesPreviewHostPolicy("https://BÜCHER.example/", allow), true);
  });

  it("rejects ports, paths, credentials and other schemes in patterns", () => {
    assert.deepEqual(
      validatePreviewHostPatterns([
        "example.com:443",
        "example.com/path",
        "user@example.com",
        "https://example.com",
        "ok.example",
      ]).length,
      4,
    );
  });
});
