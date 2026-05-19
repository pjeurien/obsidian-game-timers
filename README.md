# Game Timers

An Obsidian plugin for DM-facing countdown timers in a dedicated sidebar.

## Features

- Dedicated sidebar for creating and monitoring multiple countdown timers at once
- Quick custom timers with configurable default minutes and seconds
- Reusable presets managed from plugin settings
- Active timers persist across Obsidian reloads
- Timers can run once or continuously repeat until cancelled
- Running timers can be paused, resumed, or removed from the footer
- Presets can define optional warning times such as `1m, 30s`
- Presets can define an optional color used in the preset list and running timer footer
- Obsidian notices when a timer finishes
- Optional desktop notifications
- `game-timer` markdown code blocks for launching timers directly from notes
- Status bar summary for the next timer to expire
- Audio-sidebar-style running timers footer with quick cancel controls

## Usage

### Sidebar

Open the sidebar from any of these entry points:

- The timer ribbon icon
- The command palette with `Open Game Timers Sidebar`
- The status bar timer readout

From the sidebar you can:

1. Set a session ending clock time and click **Set session alert**
2. Enter a timer name
3. Set minutes and seconds
4. Click **Start once** or **Start continuously**

You can also start any saved preset as a one-shot or continuous timer and cancel active timers from the same panel. Multiple timers can run together, and the footer stays pinned to show the full running timer list.

### Code Block

Embed a timer launcher in any note with a `game-timer` block:

````md
```game-timer
name: Reinforcements Arrive
duration: 10m
description: Starts the countdown for the next enemy wave.
button: Start Reinforcement Timer
```
````

You can also define time explicitly:

````md
```game-timer
name: Puzzle Pressure
minutes: 5
seconds: 30
```
````

Supported fields:

- `name`
- `duration` such as `10m`, `90s`, or `1h 15m`
- `minutes`
- `seconds`
- `description`
- `button`
- `autostart: true`

### Settings

Under **Settings -> Community Plugins -> Game Timers** you can configure:

- Desktop notifications
- Notice duration
- Repeat notices
- Default minutes
- Default seconds
- Timer presets

Preset warnings are optional. Leave the warnings field empty for a silent preset, or enter comma-separated remaining times such as `5m, 1m, 30s`.

## Installation

Copy the `game-timers` plugin folder into `.obsidian/plugins/` in your vault, then enable it under **Settings -> Community Plugins**.

## Files

- `manifest.json` plugin manifest
- `main.js` plugin logic
- `styles.css` sidebar and code block styling
- `README.md` usage and installation notes
- `LICENSE.md` MIT license
