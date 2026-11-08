# Security

Report a vulnerability privately: on GitHub, open **Security → Advisories → [Report a vulnerability](https://github.com/L0nE-F0x/VibeForge/security/advisories/new)**. Please don't open a public issue for it.

In scope:

- **The phone page's server** on `127.0.0.1:4737`: its pairing code, its API, and anything it lets a phone do to a terminal.
- **The control socket** that `vibeforge tell`, `task`, `apply` and `--voice` use.
- **The update path**: the release check, the installer behind `vibe-forge.net/install`, and the in-app Update.
- **The window**: what a web page in the browser dock, a run's output or a file on disk can make the app do.

Out of scope: what a coding CLI does with its own shell (allowed folders are a policy, not a sandbox), and bugs in the CLIs themselves.

You'll get a first answer within a week. Fixes go into the next release, with credit in the changelog unless you'd rather not.
