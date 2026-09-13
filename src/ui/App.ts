/**
 * The application shell: the top bar, the three columns and the Activity bar,
 * the project file, and everything that talks to the robot.
 *
 * The open project is the single source of truth while editing. It opens and
 * saves with no robot connected; connecting to a robot never replaces it.
 * Import from robot and Deploy project to robot are the two explicit actions
 * that move things between the project and the robot.
 *
 * One `foxglove_bridge` WebSocket carries everything robot-side: the map, TF
 * and the live robot as ordinary topics, and the whole `mission_runner` HTTP
 * API through the ROS service `/mission/api`. Every piece degrades on its own
 * and says so in a sentence while the project can still be edited, saved and
 * exported.
 */

import { FoxgloveConnection } from "../net/FoxgloveConnection";
import type { ConnectionState } from "../net/FoxgloveConnection";
import { INITIAL_POSE_MISSING, MissionApi, MissionApiError, errorSentences, isMissingEndpoint } from "../mission/MissionApi";
import type { ApiFinding, ConnectorState, MissionSummary, Run, RunnerEvent, RunnerStatus } from "../mission/MissionApi";
import { RouteStore } from "../mission/RouteStore";
import { assignIds, countSteps, findStep, getList, getStepAt, walkSteps } from "../mission/ids";
import { validate, validateInitialPoses, validateSiteTopics } from "../mission/validate";
import { requestTopics, topicNote } from "../mission/requestTopics";
import type { Capabilities } from "../mission/MissionApi";
import type { Edge, Finding, Mission, Path, Site, SitesDoc, Step } from "../mission/types";
import { DEFAULT_ANSWER_TOPIC, DEFAULT_REQUEST_TOPIC, MISSION_NAME_RE, MISSION_SCHEMA_ID, SITES_SCHEMA_ID, isRecord } from "../mission/types";
import { COPYRIGHT } from "../about";
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
import { openMenu, openStepPicker, stepForChoice } from "./StepPicker";
import type { MenuItem } from "./StepPicker";
import { newStep, poseSiteRef, stepTitle, triggerSummary } from "../mission/blocks";
import { buildTree, findNode } from "../mission/tree";
import { STOP_TYPE, planRoute } from "../mission/stops";
import type { Arrival, Stop } from "../mission/stops";
import { ProjectSession } from "../project/ProjectSession";
import { baseName, nowIso, parseProject } from "../project/project";
import { hasFileSystem } from "../project/files";
import { openAddPointDialog } from "./AddPointDialog";
import { askImportMode, openDeployDialog, openProjectSettings } from "./ProjectDialogs";
import type { DeployPlan } from "./ProjectDialogs";
import { openRobotStartup } from "./RobotStartup";
import { choose } from "./modal";

export class App {
  readonly conn = new FoxgloveConnection();
  readonly store = new RouteStore();
  readonly api = new MissionApi(this.conn);
  readonly settings: AppSettings;
  readonly session: ProjectSession;

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
  #projectBtn!: HTMLButtonElement;
  #projectLabel!: HTMLElement;
  #dirtyDot!: HTMLElement;
  #runBtn!: HTMLButtonElement;
  #pauseBtn!: HTMLButtonElement;
  #stopBtn!: HTMLButtonElement;
  #deployBtn!: HTMLButtonElement;
  #treeToggle!: HTMLButtonElement;
  #tabSelection!: HTMLButtonElement;
  #tabMaps!: HTMLButtonElement;
  #noticeEl!: HTMLElement;
  #toastsEl!: HTMLElement;

  /** The missions the robot has, when connected. The tree lists the project's. */
  #robotMissions: MissionSummary[] = [];
  #connectors: Record<string, ConnectorState> = {};
  #capabilities: Capabilities | null = null;
  #findings: Finding[] = [];
  #runState = new Map<string, StepRunState>();
  #stepStart = new Map<string, number>();
  #status: RunnerStatus | null = null;
  #lastToast = new Map<string, number>();
  #busy = false;
  /** `store.robotKey()` when the robot was last known to match the project (deploy, import). */
  #deployedKey: string | null = null;
  #lastTitle = "";

  constructor(root: HTMLElement) {
    this.settings = loadSettings();
    // Before anything is built: every colour in the shell and in the scene
    // comes from the variables this attribute selects.
    applyTheme(this.settings.theme);
    const { treeSlot, viewSlot, propsSlot, activitySlot } = this.#buildShell(root);

    this.#tree = new MissionTree({
      store: this.store,
      missionList: () => this.#missionSummaries(),
      openMission: (name) => this.#openMission(name),
      createMission: () => this.#createMission(),
      deleteMission: (name) => this.#deleteMission(name),
      requestNote: (step) => this.#requestNote(step),
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
      revealStep: (mission, stepId) => this.#revealStep(mission, stepId),
      addActionAt: (arrival, anchor) => this.#addActionAt(arrival, anchor),
      addFollowRouteTo: (point) => this.#addFollowRouteTo(point),
      robotPoseNow: () => this.#robotPoseNow(),
      setRobotPoseAt: (point) => void this.#setRobotPoseAt(point),
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
      addPointByCoordinates: () => this.#addPointDialog(),
    });
    this.session = new ProjectSession({
      store: this.store,
      settings: this.settings,
      saveSettings: () => this.#save(),
      toast: (m, k) => this.toast(m, k),
      loaded: () => this.#onProjectLoaded(),
      saved: () => this.refresh(),
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
    void this.#guardWindowClose();

    this.#tree.setCollapsed(this.settings.treeCollapsed);
    this.#activity.setOpen(this.settings.activityOpen);
    this.#setTab(this.settings.rightTab);
    this.refresh();
    this.#notice(this.api.unavailableReason || "");

    void this.session.start().then(() => {
      if (this.settings.autoConnect && this.#urlInput.value.trim() !== "") this.#connect();
    });
    void this.#initUpdater();
  }

  dispose(): void {
    this.session.dispose();
    this.conn.autoReconnect = false;
    this.conn.disconnect();
    this.map.dispose();
  }

  // ---- shell --------------------------------------------------------------

  #buildShell(root: HTMLElement): { treeSlot: HTMLElement; viewSlot: HTMLElement; propsSlot: HTMLElement; activitySlot: HTMLElement } {
    root.innerHTML = "";

    const fileBtn = h("button", { class: "file-btn", title: "New, open, save and deploy the project" }, icon("folder"), "File");
    fileBtn.addEventListener("click", () => {
      const rect = fileBtn.getBoundingClientRect();
      this.#openFileMenu(rect.left, rect.bottom + 4);
    });
    this.#projectLabel = h("span", { class: "project-label", text: "" });
    this.#dirtyDot = h("span", { class: "dirty-dot", title: "Unsaved changes" });
    this.#projectBtn = h("button", { class: "project-name", title: "Project settings" }, this.#projectLabel, this.#dirtyDot);
    this.#projectBtn.addEventListener("click", () => this.#openProjectSettings());

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
    this.#deployBtn.addEventListener("click", () => this.#openDeploy());

    const menuBtn = h("button", { class: "icon-only", title: "More" }, icon("more"));
    menuBtn.addEventListener("click", () => {
      const rect = menuBtn.getBoundingClientRect();
      openMenu(rect.left - 180, rect.bottom + 4, [
        { label: "Undo", icon: "undo", hint: "Ctrl+Z", disabled: !this.store.canUndo, run: () => this.#undo() },
        { label: "Redo", icon: "redo", hint: "Ctrl+Y", disabled: !this.store.canRedo, run: () => this.#redo() },
        { label: "-", run: () => undefined },
        { label: "Export as a Python script", icon: "code", run: () => this.#exportPython() },
        { label: "Export as behavior-tree XML", icon: "fileText", run: () => this.#exportBt() },
        { label: "-", run: () => undefined },
        { label: "Robot startup…", icon: "power", hint: this.api.autostartReachable ? "" : "Connect first", disabled: !this.api.autostartReachable, run: () => this.#openRobotStartup() },
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
      h("div", { class: "brand" }, h("span", { class: "name", text: "Mission Builder" }), h("span", { class: "copyright", text: COPYRIGHT })),
      fileBtn,
      this.#projectBtn,
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

  #openFileMenu(x: number, y: number): void {
    const connected = this.api.available;
    const items: MenuItem[] = [
      { label: "New project", icon: "file", hint: "Ctrl+N", run: () => void this.session.newProject() },
      { label: "Open…", icon: "folder", hint: "Ctrl+O", run: () => void this.session.open() },
      { label: "Open recent", icon: "clock", hint: "▸", run: () => this.#openRecentMenu(x, y) },
      { label: "Save", icon: "download", hint: "Ctrl+S", run: () => void this.session.save() },
      { label: "Save as…", icon: "copy", hint: "Ctrl+Shift+S", run: () => void this.session.saveAs() },
      { label: "Close", icon: "close", run: () => void this.session.close() },
      { label: "-", run: () => undefined },
      { label: "Project settings…", icon: "settings", run: () => this.#openProjectSettings() },
      { label: "-", run: () => undefined },
      { label: "Import from robot…", icon: "refresh", disabled: !connected, run: () => void this.#importFromRobot() },
      { label: "Deploy project to robot…", icon: "upload", disabled: !connected, run: () => this.#openDeploy() },
    ];
    openMenu(x, y, items);
  }

  #openRecentMenu(x: number, y: number): void {
    if (!hasFileSystem()) {
      openMenu(x, y, [{ label: "Recent projects are kept by the desktop app.", disabled: true, run: () => undefined }]);
      return;
    }
    const recent = this.settings.recentProjects;
    if (recent.length === 0) {
      openMenu(x, y, [{ label: "No projects opened yet.", disabled: true, run: () => undefined }]);
      return;
    }
    openMenu(
      x,
      y,
      recent.map((path) => ({ label: baseName(path), icon: "file" as const, hint: shortDir(path), run: () => void this.session.openRecent(path) })),
    );
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
    this.#syncTitle();
  }

  #validateContext(): Parameters<typeof validate>[1] {
    return {
      sites: this.store.sites,
      activeMap: this.store.mapName,
      missions: this.#knownMissionNames(),
      connectors: Object.keys(this.#connectors).length > 0 ? Object.keys(this.#connectors) : null,
      capabilities: this.#capabilities,
    };
  }

  #revalidate(): void {
    const mission = this.store.mission;
    if (!mission) {
      this.#findings = [];
      return;
    }
    const result = validate(mission, this.#validateContext());
    this.#findings = [...result.errors, ...routeFindings(mission, this.store.points, this.store.lanes), ...result.warnings];
  }

  /**
   * A selected step that drives somewhere lights that point on the map (and a
   * Follow route its whole planned chain), and a selected point marks the
   * steps that drive to it in the tree.
   */
  #syncMapHighlight(): void {
    const sel = this.store.selection;
    const mission = this.store.mission;
    const layer = this.map.routeLayer;
    if (sel.kind === "point") {
      const linked = new Set<string>();
      if (mission) {
        for (const visit of walkSteps(mission)) {
          if (siteOfStep(visit.step) === sel.name && typeof visit.step.id === "string") linked.add(visit.step.id);
        }
      }
      this.#tree.setLinked(linked);
      layer.setFocusStep(null);
      layer.refreshHighlight();
      return;
    }
    this.#tree.setLinked(new Set());
    if (sel.kind !== "node" || !sel.id.startsWith("step:")) {
      if (sel.kind !== "lane") layer.setHover(null);
      layer.setFocusStep(null);
      layer.refreshHighlight();
      return;
    }
    const tree = mission ? buildTree(mission) : null;
    const node = tree ? findNode(tree, sel.id) : null;
    const step = node?.path && mission ? getStepAt(mission, node.path) : null;
    const site = step ? siteOfStep(step) : null;
    layer.setHover(site ? { kind: "point", name: site } : null);
    layer.setFocusStep(step?.type === STOP_TYPE && typeof step.id === "string" ? step.id : null);
    layer.refreshHighlight();
  }

  #syncButtons(): void {
    const connected = this.api.available;
    const state = this.#status?.state ?? "idle";
    const mission = this.store.mission;

    this.#runBtn.disabled = !connected || !mission || state === "running";
    this.#runBtn.title = !connected ? this.api.unavailableReason : !mission ? "Open a mission first." : state === "running" ? "Something is already running." : `Run ${mission.name} on the robot now.`;
    this.#pauseBtn.disabled = !connected || (state !== "running" && state !== "paused");
    setButtonContent(this.#pauseBtn, state === "paused" ? "play" : "pause", state === "paused" ? "Resume" : "Pause");
    this.#stopBtn.disabled = !connected;
    this.#stopBtn.title = connected ? "Cancel the run, the queue and anything suspended." : this.api.unavailableReason;

    const upToDate = this.#deployedKey !== null && this.#deployedKey === this.store.robotKey();
    setButtonContent(this.#deployBtn, "upload", upToDate ? "Deployed" : "Deploy");
    this.#deployBtn.disabled = !connected || this.#busy;
    this.#deployBtn.title = !connected
      ? this.api.unavailableReason
      : upToDate
        ? "The robot has this project's maps and missions. Deploy again to send them anyway."
        : "Send the project's maps and missions to the robot.";
    this.#deployBtn.classList.toggle("primary", connected && !upToDate);

    this.#treeToggle.classList.toggle("active", !this.#tree.collapsed);
  }

  /** The title bar and the top bar show the project name, with a dot when unsaved. */
  #syncTitle(): void {
    const name = this.store.meta.name;
    const dirty = this.session?.dirty ?? false;
    this.#projectLabel.textContent = name;
    this.#dirtyDot.hidden = !dirty;
    this.#projectBtn.title = `${name}${dirty ? " has unsaved changes" : ""}. ${this.session?.path ?? "Not saved to a file yet."} Click for the project settings.`;
    const title = `${dirty ? "● " : ""}${name} — Mission Builder`;
    if (title === this.#lastTitle) return;
    this.#lastTitle = title;
    document.title = title;
    if (isDesktop()) {
      void import("@tauri-apps/api/window")
        .then((w) => w.getCurrentWindow().setTitle(title))
        .catch(() => undefined);
    }
  }

  // ---- the project --------------------------------------------------------

  #onProjectLoaded(): void {
    const store = this.store;
    this.#deployedKey = null;
    this.#runState.clear();
    const url = store.meta.settings.robot_url;
    if (typeof url === "string" && url !== "" && this.conn.state === "disconnected") this.#urlInput.value = url;
    const wanted = store.missionNames.includes(this.settings.lastMission) ? this.settings.lastMission : (store.missionNames[0] ?? null);
    store.openMission(wanted);
    this.#tree.reloadExpanded();
    this.refresh();
    if (wanted) this.#tree.reveal("mission");
    this.map.fit();
  }

  #openProjectSettings(): void {
    openProjectSettings(this.store, this.#urlInput.value.trim(), () => this.refresh());
  }

  /** The project's missions for the tree, with what the robot says about each. */
  #missionSummaries(): MissionSummary[] {
    const robot = new Map(this.#robotMissions.map((m) => [m.name, m]));
    return this.store.missions.map((m) => {
      const summary: MissionSummary = { name: m.name, steps: countSteps(m.flow ?? []) };
      if (m.title) summary.title = m.title;
      const first = m.triggers?.[0];
      if (first) summary.triggers = [triggerSummary(first)];
      const onRobot = robot.get(m.name);
      if (onRobot?.state) summary.state = onRobot.state;
      return summary;
    });
  }

  #knownMissionNames(): string[] {
    return [...new Set([...this.store.missionNames, ...this.#robotMissions.map((m) => m.name)])];
  }

  #openMission(name: string): void {
    if (!this.store.openMission(name)) {
      this.toast(`The project has no mission called ${name}.`);
      return;
    }
    this.settings.lastMission = name;
    this.#save();
    this.#tree.reloadExpanded();
    this.#runState.clear();
    this.refresh();
    this.#tree.reveal("mission");
    // The tree is the editor: give it the keyboard without asking for a click.
    this.#tree.focus();
  }

  #createMission(): void {
    const suggested = uniqueName(this.store.missionNames, "new_mission");
    const answer = prompt("What should the mission be called? Lowercase letters, digits, underscore and hyphen.", suggested);
    if (answer === null) return;
    const name = answer.trim();
    if (!MISSION_NAME_RE.test(name)) {
      this.toast("A mission name is lowercase letters, digits, underscore and hyphen, starting with a letter, at most 64 characters.");
      return;
    }
    const mission: Mission = { schema: MISSION_SCHEMA_ID, name, title: name.replace(/[_-]+/g, " "), flow: [] };
    if (!this.store.addMission(mission)) {
      this.toast(`The project already has a mission called ${name}.`);
      return;
    }
    this.settings.lastMission = name;
    this.#save();
    this.#tree.reloadExpanded();
    this.refresh();
    this.#tree.reveal("mission");
  }

  #deleteMission(name: string): void {
    const onRobot = this.#robotMissions.some((m) => m.name === name);
    const robotSentence = onRobot ? " The robot keeps its copy until the project is deployed with Replace missions on the robot." : "";
    if (!confirm(`Delete the mission ${name} from the project? Ctrl+Z brings it back.${robotSentence}`)) return;
    this.store.removeMission(name);
    this.refresh();
  }

  /**
   * A request's topics, briefly, when they are not the project's. New steps
   * carry no topics: they come from the station's point or the project.
   */
  #requestNote(step: Step): string {
    if (step.type !== "ros.request") return "";
    const defaults = this.formContext();
    return topicNote(requestTopics(step, this.store.mission, this.store.points, defaults), defaults);
  }

  #revealStep(mission: string, stepId: string): void {
    if (this.store.mission?.name !== mission) this.#openMission(mission);
    this.#tree.reveal(`step:${stepId}`);
    this.refresh();
  }

  /**
   * Add action here: pick a step and insert it after the actions that already
   * follow that Follow route, in its mission (opened first when needed).
   */
  #addActionAt(arrival: Arrival, anchor: HTMLElement): void {
    const rect = anchor.getBoundingClientRect();
    const fixed = h("div", { style: `position:fixed;left:${rect.left}px;top:${rect.top}px;width:${rect.width}px;height:${rect.height}px;pointer-events:none` });
    document.body.appendChild(fixed);
    const to = typeof arrival.step.to === "string" ? arrival.step.to : "";
    openStepPicker(fixed, `Add an action at ${to} in ${arrival.mission}`, (choice) => {
      if (this.store.mission?.name !== arrival.mission) this.#openMission(arrival.mission);
      const mission = this.store.mission;
      const driveId = typeof arrival.step.id === "string" ? arrival.step.id : "";
      const visit = mission ? findStep(mission, driveId) : null;
      if (!mission || !visit) {
        this.toast("That Follow route is no longer in the mission.");
        return;
      }
      const listPath: Path = visit.path.slice(0, -1);
      const list = getList(mission, listPath) ?? [];
      const start = visit.path[visit.path.length - 1];
      let at = typeof start === "number" ? start + 1 : list.length;
      while (at < list.length && list[at]!.type !== STOP_TYPE) at++;
      const step = stepForChoice(choice, this.store.freshStepId());
      this.store.insertStep(listPath, at, step, `Add ${choice.label.toLowerCase()} at ${to}`);
      this.#tree.render();
      this.#tree.reveal(`step:${String(step.id)}`);
      this.refresh();
    });
    // The picker is placed when it opens, so the stand-in anchor is done with.
    fixed.remove();
  }

  #addFollowRouteTo(point: string): void {
    const mission = this.store.mission;
    if (!mission) {
      this.toast("Open a mission first.");
      return;
    }
    const step = newStep(STOP_TYPE, this.store.freshStepId());
    step.to = point;
    this.store.insertStep(["flow"], -1, step, `Drive to ${point}`);
    this.toast(`Added a Follow route to ${point} at the end of ${mission.name}'s tasks.`, "info");
    this.refresh();
  }

  #addPointDialog(): void {
    openAddPointDialog({
      store: this.store,
      robotPoseUnavailable: () => (this.api.available ? "" : "Connect to a robot to use where it is."),
      robotPose: async () => {
        try {
          const pose = await this.api.robotPose();
          if (typeof pose?.x === "number" && typeof pose.y === "number") return { x: pose.x, y: pose.y, yaw_deg: typeof pose.yaw_deg === "number" ? pose.yaw_deg : 0 };
        } catch {
          /* fall back to the last status */
        }
        const robot = this.#status?.robot;
        return robot && typeof robot.x === "number" ? { x: robot.x, y: robot.y, yaw_deg: robot.yaw_deg ?? 0 } : null;
      },
      added: (name) => {
        this.refresh();
        this.map.focusPoint(name);
      },
    });
  }

  // ---- import and deploy ----------------------------------------------------

  /** File → Import from robot: fill the project with the robot's maps and missions. */
  async #importFromRobot(): Promise<void> {
    if (!this.api.available) {
      this.toast(this.api.unavailableReason || "The runner cannot be reached.");
      return;
    }
    let sites: SitesDoc;
    let missions: Mission[];
    let oldRobot = false;
    try {
      const raw = await this.api.project();
      const parsed = parseProject(JSON.stringify(raw), "What the robot sent");
      if (!parsed.ok) {
        this.toast(parsed.error);
        return;
      }
      sites = parsed.doc.sites;
      missions = parsed.doc.missions;
    } catch (err) {
      if (!isMissingEndpoint(err)) {
        this.toast(this.#reason(err, "The robot's project could not be read"));
        return;
      }
      // An older mission_runner: read the same content one piece at a time.
      oldRobot = true;
      try {
        sites = await this.api.sites();
        if (!isRecord(sites.maps)) sites.maps = {};
        sites.schema = SITES_SCHEMA_ID;
        const list = await this.api.missions();
        missions = await Promise.all(list.map((m) => this.api.mission(m.name)));
      } catch (err2) {
        this.toast(this.#reason(err2, "The robot's maps and missions could not be read"));
        return;
      }
    }
    const mode = await askImportMode(Object.keys(sites.maps).length, missions.length);
    if (mode === null) return;
    const store = this.store;
    let sentence: string;
    if (mode === "replace") {
      store.replaceContent(sites, missions, "Import from robot");
      sentence = `The project now has the robot's ${missions.length} ${missions.length === 1 ? "mission" : "missions"} and ${Object.keys(sites.maps).length} ${Object.keys(sites.maps).length === 1 ? "map" : "maps"}.`;
    } else {
      const merged = mergeContent(store.sitesCopy(), store.missions.map((m) => JSON.parse(JSON.stringify(m)) as Mission), sites, missions);
      store.replaceContent(merged.sites, merged.missions, "Merge from robot");
      sentence = merged.summary;
    }
    this.#deployedKey = mode === "replace" ? store.robotKey() : null;
    if (!store.mission && store.missionNames[0]) this.#openMission(store.missionNames[0]);
    this.refresh();
    this.map.fit();
    this.toast(`${sentence}${oldRobot ? " This robot's mission_runner has no /api/project yet, so they were read one by one." : ""} Ctrl+Z undoes the import.`, "info");
  }

  /** … menu → Robot startup: the services that start Nav2 and the mission layer at boot. */
  #openRobotStartup(): void {
    if (!this.api.autostartReachable) {
      this.toast(this.api.unavailableReason || "The runner cannot be reached.");
      return;
    }
    const robotKey = this.conn.state === "connected" ? this.#urlInput.value.trim() : "(not connected)";
    openRobotStartup({
      api: this.api,
      toast: (m, k) => this.toast(m, k),
      projectArg: () => this.settings.startupProject[robotKey] ?? "",
      rememberProjectArg: (value) => {
        if (value === "") delete this.settings.startupProject[robotKey];
        else this.settings.startupProject[robotKey] = value;
        this.#save();
      },
      projectFileName: () => {
        const path = this.session.path;
        if (path) return baseName(path).replace(/\.mproj$/i, "") + ".mproj";
        const slug = this.store.meta.name.toLowerCase().replace(/[^a-z0-9_-]+/g, "_").replace(/^_+|_+$/g, "");
        return `${slug || "project"}.mproj`;
      },
    });
  }

  #openDeploy(): void {
    if (!this.api.available) {
      this.toast(this.api.unavailableReason || "The runner cannot be reached.");
      return;
    }
    openDeployDialog({
      plan: this.#deployPlan(),
      robotMissions: async () => {
        try {
          return (await this.api.missions()).map((m) => m.name);
        } catch {
          return null;
        }
      },
      deploy: (replace) => this.#deployProject(replace),
    });
  }

  /** Every mission checked the way the robot will check it, before anything is sent. */
  #deployPlan(): DeployPlan {
    const store = this.store;
    const errors: string[] = [];
    const cautions: string[] = [];
    const ctx = { ...this.#validateContext(), missions: store.missionNames };
    for (const mission of store.missions) {
      const copy = JSON.parse(JSON.stringify(mission)) as Mission;
      assignIds(copy);
      const result = validate(copy, ctx);
      for (const e of result.errors) errors.push(`${mission.name}: ${sentenceCase(e.message)}.`);
      for (const f of routeFindings(mission, store.points, store.lanes)) cautions.push(`${mission.name}: ${sentenceCase(f.message)}.`);
    }
    for (const f of [...validateSiteTopics(store.sites), ...validateInitialPoses(store.sites)]) (f.level === "error" ? errors : cautions).push(`Map ${String(f.path[1])}: ${sentenceCase(f.message)}.`);
    return { maps: store.mapNames.length, missions: store.missionNames, errors, cautions };
  }

  async #deployProject(replace: boolean): Promise<boolean> {
    const store = this.store;
    const doc = store.toProjectDoc(nowIso());
    this.#busy = true;
    this.#syncButtons();
    try {
      const result = await this.api.putProject(doc, replace);
      if (result.ok === false) {
        this.#reportProjectErrors(result.errors ?? []);
        return false;
      }
      this.#deployedKey = store.robotKey();
      await this.#refreshMissionList();
      const saved = result.saved ?? store.missionNames;
      const deleted = result.deleted ?? [];
      const parts = [`Deployed ${store.meta.name}: ${saved.length} ${saved.length === 1 ? "mission is" : "missions are"} armed on the robot and the maps are saved.`];
      if (deleted.length > 0) parts.push(`Deleted from the robot: ${deleted.join(", ")}.`);
      this.toast(parts.join(" "), "info");
      for (const w of result.warnings ?? []) this.toast(`Warning${w.mission ? ` in ${w.mission}` : ""}: ${w.message}`, "info");
      return true;
    } catch (err) {
      if (isMissingEndpoint(err)) return await this.#deployPieceByPiece(replace);
      if (err instanceof MissionApiError && err.errors.length > 0) {
        this.#reportProjectErrors(err.errors);
        return false;
      }
      this.toast(this.#reason(err, "Deploy failed"));
      return false;
    } finally {
      this.#busy = false;
      this.refresh();
    }
  }

  /**
   * A mission_runner older than the project contract has no `/api/project`.
   * The maps and missions still reach it through the endpoints it does have,
   * one at a time; Replace (and all-or-nothing) needs the newer runner.
   */
  async #deployPieceByPiece(replace: boolean): Promise<boolean> {
    const store = this.store;
    if (replace) {
      this.toast("This robot's mission_runner is too old to take a whole project: it has no /api/project, so Replace missions on the robot cannot be done. Update mission_runner on the robot, or deploy without Replace.");
      return false;
    }
    try {
      const sites = store.sitesCopy();
      sites.schema = SITES_SCHEMA_ID;
      await this.api.saveSites(sites);
      for (const mission of store.missions) {
        const copy = JSON.parse(JSON.stringify(mission)) as Mission;
        assignIds(copy);
        const result = await this.api.saveMission(copy);
        if (result.ok === false) {
          this.toast(`The robot rejected ${mission.name}: ${result.errors?.[0]?.message ?? "no reason given"}. The maps and the missions before it were saved.`);
          return false;
        }
      }
      this.#deployedKey = store.robotKey();
      await this.#refreshMissionList();
      this.toast(
        `Deployed ${store.missions.length} ${store.missions.length === 1 ? "mission" : "missions"} and the maps. This robot's mission_runner is too old for /api/project, so they were sent one at a time; update it for all-or-nothing deploys and Replace.`,
        "info",
      );
      return true;
    } catch (err) {
      if (err instanceof MissionApiError) this.#adoptApiFindings(err.errors);
      this.toast(this.#reason(err, "Deploy failed"));
      return false;
    }
  }

  #reportProjectErrors(errors: readonly ApiFinding[]): void {
    const first = errors[0];
    if (!first) {
      this.toast("The robot refused the project without saying why. Nothing was written.");
      return;
    }
    const more = errors.length > 1 ? ` ${errors.length - 1} more ${errors.length === 2 ? "problem" : "problems"} after that.` : "";
    this.toast(`The robot refused the project and wrote nothing. ${first.mission ? `In ${first.mission}: ` : ""}${sentenceCase(first.message)}.${more}`);
    const open = this.store.mission?.name;
    this.#adoptApiFindings(errors.filter((e) => !e.mission || e.mission === open));
    this.#tree.render();
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
      this.#activity.setUnavailable("Not connected to a robot. The project can still be edited, saved and exported.");
      this.#stateEl.textContent = "";
    }
    this.#notice(this.api.unavailableReason);
    this.refresh();
  }

  #onApiAvailability(available: boolean): void {
    this.#notice(this.api.unavailableReason);
    if (available) {
      this.api.startLiveState();
      void this.#refreshRobotInfo();
    } else {
      this.#robotMissions = [];
      this.#status = null;
      this.#deployedKey = null;
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
    this.#noticeEl.replaceChildren(icon("info"), h("span", { text: `${reason} The project can still be edited, saved and exported here.` }));
    this.#noticeEl.hidden = false;
  }

  // ---- what the robot has ---------------------------------------------------

  /**
   * What the robot has, without touching the project: its mission list (for
   * Run and for the tree's states), connectors, capabilities and status.
   */
  async #refreshRobotInfo(): Promise<void> {
    await this.#refreshMissionList();
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
    const store = this.store;
    if (store.missions.length === 0 && Object.keys(store.points).length === 0 && this.#robotMissions.length > 0) {
      this.toast(`Connected. The robot has ${this.#robotMissions.length} ${this.#robotMissions.length === 1 ? "mission" : "missions"}; File → Import from robot brings them into this project.`, "info");
    }
    this.refresh();
  }

  async #refreshMissionList(): Promise<void> {
    if (!this.api.available) return;
    try {
      this.#robotMissions = await this.api.missions();
      this.#tree.render();
    } catch {
      /* the list stays as it was */
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
   * from `sites.json`, so this is `default_map` plus a `PUT /api/sites` of the
   * project's maps; Nav2 itself is switched by a `Change map` step.
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
      this.toast(`${name} is the robot's active map now, and the robot has the project's maps. Nav2 itself is switched by a 'Change map' step in a mission.`, "info");
    } catch (err) {
      this.toast(this.#reason(err, `${name} could not be made the active map`));
    }
    this.refresh();
  }

  // ---- live state ---------------------------------------------------------

  #onStatus(status: RunnerStatus): void {
    const was = this.#status?.state;
    this.#status = status;
    // "Set robot pose here now" is off while a mission runs.
    if (was !== status.state && this.settings.rightTab === "selection") this.#props.render();
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

  // ---- initial pose -------------------------------------------------------

  #robotPoseNow(): { enabled: boolean; reason: string } {
    if (!this.api.autostartReachable) return { enabled: false, reason: "Connect to a robot to set its pose from here." };
    const state = this.#status?.state;
    if (state === "running" || state === "paused") return { enabled: false, reason: "A mission is running. Stop it before setting the robot's pose." };
    return { enabled: true, reason: "" };
  }

  /**
   * Ask, then `POST /api/robot/initial_pose`. The point's name is sent when
   * the robot is known to have this project on this map; otherwise its
   * coordinates, so what is set is what the user sees.
   */
  async #setRobotPoseAt(name: string): Promise<void> {
    const action = this.#robotPoseNow();
    if (!action.enabled) {
      this.toast(action.reason);
      return;
    }
    const site = this.store.points[name];
    if (!site) return;
    const yaw = site.yaw_deg ?? 0;
    const robotMap = this.#status?.current_map ?? null;
    const inSync = this.#deployedKey !== null && this.#deployedKey === this.store.robotKey() && (robotMap ?? this.store.sites.default_map) === this.store.mapName;
    const sentences = [
      `This tells the robot's localization that the robot is standing at ${name} (x ${site.x.toFixed(2)} m, y ${site.y.toFixed(2)} m, heading ${Math.round(yaw)}°) right now.`,
      "Only do this when the robot really is there, facing that way. A wrong pose makes Nav2 plan and drive from the wrong place.",
    ];
    if (!inSync) sentences.push("The robot may not have this project's latest points, so these coordinates are sent rather than the point's name.");
    if (robotMap && robotMap !== this.store.mapName) sentences.push(`The robot has the map ${robotMap} loaded, not ${this.store.mapName}.`);
    const answer = await choose(`Set the robot's pose at ${name}?`, sentences, [
      { value: "cancel", label: "Cancel" },
      { value: "set", label: "Set pose", kind: "primary" },
    ]);
    if (answer !== "set") return;
    this.toast(`Setting the robot's pose at ${name}…`, "info");
    try {
      const res = await this.api.setInitialPose(inSync ? { site: name } : { x: site.x, y: site.y, yaw_deg: yaw });
      const x = typeof res?.x === "number" ? res.x : site.x;
      const y = typeof res?.y === "number" ? res.y : site.y;
      const heading = typeof res?.yaw_deg === "number" ? res.yaw_deg : yaw;
      this.toast(`Initial pose set at ${res?.site ?? name} (x ${x.toFixed(2)}, y ${y.toFixed(2)}, ${Math.round(heading)}°). Localization confirmed it.`, "info");
    } catch (err) {
      this.toast(this.#initialPoseError(err, name));
    }
  }

  #initialPoseError(err: unknown, name: string): string {
    if (err instanceof MissionApiError) {
      const detail = err.message.trim().replace(/\.$/, "");
      if (err.message === INITIAL_POSE_MISSING) return INITIAL_POSE_MISSING;
      if (err.status === 409) return `A mission is running, so the pose was not set. Stop it first, then set the pose at ${name}.`;
      if (err.status === 400) return `The robot refused the pose at ${name}: ${errorSentences(err).map((s) => s.trim().replace(/\.$/, "")).join("; ")}.`;
      if (err.status === 500 || err.status === 504) return `The pose at ${name} was sent, but localization did not confirm it: ${detail}.`;
    }
    return this.#reason(err, `The pose at ${name} could not be set`);
  }

  // ---- run, pause, stop ---------------------------------------------------

  async #run(): Promise<void> {
    const mission = this.store.mission;
    if (!mission) return;
    if (!this.#robotMissions.some((m) => m.name === mission.name)) {
      this.toast(`${mission.name} is not on the robot yet. Deploy the project first.`);
      return;
    }
    if (this.#deployedKey !== this.store.robotKey()) {
      const sentence =
        this.#deployedKey === null
          ? "The robot may not have the latest version of this project. Run the version the robot already has?"
          : "The project has changes the robot does not have yet. Run the version the robot already has?";
      if (!confirm(sentence)) return;
    }
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

  // ---- export -------------------------------------------------------------

  #exportPython(): void {
    const mission = this.store.missionCopy();
    if (!mission) {
      this.toast("Open a mission first.");
      return;
    }
    assignIds(mission);
    const ctx = this.formContext();
    showExport("Export as a Python script", exportPython(mission, this.store.sites, this.store.mapName, { requestTopic: ctx.requestTopic, answerTopic: ctx.answerTopic }));
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
    const key = ev.key.toLowerCase();
    if (ev.ctrlKey && !ev.altKey) {
      if (key === "s") {
        ev.preventDefault();
        // Leave a field first, so a value still being typed is part of what is saved.
        if (typing) target.blur();
        void (ev.shiftKey ? this.session.saveAs() : this.session.save());
        return;
      }
      if (key === "o") {
        ev.preventDefault();
        void this.session.open();
        return;
      }
      if (key === "n") {
        ev.preventDefault();
        void this.session.newProject();
        return;
      }
      if (key === "z" && !typing) {
        ev.preventDefault();
        this.#undo();
        return;
      }
      if (key === "y" && !typing) {
        ev.preventDefault();
        this.#redo();
        return;
      }
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

  /** Closing the window with unsaved changes asks first. */
  async #guardWindowClose(): Promise<void> {
    if (isDesktop()) {
      try {
        const { getCurrentWindow } = await import("@tauri-apps/api/window");
        await getCurrentWindow().onCloseRequested(async (event) => {
          if (!this.session.dirty) return;
          if (!(await this.session.confirmDiscard("closing Mission Builder"))) event.preventDefault();
        });
      } catch {
        /* without the window API the close is not guarded; the autosave still is */
      }
      return;
    }
    window.addEventListener("beforeunload", (event) => {
      if (!this.session.dirty) return;
      void this.session.autosaveNow();
      event.preventDefault();
    });
  }

  // ---- helpers ------------------------------------------------------------

  formContext(): FormContext {
    const s = this.store.meta.settings;
    return {
      siteNames: Object.keys(this.store.points),
      mapNames: this.store.mapNames,
      connectorNames: Object.keys(this.#connectors),
      missionNames: this.#knownMissionNames(),
      requestTopic: typeof s.request_topic === "string" && s.request_topic !== "" ? s.request_topic : DEFAULT_REQUEST_TOPIC,
      answerTopic: typeof s.answer_topic === "string" && s.answer_topic !== "" ? s.answer_topic : DEFAULT_ANSWER_TOPIC,
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
    setTimeout(() => el.remove(), kind === "info" ? 5000 : 8000);
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

// ---- module helpers ------------------------------------------------------------

/** The site a step drives to, when it names one. */
function siteOfStep(step: { type: string; [k: string]: unknown }): string | null {
  if (step.type === "nav.follow_route") return typeof step.to === "string" && step.to !== "" ? step.to : null;
  for (const key of ["pose", "goal", "dock_pose", "start"]) {
    const ref = poseSiteRef(step[key]);
    if (ref) return ref;
  }
  return null;
}

/**
 * The Follow routes of a mission the graph cannot drive, as findings on their
 * steps: red when the run would fail, a warning when `on_no_route: direct`
 * drives straight instead. A destination that is not a point at all is left
 * to the validator, which already says so.
 */
function routeFindings(mission: Mission, points: Record<string, Site>, lanes: readonly Edge[]): Finding[] {
  const stops: Stop[] = [];
  const paths = new Map<Step, Path>();
  for (const visit of walkSteps(mission)) {
    if (visit.step.type !== STOP_TYPE) continue;
    stops.push({ step: visit.step, actions: [] });
    paths.set(visit.step, visit.path);
  }
  const out: Finding[] = [];
  for (const leg of planRoute(stops, points, lanes, mission)) {
    if (leg.problem === "" || leg.route.length === 0) continue;
    const step = stops[leg.stopIndex]!.step;
    const message = `${stepTitle(step)}: ${leg.problem.replace(/\.$/, "")}${leg.direct ? ", so it drives straight there" : ""}`;
    const finding: Finding = { level: leg.direct ? "warning" : "error", path: paths.get(step) ?? [], message };
    if (typeof step.id === "string") finding.stepId = step.id;
    out.push(finding);
  }
  return out;
}

/**
 * Merge what a robot has into the project: maps, points, lanes and missions
 * the project lacks are added; everything the project already has is kept.
 */
function mergeContent(sites: SitesDoc, missions: Mission[], robotSites: SitesDoc, robotMissions: Mission[]): { sites: SitesDoc; missions: Mission[]; summary: string } {
  let maps = 0;
  let points = 0;
  let lanes = 0;
  for (const [name, robotMap] of Object.entries(robotSites.maps ?? {})) {
    const own = sites.maps[name];
    if (!own) {
      sites.maps[name] = robotMap;
      maps++;
      continue;
    }
    own.sites ??= {};
    for (const [p, site] of Object.entries(robotMap.sites ?? {})) {
      if (own.sites[p]) continue;
      own.sites[p] = site;
      points++;
    }
    own.edges ??= [];
    for (const e of robotMap.edges ?? []) {
      if (own.edges.some((o) => (o.from === e.from && o.to === e.to) || (o.from === e.to && o.to === e.from))) continue;
      own.edges.push(e);
      lanes++;
    }
    for (const [z, zone] of Object.entries(robotMap.zones ?? {})) {
      own.zones ??= {};
      if (!own.zones[z]) own.zones[z] = zone;
    }
    // The project's start position wins; the robot's is taken when the project has none.
    if (!own.initial_pose && robotMap.initial_pose && own.sites[robotMap.initial_pose.site]) own.initial_pose = robotMap.initial_pose;
  }
  if (!sites.default_map && robotSites.default_map) sites.default_map = robotSites.default_map;
  const added: string[] = [];
  let kept = 0;
  for (const m of robotMissions) {
    if (missions.some((o) => o.name === m.name)) {
      kept++;
      continue;
    }
    missions.push(m);
    added.push(m.name);
  }
  const bits: string[] = [];
  if (maps > 0) bits.push(`${maps} ${maps === 1 ? "map" : "maps"}`);
  if (points > 0) bits.push(`${points} ${points === 1 ? "point" : "points"}`);
  if (lanes > 0) bits.push(`${lanes} ${lanes === 1 ? "lane" : "lanes"}`);
  if (added.length > 0) bits.push(`${added.length} ${added.length === 1 ? "mission" : "missions"} (${added.join(", ")})`);
  const summary =
    (bits.length === 0 ? "The project already had everything the robot has." : `Merged in from the robot: ${bits.join(", ")}.`) +
    (kept > 0 ? ` ${kept} ${kept === 1 ? "mission was" : "missions were"} in both, and the project's version was kept.` : "");
  return { sites, missions, summary };
}

function sentenceCase(text: string): string {
  const t = text.trim().replace(/\.$/, "");
  return t.charAt(0).toUpperCase() + t.slice(1);
}

function uniqueName(taken: readonly string[], base: string): string {
  if (!taken.includes(base)) return base;
  for (let i = 2; ; i++) if (!taken.includes(`${base}_${i}`)) return `${base}_${i}`;
}

/** The folder of a path, shortened for a menu hint. */
function shortDir(path: string): string {
  const parts = path.split(/[\\/]/);
  parts.pop();
  const dir = parts.join("\\");
  return dir.length > 34 ? `…${dir.slice(-33)}` : dir;
}
