- Stored MCP secrets and MCP sign-in tokens are encrypted at rest with AES-256-GCM. The desktop app
  keeps each profile's key in the OS keychain; a server without one uses a key file readable only
  by its user. Existing secrets are re-encrypted the first time they are read. Password-encrypted backups hold
  these values decrypted, so they restore on another machine, and the key file is removed once the
  keychain key protects every value.
