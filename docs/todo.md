# To do

Picked up after the layout and onboarding pass (2026-09-25).

## Next up

- [ ] **In-app updates.** Tag versioned GitHub releases. Help shows "Update available" (the check contacts GitHub, so add a setting to turn it off), runs the installer's update in a terminal pane so it's visible, then offers a restart. Consider an AUR package so Omarchy users update with `yay`.
- [ ] **Multi-language support.** A small `t()` helper with no dependencies, one catalog file per language, and a language picker in Settings that defaults to the system language. Translate the tour, tooltips and empty states first; they hold most of the text.
- [ ] **Diagnostics.** A local log file, plus "Copy diagnostics" in Help so bug reports can include what went wrong.

## Branding

- [ ] **Possible rebrand.** A VibeForge domain has been hard to find. The candidates are **ApexVibeForge** (domain available) or a new name. Decide before sharing widely, because the name is in:
  - the app and window class, `package.json`, the launcher, the desktop entry and the installer paths
  - the config and data folders (`~/.config/vibeforge`, `~/.local/share/vibeforge`), which need a one-time migration
  - the GitHub repo, `REPO` in `src/ui/components/Help.tsx` and `REPO_URL` in `electron/main.ts`
  - the website, the Netlify site name, the README, the icons and the issue templates
- [ ] **"Created by ApexForge" credit.** Add a small, discreet line in the app linking to http://ame-apexforge.org/. Possible spots are the Help menu footer, the bottom of Settings, or under the rail logo. Check whether the site also serves https.

## Known rough edges

- Tooltips and popovers can be hidden behind the browser dock, which is a native view drawn above the page.
