/**
 * The right column: whatever is selected, edited in place.
 *
 * A tree node, a point, several points or a lane all land here. The per-step
 * forms are generated from the ported block registry (`ActionForm.ts`), except
 * the request form, which is written by hand (`RequestForm.ts`). The point and
 * lane configuration is written by hand because coordinates, direction,
 * blocked, speed cap and cost are the things an operator actually reasons
 * about.
 */

import { h, row } from "./dom";
import { icon } from "./icons";
import { actionForm, selectInput, textInput } from "./ActionForm";
import type { FormContext } from "./ActionForm";
import { paramControl } from "./ActionForm";
import { requestForm } from "./RequestForm";
import type { RouteStore } from "../mission/RouteStore";
import type { Edge, Finding, Mission, Site, Step, Trigger } from "../mission/types";
import { MISSION_NAME_RE, POLICIES, SITE_KINDS, INPUT_TYPES } from "../mission/types";
import { blockDefOrUnknown, stepTitle, triggerDef, triggerSummary } from "../mission/blocks";
import { getStepAt } from "../mission/ids";
import { buildTree, findNode } from "../mission/tree";
import type { TreeNode } from "../mission/tree";
import { pathToString, validateInitialPoses, validateSiteTopics } from "../mission/validate";
import { lastRouteSiteBefore, requestTopics, suggestedTopics, topicNote } from "../mission/requestTopics";
import { arrivalsAt, planForStep } from "../mission/stops";
import type { Arrival } from "../mission/stops";
import { hasExpression } from "../mission/expressions";

export interface PropertiesHost {
  store: RouteStore;
  formContext(): FormContext;
  /** Validation findings for the open mission. */
  findings(): readonly Finding[];
  /** Redraw the tree and the map after a change made here. */
  refresh(): void;
  /** Ask the map to move the camera onto a point. */
  focusPoint(name: string): void;
  toast(message: string, kind?: "error" | "info"): void;
  /** Open a mission of the project (if it is not open) and select one of its steps. */
  revealStep(mission: string, stepId: string): void;
  /** Pick a step and insert it after the actions that follow a Follow route. */
  addActionAt(arrival: Arrival, anchor: HTMLElement): void;
  /** Append a Follow route to a point to the open mission's tasks. */
  addFollowRouteTo(point: string): void;
  /** Whether "Set robot pose here now" can be pressed, and the sentence saying why not. */
  robotPoseNow(): { enabled: boolean; reason: string };
  /** Ask, then tell the robot's localization that it stands at this point now. */
  setRobotPoseAt(point: string): void;
}

export class Properties {
  readonly element: HTMLElement;
  #host: PropertiesHost;
  #body: HTMLElement;
  #title: HTMLElement;

  constructor(host: PropertiesHost) {
    this.#host = host;
    this.#title = h("span", { class: "col-title", text: "Nothing selected" });
    this.#body = h("div", { class: "props-body" });
    this.element = h("div", { class: "props-col" }, h("div", { class: "col-head" }, this.#title, h("div", { class: "spacer" })), this.#body);
  }

  render(): void {
    const store = this.#host.store;
    const sel = store.selection;
    if (sel.kind === "point") return this.#renderPoint(sel.name);
    if (sel.kind === "points") return this.#renderPoints(sel.names);
    if (sel.kind === "lane") return this.#renderLane(sel.index);
    if (sel.kind === "node") return this.#renderNode(sel.id);
    this.#title.textContent = "Nothing selected";
    this.#body.replaceChildren(
      h("p", { class: "prose", text: "Pick something in the tree on the left, or a point or a lane on the map, and it is edited here." }),
      h("p", { class: "prose muted", text: "Ctrl-click several points on the map to connect them in order." }),
    );
  }

  // ---- tree nodes ---------------------------------------------------------

  #renderNode(id: string): void {
    const store = this.#host.store;
    const mission = store.mission;
    const tree = buildTree(mission);
    const node = tree ? findNode(tree, id) : null;
    if (!mission || !node) {
      this.#title.textContent = "Nothing selected";
      this.#body.replaceChildren(h("p", { class: "prose", text: "That part of the mission is no longer there." }));
      return;
    }
    this.#title.textContent = node.label;
    switch (node.kind) {
      case "mission":
        return this.#renderMission(mission);
      case "settings":
        return this.#renderSettings(mission);
      case "trigger":
        return this.#renderTrigger("triggers", node.index ?? 0);
      case "interrupt":
        return this.#renderTrigger("interrupts", node.index ?? 0);
      case "step":
        return this.#renderStep(node);
      default:
        return this.#renderContainer(node);
    }
  }

  #renderMission(mission: Mission): void {
    const store = this.#host.store;
    const body = h("div");
    body.append(
      row("Name", textInput(mission.name, "pickup_job", (v) => {
        const next = v.trim();
        if (next === mission.name) return;
        if (store.missions.some((m) => m !== mission && m.name === next)) {
          this.#host.toast(`The project already has a mission called ${next}.`);
          this.#host.refresh();
          return;
        }
        if (!MISSION_NAME_RE.test(next)) this.#host.toast("A mission name is lowercase letters, digits, underscore and hyphen, starting with a letter.");
        store.setMissionField("name", next, "Rename mission");
        this.#host.refresh();
      })),
      row("Title", textInput(mission.title ?? "", "Pickup job", (v) => {
        store.setMissionField("title", v.trim() === "" ? undefined : v, "Change the title");
        this.#host.refresh();
      })),
    );
    const desc = h("textarea", { rows: 3, placeholder: "What this mission is for" });
    desc.value = mission.description ?? "";
    desc.addEventListener("change", () => {
      store.setMissionField("description", desc.value.trim() === "" ? undefined : desc.value, "Change the description");
      this.#host.refresh();
    });
    body.append(h("div", { class: "sub-title", text: "Description" }), desc);
    body.append(h("p", { class: "prose muted", text: "The name is the file name on the robot and the name of its ROS service. Lowercase letters, digits, underscore and hyphen." }));
    this.#appendFindings(body, [], mission);
    this.#body.replaceChildren(body);
  }

  #renderSettings(mission: Mission): void {
    const store = this.#host.store;
    const body = h("div");
    body.append(
      row(
        "When it is asked to start",
        selectInput(POLICIES, mission.policy ?? "queue", false, (v) => {
          store.setMissionField("policy", v === "queue" ? undefined : v, "Change the policy");
          this.#host.refresh();
        }),
      ),
    );
    const priority = h("input", { type: "number", min: 0, max: 100, value: String(mission.priority ?? 50) });
    priority.addEventListener("change", () => {
      const n = Math.round(Number(priority.value));
      store.setMissionField("priority", Number.isFinite(n) ? n : undefined, "Change the priority");
      this.#host.refresh();
    });
    body.append(row("Priority", priority));
    body.append(h("p", { class: "prose muted", text: policySentence(mission.policy ?? "queue") }));

    body.append(h("div", { class: "sub-title", text: "Inputs" }));
    const inputs = mission.inputs ?? {};
    if (Object.keys(inputs).length === 0) body.append(h("p", { class: "prose", text: "This mission takes no parameters." }));
    for (const [name, def] of Object.entries(inputs)) {
      const line = h("div", { class: "kv-row" });
      line.append(h("span", { class: "kv-key", text: name }));
      line.append(
        selectInput(INPUT_TYPES, def.type, false, (v) => {
          const next = { ...inputs, [name]: { ...def, type: v as (typeof INPUT_TYPES)[number] } };
          store.setMissionField("inputs", next, "Change an input");
          this.#host.refresh();
        }),
      );
      line.append(
        textInput(def.default === undefined ? "" : String(def.default), "default", (v) => {
          const next = { ...inputs, [name]: { ...def, default: v === "" ? undefined : v } };
          store.setMissionField("inputs", next, "Change an input");
          this.#host.refresh();
        }),
      );
      const del = h("button", { class: "icon-only danger", title: `Remove the input ${name}` }, icon("trash"));
      del.addEventListener("click", () => {
        const next = { ...inputs };
        delete next[name];
        store.setMissionField("inputs", Object.keys(next).length === 0 ? undefined : next, "Remove an input");
        this.#host.refresh();
      });
      line.append(del);
      body.append(line);
    }
    const addInput = h("button", {}, icon("plus"), "Add an input");
    addInput.addEventListener("click", () => {
      const name = uniqueKey(inputs, "value");
      store.setMissionField("inputs", { ...inputs, [name]: { type: "string" } }, "Add an input");
      this.#host.refresh();
    });
    body.append(h("div", { class: "row" }, addInput));

    body.append(h("div", { class: "sub-title", text: "Variables" }));
    const vars = mission.vars ?? {};
    if (Object.keys(vars).length === 0) body.append(h("p", { class: "prose", text: "This mission starts with no variables." }));
    for (const [name, value] of Object.entries(vars)) {
      const line = h("div", { class: "kv-row" });
      line.append(h("span", { class: "kv-key", text: name }));
      line.append(
        textInput(value === undefined ? "" : JSON.stringify(value), "value", (v) => {
          const next = { ...vars, [name]: parseLoose(v) };
          store.setMissionField("vars", next, "Change a variable");
          this.#host.refresh();
        }),
      );
      const del = h("button", { class: "icon-only danger", title: `Remove the variable ${name}` }, icon("trash"));
      del.addEventListener("click", () => {
        const next = { ...vars };
        delete next[name];
        store.setMissionField("vars", Object.keys(next).length === 0 ? undefined : next, "Remove a variable");
        this.#host.refresh();
      });
      line.append(del);
      body.append(line);
    }
    const addVar = h("button", {}, icon("plus"), "Add a variable");
    addVar.addEventListener("click", () => {
      const name = uniqueKey(vars, "count");
      store.setMissionField("vars", { ...vars, [name]: 0 }, "Add a variable");
      this.#host.refresh();
    });
    body.append(h("div", { class: "row" }, addVar));
    this.#body.replaceChildren(body);
  }

  #renderTrigger(kind: "triggers" | "interrupts", index: number): void {
    const store = this.#host.store;
    const mission = store.mission;
    const list: Trigger[] | undefined = kind === "triggers" ? mission?.triggers : mission?.interrupts;
    const trigger = list?.[index];
    if (!trigger) {
      this.#body.replaceChildren(h("p", { class: "prose", text: "That trigger is no longer there." }));
      return;
    }
    const ctx = this.#host.formContext();
    const def = triggerDef(trigger.type);
    const body = h("div");
    body.append(h("p", { class: "prose", text: def?.help ?? `The runner does not know the event type '${trigger.type}'.` }));
    body.append(row("Name", textInput(typeof trigger.name === "string" ? trigger.name : "", triggerSummary(trigger), (v) => {
      store.setTriggerParam(kind, index, "name", v.trim() === "" ? undefined : v);
      this.#host.refresh();
    })));
    for (const p of def?.params ?? []) {
      body.append(row(p.label, paramControl(p, trigger[p.key], ctx, (v) => {
        store.setTriggerParam(kind, index, p.key, v);
        this.#host.refresh();
      })));
    }
    body.append(row("Only when", textInput(typeof trigger.when === "string" ? trigger.when : "", "payload.value", (v) => {
      store.setTriggerParam(kind, index, "when", v.trim() === "" ? undefined : v);
      this.#host.refresh();
    })));
    body.append(row("Edge", selectInput(["any", "rising"], typeof trigger.edge === "string" ? trigger.edge : "any", false, (v) => {
      store.setTriggerParam(kind, index, "edge", v === "any" ? undefined : v);
      this.#host.refresh();
    })));
    if (kind === "interrupts") {
      body.append(row("Run this mission", textInput(typeof (trigger as { run?: string }).run === "string" ? (trigger as { run?: string }).run! : "", "go_charge", (v) => {
        store.setTriggerParam(kind, index, "run", v.trim());
        this.#host.refresh();
      })));
    }
    const on = h("input", { type: "checkbox" });
    on.checked = trigger.enabled !== false;
    on.addEventListener("change", () => {
      store.setTriggerParam(kind, index, "enabled", on.checked ? undefined : false);
      this.#host.refresh();
    });
    body.append(row("Armed", on));
    this.#appendFindings(body, [kind, index]);
    this.#body.replaceChildren(body);
  }

  #renderStep(node: TreeNode): void {
    const store = this.#host.store;
    const mission = store.mission;
    if (!mission || !node.path) return;
    const step = getStepAt(mission, node.path);
    if (!step) {
      this.#body.replaceChildren(h("p", { class: "prose", text: "That step is no longer there." }));
      return;
    }
    const def = blockDefOrUnknown(step.type);
    const ctx = this.#host.formContext();
    const body = h("div");
    body.append(h("div", { class: "props-type" }, icon(def.icon), h("span", { text: def.label }), h("span", { class: "props-typename", text: step.type })));
    body.append(h("p", { class: "prose", text: def.help }));

    const onChange = (key: string, value: unknown): void => {
      store.setStepParam(step, key, value);
      this.#host.refresh();
    };
    if (step.type === "ros.request") {
      body.append(requestForm(step, { ...ctx, mission, stationDefault: lastRouteSiteBefore(mission, step), points: store.points }, onChange));
    } else {
      body.append(actionForm(step, ctx, onChange));
    }
    if (step.type === "nav.follow_route") this.#appendPlannedRoute(body, mission, step);

    body.append(h("div", { class: "sub-title", text: "When it goes wrong" }));
    const onFail = step.on_fail ?? {};
    const retry = h("input", { type: "number", min: 0, max: 20, value: String(onFail.retry ?? 0) });
    retry.addEventListener("change", () => {
      const n = Math.max(0, Math.round(Number(retry.value) || 0));
      const next = { ...onFail, retry: n === 0 ? undefined : n };
      store.setStepParam(step, "on_fail", cleanOnFail(next), "Change the retries");
      this.#host.refresh();
    });
    body.append(row("Retries", retry));
    body.append(
      row(
        "Then",
        selectInput(["abort", "continue"], onFail.then ?? "abort", false, (v) => {
          const next = { ...onFail, then: v === "abort" ? undefined : ("continue" as const) };
          store.setStepParam(step, "on_fail", cleanOnFail(next), "Change what happens after a failure");
          this.#host.refresh();
        }),
      ),
    );
    const beforeRetry = Array.isArray(onFail.before_retry) ? onFail.before_retry.length : 0;
    const addFail = h("button", {}, icon("plus"), beforeRetry === 0 ? "Add a step to run before a retry" : `${beforeRetry} step${beforeRetry === 1 ? "" : "s"} run before a retry`);
    addFail.addEventListener("click", () => {
      const next = { ...onFail, before_retry: Array.isArray(onFail.before_retry) ? onFail.before_retry : ([] as Step[]) };
      store.setStepParam(step, "on_fail", next, "Add a clean-up level");
      this.#host.refresh();
      this.#host.toast("Use the plus on the step's 'When it fails' level to add the steps.", "info");
    });
    body.append(h("div", { class: "row" }, addFail));

    body.append(h("div", { class: "sub-title", text: "This step" }));
    // The request form has its own "Give up after", next to what happens then.
    if (step.type !== "ros.request") {
      const timeout = h("input", { type: "number", min: 0, value: step.timeout_s === undefined ? "" : String(step.timeout_s) });
      timeout.addEventListener("change", () => {
        const n = Number(timeout.value);
        store.setStepParam(step, "timeout_s", timeout.value === "" || !Number.isFinite(n) ? undefined : n, "Change the timeout");
        this.#host.refresh();
      });
      body.append(row("Give up after (s)", timeout));
    }
    body.append(row("Store the result in", textInput(typeof step.out === "string" ? step.out : "", "(no variable)", (v) => {
      store.setStepParam(step, "out", v.trim() === "" ? undefined : v.trim(), "Change where the result goes");
      this.#host.refresh();
    })));
    const enabled = h("input", { type: "checkbox" });
    enabled.checked = step.enabled !== false;
    enabled.addEventListener("change", () => {
      if (node.path) store.setStepEnabled(node.path, enabled.checked);
      this.#host.refresh();
    });
    body.append(row("Turned on", enabled));
    body.append(h("div", { class: "row" }, h("span", { class: "stats", text: `Step id ${String(step.id ?? "(none)")}` })));
    this.#appendFindings(body, node.path, undefined, typeof step.id === "string" ? step.id : undefined);
    this.#body.replaceChildren(body);
  }

  /** What a Follow route will drive, planned with the runner's rules. */
  #appendPlannedRoute(body: HTMLElement, mission: Mission, step: Step): void {
    const store = this.#host.store;
    body.append(h("div", { class: "sub-title", text: "Planned route" }));
    const to = typeof step.to === "string" ? step.to : "";
    if (to === "") {
      body.append(h("p", { class: "prose", text: "Pick where it drives to, and the route along the lanes is shown here and on the map." }));
      return;
    }
    const leg = typeof step.id === "string" ? planForStep(step.id, store.stops, store.points, store.lanes, mission) : null;
    if (!leg) {
      body.append(h("p", { class: "prose", text: hasExpression(to) ? `The destination ${to} is only known when the mission runs, so its route is planned on the robot.` : "The route cannot be planned here." }));
      return;
    }
    if (leg.route.length === 0) {
      body.append(h("div", { class: "finding error" }, h("div", { text: leg.problem })));
      return;
    }
    const chain = leg.start === null ? ["(nearest point to the robot)", ...leg.route] : leg.route;
    body.append(h("div", { class: `route-chain${leg.problem ? " bad" : ""}`, text: chain.join(" → ") }));
    if (leg.route.length > 1) body.append(h("div", { class: "stats", text: `${leg.route.length - 1} ${leg.route.length === 2 ? "lane" : "lanes"}, ${leg.lengthM.toFixed(1)} m` }));
    if (leg.problem) {
      body.append(
        h("div", { class: `finding ${leg.direct ? "warning" : "error"}` }, h("div", { text: leg.direct ? `${leg.problem} The robot drives straight there instead, because 'When there is no route' is direct.` : leg.problem })),
      );
    }
    const from = typeof step.from === "string" && step.from !== "" ? step.from : null;
    const startSentence =
      leg.start === null
        ? "It starts from the point nearest the robot, so the first lane is chosen on the robot when it runs."
        : from !== null
          ? `It starts from ${from}.`
          : `It starts from ${leg.start}, where the Follow route before it ends.`;
    body.append(h("p", { class: "prose muted", text: startSentence }));
  }

  #renderContainer(node: TreeNode): void {
    const body = h("div");
    body.append(h("p", { class: "prose", text: containerSentence(node) }));
    body.append(h("p", { class: "prose muted", text: `${node.children.length} ${node.children.length === 1 ? "item" : "items"} in this level. Use the plus on the row to add one.` }));
    this.#body.replaceChildren(body);
  }

  // ---- map objects --------------------------------------------------------

  #renderPoint(name: string): void {
    const store = this.#host.store;
    const site: Site | undefined = store.points[name];
    if (!site) {
      this.#title.textContent = "Nothing selected";
      this.#body.replaceChildren(h("p", { class: "prose", text: "That point is no longer on this map." }));
      return;
    }
    this.#title.textContent = name;
    const body = h("div");
    body.append(h("div", { class: "props-type" }, icon("mapPin"), h("span", { text: "Point" }), h("span", { class: "props-typename", text: store.mapName })));
    body.append(row("Name", textInput(name, "Conveyor1", (v) => {
      const next = store.renamePoint(name, v);
      if (next === name && v.trim() !== name) this.#host.toast(`There is already a point called ${v.trim()}.`);
      this.#host.refresh();
    })));
    body.append(row("Kind", selectInput(SITE_KINDS, site.kind ?? "waypoint", false, (v) => {
      store.setPointKind(name, v as (typeof SITE_KINDS)[number]);
      this.#host.refresh();
    })));
    body.append(
      row("X (m)", this.#liveNumber(site.x, 0.1, "", false, "Move point", (n) => store.movePoint(name, n ?? site.x, site.y))),
      row("Y (m)", this.#liveNumber(site.y, 0.1, "", false, "Move point", (n) => store.movePoint(name, site.x, n ?? site.y))),
      row("Heading (deg)", this.#liveNumber(site.yaw_deg, 5, "(no heading)", true, "Set heading", (n) => store.setPointYaw(name, n))),
    );
    body.append(h("p", { class: "prose muted", text: "Map frame, metres. Heading 0 is along +x, counter-clockwise positive. Typing moves the point; Ctrl+Z puts it back." }));

    this.#appendStartPosition(body, name, site);
    this.#appendPointTopics(body, name, site);

    const lanes = store.lanes.map((lane, index) => ({ lane, index })).filter(({ lane }) => lane.from === name || lane.to === name);
    body.append(h("div", { class: "sub-title", text: "Lanes here" }));
    if (lanes.length === 0) body.append(h("p", { class: "prose", text: "No lane reaches this point yet, so nothing can drive to it along the route graph." }));
    for (const { lane, index } of lanes) {
      const other = lane.from === name ? lane.to : lane.from;
      const glyph = lane.bidirectional === false ? (lane.from === name ? "→" : "←") : "⇄";
      const sentence = lane.bidirectional === false ? (lane.from === name ? `One-way from ${name} to ${other}` : `One-way from ${other} to ${name}`) : `Two-way between ${name} and ${other}`;
      const btn = h("button", { class: "list-row", title: `${sentence}${lane.blocked === true ? ", blocked" : ""}.` }, h("span", { class: "lane-glyph", text: glyph }), h("span", { text: other }), ...(lane.blocked === true ? [h("span", { class: "pill", text: "blocked" })] : []));
      btn.addEventListener("click", () => {
        store.select({ kind: "lane", index });
        this.#host.refresh();
      });
      body.append(btn);
    }

    this.#appendArrivals(body, name);

    const focus = h("button", {}, icon("locate"), "Show it on the map");
    focus.addEventListener("click", () => this.#host.focusPoint(name));
    const del = h("button", { class: "danger" }, icon("trash"), "Delete this point");
    del.addEventListener("click", () => {
      const refs = store.referencesTo(name);
      if (refs.length > 0 && !confirm(`${name} is used by ${refs.join(", ")}. Delete it anyway?`)) return;
      store.deletePoint(name);
      this.#host.refresh();
    });
    body.append(h("div", { class: "row buttons" }, focus, del));
    this.#body.replaceChildren(body);
  }

  /**
   * The map's start position (its `initial_pose`): whether the robot starts
   * at this point, whether mission_runner sets it on start, and a button that
   * sets the robot's pose here right now.
   */
  #appendStartPosition(body: HTMLElement, name: string, site: Site): void {
    const store = this.#host.store;
    const start = store.initialPose;
    const isStart = start?.site === name;
    body.append(h("div", { class: "sub-title", text: "Start position" }));

    const here = h("input", { type: "checkbox" });
    here.checked = isStart;
    here.addEventListener("change", () => {
      if (here.checked) {
        const from = store.setInitialPose(name);
        this.#host.toast(from !== null ? `The start position moved from ${from} to ${name}.` : `${name} is where the robot starts on ${store.mapName} now.`, "info");
      } else {
        store.setInitialPose(null);
      }
      this.#host.refresh();
    });
    body.append(h("label", { class: "check-row start-check" }, here, h("span", { text: "Robot starts here (initial pose)" })));

    if (isStart) {
      const onStart = h("input", { type: "checkbox" });
      onStart.checked = start.on_start !== false;
      onStart.addEventListener("change", () => {
        store.setInitialPoseOnStart(onStart.checked);
        this.#host.refresh();
      });
      body.append(h("label", { class: "check-row start-check sub" }, onStart, h("span", { text: "Set it when the robot starts" })));
      body.append(
        h("p", {
          class: "prose muted",
          text:
            start.on_start !== false
              ? "When mission_runner starts and the robot is not localized yet, it sets AMCL's initial pose here, so Nav2 comes up without anyone clicking 2D Pose Estimate."
              : "mission_runner leaves localization alone when it starts. Set the pose with the button below instead.",
        }),
      );
    } else if (start && store.points[start.site]) {
      body.append(h("p", { class: "prose muted", text: `This map's robot starts at ${start.site}. Ticking this moves the start position here.` }));
    } else if ((site.kind ?? "waypoint") === "home" && !start) {
      const use = h("button", {}, icon("home"), "Use as start position");
      use.addEventListener("click", () => {
        store.setInitialPose(name);
        this.#host.toast(`${name} is where the robot starts on ${store.mapName} now.`, "info");
        this.#host.refresh();
      });
      body.append(h("div", { class: "start-hint" }, h("span", { text: "This is a home point and this map has no start position yet." }), use));
    }

    const action = this.#host.robotPoseNow();
    const now = h("button", { title: action.enabled ? `Tell localization the robot is at ${name} now` : action.reason }, icon("poseEstimate"), "Set robot pose here now");
    now.disabled = !action.enabled;
    now.addEventListener("click", () => this.#host.setRobotPoseAt(name));
    body.append(h("div", { class: "row" }, now));
    if (!action.enabled && action.reason !== "") body.append(h("p", { class: "prose muted", text: action.reason }));
    const facing = typeof site.yaw_deg === "number" ? `facing ${Math.round(site.yaw_deg)}°` : "facing along +x (this point has no heading, so 0° is used)";
    body.append(h("p", { class: "prose muted", text: `The robot must really be standing at ${name}, ${facing}, when its pose is set here. A wrong pose makes Nav2 plan from the wrong place.` }));

    const map = store.mapName;
    for (const f of validateInitialPoses(store.sites).filter((x) => x.path[1] === map)) {
      body.append(h("div", { class: `finding ${f.level}` }, h("div", { text: `${f.message.charAt(0).toUpperCase()}${f.message.slice(1)}.` })));
    }
  }

  /** The request and answer topics an Ask for an answer at this point uses, so each station only receives its own questions. */
  #appendPointTopics(body: HTMLElement, name: string, site: Site): void {
    const store = this.#host.store;
    const ctx = this.#host.formContext();
    body.append(h("div", { class: "sub-title", text: "Questions at this point" }));
    const field = (key: "request_topic" | "answer_topic", placeholder: string, label: string): HTMLInputElement => {
      const input = textInput(site[key] ?? "", placeholder, (v) => {
        store.setPointTopics(name, { [key]: v }, label);
        this.#host.refresh();
      });
      input.classList.add("mono");
      return input;
    };
    body.append(
      row("Request topic", field("request_topic", ctx.requestTopic, "Change the point's request topic")),
      row("Answer topic", field("answer_topic", ctx.answerTopic, "Change the point's answer topic")),
    );
    const suggested = suggestedTopics(name);
    const use = h("button", { title: `${suggested.request} and ${suggested.answer}` }, icon("message"), `Use ${suggested.request} and /answer`);
    use.addEventListener("click", () => {
      store.setPointTopics(name, { request_topic: suggested.request, answer_topic: suggested.answer }, "Use the suggested topics");
      this.#host.refresh();
    });
    body.append(h("div", { class: "row" }, use));
    body.append(
      h("p", {
        class: "prose muted",
        text: "An Ask for an answer at this point publishes on these topics unless the step sets its own; left empty, the project's topics are used. Point this station's iViz Dashboard (Settings → Requests/Answers topics) or your node at them.",
      }),
    );
    const map = store.mapName;
    const own = validateSiteTopics(store.sites).filter((f) => f.path[1] === map && f.path[3] === name);
    for (const f of own) body.append(h("div", { class: `finding ${f.level}` }, h("div", { text: `${f.message.charAt(0).toUpperCase()}${f.message.slice(1)}.` })));
  }

  /** The tasks that happen when a mission arrives at this point, per mission. */
  #appendArrivals(body: HTMLElement, name: string): void {
    const store = this.#host.store;
    const arrivals = arrivalsAt(store.missions, name);
    body.append(h("div", { class: "sub-title", text: "Actions here" }));
    if (arrivals.length === 0) {
      const open = store.mission;
      body.append(h("p", { class: "prose", text: open ? `No mission drives here yet. Actions at a point are the tasks after a Follow route to it.` : "No mission drives here yet. Create a mission first, then add a Follow route to this point." }));
      if (open) {
        const add = h("button", {}, icon("route"), `Add a Follow route to ${name} in ${open.name}`);
        add.addEventListener("click", () => this.#host.addFollowRouteTo(name));
        body.append(h("div", { class: "row" }, add));
      }
      return;
    }
    const byMission = new Map<string, Arrival[]>();
    for (const a of arrivals) {
      const list = byMission.get(a.mission);
      if (list) list.push(a);
      else byMission.set(a.mission, [a]);
    }
    const ctx = this.#host.formContext();
    for (const [missionName, list] of byMission) {
      const mission = store.missions.find((m) => m.name === missionName) ?? null;
      const count = list.reduce((n, a) => n + a.actions.length, 0);
      const card = h("div", { class: "arrival-card" });
      card.append(h("div", { class: "arrival-head" }, icon("file"), h("span", { class: "arrival-mission", text: missionName }), h("span", { class: "stats", text: `${count} ${count === 1 ? "action" : "actions"}` })));
      list.forEach((arrival, i) => {
        if (list.length > 1) card.append(h("div", { class: "arrival-when", text: `Arrival ${i + 1}` }));
        const drive = h("button", { class: "list-row", title: "Show this Follow route in the tree" }, icon("route"), h("span", { text: stepTitle(arrival.step) }));
        drive.addEventListener("click", () => this.#host.revealStep(missionName, String(arrival.step.id ?? "")));
        card.append(drive);
        for (const action of arrival.actions) {
          const def = blockDefOrUnknown(action.type);
          const note = action.type === "ros.request" ? topicNote(requestTopics(action, mission, store.points, ctx), ctx) : "";
          const btn = h("button", { class: "list-row indent" }, icon(def.icon), h("span", { text: stepTitle(action) }), ...(note !== "" ? [h("span", { class: "stats", text: note })] : []));
          btn.addEventListener("click", () => this.#host.revealStep(missionName, String(action.id ?? "")));
          card.append(btn);
        }
        const add = h("button", { class: "link-btn" }, icon("plus"), "Add action here");
        add.addEventListener("click", () => this.#host.addActionAt(arrival, add));
        card.append(add);
      });
      body.append(card);
    }
  }

  /** Several points picked with Ctrl-click. */
  #renderPoints(names: string[]): void {
    const store = this.#host.store;
    this.#title.textContent = `${names.length} points`;
    const body = h("div");
    body.append(h("div", { class: "props-type" }, icon("waypoints"), h("span", { text: "Points" }), h("span", { class: "props-typename", text: store.mapName })));
    body.append(h("p", { class: "prose", text: `Picked in this order: ${names.join(", ")}.` }));
    const connect = h("button", { class: "primary" }, icon("route"), "Connect in order");
    connect.title = `Two-way lanes ${names.join(" ⇄ ")}`;
    connect.addEventListener("click", () => {
      const added = store.connectInOrder(names);
      this.#host.toast(added === 0 ? "Those points are already joined in that order." : `Added ${added} two-way ${added === 1 ? "lane" : "lanes"}: ${names.join(" ⇄ ")}.`, "info");
      this.#host.refresh();
    });
    const clear = h("button", {}, icon("close"), "Clear the selection");
    clear.addEventListener("click", () => {
      store.select({ kind: "none" });
      this.#host.refresh();
    });
    body.append(h("div", { class: "row buttons" }, connect, clear));
    body.append(h("p", { class: "prose muted", text: "Pairs that a lane already joins are skipped. Make a lane one-way afterwards by selecting it." }));
    this.#body.replaceChildren(body);
  }

  /** Lane configuration: direction, blocked, speed cap and cost. */
  #renderLane(index: number): void {
    const store = this.#host.store;
    const lane: Edge | undefined = store.lanes[index];
    if (!lane) {
      this.#title.textContent = "Nothing selected";
      this.#body.replaceChildren(h("p", { class: "prose", text: "That lane is no longer on this map." }));
      return;
    }
    this.#title.textContent = laneName(lane);
    const body = h("div");
    body.append(h("div", { class: "props-type" }, icon("route"), h("span", { text: "Lane" }), h("span", { class: "props-typename", text: store.mapName })));

    const a = lane.from;
    const b = lane.to;
    const oneWay = lane.bidirectional === false;
    const choices: { id: string; label: string; title: string; active: boolean; apply: () => void }[] = [
      { id: "both", label: `${a} ⇄ ${b}`, title: "Two-way", active: !oneWay, apply: () => store.updateLane(index, { bidirectional: undefined }, "Make the lane two-way") },
      { id: "ab", label: `${a} → ${b}`, title: `One-way, ${a} to ${b}`, active: oneWay, apply: () => store.updateLane(index, { bidirectional: false }, "Make the lane one-way") },
      {
        id: "ba",
        label: `${b} → ${a}`,
        title: `One-way, ${b} to ${a}`,
        active: false,
        // "one way the other way" is the same lane with its ends swapped.
        apply: () =>
          store.edit("Make the lane one-way the other way", () => {
            lane.from = b;
            lane.to = a;
            lane.bidirectional = false;
          }),
      },
    ];
    const dir = h("div", { class: "direction-choices" });
    for (const c of choices) {
      const btn = h("button", { class: `direction${c.active ? " active" : ""}`, title: c.title }, h("span", { text: c.label }));
      btn.dataset.direction = c.id;
      btn.addEventListener("click", () => {
        if (c.active) return;
        c.apply();
        this.#host.refresh();
      });
      dir.append(btn);
    }
    body.append(h("div", { class: "sub-title", text: "Direction" }), dir);
    body.append(h("p", { class: "prose muted", text: oneWay ? `The robot may only drive from ${a} to ${b} on this lane.` : "The robot may drive this lane in either direction." }));

    const blocked = h("input", { type: "checkbox" });
    blocked.checked = lane.blocked === true;
    blocked.addEventListener("change", () => {
      store.updateLane(index, { blocked: blocked.checked ? true : undefined }, blocked.checked ? "Block the lane" : "Unblock the lane");
      this.#host.refresh();
    });
    body.append(row("Blocked", blocked));
    body.append(h("p", { class: "prose muted", text: "A blocked lane is closed temporarily. The planner routes around it and it is drawn as a dashed red line." }));

    const speed = h("input", { type: "number", min: 0, step: 0.05, value: lane.speed_mps === undefined ? "" : String(lane.speed_mps), placeholder: "(no cap)" });
    speed.addEventListener("change", () => {
      const n = Number(speed.value);
      store.updateLane(index, { speed_mps: speed.value === "" || !Number.isFinite(n) || n <= 0 ? undefined : n }, "Change the speed limit");
      this.#host.refresh();
    });
    body.append(row("Speed limit (m/s)", speed));

    const cost = h("input", { type: "number", min: 0.1, step: 0.1, value: lane.cost === undefined ? "" : String(lane.cost), placeholder: "1" });
    cost.addEventListener("change", () => {
      const n = Number(cost.value);
      store.updateLane(index, { cost: cost.value === "" || !Number.isFinite(n) || n === 1 ? undefined : n }, "Change the cost");
      this.#host.refresh();
    });
    body.append(row("Cost", cost));
    body.append(h("p", { class: "prose muted", text: "Cost multiplies the lane's length when a route is chosen. 1 is neutral; 2 makes the robot treat it as twice as long and prefer another way round." }));

    const notes = textInput(lane.notes ?? "", "(no note)", (v) => {
      store.updateLane(index, { notes: v.trim() === "" ? undefined : v }, "Change the note");
      this.#host.refresh();
    });
    body.append(row("Note", notes));

    const flip = h("button", {}, icon("rotate"), "Swap the ends");
    flip.addEventListener("click", () => {
      store.flipLane(index);
      this.#host.refresh();
    });
    const del = h("button", { class: "danger" }, icon("trash"), "Delete this lane");
    del.addEventListener("click", () => {
      store.deleteLane(index);
      this.#host.refresh();
    });
    body.append(h("div", { class: "row buttons" }, flip, del));
    this.#body.replaceChildren(body);
  }

  /**
   * A number field that edits live: every keystroke moves the point on the map
   * inside one pending edit, and leaving the field (or Enter) commits it, so
   * a typed coordinate is one undo step, the same as a drag.
   */
  #liveNumber(value: number | undefined, step: number, placeholder: string, allowEmpty: boolean, label: string, apply: (n: number | null) => void): HTMLInputElement {
    const store = this.#host.store;
    const inp = h("input", { type: "number", step, value: value === undefined ? "" : String(value), placeholder });
    inp.addEventListener("input", () => {
      const text = inp.value.trim();
      const n = Number(text);
      if (text === "" ? !allowEmpty : !Number.isFinite(n)) return;
      if (!store.editing) store.beginEdit(label);
      apply(text === "" ? null : n);
      store.version++;
    });
    const finish = (): void => {
      if (!store.editing) return;
      store.commit();
      this.#host.refresh();
    };
    inp.addEventListener("change", finish);
    inp.addEventListener("blur", finish);
    return inp;
  }

  // ---- findings -----------------------------------------------------------

  #appendFindings(body: HTMLElement, prefix: readonly (string | number)[], mission?: Mission, stepId?: string): void {
    const all = this.#host.findings();
    const own = all.filter((f) => {
      if (stepId && f.stepId === stepId) return true;
      if (mission && f.path.length <= 1) return true;
      if (prefix.length === 0) return false;
      return f.path.length >= prefix.length && prefix.every((seg, i) => f.path[i] === seg);
    });
    if (own.length === 0) return;
    body.append(h("div", { class: "sub-title", text: "Problems" }));
    for (const f of own) {
      body.append(
        h("div", { class: `finding ${f.level}` }, h("div", { text: `${f.message.charAt(0).toUpperCase()}${f.message.slice(1)}.` }), h("div", { class: "where", text: pathToString(f.path) })),
      );
    }
  }
}

// ---- helpers ----------------------------------------------------------------

export { lastRouteSiteBefore };

export function laneName(lane: Edge): string {
  return `${lane.from} ${lane.bidirectional === false ? "→" : "⇄"} ${lane.to}`;
}

function containerSentence(node: TreeNode): string {
  switch (node.kind) {
    case "triggers":
      return "The events that start this mission on their own. Without one, it only runs when somebody asks for it.";
    case "interrupts":
      return "Armed only while this mission runs. When one fires it starts another mission, and this one is suspended or preempted.";
    case "flow":
      return "The steps the robot performs, in order. The first one that fails ends the run unless it is told to carry on.";
    case "onabort":
      return "The steps that run when the mission fails or is canceled. This is where the robot is put back in a safe state.";
    case "onfail":
      return "The steps that run before this step is tried again.";
    case "branch":
      return "The steps of this branch, in order.";
    default:
      return "";
  }
}

function policySentence(policy: string): string {
  switch (policy) {
    case "preempt":
      return "If something else is running and this mission has at least the same priority, that run is canceled and this one starts.";
    case "preempt_latest":
      return "Like preempt, and queued runs of this same mission are dropped, so the newest request wins.";
    case "reject_if_busy":
      return "The request is dropped whenever anything is running or queued.";
    case "interrupt_and_resume":
      return "The current run is suspended, this mission runs, and then the suspended run carries on from the step it was in.";
    default:
      return "The request joins the queue, which is ordered by priority and then by arrival.";
  }
}

function cleanOnFail(value: Record<string, unknown>): unknown {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(value)) if (v !== undefined) out[k] = v;
  return Object.keys(out).length === 0 ? undefined : out;
}

function uniqueKey(record: Record<string, unknown>, base: string): string {
  if (!(base in record)) return base;
  for (let i = 2; ; i++) if (!(`${base}${i}` in record)) return `${base}${i}`;
}

function parseLoose(text: string): unknown {
  const t = text.trim();
  if (t === "") return "";
  if (t === "true") return true;
  if (t === "false") return false;
  if (t === "null") return null;
  if (/^-?\d+(\.\d+)?$/.test(t)) return Number(t);
  try {
    return JSON.parse(t);
  } catch {
    return text;
  }
}
