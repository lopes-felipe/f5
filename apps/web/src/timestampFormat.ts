import { type TimestampFormat } from "./appSettings";

export function getTimestampFormatOptions(
  timestampFormat: TimestampFormat,
  includeSeconds: boolean,
): Intl.DateTimeFormatOptions {
  const baseOptions: Intl.DateTimeFormatOptions = {
    hour: "numeric",
    minute: "2-digit",
    ...(includeSeconds ? { second: "2-digit" } : {}),
  };

  if (timestampFormat === "locale") {
    return baseOptions;
  }

  return {
    ...baseOptions,
    hour12: timestampFormat === "12-hour",
  };
}

export function resolveTimestampLocale(
  systemLocale: string | null | undefined,
): string | undefined {
  const locale = systemLocale?.trim();
  if (!locale) return undefined;
  try {
    Intl.DateTimeFormat.supportedLocalesOf([locale]);
    return locale;
  } catch {
    return undefined;
  }
}

const locale = resolveTimestampLocale(
  typeof window === "undefined" ? null : window.desktopBridge?.getSystemLocale?.(),
);

const timestampFormatterCache = new Map<string, Intl.DateTimeFormat>();

function getTimestampFormatter(
  timestampFormat: TimestampFormat,
  includeSeconds: boolean,
  includeDate = false,
): Intl.DateTimeFormat {
  const cacheKey = `${locale ?? "default"}:${timestampFormat}:${includeSeconds ? "seconds" : "minutes"}:${includeDate}`;
  const cachedFormatter = timestampFormatterCache.get(cacheKey);
  if (cachedFormatter) {
    return cachedFormatter;
  }

  const formatter = new Intl.DateTimeFormat(locale, {
    ...getTimestampFormatOptions(timestampFormat, includeSeconds),
    ...(includeDate ? ({ year: "numeric", month: "short", day: "numeric" } as const) : {}),
  });
  timestampFormatterCache.set(cacheKey, formatter);
  return formatter;
}

export function isOlderCalendarDay(date: Date, now: Date): boolean {
  return (
    date.getFullYear() !== now.getFullYear() ||
    date.getMonth() !== now.getMonth() ||
    date.getDate() !== now.getDate()
  );
}

export function formatTimestamp(isoDate: string, timestampFormat: TimestampFormat): string {
  const date = new Date(isoDate);
  return getTimestampFormatter(timestampFormat, true, isOlderCalendarDay(date, new Date())).format(
    date,
  );
}

export function formatShortTimestamp(isoDate: string, timestampFormat: TimestampFormat): string {
  const date = new Date(isoDate);
  return getTimestampFormatter(timestampFormat, false, isOlderCalendarDay(date, new Date())).format(
    date,
  );
}
