export function toSystemLocaleTag(identifier: string, hourCycle?: "h12" | "h23"): string {
  const [base = "", keywords = ""] = identifier.split("@");
  const languageTag = base.replace(/_/g, "-");
  const region = /(?:^|;)rg=([a-z]{2}|\d{3})zzzz(?:;|$)/i.exec(keywords)?.[1]?.toUpperCase();
  try {
    return new Intl.Locale(languageTag, {
      ...(region ? { region } : {}),
      ...(hourCycle ? { hourCycle } : {}),
    }).toString();
  } catch {
    return languageTag;
  }
}

export function systemLocale(
  identifier: string,
  platform: string,
  env: NodeJS.ProcessEnv,
  preference: (key: string) => boolean,
): string {
  let hourCycle: "h12" | "h23" | undefined;
  if (platform === "linux") {
    const timeLocale = (env.LC_ALL || env.LC_TIME || env.LANG)?.split(".")[0];
    if (timeLocale && timeLocale !== "C" && timeLocale !== "POSIX") identifier = timeLocale;
  } else if (platform === "darwin") {
    if (preference("AppleICUForce24HourTime")) hourCycle = "h23";
    else if (preference("AppleICUForce12HourTime")) hourCycle = "h12";
  }
  return toSystemLocaleTag(identifier, hourCycle);
}
