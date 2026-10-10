# Achievement Manager

A [Millennium](https://steambrew.app) plugin that adds an **Achievement Manager** tab to a game's achievements window in the Steam library — next to *My Achievements* and *Global Achievements* (and *Achievement Groups*, if you use that plugin).

The tab is built only from Steam's own controls — rows, toggles, dropdowns, button rows, search box, progress bar. There are no custom windows or pop-ups.

- every achievement of the game as a row: icon, name, description, unlock date, **toggle**
- search, filter (All / Unlocked / Locked / Changed) and sort
- *Unlock shown* / *Lock shown* for whatever the search and filter currently show
- changes are **staged** first; **Apply** asks for a second click, then writes them to your Steam account and waits for Steam to confirm the save


## Install

Grab `achievement-manager.star` from the [Releases](https://github.com/madmaxgrey/AchievementManager/releases) page, or build it from this source (see *Building* below).

1. Copy `achievement-manager.star` into `<Steam>\millennium\plugins\`.
2. Open **Millennium → Plugins**, enable **Achievement Manager**, restart if asked.
3. Open a game's page → the achievements button → the new tab.


## Notes

- Windows only. The helper and the process code are Windows-specific.
- Command-line length is not a limit: long lists go to the helper through a temporary file.
- If the other tabs still show the old state after Apply, close and reopen the achievements window.
- Achievement names are in Steam's current language when the schema has it, English otherwise.

## Building

The plugin is a [Starlight](https://www.npmjs.com/package/@steambrew/starlight) project (`millennium.toml`).

Requirements: [Millennium](https://github.com/SteamClientHomebrew/Millennium) >= v3.5.0 and [Bun](https://bun.com/) >= v1.4.3.

```
git clone https://github.com/madmaxgrey/AchievementManager
cd AchievementManager
bun install
bun run build     # packs achievement-manager.star and installs it into Millennium
```

`bun run dev` watches the source and reloads the plugin while you work.

## Files

```
millennium.toml                      manifest (plugin id, backend, frontend, resources)
backend/main.lua                     load / unload hooks
backend/rpc_functions.lua            am_status / am_apply, helper build + launch
resources/steam_achievement_helper.cs   the Steam client helper (bundled, compiled on first use)
frontend/index.tsx                   tab injection, UI and Steam stats schema reader
```

## License

MIT — see `LICENSE`. Maintained by [madmaxgrey](https://github.com/madmaxgrey).

## Acknowledgements

The helper follows the approach of [gibbed/SteamAchievementManager](https://github.com/gibbed/SteamAchievementManager) (Steam's stats schema file).
