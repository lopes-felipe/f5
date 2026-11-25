- F5 exports traces and metrics only to the OTLP collector set in **Settings → Diagnostics**.
  `OTEL_EXPORTER_OTLP_*` endpoints and headers and `OTEL_RESOURCE_ATTRIBUTES` from the environment
  are now ignored, so a workstation-wide collector no longer receives F5 data.
