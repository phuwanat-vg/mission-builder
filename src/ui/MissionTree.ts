/**
 * The mission tree: the left column, and the primary way a mission is built.
 *
 * It is a view over the ordinary `mission/1` JSON (see `mission/tree.ts`).
 * Every edit here is an array edit on the document through the store, so undo,
 * dirty tracking and round-tripping come for free.
 *
 * The shape is the one a Windows file explorer uses: a disclosure triangle, an
 * icon, a label and one muted detail line. The top level lists the missions the
 * robot knows; the open one expands into its triggers, interrupts, settings,
 * tasks and clean-up steps.
 */

import { h } from "./dom";
import { icon } from "./icons";
import type { IconName } from "./icons";
import { openMenu, openStepPicker, openTriggerPicker, stepForChoice, triggerForType } from "./StepPicker";
import type { MenuItem } from "./StepPicker";
import type { RouteStore } from "../mission/RouteStore";
import type { MissionSummary } from "../mission/MissionApi";
import type { Finding, Path, Step } from "../mission/types";
import { DEFAULT_EXPANDED, badgeSentence, badgesForTree, buildTree, flattenVisible, pathToNode } from "../mission/tree";
import type { NodeBadges, TreeNode } from "../mission/tree";
import { genId } from "../mission/ids";

export type StepRunPhase = "waiting" | "running" | "done" | "failed";

export interface StepRunState {
  phase: StepRunPhase;
  /** How long the step took, once it has finished. */
  durationS?: number;
}

export interface TreeHost {
  store: RouteStore;
  /** The project's missions, for the top level. */
  missionList(): readonly MissionSummary[];
  openMission(name: string): void;
  createMission(): void;
  deleteMission(name: string): void;
  /** For a request's detail line: its topics when they are not the project's, else "". */
  requestNote(step: Step): string;
  exportPython(): void;
  exportBt(): void;
  /** Validation findings for the open mission. */
  findings(): readonly Finding[];
  /** Live per-step run state, keyed by step id. */
  runState(): ReadonlyMap<string, StepRunState>;
  /** The open mission is running right now. */
  running(): boolean;
  /** Redraw everything that depends on the selection. */
  refresh(): void;
  toast(message: string, kind?: "error" | "info"): void;
}

const ROOT = "missions";
const STORAGE_KEY = "missionbuilder.expanded";

type DropZone = "before" | "after" | "into";

export class MissionTree {
  readonly element: HTMLElement;
  #host: TreeHost;
  #rowsEl: HTMLElement;
  #headEl: HTMLElement;
  #expanded = new Set<string>([ROOT, ...DEFAULT_EXPANDED]);
  #rows: { node: TreeNode; depth: number }[] = [];
  #tree: TreeNode | null = null;
  #badges = new Map<string, NodeBadges>();
  #dragId: string | null = null;
  #collapsed = false;
  /** Steps that drive to whatever is selected on the map. */
  #linked = new Set<string>();

  constructor(host: TreeHost) {
    this.#host = host;
    this.#rowsEl = h("div", { class: "tree-rows", tabIndex: 0 });
    const newBtn = h("button", { class: "icon-only", title: "Create a mission" }, icon("plus"));
    newBtn.addEventListener("click", () => this.#host.createMission());
    const collapseBtn = h("button", { class: "icon-only", title: "Hide the mission tree" }, icon("panelLeft"));
    collapseBtn.addEventListener("click", () => this.setCollapsed(true));
    this.#headEl = h("div", { class: "col-head" }, h("span", { class: "col-title", text: "Missions" }), h("div", { class: "spacer" }), newBtn, collapseBtn);
    this.element = h("div", { class: "tree-col" }, this.#headEl, this.#rowsEl);

    this.#rowsEl.addEventListener("keydown", (ev) => this.#onKey(ev));
    this.#restoreExpanded();
  }

  get collapsed(): boolean {
    return this.#collapsed;
  }

  setCollapsed(collapsed: boolean): void {
    this.#collapsed = collapsed;
    this.element.hidden = collapsed;
  }

  focus(): void {
    this.#rowsEl.focus();
  }

  /** Rebuild every row from the document. Cheap: a mission is a few hundred rows at most. */
  render(): void {
    const store = this.#host.store;
    const mission = store.mission;
    const root: TreeNode = {
      id: ROOT,
      kind: "mission",
      label: "Missions",
      detail: "",
      icon: "folder",
      enabled: true,
      draggable: false,
      children: [],
    };
    const summaries = this.#host.missionList();
    const openName = mission?.name ?? "";
    const openTree = buildTree(mission, (step) => this.#host.requestNote(step));
    const seen = new Set<string>();
    for (const summary of summaries) {
      seen.add(summary.name);
      root.children.push(summary.name === openName && openTree ? openTree : closedMission(summary));
    }
    // A mission that only exists here (a draft, or the robot is offline).
    if (openTree && !seen.has(openName)) root.children.unshift(openTree);
    this.#tree = root;

    this.#badges = badgesForTree(root, this.#host.findings());
    this.#rows = flattenVisible(root, this.#expanded);
    const runState = this.#host.runState();
    const selection = store.selection;
    const selectedId = selection.kind === "node" ? selection.id : "";
    this.#rowsEl.replaceChildren(...this.#rows.map((r) => this.#row(r.node, r.depth, selectedId, runState)));
    if (root.children.length === 0) {
      const create = h("button", { class: "step-btn" }, icon("plus"), h("span", { text: "Create a mission" }));
      create.addEventListener("click", () => this.#host.createMission());
      this.#rowsEl.append(h("div", { class: "tree-empty" }, h("p", { class: "prose", text: "This project has no missions yet. A mission is the list of tasks the robot performs." }), create));
    }
  }

  // ---- rows ---------------------------------------------------------------

  /** Highlight the steps that drive to whatever is selected on the map. */
  setLinked(ids: ReadonlySet<string>): void {
    if (ids.size === this.#linked.size && [...ids].every((id) => this.#linked.has(id))) return;
    this.#linked = new Set(ids);
    this.render();
  }

  #row(node: TreeNode, depth: number, selectedId: string, runState: ReadonlyMap<string, StepRunState>): HTMLElement {
    const hasChildren = node.children.length > 0 || (node.listPath !== undefined && node.kind !== "step");
    const open = this.#expanded.has(node.id);
    const stepId = node.kind === "step" && typeof node.step?.id === "string" ? node.step.id : "";
    const twisty = h("span", { class: `twisty${hasChildren ? "" : " leaf"}`, text: hasChildren ? (open ? "\u25be" : "\u25b8") : "" });
    const label = h("span", { class: "tree-label", text: node.number !== undefined ? `${node.number}  ${node.label}` : node.label });
    const detail = h("span", { class: "tree-detail", text: node.detail });
    const text = h("span", { class: "tree-text" }, label, detail);
    const row = h("div", {
      class: `tree-row kind-${node.kind}${node.id === selectedId ? " selected" : ""}${node.enabled ? "" : " off"}${stepId !== "" && this.#linked.has(stepId) ? " linked" : ""}`,
      title: node.detail ? `${node.label} — ${node.detail}` : node.label,
      style: `padding-left:${6 + depth * 14}px`,
    });
    row.dataset.id = node.id;
    row.append(twisty, icon(node.icon), text);

    // Run status. While a run is live every step carries a glyph, so a step
    // that has not been reached yet reads as waiting rather than as nothing.
    const state = stepId ? (runState.get(stepId) ?? (this.#host.running() ? { phase: "waiting" as const } : undefined)) : undefined;
    if (state) {
      const glyph = h("span", { class: `run-glyph ${state.phase}`, title: runSentence(state) }, icon(runIcon(state.phase)));
      row.appendChild(glyph);
      if (state.durationS !== undefined) row.appendChild(h("span", { class: "run-time", text: `${state.durationS.toFixed(state.durationS < 10 ? 1 : 0)} s` }));
    }

    // validation badge
    const badge = this.#badges.get(node.id);
    if (badge && (badge.errors.length > 0 || badge.warnings.length > 0)) {
      // A small outline dot; the sentence is in the tooltip.
      const level = badge.errors.length > 0 ? "error" : "warning";
      row.appendChild(h("span", { class: `tree-badge ${level}`, title: badgeSentence(badge) }));
    }

    if (node.listPath) {
      const add = h("button", { class: "tree-add icon-only", title: `Add a step to ${node.label}` }, icon("plus"));
      add.addEventListener("click", (ev) => {
        ev.stopPropagation();
        this.#addStep(node, add);
      });
      row.appendChild(add);
    } else if (node.kind === "triggers" || node.kind === "interrupts") {
      const add = h("button", { class: "tree-add icon-only", title: node.kind === "triggers" ? "Add a trigger" : "Add an interrupt" }, icon("plus"));
      add.addEventListener("click", (ev) => {
        ev.stopPropagation();
        this.#addTrigger(node.kind === "triggers" ? "triggers" : "interrupts", add);
      });
      row.appendChild(add);
    }

    twisty.addEventListener("click", (ev) => {
      ev.stopPropagation();
      this.#toggle(node.id);
    });
    row.addEventListener("click", () => this.#select(node));
    row.addEventListener("dblclick", () => {
      if (node.kind === "mission" && node.id.startsWith("mission:")) this.#host.openMission(node.id.slice("mission:".length));
      else this.#toggle(node.id);
    });
    row.addEventListener("contextmenu", (ev) => {
      ev.preventDefault();
      this.#select(node);
      this.#menu(node, ev.clientX, ev.clientY);
    });

    if (node.draggable) {
      row.draggable = true;
      row.addEventListener("dragstart", (ev) => {
        this.#dragId = node.id;
        row.classList.add("dragging");
        ev.dataTransfer?.setData("text/plain", node.id);
        if (ev.dataTransfer) ev.dataTransfer.effectAllowed = "move";
      });
      row.addEventListener("dragend", () => {
        this.#dragId = null;
        row.classList.remove("dragging");
        this.#clearDropMarks();
      });
    }
    row.addEventListener("dragover", (ev) => this.#onDragOver(ev, node, row));
    row.addEventListener("dragleave", () => row.classList.remove("drop-before", "drop-after", "drop-into"));
    row.addEventListener("drop", (ev) => this.#onDrop(ev, node, row));
    return row;
  }

  // ---- interaction --------------------------------------------------------

  #select(node: TreeNode): void {
    if (node.id.startsWith("mission:")) {
      this.#host.openMission(node.id.slice("mission:".length));
      return;
    }
    this.#host.store.select({ kind: "node", id: node.id });
    this.#host.refresh();
  }

  #toggle(id: string): void {
    if (this.#expanded.has(id)) this.#expanded.delete(id);
    else this.#expanded.add(id);
    this.#saveExpanded();
    this.render();
  }

  /** Open every level down to a node and select it (after an add or a move). */
  reveal(id: string): void {
    if (!this.#tree) this.render();
    if (!this.#tree) return;
    for (const node of pathToNode(this.#tree, id)) this.#expanded.add(node.id);
    this.#saveExpanded();
    this.#host.store.select({ kind: "node", id });
    this.render();
    const el = this.#rowsEl.querySelector<HTMLElement>(`[data-id="${cssEscape(id)}"]`);
    el?.scrollIntoView({ block: "nearest" });
  }

  /** Select the row for a step id, used when the map selection changes. */
  selectStepById(stepId: string): void {
    if (!this.#tree) return;
    for (const { node } of this.#rows) {
      if (node.kind === "step" && node.step?.id === stepId) {
        this.reveal(node.id);
        return;
      }
    }
  }

  #addStep(node: TreeNode, anchor: HTMLElement): void {
    const listPath = node.listPath;
    if (!listPath) return;
    openStepPicker(anchor, `Add a step to ${node.label}`, (choice) => {
      const store = this.#host.store;
      const step = stepForChoice(choice, store.freshStepId());
      const added = store.insertStep(listPath, -1, step, `Add ${choice.label.toLowerCase()}`);
      this.render();
      if (added) this.reveal(`step:${String(step.id)}`);
      this.#host.refresh();
    });
  }

  #addTrigger(kind: "triggers" | "interrupts", anchor: HTMLElement): void {
    openTriggerPicker(anchor, kind === "triggers" ? "What starts this mission?" : "What interrupts it?", (type) => {
      const store = this.#host.store;
      const trigger = triggerForType(type, genId(kind === "triggers" ? "t" : "i"));
      if (kind === "interrupts") (trigger as { run?: string }).run = "";
      const index = store.addTrigger(kind, trigger as never);
      this.render();
      if (index >= 0) this.reveal(`${kind === "triggers" ? "trigger" : "interrupt"}:${index}`);
      this.#host.refresh();
    });
  }

  #menu(node: TreeNode, x: number, y: number): void {
    const store = this.#host.store;
    const items: MenuItem[] = [];
    if (node.listPath) {
      items.push({ label: `Add a step to ${node.label}`, icon: "plus" as IconName, hint: "Ins", run: () => this.#addStepAtPointer(node, x, y) });
    }
    if (node.kind === "triggers" || node.kind === "interrupts") {
      items.push({ label: node.kind === "triggers" ? "Add a trigger" : "Add an interrupt", icon: "plus" as IconName, hint: "Ins", run: () => this.#addTriggerAtPointer(node.kind === "triggers" ? "triggers" : "interrupts", x, y) });
    }
    if (node.kind === "step" && node.path) {
      if (node.children.some((c) => c.listPath)) {
        const first = node.children.find((c) => c.listPath);
        if (first) items.push({ label: `Add a step to ${first.label}`, icon: "plus" as IconName, run: () => this.#addStepAtPointer(first, x, y) });
      }
      items.push({ label: "-", run: () => undefined });
      items.push({ label: "Duplicate", icon: "copy" as IconName, hint: "Ctrl+D", run: () => this.duplicateSelected() });
      items.push({ label: node.enabled ? "Turn off" : "Turn on", icon: node.enabled ? ("eyeOff" as IconName) : ("eye" as IconName), hint: "Ctrl+E", run: () => this.toggleEnabledSelected() });
      items.push({ label: "Delete", icon: "trash" as IconName, hint: "Del", danger: true, run: () => this.deleteSelected() });
    }
    if (node.kind === "trigger" || node.kind === "interrupt") {
      items.push({ label: "-", run: () => undefined });
      items.push({ label: "Delete", icon: "trash" as IconName, hint: "Del", danger: true, run: () => this.deleteSelected() });
    }
    if (node.kind === "mission") {
      const name = node.id.startsWith("mission:") ? node.id.slice("mission:".length) : (store.mission?.name ?? "");
      const isOpen = node.id === "mission";
      if (!isOpen) items.push({ label: "Open", icon: "folder" as IconName, run: () => this.#host.openMission(name) });
      if (isOpen) {
        items.push({ label: "Export as a Python script", icon: "code" as IconName, run: () => this.#host.exportPython() });
        items.push({ label: "Export as behavior-tree XML", icon: "fileText" as IconName, run: () => this.#host.exportBt() });
      }
      items.push({ label: "-", run: () => undefined });
      items.push({ label: "Delete from the project", icon: "trash" as IconName, danger: true, disabled: name === "", run: () => this.#host.deleteMission(name) });
    }
    if (items.length === 0) return;
    openMenu(x, y, items);
  }

  #addStepAtPointer(node: TreeNode, x: number, y: number): void {
    const anchor = h("div", { style: `position:fixed;left:${x}px;top:${y}px;width:1px;height:1px` });
    document.body.appendChild(anchor);
    this.#addStep(node, anchor);
    setTimeout(() => anchor.remove(), 0);
  }

  #addTriggerAtPointer(kind: "triggers" | "interrupts", x: number, y: number): void {
    const anchor = h("div", { style: `position:fixed;left:${x}px;top:${y}px;width:1px;height:1px` });
    document.body.appendChild(anchor);
    this.#addTrigger(kind, anchor);
    setTimeout(() => anchor.remove(), 0);
  }

  // ---- commands (also reachable from the keyboard) ------------------------

  get selectedNode(): TreeNode | null {
    const sel = this.#host.store.selection;
    if (sel.kind !== "node" || !this.#tree) return null;
    for (const { node } of this.#rows) if (node.id === sel.id) return node;
    return null;
  }

  deleteSelected(): void {
    const node = this.selectedNode;
    if (!node) return;
    const store = this.#host.store;
    if (node.kind === "step" && node.path) {
      store.removeStep(node.path);
      store.select({ kind: "none" });
    } else if (node.kind === "trigger" && node.index !== undefined) {
      store.removeTrigger("triggers", node.index);
      store.select({ kind: "none" });
    } else if (node.kind === "interrupt" && node.index !== undefined) {
      store.removeTrigger("interrupts", node.index);
      store.select({ kind: "none" });
    } else {
      return;
    }
    this.render();
    this.#host.refresh();
  }

  duplicateSelected(): void {
    const node = this.selectedNode;
    if (!node || node.kind !== "step" || !node.path) return;
    const copy = this.#host.store.duplicateStep(node.path);
    this.render();
    if (copy) this.reveal(`step:${String(copy.id)}`);
    this.#host.refresh();
  }

  toggleEnabledSelected(): void {
    const node = this.selectedNode;
    if (!node) return;
    const store = this.#host.store;
    if (node.kind === "step" && node.path) store.setStepEnabled(node.path, !node.enabled);
    else if (node.kind === "trigger" && node.index !== undefined) store.setTriggerParam("triggers", node.index, "enabled", node.enabled ? false : undefined);
    else if (node.kind === "interrupt" && node.index !== undefined) store.setTriggerParam("interrupts", node.index, "enabled", node.enabled ? false : undefined);
    else return;
    this.render();
    this.#host.refresh();
  }

  /** Alt+arrow: move the selected step one place within its own level. */
  moveSelected(delta: -1 | 1): void {
    const node = this.selectedNode;
    if (!node?.path || node.kind !== "step" || !node.step) return;
    if (!this.#host.store.nudgeStep(node.path, delta)) return;
    this.render();
    this.reveal(`step:${String(node.step.id)}`);
    this.#host.refresh();
  }

  addToSelected(): void {
    const node = this.selectedNode;
    if (!node) return;
    const row = this.#rowsEl.querySelector<HTMLElement>(`[data-id="${cssEscape(node.id)}"]`);
    if (!row) return;
    if (node.listPath) this.#addStep(node, row);
    else if (node.kind === "triggers") this.#addTrigger("triggers", row);
    else if (node.kind === "interrupts") this.#addTrigger("interrupts", row);
  }

  // ---- keyboard -----------------------------------------------------------

  #onKey(ev: KeyboardEvent): void {
    const sel = this.#host.store.selection;
    const id = sel.kind === "node" ? sel.id : "";
    const index = this.#rows.findIndex((r) => r.node.id === id);
    const node = index >= 0 ? this.#rows[index]!.node : null;
    switch (ev.key) {
      case "ArrowDown":
        if (ev.altKey) {
          ev.preventDefault();
          this.moveSelected(1);
          return;
        }
        ev.preventDefault();
        this.#selectRow(index + 1);
        return;
      case "ArrowUp":
        if (ev.altKey) {
          ev.preventDefault();
          this.moveSelected(-1);
          return;
        }
        ev.preventDefault();
        this.#selectRow(index - 1);
        return;
      case "ArrowRight":
        if (node && !this.#expanded.has(node.id) && node.children.length > 0) {
          ev.preventDefault();
          this.#toggle(node.id);
        } else {
          ev.preventDefault();
          this.#selectRow(index + 1);
        }
        return;
      case "ArrowLeft":
        if (node && this.#expanded.has(node.id) && node.children.length > 0) {
          ev.preventDefault();
          this.#toggle(node.id);
        } else if (index > 0) {
          ev.preventDefault();
          // Jump to the parent row: the nearest row above with a smaller depth.
          const depth = this.#rows[index]!.depth;
          for (let i = index - 1; i >= 0; i--) {
            if (this.#rows[i]!.depth < depth) {
              this.#selectRow(i);
              break;
            }
          }
        }
        return;
      case "Delete":
        ev.preventDefault();
        this.deleteSelected();
        return;
      case "Insert":
        ev.preventDefault();
        this.addToSelected();
        return;
      default:
        break;
    }
    if (ev.ctrlKey && (ev.key === "d" || ev.key === "D")) {
      ev.preventDefault();
      this.duplicateSelected();
    } else if (ev.ctrlKey && (ev.key === "e" || ev.key === "E")) {
      ev.preventDefault();
      this.toggleEnabledSelected();
    }
  }

  #selectRow(index: number): void {
    const row = this.#rows[Math.max(0, Math.min(this.#rows.length - 1, index))];
    if (!row) return;
    this.#select(row.node);
    this.#rowsEl.querySelector<HTMLElement>(`[data-id="${cssEscape(row.node.id)}"]`)?.scrollIntoView({ block: "nearest" });
  }

  // ---- drag and drop ------------------------------------------------------

  #onDragOver(ev: DragEvent, node: TreeNode, row: HTMLElement): void {
    if (!this.#dragId) return;
    const zone = this.#dropZone(ev, node, row);
    if (!zone) return;
    ev.preventDefault();
    if (ev.dataTransfer) ev.dataTransfer.dropEffect = "move";
    row.classList.remove("drop-before", "drop-after", "drop-into");
    row.classList.add(`drop-${zone}`);
  }

  #dropZone(ev: DragEvent, node: TreeNode, row: HTMLElement): DropZone | null {
    const rect = row.getBoundingClientRect();
    const t = (ev.clientY - rect.top) / Math.max(1, rect.height);
    const acceptsInto = node.listPath !== undefined || (node.kind === "step" && node.children.some((c) => c.listPath !== undefined));
    if (node.kind === "step") {
      if (t < 0.3) return "before";
      if (t > 0.7) return "after";
      return acceptsInto ? "into" : t < 0.5 ? "before" : "after";
    }
    return acceptsInto ? "into" : null;
  }

  #onDrop(ev: DragEvent, node: TreeNode, row: HTMLElement): void {
    const dragId = this.#dragId ?? ev.dataTransfer?.getData("text/plain") ?? "";
    row.classList.remove("drop-before", "drop-after", "drop-into");
    if (!dragId || !this.#tree) return;
    const zone = this.#dropZone(ev, node, row);
    if (!zone) return;
    ev.preventDefault();
    const source = this.#rows.find((r) => r.node.id === dragId)?.node;
    if (!source?.path) return;

    let listPath: Path | undefined;
    let index = -1;
    if (zone === "into") {
      const container = node.listPath ? node : node.children.find((c) => c.listPath !== undefined);
      listPath = container?.listPath;
      index = -1;
    } else if (node.path) {
      listPath = node.path.slice(0, -1);
      const at = node.path[node.path.length - 1];
      index = typeof at === "number" ? (zone === "after" ? at + 1 : at) : -1;
    }
    if (!listPath) return;
    const moved = this.#host.store.moveStep(source.path, listPath, index);
    if (!moved) {
      this.#host.toast("A step cannot be moved inside itself.");
      return;
    }
    this.render();
    if (source.step) this.reveal(`step:${String(source.step.id)}`);
    this.#host.refresh();
  }

  #clearDropMarks(): void {
    for (const el of this.#rowsEl.querySelectorAll(".drop-before, .drop-after, .drop-into")) {
      el.classList.remove("drop-before", "drop-after", "drop-into");
    }
  }

  // ---- expanded state -----------------------------------------------------

  /** Remembered per mission, so opening one again looks the way it was left. */
  #storageKey(): string {
    return `${STORAGE_KEY}.${this.#host.store.mission?.name ?? "-"}`;
  }

  #restoreExpanded(): void {
    try {
      const raw = localStorage.getItem(this.#storageKey());
      if (raw) {
        const list = JSON.parse(raw) as unknown;
        if (Array.isArray(list)) this.#expanded = new Set([ROOT, ...list.filter((v): v is string => typeof v === "string")]);
      }
    } catch {
      /* a corrupt entry just means the default expansion */
    }
  }

  /** Call after opening a different mission. */
  reloadExpanded(): void {
    this.#expanded = new Set([ROOT, ...DEFAULT_EXPANDED]);
    this.#restoreExpanded();
  }

  #saveExpanded(): void {
    try {
      localStorage.setItem(this.#storageKey(), JSON.stringify([...this.#expanded]));
    } catch {
      /* private mode: the tree just forgets between sessions */
    }
  }
}

function closedMission(summary: MissionSummary): TreeNode {
  const bits: string[] = [];
  if (summary.steps !== undefined) bits.push(`${summary.steps} ${summary.steps === 1 ? "step" : "steps"}`);
  if (summary.triggers && summary.triggers.length > 0) bits.push(summary.triggers[0]!);
  if (summary.state && summary.state !== "idle") bits.push(summary.state);
  return {
    id: `mission:${summary.name}`,
    kind: "mission",
    label: summary.title?.trim() || summary.name,
    detail: bits.join(" · "),
    icon: "file",
    enabled: true,
    draggable: false,
    children: [],
  };
}

function runIcon(phase: StepRunPhase): IconName {
  switch (phase) {
    case "running":
      return "playCircle";
    case "done":
      return "checkCircle";
    case "failed":
      return "xCircle";
    default:
      return "circle";
  }
}

function runSentence(state: StepRunState): string {
  const took = state.durationS !== undefined ? ` It took ${state.durationS.toFixed(1)} seconds.` : "";
  switch (state.phase) {
    case "running":
      return `This step is running now.${took}`;
    case "done":
      return `This step finished.${took}`;
    case "failed":
      return `This step failed.${took}`;
    default:
      return "This step has not run yet.";
  }
}

/** `CSS.escape` is not in the DOM lib typings everywhere; this is enough for our ids. */
function cssEscape(value: string): string {
  return value.replace(/["\\]/g, "\\$&");
}
