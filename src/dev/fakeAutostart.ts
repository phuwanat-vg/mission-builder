/**
 * DEV BUILD ONLY. A fake robot for the Robot startup dialog: the
 * `/api/autostart` contract of Mission/docs/robot-startup.md answered from
 * memory, over a small fake file tree. Loaded by main.ts only when
 * `import.meta.env.DEV` and the page has `?fake-robot=1`, so production
 * bundles never contain it.
 *
 *   ?fake-robot=1                 supported, linger off, no services
 *   &fake-linger=1                linger already on
 *   &fake-unsupported=1           supported: false (like the runner on Windows)
 *   &fake-old=1                   a runner without /api/autostart (404)
 *   &fake-services=1              start with a robot and a mission service
 */

import type { AutostartOverride, AutostartService, AutostartSpec, MissionApi, RunnerEvent } from "../mission/MissionApi";

const USER = "pi";
const HOME = `/home/${USER}`;
const DISTRO = "jazzy";
const ROOTS = [HOME, "/opt/ros"];

const FILES = [
  `${HOME}/.bashrc`,
  `${HOME}/line2.mproj`,
  `${HOME}/maps/floor1.yaml`,
  `${HOME}/maps/floor1.pgm`,
  `${HOME}/robot_ws/install/setup.bash`,
  `${HOME}/robot_ws/install/my_robot/share/my_robot/launch/robot.launch.py`,
  `${HOME}/robot_ws/src/my_robot/package.xml`,
  `${HOME}/robot_ws/src/my_robot/CMakeLists.txt`,
  `${HOME}/robot_ws/src/my_robot/README.md`,
  `${HOME}/robot_ws/src/my_robot/launch/robot.launch.py`,
  `${HOME}/robot_ws/src/my_robot/launch/sim.launch.py`,
  `${HOME}/robot_ws/src/my_robot/launch/lidar.launch.xml`,
  `${HOME}/robot_ws/src/my_robot/config/nav2_params.yaml`,
  `${HOME}/robot_ws/src/my_robot/config/fast_lio.yaml`,
  `${HOME}/ros2_ws/install/setup.bash`,
  `${HOME}/ros2_ws/install/mission_runner/share/mission_runner/launch/bringup.launch.py`,
  `${HOME}/ros2_ws/install/mission_runner/share/mission_runner/launch/mission_runner.launch.py`,
  `${HOME}/ros2_ws/src/mission/runner/package.xml`,
  `/opt/ros/${DISTRO}/setup.bash`,
  `/opt/ros/${DISTRO}/share/nav2_bringup/launch/navigation_launch.py`,
  `/opt/ros/${DISTRO}/share/nav2_bringup/launch/bringup_launch.py`,
  `/opt/ros/${DISTRO}/share/nav2_bringup/params/nav2_params.yaml`,
];
const PACKAGES: Record<string, string[]> = {
  mission_runner: ["bringup.launch.py", "mission_runner.launch.py"],
  my_robot: ["robot.launch.py", "sim.launch.py", "lidar.launch.xml"],
  nav2_bringup: ["navigation_launch.py", "bringup_launch.py"],
};

const NAME_RE = /^[a-z][a-z0-9-]{0,31}$/;
const ARG_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;
const PKG_RE = /^[A-Za-z0-9_.-]+$/;

interface Entry {
  spec: AutostartSpec;
  service: AutostartService;
  log: string[];
  timer?: number;
}

function isLaunchFile(path: string): boolean {
  if (/\.launch\.(py|xml|yaml)$/.test(path)) return true;
  const parts = path.split("/");
  return /\.(py|xml|yaml)$/.test(path) && parts[parts.length - 2] === "launch";
}

function stamp(): string {
  return new Date().toISOString().replace(/\.\d+Z$/, "+0000");
}

export function installFakeAutostart(api: MissionApi, params: URLSearchParams): void {
  const flag = (k: string): boolean => params.get(k) === "1";
  if (flag("fake-old")) {
    const old: AutostartOverride = async () => ({ status: 404, body: { error: "not found" } });
    api.setAutostartOverride(old);
    return;
  }
  const supported = !flag("fake-unsupported");
  let linger = flag("fake-linger");
  let lingerTries = 0;
  const services = new Map<string, Entry>();

  const dirs = new Set<string>();
  for (const f of FILES) {
    for (let at = f.lastIndexOf("/"); at > 0; at = f.lastIndexOf("/", at - 1)) dirs.add(f.slice(0, at));
  }
  const exists = (p: string): boolean => FILES.includes(p) || dirs.has(p);
  const under = (p: string): boolean => ROOTS.some((r) => p === r || p.startsWith(`${r}/`));

  const unit = (name: string): string => `mission-autostart-${name}.service`;
  const log = (e: Entry, line: string): void => {
    e.log.push(`${stamp()} raspberrypi ${e.service.name}[${e.service.main_pid ?? 0}]: ${line}`);
    if (e.log.length > 1000) e.log.splice(0, e.log.length - 1000);
  };
  const systemdLog = (e: Entry, line: string): void => {
    e.log.push(`${stamp()} raspberrypi systemd[1102]: ${line}`);
  };

  function startEntry(e: Entry, emit: (ev: RunnerEvent) => void): void {
    window.clearTimeout(e.timer);
    const s = e.service;
    s.active = "activating";
    s.sub_state = "start";
    s.main_pid = 2000 + Math.floor(Math.random() * 6000);
    systemdLog(e, `Starting ${unit(s.name)} - ${s.description || s.name} (mission_runner autostart)...`);
    e.timer = window.setTimeout(() => {
      s.active = "active";
      s.sub_state = "running";
      s.since = new Date().toISOString();
      systemdLog(e, `Started ${unit(s.name)}.`);
      const target = e.spec.launch.package ? `${e.spec.launch.package} ${e.spec.launch.file}` : e.spec.launch.file;
      log(e, `[INFO] [launch]: All log files can be found below /home/pi/.ros/log`);
      log(e, `[INFO] [launch]: Default logging verbosity is set to INFO`);
      log(e, `[INFO] [launch]: ros2 launch ${target} ${(e.spec.args ?? []).join(" ")}`.trim());
      if (e.spec.launch.package === "mission_runner") {
        log(e, "[INFO] [mission_runner-1]: process started with pid [" + String(s.main_pid) + "]");
        log(e, "[INFO] [foxglove_bridge-2]: process started");
        log(e, "[mission_runner-1] waiting for Nav2 to become active");
      } else {
        log(e, "[INFO] [lifecycle_manager_navigation]: Managed nodes are active");
      }
      emit({ type: "autostart.changed", name: s.name });
    }, 1500);
  }

  function stopEntry(e: Entry): void {
    window.clearTimeout(e.timer);
    const s = e.service;
    if (s.active !== "inactive") systemdLog(e, `Stopping ${unit(s.name)}...`);
    s.active = "inactive";
    s.sub_state = "dead";
    s.main_pid = null;
    s.since = null;
    systemdLog(e, `Stopped ${unit(s.name)}.`);
  }

  function validate(name: string, body: unknown): { errors: string[]; spec?: AutostartSpec } {
    const errors: string[] = [];
    if (!NAME_RE.test(name)) errors.push(`name: ${name} does not match ^[a-z][a-z0-9-]{0,31}$`);
    if (typeof body !== "object" || body === null) return { errors: [...errors, "body: expected a JSON object"] };
    const spec = body as AutostartSpec;
    const launch = spec.launch as { file?: unknown; package?: unknown } | undefined;
    if (!launch || typeof launch.file !== "string") errors.push("launch: give {file} or {package, file}");
    else if (launch.package !== undefined) {
      if (typeof launch.package !== "string" || !PKG_RE.test(launch.package)) errors.push(`launch.package: ${String(launch.package)} is not a package name`);
      else if (!PACKAGES[launch.package]) errors.push(`launch.package: package ${launch.package} is not installed`);
      if (!PKG_RE.test(launch.file)) errors.push(`launch.file: ${launch.file} is a file name, not a path, for the package form`);
      else if (typeof launch.package === "string" && PACKAGES[launch.package] && !PACKAGES[launch.package]!.includes(launch.file)) errors.push(`launch.file: ${launch.package} has no launch file ${launch.file}`);
    } else {
      const f = launch.file;
      if (!f.startsWith("/")) errors.push(`launch.file: ${f} is not an absolute path`);
      else if (!under(f)) errors.push(`launch.file: ${f} is not under an allowed root (${ROOTS.join(", ")})`);
      else if (!FILES.includes(f)) errors.push(`launch.file: ${f} does not exist`);
      else if (!isLaunchFile(f)) errors.push(`launch.file: ${f} is not a launch file (.launch.py, .launch.xml, .launch.yaml, or .py/.xml/.yaml in a launch directory)`);
    }
    for (const a of spec.args ?? []) {
      const at = a.indexOf(":=");
      if (at < 0) errors.push(`args: ${a} is not name:=value`);
      else if (!ARG_RE.test(a.slice(0, at))) errors.push(`args: ${a.slice(0, at)} is not a valid argument name`);
      else if (/[\r\n]/.test(a)) errors.push(`args: the value of ${a.slice(0, at)} contains a newline`);
    }
    for (const w of spec.workspaces ?? []) {
      if (!w.endsWith("setup.bash")) errors.push(`workspaces: ${w} is not a setup.bash file`);
      else if (!FILES.includes(w)) errors.push(`workspaces: ${w} does not exist`);
    }
    if (spec.ros_domain_id !== undefined && (!Number.isInteger(spec.ros_domain_id) || spec.ros_domain_id < 0 || spec.ros_domain_id > 232)) errors.push("ros_domain_id: must be an integer from 0 to 232");
    for (const a of spec.after ?? []) {
      if (a === name) errors.push("after: a service cannot start after itself");
      else if (!NAME_RE.test(a)) errors.push(`after: ${a} is not a service name`);
    }
    return errors.length > 0 ? { errors } : { errors, spec };
  }

  function defaultWorkspaces(file: string): string[] {
    const out: string[] = [];
    for (let at = file.lastIndexOf("/"); at > 0; at = file.lastIndexOf("/", at - 1)) {
      const ws = `${file.slice(0, at)}/install/setup.bash`;
      if (FILES.includes(ws)) out.unshift(ws);
    }
    return out;
  }

  function put(name: string, body: unknown, emit: (ev: RunnerEvent) => void): { status: number; body: unknown } {
    const { errors, spec } = validate(name, body);
    if (!spec) return { status: 400, body: { errors } };
    const workspaces = spec.workspaces && spec.workspaces.length > 0 ? spec.workspaces : spec.launch.package ? [`${HOME}/ros2_ws/install/setup.bash`] : defaultWorkspaces(spec.launch.file);
    const prev = services.get(name);
    const service: AutostartService = {
      name,
      unit: unit(name),
      description: spec.description ?? "",
      launch: spec.launch.package ? { package: spec.launch.package, file: spec.launch.file } : { file: spec.launch.file },
      args: spec.args ?? [],
      workspaces,
      ros_domain_id: spec.ros_domain_id ?? null,
      rmw: spec.rmw ?? null,
      after: spec.after ?? [],
      enabled: true,
      active: prev?.service.active ?? "inactive",
      sub_state: prev?.service.sub_state ?? "dead",
      since: prev?.service.since ?? null,
      restarts: prev?.service.restarts ?? 0,
      main_pid: prev?.service.main_pid ?? null,
      self: spec.launch.package === "mission_runner",
    };
    const entry: Entry = { spec: { ...spec, workspaces }, service, log: prev?.log ?? [] };
    window.clearTimeout(prev?.timer);
    services.set(name, entry);
    systemdLog(entry, "Reloading.");
    if (spec.start_now) startEntry(entry, emit);
    emit({ type: "autostart.changed", name });
    return { status: 200, body: service };
  }

  const handler: AutostartOverride = async (method, rawPath, body, emit) => {
    await new Promise((r) => setTimeout(r, 120));
    const url = new URL(rawPath, "http://robot");
    const path = url.pathname;
    const change = method !== "GET";
    if (change && !supported && path !== "/api/autostart/browse") return { status: 409, body: { error: "systemd user services are not available on this robot" } };

    if (method === "GET" && path === "/api/autostart") {
      const list = [...services.values()].map((e) => ({ ...e.service }));
      const own = list.find((s) => s.self);
      return {
        status: 200,
        body: {
          supported,
          ...(supported ? {} : { reason: "Not Linux (win32): systemd user services are not available" }),
          enabled: true,
          user: USER,
          linger,
          ros_distro: supported ? DISTRO : null,
          roots: ROOTS,
          self: own ? own.name : null,
          services: list,
        },
      };
    }
    if (method === "GET" && path === "/api/autostart/browse") {
      const p = (url.searchParams.get("path") ?? ROOTS[0]!).replace(/\/+$/, "") || "/";
      if (!under(p)) return { status: 403, body: { error: `${p} is not under an allowed root (${ROOTS.join(", ")})` } };
      if (!exists(p)) return { status: 404, body: { error: `${p} does not exist` } };
      if (FILES.includes(p)) return { status: 400, body: { error: `${p} is not a directory` } };
      const names = new Map<string, "dir" | "file">();
      for (const f of [...FILES, ...dirs]) {
        if (!f.startsWith(`${p}/`)) continue;
        const rest = f.slice(p.length + 1);
        const first = rest.split("/")[0]!;
        if (first.startsWith(".")) continue;
        const full = `${p}/${first}`;
        names.set(first, dirs.has(full) ? "dir" : "file");
      }
      const entries = [...names]
        .map(([name, kind]) => ({ name, path: `${p}/${name}`, kind, launch: kind === "file" && isLaunchFile(`${p}/${name}`) }))
        .sort((a, b) => (a.kind === b.kind ? a.name.localeCompare(b.name) : a.kind === "dir" ? -1 : 1));
      const isRoot = ROOTS.includes(p);
      const parent = isRoot ? null : p.slice(0, p.lastIndexOf("/")) || "/";
      return { status: 200, body: { path: p, parent, roots: ROOTS, entries } };
    }
    if (method === "POST" && path === "/api/autostart/linger") {
      lingerTries++;
      // The first try is refused, as it is on a Raspberry Pi OS user without polkit rights.
      if (lingerTries >= 2) linger = true;
      return { status: 200, body: linger ? { linger: true } : { linger: false, command: `sudo loginctl enable-linger ${USER}` } };
    }
    const m = /^\/api\/autostart\/([^/]+)(?:\/(start|stop|restart|log))?$/.exec(path);
    if (!m) return { status: 404, body: { error: `no route ${method} ${path}` } };
    const name = decodeURIComponent(m[1]!);
    const verb = m[2];
    if (method === "PUT" && !verb) return put(name, body, emit);
    const entry = services.get(name);
    if (!entry) return { status: 404, body: { error: `no autostart service called ${name}` } };
    if (method === "GET" && verb === "log") {
      const n = Number(url.searchParams.get("lines") ?? 200);
      return { status: 200, body: { lines: entry.log.slice(-n) } };
    }
    if (method === "POST" && verb) {
      if (verb === "stop") stopEntry(entry);
      else if (verb === "start") startEntry(entry, emit);
      else {
        stopEntry(entry);
        startEntry(entry, emit);
      }
      emit({ type: "autostart.changed", name });
      return { status: 200, body: { ...entry.service } };
    }
    if (method === "DELETE" && !verb) {
      stopEntry(entry);
      services.delete(name);
      emit({ type: "autostart.changed", name });
      return { status: 200, body: { removed: name, self: entry.service.self } };
    }
    return { status: 405, body: { error: `${method} is not allowed on ${path}` } };
  };

  if (flag("fake-services")) {
    const noop = (): void => undefined;
    put("robot", { description: "Drivers, FAST-LIO and Nav2", launch: { file: `${HOME}/robot_ws/src/my_robot/launch/robot.launch.py` }, args: ["use_sim_time:=false"], start_now: true }, noop);
    put("mission", { description: "Mission layer", launch: { package: "mission_runner", file: "bringup.launch.py" }, args: [`project:=${HOME}/line2.mproj`], after: ["robot"], start_now: true }, noop);
    const failing = services.get("robot");
    if (failing) failing.service.restarts = 0;
  }

  api.setAutostartOverride(handler);
  console.info("[fake-robot] /api/autostart is answered from memory (dev build only).");
}
