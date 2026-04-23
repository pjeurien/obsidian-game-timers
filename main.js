"use strict";

const { ItemView, Notice, Plugin, PluginSettingTab, Setting } = require("obsidian");

const VIEW_TYPE_GAME_TIMERS = "game-timers-sidebar";

const DEFAULT_SETTINGS = {
  enableDesktopNotifications: true,
  noticeDurationMs: 12000,
  repeatNotices: 2,
  defaultMinutes: 10,
  defaultSeconds: 0,
  presets: [
    { id: "short-break", name: "Short Break", minutes: 10, seconds: 0 },
    { id: "combat-round", name: "Combat Pressure", minutes: 1, seconds: 0 },
    { id: "long-rest-watch", name: "Watch Change", minutes: 120, seconds: 0 }
  ],
  activeTimers: []
};

class GameTimersPlugin extends Plugin {
  async onload() {
    await this.loadSettings();
    this.activeTimers = Array.isArray(this.settings.activeTimers) ? this.settings.activeTimers : [];
    this.views = new Set();

    this.registerView(
      VIEW_TYPE_GAME_TIMERS,
      (leaf) => new GameTimersView(leaf, this)
    );

    this.addRibbonIcon("timer", "Open Game Timers Sidebar", () => {
      this.activateView();
    });

    this.addCommand({
      id: "open-game-timers-sidebar",
      name: "Open Game Timers Sidebar",
      callback: () => this.activateView()
    });

    this.addCommand({
      id: "start-default-timer",
      name: "Start Default Timer",
      callback: async () => {
        await this.startTimer(
          "Session Timer",
          getDurationMs(this.settings.defaultMinutes, this.settings.defaultSeconds)
        );
        this.activateView();
      }
    });

    this.registerMarkdownCodeBlockProcessor("game-timer", async (source, el) => {
      this.renderTimerCodeBlock(source, el);
    });

    this.addSettingTab(new GameTimersSettingTab(this.app, this));

    this.statusBar = this.addStatusBarItem();
    this.statusBar.addClass("game-timers-status");
    this.statusBar.onClickEvent(() => this.activateView());

    this.registerEvent(this.app.workspace.on("layout-ready", () => {
      this.refreshViews();
      this.updateStatusBar();
    }));

    this.resumeTimers();
    this.startTicker();
    this.updateStatusBar();
  }

  onunload() {
    if (this.tickHandle) {
      window.clearInterval(this.tickHandle);
      this.tickHandle = null;
    }

    this.app.workspace.detachLeavesOfType(VIEW_TYPE_GAME_TIMERS);
  }

  async loadSettings() {
    const loaded = await this.loadData();
    this.settings = Object.assign({}, DEFAULT_SETTINGS, loaded || {});
    this.settings.presets = Array.isArray(this.settings.presets)
      ? this.settings.presets
      : DEFAULT_SETTINGS.presets.slice();
    this.settings.activeTimers = Array.isArray(this.settings.activeTimers)
      ? this.settings.activeTimers
      : [];
  }

  async saveSettings() {
    this.settings.activeTimers = this.activeTimers;
    await this.saveData(this.settings);
    this.updateStatusBar();
    this.refreshViews();
  }

  async activateView() {
    let leaf = this.app.workspace.getLeavesOfType(VIEW_TYPE_GAME_TIMERS)[0];

    if (!leaf) {
      leaf = this.app.workspace.getRightLeaf(false);
      await leaf.setViewState({
        type: VIEW_TYPE_GAME_TIMERS,
        active: true
      });
    }

    this.app.workspace.revealLeaf(leaf);
    this.refreshViews();
  }

  registerViewInstance(view) {
    this.views.add(view);
  }

  unregisterViewInstance(view) {
    this.views.delete(view);
  }

  refreshViews() {
    this.views.forEach((view) => view.render());
  }

  startTicker() {
    if (this.tickHandle) {
      window.clearInterval(this.tickHandle);
    }

    this.tickHandle = window.setInterval(() => {
      this.checkTimers();
      this.updateStatusBar();
      this.refreshViews();
    }, 1000);
  }

  resumeTimers() {
    const now = Date.now();
    const overdue = [];

    this.activeTimers = this.activeTimers.filter((timer) => {
      if (!timer || typeof timer.endsAt !== "number") {
        return false;
      }

      if (timer.endsAt <= now) {
        overdue.push(timer);
        return false;
      }

      return true;
    });

    if (overdue.length) {
      overdue.forEach((timer) => this.notifyTimerFinished(timer));
      this.saveSettings();
    }
  }

  async startTimer(name, totalMs) {
    const safeName = (name || "Session Timer").trim() || "Session Timer";
    const durationMs = Math.max(1000, Math.floor(totalMs));
    const now = Date.now();
    const timer = {
      id: `${now}-${Math.random().toString(36).slice(2, 8)}`,
      name: safeName,
      durationMs,
      startedAt: now,
      endsAt: now + durationMs
    };

    this.activeTimers.push(timer);
    await this.saveSettings();
    new Notice(`Started timer: ${safeName} (${formatDuration(durationMs)})`, 5000);
    return timer;
  }

  async cancelTimer(timerId) {
    const timer = this.activeTimers.find((item) => item.id === timerId);
    this.activeTimers = this.activeTimers.filter((item) => item.id !== timerId);
    await this.saveSettings();

    if (timer) {
      new Notice(`Cancelled timer: ${timer.name}`, 4000);
    }
  }

  async checkTimers() {
    if (!this.activeTimers.length) {
      return;
    }

    const now = Date.now();
    const finished = this.activeTimers.filter((timer) => timer.endsAt <= now);
    if (!finished.length) {
      return;
    }

    this.activeTimers = this.activeTimers.filter((timer) => timer.endsAt > now);
    await this.saveSettings();
    finished.forEach((timer) => this.notifyTimerFinished(timer));
  }

  renderTimerCodeBlock(source, el) {
    const config = parseTimerBlock(source);
    const durationMs = config.durationMs > 0
      ? config.durationMs
      : getDurationMs(this.settings.defaultMinutes, this.settings.defaultSeconds);

    el.empty();
    el.addClass("game-timers-codeblock");

    const card = el.createDiv({ cls: "game-timers-codeblock-card" });
    card.createEl("strong", { text: config.name || "Session Timer" });
    card.createDiv({
      cls: "game-timers-muted",
      text: config.description || `Duration: ${formatDuration(durationMs)}`
    });

    if (config.durationMs <= 0) {
      card.createDiv({
        cls: "game-timers-codeblock-warning",
        text: "Invalid or missing duration. Use duration: 10m, or minutes: 10 with optional seconds: 30."
      });
    }

    const meta = card.createDiv({ cls: "game-timers-codeblock-meta" });
    meta.createSpan({ text: `Timer: ${config.name || "Session Timer"}` });
    meta.createSpan({ text: `Length: ${formatDuration(durationMs)}` });

    const button = card.createEl("button", {
      cls: "mod-cta",
      text: config.buttonLabel || "Start Timer"
    });
    button.disabled = config.durationMs <= 0;
    button.addEventListener("click", async () => {
      await this.startTimer(config.name || "Session Timer", durationMs);
      await this.activateView();
    });

    if (config.autoStart && config.durationMs > 0) {
      const markerKey = `started:${config.name}:${durationMs}`;
      if (el.dataset.gameTimersStarted !== markerKey) {
        el.dataset.gameTimersStarted = markerKey;
        window.setTimeout(async () => {
          await this.startTimer(config.name || "Session Timer", durationMs);
          await this.activateView();
        }, 0);
      }
    }
  }

  async notifyTimerFinished(timer) {
    const repeatCount = Math.max(1, Number(this.settings.repeatNotices) || 1);
    const noticeDuration = Math.max(4000, Number(this.settings.noticeDurationMs) || 12000);
    const message = `Time is up: ${timer.name}`;

    for (let index = 0; index < repeatCount; index += 1) {
      window.setTimeout(() => new Notice(message, noticeDuration), index * 700);
    }

    if (this.settings.enableDesktopNotifications) {
      this.sendDesktopNotification(timer);
    }
  }

  async sendDesktopNotification(timer) {
    if (typeof window === "undefined" || !("Notification" in window)) {
      return;
    }

    if (window.Notification.permission === "default") {
      try {
        await window.Notification.requestPermission();
      } catch (error) {
        console.error("Game Timers: notification permission request failed", error);
      }
    }

    if (window.Notification.permission === "granted") {
      new window.Notification("Game Timer Finished", {
        body: `${timer.name} is done.`,
        silent: false
      });
    }
  }

  updateStatusBar() {
    if (!this.statusBar) {
      return;
    }

    if (!this.activeTimers.length) {
      this.statusBar.setText("No active timers");
      return;
    }

    const nextTimer = this.activeTimers.slice().sort((left, right) => left.endsAt - right.endsAt)[0];
    const remaining = Math.max(0, nextTimer.endsAt - Date.now());
    this.statusBar.setText(`${nextTimer.name}: ${formatRemaining(remaining)}`);
  }
}

class GameTimersView extends ItemView {
  constructor(leaf, plugin) {
    super(leaf);
    this.plugin = plugin;
    this.isBuilt = false;
  }

  getViewType() {
    return VIEW_TYPE_GAME_TIMERS;
  }

  getDisplayText() {
    return "Game Timers";
  }

  getIcon() {
    return "timer";
  }

  async onOpen() {
    this.plugin.registerViewInstance(this);
    this.render();
  }

  async onClose() {
    this.plugin.unregisterViewInstance(this);
  }

  render() {
    if (!this.isBuilt) {
      this.buildView();
      this.isBuilt = true;
    }

    this.renderPresets();
    this.renderActiveTimers();
  }

  buildView() {
    const { contentEl } = this;
    contentEl.empty();
    contentEl.addClass("game-timers-view");

    const wrapper = contentEl.createDiv({ cls: "game-timers-shell" });

    const toolbar = wrapper.createDiv({ cls: "game-timers-toolbar" });
    const titleRow = toolbar.createDiv({ cls: "game-timers-title-row" });
    titleRow.createEl("div", { text: "Game Timers", cls: "game-timers-title" });
    titleRow.createEl("div", {
      text: "Keep pressure on the table with quick countdowns.",
      cls: "game-timers-subtitle"
    });

    const createSection = toolbar.createDiv({ cls: "game-timers-create" });

    this.nameInput = createSection.createEl("input", {
      cls: "game-timers-input",
      type: "text",
      placeholder: "Timer name"
    });
    this.nameInput.value = "Session Timer";

    const durationGrid = createSection.createDiv({ cls: "game-timers-duration-grid" });

    const minutesWrap = durationGrid.createDiv({ cls: "game-timers-field" });
    minutesWrap.createEl("label", { text: "Minutes" });
    this.minutesInput = minutesWrap.createEl("input", {
      cls: "game-timers-input",
      type: "number",
      attr: { min: "0", step: "1" }
    });
    this.minutesInput.value = String(this.plugin.settings.defaultMinutes);

    const secondsWrap = durationGrid.createDiv({ cls: "game-timers-field" });
    secondsWrap.createEl("label", { text: "Seconds" });
    this.secondsInput = secondsWrap.createEl("input", {
      cls: "game-timers-input",
      type: "number",
      attr: { min: "0", max: "59", step: "5" }
    });
    this.secondsInput.value = String(this.plugin.settings.defaultSeconds);

    const startButton = createSection.createEl("button", {
      cls: "mod-cta game-timers-action-button",
      text: "Start Timer"
    });

    startButton.addEventListener("click", async () => {
      const totalMs = getDurationMs(this.minutesInput.value, this.secondsInput.value);
      if (totalMs <= 0) {
        new Notice("Enter a timer longer than 0 seconds.", 4000);
        return;
      }

      await this.plugin.startTimer(this.nameInput.value, totalMs);
      this.resetForm();
      this.renderActiveTimers();
    });

    this.bodyEl = wrapper.createDiv({ cls: "game-timers-body" });

    this.presetSection = this.bodyEl.createDiv({ cls: "game-timers-section" });
    const presetHeader = this.presetSection.createDiv({ cls: "game-timers-section-header" });
    presetHeader.createEl("span", { text: "Presets", cls: "game-timers-section-title" });
    this.presetCountEl = presetHeader.createEl("span", { cls: "game-timers-section-count" });
    this.presetList = this.presetSection.createDiv({ cls: "game-timers-list" });

    this.activeSection = this.bodyEl.createDiv({ cls: "game-timers-section" });
    const activeHeader = this.activeSection.createDiv({ cls: "game-timers-section-header" });
    activeHeader.createEl("span", { text: "Active Timers", cls: "game-timers-section-title" });
    this.activeCountEl = activeHeader.createEl("span", { cls: "game-timers-section-count" });
    this.activeTimersContainer = this.activeSection.createDiv({ cls: "game-timers-list" });

    this.footerEl = wrapper.createDiv({ cls: "game-timers-footer" });
    this.footerLabelEl = this.footerEl.createDiv({
      cls: "game-timers-footer-label",
      text: "Next Timer"
    });
    this.footerTrackEl = this.footerEl.createDiv({
      cls: "game-timers-footer-track",
      text: "No active timers"
    });
    this.footerMetaEl = this.footerEl.createDiv({ cls: "game-timers-footer-meta" });
    this.footerControlsEl = this.footerEl.createDiv({ cls: "game-timers-footer-controls" });
    this.footerPrimaryButton = this.footerControlsEl.createEl("button", {
      cls: "game-timers-footer-btn mod-cta",
      type: "button",
      text: "Start Default"
    });
    this.footerSecondaryButton = this.footerControlsEl.createEl("button", {
      cls: "game-timers-footer-btn",
      type: "button",
      text: "Cancel Next"
    });

    this.footerPrimaryButton.addEventListener("click", async () => {
      await this.plugin.startTimer(
        "Session Timer",
        getDurationMs(this.plugin.settings.defaultMinutes, this.plugin.settings.defaultSeconds)
      );
      this.render();
    });

    this.footerSecondaryButton.addEventListener("click", async () => {
      const nextTimer = this.getNextTimer();
      if (!nextTimer) {
        return;
      }
      await this.plugin.cancelTimer(nextTimer.id);
      this.render();
    });
  }

  resetForm() {
    if (this.nameInput) {
      this.nameInput.value = "Session Timer";
    }
    if (this.minutesInput) {
      this.minutesInput.value = String(this.plugin.settings.defaultMinutes);
    }
    if (this.secondsInput) {
      this.secondsInput.value = String(this.plugin.settings.defaultSeconds);
    }
  }

  renderPresets() {
    if (!this.presetList) {
      return;
    }

    this.presetList.empty();
    const presetCount = this.plugin.settings.presets.length;
    if (this.presetCountEl) {
      this.presetCountEl.textContent = `${presetCount} preset${presetCount === 1 ? "" : "s"}`;
    }

    if (!presetCount) {
      this.presetList.createEl("p", {
        cls: "game-timers-muted",
        text: "No presets yet. Add them in plugin settings."
      });
      return;
    }

    this.plugin.settings.presets.forEach((preset) => {
      const row = this.presetList.createDiv({ cls: "game-timers-list-row" });
      const details = row.createDiv({ cls: "game-timers-list-details" });
      details.createEl("div", { cls: "game-timers-list-title", text: preset.name });
      details.createDiv({
        cls: "game-timers-muted",
        text: formatDuration(getDurationMs(preset.minutes, preset.seconds))
      });

      const button = row.createEl("button", {
        cls: "game-timers-row-button",
        text: "Start"
      });
      button.addEventListener("click", async () => {
        await this.plugin.startTimer(preset.name, getDurationMs(preset.minutes, preset.seconds));
        this.renderActiveTimers();
      });
    });
  }

  renderActiveTimers() {
    if (!this.activeTimersContainer) {
      return;
    }

    this.activeTimersContainer.empty();

    const activeTimers = this.plugin.activeTimers.slice().sort((left, right) => left.endsAt - right.endsAt);
    if (this.activeCountEl) {
      this.activeCountEl.textContent = `${activeTimers.length} active`;
    }
    if (!activeTimers.length) {
      this.activeTimersContainer.createEl("p", {
        cls: "game-timers-muted",
        text: "No active timers right now."
      });
      this.updateFooter(null);
      return;
    }

    activeTimers.forEach((timer) => {
      const row = this.activeTimersContainer.createDiv({ cls: "game-timers-active-card" });
      row.createEl("div", { cls: "game-timers-list-title", text: timer.name });
      row.createDiv({
        cls: "game-timers-time",
        text: formatRemaining(Math.max(0, timer.endsAt - Date.now()))
      });
      row.createDiv({
        cls: "game-timers-muted",
        text: `Total: ${formatDuration(timer.durationMs)}`
      });

      const cancelButton = row.createEl("button", {
        cls: "game-timers-row-button",
        text: "Cancel"
      });
      cancelButton.addEventListener("click", async () => {
        await this.plugin.cancelTimer(timer.id);
        this.renderActiveTimers();
      });
    });

    this.updateFooter(activeTimers[0]);
  }

  getNextTimer() {
    return this.plugin.activeTimers
      .slice()
      .sort((left, right) => left.endsAt - right.endsAt)[0] || null;
  }

  updateFooter(timer) {
    if (!this.footerEl) {
      return;
    }

    if (!timer) {
      this.footerEl.removeClass("game-timers-footer-active");
      this.footerTrackEl.textContent = "No active timers";
      this.footerMetaEl.textContent = `Default: ${formatDuration(
        getDurationMs(this.plugin.settings.defaultMinutes, this.plugin.settings.defaultSeconds)
      )}`;
      this.footerSecondaryButton.disabled = true;
      return;
    }

    this.footerEl.addClass("game-timers-footer-active");
    this.footerTrackEl.textContent = timer.name;
    this.footerMetaEl.textContent = `${formatRemaining(Math.max(0, timer.endsAt - Date.now()))} remaining • Total ${formatDuration(timer.durationMs)}`;
    this.footerSecondaryButton.disabled = false;
  }
}

class GameTimersSettingTab extends PluginSettingTab {
  constructor(app, plugin) {
    super(app, plugin);
    this.plugin = plugin;
  }

  display() {
    const { containerEl } = this;
    containerEl.empty();
    containerEl.addClass("game-timers-settings");

    new Setting(containerEl)
      .setName("Desktop notifications")
      .setDesc("Also send a system notification when a timer finishes.")
      .addToggle((toggle) => {
        toggle.setValue(this.plugin.settings.enableDesktopNotifications).onChange(async (value) => {
          this.plugin.settings.enableDesktopNotifications = value;
          await this.plugin.saveSettings();
        });
      });

    new Setting(containerEl)
      .setName("Notice duration")
      .setDesc("How long the Obsidian in-app notification stays visible.")
      .addText((text) => {
        text
          .setPlaceholder("12000")
          .setValue(String(this.plugin.settings.noticeDurationMs))
          .onChange(async (value) => {
            const parsed = Number(value);
            if (!Number.isNaN(parsed) && parsed >= 4000) {
              this.plugin.settings.noticeDurationMs = parsed;
              await this.plugin.saveSettings();
            }
          });
      });

    new Setting(containerEl)
      .setName("Repeat notices")
      .setDesc("Repeat the alert a few times so it is harder to miss during a session.")
      .addText((text) => {
        text
          .setPlaceholder("2")
          .setValue(String(this.plugin.settings.repeatNotices))
          .onChange(async (value) => {
            const parsed = Number(value);
            if (!Number.isNaN(parsed) && parsed >= 1) {
              this.plugin.settings.repeatNotices = parsed;
              await this.plugin.saveSettings();
            }
          });
      });

    new Setting(containerEl)
      .setName("Default minutes")
      .setDesc("The default minutes pre-filled when creating a timer.")
      .addText((text) => {
        text
          .setPlaceholder("10")
          .setValue(String(this.plugin.settings.defaultMinutes))
          .onChange(async (value) => {
            const parsed = Number(value);
            if (!Number.isNaN(parsed) && parsed >= 0) {
              this.plugin.settings.defaultMinutes = parsed;
              await this.plugin.saveSettings();
            }
          });
      });

    new Setting(containerEl)
      .setName("Default seconds")
      .setDesc("The default seconds pre-filled when creating a timer.")
      .addText((text) => {
        text
          .setPlaceholder("0")
          .setValue(String(this.plugin.settings.defaultSeconds))
          .onChange(async (value) => {
            const parsed = Number(value);
            if (!Number.isNaN(parsed) && parsed >= 0 && parsed < 60) {
              this.plugin.settings.defaultSeconds = parsed;
              await this.plugin.saveSettings();
            }
          });
      });

    containerEl.createEl("h3", { text: "Timer presets" });
    containerEl.createEl("p", {
      cls: "setting-item-description",
      text: "Create named timers you can launch quickly from the sidebar."
    });

    this.plugin.settings.presets.forEach((preset, index) => {
      const presetContainer = containerEl.createDiv({ cls: "game-timers-preset-editor" });

      new Setting(presetContainer)
        .setName(`Preset ${index + 1}`)
        .addText((text) => {
          text.setPlaceholder("Name").setValue(preset.name).onChange(async (value) => {
            preset.name = value || `Preset ${index + 1}`;
            await this.plugin.saveSettings();
          });
        })
        .addText((text) => {
          text.setPlaceholder("Minutes").setValue(String(preset.minutes)).onChange(async (value) => {
            const parsed = Number(value);
            if (!Number.isNaN(parsed) && parsed >= 0) {
              preset.minutes = parsed;
              await this.plugin.saveSettings();
            }
          });
        })
        .addText((text) => {
          text.setPlaceholder("Seconds").setValue(String(preset.seconds)).onChange(async (value) => {
            const parsed = Number(value);
            if (!Number.isNaN(parsed) && parsed >= 0 && parsed < 60) {
              preset.seconds = parsed;
              await this.plugin.saveSettings();
            }
          });
        })
        .addButton((button) => {
          button.setButtonText("Delete").setWarning().onClick(async () => {
            this.plugin.settings.presets = this.plugin.settings.presets.filter((item) => item.id !== preset.id);
            await this.plugin.saveSettings();
            this.display();
          });
        });
    });

    new Setting(containerEl)
      .setName("Add preset")
      .setDesc("Add a new reusable timer preset.")
      .addButton((button) => {
        button.setButtonText("Add").setCta().onClick(async () => {
          this.plugin.settings.presets.push({
            id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
            name: "New Preset",
            minutes: 5,
            seconds: 0
          });
          await this.plugin.saveSettings();
          this.display();
        });
      });
  }
}

function getDurationMs(minutesValue, secondsValue) {
  const minutes = Math.max(0, Number(minutesValue) || 0);
  const seconds = Math.max(0, Number(secondsValue) || 0);
  return ((minutes * 60) + seconds) * 1000;
}

function parseTimerBlock(source) {
  const config = {
    name: "Session Timer",
    description: "",
    buttonLabel: "Start Timer",
    autoStart: false,
    durationMs: 0
  };
  let explicitMinutes = null;
  let explicitSeconds = null;

  const lines = source
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);

  lines.forEach((line) => {
    const separatorIndex = line.indexOf(":");
    if (separatorIndex === -1) {
      return;
    }

    const key = line.slice(0, separatorIndex).trim().toLowerCase();
    const value = line.slice(separatorIndex + 1).trim();

    if (!value) {
      return;
    }

    if (key === "name" || key === "title") {
      config.name = value;
      return;
    }

    if (key === "description" || key === "note") {
      config.description = value;
      return;
    }

    if (key === "button" || key === "label") {
      config.buttonLabel = value;
      return;
    }

    if (key === "autostart" || key === "auto-start") {
      config.autoStart = isTruthy(value);
      return;
    }

    if (key === "minutes") {
      explicitMinutes = Number(value);
      return;
    }

    if (key === "seconds") {
      explicitSeconds = Number(value);
      return;
    }

    if (key === "duration" || key === "time") {
      config.durationMs = parseDurationText(value);
    }
  });

  if (explicitMinutes !== null || explicitSeconds !== null) {
    config.durationMs = getDurationMs(explicitMinutes || 0, explicitSeconds || 0);
  }

  return config;
}

function parseDurationText(value) {
  const normalized = String(value || "").trim().toLowerCase();
  if (!normalized) {
    return 0;
  }

  if (/^\d+$/.test(normalized)) {
    return Number(normalized) * 1000;
  }

  let totalSeconds = 0;
  const regex = /(\d+)\s*(h|hr|hrs|hour|hours|m|min|mins|minute|minutes|s|sec|secs|second|seconds)\b/g;
  let match = regex.exec(normalized);

  while (match) {
    const amount = Number(match[1]);
    const unit = match[2];

    if (unit.startsWith("h")) {
      totalSeconds += amount * 3600;
    } else if (unit.startsWith("m")) {
      totalSeconds += amount * 60;
    } else {
      totalSeconds += amount;
    }

    match = regex.exec(normalized);
  }

  return totalSeconds * 1000;
}

function isTruthy(value) {
  return ["true", "yes", "1", "on"].includes(String(value || "").trim().toLowerCase());
}

function formatDuration(durationMs) {
  const totalSeconds = Math.max(0, Math.floor(durationMs / 1000));
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;

  if (hours > 0) {
    if (minutes > 0) {
      return `${hours}h ${minutes}m`;
    }
    return `${hours}h`;
  }

  if (minutes && seconds) {
    return `${minutes}m ${seconds}s`;
  }

  if (minutes) {
    return `${minutes}m`;
  }

  return `${seconds}s`;
}

function formatRemaining(durationMs) {
  const totalSeconds = Math.max(0, Math.ceil(durationMs / 1000));
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;

  if (hours > 0) {
    return `${hours}:${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}`;
  }

  return `${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}`;
}

module.exports = GameTimersPlugin;
