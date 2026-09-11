/**
 * The mission as a tree.
 *
 * The left column of Mission Builder is a view over the ordinary `mission/1`
 * JSON: nothing here owns any state. `buildTree` reads a mission and returns
 * the nodes to draw; every node that can hold children names the JSON list it
 * inserts into, so adding, dragging and deleting are ordinary array edits on
 * the document and step ids and unknown fields round-trip untouched.
 *
 * Node ids are stable strings built from each step's own id, so the expanded
 * set and the selection survive a rebuild after every edit — including one
 * that reorders or reparents steps.
 */

import type { Finding, Interrupt, Mission, Path, Step, Trigger } from "./types";
import type { IconName } from "../ui/icons";
import { blockDefOrUnknown, stepSummaryShort, stepTitle, triggerIcon, triggerSummary } from "./blocks";
import { pathKey } from "./ids";

export type NodeKind =
  | "mission"
  | "triggers"
  | "trigger"
  | "interrupts"
  | "interrupt"
  | "settings"
  | "flow"
  | "step"
  | "branch"
  | "onfail"
  | "onabort";

export interface TreeNode {
  /** Stable across rebuilds, including reorders: built from the step's id. */
  id: string;
  kind: NodeKind;
  label: string;
  /** The one muted line under the label. */
  detail: string;
  icon: IconName;
  children: TreeNode[];
  /** The step list new children go into, when this node accepts them. */
  listPath?: Path;
  /** The step itself, for step nodes. */
  step?: Step;
  /** Path of the step in the document, for step nodes. */
  path?: Path;
  /** Index of a trigger or interrupt in its array. */
  index?: number;
  /** False when `enabled: false` (the step or trigger is turned off). */
  enabled: boolean;
  /** 1-based position within its own list, for flow steps. */
  number?: number;
  /** Draggable rows are the ones that live in a step list. */
  draggable: boolean;
}

export const ROOT_ID = "mission";
export const TRIGGERS_ID = "triggers";
export const INTERRUPTS_ID = "interrupts";
export const SETTINGS_ID = "settings";
export const FLOW_ID = "flow";
export const ON_ABORT_ID = "on_abort";

/** The whole mission, as the tree the left column draws. */
export function buildTree(mission: Mission | null): TreeNode | null {
  if (!mission) return null;
  const triggers = mission.triggers ?? [];
  const interrupts = mission.interrupts ?? [];
  const root: TreeNode = {
    id: ROOT_ID,
    kind: "mission",
    label: mission.title?.trim() || mission.name || "(unnamed mission)",
    detail: mission.name,
    icon: "route",
    enabled: true,
    draggable: false,
    children: [
      {
        id: TRIGGERS_ID,
        kind: "triggers",
        label: "Starts when",
        detail: triggers.length === 0 ? "Only started by hand" : `${triggers.length} ${triggers.length === 1 ? "trigger" : "triggers"}`,
        icon: "zap",
        enabled: true,
        draggable: false,
        children: triggers.map((t, i) => triggerNode(t, i, "trigger")),
      },
      {
        id: INTERRUPTS_ID,
        kind: "interrupts",
        label: "While running",
        detail: interrupts.length === 0 ? "Nothing can interrupt it" : `${interrupts.length} ${interrupts.length === 1 ? "interrupt" : "interrupts"}`,
        icon: "alert",
        enabled: true,
        draggable: false,
        children: interrupts.map((t, i) => triggerNode(t, i, "interrupt")),
      },
      {
        id: SETTINGS_ID,
        kind: "settings",
        label: "Settings",
        detail: settingsDetail(mission),
        icon: "settings",
        enabled: true,
        draggable: false,
        children: [],
      },
      {
        id: FLOW_ID,
        kind: "flow",
        label: "Tasks",
        detail: countDetail(mission.flow ?? []),
        icon: "list",
        enabled: true,
        draggable: false,
        listPath: ["flow"],
        children: stepNodes(mission, mission.flow ?? [], ["flow"]),
      },
    ],
  };
  const onAbort = mission.on_abort ?? [];
  root.children.push({
    id: ON_ABORT_ID,
    kind: "onabort",
    label: "When it fails",
    detail: onAbort.length === 0 ? "Nothing to clean up" : countDetail(onAbort),
    icon: "xCircle",
    enabled: true,
    draggable: false,
    listPath: ["on_abort"],
    children: stepNodes(mission, onAbort, ["on_abort"]),
  });
  return root;
}

function countDetail(steps: Step[]): string {
  return `${steps.length} ${steps.length === 1 ? "step" : "steps"}`;
}

function settingsDetail(mission: Mission): string {
  const bits: string[] = [];
  bits.push(mission.policy ?? "queue");
  if (typeof mission.priority === "number") bits.push(`priority ${mission.priority}`);
  const inputs = Object.keys(mission.inputs ?? {}).length;
  if (inputs > 0) bits.push(`${inputs} ${inputs === 1 ? "input" : "inputs"}`);
  const vars = Object.keys(mission.vars ?? {}).length;
  if (vars > 0) bits.push(`${vars} ${vars === 1 ? "variable" : "variables"}`);
  return bits.join(" · ");
}

function triggerNode(t: Trigger | Interrupt, index: number, kind: "trigger" | "interrupt"): TreeNode {
  const run = (t as Interrupt).run;
  const detail = kind === "interrupt" && typeof run === "string" && run !== "" ? `${triggerSummary(t)} → ${run}` : triggerSummary(t);
  return {
    id: `${kind}:${index}`,
    kind,
    label: typeof t.name === "string" && t.name.trim() !== "" ? t.name : triggerLabel(t),
    detail,
    icon: triggerIcon(t.type),
    index,
    enabled: t.enabled !== false,
    draggable: false,
    children: [],
  };
}

function triggerLabel(t: Trigger): string {
  return triggerSummary(t);
}

/** The rows for one step list, with their nested levels. */
function stepNodes(mission: Mission, list: Step[], listPath: Path): TreeNode[] {
  return list.map((step, i) => stepNode(mission, step, [...listPath, i], i + 1));
}

/**
 * Node ids key the expanded set and the selection, so they must survive a
 * reorder: they are built from the step's own id, which every step in an open
 * mission has (`assignIds` runs when one is loaded). A step that somehow has
 * none falls back to its path, which is stable enough to render.
 */
function stepKey(step: Step, path: Path): string {
  return typeof step.id === "string" && step.id !== "" ? step.id : `@${pathKey(path)}`;
}

function stepNode(mission: Mission, step: Step, path: Path, number: number): TreeNode {
  const def = blockDefOrUnknown(step.type);
  const nodeKey = stepKey(step, path);
  const node: TreeNode = {
    id: `step:${nodeKey}`,
    kind: "step",
    label: stepTitle(step),
    detail: stepSummaryShort(step, { mission }) || def.label,
    icon: def.icon,
    step,
    path,
    number,
    enabled: step.enabled !== false,
    draggable: true,
    children: [],
  };
  // Container branches (`then`, `else`, `body`) become child levels.
  for (const key of def.containers ?? []) {
    const nested = step[key];
    const branchPath: Path = [...path, key];
    node.children.push({
      id: `branch:${nodeKey}/${key}`,
      kind: "branch",
      label: branchLabel(step.type, key),
      detail: Array.isArray(nested) ? countDetail(nested as Step[]) : "0 steps",
      icon: key === "else" ? "gitBranch" : step.type === "loop" ? "repeat" : "gitBranch",
      enabled: true,
      draggable: false,
      listPath: branchPath,
      children: Array.isArray(nested) ? stepNodes(mission, nested as Step[], branchPath) : [],
    });
  }
  // The steps that run before a retry are this step's own "when it fails".
  const before = step.on_fail?.before_retry;
  const failPath: Path = [...path, "on_fail", "before_retry"];
  if (Array.isArray(before) && before.length > 0) {
    node.children.push({
      id: `onfail:${nodeKey}`,
      kind: "onfail",
      label: "When it fails",
      detail: countDetail(before),
      icon: "rotate",
      enabled: true,
      draggable: false,
      listPath: failPath,
      children: stepNodes(mission, before, failPath),
    });
  }
  return node;
}

/** Walk the tree depth-first, parents before children. */
export function* walkTree(node: TreeNode): Generator<TreeNode> {
  yield node;
  for (const child of node.children) yield* walkTree(child);
}

/** The rows that are actually visible, given which nodes are expanded. */
export function flattenVisible(root: TreeNode, expanded: ReadonlySet<string>): { node: TreeNode; depth: number }[] {
  const out: { node: TreeNode; depth: number }[] = [];
  const walk = (node: TreeNode, depth: number): void => {
    out.push({ node, depth });
    if (!expanded.has(node.id)) return;
    for (const child of node.children) walk(child, depth + 1);
  };
  walk(root, 0);
  return out;
}

export function findNode(root: TreeNode, id: string): TreeNode | null {
  for (const node of walkTree(root)) if (node.id === id) return node;
  return null;
}

/** The chain from the root down to `id`, so an edit can reveal what it made. */
export function pathToNode(root: TreeNode, id: string): TreeNode[] {
  const chain: TreeNode[] = [];
  const walk = (node: TreeNode): boolean => {
    chain.push(node);
    if (node.id === id) return true;
    for (const child of node.children) if (walk(child)) return true;
    chain.pop();
    return false;
  };
  return walk(root) ? chain : [];
}

function branchLabel(stepType: string, key: string): string {
  if (stepType === "if") return key === "then" ? "then" : "else";
  if (stepType === "loop") return "each time round";
  return key;
}

/**
 * The nodes a mission with no tasks yet still shows, so the levels a mission
 * has are visible before anything is in them.
 */
export const DEFAULT_EXPANDED: readonly string[] = [ROOT_ID, TRIGGERS_ID, INTERRUPTS_ID, FLOW_ID];

// ---- badges ----------------------------------------------------------------

export interface NodeBadges {
  errors: Finding[];
  warnings: Finding[];
}

/**
 * Validation findings attached to the node they belong to. Step findings are
 * matched by step id where the validator gives one and by path otherwise, so
 * a badge always lands on a row rather than disappearing.
 */
export function badgesForTree(root: TreeNode, findings: readonly Finding[]): Map<string, NodeBadges> {
  const byStepId = new Map<string, Finding[]>();
  const byPath = new Map<string, Finding[]>();
  for (const f of findings) {
    if (f.stepId) push(byStepId, f.stepId, f);
    push(byPath, pathKey(f.path), f);
  }
  const out = new Map<string, NodeBadges>();
  for (const node of walkTree(root)) {
    const own: Finding[] = [];
    if (node.kind === "step" && node.step && node.path) {
      const id = typeof node.step.id === "string" ? node.step.id : "";
      if (id !== "") own.push(...(byStepId.get(id) ?? []));
      // Findings that name the step's path but carry no id (schema-level ones).
      for (const f of byPath.get(pathKey(node.path)) ?? []) if (!f.stepId && !own.includes(f)) own.push(f);
    } else if (node.kind === "trigger" && node.index !== undefined) {
      own.push(...prefixed(findings, ["triggers", node.index]));
    } else if (node.kind === "interrupt" && node.index !== undefined) {
      own.push(...prefixed(findings, ["interrupts", node.index]));
    } else if (node.kind === "settings") {
      for (const key of ["name", "title", "description", "policy", "priority", "inputs", "vars", "schema", "version"]) {
        own.push(...prefixed(findings, [key]));
      }
    }
    if (own.length === 0) continue;
    out.set(node.id, {
      errors: own.filter((f) => f.level === "error"),
      warnings: own.filter((f) => f.level === "warning"),
    });
  }
  // A collapsed parent has to show that something below it is wrong.
  rollUp(root, out);
  return out;
}

function rollUp(node: TreeNode, badges: Map<string, NodeBadges>): NodeBadges {
  const own = badges.get(node.id) ?? { errors: [], warnings: [] };
  const errors = [...own.errors];
  const warnings = [...own.warnings];
  for (const child of node.children) {
    const sub = rollUp(child, badges);
    errors.push(...sub.errors);
    warnings.push(...sub.warnings);
  }
  if (errors.length || warnings.length) badges.set(node.id, { errors, warnings });
  return { errors, warnings };
}

function prefixed(findings: readonly Finding[], prefix: Path): Finding[] {
  return findings.filter((f) => f.path.length >= prefix.length && prefix.every((seg, i) => f.path[i] === seg));
}

function push<T>(map: Map<string, T[]>, key: string, value: T): void {
  const list = map.get(key);
  if (list) list.push(value);
  else map.set(key, [value]);
}

/**
 * One sentence explaining what is wrong with a node, for the badge's tooltip.
 * Findings are already sentences; this joins them and says how many there are.
 */
export function badgeSentence(badges: NodeBadges): string {
  const parts: string[] = [];
  for (const f of [...badges.errors, ...badges.warnings].slice(0, 4)) {
    parts.push(`${f.level === "error" ? "Error" : "Warning"}: ${f.message}.`);
  }
  const extra = badges.errors.length + badges.warnings.length - 4;
  if (extra > 0) parts.push(`And ${extra} more.`);
  return parts.join(" ");
}
