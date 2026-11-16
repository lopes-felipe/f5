import { expect, it } from "vitest";
import { getUpdateErrorMessage } from "./updateErrors";
it.each([
  [
    "HttpError: 404 https://example.com/private Headers: secret Stack: private",
    "Update information is unavailable. Try again later.",
  ],
  [
    "net::ERR_INTERNET_DISCONNECTED\nlong stack",
    "Unable to connect. Check your internet connection and try again.",
  ],
  ["429 headers/stack", "The update service is busy. Try again later."],
  ["arbitrary provider text https://example.com", "Could not check for updates. Try again."],
])("maps provider errors to short UI messages", (error, expected) =>
  expect(getUpdateErrorMessage(new Error(error), "check")).toBe(expected),
);
