# Achievement Manager

A [Millennium](https://steambrew.app) plugin that adds an **Achievement Manager** button next to *View My Achievements* on a game's page in the Steam library. The button opens a window styled like Steam's own game Properties window, where you can unlock or lock the game's achievements on your Steam account.

- every achievement of the game as a card: icon, name, description, unlock date, **toggle**
- a navigation column that filters the list: **All achievements / Unlocked / Locked / Changed**, with counts; search and sort on top
- *Unlock shown* / *Lock shown* for whatever the search and filter currently show
- changes are **staged** first; **Apply** asks for a confirmation, then writes them to your Steam account and waits for Steam to confirm the save


## Install

Grab `achievement-manager.star` from the [Releases](https://github.com/madmaxgrey/AchievementManager/releases) page, or build it from this source (see *Building* below).

1. Copy `achievement-manager.star` into `<Steam>\millennium\plugins\`.
2. Open **Millennium → Plugins**, enable **Achievement Manager**, restart if asked.
3. Open a game's page in your library and click **Achievement Manager**, the button next to *View My Achievements*.


## Notes

- Windows only. The helper and the process code are Windows-specific.
- The button sits next to *View My Achievements* on the game page. If that button is not there, the plugin adds its own button to the achievements section instead.
- If the game page still shows the old achievements after Apply, leave the page and open it again.
- Achievement names are in Steam's current language when the schema has it, English otherwise.

## Building

The plugin is a [Starlight](https://www.npmjs.com/package/@steambrew/starlight) project (`millennium.toml`).

Requirements: [Millennium](https://github.com/SteamClientHomebrew/Millennium) >= v3.6.1 and [Bun](https://bun.com/) >= v1.4.3.

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
frontend/index.tsx                   button injection, the manager window and the Steam stats schema reader
```

## License

MIT — see `LICENSE`. Maintained by [madmaxgrey](https://github.com/madmaxgrey).

## Acknowledgements

The helper follows the approach of [gibbed/SteamAchievementManager](https://github.com/gibbed/SteamAchievementManager) (Steam's stats schema file).
