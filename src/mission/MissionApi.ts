/**
 * The whole mission_runner API over the one connection iViz already has.
 *
 * `mission_runner` advertises the ROS service `/mission/api`
 * (`mission_msgs/srv/Api`): `{method, path, body_json}` -> `{ok, status,
 * body_json, message}`, where `path` and the bodies are exactly the HTTP API in
 * Mission/docs/runner-api.md. Live state arrives on `/mission/state` and
 * `/mission/event`, both `std_msgs/msg/String` carrying JSON.
 *
 * Everything here degrades cleanly: when the bridge has no `services`
 * capability or does not advertise `/mission/api`, `available` is false and
 * `unavailableReason` says why. iViz stays a viewer.
 */

import type { FoxgloveConnection } from "../net/FoxgloveConnection";
import type { Mission, Path, SitesDoc } from "./types";

export const MISSION_API_SERVICE = "/mission/api";
export const MISSION_STATE_TOPIC = "/mission/state";
export const MISSION_EVENT_TOPIC = "/mission/event";

// ---- API shapes (runner-api.md) --------------------------------------------

export type RunStatus = "queued" | "running" | "paused" | "suspended" | "succeeded" | "failed" | "canceled";

export interface RobotState {
  x: number;
  y: number;
  yaw_deg: number;
  frame?: string;
  battery?: number | null;
  nav_active?: boolean;
}

export interface StepRef {
  id: string;
  name?: string;
  path?: Path;
  started_at?: string;
}

export interface Feedback {
  distance_remaining?: number;
  recoveries?: number;
  eta_s?: number;
}

export interface Run {
  id: string;
  mission: string;
  inputs?: Record<string, unknown>;
  source?: { kind: string; id?: string; detail?: string };
  priority?: number;
  status: RunStatus;
  started_at?: string | null;
  finished_at?: string | null;
  step?: StepRef | null;
  error?: string;
  feedback?: Feedback | null;
}

export interface Prompt {
  id: string;
  run_id?: string;
  mission?: string;
  text: string;
  options: string[];
  default?: string | null;
  expires_at?: string | null;
}

export interface ConnectorState {
  type: string;
  connected?: boolean;
  config?: Record<string, unknown>;
}

export interface RunnerStatus {
  runner?: { version?: string; uptime_s?: number; backend?: string; home?: string };
  state: "idle" | "running" | "paused";
  run: Run | null;
  queue?: Run[];
  suspended?: Run[];
  robot?: RobotState | null;
  current_map?: string | null;
  connectors?: Record<string, ConnectorState>;
  prompt?: Prompt | null;
}

export interface ApiFinding {
  path?: Path;
  message: string;
  /** `PUT /api/project`: the mission a finding belongs to. */
  mission?: string;
}

/** `PUT /api/project`. */
export interface ProjectDeployResult {
  ok: boolean;
  saved?: string[];
  deleted?: string[];
  warnings?: ApiFinding[];
  errors?: ApiFinding[];
}

/**
 * True when the runner answered that it has no such endpoint, which is how an
 * older mission_runner says it does not know `/api/project` yet.
 */
export function isMissingEndpoint(err: unknown): boolean {
  return err instanceof MissionApiError && (err.status === 404 || err.status === 405 || err.status === 501);
}

export interface MissionSummary {
  name: string;
  title?: string;
  description?: string;
  version?: number;
  updated_at?: string;
  triggers?: string[];
  interrupts?: string[];
  steps?: number;
  sha256?: string;
  state?: "idle" | "running" | "queued" | "suspended";
  trigger_problems?: string[];
  errors?: ApiFinding[];
}

export interface CapabilityInfo {
  available: boolean;
  reason?: string;
}

export interface Capabilities {
  backend?: string;
  steps?: Record<string, CapabilityInfo>;
  triggers?: Record<string, CapabilityInfo>;
  connectors?: string[];
  ros_distro?: string;
}

export interface SaveResult {
  ok: boolean;
  name?: string;
  version?: number;
  sha256?: string;
  warnings?: ApiFinding[];
  errors?: ApiFinding[];
}

export interface RunAccepted {
  accepted: boolean;
  run_id?: string;
  reason?: string;
}

/** One `/mission/event` message. Fields depend on `type` (see runner-api.md). */
export interface RunnerEvent {
  type: string;
  run?: Run;
  run_id?: string;
  step_id?: string;
  path?: Path;
  name?: string;
  step_type?: string;
  result?: { ok: boolean; status: string; error?: string };
  feedback?: Feedback;
  prompt?: Prompt;
  answer?: string;
  names?: string[];
  t?: string;
  level?: string;
  text?: string;
}

// ---- autostart (Mission/docs/robot-startup.md, section 4) -------------------

/** What a service launches: a launch file on the robot, or a package's launch file. */
export type LaunchTarget = { file: string; package?: undefined } | { package: string; file: string };

/** One `mission-autostart-<name>` systemd user service. */
export interface AutostartService {
  name: string;
  unit: string;
  description: string;
  launch: LaunchTarget;
  args: string[];
  workspaces: string[];
  ros_domain_id: number | null;
  rmw: string | null;
  after: string[];
  enabled: boolean;
  active: string;
  sub_state: string;
  since: string | null;
  restarts: number;
  main_pid: number | null;
  /** The runner answering this call runs inside this service. */
  self: boolean;
}

/** `GET /api/autostart`. */
export interface AutostartInfo {
  supported: boolean;
  reason?: string;
  enabled: boolean;
  user: string;
  linger: boolean;
  ros_distro: string | null;
  roots: string[];
  self?: string | null;
  services: AutostartService[];
}

/** `PUT /api/autostart/{name}`. */
export interface AutostartSpec {
  description?: string;
  launch: LaunchTarget;
  args?: string[];
  workspaces?: string[];
  ros_domain_id?: number;
  rmw?: string;
  after?: string[];
  start_now?: boolean;
}

export interface BrowseEntry {
  name: string;
  path: string;
  kind: "dir" | "file";
  launch: boolean;
}

/** `GET /api/autostart/browse`. */
export interface BrowseResult {
  path: string;
  parent: string | null;
  roots: string[];
  entries: BrowseEntry[];
}

/** `POST /api/autostart/linger`. */
export interface LingerResult {
  linger: boolean;
  command?: string;
}

export type AutostartVerb = "start" | "stop" | "restart";

/** Said when the runner has no `/api/autostart` at all. */
export const AUTOSTART_MISSING = "Update mission_runner on the robot: this version cannot set up services that start at boot.";

/**
 * A stand-in for the autostart endpoints, used only by the dev build's fake
 * robot. It answers like the runner would: an HTTP status and a JSON body.
 */
export type AutostartOverride = (method: string, path: string, body: unknown, emit: (ev: RunnerEvent) => void) => Promise<{ status: number; body: unknown }>;

/**
 * The sentences in a failure: `400 {errors:[str]}` from autostart, the
 * `{message}` findings of the mission endpoints, or the error itself.
 */
export function errorSentences(err: unknown): string[] {
  if (err instanceof MissionApiError) {
    const list = (err.errors as unknown[])
      .map((e) => (typeof e === "string" ? e : isRecord(e) && typeof e.message === "string" ? e.message : ""))
      .filter((s) => s !== "");
    return list.length > 0 ? list : [err.message];
  }
  return [err instanceof Error ? err.message : String(err)];
}

/** An error the runner reported, carrying its HTTP status and findings. */
export class MissionApiError extends Error {
  readonly status: number;
  readonly errors: ApiFinding[];
  constructor(message: string, status: number, errors: ApiFinding[] = []) {
    super(message);
    this.name = "MissionApiError";
    this.status = status;
    this.errors = errors;
  }
}

interface ApiResponse {
  ok: boolean;
  status: number;
  body_json: string;
  message: string;
}

type Listener<T> = (value: T) => void;

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

export class MissionApi {
  readonly #conn: FoxgloveConnection;
  #available = false;
  #availabilityListeners = new Set<Listener<boolean>>();
  #statusListeners = new Set<Listener<RunnerStatus>>();
  #eventListeners = new Set<Listener<RunnerEvent>>();
  #unsubState?: () => void;
  #unsubEvent?: () => void;
  #lastStatus: RunnerStatus | null = null;

  constructor(conn: FoxgloveConnection) {
    this.#conn = conn;
    conn.onServicesChange(() => this.#refreshAvailability());
    conn.onStateChange(() => this.#refreshAvailability());
    this.#available = this.#compute();
  }

  /** True when `/mission/api` can be called right now. */
  get available(): boolean {
    return this.#available;
  }

  /** Why Route mode is off, or "" when it is on. */
  get unavailableReason(): string {
    if (this.#conn.state !== "connected") return "Not connected to a bridge.";
    if (!this.#conn.supportsServices) return "This bridge does not advertise the services capability, so mission_runner cannot be reached.";
    if (!this.#conn.hasService(MISSION_API_SERVICE)) return `The bridge does not advertise ${MISSION_API_SERVICE}. Start mission_runner (with mission_msgs built) on the robot.`;
    return "";
  }

  /** The most recent `/mission/state`, or null when none has arrived. */
  get lastStatus(): RunnerStatus | null {
    return this.#lastStatus;
  }

  onAvailabilityChange(l: Listener<boolean>): () => void {
    this.#availabilityListeners.add(l);
    return () => this.#availabilityListeners.delete(l);
  }
  onStatus(l: Listener<RunnerStatus>): () => void {
    this.#statusListeners.add(l);
    return () => this.#statusListeners.delete(l);
  }
  onEvent(l: Listener<RunnerEvent>): () => void {
    this.#eventListeners.add(l);
    return () => this.#eventListeners.delete(l);
  }

  /** Subscribe to `/mission/state` and `/mission/event`. Safe to call twice. */
  startLiveState(): void {
    if (!this.#unsubState) {
      this.#unsubState = this.#conn.subscribe(MISSION_STATE_TOPIC, (msg) => {
        const parsed = parseStringMessage(msg);
        if (!isRecord(parsed) || typeof parsed.state !== "string") return;
        const status = parsed as unknown as RunnerStatus;
        this.#lastStatus = status;
        for (const l of this.#statusListeners) l(status);
      });
    }
    if (!this.#unsubEvent) {
      this.#unsubEvent = this.#conn.subscribe(MISSION_EVENT_TOPIC, (msg) => {
        const parsed = parseStringMessage(msg);
        if (!isRecord(parsed) || typeof parsed.type !== "string") return;
        const ev = parsed as unknown as RunnerEvent;
        // The runner also streams full status snapshots as events.
        if (ev.type === "status" && typeof (parsed as { state?: unknown }).state === "string") {
          const status = parsed as unknown as RunnerStatus;
          this.#lastStatus = status;
          for (const l of this.#statusListeners) l(status);
        }
        for (const l of this.#eventListeners) l(ev);
      });
    }
  }

  stopLiveState(): void {
    this.#unsubState?.();
    this.#unsubEvent?.();
    this.#unsubState = undefined;
    this.#unsubEvent = undefined;
  }

  // ---- verbs --------------------------------------------------------------

  async get<T>(path: string): Promise<T> {
    return await this.#call<T>("GET", path);
  }
  async post<T>(path: string, body?: unknown): Promise<T> {
    return await this.#call<T>("POST", path, body);
  }
  async put<T>(path: string, body?: unknown): Promise<T> {
    return await this.#call<T>("PUT", path, body);
  }
  async del<T>(path: string, body?: unknown): Promise<T> {
    return await this.#call<T>("DELETE", path, body);
  }

  async #call<T>(method: string, path: string, body?: unknown): Promise<T> {
    const override = this.#autostartOverride;
    if (override && path.startsWith("/api/autostart")) {
      const res = await override(method, path, body, (ev) => {
        for (const l of this.#eventListeners) l(ev);
      });
      return this.#answer<T>(method, path, { ok: res.status < 400, status: res.status, body_json: JSON.stringify(res.body), message: "" });
    }
    const reason = this.unavailableReason;
    if (reason) throw new MissionApiError(reason, 0);
    let res: ApiResponse;
    try {
      res = await this.#conn.callService<ApiResponse>(MISSION_API_SERVICE, {
        method,
        path,
        body_json: body === undefined ? "" : JSON.stringify(body),
      });
    } catch (err) {
      throw new MissionApiError(err instanceof Error ? err.message : String(err), 0);
    }
    return this.#answer<T>(method, path, res);
  }

  #answer<T>(method: string, path: string, res: ApiResponse): T {
    const status = Number(res.status) || 0;
    let parsed: unknown = undefined;
    if (typeof res.body_json === "string" && res.body_json !== "") {
      try {
        parsed = JSON.parse(res.body_json);
      } catch {
        if (res.ok !== false && status < 400) throw new MissionApiError(`${method} ${path} returned a body that is not JSON`, status);
      }
    }
    if (res.ok === false || status >= 400) {
      const detail = isRecord(parsed) && typeof parsed.error === "string" && parsed.error !== "" ? parsed.error : res.message || `${method} ${path} failed with ${status || "no status"}`;
      const errors = isRecord(parsed) && Array.isArray(parsed.errors) ? (parsed.errors as ApiFinding[]) : [];
      throw new MissionApiError(detail, status, errors);
    }
    return parsed as T;
  }

  // ---- typed helpers ------------------------------------------------------

  async status(): Promise<RunnerStatus> {
    return await this.get<RunnerStatus>("/api/status");
  }
  async missions(): Promise<MissionSummary[]> {
    const list = await this.get<MissionSummary[]>("/api/missions");
    return Array.isArray(list) ? list : [];
  }
  async mission(name: string): Promise<Mission> {
    return await this.get<Mission>(`/api/missions/${encodeURIComponent(name)}`);
  }
  async saveMission(doc: Mission): Promise<SaveResult> {
    return await this.put<SaveResult>(`/api/missions/${encodeURIComponent(doc.name)}`, doc);
  }
  async deleteMission(name: string): Promise<void> {
    await this.del<unknown>(`/api/missions/${encodeURIComponent(name)}`);
  }
  async validateMission(doc: Mission): Promise<SaveResult> {
    return await this.post<SaveResult>("/api/missions/validate", doc);
  }
  async sites(): Promise<SitesDoc> {
    return await this.get<SitesDoc>("/api/sites");
  }
  async saveSites(doc: SitesDoc): Promise<unknown> {
    return await this.put<unknown>("/api/sites", doc);
  }
  /** The robot's sites and missions as one `project/1` document. */
  async project(): Promise<unknown> {
    return await this.get<unknown>("/api/project");
  }
  /**
   * Import a `project/1` document: the runner validates everything first and
   * writes nothing if a mission is invalid. `replace` also deletes robot
   * missions the project does not have.
   */
  async putProject(doc: unknown, replace: boolean): Promise<ProjectDeployResult> {
    return await this.put<ProjectDeployResult>(`/api/project?replace=${replace ? "true" : "false"}`, doc);
  }
  async robotPose(): Promise<{ x: number; y: number; yaw_deg: number; frame?: string }> {
    return await this.get("/api/robot/pose");
  }
  async connectors(): Promise<Record<string, ConnectorState>> {
    const c = await this.get<Record<string, ConnectorState>>("/api/connectors");
    return isRecord(c) ? c : {};
  }
  async capabilities(): Promise<Capabilities> {
    return await this.get<Capabilities>("/api/capabilities");
  }
  async run(name: string, inputs?: Record<string, unknown>): Promise<RunAccepted> {
    return await this.post<RunAccepted>(`/api/missions/${encodeURIComponent(name)}/run`, inputs ? { inputs } : {});
  }
  async stop(): Promise<unknown> {
    return await this.post<unknown>("/api/stop", {});
  }
  /** Pause the active run. Without an id the one from the last status is used. */
  async pause(runId?: string): Promise<unknown> {
    const id = runId ?? this.#lastStatus?.run?.id;
    if (!id) throw new MissionApiError("Nothing is running.", 0);
    return await this.post<unknown>(`/api/runs/${encodeURIComponent(id)}/pause`, {});
  }
  async resume(runId?: string): Promise<unknown> {
    const id = runId ?? this.#lastStatus?.run?.id;
    if (!id) throw new MissionApiError("Nothing is paused.", 0);
    return await this.post<unknown>(`/api/runs/${encodeURIComponent(id)}/resume`, {});
  }
  async answerPrompt(id: string, answer: string): Promise<unknown> {
    return await this.post<unknown>(`/api/prompt/${encodeURIComponent(id)}/answer`, { answer });
  }

  // ---- autostart ----------------------------------------------------------

  #autostartOverride: AutostartOverride | null = null;

  /** Dev build only: answer the autostart endpoints from memory. */
  setAutostartOverride(fn: AutostartOverride | null): void {
    this.#autostartOverride = fn;
  }

  /** True when the autostart endpoints can be called (connected, or the dev fake). */
  get autostartReachable(): boolean {
    return this.#available || this.#autostartOverride !== null;
  }

  /**
   * `GET /api/autostart`, doubling as the capability check: a runner that
   * does not know the endpoint answers 404, reported as {@link AUTOSTART_MISSING}.
   */
  async autostart(): Promise<AutostartInfo> {
    try {
      const info = await this.get<AutostartInfo>("/api/autostart");
      if (!isRecord(info)) throw new MissionApiError("GET /api/autostart returned something that is not a listing", 0);
      return { ...info, services: Array.isArray(info.services) ? info.services : [], roots: Array.isArray(info.roots) ? info.roots : [] };
    } catch (err) {
      if (isMissingEndpoint(err)) throw new MissionApiError(AUTOSTART_MISSING, (err as MissionApiError).status);
      throw err;
    }
  }
  async autostartBrowse(path?: string): Promise<BrowseResult> {
    return await this.get<BrowseResult>(`/api/autostart/browse${path ? `?path=${encodeURIComponent(path)}` : ""}`);
  }
  async putAutostart(name: string, spec: AutostartSpec): Promise<AutostartService> {
    return await this.put<AutostartService>(`/api/autostart/${encodeURIComponent(name)}`, spec);
  }
  async autostartAction(name: string, verb: AutostartVerb): Promise<AutostartService> {
    return await this.post<AutostartService>(`/api/autostart/${encodeURIComponent(name)}/${verb}`, {});
  }
  async removeAutostart(name: string): Promise<{ removed: string; self: boolean }> {
    return await this.del<{ removed: string; self: boolean }>(`/api/autostart/${encodeURIComponent(name)}`);
  }
  async autostartLog(name: string, lines = 200): Promise<string[]> {
    const res = await this.get<{ lines?: unknown }>(`/api/autostart/${encodeURIComponent(name)}/log?lines=${lines}`);
    return isRecord(res) && Array.isArray(res.lines) ? res.lines.map(String) : [];
  }
  async autostartLinger(): Promise<LingerResult> {
    return await this.post<LingerResult>("/api/autostart/linger", {});
  }

  // ---- internals ----------------------------------------------------------

  #compute(): boolean {
    return this.#conn.state === "connected" && this.#conn.supportsServices && this.#conn.hasService(MISSION_API_SERVICE);
  }

  #refreshAvailability(): void {
    const now = this.#compute();
    if (now === this.#available) return;
    this.#available = now;
    if (!now) this.#lastStatus = null;
    for (const l of this.#availabilityListeners) l(now);
  }
}

/** Parse the JSON carried by a `std_msgs/msg/String` message. */
function parseStringMessage(msg: unknown): unknown {
  if (!isRecord(msg) || typeof msg.data !== "string" || msg.data === "") return undefined;
  try {
    return JSON.parse(msg.data);
  } catch {
    return undefined;
  }
}
