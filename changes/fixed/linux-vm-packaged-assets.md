- The experimental Linux VM profiles (`F5_EXPERIMENTAL_LINUX_VM=1`) can start from the released
  Apple silicon app: it now ships Lima, signed for virtualization, and downloads the matching
  Linux backend from its own release the first time a VM needs it. A slow download no longer
  trips the startup timeout while it keeps making progress.
- macOS and Windows packages no longer carry a second, unused copy of the native helper inside
  the app archive.
