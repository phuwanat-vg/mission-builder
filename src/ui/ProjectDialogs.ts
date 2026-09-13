/**
 * The project's dialogs: its settings, deploying it to a robot, how to import
 * from a robot, and what to do with unsaved changes.
 */

import { h } from "./dom";
import { icon } from "./icons";
import { choose, field, openModal } from "./modal";
import type { RouteStore } from "../mission/RouteStore";
import { DEFAULT_ANSWER_TOPIC, DEFAULT_REQUEST_TOPIC } from "../mission/types";

// ---- project settings ------------------------------------------------------

/** File → Project settings: name, description, robot address and the request topics. */
export function openProjectSettings(store: RouteStore, currentUrl: string, done: () => void): void {
  const meta = store.meta;
  const settings = meta.settings;
  const str = (v: unknown): string => (typeof v === "string" ? v : "");
  const name = h("input", { type: "text", value: meta.name, placeholder: "Line 3 delivery" });
  const description = h("textarea", { rows: 2, placeholder: "What this project sets up" });
  description.value = meta.description ?? "";
  const url = h("input", { type: "text", value: str(settings.robot_url), placeholder: "ws://192.168.1.40:8765" });
  const useCurrent = h("button", { title: "Use the address in the top bar" }, icon("plug"), "Use the top bar's");
  useCurrent.addEventListener("click", () => {
    url.value = currentUrl;
  });
  const request = h("input", { type: "text", value: str(settings.request_topic), placeholder: DEFAULT_REQUEST_TOPIC });
  const answer = h("input", { type: "text", value: str(settings.answer_topic), placeholder: DEFAULT_ANSWER_TOPIC });

  const dialog = openModal({
    title: "Project settings",
    content: [
      field("Project name", name),
      field("Description", description),
      field("Robot address", h("div", { class: "row" }, url, useCurrent), "Filled into the top bar when the project is opened."),
      h("div", { class: "field-row" }, field("Request topic", request), field("Answer topic", answer)),
      h("p", { class: "prose muted", text: "New Ask for an answer steps take these topics. Steps that already name a topic keep theirs. iViz's Dashboard answers /iviz/request on /iviz/answer." }),
    ],
    buttons: [
      { label: "Cancel" },
      {
        label: "Save settings",
        kind: "primary",
        run: () => {
          const n = name.value.trim();
          if (n === "") return fail("Give the project a name.");
          if (n.length > 120) return fail("The project name can be at most 120 characters.");
          const rt = request.value.trim();
          const at = answer.value.trim();
          if (rt !== "" && !rt.startsWith("/")) return fail("The request topic has to start with /, like /iviz/request.");
          if (at !== "" && !at.startsWith("/")) return fail("The answer topic has to start with /, like /iviz/answer.");
          if (rt !== "" && rt === at) return fail("The request and the answer need two different topics.");
          const next: Record<string, unknown> = { ...settings };
          const put = (key: string, value: string): void => {
            if (value === "") delete next[key];
            else next[key] = value;
          };
          put("robot_url", url.value.trim());
          put("request_topic", rt);
          put("answer_topic", at);
          store.setMeta({ name: n, description: description.value.trim(), settings: next }, "Change the project settings");
          done();
          return true;
        },
      },
    ],
  });
  function fail(sentence: string): false {
    dialog.setError(sentence);
    return false;
  }
}

// ---- deploy ----------------------------------------------------------------

export interface DeployPlan {
  maps: number;
  missions: string[];
  /** Problems that stop a deploy, as sentences. */
  errors: string[];
  /** Things worth knowing that do not stop it (a task with no route). */
  cautions: string[];
}

export interface DeployHost {
  plan: DeployPlan;
  /** The robot's mission names, or null when they cannot be read. */
  robotMissions(): Promise<string[] | null>;
  /** Send it. Resolves true when the dialog can close. */
  deploy(replace: boolean): Promise<boolean>;
}

/** File → Deploy project to robot, with the optional replace and the list it would delete. */
export function openDeployDialog(host: DeployHost): void {
  const plan = host.plan;
  const replace = h("input", { type: "checkbox" });
  // On by default: the robot ends up with exactly this project's missions.
  replace.checked = true;
  const replaceNote = h("p", { class: "prose muted", text: "Missions on the robot that are not in this project are left alone." });
  const content: (Node | string)[] = [
    h("p", {
      class: "prose",
      text: `Sends ${plan.maps} ${plan.maps === 1 ? "map" : "maps"} and ${plan.missions.length} ${plan.missions.length === 1 ? "mission" : "missions"}${plan.missions.length > 0 ? ` (${plan.missions.join(", ")})` : ""} to the robot. The robot checks every mission first and writes nothing if one of them is invalid, then re-arms their triggers.`,
    }),
  ];
  if (plan.errors.length > 0) {
    content.push(h("div", { class: "sub-title", text: "Fix these first" }));
    for (const e of plan.errors.slice(0, 6)) content.push(h("div", { class: "finding error", text: e }));
    if (plan.errors.length > 6) content.push(h("p", { class: "prose muted", text: `And ${plan.errors.length - 6} more.` }));
  }
  if (plan.cautions.length > 0) {
    content.push(h("div", { class: "sub-title", text: "Worth knowing" }));
    for (const c of plan.cautions.slice(0, 6)) content.push(h("div", { class: "finding warning", text: c }));
  }
  content.push(h("label", { class: "check-row" }, replace, h("span", { text: "Replace missions on the robot" })), replaceNote);

  let toDelete: string[] | null = [];
  const showReplace = (): void => {
    if (!replace.checked) {
      toDelete = [];
      replaceNote.textContent = "Missions on the robot that are not in this project are left alone.";
      return;
    }
    replaceNote.textContent = "Reading the robot's missions.";
    toDelete = null;
    void host.robotMissions().then((names) => {
      if (!replace.checked) return;
      if (names === null) {
        // Replace is on by default; never leave it on when what it deletes is unknown.
        replace.checked = false;
        toDelete = [];
        replaceNote.textContent = "The robot's missions could not be read, so Replace was turned off. Missions on the robot that are not in this project are left alone.";
        return;
      }
      toDelete = names.filter((n) => !plan.missions.includes(n));
      replaceNote.textContent =
        toDelete.length === 0 ? "Every mission on the robot is in this project, so nothing is deleted." : `These missions are on the robot but not in this project and will be deleted: ${toDelete.join(", ")}.`;
    });
  };
  replace.addEventListener("change", showReplace);
  showReplace();

  const dialog = openModal({
    title: "Deploy project to robot",
    size: "medium",
    content,
    buttons: [
      { label: "Cancel" },
      {
        label: "Deploy",
        icon: "upload",
        kind: "primary",
        run: async () => {
          if (plan.errors.length > 0) {
            dialog.setError("The project has problems the robot would refuse. Fix them first.");
            return false;
          }
          if (replace.checked && toDelete === null) {
            dialog.setError("Wait until the robot's missions have been read, so you can see what Replace deletes.");
            return false;
          }
          dialog.setError("");
          dialog.setBusy(true);
          const ok = await host.deploy(replace.checked);
          dialog.setBusy(false);
          return ok;
        },
      },
    ],
  });
  const deployBtn = dialog.button("Deploy");
  if (deployBtn && plan.errors.length > 0) deployBtn.disabled = true;
}

// ---- questions ---------------------------------------------------------------

export type ImportMode = "replace" | "merge";

export function askImportMode(maps: number, missions: number): Promise<ImportMode | null> {
  return choose<ImportMode>(
    "Import from robot",
    [
      `The robot has ${maps} ${maps === 1 ? "map" : "maps"} and ${missions} ${missions === 1 ? "mission" : "missions"}.`,
      "Replace makes the project exactly what the robot has. Merge adds the maps, points, lanes and missions the project does not have yet and keeps the project's own version of everything else. Either can be undone.",
    ],
    [
      { value: "merge", label: "Merge into the project" },
      { value: "replace", label: "Replace the project", kind: "primary" },
    ],
  );
}

export type UnsavedAnswer = "save" | "discard";

/** Unsaved changes before New, Open or Close. Null means stay. */
export function askUnsaved(projectName: string, then: string): Promise<UnsavedAnswer | null> {
  return choose<UnsavedAnswer>(
    "Unsaved changes",
    [`${projectName} has changes that are not saved. Save them before ${then}?`],
    [
      { value: "discard", label: "Don't save", kind: "danger" },
      { value: "save", label: "Save", kind: "primary" },
    ],
  );
}
