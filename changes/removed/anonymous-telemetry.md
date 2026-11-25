- F5 no longer contains product analytics. The dormant usage telemetry inherited from T3 Code,
  its anonymous ID and its startup heartbeat are gone, and F5 deletes the leftover `anonymous-id`
  and heartbeat lock files on startup. [Privacy](docs/privacy.md) lists every request F5 still
  makes on its own.
