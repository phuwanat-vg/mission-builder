/**
 * The Activity bar along the bottom: one line when nothing is happening, the
 * live event list and the run history when it is opened or while a run is on.
 *
 * Events come from `/mission/event` and the status snapshots from
 * `/mission/state`, so this is exactly what the robot is doing, whether or not
 * the run was started from here.
 */

import { h } from "./dom";
import { icon } from "./icons";
import type { Run, RunnerEvent, RunnerStatus } from "../mission/MissionApi";

interface Entry {
  t: number;
  level: "info" | "warn" | "error" | "ok";
  text: string;
}

const MAX_ENTRIES = 300;

export interface ActivityHost {
  /** Fetch the run history; called when the bar is opened. */
  loadHistory(): void;
  /** Answer a pending `ask_user` prompt. */
  answerPrompt(id: string, answer: string): void;
}

export class Activity {
  readonly element: HTMLElement;
  #host: ActivityHost;
  #summaryEl: HTMLElement;
  #panelEl: HTMLElement;
  #eventsEl: HTMLElement;
  #historyEl: HTMLElement;
  #promptEl: HTMLElement;
  #caret: HTMLElement;
  #entries: Entry[] = [];
  #history: Run[] = [];
  #status: RunnerStatus | null = null;
  #open = false;
  #reason = "Not connected to a robot yet.";

  constructor(host: ActivityHost) {
    this.#host = host;
    this.#caret = h("span", { class: "caret", text: "˄" });
    this.#summaryEl = h("span", { class: "activity-summary", text: this.#reason });
    const toggle = h("button", { class: "activity-toggle" }, this.#caret, h("span", { text: "Activity" }));
    toggle.addEventListener("click", () => this.setOpen(!this.#open));
    const clear = h("button", { class: "icon-only", title: "Clear the event list" }, icon("eraser"));
    clear.addEventListener("click", () => {
      this.#entries = [];
      this.#renderEvents();
    });

    this.#eventsEl = h("div", { class: "activity-events" });
    this.#historyEl = h("div", { class: "activity-history" });
    this.#promptEl = h("div", { class: "prompt-banner" });
    this.#promptEl.hidden = true;
    this.#panelEl = h(
      "div",
      { class: "activity-panel" },
      this.#promptEl,
      h("div", { class: "activity-cols" }, h("div", { class: "activity-col" }, h("div", { class: "sub-title", text: "Live events" }), this.#eventsEl), h("div", { class: "activity-col" }, h("div", { class: "sub-title", text: "Recent runs" }), this.#historyEl)),
    );
    this.#panelEl.hidden = true;
    this.element = h("div", { class: "activity" }, h("div", { class: "activity-bar" }, toggle, this.#summaryEl, h("div", { class: "spacer" }), clear), this.#panelEl);
    this.#renderEvents();
    this.#renderHistory();
  }

  get open(): boolean {
    return this.#open;
  }

  setOpen(open: boolean): void {
    this.#open = open;
    this.#panelEl.hidden = !open;
    this.#caret.textContent = open ? "˅" : "˄";
    this.element.classList.toggle("open", open);
    if (open) this.#host.loadHistory();
  }

  /** Why there is nothing to show, when the runner cannot be reached. */
  setUnavailable(reason: string): void {
    this.#reason = reason;
    this.#status = null;
    this.#summaryEl.textContent = reason;
    this.#summaryEl.className = "activity-summary";
  }

  setStatus(status: RunnerStatus | null): void {
    this.#status = status;
    this.#renderSummary();
    this.#renderPrompt();
    if (status && (status.state === "running" || status.state === "paused") && !this.#open) this.setOpen(true);
  }

  setHistory(runs: Run[]): void {
    this.#history = runs;
    this.#renderHistory();
  }

  onEvent(ev: RunnerEvent): void {
    const line = describe(ev);
    if (line) this.#add(line.level, line.text);
    if (ev.type === "run.finished" && ev.run) {
      this.#history = [ev.run, ...this.#history.filter((r) => r.id !== ev.run!.id)].slice(0, 30);
      this.#renderHistory();
    }
    this.#renderSummary();
  }

  #add(level: Entry["level"], text: string): void {
    this.#entries.push({ t: Date.now(), level, text });
    if (this.#entries.length > MAX_ENTRIES) this.#entries.splice(0, this.#entries.length - MAX_ENTRIES);
    this.#renderEvents();
  }

  #renderEvents(): void {
    if (this.#entries.length === 0) {
      this.#eventsEl.replaceChildren(h("div", { class: "empty", text: "Nothing has happened since this window opened." }));
      return;
    }
    const rows = this.#entries.slice(-120).reverse().map((e) => h("div", { class: `activity-line ${e.level}` }, h("span", { class: "activity-time", text: clock(e.t) }), h("span", { text: e.text })));
    this.#eventsEl.replaceChildren(...rows);
  }

  #renderHistory(): void {
    if (this.#history.length === 0) {
      this.#historyEl.replaceChildren(h("div", { class: "empty", text: "No runs recorded yet." }));
      return;
    }
    const rows = this.#history.slice(0, 30).map((r) => {
      const took = duration(r);
      return h(
        "div",
        { class: `activity-line ${r.status === "succeeded" ? "ok" : r.status === "failed" ? "error" : "info"}` },
        h("span", { class: "activity-time", text: r.started_at ? clock(Date.parse(r.started_at)) : "" }),
        h("span", { text: `${r.mission} ${statusWord(r.status)}${took}${r.error ? ` — ${r.error}` : ""}` }),
      );
    });
    this.#historyEl.replaceChildren(...rows);
  }

  #renderSummary(): void {
    const status = this.#status;
    if (!status) {
      this.#summaryEl.textContent = this.#reason;
      this.#summaryEl.className = "activity-summary";
      return;
    }
    const run = status.run;
    if (run && (run.status === "running" || run.status === "paused")) {
      const step = run.step?.name ?? run.step?.id ?? "";
      this.#summaryEl.textContent = `${run.mission} is ${run.status === "paused" ? "paused" : "running"}${step ? ` at ${step}` : ""}.`;
      this.#summaryEl.className = "activity-summary running";
      return;
    }
    const last = this.#history[0];
    if (last) {
      this.#summaryEl.textContent = `${last.mission} ${statusWord(last.status)}${duration(last)}.`;
      this.#summaryEl.className = `activity-summary ${last.status === "succeeded" ? "ok" : last.status === "failed" ? "error" : ""}`;
      return;
    }
    const queued = status.queue?.length ?? 0;
    this.#summaryEl.textContent = queued > 0 ? `Nothing is running. ${queued} ${queued === 1 ? "run is" : "runs are"} waiting.` : "Nothing is running.";
    this.#summaryEl.className = "activity-summary";
  }

  #renderPrompt(): void {
    const prompt = this.#status?.prompt ?? null;
    if (!prompt) {
      this.#promptEl.hidden = true;
      this.#promptEl.replaceChildren();
      return;
    }
    const buttons = h("div", { class: "row buttons" });
    for (const option of prompt.options.length > 0 ? prompt.options : ["OK"]) {
      const btn = h("button", { class: option === prompt.default ? "primary" : "" }, h("span", { text: option }));
      btn.addEventListener("click", () => this.#host.answerPrompt(prompt.id, option));
      buttons.append(btn);
    }
    this.#promptEl.replaceChildren(h("div", { class: "prompt-text", text: prompt.text }), buttons);
    this.#promptEl.hidden = false;
    if (!this.#open) this.setOpen(true);
  }
}

function clock(ms: number): string {
  const d = new Date(ms);
  return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}:${String(d.getSeconds()).padStart(2, "0")}`;
}

function statusWord(status: string): string {
  switch (status) {
    case "succeeded":
      return "finished";
    case "failed":
      return "failed";
    case "canceled":
      return "was stopped";
    case "queued":
      return "is waiting";
    case "suspended":
      return "is suspended";
    case "paused":
      return "is paused";
    default:
      return status;
  }
}

function duration(run: Run): string {
  if (!run.started_at || !run.finished_at) return "";
  const s = (Date.parse(run.finished_at) - Date.parse(run.started_at)) / 1000;
  if (!Number.isFinite(s) || s < 0) return "";
  return ` after ${s < 60 ? `${s.toFixed(s < 10 ? 1 : 0)} s` : `${Math.round(s / 60)} min`}`;
}

/** One readable sentence for a runner event, or null for the noisy ones. */
function describe(ev: RunnerEvent): { level: Entry["level"]; text: string } | null {
  switch (ev.type) {
    case "run.queued":
      return ev.run ? { level: "info", text: `${ev.run.mission} joined the queue.` } : null;
    case "run.started":
      return ev.run ? { level: "info", text: `${ev.run.mission} started${ev.run.source?.detail ? ` (${ev.run.source.detail})` : ""}.` } : null;
    case "run.finished":
      if (!ev.run) return null;
      return { level: ev.run.status === "succeeded" ? "ok" : ev.run.status === "failed" ? "error" : "info", text: `${ev.run.mission} ${statusWord(ev.run.status)}${ev.run.error ? ` — ${ev.run.error}` : ""}.` };
    case "run.suspended":
      return ev.run ? { level: "warn", text: `${ev.run.mission} was suspended.` } : null;
    case "run.resumed":
      return ev.run ? { level: "info", text: `${ev.run.mission} carried on.` } : null;
    case "step.started":
      return { level: "info", text: `${ev.name || ev.step_id || "A step"} started${ev.step_type ? ` (${ev.step_type})` : ""}.` };
    case "step.finished": {
      const ok = ev.result?.ok !== false;
      return { level: ok ? "ok" : "error", text: `${ev.step_id ?? "A step"} ${ok ? "finished" : `failed — ${ev.result?.error ?? ev.result?.status ?? "no reason given"}`}.` };
    }
    case "log":
      return { level: ev.level === "error" ? "error" : ev.level === "warn" ? "warn" : "info", text: ev.text ?? "" };
    case "prompt":
      return ev.prompt ? { level: "warn", text: `The robot is asking: ${ev.prompt.text}` } : null;
    case "prompt.answered":
      return { level: "info", text: `Answered ${ev.answer ?? ""}.` };
    case "missions.changed":
      return { level: "info", text: "The missions on the robot changed." };
    case "sites.changed":
      return { level: "info", text: "The map data on the robot changed." };
    default:
      return null;
  }
}
