/**
 * Returns true when `host` refers to a local loopback interface (`localhost`,
 * `::1` / `[::1]`, or any address in `127.0.0.0/8`), ignoring surrounding
 * whitespace and letter casing.
 */
export const isLoopbackHost = (host: string | undefined): boolean => {
  const normalized =
    host
      ?.trim()
      .toLowerCase()
      .replace(/^\[|\]$/gu, "") ?? "";
  return (
    normalized === "localhost" || normalized === "::1" || /^127(?:\.\d{1,3}){3}$/u.test(normalized)
  );
};
