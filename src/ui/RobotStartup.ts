/**
 * … menu → Robot startup: the systemd user services that start the robot's
 * own launch file (drivers, localization, Nav2) and the mission layer at boot,
 * managed by mission_runner through `/api/autostart` (Mission/docs/robot-startup.md).
 *
 * Nothing here is kept in the project: the robot's `~/.mission/autostart`
 * is the source of truth, and the list is read again after every change, on
 * `autostart.changed`, and every 5 seconds while the dialog is open (systemd
 * state changes such as a crash and restart send no event).
 */

import { h } from "./dom";
import { icon } from "./icons";
import { choose, field, openModal } from "./modal";
import type { ModalHandle } from "./modal";
import { AUTOSTART_MISSING, MissionApiError, errorSentences } from "../mission/MissionApi";
import type { AutostartInfo, AutostartService, AutostartSpec, AutostartVerb, BrowseEntry, BrowseResult, MissionApi } from "../mission/MissionApi";

export interface StartupHost {
  api: MissionApi;
  toast(message: string, kind?: "error" | "info"): void;
  /** The `project` argument the mission layer last used on this robot, or "". */
  projectArg(): string;
  rememberProjectArg(value: string): void;
  /** A file name to suggest for the `project` argument, like `line2.mproj`. */
  projectFileName(): string;
}

const NAME_RE = /^[a-z][a-z0-9-]{0,31}$/;
const POLL_MS = 5000;
const LOG_LINES = 200;
const MISSION_PACKAGE = "mission_runner";
const MISSION_LAUNCH = "bringup.launch.py";
const RMW_CHOICES = ["rmw_fastrtps_cpp", "rmw_cyclonedds_cpp", "rmw_zenoh_cpp"];

// ---- the list ----------------------------------------------------------------

export function openRobotStartup(host: StartupHost): void {
  const api = host.api;
  const body = h("div", { class: "startup" });
  let info: AutostartInfo | null = null;
  let loadError = "";
  let missing = false;
  let loading = false;
  let closed = false;
  const busy = new Set<string>();

  const dialog = openModal({
    title: "Robot startup",
    size: "large",
    content: [body],
    buttons: [{ label: "Close" }],
    onDismiss: () => stop(),
  });
  dialog.element.classList.add("startup-modal");

  const unsubEvent = api.onEvent((ev) => {
    if (ev.type === "autostart.changed") void load();
  });
  const timer = window.setInterval(() => void load(), POLL_MS);
  function stop(): void {
    closed = true;
    unsubEvent();
    window.clearInterval(timer);
  }

  async function load(): Promise<void> {
    if (loading || closed) return;
    loading = true;
    try {
      info = await api.autostart();
      loadError = "";
      missing = false;
    } catch (err) {
      missing = err instanceof MissionApiError && err.message === AUTOSTART_MISSING;
      loadError = missing ? AUTOSTART_MISSING : `The robot's services could not be read: ${errorSentences(err).join(" ")}`;
    } finally {
      loading = false;
    }
    if (!closed) render();
  }

  const canChange = (): boolean => info !== null && info.supported && info.enabled !== false && !missing;

  function render(): void {
    const parts: Node[] = [];
    if (missing) {
      parts.push(banner("alert", AUTOSTART_MISSING, "warn"));
      body.replaceChildren(...parts);
      return;
    }
    if (loadError) parts.push(banner("alert", loadError, "error"));
    if (!info) {
      if (!loadError) parts.push(h("p", { class: "prose", text: "Reading the robot's services." }));
      body.replaceChildren(...parts);
      return;
    }
    if (!info.supported) {
      parts.push(banner("ban", `Services cannot be set up on this robot${info.reason ? `: ${trimStop(info.reason)}` : ""}. The list is read-only.`, "warn"));
    } else if (info.enabled === false) {
      parts.push(banner("ban", "Robot startup is turned off on this robot (autostart.enabled: false in runner.yaml). The list is read-only.", "warn"));
    } else if (info.linger === false) {
      parts.push(lingerBanner(info.user));
    }

    const addBtn = h("button", { class: "primary" }, icon("plus"), "Add service…");
    addBtn.disabled = !canChange();
    addBtn.addEventListener("click", () => editService(null));
    const layer = info.services.find(isMissionLayer);
    const layerBtn = h("button", {}, icon("layers"), "Add the mission layer");
    layerBtn.disabled = !canChange() || layer !== undefined;
    layerBtn.title = layer ? `${layer.name} already starts mission_runner.` : "mission_runner, foxglove_bridge and the station answers, started after your robot's service.";
    layerBtn.addEventListener("click", () => editService(null, missionLayerPreset(info!, host)));
    parts.push(
      h(
        "div",
        { class: "startup-head" },
        h("p", {
          class: "prose",
          text: `Each service starts one launch file when the robot boots and restarts it if it fails, as a systemd user service of ${info.user || "the runner's user"}. Nav2 keeps running in its own service when the mission layer restarts.`,
        }),
        h("div", { class: "row buttons" }, addBtn, layerBtn),
      ),
    );

    if (info.services.length === 0) {
      parts.push(h("div", { class: "startup-empty prose", text: "No services yet. Add one for your robot's launch file (drivers, localization, Nav2), then add the mission layer after it." }));
    } else {
      const list = h("div", { class: "startup-list" });
      for (const s of info.services) list.append(serviceCard(s));
      parts.push(list);
    }
    body.replaceChildren(...parts);
  }

  function serviceCard(s: AutostartService): HTMLElement {
    const state = stateOf(s);
    const head = h(
      "div",
      { class: "startup-card-head" },
      h("span", { class: `state-dot ${state.tone}`, title: `${s.active}${s.sub_state ? ` (${s.sub_state})` : ""}` }),
      h("span", { class: "startup-name", text: s.name }),
      h("span", { class: `startup-state ${state.tone}`, text: state.text }),
      ...(s.self ? [h("span", { class: "pill", text: "This connection", title: "mission_runner and the bridge Mission Builder is connected to run in this service." })] : []),
      ...(s.enabled === false ? [h("span", { class: "pill", text: "Off at boot" })] : []),
    );
    const lines: Node[] = [head];
    if (s.description) lines.push(h("div", { class: "startup-desc", text: s.description }));
    lines.push(h("div", { class: "startup-target", text: launchText(s) }));
    const bits: string[] = [];
    if (s.after.length > 0) bits.push(`Starts after ${joinAnd(s.after)}`);
    if (s.args.length > 0) bits.push(s.args.join(" "));
    if (s.ros_domain_id !== null && s.ros_domain_id !== undefined) bits.push(`ROS_DOMAIN_ID ${s.ros_domain_id}`);
    if (s.rmw) bits.push(s.rmw);
    if (bits.length > 0) lines.push(h("div", { class: "startup-meta", text: bits.join(" · ") }));

    const change = canChange() && !busy.has(s.name);
    const running = s.active === "active" || s.active === "activating" || s.active === "reloading";
    const btn = (label: string, iconName: Parameters<typeof icon>[0], run: () => void, enabled: boolean, kind = ""): HTMLButtonElement => {
      const b = h("button", { class: kind }, icon(iconName), label);
      b.disabled = !enabled;
      b.addEventListener("click", run);
      return b;
    };
    lines.push(
      h(
        "div",
        { class: "row buttons startup-actions" },
        btn("Start", "play", () => void act(s, "start"), change && !running),
        btn("Stop", "stop", () => void act(s, "stop"), change && running),
        btn("Restart", "refresh", () => void act(s, "restart"), change),
        btn("Log", "terminal", () => openLog(api, s.name), !missing && info?.supported === true),
        btn("Edit", "edit", () => editService(s), change),
        h("div", { class: "spacer" }),
        btn("Remove", "trash", () => void remove(s), change, "danger"),
      ),
    );
    return h("div", { class: `startup-card ${state.tone}` }, ...lines);
  }

  async function act(s: AutostartService, verb: AutostartVerb): Promise<void> {
    if (s.self && verb !== "start") {
      const answer = await choose(
        verb === "stop" ? `Stop ${s.name}?` : `Restart ${s.name}?`,
        verb === "stop"
          ? [
              `Mission Builder is connected to the robot through ${s.name}. Stopping it stops mission_runner and the bridge, so the connection to the robot will drop.`,
              `It starts again when the robot boots, or with mission_runner autostart start ${s.name} on the robot.`,
            ]
          : [`Mission Builder is connected to the robot through ${s.name}, so the connection drops while it restarts and comes back when the bridge is up again.`],
        [
          { value: "cancel", label: "Cancel" },
          { value: "go", label: verb === "stop" ? "Stop it" : "Restart it", kind: "danger" },
        ],
      );
      if (answer !== "go") return;
    }
    busy.add(s.name);
    render();
    try {
      await api.autostartAction(s.name, verb);
      if (s.self) host.toast(`${s.name} is ${verb === "stop" ? "stopping" : "restarting"}. The connection to the robot will drop.`, "info");
    } catch (err) {
      host.toast(`${s.name} could not be ${verb === "stop" ? "stopped" : verb === "start" ? "started" : "restarted"}: ${errorSentences(err).join(" ")}`);
    } finally {
      busy.delete(s.name);
    }
    await load();
  }

  async function remove(s: AutostartService): Promise<void> {
    const sentences = [`This stops ${s.name}, keeps it from starting at boot, and deletes its unit, wrapper script and settings on the robot. The launch file itself is not touched.`];
    if (s.self) {
      sentences.push(
        `Mission Builder is connected to the robot through ${s.name}: removing it stops mission_runner and the bridge, so the connection to the robot will drop and cannot come back until they are started another way on the robot.`,
      );
    }
    const dependents = info?.services.filter((o) => o.after.includes(s.name)).map((o) => o.name) ?? [];
    if (dependents.length > 0) sentences.push(`${joinAnd(dependents)} ${dependents.length === 1 ? "starts" : "start"} after it and will simply start without waiting.`);
    const answer = await choose(`Remove ${s.name}?`, sentences, [
      { value: "cancel", label: "Cancel" },
      { value: "remove", label: s.self ? "Remove and disconnect" : "Remove service", kind: "danger" },
    ]);
    if (answer !== "remove") return;
    busy.add(s.name);
    render();
    try {
      const res = await api.removeAutostart(s.name);
      host.toast(res.self ? `${s.name} was removed. The connection to the robot drops in a moment.` : `${s.name} was removed from the robot.`, "info");
    } catch (err) {
      host.toast(`${s.name} could not be removed: ${errorSentences(err).join(" ")}`);
    } finally {
      busy.delete(s.name);
    }
    await load();
  }

  function editService(existing: AutostartService | null, preset?: ServicePreset): void {
    if (!info) return;
    openServiceDialog({
      api,
      info,
      existing,
      preset,
      saved: (s, spec) => {
        if (s.launch.package === MISSION_PACKAGE || spec.launch.package === MISSION_PACKAGE) {
          const project = (spec.args ?? []).find((a) => a.startsWith("project:="));
          if (project !== undefined) host.rememberProjectArg(project.slice("project:=".length));
        }
        host.toast(
          existing
            ? `${s.name} was saved${spec.start_now ? " and restarted" : ""}.`
            : `${s.name} now starts when the robot boots${spec.start_now ? ", and it is starting now" : ". Start it now from the list, or reboot"}.`,
          "info",
        );
        void load();
      },
    });
  }

  function lingerBanner(user: string): HTMLElement {
    const command = `sudo loginctl enable-linger ${user || "$USER"}`;
    const note = h("span", { class: "startup-banner-note" });
    const tryBtn = h("button", {}, icon("power"), "Try now");
    tryBtn.addEventListener("click", () => {
      tryBtn.disabled = true;
      note.textContent = "";
      void api
        .autostartLinger()
        .then(async (res) => {
          if (res.linger) {
            host.toast("Linger is on: the services will start at boot without anyone logging in.", "info");
            await load();
          } else {
            note.textContent = `The robot did not allow it without sudo. Run ${res.command ?? command} on the robot once.`;
          }
        })
        .catch((err: unknown) => {
          note.textContent = `It could not be turned on: ${errorSentences(err).join(" ")}`;
        })
        .finally(() => {
          tryBtn.disabled = false;
        });
    });
    const copyBtn = h("button", { title: "Copy the command" }, icon("copy"), "Copy command");
    copyBtn.addEventListener("click", () => void copyText(command).then((ok) => host.toast(ok ? "The command is copied." : `Copy did not work here. The command is: ${command}`, "info")));
    return h(
      "div",
      { class: "startup-banner warn" },
      icon("alert"),
      h(
        "div",
        { class: "startup-banner-text" },
        h("span", {}, "Services will only start at boot after ", h("code", { text: command }), " is run once on the robot."),
        note,
      ),
      tryBtn,
      copyBtn,
    );
  }

  render();
  void load();
}

function banner(iconName: "alert" | "ban" | "info", text: string, tone: "warn" | "error" | "info"): HTMLElement {
  return h("div", { class: `startup-banner ${tone}` }, icon(iconName), h("div", { class: "startup-banner-text", text }));
}

function isMissionLayer(s: AutostartService): boolean {
  return s.launch.package === MISSION_PACKAGE;
}

function launchText(s: { launch: AutostartService["launch"] }): string {
  return s.launch.package ? `${s.launch.package} ${s.launch.file}` : s.launch.file;
}

/** "Running since 08:02", "Failed, restarted 3 times", "Stopped". */
export function stateOf(s: AutostartService): { text: string; tone: "ok" | "warn" | "err" | "off" } {
  const restarted = s.restarts > 0 ? `restarted ${s.restarts} ${s.restarts === 1 ? "time" : "times"}` : "";
  switch (s.active) {
    case "active":
      return { text: `Running${s.since ? ` since ${clock(s.since)}` : ""}${restarted ? `, ${restarted}` : ""}`, tone: "ok" };
    case "activating":
      return { text: restarted ? `Starting again, ${restarted}` : "Starting", tone: "warn" };
    case "deactivating":
      return { text: "Stopping", tone: "warn" };
    case "reloading":
      return { text: "Reloading", tone: "warn" };
    case "failed":
      return { text: restarted ? `Failed, ${restarted}` : "Failed", tone: "err" };
    case "inactive":
      return { text: "Stopped", tone: "off" };
    default:
      return { text: s.active ? s.active.charAt(0).toUpperCase() + s.active.slice(1) : "Unknown", tone: "off" };
  }
}

function clock(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  const time = d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", hourCycle: "h23" });
  const today = new Date();
  if (d.toDateString() === today.toDateString()) return time;
  return `${d.toLocaleDateString([], { day: "numeric", month: "short" })} ${time}`;
}

function joinAnd(items: readonly string[]): string {
  if (items.length <= 1) return items.join("");
  return `${items.slice(0, -1).join(", ")} and ${items[items.length - 1]}`;
}

function trimStop(text: string): string {
  return text.trim().replace(/\.$/, "");
}

async function copyText(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    return false;
  }
}

// ---- add and edit ------------------------------------------------------------

interface ServicePreset {
  name: string;
  description: string;
  launch: AutostartSpec["launch"];
  args: string[];
  workspaces: string[];
  after: string[];
  /** An argument whose value is only a suggestion: shown as a placeholder. */
  placeholders?: Record<string, string>;
  note?: string;
}

function missionLayerPreset(info: AutostartInfo, host: StartupHost): ServicePreset {
  const taken = info.services.map((s) => s.name);
  let name = "mission";
  for (let i = 2; taken.includes(name); i++) name = `mission-${i}`;
  const first = info.services.find((s) => !isMissionLayer(s));
  const home = info.user ? (info.user === "root" ? "/root" : `/home/${info.user}`) : "~";
  return {
    name,
    description: "Mission layer: mission_runner, foxglove_bridge and station answers",
    launch: { package: MISSION_PACKAGE, file: MISSION_LAUNCH },
    args: [`project:=${host.projectArg()}`],
    workspaces: first ? [...first.workspaces] : [],
    after: first ? [first.name] : [],
    placeholders: { project: `${home}/${host.projectFileName()}` },
    note: first
      ? `Starts after ${first.name}; mission_runner waits for Nav2 to become active, so the order at boot is safe. The workspaces are copied from ${first.name}: the workspace that has mission_runner has to be one of them.`
      : "There is no service for your robot's launch file yet. Add it too, so Nav2 is running when the mission layer starts.",
  };
}

interface ServiceDialogOptions {
  api: MissionApi;
  info: AutostartInfo;
  existing: AutostartService | null;
  preset?: ServicePreset;
  saved(service: AutostartService, spec: AutostartSpec): void;
}

function openServiceDialog(opts: ServiceDialogOptions): void {
  const { api, info, existing, preset } = opts;
  const src = existing ?? preset ?? null;

  const name = h("input", { type: "text", value: existing?.name ?? preset?.name ?? "", placeholder: "robot", spellcheck: false });
  name.disabled = existing !== null;
  const description = h("input", { type: "text", value: existing?.description ?? preset?.description ?? "", placeholder: "Drivers, localization and Nav2" });

  // launch target
  let mode: "file" | "package" = src?.launch.package ? "package" : "file";
  const filePath = h("input", { type: "text", class: "mono", value: src && !src.launch.package ? src.launch.file : "", placeholder: `/home/${info.user || "pi"}/robot_ws/src/my_robot/launch/robot.launch.py`, spellcheck: false });
  const browseBtn = h("button", {}, icon("folder"), "Browse…");
  const pkg = h("input", { type: "text", class: "mono", value: src?.launch.package ?? "", placeholder: "my_robot", spellcheck: false });
  const pkgFile = h("input", { type: "text", class: "mono", value: src?.launch.package ? src.launch.file : "", placeholder: "robot.launch.py", spellcheck: false });
  const modeFile = h("button", {}, icon("file"), "Launch file");
  const modePkg = h("button", {}, icon("layers"), "Package and file");
  const fileBox = h("div", { class: "field" }, h("div", { class: "row" }, filePath, browseBtn), h("span", { class: "field-help", text: "A launch file on the robot: .launch.py, .launch.xml or .launch.yaml, or a .py, .xml or .yaml file in a launch folder." }));
  const pkgBox = h("div", { class: "field-row" }, field("Package", pkg), field("Launch file in the package", pkgFile));
  const syncMode = (): void => {
    modeFile.classList.toggle("active", mode === "file");
    modePkg.classList.toggle("active", mode === "package");
    fileBox.hidden = mode !== "file";
    pkgBox.hidden = mode !== "package";
  };
  modeFile.addEventListener("click", () => {
    mode = "file";
    syncMode();
  });
  modePkg.addEventListener("click", () => {
    mode = "package";
    syncMode();
  });
  syncMode();

  // arguments
  const args = rowsControl({
    addLabel: "Add argument",
    empty: "No arguments: the launch file's defaults are used.",
    pair: true,
    placeholders: preset?.placeholders,
  });
  for (const a of src?.args ?? []) {
    const at = a.indexOf(":=");
    args.add(at < 0 ? a : a.slice(0, at), at < 0 ? "" : a.slice(at + 2));
  }

  // workspaces
  const workspaceNote = h("span", { class: "field-help" });
  const distroSentence = info.ros_distro ? `/opt/ros/${info.ros_distro}/setup.bash is sourced first.` : "The ROS installation in /opt/ros is sourced first.";
  workspaceNote.textContent = `${distroSentence} Then these, in order. Leave the list empty to let the robot pick the workspaces around the launch file.`;
  let workspacesTouched = existing !== null || (preset?.workspaces.length ?? 0) > 0;
  const workspaces = rowsControl({
    addLabel: "Add workspace",
    empty: "None.",
    pair: false,
    valuePlaceholder: `/home/${info.user || "pi"}/robot_ws/install/setup.bash`,
    changed: () => {
      workspacesTouched = true;
    },
  });
  for (const w of src?.workspaces ?? []) workspaces.add(w, "");

  const fillWorkspaces = (file: string): void => {
    // What the robot refused was about the old target.
    showErrors([]);
    dialog.setError("");
    if (workspacesTouched && workspaces.values().length > 0) return;
    workspaceNote.textContent = "Looking for workspaces around the launch file.";
    void suggestWorkspaces(api, file, info.roots).then((found) => {
      workspaceNote.textContent = `${distroSentence} Then these, in order. Filled from the launch file's folders; edit them if the robot needs others.`;
      if (workspacesTouched && workspaces.values().length > 0) return;
      workspaces.set(found.map((f) => [f, ""]));
      workspacesTouched = false;
    });
  };
  browseBtn.addEventListener("click", () => {
    openFileBrowser(api, info.roots, filePath.value.trim(), (path) => {
      filePath.value = path;
      fillWorkspaces(path);
    });
  });
  filePath.addEventListener("change", () => {
    const v = filePath.value.trim();
    if (v.startsWith("/")) fillWorkspaces(v);
  });

  // environment
  const domain = h("input", { type: "number", min: 0, max: 232, step: 1, placeholder: "Not set", value: src && "ros_domain_id" in src && src.ros_domain_id !== null && src.ros_domain_id !== undefined ? String(src.ros_domain_id) : "" });
  const rmw = h("select", {}, h("option", { value: "", text: "Not set (the robot's default)" }));
  const currentRmw = existing?.rmw ?? "";
  for (const r of new Set([...RMW_CHOICES, ...(currentRmw ? [currentRmw] : [])])) rmw.append(h("option", { value: r, text: r }));
  rmw.value = currentRmw;

  // order
  const afterBoxes = new Map<string, HTMLInputElement>();
  const others = info.services.filter((s) => s.name !== existing?.name);
  const wantedAfter = new Set(src?.after ?? []);
  const afterList = h("div", { class: "startup-after" });
  if (others.length === 0) afterList.append(h("span", { class: "field-help", text: "There are no other services to wait for." }));
  for (const o of others) {
    const box = h("input", { type: "checkbox" });
    box.checked = wantedAfter.has(o.name);
    afterBoxes.set(o.name, box);
    afterList.append(h("label", { class: "check-row" }, box, h("span", { text: o.name }), h("span", { class: "field-help", text: launchText(o) })));
  }
  for (const n of wantedAfter) {
    if (afterBoxes.has(n) || n === existing?.name) continue;
    const box = h("input", { type: "checkbox" });
    box.checked = true;
    afterBoxes.set(n, box);
    afterList.append(h("label", { class: "check-row" }, box, h("span", { text: n }), h("span", { class: "field-help", text: "not on the robot" })));
  }

  const startNow = h("input", { type: "checkbox" });
  const errorsBox = h("div", { class: "startup-errors" });
  errorsBox.hidden = true;

  const content: Node[] = [];
  if (preset?.note) content.push(h("p", { class: "prose", text: preset.note }));
  content.push(
    h("div", { class: "field-row" }, field("Name", name, existing ? "The name cannot be changed. Remove the service and add it again to rename it." : "Lowercase letters, digits and hyphens, starting with a letter."), field("Description", description)),
    h("div", { class: "field" }, h("span", { class: "field-label", text: "Launch" }), h("div", { class: "seg" }, modeFile, modePkg)),
    fileBox,
    pkgBox,
    h("div", { class: "field" }, h("span", { class: "field-label", text: "Launch arguments" }), args.element),
    h("div", { class: "field" }, h("span", { class: "field-label", text: "Workspaces" }), workspaces.element, workspaceNote),
    h("div", { class: "field-row" }, field("ROS_DOMAIN_ID", domain), field("RMW implementation", rmw)),
    h("div", { class: "field" }, h("span", { class: "field-label", text: "Start after" }), afterList),
    h("label", { class: "check-row" }, startNow, h("span", { text: existing ? "Restart it now with these settings" : "Start it now" })),
    h("p", { class: "prose", text: "Leave this off while the same launch file is already running by hand, or the two copies fight over the robot." }),
    errorsBox,
  );

  const dialog: ModalHandle = openModal({
    title: existing ? `Edit ${existing.name}` : preset ? "Add the mission layer" : "Add service",
    size: "medium",
    content,
    buttons: [
      { label: "Cancel" },
      {
        label: existing ? "Save service" : "Add service",
        kind: "primary",
        run: async () => {
          showErrors([]);
          dialog.setError("");
          const n = name.value.trim();
          if (!NAME_RE.test(n)) return fail("A service name is lowercase letters, digits and hyphens, starting with a letter, at most 32 characters.");
          if (!existing && info.services.some((s) => s.name === n)) return fail(`There already is a service called ${n}. Edit it instead, or pick another name.`);
          let launch: AutostartSpec["launch"];
          if (mode === "file") {
            const f = filePath.value.trim();
            if (f === "") return fail("Choose the launch file, with Browse… or by typing its full path on the robot.");
            launch = { file: f };
          } else {
            const p = pkg.value.trim();
            const f = pkgFile.value.trim();
            if (p === "" || f === "") return fail("Fill in both the package and its launch file.");
            launch = { package: p, file: f };
          }
          const argList: string[] = [];
          for (const [k, v] of args.values()) {
            if (k === "" && v === "") continue;
            if (k === "") return fail(`The argument with the value ${v} needs a name.`);
            argList.push(`${k}:=${v}`);
          }
          const spec: AutostartSpec = { launch, args: argList, workspaces: workspaces.values().map(([w]) => w).filter((w) => w !== "") };
          const d = description.value.trim();
          if (d !== "") spec.description = d;
          if (domain.value.trim() !== "") {
            const id = Number(domain.value);
            if (!Number.isInteger(id) || id < 0) return fail("ROS_DOMAIN_ID is a whole number, 0 or more.");
            spec.ros_domain_id = id;
          }
          if (rmw.value !== "") spec.rmw = rmw.value;
          spec.after = [...afterBoxes].filter(([, b]) => b.checked).map(([k]) => k);
          spec.start_now = startNow.checked;
          dialog.setBusy(true);
          try {
            const service = await api.putAutostart(n, spec);
            opts.saved(service, spec);
            return true;
          } catch (err) {
            if (err instanceof MissionApiError && err.status === 400) {
              showErrors(errorSentences(err));
            } else {
              dialog.setError(`The robot did not save it: ${errorSentences(err).join(" ")}`);
            }
            return false;
          } finally {
            dialog.setBusy(false);
          }
        },
      },
    ],
  });
  dialog.element.classList.add("startup-edit");
  if (existing) description.focus();

  function showErrors(list: string[]): void {
    errorsBox.replaceChildren(...(list.length > 0 ? [h("div", { class: "field-label", text: "The robot refused these settings" })] : []), ...list.map((e) => h("div", { class: "finding error", text: e })));
    errorsBox.hidden = list.length === 0;
    if (list.length > 0) errorsBox.scrollIntoView({ block: "nearest" });
  }
  function fail(sentence: string): false {
    dialog.setError(sentence);
    return false;
  }
}

/** Rows of `name := value` (or a single value), with add and remove. */
function rowsControl(opts: {
  addLabel: string;
  empty: string;
  pair: boolean;
  valuePlaceholder?: string;
  placeholders?: Record<string, string>;
  changed?: () => void;
}): { element: HTMLElement; add(key: string, value: string): void; set(rows: [string, string][]): void; values(): [string, string][] } {
  const list = h("div", { class: "list-control" });
  const rows: { key: HTMLInputElement | null; value: HTMLInputElement; el: HTMLElement }[] = [];
  const emptyNote = h("span", { class: "field-help", text: opts.empty });
  const addBtn = h("button", {}, icon("plus"), opts.addLabel);
  const sync = (): void => {
    emptyNote.hidden = rows.length > 0;
  };
  const add = (key: string, value: string): void => {
    const keyInput = opts.pair ? h("input", { type: "text", class: "mono kv-key-input", value: key, placeholder: "name", spellcheck: false }) : null;
    const valueInput = h("input", { type: "text", class: "mono", value: opts.pair ? value : key, placeholder: opts.pair ? (opts.placeholders?.[key] ?? "value") : (opts.valuePlaceholder ?? ""), spellcheck: false });
    const del = h("button", { class: "icon-only", title: "Remove this row" }, icon("close"));
    const el = h("div", { class: "list-item" }, ...(keyInput ? [keyInput, h("span", { class: "kv-sep", text: ":=" })] : []), valueInput, del);
    const entry = { key: keyInput, value: valueInput, el };
    del.addEventListener("click", () => {
      rows.splice(rows.indexOf(entry), 1);
      el.remove();
      sync();
      opts.changed?.();
    });
    for (const input of [keyInput, valueInput]) input?.addEventListener("input", () => opts.changed?.());
    rows.push(entry);
    list.insertBefore(el, emptyNote);
    sync();
  };
  addBtn.addEventListener("click", () => {
    add("", "");
    opts.changed?.();
    (rows[rows.length - 1]?.key ?? rows[rows.length - 1]?.value)?.focus();
  });
  list.append(emptyNote, addBtn);
  sync();
  return {
    element: list,
    add,
    set(next) {
      for (const r of rows) r.el.remove();
      rows.length = 0;
      for (const [k, v] of next) add(k, v);
      sync();
    },
    values: () => rows.map((r) => (r.key ? [r.key.value.trim(), r.value.value] : [r.value.value.trim(), ""])),
  };
}

/**
 * The workspaces a launch file most likely needs: the `install/setup.bash`
 * of every folder above it, inside the root it is in, nearest last. The
 * robot applies the same rule when the list is left empty.
 */
async function suggestWorkspaces(api: MissionApi, file: string, roots: readonly string[]): Promise<string[]> {
  const root = rootOf(file, roots);
  if (!root) return [];
  const dirs: string[] = [];
  for (let dir = parentOf(file); dir !== null && isUnder(dir, root); dir = parentOf(dir)) {
    dirs.unshift(dir);
    if (dir === root) break;
  }
  const found = await Promise.all(
    dirs.map(async (dir) => {
      try {
        const listing = await api.autostartBrowse(dir);
        if (!listing.entries.some((e) => e.kind === "dir" && e.name === "install")) return null;
        const install = await api.autostartBrowse(joinPath(dir, "install"));
        return install.entries.some((e) => e.kind === "file" && e.name === "setup.bash") ? joinPath(dir, "install/setup.bash") : null;
      } catch {
        return null;
      }
    }),
  );
  return found.filter((f): f is string => f !== null);
}

// ---- the file browser on the robot ------------------------------------------

function openFileBrowser(api: MissionApi, knownRoots: readonly string[], current: string, choose: (path: string) => void): void {
  let roots = [...knownRoots];
  let listing: BrowseResult | null = null;
  let selected: BrowseEntry | null = null;

  const rootsRow = h("div", { class: "browse-roots" });
  const crumbs = h("div", { class: "browse-crumbs" });
  const list = h("div", { class: "browse-list" });
  const pathInput = h("input", { type: "text", class: "mono", spellcheck: false, placeholder: "/home/pi/robot_ws/src/my_robot/launch/robot.launch.py" });
  const legend = h("p", { class: "prose", text: "Launch files can be chosen. Other files are shown greyed out. Type a path and press Enter to go there." });

  const dialog = openModal({
    title: "Choose a launch file on the robot",
    size: "medium",
    content: [rootsRow, crumbs, list, field("Path", pathInput), legend],
    buttons: [
      { label: "Cancel" },
      {
        label: "Choose",
        kind: "primary",
        run: async () => await accept(),
      },
    ],
  });
  dialog.element.classList.add("browse-modal");

  async function go(path?: string): Promise<boolean> {
    list.classList.add("loading");
    try {
      const res = await api.autostartBrowse(path);
      listing = res;
      if (Array.isArray(res.roots) && res.roots.length > 0) roots = res.roots;
      selected = null;
      dialog.setError("");
      pathInput.value = res.path;
      render();
      return true;
    } catch (err) {
      dialog.setError(errorSentences(err).join(" "));
      return false;
    } finally {
      list.classList.remove("loading");
    }
  }

  /** Choose the selection, or go to (or choose) whatever path was typed. */
  async function accept(): Promise<boolean> {
    const typed = pathInput.value.trim().replace(/\/+$/, "") || "/";
    if (selected && typed === selected.path) {
      choose(selected.path);
      return true;
    }
    if (listing && typed === listing.path.replace(/\/+$/, "")) {
      dialog.setError("Pick a launch file in this folder, or type the path of one.");
      return false;
    }
    if (!typed.startsWith("/")) {
      dialog.setError("Type the full path on the robot, starting with /.");
      return false;
    }
    // A folder: go there. Otherwise look the file up in its folder.
    try {
      const res = await api.autostartBrowse(typed);
      if (res && typeof res.path === "string" && Array.isArray(res.entries)) {
        listing = res;
        if (Array.isArray(res.roots) && res.roots.length > 0) roots = res.roots;
        selected = null;
        pathInput.value = res.path;
        dialog.setError("");
        render();
        return false;
      }
    } catch {
      /* not a folder that can be listed: maybe a file */
    }
    const parent = parentOf(typed);
    if (parent === null) {
      dialog.setError(`${typed} cannot be opened.`);
      return false;
    }
    let folder: BrowseResult;
    try {
      folder = await api.autostartBrowse(parent);
    } catch (err) {
      dialog.setError(errorSentences(err).join(" "));
      return false;
    }
    listing = folder;
    render();
    const base = typed.slice(parent.length).replace(/^\/+/, "");
    const entry = folder.entries.find((e) => e.name === base);
    if (!entry) {
      pathInput.value = typed;
      dialog.setError(`There is no ${base} in ${folder.path}.`);
      return false;
    }
    if (entry.kind === "file" && !entry.launch) {
      select(entry);
      dialog.setError(`${entry.name} is not a launch file. A launch file ends in .launch.py, .launch.xml or .launch.yaml, or is a .py, .xml or .yaml file in a launch folder.`);
      return false;
    }
    choose(entry.path);
    return true;
  }

  function select(entry: BrowseEntry): void {
    selected = entry;
    pathInput.value = entry.path;
    for (const row of list.querySelectorAll<HTMLElement>(".browse-row")) row.classList.toggle("selected", row.dataset.path === entry.path);
  }

  function render(): void {
    const res = listing;
    rootsRow.replaceChildren(h("span", { class: "field-label", text: "Places" }));
    for (const r of roots) {
      const b = h("button", { class: res && isUnder(res.path, r) ? "active" : "" }, icon(r.startsWith("/opt/ros") ? "layers" : "home"), r);
      b.addEventListener("click", () => void go(r));
      rootsRow.append(b);
    }
    crumbs.replaceChildren();
    if (!res) return;
    const root = rootOf(res.path, roots);
    const up = h("button", { class: "icon-only", title: "Up one folder" }, icon("arrowUp"));
    up.disabled = res.parent === null;
    up.addEventListener("click", () => {
      if (res.parent !== null) void go(res.parent);
    });
    crumbs.append(up);
    const segments: { label: string; path: string }[] = [];
    if (root) {
      segments.push({ label: root, path: root });
      const rest = res.path.slice(root.length).split("/").filter((s) => s !== "");
      let acc = root;
      for (const seg of rest) {
        acc = joinPath(acc, seg);
        segments.push({ label: seg, path: acc });
      }
    } else {
      segments.push({ label: res.path, path: res.path });
    }
    segments.forEach((seg, i) => {
      if (i > 0) crumbs.append(h("span", { class: "crumb-sep", text: "/" }));
      const last = i === segments.length - 1;
      const b = h("button", { class: `crumb${last ? " current" : ""}`, text: seg.label });
      b.disabled = last;
      b.addEventListener("click", () => void go(seg.path));
      crumbs.append(b);
    });

    const entries = [...res.entries].sort((a, b) => (a.kind === b.kind ? a.name.localeCompare(b.name) : a.kind === "dir" ? -1 : 1));
    list.replaceChildren();
    if (entries.length === 0) list.append(h("div", { class: "browse-empty prose", text: "This folder is empty." }));
    for (const e of entries) {
      const kind = e.kind === "dir" ? "dir" : e.launch ? "launch" : "other";
      const row = h(
        "button",
        { class: `browse-row ${kind}`, title: kind === "other" ? "Not a launch file" : e.path },
        icon(kind === "dir" ? "folder" : kind === "launch" ? "play" : "file"),
        h("span", { class: "browse-name", text: e.name }),
        h("span", { class: "browse-kind", text: kind === "dir" ? "" : kind === "launch" ? "launch file" : "" }),
      );
      row.dataset.path = e.path;
      if (kind === "other") row.disabled = true;
      row.addEventListener("click", () => {
        if (kind === "dir") void go(e.path);
        else if (kind === "launch") select(e);
      });
      row.addEventListener("dblclick", () => {
        if (kind !== "launch") return;
        choose(e.path);
        dialog.close();
      });
      list.append(row);
    }
    if (selected) select(selected);
  }

  render();
  const startDir = current.startsWith("/") ? parentOf(current) : null;
  void go(startDir ?? undefined).then((ok) => {
    if (ok && current && listing) {
      const entry = listing.entries.find((e) => e.path === current);
      if (entry?.launch) select(entry);
    } else if (!ok && startDir) {
      void go();
    }
  });
  pathInput.focus();
}

// ---- the log -----------------------------------------------------------------

function openLog(api: MissionApi, name: string): void {
  const text = h("pre", { class: "export-text startup-log", text: "Reading the journal." });
  const meta = h("p", { class: "prose", text: `The last ${LOG_LINES} lines of journalctl --user -u mission-autostart-${name}.service.` });
  const load = async (): Promise<void> => {
    try {
      const lines = await api.autostartLog(name, LOG_LINES);
      text.textContent = lines.length > 0 ? lines.join("\n") : "The journal has nothing for this service yet.";
      meta.textContent = `The last ${LOG_LINES} lines of journalctl --user -u mission-autostart-${name}.service, read at ${new Date().toLocaleTimeString([], { hourCycle: "h23" })}.`;
      text.scrollTop = text.scrollHeight;
    } catch (err) {
      text.textContent = `The log could not be read: ${errorSentences(err).join(" ")}`;
    }
  };
  openModal({
    title: `Log of ${name}`,
    size: "large",
    content: [meta, text],
    buttons: [
      {
        label: "Refresh",
        icon: "refresh",
        run: async () => {
          await load();
          return false;
        },
      },
      { label: "Close", kind: "primary", run: () => true },
    ],
  }).element.classList.add("log-modal");
  void load();
}

// ---- paths on the robot (always POSIX) ---------------------------------------

function parentOf(path: string): string | null {
  const p = path.replace(/\/+$/, "");
  if (p === "" || p === "/") return null;
  const at = p.lastIndexOf("/");
  return at <= 0 ? "/" : p.slice(0, at);
}

function joinPath(dir: string, rest: string): string {
  return `${dir.replace(/\/+$/, "")}/${rest.replace(/^\/+/, "")}`;
}

function isUnder(path: string, root: string): boolean {
  const r = root.replace(/\/+$/, "");
  return path === r || path.startsWith(`${r}/`) || r === "";
}

/** The longest root a path is inside, or null. */
function rootOf(path: string, roots: readonly string[]): string | null {
  let best: string | null = null;
  for (const r of roots) {
    const clean = r.replace(/\/+$/, "") || "/";
    if (isUnder(path, clean) && (best === null || clean.length > best.length)) best = clean;
  }
  return best;
}
