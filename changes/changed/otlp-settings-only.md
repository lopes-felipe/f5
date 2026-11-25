- F5 exports traces and metrics only to the OTLP collector set in **Settings → Diagnostics**.
  `OTEL_EXPORTER_OTLP_*` endpoints and headers from the environment are now ignored, so a
  workstation-wide collector no longer receives F5 data; F5 logs a warning at startup when they
  are set. `OTEL_RESOURCE_ATTRIBUTES` still labels exported data, for example to replace the
  host name.
