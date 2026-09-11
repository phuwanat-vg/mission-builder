/**
 * The application shell: the top bar, the three columns and the Activity bar,
 * and everything that talks to the robot.
 *
 * One `foxglove_bridge` WebSocket carries all of it: the map, TF and the live
 * robot as ordinary topics, and the whole `mission_runner` HTTP API through the
 * ROS service `/mission/api`. Every piece degrades on its own — no bridge, no
 * `/mission/api`, or a runner that is offline — and says so in a sentence while
 * the mission can still be edited and exported.
 */

import { FoxgloveConnection } from "../net/FoxgloveConnection";
import type { ConnectionState } from "../net/FoxgloveConnection";
import { MissionApi, MissionApiError } from "../mission/MissionApi";
import type { ApiFinding, ConnectorState, MissionSummary, Run, RunnerEvent, RunnerStatus } from "../mission/MissionApi";
import { RouteStore } from "../mission/RouteStore";
import { assignIds } from "../mission/ids";
import { validate } from "../mission/validate";
import type { Capabilities } from "../mission/MissionApi";
import type { Finding, Mission, Path, SitesDoc } from "../mission/types";
import { MISSION_SCHEMA_ID, SITES_SCHEMA_ID } from "../mission/types";
import { loadSettings, saveSettings } from "../state/settings";
import type { AppSettings } from "../state/settings";
import { THEME_LABELS, THEME_NAMES, applyTheme } from "./theme";
import type { ThemeName } from "./theme";
import { checkForUpdate, getAppVersion, installUpdateAndRestart, isDesktop } from "../updater";
import type { UpdateInfo } from "../updater";
import { h } from "./dom";
import { icon, setButtonContent } from "./icons";
import { MissionTree } from "./MissionTree";
import type { StepRunState } from "./MissionTree";
import { Properties } from "./Properties";
import { MapsPanel } from "./MapsPanel";
import { Activity } from "./Activity";
import { MapView } from "./MapView";
import { exportBehaviorTrees, exportPython, showExport } from "./exports";
import type { FormContext } from "./ActionForm";
import { openMenu } from "./StepPicker";
import { poseSiteRef } from "../mission/blocks";
import { getStepAt, walkSteps } from "../mission/ids";
import { buildTree, findNode } from "../mission/tree";

export class App {
  readonly conn = new FoxgloveConnection();
  readonly store = new RouteStore();
  readonly api = new MissionApi(this.conn);
  readonly settings: AppSettings;

  #tree: MissionTree;
  #props: Properties;
  #maps: MapsPanel;
  #activity: Activity;
  /** The map column. Public so the shell's keyboard handling can reach it. */
  map!: MapView;

  // top bar
  #urlInput!: HTMLInputElement;
  #connectBtn!: HTMLButtonElement;
  #statusEl!: HTMLElement;
  #stateEl!: HTMLElement;
  #runBtn!: HTMLButtonElement;
  #pauseBtn!: HTMLButtonElement;
  #stopBtn!: HTMLButtonElement;
  #deployBtn!: HTMLButtonElement;
  #treeToggle!: HTMLButtonElement;
  #tabSelection!: HTMLButtonElement;
  #tabMaps!: HTMLButtonElement;
  #noticeEl!: HTMLElement;
  #toastsEl!: HTMLElement;

  #missions: MissionSummary[] = [];
  #connectors: Record<string, ConnectorState> = {};
  #capabilities: Capabilities | null = null;
  #findings: Finding[] = [];
  #runState = new Map<string, StepRunState>();
  #stepStart = new Map<string, number>();
  #status: RunnerStatus | null = null;
  #lastToast = new Map<string, number>();
  #busy = false;

  constructor(root: HTMLElement) {
    this.settings = loadSettings();
    // Before anything is built: every colour in the shell and in the scene
    // comes from the variables this attribute selects.
    applyTheme(this.settings.theme);
    const { treeSlot, viewSlot, propsSlot, activitySlot } = this.#buildShell(root);

    this.#tree = new MissionTree({
      store: this.store,
      missionList: () => this.#missions,
      openMission: (name) => void this.#openMission(name),
      createMission: () => this.#createMission(),
      deleteMission: (name) => void this.#deleteMission(name),
      exportPython: () => this.#exportPython(),
      exportBt: () => this.#exportBt(),
      findings: () => this.#findings,
      runState: () => this.#runState,
      running: () => this.#status?.run?.mission !== undefined && this.#status.run.mission === this.store.mission?.name && (this.#status.state === "running" || this.#status.state === "paused"),
      refresh: () => this.refresh(),
      toast: (m, k) => this.toast(m, k),
    });
    this.#props = new Properties({
      store: this.store,
      formContext: () => this.formContext(),
      findings: () => this.#findings,
      refresh: () => this.refresh(),
      focusPoint: (name) => this.map.focusPoint(name),
      toast: (m, k) => this.toast(m, k),
    });
    this.#maps = new MapsPanel({
      store: this.store,
      currentMap: () => this.#status?.current_map ?? null,
      showMap: (name) => {
        this.store.setMapName(name);
        this.refresh();
        this.map.fit();
      },
      changeRobotMap: (name) => void this.#changeRobotMap(name),
      refresh: () => this.refresh(),
      toast: (m, k) => this.toast(m, k),
    });
    this.#activity = new Activity({
      loadHistory: () => void this.#loadHistory(),
      answerPrompt: (id, answer) => void this.#answerPrompt(id, answer),
    });
    this.map = new MapView({
      conn: this.conn,
      store: this.store,
      refresh: () => this.refresh(),
    });

    treeSlot.replaceWith(this.#tree.element);
    viewSlot.replaceWith(this.map.element);
    propsSlot.append(this.#props.element, this.#maps.element);
    activitySlot.replaceWith(this.#activity.element);
    this.map.element.append(this.#toastsEl);

    this.store.onChange(() => this.refresh());
    this.conn.onStateChange((s) => this.#onConnectionState(s));
    this.conn.onError((m) => this.toast(m));
    this.api.onAvailabilityChange((ok) => this.#onApiAvailability(ok));
    this.api.onStatus((s) => this.#onStatus(s));
    this.api.onEvent((e) => this.#onEvent(e));

    window.addEventListener("keydown", (ev) => this.#onKey(ev));

    this.#tree.setCollapsed(this.settings.treeCollapsed);
    this.#activity.setOpen(this.settings.activityOpen);
    this.#setTab(this.settings.rightTab);
    this.refresh();
    this.#notice(this.api.unavailableReason || "");

    if (this.settings.autoConnect && this.settings.url) this.#connect();
    void this.#initUpdater();
  }

  dispose(): void {
    this.conn.autoReconnect = false;
    this.conn.disconnect();
    this.map.dispose();
  }

  // ---- shell --------------------------------------------------------------

  #buildShell(root: HTMLElement): { treeSlot: HTMLElement; viewSlot: HTMLElement; propsSlot: HTMLElement; activitySlot: HTMLElement } {
    root.innerHTML = "";

    this.#urlInput = h("input", { class: "url-input", type: "text", value: this.settings.url, placeholder: "ws://<robot-ip>:8765" });
    this.#urlInput.addEventListener("keydown", (ev) => {
      ev.stopPropagation();
      if (ev.key === "Enter") this.#connect();
    });
    this.#connectBtn = h("button", { class: "primary" }, icon("plug"), "Connect");
    this.#connectBtn.addEventListener("click", () => {
      if (this.conn.state === "disconnected") this.#connect();
      else this.#disconnect();
    });
    this.#statusEl = h("div", { class: "status" }, h("span", { class: "dot" }), h("span", { class: "label", text: "Not connected" }));
    this.#stateEl = h("div", { class: "runner-state", text: "" });

    this.#treeToggle = h("button", { class: "icon-only", title: "Show or hide the mission tree" }, icon("panelLeft"));
    this.#treeToggle.addEventListener("click", () => {
      this.settings.treeCollapsed = !this.#tree.collapsed;
      this.#tree.setCollapsed(this.settings.treeCollapsed);
      this.#save();
      this.refresh();
    });

    this.#runBtn = h("button", { class: "primary big solid" }, icon("play"), "Run");
    this.#runBtn.addEventListener("click", () => void this.#run());
    this.#pauseBtn = h("button", { class: "big" }, icon("pause"), "Pause");
    this.#pauseBtn.addEventListener("click", () => void this.#pause());
    this.#stopBtn = h("button", { class: "big danger solid" }, icon("stop"), "Stop");
    this.#stopBtn.addEventListener("click", () => void this.#stop());
    this.#deployBtn = h("button", { class: "big" }, icon("upload"), "Deploy");
    this.#deployBtn.addEventListener("click", () => void this.#deploy());

    const menuBtn = h("button", { class: "icon-only", title: "More" }, icon("more"));
    menuBtn.addEventListener("click", () => {
      const rect = menuBtn.getBoundingClientRect();
      openMenu(rect.left - 180, rect.bottom + 4, [
        { label: "Reload from the robot", icon: "refresh", run: () => void this.#reload() },
        { label: "Undo", icon: "undo", hint: "Ctrl+Z", disabled: !this.store.canUndo, run: () => this.#undo() },
        { label: "Redo", icon: "redo", hint: "Ctrl+Y", disabled: !this.store.canRedo, run: () => this.#redo() },
        { label: "-", run: () => undefined },
        { label: "Export as a Python script", icon: "code", run: () => this.#exportPython() },
        { label: "Export as behavior-tree XML", icon: "fileText", run: () => this.#exportBt() },
        { label: "-", run: () => undefined },
        { label: "Theme", icon: "eye", hint: THEME_LABELS[this.settings.theme], run: () => this.#openThemeMenu(rect.left - 180, rect.bottom + 4) },
        { label: "-", run: () => undefined },
        { label: `Version ${this.#version}`, icon: "info", disabled: true, run: () => undefined },
        { label: "Check for updates", icon: "refresh", run: () => void this.#checkUpdates(true) },
      ]);
    });

    const topbar = h(
      "div",
      { class: "topbar" },
      h("div", { class: "brand" }, "Mission", h("span", { text: " Builder" })),
      this.#treeToggle,
      this.#urlInput,
      this.#connectBtn,
      this.#statusEl,
      this.#stateEl,
      h("div", { class: "spacer" }),
      this.#runBtn,
      this.#pauseBtn,
      this.#stopBtn,
      this.#deployBtn,
      menuBtn,
    );

    this.#tabSelection = h("button", {}, icon("sliders"), "Selected");
    this.#tabMaps = h("button", {}, icon("map"), "Maps");
    this.#tabSelection.addEventListener("click", () => this.#setTab("selection"));
    this.#tabMaps.addEventListener("click", () => this.#setTab("maps"));

    const treeSlot = h("div");
    const viewSlot = h("div");
    const propsSlot = h("div", { class: "props-wrap" }, h("div", { class: "seg tabs" }, this.#tabSelection, this.#tabMaps));
    const activitySlot = h("div");
    this.#noticeEl = h("div", { class: "notice" });
    this.#noticeEl.hidden = true;
    this.#toastsEl = h("div", { class: "toasts" });

    root.append(topbar, this.#noticeEl, treeSlot, viewSlot, propsSlot, activitySlot);
    return { treeSlot, viewSlot, propsSlot, activitySlot };
  }

  /** Drafting or Dark, remembered and applied without a reload. */
  #openThemeMenu(x: number, y: number): void {
    openMenu(
      x,
      y,
      THEME_NAMES.map((name) => ({
        label: THEME_LABELS[name],
        icon: this.settings.theme === name ? ("check" as const) : undefined,
        run: () => this.#setTheme(name),
      })),
    );
  }

  #setTheme(theme: ThemeName): void {
    if (this.settings.theme === theme) return;
    this.settings.theme = theme;
    this.#save();
    // The DOM follows the attribute; the three.js layers are handed the new
    // variables by the MapView's subscription, so nothing is reloaded.
    applyTheme(theme);
  }

  #setTab(tab: "selection" | "maps"): void {
    this.settings.rightTab = tab;
    this.#save();
    this.#tabSelection.classList.toggle("active", tab === "selection");
    this.#tabMaps.classList.toggle("active", tab === "maps");
    this.#props.element.hidden = tab !== "selection";
    this.#maps.element.hidden = tab !== "maps";
    this.refresh();
  }

  // ---- redraw -------------------------------------------------------------

  /** Recompute the findings and redraw every column. Called after every edit. */
  refresh(): void {
    this.#revalidate();
    this.#tree.render();
    if (this.settings.rightTab === "maps") this.#maps.render();
    else this.#props.render();
    this.map.renderGuide();
    this.#syncButtons();
    this.#syncMapHighlight();
  }

  #revalidate(): void {
    const mission = this.store.mission;
    if (!mission) {
      this.#findings = [];
      return;
    }
    const result = validate(mission, {
      sites: this.store.sites,
      activeMap: this.store.mapName,
      missions: this.#missions.map((m) => m.name),
      connectors: Object.keys(this.#connectors).length > 0 ? Object.keys(this.#connectors) : null,
      capabilities: this.#capabilities,
    });
    this.#findings = [...result.errors, ...result.warnings];
  }

  /**
   * A selected step that drives somewhere lights that point on the map, and a
   * selected point marks the steps that drive to it in the tree.
   */
  #syncMapHighlight(): void {
    const sel = this.store.selection;
    const mission = this.store.mission;
    if (sel.kind === "point") {
      const linked = new Set<string>();
      if (mission) {
        for (const visit of walkSteps(mission)) {
          if (siteOfStep(visit.step) === sel.name && typeof visit.step.id === "string") linked.add(visit.step.id);
        }
      }
      this.#tree.setLinked(linked);
      this.map.routeLayer.refreshHighlight();
      return;
    }
    this.#tree.setLinked(new Set());
    if (sel.kind !== "node" || !sel.id.startsWith("step:")) {
      if (sel.kind !== "lane") this.map.routeLayer.setHover(null);
      this.map.routeLayer.refreshHighlight();
      return;
    }
    const tree = mission ? buildTree(mission) : null;
    const node = tree ? findNode(tree, sel.id) : null;
    const step = node?.path && mission ? getStepAt(mission, node.path) : null;
    const site = step ? siteOfStep(step) : null;
    this.map.routeLayer.setHover(site ? { kind: "point", name: site } : null);
    this.map.routeLayer.refreshHighlight();
  }

  #syncButtons(): void {
    const connected = this.api.available;
    const state = this.#status?.state ?? "idle";
    const mission = this.store.mission;
    const errors = this.#findings.filter((f) => f.level === "error").length;

    this.#runBtn.disabled = !connected || !mission || state === "running";
    this.#runBtn.title = !connected ? this.api.unavailableReason : !mission ? "Open a mission first." : state === "running" ? "Something is already running." : `Run ${mission.name} on the robot now.`;
    this.#pauseBtn.disabled = !connected || (state !== "running" && state !== "paused");
    setButtonContent(this.#pauseBtn, state === "paused" ? "play" : "pause", state === "paused" ? "Resume" : "Pause");
    this.#stopBtn.disabled = !connected;
    this.#stopBtn.title = connected ? "Cancel the run, the queue and anything suspended." : this.api.unavailableReason;

    const what = !mission ? "" : this.store.missionDirty && this.store.sitesDirty ? " mission and map" : this.store.missionDirty ? " mission" : this.store.sitesDirty ? " map" : "";
    setButtonContent(this.#deployBtn, "upload", what === "" ? "Deployed" : `Deploy${what}`);
    this.#deployBtn.disabled = !connected || !mission || what === "" || this.#busy;
    this.#deployBtn.title = !connected
      ? this.api.unavailableReason
      : what === ""
        ? "Nothing has changed since the last deploy."
        : errors > 0
          ? `Deploy checks the mission first; ${errors} ${errors === 1 ? "problem" : "problems"} must be fixed.`
          : `Saves the${what} to the robot.`;
    this.#deployBtn.classList.toggle("primary", what !== "" && errors === 0);

    this.#treeToggle.classList.toggle("active", !this.#tree.collapsed);
  }

  // ---- connection ---------------------------------------------------------

  #connect(): void {
    const url = this.#urlInput.value.trim();
    if (!url) return;
    this.settings.url = url;
    this.settings.autoConnect = true;
    this.#save();
    this.conn.connect(url);
  }

  #disconnect(): void {
    this.settings.autoConnect = false;
    this.#save();
    this.conn.disconnect();
  }

  #onConnectionState(state: ConnectionState): void {
    this.#statusEl.classList.remove("connected", "connecting");
    if (state !== "disconnected") this.#statusEl.classList.add(state);
    const label = this.#statusEl.querySelector(".label");
    if (label) label.textContent = state === "connected" ? "Connected" : state === "connecting" ? "Connecting" : "Not connected";
    setButtonContent(this.#connectBtn, state === "disconnected" ? "plug" : "unplug", state === "disconnected" ? "Connect" : "Disconnect");
    this.#connectBtn.classList.toggle("primary", state === "disconnected");
    if (state === "disconnected") {
      this.#status = null;
      this.#activity.setUnavailable("Not connected to a robot. The mission can still be edited and exported.");
      this.#stateEl.textContent = "";
    }
    this.#notice(this.api.unavailableReason);
    this.refresh();
  }

  #onApiAvailability(available: boolean): void {
    this.#notice(this.api.unavailableReason);
    if (available) {
      this.api.startLiveState();
      void this.#reload();
    } else {
      this.#missions = [];
      this.#status = null;
      this.#activity.setUnavailable(this.api.unavailableReason || "The runner cannot be reached.");
    }
    this.refresh();
  }

  /** One sentence about why something is missing, above the columns. */
  #notice(reason: string): void {
    if (!reason) {
      this.#noticeEl.hidden = true;
      return;
    }
    this.#noticeEl.replaceChildren(icon("info"), h("span", { text: `${reason} Missions can still be edited and exported here.` }));
    this.#noticeEl.hidden = false;
  }

  // ---- loading ------------------------------------------------------------

  async #reload(): Promise<void> {
    if (!this.api.available) {
      this.toast(this.api.unavailableReason || "The runner cannot be reached.");
      return;
    }
    try {
      const [missions, sites] = await Promise.all([this.api.missions(), this.api.sites()]);
      this.#missions = missions;
      this.store.setSites(sites);
      this.map.fit();
    } catch (err) {
      this.toast(this.#reason(err, "The list of missions could not be read"));
    }
    // These two are advisory: a runner without them still works.
    try {
      this.#connectors = await this.api.connectors();
    } catch {
      this.#connectors = {};
    }
    try {
      this.#capabilities = await this.api.capabilities();
    } catch {
      this.#capabilities = null;
    }
    try {
      this.#status = await this.api.status();
      this.#activity.setStatus(this.#status);
      this.#renderRunnerState();
    } catch {
      /* the live topic will fill it in */
    }
    const wanted = this.store.mission?.name || this.settings.lastMission;
    if (wanted && this.#missions.some((m) => m.name === wanted)) await this.#openMission(wanted);
    this.refresh();
  }

  async #openMission(name: string): Promise<void> {
    if (this.store.missionDirty && !confirm("The open mission has changes that are not on the robot yet. Open another one and lose them?")) return;
    try {
      const mission = await this.api.mission(name);
      this.store.setMission(mission);
      this.settings.lastMission = name;
      this.#save();
      this.#tree.reloadExpanded();
      this.#runState.clear();
      this.refresh();
      this.#tree.reveal("mission");
      // The tree is the editor: give it the keyboard without asking for a click.
      this.#tree.focus();
    } catch (err) {
      this.toast(this.#reason(err, `The mission ${name} could not be read`));
    }
  }

  #createMission(): void {
    const name = prompt("What should the mission be called? Lowercase letters, digits, underscore and hyphen.", "new_mission");
    if (name === null) return;
    const mission: Mission = { schema: MISSION_SCHEMA_ID, name: name.trim(), title: "", flow: [] };
    this.store.setMission(mission);
    this.store.setMissionField("title", name.trim().replace(/[_-]+/g, " "), "Name the mission");
    this.#tree.reloadExpanded();
    this.refresh();
    this.#tree.reveal("mission");
    this.toast("The mission only exists here until you deploy it.", "info");
  }

  async #deleteMission(name: string): Promise<void> {
    if (!confirm(`Delete the mission ${name} from the robot? Its triggers stop being armed straight away.`)) return;
    try {
      await this.api.deleteMission(name);
      if (this.store.mission?.name === name) this.store.setMission(null);
      this.#missions = this.#missions.filter((m) => m.name !== name);
      this.toast(`${name} was deleted.`, "info");
      this.refresh();
    } catch (err) {
      this.toast(this.#reason(err, `${name} could not be deleted`));
    }
  }

  async #loadHistory(): Promise<void> {
    if (!this.api.available) return;
    try {
      const runs = await this.api.get<Run[]>("/api/runs?limit=30");
      this.#activity.setHistory(Array.isArray(runs) ? runs : []);
    } catch {
      /* the bar shows what it already has */
    }
  }

  async #answerPrompt(id: string, answer: string): Promise<void> {
    try {
      await this.api.answerPrompt(id, answer);
    } catch (err) {
      this.toast(this.#reason(err, "The answer could not be sent"));
    }
  }

  /**
   * Make a map the active one on the robot. The runner reads the active map
   * from `sites.json`, so this is `default_map` plus a `PUT /api/sites`; Nav2
   * itself is switched by a `Change map` step inside a mission.
   */
  async #changeRobotMap(name: string): Promise<void> {
    if (!this.api.available) {
      this.toast(this.api.unavailableReason);
      return;
    }
    this.store.setDefaultMap(name);
    try {
      const sites: SitesDoc = this.store.sitesCopy();
      sites.schema = SITES_SCHEMA_ID;
      await this.api.saveSites(sites);
      this.store.markSitesSaved();
      this.toast(`${name} is the robot's active map now. Nav2 itself is switched by a 'Change map' step in a mission.`, "info");
    } catch (err) {
      this.toast(this.#reason(err, `${name} could not be made the active map`));
    }
    this.refresh();
  }

  // ---- live state ---------------------------------------------------------

  #onStatus(status: RunnerStatus): void {
    this.#status = status;
    this.#activity.setStatus(status);
    this.#renderRunnerState();
    this.#syncButtons();
  }

  #renderRunnerState(): void {
    const status = this.#status;
    if (!status) {
      this.#stateEl.textContent = "";
      this.#stateEl.className = "runner-state";
      return;
    }
    const run = status.run;
    this.#stateEl.textContent = run && (run.status === "running" || run.status === "paused") ? `${run.mission} · ${run.status}` : status.state;
    this.#stateEl.className = `runner-state ${status.state}`;
  }

  #onEvent(ev: RunnerEvent): void {
    this.#activity.onEvent(ev);
    if (ev.type === "run.started") {
      this.#runState.clear();
      this.#stepStart.clear();
    }
    if (ev.type === "step.started" && ev.step_id) {
      this.#runState.set(ev.step_id, { phase: "running" });
      this.#stepStart.set(ev.step_id, Date.now());
      this.#tree.render();
    }
    if (ev.type === "step.finished" && ev.step_id) {
      const started = this.#stepStart.get(ev.step_id);
      const durationS = started ? (Date.now() - started) / 1000 : undefined;
      this.#runState.set(ev.step_id, { phase: ev.result?.ok === false ? "failed" : "done", durationS });
      this.#tree.render();
    }
    if (ev.type === "missions.changed") void this.#refreshMissionList();
  }

  async #refreshMissionList(): Promise<void> {
    try {
      this.#missions = await this.api.missions();
      this.#tree.render();
    } catch {
      /* the list stays as it was */
    }
  }

  // ---- run, pause, stop, deploy -------------------------------------------

  async #run(): Promise<void> {
    const mission = this.store.mission;
    if (!mission) return;
    if (this.store.missionDirty && !confirm("This mission has changes that are not on the robot. Run the version the robot already has?")) return;
    try {
      const result = await this.api.run(mission.name);
      if (result.accepted === false) this.toast(`The robot did not start it: ${result.reason ?? "no reason given"}.`);
      else {
        this.#runState.clear();
        this.#activity.setOpen(true);
        this.settings.activityOpen = true;
        this.#save();
      }
    } catch (err) {
      this.toast(this.#reason(err, `${mission.name} could not be started`));
    }
  }

  async #pause(): Promise<void> {
    try {
      if (this.#status?.state === "paused") await this.api.resume();
      else await this.api.pause();
    } catch (err) {
      this.toast(this.#reason(err, "The run could not be paused"));
    }
  }

  async #stop(): Promise<void> {
    try {
      await this.api.stop();
      this.toast("Stop was sent: the run, the queue and anything suspended are canceled.", "info");
    } catch (err) {
      this.toast(this.#reason(err, "Stop could not be sent"));
    }
  }

  /** Validate, then write the mission and the map data in one action. */
  async #deploy(): Promise<void> {
    const mission = this.store.missionCopy();
    if (!mission) return;
    assignIds(mission);
    const local = validate(mission, {
      sites: this.store.sites,
      activeMap: this.store.mapName,
      missions: this.#missions.map((m) => m.name),
      connectors: Object.keys(this.#connectors).length > 0 ? Object.keys(this.#connectors) : null,
      capabilities: this.#capabilities,
    });
    if (local.errors.length > 0) {
      this.toast(`${local.errors.length} ${local.errors.length === 1 ? "problem has" : "problems have"} to be fixed first. The first one: ${local.errors[0]!.message}.`);
      this.#findings = [...local.errors, ...local.warnings];
      this.#tree.render();
      return;
    }
    this.#busy = true;
    this.#syncButtons();
    try {
      const missionDirty = this.store.missionDirty;
      const sitesDirty = this.store.sitesDirty;
      if (missionDirty) {
        const result = await this.api.saveMission(mission);
        if (result.ok === false) {
          this.#adoptApiFindings(result.errors ?? []);
          this.#tree.render();
          this.toast(`The robot rejected the mission: ${result.errors?.[0]?.message ?? "no reason given"}.`);
          return;
        }
        // Give the document back its generated ids and the new version.
        const current = this.store.mission;
        if (current) {
          assignIds(current);
          if (typeof result.version === "number") current.version = result.version;
        }
        this.store.markMissionSaved();
        for (const w of result.warnings ?? []) this.toast(`Warning: ${w.message}`, "info");
      }
      if (sitesDirty) {
        const sites: SitesDoc = this.store.sitesCopy();
        sites.schema = SITES_SCHEMA_ID;
        await this.api.saveSites(sites);
        this.store.markSitesSaved();
      }
      await this.#refreshMissionList();
      const said = [missionDirty ? `${mission.name} is armed on the robot.` : "", sitesDirty ? "The map data is saved." : ""].filter((s) => s !== "");
      this.toast(`Deployed. ${said.join(" ")}`, "info");
    } catch (err) {
      if (err instanceof MissionApiError) this.#adoptApiFindings(err.errors);
      this.toast(this.#reason(err, "Deploy failed"));
    } finally {
      this.#busy = false;
      this.#syncButtons();
      this.#tree.render();
      if (this.settings.rightTab === "maps") this.#maps.render();
      else this.#props.render();
    }
  }

  // ---- export -------------------------------------------------------------

  #exportPython(): void {
    const mission = this.store.missionCopy();
    if (!mission) {
      this.toast("Open a mission first.");
      return;
    }
    assignIds(mission);
    showExport("Export as a Python script", exportPython(mission, this.store.sites, this.store.mapName));
  }

  #exportBt(): void {
    const mission = this.store.missionCopy();
    if (!mission) {
      this.toast("Open a mission first.");
      return;
    }
    assignIds(mission);
    showExport("Export as behavior-tree XML", exportBehaviorTrees(mission));
  }

  // ---- keyboard -----------------------------------------------------------

  #onKey(ev: KeyboardEvent): void {
    const target = ev.target as HTMLElement | null;
    const typing = target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement || target instanceof HTMLSelectElement;
    if (ev.ctrlKey && (ev.key === "z" || ev.key === "Z")) {
      ev.preventDefault();
      this.#undo();
      return;
    }
    if (ev.ctrlKey && (ev.key === "y" || ev.key === "Y")) {
      ev.preventDefault();
      this.#redo();
      return;
    }
    if (ev.ctrlKey && (ev.key === "s" || ev.key === "S")) {
      ev.preventDefault();
      void this.#deploy();
      return;
    }
    if (typing) return;
    // The tree owns the arrows while it has focus; the map owns the tool keys.
    if (this.#tree.element.contains(target)) return;
    this.map.handleKey(ev);
  }

  #undo(): void {
    if (this.store.undo()) this.refresh();
  }
  #redo(): void {
    if (this.store.redo()) this.refresh();
  }

  // ---- helpers ------------------------------------------------------------

  formContext(): FormContext {
    return {
      siteNames: Object.keys(this.store.points),
      mapNames: this.store.mapNames,
      connectorNames: Object.keys(this.#connectors),
      missionNames: this.#missions.map((m) => m.name),
    };
  }

  /**
   * Turn any failure into a sentence. The runner reports a rejected mission as
   * a list of findings with no summary line, so the first finding is the
   * sentence worth showing.
   */
  #reason(err: unknown, what: string): string {
    if (err instanceof MissionApiError) {
      const first = err.errors[0]?.message;
      return first ? `${what}: ${first}` : `${what}: ${err.message}`;
    }
    return `${what}: ${err instanceof Error ? err.message : String(err)}`;
  }

  /**
   * Show what the robot said about a mission it refused, on the steps it
   * refused them for. Its paths arrive as "flow/1/to"; ours are arrays.
   */
  #adoptApiFindings(findings: readonly ApiFinding[]): void {
    const mapped: Finding[] = [];
    for (const f of findings) {
      const raw: unknown = f.path;
      const parts: unknown[] = typeof raw === "string" ? raw.split("/") : Array.isArray(raw) ? raw : [];
      const segments: Path = parts.map((seg) => (typeof seg === "number" ? seg : /^\d+$/.test(String(seg)) ? Number(seg) : String(seg)));
      const stepId = (f as { step_id?: unknown }).step_id;
      const level = (f as { level?: unknown }).level === "warning" ? "warning" : "error";
      mapped.push(typeof stepId === "string" ? { level, path: segments, stepId, message: f.message } : { level, path: segments, message: f.message });
    }
    if (mapped.length > 0) this.#findings = [...mapped, ...this.#findings];
  }

  toast(message: string, kind: "error" | "info" = "error"): void {
    if (message.trim() === "") return;
    const now = Date.now();
    const last = this.#lastToast.get(message) ?? 0;
    if (now - last < 4000) return;
    this.#lastToast.set(message, now);
    const el = h("div", { class: `toast ${kind}`, text: message });
    this.#toastsEl.appendChild(el);
    setTimeout(() => el.remove(), kind === "info" ? 4000 : 7000);
  }

  #save(): void {
    saveSettings(this.settings);
  }

  // ---- updates ------------------------------------------------------------

  #version = "dev";
  #updateBusy = false;

  async #initUpdater(): Promise<void> {
    try {
      this.#version = await getAppVersion();
    } catch {
      this.#version = "?";
    }
    if (!isDesktop()) return;
    setTimeout(() => void this.#checkUpdates(false), 5000);
  }

  async #checkUpdates(manual: boolean): Promise<void> {
    if (!isDesktop()) {
      if (manual) this.toast("Updates are only available in the desktop app.", "info");
      return;
    }
    if (this.#updateBusy) return;
    this.#updateBusy = true;
    try {
      const info = await checkForUpdate();
      if (!info) {
        if (manual) this.toast("Mission Builder is up to date.", "info");
        return;
      }
      this.#offerUpdate(info);
    } catch (err) {
      if (manual) this.toast(`The update check failed: ${String(err)}`);
    } finally {
      this.#updateBusy = false;
    }
  }

  #offerUpdate(info: UpdateInfo): void {
    const install = h("button", { class: "primary" }, icon("download"), "Install and restart");
    const later = h("button", {}, icon("clock"), "Later");
    const progress = h("div", { class: "prose muted" });
    const card = h(
      "div",
      { class: "toast info update" },
      h("div", { text: `Mission Builder ${info.version} is available (you have ${info.currentVersion}).` }),
      h("div", { class: "row buttons" }, install, later),
      progress,
    );
    later.addEventListener("click", () => card.remove());
    install.addEventListener("click", () => {
      install.disabled = true;
      later.disabled = true;
      progress.textContent = "Downloading.";
      void installUpdateAndRestart((done, total) => {
        const mb = (done / 1048576).toFixed(1);
        progress.textContent = total ? `Downloading ${mb} of ${(total / 1048576).toFixed(1)} MB.` : `Downloading ${mb} MB.`;
      }).catch((err: unknown) => {
        progress.textContent = `The update failed: ${String(err)}`;
        install.disabled = false;
        later.disabled = false;
      });
    });
    this.#toastsEl.appendChild(card);
  }
}

/** The site a step drives to, when it names one. */
function siteOfStep(step: { type: string; [k: string]: unknown }): string | null {
  if (step.type === "nav.follow_route") return typeof step.to === "string" && step.to !== "" ? step.to : null;
  for (const key of ["pose", "goal", "dock_pose", "start"]) {
    const ref = poseSiteRef(step[key]);
    if (ref) return ref;
  }
  return null;
}
