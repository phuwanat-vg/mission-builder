/**
 * Export a mission as a standalone `nav2_simple_commander` Python script or as
 * Nav2 behavior-tree XML.
 *
 * Both generators are the web editor's, ported unchanged
 * (`src/mission/codegen/`). What is here is only the way the result is handed
 * over: a panel with the text, a Copy button and a Save button. The webview
 * blocks some downloads, so Copy is always there as the way that cannot fail.
 */

import { h } from "./dom";
import { icon } from "./icons";
import { generatePython } from "../mission/codegen/python";
import { btFileName, renderBehaviorTree, templateDefaults } from "../mission/codegen/bt";
import { walkSteps } from "../mission/ids";
import { isBtTemplateName } from "../mission/blocks";
import type { Mission, SitesDoc } from "../mission/types";
import { isRecord } from "../mission/types";

export interface ExportResult {
  fileName: string;
  text: string;
  note: string;
}

/** The whole mission as one Python script. */
export function exportPython(mission: Mission, sites: SitesDoc | null, activeMap: string | null): ExportResult {
  return {
    fileName: `${mission.name}.py`,
    text: generatePython(mission, { sites, activeMap, fileName: `${mission.name}.json` }),
    note: "A self-contained nav2_simple_commander script. Put it on the robot, make it executable and run it with the ROS environment sourced.",
  };
}

/**
 * The behavior trees this mission asks for. A step whose `behavior_tree` is a
 * template gets its own file, named exactly as the runner names it at deploy;
 * a mission with none gets the default navigate-with-recovery tree, so the
 * export is never empty.
 */
export function exportBehaviorTrees(mission: Mission): ExportResult {
  const files: { name: string; xml: string }[] = [];
  for (const visit of walkSteps(mission)) {
    const spec = visit.step.behavior_tree;
    if (isRecord(spec) && isBtTemplateName(spec.template)) {
      files.push({ name: btFileName(mission.name, String(visit.step.id ?? "step")), xml: renderBehaviorTree(spec) });
    }
  }
  if (files.length === 1) {
    return {
      fileName: files[0]!.name,
      text: files[0]!.xml,
      note: "The runner writes this same file to <home>/bt/ when the mission is deployed, and sends its path with the goal.",
    };
  }
  if (files.length === 0) {
    const xml = renderBehaviorTree({ template: "navigate_with_recovery", ...templateDefaults() });
    return {
      fileName: `${mission.name}__default.xml`,
      text: xml,
      note: "No step of this mission asks for its own behavior tree, so this is the default navigate-with-recovery tree with Nav2's usual settings.",
    };
  }
  const text = files.map((f) => `<!-- ${f.name} -->\n${f.xml}`).join("\n\n");
  return {
    fileName: `${mission.name}__behavior_trees.xml`,
    text,
    note: `${files.length} behavior trees, one per step that asks for one. Each block is one file; its name is in the comment above it.`,
  };
}

/** Show the generated text with Copy and Save. Closes on Escape or the button. */
export function showExport(title: string, result: ExportResult): void {
  const pre = h("pre", { class: "export-text" });
  pre.textContent = result.text;
  const status = h("span", { class: "stats", text: `${result.text.split("\n").length} lines` });

  const copy = h("button", { class: "primary" }, icon("copy"), "Copy to the clipboard");
  copy.addEventListener("click", () => {
    void navigator.clipboard
      .writeText(result.text)
      .then(() => {
        status.textContent = "Copied.";
      })
      .catch(() => {
        // Older webviews: select the text so Ctrl+C works.
        const range = document.createRange();
        range.selectNodeContents(pre);
        const sel = window.getSelection();
        sel?.removeAllRanges();
        sel?.addRange(range);
        status.textContent = "Select the text and press Ctrl+C.";
      });
  });

  const save = h("button", {}, icon("download"), `Save ${result.fileName}`);
  save.addEventListener("click", () => {
    try {
      const url = URL.createObjectURL(new Blob([result.text], { type: "text/plain" }));
      const a = h("a", { href: url, download: result.fileName });
      document.body.appendChild(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 5000);
      status.textContent = `Saved as ${result.fileName}, if the window allows downloads.`;
    } catch {
      status.textContent = "This window cannot save files. Use Copy instead.";
    }
  });

  const close = h("button", {}, icon("close"), "Close");
  const backdrop = h("div", { class: "modal-backdrop" });
  const dismiss = (): void => {
    backdrop.remove();
    document.removeEventListener("keydown", onKey, true);
  };
  const onKey = (ev: KeyboardEvent): void => {
    if (ev.key === "Escape") {
      ev.stopPropagation();
      dismiss();
    }
  };
  close.addEventListener("click", dismiss);
  backdrop.addEventListener("click", (ev) => {
    if (ev.target === backdrop) dismiss();
  });
  backdrop.appendChild(
    h(
      "div",
      { class: "modal" },
      h("div", { class: "modal-head" }, h("span", { class: "modal-title", text: title }), h("div", { class: "spacer" }), status),
      h("p", { class: "prose", text: result.note }),
      pre,
      h("div", { class: "row buttons" }, copy, save, h("div", { class: "spacer" }), close),
    ),
  );
  document.body.appendChild(backdrop);
  document.addEventListener("keydown", onKey, true);
}
