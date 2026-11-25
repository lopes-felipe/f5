- Fresh SQLite databases now bootstrap directly from a squashed baseline schema (migrations 1–174)
  in a single transaction instead of replaying every historical migration, speeding up initial
  startup and test database setup while keeping existing databases on the standard incremental
  upgrade path.
