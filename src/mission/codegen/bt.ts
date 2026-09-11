/**
 * Behavior-tree XML from `behavior_tree` templates. Byte-for-byte port of
 * runner/mission_runner/bt.py (same defaults, whitespace and comment line),
 * so the editor's "Export BT XML" matches what the runner writes at deploy.
 */

import type { BtTemplate, Recovery } from "../types";
import { BT_TEMPLATES, RECOVERIES } from "../types";

export const BT_DEFAULTS = {
  retries: 6,
  recoveries: ["clear_costmap", "spin", "wait", "backup"] as Recovery[],
  replan_rate_hz: 1.0,
  spin_deg: 90.0,
  backup_m: 0.3,
  wait_s: 5.0,
  planner_id: "GridBased",
  controller_id: "FollowPath",
} as const;

export function templateDefaults(): Required<Omit<BtTemplate, "template">> {
  return { ...BT_DEFAULTS, recoveries: [...BT_DEFAULTS.recoveries] };
}

export function btFileName(mission: string, stepId: string): string {
  return `${`${mission}__${stepId}`.replace(/[^A-Za-z0-9_-]/g, "_")}.xml`;
}

/** Python's `f"{float(v):.4g}"` (round half to even on exact ties, like CPython). */
export function fmtG4(v: number): string {
  if (!Number.isFinite(v)) return v > 0 ? "inf" : v < 0 ? "-inf" : "nan";
  if (v === 0) return Object.is(v, -0) ? "-0" : "0";
  const rounded = roundSig4(v);
  const exp = Math.floor(Math.log10(Math.abs(rounded)));
  if (exp < -4 || exp >= 4) {
    const [mant, ex] = rounded.toExponential(3).split("e") as [string, string];
    const en = Number(ex);
    return `${stripZeros(mant)}e${en < 0 ? "-" : "+"}${String(Math.abs(en)).padStart(2, "0")}`;
  }
  return stripZeros(rounded.toFixed(Math.max(0, 3 - exp)));
}

/**
 * Round to 4 significant digits. JS `toPrecision` rounds exact ties away from
 * zero; Python rounds them to even. Ties are detected on the exact binary
 * value (21 significant digits are enough: a tie has at most 5).
 */
function roundSig4(v: number): number {
  const [mant, exp] = Math.abs(v).toExponential(20).split("e") as [string, string];
  const digits = mant.replace(".", "");
  const rest = digits.slice(4);
  if (/^50*$/.test(rest) && Number(digits[3]) % 2 === 0) {
    const kept = `${digits[0]}.${digits.slice(1, 4)}e${exp}`;
    return Math.sign(v) * Number(kept);
  }
  return Number(v.toPrecision(4));
}

function stripZeros(s: string): string {
  return s.includes(".") ? s.replace(/0+$/, "").replace(/\.$/, "") : s;
}

/** Return the XML for a `behavior_tree` template object. Throws on an unknown template. */
export function renderBehaviorTree(spec: BtTemplate | Record<string, unknown>): string {
  const cfg: Record<string, unknown> = { ...BT_DEFAULTS };
  for (const [k, v] of Object.entries(spec)) if (v !== null && v !== undefined) cfg[k] = v;
  const template = typeof cfg.template === "string" ? cfg.template : BT_TEMPLATES[0];
  if (!(BT_TEMPLATES as readonly string[]).includes(template)) throw new Error(`unknown behavior tree template '${template}'`);
  const retries = Math.trunc(Number(cfg.retries));
  const rate = Number(cfg.replan_rate_hz);
  const planner = String(cfg.planner_id);
  const controller = String(cfg.controller_id);
  const recoveries = (Array.isArray(cfg.recoveries) ? cfg.recoveries : []).filter((r): r is Recovery => (RECOVERIES as readonly string[]).includes(String(r)));

  let compute: string;
  if (template === "navigate_with_recovery") {
    compute =
      '          <RecoveryNode number_of_retries="1" name="ComputePathToPose">\n' +
      `            <ComputePathToPose goal="{goal}" path="{path}" planner_id="${planner}" error_code_id="{compute_path_error_code}"/>\n` +
      '            <ClearEntireCostmap name="ClearGlobalCostmap-Context" service_name="global_costmap/clear_entirely_global_costmap"/>\n' +
      "          </RecoveryNode>\n";
  } else {
    compute =
      '          <RecoveryNode number_of_retries="1" name="ComputePathThroughPoses">\n' +
      "            <ReactiveSequence>\n" +
      '              <RemovePassedGoals input_goals="{goals}" output_goals="{goals}" radius="0.7"/>\n' +
      `              <ComputePathThroughPoses goals="{goals}" path="{path}" planner_id="${planner}" error_code_id="{compute_path_error_code}"/>\n` +
      "            </ReactiveSequence>\n" +
      '            <ClearEntireCostmap name="ClearGlobalCostmap-Context" service_name="global_costmap/clear_entirely_global_costmap"/>\n' +
      "          </RecoveryNode>\n";
  }

  const recoveryNodes: string[] = [];
  for (const r of recoveries) {
    if (r === "clear_costmap") {
      recoveryNodes.push(
        '          <Sequence name="ClearingActions">\n' +
          '            <ClearEntireCostmap name="ClearLocalCostmap-Subtree" service_name="local_costmap/clear_entirely_local_costmap"/>\n' +
          '            <ClearEntireCostmap name="ClearGlobalCostmap-Subtree" service_name="global_costmap/clear_entirely_global_costmap"/>\n' +
          "          </Sequence>\n",
      );
    } else if (r === "spin") {
      recoveryNodes.push(`          <Spin spin_dist="${fmtG4((Number(cfg.spin_deg) * Math.PI) / 180)}" error_code_id="{spin_error_code}"/>\n`);
    } else if (r === "wait") {
      recoveryNodes.push(`          <Wait wait_duration="${fmtG4(Number(cfg.wait_s))}" error_code_id="{wait_error_code}"/>\n`);
    } else if (r === "backup") {
      recoveryNodes.push(`          <BackUp backup_dist="${fmtG4(Number(cfg.backup_m))}" backup_speed="0.05" error_code_id="{backup_error_code}"/>\n`);
    }
  }

  const fallback =
    recoveryNodes.length > 0
      ? '      <ReactiveFallback name="RecoveryFallback">\n' +
        "        <GoalUpdated/>\n" +
        '        <RoundRobin name="RecoveryActions">\n' +
        recoveryNodes.join("") +
        "        </RoundRobin>\n" +
        "      </ReactiveFallback>\n"
      : '      <AlwaysFailure name="NoRecovery"/>\n';

  return (
    '<?xml version="1.0" encoding="UTF-8"?>\n' +
    `<!-- generated by mission_runner: template=${template} retries=${retries} recoveries=${recoveries.join(",") || "none"} -->\n` +
    '<root BTCPP_format="4" main_tree_to_execute="MainTree">\n' +
    '  <BehaviorTree ID="MainTree">\n' +
    `    <RecoveryNode number_of_retries="${retries}" name="NavigateRecovery">\n` +
    '      <PipelineSequence name="NavigateWithReplanning">\n' +
    `        <RateController hz="${fmtG4(rate)}">\n` +
    compute +
    "        </RateController>\n" +
    '        <RecoveryNode number_of_retries="1" name="FollowPath">\n' +
    `          <FollowPath path="{path}" controller_id="${controller}" error_code_id="{follow_path_error_code}"/>\n` +
    '          <ClearEntireCostmap name="ClearLocalCostmap-Context" service_name="local_costmap/clear_entirely_local_costmap"/>\n' +
    "        </RecoveryNode>\n" +
    "      </PipelineSequence>\n" +
    fallback +
    "    </RecoveryNode>\n" +
    "  </BehaviorTree>\n" +
    "</root>\n"
  );
}
