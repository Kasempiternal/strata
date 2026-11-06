# Security policy

Strata can run elevated and can delete files, so its safety matters.

## What Strata does and doesn't do

- **Read-only until you delete.** Scanning opens the volume (MFT mode) or lists directories (walk mode) for reading only.
- **No network access.** No telemetry, no update pings, no uploads. Your file list never leaves your PC.
- **Deletes only what you confirm.** Every delete goes through a confirmation dialog that lists the exact paths. The Recycle Bin is the default.
  Protected locations are refused by the backend even if the UI asks: drive roots, `C:\Windows` and everything under it, the `Program Files` and `ProgramData` roots,
  user profile roots, NTFS metadata (`$MFT` and the rest), `System Volume Information`, and page and hibernation files.

## Reporting a vulnerability

Please **do not open a public issue** for security problems. Use
[GitHub private vulnerability reporting](https://github.com/Kasempiternal/strata/security/advisories/new) instead.
You'll get an answer within a few days. Please include the Strata version, your Windows version and steps to reproduce.

## Supported versions

Only the latest release gets security fixes.
