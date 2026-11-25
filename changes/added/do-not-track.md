- Setting `DO_NOT_TRACK=1` stops F5's background requests: automatic provider CLI update lookups,
  the remote model manifest and file icons from jsDelivr (icons are drawn locally instead).
  Update checks you start still run. On macOS the desktop app also picks up `DO_NOT_TRACK` from
  your login shell.
