- Agents now start with `DISABLE_ERROR_REPORTING=1`, opting Claude Code and other CLIs that honor
  it out of vendor crash reports. A value in your environment or a provider instance's
  **Environment** setting still wins. Terminals and git are unchanged.
