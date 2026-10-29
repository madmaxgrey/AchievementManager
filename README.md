# Achievement Manager

A [Millennium](https://steambrew.app) plugin that adds an **Achievement Manager** button next to *View My Achievements* on a game's page in the Steam library. The button opens a window styled like Steam's own game Properties window, where you can unlock or lock the game's achievements on your Steam account.

- every achievement of the game as a card: icon, name, description, unlock date, **toggle**
- a navigation column that filters the list: **All achievements / Unlocked / Locked / Changed**, with counts; search and sort on top
- *Unlock shown* / *Lock shown* for whatever the search and filter currently show
- changes are **staged** first; **Apply** asks for a confirmation, then writes them to your Steam account and waits for Steam to confirm the save


## Install

Grab `achievement-manager.star` from the [Releases](https://github.com/madmaxgrey/AchievementManager/releases) page, or build it from this source (see *Building* below).

1. Copy `achievement-manager.star` into Millennium's plugins folder: `<Steam>\millennium\plugins\` on Windows, `~/.local/share/millennium/plugins/` on Linux.
2. Open **Millennium → Plugins**, enable **Achievement Manager**, restart if asked.
3. Open a game's page in your library and click **Achievement Manager**, the button next to *View My Achievements*.


## Notes

> [!IMPORTANT]
> **Windows and Linux.** The plugin detects the system and picks its helper. On Linux the helper is a Python script, so `python3` (3.6 or newer) must be installed. Steam Deck / SteamOS, immutable distributions are not supported.

- It sits next to *View My Achievements* on the game page. If that button is not there, the plugin adds its own button to the achievements section instead.
- Achievement names are shown in Steam's current language when the game's schema has it, English otherwise.
- If the button isn't showing, you can still open the manager for any game with a Steam link. Type this in a browser's address bar or, on Windows, press `Win + R`:

  ```
  steam://achievementmanager/open/<appid>
  ```

  On Linux you can also run it in a terminal:

  ```
  steam steam://achievementmanager/open/<appid>
  ```

  For example, `steam://achievementmanager/open/220` opens the manager for Half-Life 2.

## Building

The plugin is a [Starlight](https://www.npmjs.com/package/@steambrew/starlight) project (`millennium.toml`).

Requirements: [Millennium](https://github.com/SteamClientHomebrew/Millennium) >= v3.6.2 and [Bun](https://bun.com/) >= v1.4.3.

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
resources/steam_achievement_helper.cs   the Windows Steam client helper (bundled, compiled on first use)
resources/steam_achievement_helper.py   the Linux Steam client helper (bundled, run with python3)
frontend/index.tsx                   button injection, the manager window and the Steam stats schema reader
```

## License

MIT — see `LICENSE`. Maintained by [madmaxgrey](https://github.com/madmaxgrey).

## Acknowledgements

The helper follows the approach of [gibbed/SteamAchievementManager](https://github.com/gibbed/SteamAchievementManager) (Steam's stats schema file).
