- Agents now start with `DO_NOT_TRACK=1`, `DISABLE_TELEMETRY=1` and `DISABLE_ERROR_REPORTING=1`,
  opting Claude Code and other CLIs that honor them out of vendor usage metrics and crash reports.
  A value in your environment or a provider instance's **Environment** setting still wins.
  Terminals and git are unchanged.
