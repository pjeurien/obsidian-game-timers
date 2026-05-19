"use strict";

const { ItemView, Notice, Plugin, PluginSettingTab, Setting, setIcon } = require("obsidian");

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

    this.registerView(
      VIEW_TYPE_GAME_TIMERS,
      (leaf) => new GameTimersView(leaf, this)
    );

    this.addRibbonIcon("timer", "Open Game Timers Sidebar", () => {
      this.activateView();
    });

    this.addCommand({
      id: "open-game-timers-sidebar",
      name: "Open game timers sidebar",
      callback: () => this.activateView()
    });

    this.addCommand({
      id: "start-default-timer",
      name: "Start default timer",
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

  refreshViews() {
    this.app.workspace.getLeavesOfType(VIEW_TYPE_GAME_TIMERS).forEach((leaf) => {
      if (leaf.view instanceof GameTimersView) {
        leaf.view.render();
      }
    });
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

    this.activeTimers = this.activeTimers.reduce((timers, timer) => {
      if (!timer || typeof timer.endsAt !== "number") {
        return timers;
      }

      if (timer.paused) {
        timer.warningOffsetsMs = normalizeWarningOffsets(timer.warningOffsetsMs, timer.durationMs);
        timer.pendingWarningsMs = Array.isArray(timer.pendingWarningsMs)
          ? normalizeWarningOffsets(timer.pendingWarningsMs, timer.durationMs)
          : timer.warningOffsetsMs.slice();
        timers.push(timer);
        return timers;
      }

      if (timer.endsAt <= now) {
        overdue.push(timer);
        if (timer.continuous) {
          const warningOffsetsMs = normalizeWarningOffsets(timer.warningOffsetsMs, timer.durationMs);
          timers.push({
            ...timer,
            warningOffsetsMs,
            pendingWarningsMs: warningOffsetsMs.slice(),
            startedAt: now,
            endsAt: now + timer.durationMs
          });
        }
        return timers;
      }

      timer.warningOffsetsMs = normalizeWarningOffsets(timer.warningOffsetsMs, timer.durationMs);
      timer.pendingWarningsMs = Array.isArray(timer.pendingWarningsMs)
        ? normalizeWarningOffsets(timer.pendingWarningsMs, timer.durationMs)
        : timer.warningOffsetsMs.filter((warningMs) => Math.max(0, timer.endsAt - now) > warningMs);
      timers.push(timer);
      return timers;
    }, []);

    if (overdue.length) {
      overdue.forEach((timer) => this.notifyTimerFinished(timer));
      this.saveSettings();
    }
  }

  async startTimer(name, totalMs, continuous = false, warningOffsetsMs = [], color = "") {
    const safeName = (name || "Session Timer").trim() || "Session Timer";
    const durationMs = Math.max(1000, Math.floor(totalMs));
    const warnings = normalizeWarningOffsets(warningOffsetsMs, durationMs);
    const safeColor = normalizeColor(color);
    const now = Date.now();
    const timer = {
      id: `${now}-${Math.random().toString(36).slice(2, 8)}`,
      name: safeName,
      durationMs,
      startedAt: now,
      endsAt: now + durationMs,
      continuous: Boolean(continuous),
      warningOffsetsMs: warnings,
      pendingWarningsMs: warnings.slice()
    };
    if (safeColor) {
      timer.color = safeColor;
    }

    this.activeTimers.push(timer);
    await this.saveSettings();
    new Notice(`Started ${timer.continuous ? "continuous " : ""}timer: ${safeName} (${formatDuration(durationMs)})`, 5000);
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

  async resetTimer(timerId) {
    const now = Date.now();
    const timer = this.activeTimers.find((item) => item.id === timerId);
    if (!timer) {
      return;
    }

    timer.paused = false;
    delete timer.pausedRemainingMs;
    timer.startedAt = now;
    timer.endsAt = now + timer.durationMs;
    timer.pendingWarningsMs = timer.warningOffsetsMs.slice();
    await this.saveSettings();
    new Notice(`Reset timer: ${timer.name}`, 3000);
  }

  async pauseTimer(timerId) {
    const now = Date.now();
    const timer = this.activeTimers.find((item) => item.id === timerId);
    if (!timer || timer.paused) {
      return;
    }

    timer.paused = true;
    timer.pausedRemainingMs = Math.max(0, timer.endsAt - now);
    await this.saveSettings();
  }

  async resumeTimer(timerId) {
    const now = Date.now();
    const timer = this.activeTimers.find((item) => item.id === timerId);
    if (!timer || !timer.paused) {
      return;
    }

    timer.paused = false;
    timer.endsAt = now + Math.max(1000, Number(timer.pausedRemainingMs) || timer.durationMs);
    delete timer.pausedRemainingMs;
    await this.saveSettings();
  }

  async checkTimers() {
    if (!this.activeTimers.length) {
      return;
    }

    const now = Date.now();
    const finished = [];
    const warnings = [];
    this.activeTimers = this.activeTimers.reduce((timers, timer) => {
      if (timer.paused) {
        timers.push(timer);
        return timers;
      }

      if (timer.endsAt > now) {
        const pendingWarnings = Array.isArray(timer.pendingWarningsMs) ? timer.pendingWarningsMs : [];
        const remainingMs = Math.max(0, timer.endsAt - now);
        timer.pendingWarningsMs = pendingWarnings.filter((warningMs) => {
          if (remainingMs <= warningMs) {
            warnings.push({ timer, warningMs });
            return false;
          }
          return true;
        });
        timers.push(timer);
        return timers;
      }

      finished.push(timer);
      if (timer.continuous) {
        const warningOffsetsMs = normalizeWarningOffsets(timer.warningOffsetsMs, timer.durationMs);
        timers.push({
          ...timer,
          warningOffsetsMs,
          pendingWarningsMs: warningOffsetsMs.slice(),
          startedAt: now,
          endsAt: now + timer.durationMs
        });
      }
      return timers;
    }, []);

    if (!finished.length) {
      return;
    }

    await this.saveSettings();
    warnings.forEach(({ timer, warningMs }) => this.notifyTimerWarning(timer, warningMs));
    finished.forEach((timer) => this.notifyTimerFinished(timer));
  }

  notifyTimerWarning(timer, warningMs) {
    new Notice(`${timer.name}: ${formatDuration(warningMs)} remaining`, 5000);
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

    const buttonRow = card.createDiv({ cls: "game-timers-button-row" });
    const startOnceButton = buttonRow.createEl("button", {
      cls: "game-timers-codeblock-button",
      text: config.buttonLabel || "Start once"
    });
    startOnceButton.disabled = config.durationMs <= 0;
    startOnceButton.addEventListener("click", async () => {
      await this.startTimer(config.name || "Session Timer", durationMs, false);
      await this.activateView();
    });

    const startContinuousButton = buttonRow.createEl("button", {
      cls: "game-timers-codeblock-button",
      text: "Start continuously"
    });
    startContinuousButton.disabled = config.durationMs <= 0;
    startContinuousButton.addEventListener("click", async () => {
      await this.startTimer(config.name || "Session Timer", durationMs, true);
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

    const nextTimer = this.activeTimers
      .filter((timer) => !timer.paused)
      .sort((left, right) => left.endsAt - right.endsAt)[0];
    if (!nextTimer) {
      this.statusBar.setText("All timers paused");
      return;
    }

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
    this.render();
  }

  async onClose() {
  }

  render() {
    if (!this.isBuilt) {
      this.buildView();
      this.isBuilt = true;
    }

    this.renderPresets();
    this.renderRunningTimersFromState();
  }

  buildView() {
    const { contentEl } = this;
    contentEl.empty();
    contentEl.addClass("game-timers-view");

    const wrapper = contentEl.createDiv({ cls: "game-timers-shell" });

    const toolbar = wrapper.createDiv({ cls: "game-timers-toolbar" });
    const titleRow = toolbar.createDiv({ cls: "game-timers-title-row" });
    const titleText = titleRow.createDiv({ cls: "game-timers-title-text" });
    titleText.createEl("div", { text: "Game Timers", cls: "game-timers-title" });
    titleText.createEl("div", {
      text: "Keep pressure on the table with quick countdowns.",
      cls: "game-timers-subtitle"
    });
    const settingsButton = titleRow.createEl("button", {
      cls: "game-timers-cog-btn",
      type: "button",
      attr: { "aria-label": "Game Timers settings" }
    });
    setIcon(settingsButton, "settings");
    settingsButton.addEventListener("click", () => {
      this.plugin.app.setting.open();
      this.plugin.app.setting.openTabById("game-timers");
    });

    const sessionSection = toolbar.createDiv({ cls: "game-timers-session-alert" });
    const sessionTimeWrap = sessionSection.createDiv({ cls: "game-timers-field" });
    sessionTimeWrap.createEl("label", { text: "Session ends at" });
    const sessionTimeControls = sessionTimeWrap.createDiv({ cls: "game-timers-clock-selectors" });
    const hourOptions = Array.from({ length: 24 }, (_, i) => String(i).padStart(2, "0"));
    const minuteOptions = Array.from({ length: 60 }, (_, i) => String(i).padStart(2, "0"));
    this.sessionHourSelect = createCustomSelect(sessionTimeControls, hourOptions, "00", "Session ending hour");
    sessionTimeControls.createSpan({ cls: "game-timers-clock-separator", text: ":" });
    this.sessionMinuteSelect = createCustomSelect(sessionTimeControls, minuteOptions, "00", "Session ending minute");
    const sessionAlertButton = sessionSection.createEl("button", {
      cls: "game-timers-action-button",
      text: "Set session alert"
    });
    sessionAlertButton.addEventListener("click", async () => this.startSessionEndAlert());

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

    const startButtonRow = createSection.createDiv({ cls: "game-timers-button-row" });
    const startOnceButton = startButtonRow.createEl("button", {
      cls: "game-timers-action-button",
      text: "Start once"
    });
    startOnceButton.addEventListener("click", async () => this.startTimerFromForm(false));

    const startContinuousButton = startButtonRow.createEl("button", {
      cls: "game-timers-action-button",
      text: "Start continuously"
    });
    startContinuousButton.addEventListener("click", async () => this.startTimerFromForm(true));

    this.bodyEl = wrapper.createDiv({ cls: "game-timers-body" });

    this.presetSection = this.bodyEl.createDiv({ cls: "game-timers-section" });
    const presetHeader = this.presetSection.createDiv({ cls: "game-timers-section-header" });
    presetHeader.createEl("span", { text: "Presets", cls: "game-timers-section-title" });
    this.presetCountEl = presetHeader.createEl("span", { cls: "game-timers-section-count" });
    this.presetList = this.presetSection.createDiv({ cls: "game-timers-list" });

    this.footerEl = wrapper.createDiv({ cls: "game-timers-footer" });
    this.footerLabelEl = this.footerEl.createDiv({
      cls: "game-timers-footer-label",
      text: "Running timers"
    });
    this.runningTimersListEl = this.footerEl.createDiv({ cls: "game-timers-running-list" });
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

    const presetsKey = JSON.stringify(this.plugin.settings.presets);
    if (presetsKey === this._lastPresetsKey) {
      return;
    }
    this._lastPresetsKey = presetsKey;

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
      applyTimerColor(row, preset.color);
      const details = row.createDiv({ cls: "game-timers-list-details" });
      const titleRow = details.createDiv({ cls: "game-timers-list-title-row" });
      titleRow.createSpan({ cls: "game-timers-color-dot" });
      titleRow.createEl("div", { cls: "game-timers-list-title", text: preset.name });
      details.createDiv({
        cls: "game-timers-muted",
        text: getPresetSummary(preset)
      });

      const buttonRow = row.createDiv({ cls: "game-timers-button-row" });
      const startOnceButton = buttonRow.createEl("button", {
        cls: "game-timers-row-button",
        text: "Start once"
      });
      startOnceButton.addEventListener("click", async () => {
        await this.plugin.startTimer(
          preset.name,
          getDurationMs(preset.minutes, preset.seconds),
          false,
          getPresetWarnings(preset),
          preset.color
        );
        this.renderRunningTimersFromState();
      });

      const startContinuousButton = buttonRow.createEl("button", {
        cls: "game-timers-row-button",
        text: "Start continuously"
      });
      startContinuousButton.addEventListener("click", async () => {
        await this.plugin.startTimer(
          preset.name,
          getDurationMs(preset.minutes, preset.seconds),
          true,
          getPresetWarnings(preset),
          preset.color
        );
        this.renderRunningTimersFromState();
      });
    });
  }

  renderRunningTimersFromState() {
    const activeTimers = this.plugin.activeTimers.slice().sort((left, right) => {
      return getTimerRemainingMs(left) - getTimerRemainingMs(right);
    });

    const stateKey = activeTimers.map((t) => `${t.id}:${t.paused ? 1 : 0}:${t.continuous ? 1 : 0}`).join("|");
    if (stateKey === this._lastTimerStateKey && this.runningTimersListEl) {
      const timeEls = this.runningTimersListEl.querySelectorAll(".game-timers-running-time");
      activeTimers.forEach((timer, index) => {
        if (timeEls[index]) {
          timeEls[index].textContent = formatRemaining(getTimerRemainingMs(timer));
        }
      });
      return;
    }
    this._lastTimerStateKey = stateKey;

    this.renderRunningTimers(activeTimers);
  }

  async startTimerFromForm(continuous) {
    const totalMs = getDurationMs(this.minutesInput.value, this.secondsInput.value);
    if (totalMs <= 0) {
      new Notice("Enter a timer longer than 0 seconds.", 4000);
      return;
    }

    await this.plugin.startTimer(this.nameInput.value, totalMs, continuous);
    this.resetForm();
    this.renderRunningTimersFromState();
  }

  async startSessionEndAlert() {
    const target = getNextClockTime(`${this.sessionHourSelect.value}:${this.sessionMinuteSelect.value}`);
    if (!target) {
      new Notice("Choose a session ending time.", 4000);
      return;
    }

    const durationMs = target.getTime() - Date.now();
    await this.plugin.startTimer("Session Ending", durationMs, false);
    new Notice(`Session ending alert set for ${formatClockTime(target)}.`, 5000);
    this.renderRunningTimersFromState();
  }

  renderRunningTimers(activeTimers) {
    if (!this.runningTimersListEl) {
      return;
    }

    this.runningTimersListEl.empty();

    if (!activeTimers.length) {
      this.footerEl.removeClass("game-timers-footer-active");
      this.runningTimersListEl.createEl("div", {
        cls: "game-timers-running-empty",
        text: "No active timers"
      });
      return;
    }

    this.footerEl.addClass("game-timers-footer-active");
    activeTimers.forEach((timer, index) => this.addRunningTimerRow(timer, index));
  }

  addRunningTimerRow(timer, index) {
    const row = this.runningTimersListEl.createDiv({
      cls: `game-timers-running-row game-timers-running-${index % 3}${timer.continuous ? " game-timers-running-continuous" : ""}${timer.paused ? " game-timers-running-paused" : ""}`
    });
    applyTimerColor(row, timer.color);

    row.createEl("span", {
      cls: "game-timers-running-time",
      text: formatRemaining(getTimerRemainingMs(timer))
    });
    row.createEl("span", {
      cls: "game-timers-running-name",
      text: timer.name
    });
    if (timer.continuous) {
      row.createEl("span", {
        cls: "game-timers-running-badge",
        text: "Loop"
      });
    }

    const controls = row.createDiv({ cls: "game-timers-running-controls" });
    const pauseButton = controls.createEl("button", {
      cls: "game-timers-running-btn",
      type: "button",
      attr: { "aria-label": `${timer.paused ? "Resume" : "Pause"} ${timer.name}` }
    });
    setIcon(pauseButton, timer.paused ? "play" : "pause");
    pauseButton.addEventListener("click", async () => {
      if (timer.paused) {
        await this.plugin.resumeTimer(timer.id);
      } else {
        await this.plugin.pauseTimer(timer.id);
      }
      this.renderRunningTimersFromState();
    });

    const resetButton = controls.createEl("button", {
      cls: "game-timers-running-btn",
      type: "button",
      attr: { "aria-label": `Reset ${timer.name}` }
    });
    setIcon(resetButton, "rotate-ccw");
    resetButton.addEventListener("click", async () => {
      await this.plugin.resetTimer(timer.id);
      this.renderRunningTimersFromState();
    });

    const cancelButton = controls.createEl("button", {
      cls: "game-timers-running-btn",
      type: "button",
      attr: { "aria-label": `Cancel ${timer.name}` }
    });
    setIcon(cancelButton, "trash-2");
    cancelButton.addEventListener("click", async () => {
      await this.plugin.cancelTimer(timer.id);
      this.renderRunningTimersFromState();
    });
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

    new Setting(containerEl).setName("Timer presets").setHeading();
    containerEl.createEl("p", {
      cls: "setting-item-description",
      text: "Create named timers you can launch quickly from the sidebar."
    });

    this.plugin.settings.presets.forEach((preset, index) => {
      const presetContainer = containerEl.createDiv({ cls: "game-timers-preset-editor" });

      new Setting(presetContainer)
        .setName(`Preset ${index + 1}`)
        .setDesc("Saved timer shown in the sidebar.")
        .addButton((button) => {
          button.setButtonText("Delete").setWarning().onClick(async () => {
            this.plugin.settings.presets = this.plugin.settings.presets.filter((item) => item.id !== preset.id);
            await this.plugin.saveSettings();
            this.display();
          });
        });

      const fields = presetContainer.createDiv({ cls: "game-timers-preset-fields" });
      this.addPresetTextField(fields, "Name", preset.name, "Timer name", async (value) => {
        preset.name = value || `Preset ${index + 1}`;
        await this.plugin.saveSettings();
      });
      this.addPresetTextField(fields, "Minutes", String(preset.minutes), "0", async (value) => {
        const parsed = Number(value);
        if (!Number.isNaN(parsed) && parsed >= 0) {
          preset.minutes = parsed;
          await this.plugin.saveSettings();
        }
      }, "number");
      this.addPresetTextField(fields, "Seconds", String(preset.seconds), "0-59", async (value) => {
        const parsed = Number(value);
        if (!Number.isNaN(parsed) && parsed >= 0 && parsed < 60) {
          preset.seconds = parsed;
          await this.plugin.saveSettings();
        }
      }, "number");
      this.addPresetTextField(fields, "Warnings", preset.warningTimes || "", "Optional: 1m, 30s", async (value) => {
        preset.warningTimes = value.trim();
        await this.plugin.saveSettings();
      });
      this.addPresetColorField(fields, "Color", preset.color || "", async (value) => {
        preset.color = normalizeColor(value);
        await this.plugin.saveSettings();
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
            seconds: 0,
            warningTimes: "",
            color: ""
          });
          await this.plugin.saveSettings();
          this.display();
        });
      });
  }

  addPresetTextField(parentEl, label, value, placeholder, onChange, type = "text") {
    const field = parentEl.createDiv({ cls: "game-timers-preset-field" });
    field.createEl("label", { text: label });
    const input = field.createEl("input", {
      cls: "game-timers-settings-input",
      type,
      attr: { placeholder }
    });
    input.value = value;
    input.addEventListener("change", async () => {
      await onChange(input.value);
    });
    return input;
  }

  addPresetColorField(parentEl, label, value, onChange) {
    const field = parentEl.createDiv({ cls: "game-timers-preset-field" });
    field.createEl("label", { text: label });
    const colorRow = field.createDiv({ cls: "game-timers-color-input-row" });
    const colorInput = colorRow.createEl("input", {
      cls: "game-timers-color-input",
      type: "color"
    });
    colorInput.value = normalizeColor(value) || "#4caf50";
    const clearButton = colorRow.createEl("button", {
      cls: "game-timers-color-clear",
      type: "button",
      text: "Clear"
    });
    colorInput.addEventListener("change", async () => {
      await onChange(colorInput.value);
    });
    clearButton.addEventListener("click", async () => {
      colorInput.value = "#4caf50";
      await onChange("");
    });
    return colorInput;
  }
}

function getDurationMs(minutesValue, secondsValue) {
  const minutes = Math.max(0, Number(minutesValue) || 0);
  const seconds = Math.max(0, Number(secondsValue) || 0);
  return ((minutes * 60) + seconds) * 1000;
}

function getNextClockTime(value) {
  if (!value || !/^\d{2}:\d{2}$/.test(value)) {
    return null;
  }

  const [hoursText, minutesText] = value.split(":");
  const hours = Number(hoursText);
  const minutes = Number(minutesText);
  if (Number.isNaN(hours) || Number.isNaN(minutes) || hours > 23 || minutes > 59) {
    return null;
  }

  const now = new Date();
  const target = new Date(now);
  target.setHours(hours, minutes, 0, 0);
  if (target.getTime() <= now.getTime()) {
    target.setDate(target.getDate() + 1);
  }
  return target;
}

function formatClockTime(date) {
  return date.toLocaleTimeString([], {
    hour: "2-digit",
    minute: "2-digit"
  });
}

function getPresetWarnings(preset) {
  return parseWarningTimes(preset.warningTimes);
}

function getPresetSummary(preset) {
  const durationText = formatDuration(getDurationMs(preset.minutes, preset.seconds));
  const warnings = getPresetWarnings(preset);
  if (!warnings.length) {
    return durationText;
  }

  return `${durationText} • warns at ${warnings.map(formatDuration).join(", ")}`;
}

function parseWarningTimes(value) {
  if (!value || typeof value !== "string") {
    return [];
  }

  return value
    .split(",")
    .map((item) => parseDurationText(item.trim()))
    .filter((item) => item > 0);
}

function normalizeWarningOffsets(warningOffsetsMs, durationMs) {
  const seen = new Set();
  return (Array.isArray(warningOffsetsMs) ? warningOffsetsMs : [])
    .map((item) => Math.floor(Number(item) || 0))
    .filter((item) => item > 0 && item < durationMs)
    .sort((left, right) => right - left)
    .filter((item) => {
      if (seen.has(item)) {
        return false;
      }
      seen.add(item);
      return true;
    });
}

function normalizeColor(value) {
  if (typeof value !== "string") {
    return "";
  }

  const color = value.trim();
  return /^#[0-9a-f]{6}$/i.test(color) ? color.toLowerCase() : "";
}

function applyTimerColor(el, color) {
  const safeColor = normalizeColor(color);
  if (!safeColor) {
    return;
  }

  el.style.setProperty("--game-timer-color", safeColor);
  el.style.setProperty("--game-timer-color-bg", hexToRgba(safeColor, 0.12));
}

function hexToRgba(hex, alpha) {
  const value = hex.replace("#", "");
  const red = parseInt(value.slice(0, 2), 16);
  const green = parseInt(value.slice(2, 4), 16);
  const blue = parseInt(value.slice(4, 6), 16);
  return `rgba(${red}, ${green}, ${blue}, ${alpha})`;
}

function getTimerRemainingMs(timer) {
  if (timer.paused) {
    return Math.max(0, Number(timer.pausedRemainingMs) || 0);
  }

  return Math.max(0, timer.endsAt - Date.now());
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

function createCustomSelect(parentEl, optionValues, initialValue, ariaLabel) {
  const wrapper = parentEl.createDiv({ cls: "game-timers-custom-select" });
  let currentValue = initialValue || optionValues[0];
  let isOpen = false;
  let listEl = null;
  let outsideHandler = null;

  const trigger = wrapper.createEl("button", {
    cls: "game-timers-custom-select-trigger",
    type: "button",
    attr: { "aria-label": ariaLabel }
  });
  trigger.textContent = currentValue;

  function close() {
    if (!isOpen) { return; }
    if (listEl) { listEl.remove(); listEl = null; }
    if (outsideHandler) {
      document.removeEventListener("mousedown", outsideHandler);
      outsideHandler = null;
    }
    isOpen = false;
  }

  function open() {
    if (isOpen) { close(); return; }
    isOpen = true;
    listEl = wrapper.createDiv({ cls: "game-timers-custom-select-list" });

    let selectedItem = null;
    optionValues.forEach((val) => {
      const item = listEl.createDiv({
        cls: "game-timers-custom-select-option" + (val === currentValue ? " is-selected" : "")
      });
      item.textContent = val;
      if (val === currentValue) { selectedItem = item; }
      item.addEventListener("mousedown", (e) => {
        e.preventDefault();
        currentValue = val;
        trigger.textContent = val;
        close();
      });
    });

    if (selectedItem) {
      window.setTimeout(() => selectedItem.scrollIntoView({ block: "nearest" }), 0);
    }

    outsideHandler = (e) => {
      if (!wrapper.contains(e.target)) { close(); }
    };
    window.setTimeout(() => document.addEventListener("mousedown", outsideHandler), 0);
  }

  trigger.addEventListener("click", (e) => {
    e.stopPropagation();
    open();
  });

  return {
    get value() { return currentValue; }
  };
}

module.exports = GameTimersPlugin;
