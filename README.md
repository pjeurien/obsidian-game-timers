# Game Timers

An Obsidian plugin for DM-facing countdown timers in a dedicated sidebar.

## Features

- Dedicated sidebar for creating and monitoring countdown timers
- Quick custom timers with configurable default minutes and seconds
- Reusable presets managed from plugin settings
- Active timers persist across Obsidian reloads
- Obsidian notices when a timer finishes
- Optional desktop notifications
- `game-timer` markdown code blocks for launching timers directly from notes
- Status bar summary for the next timer to expire

## Usage

### Sidebar

Open the sidebar from any of these entry points:

- The timer ribbon icon
- The command palette with `Open Game Timers Sidebar`
- The status bar timer readout

From the sidebar you can:

1. Enter a timer name
2. Set minutes and seconds
3. Click **Start Timer**

You can also start any saved preset with one click and cancel active timers from the same panel.

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

## Installation

Copy the `game-timers` plugin folder into `.obsidian/plugins/` in your vault, then enable it under **Settings -> Community Plugins**.

## Files

- `manifest.json` plugin manifest
- `main.js` plugin logic
- `styles.css` sidebar and code block styling
- `README.md` usage and installation notes
- `LICENSE.md` MIT license
