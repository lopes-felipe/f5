- On Windows and macOS, the desktop app now encrypts its cookies, including cookies imported into
  the preview browser, with the operating system's key (DPAPI on Windows, the Keychain on macOS).
  Cookies written or replaced after the update are encrypted; older ones keep working and are
  encrypted the next time they change. Reinstalling an older F5 release afterwards loses these
  cookies. Linux is unchanged for now.
