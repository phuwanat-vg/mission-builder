/**
 * The form of an "Ask for an answer" step (`ros.request`).
 *
 * The generated forms would show the answers as comma-separated text and the
 * extra data as raw JSON; this one is written by hand because those two are
 * the parts a person edits most: the answers are a list with one row each,
 * the default is picked from them (or typed), and the data is key and value
 * rows whose values may be expressions. Underneath is the request exactly as
 * the robot publishes it, so the exchange is never a guess.
 */

import { h, row } from "./dom";
import { icon } from "./icons";
import type { FormContext } from "./ActionForm";
import { textInput } from "./ActionForm";
import type { Mission, Site, Step } from "../mission/types";
import { isRecord } from "../mission/types";
import { requestTopics, topicSourceText } from "../mission/requestTopics";
import type { EffectiveTopic } from "../mission/requestTopics";

export interface RequestFormContext extends FormContext {
  /** The mission the step belongs to, for the preview and the station default. */
  mission: Mission;
  /** Where the robot is when it asks, when no station is given: the last Follow route's destination. */
  stationDefault: string | null;
  /** The open map's points, whose request and answer topics a station may set. */
  points: Record<string, Site>;
}

const TYPED = "typed";

export function requestForm(step: Step, ctx: RequestFormContext, onChange: (key: string, value: unknown) => void): HTMLElement {
  const body = h("div", { class: "action-form request-form" });
  const str = (v: unknown): string => (typeof v === "string" ? v : "");

  // the question
  const text = h("textarea", { rows: 2, placeholder: "Is the part in place?" });
  text.value = str(step.text);
  text.addEventListener("change", () => onChange("text", text.value));
  body.append(row("Question", text));

  // the answers, one row each
  const options = Array.isArray(step.options) ? step.options.map(String) : [];
  const list = h("div", { class: "list-control" });
  options.forEach((option, i) => {
    const input = h("input", { type: "text", value: option });
    input.addEventListener("change", () => {
      const next = options.slice();
      const v = input.value.trim();
      if (v === "") next.splice(i, 1);
      else next[i] = v;
      onChange("options", next);
    });
    const del = h("button", { class: "icon-only danger", title: `Remove the answer ${option}` }, icon("close"));
    del.addEventListener("click", () => onChange("options", options.filter((_, j) => j !== i)));
    list.append(h("div", { class: "list-item" }, h("span", { class: "list-no", text: String(i + 1) }), input, del));
  });
  const adding = h("input", { type: "text", placeholder: options.length === 0 ? "Add an answer, e.g. OK" : "Add another answer" });
  const addBtn = h("button", { class: "icon-only", title: "Add this answer" }, icon("plus"));
  const add = (): void => {
    const v = adding.value.trim();
    if (v === "" || options.includes(v)) return;
    onChange("options", [...options, v]);
  };
  addBtn.addEventListener("click", add);
  adding.addEventListener("keydown", (ev) => {
    if (ev.key === "Enter") add();
  });
  list.append(h("div", { class: "list-item adder" }, adding, addBtn));
  if (options.length === 0) list.append(h("span", { class: "field-help", text: "No answers listed: any answer is accepted." }));
  body.append(row("Answers", list));

  // the default: one of the answers, or typed
  const dflt = str(step.default);
  const defaultWrap = h("div", { class: "pose-control" });
  const typed = h("input", { type: "text", value: dflt, placeholder: "The answer used on timeout" });
  typed.addEventListener("change", () => onChange("default", typed.value.trim() === "" ? undefined : typed.value.trim()));
  if (options.length > 0) {
    const sel = h("select");
    sel.appendChild(h("option", { value: "", text: "(no default)" }));
    for (const o of options) sel.appendChild(h("option", { value: o, text: o }));
    sel.appendChild(h("option", { value: TYPED, text: "Another answer…" }));
    const isTyped = dflt !== "" && !options.includes(dflt);
    sel.value = isTyped ? TYPED : dflt;
    typed.hidden = !isTyped;
    sel.addEventListener("change", () => {
      if (sel.value === TYPED) {
        typed.hidden = false;
        typed.focus();
        return;
      }
      onChange("default", sel.value === "" ? undefined : sel.value);
    });
    defaultWrap.append(sel, typed);
  } else {
    defaultWrap.append(typed);
  }
  body.append(row("Default answer", defaultWrap));

  // waiting
  const timeout = h("input", { type: "number", min: 0, step: 10, value: typeof step.timeout_s === "number" ? String(step.timeout_s) : "", placeholder: "(waits until answered)" });
  timeout.addEventListener("change", () => {
    const n = Number(timeout.value);
    onChange("timeout_s", timeout.value.trim() === "" || !Number.isFinite(n) || n <= 0 ? undefined : n);
  });
  body.append(row("Give up after (s)", timeout));
  const onTimeout = h("select");
  onTimeout.append(h("option", { value: "default", text: "Use the default answer" }), h("option", { value: "fail", text: "Fail the step" }));
  onTimeout.value = step.on_timeout === "fail" ? "fail" : "default";
  onTimeout.addEventListener("change", () => onChange("on_timeout", onTimeout.value));
  body.append(row("When nobody answers", onTimeout));

  // where the robot is
  const station = h("select");
  station.appendChild(h("option", { value: "", text: ctx.stationDefault ? `Where the last Follow route ends (${ctx.stationDefault})` : "Where the last Follow route ends" }));
  const current = str(step.station);
  for (const name of current !== "" && !ctx.siteNames.includes(current) ? [...ctx.siteNames, current] : ctx.siteNames) station.appendChild(h("option", { value: name, text: name }));
  station.value = current;
  station.addEventListener("change", () => onChange("station", station.value === "" ? undefined : station.value));
  body.append(row("Station", station));

  // the topics: empty uses the station's point, then the project's
  const topics = requestTopics(step, ctx.mission, ctx.points, ctx);
  const inherited = requestTopics(step, ctx.mission, ctx.points, ctx, true);
  const topicRow = (label: string, key: "request_topic" | "answer_topic", own: EffectiveTopic, fallback: EffectiveTopic): HTMLElement => {
    const input = textInput(str(step[key]), fallback.topic, (v) => onChange(key, v.trim() === "" ? undefined : v.trim()));
    input.classList.add("mono");
    const where = own.from === "step" ? `Set on this step. Left empty: ${fallback.topic} (${topicSourceText(fallback).toLowerCase()}).` : topicSourceText(own);
    return row(label, h("div", { class: "pose-control" }, input, h("span", { class: "field-help", text: where })));
  };
  body.append(topicRow("Request topic", "request_topic", topics.request, inherited.request), topicRow("Answer topic", "answer_topic", topics.answer, inherited.answer));

  // extra data, key and value rows
  const data = isRecord(step.data) ? step.data : {};
  const dataList = h("div", { class: "list-control" });
  const writeData = (entries: [string, unknown][]): void => {
    const next: Record<string, unknown> = {};
    for (const [k, v] of entries) if (k.trim() !== "") next[k.trim()] = v;
    onChange("data", Object.keys(next).length === 0 ? undefined : next);
  };
  const entries = Object.entries(data);
  entries.forEach(([key, value], i) => {
    const k = h("input", { type: "text", value: key, placeholder: "key", class: "kv-key-input" });
    const v = h("input", { type: "text", value: typeof value === "string" ? value : JSON.stringify(value), placeholder: "value or $expression", class: "mono" });
    k.addEventListener("change", () => writeData(entries.map(([ek, ev], j) => (j === i ? [k.value, ev] : [ek, ev]))));
    v.addEventListener("change", () => writeData(entries.map(([ek, ev], j) => (j === i ? [ek, parseLoose(v.value)] : [ek, ev]))));
    const del = h("button", { class: "icon-only danger", title: `Remove ${key}` }, icon("close"));
    del.addEventListener("click", () => writeData(entries.filter((_, j) => j !== i)));
    dataList.append(h("div", { class: "list-item" }, k, v, del));
  });
  const addData = h("button", {}, icon("plus"), "Add a value");
  addData.addEventListener("click", () => {
    let name = "key";
    for (let n = 2; name in data; n++) name = `key${n}`;
    writeData([...entries, [name, ""]]);
  });
  dataList.append(addData);
  body.append(row("Extra data", dataList));

  body.append(row("Name", textInput(str(step.name), "(step label)", (v) => onChange("name", v === "" ? undefined : v))));

  // what goes over the wire
  const request: Record<string, unknown> = { id: "(new for every run)", text: str(step.text), options };
  if (dflt !== "") request.default = dflt;
  if (typeof step.timeout_s === "number") request.timeout_s = step.timeout_s;
  const where = current !== "" ? current : ctx.stationDefault;
  if (where) request.station = where;
  request.source = "mission_runner";
  request.mission = ctx.mission.name;
  request.step_id = str(step.id);
  if (isRecord(step.data)) request.data = step.data;
  const requestTopic = topics.request.topic;
  const answerTopic = topics.answer.topic;
  const out = typeof step.out === "string" && step.out !== "" ? step.out : null;
  body.append(
    h("div", { class: "sub-title", text: `Published on ${requestTopic}` }),
    h("pre", { class: "export-text request-preview", text: JSON.stringify(request, null, 2) }),
    h("p", {
      class: "prose muted",
      text:
        `The answer comes back on ${answerTopic} as {"id", "answer", "by"} with the same id. iViz's Dashboard answers it out of the box; any node can too.` +
        (out ? ` A later If can read ${out}.value.answer.` : " Set 'Store the result in' below to use the answer in a later If."),
    }),
  );
  return body;
}

/** `42`, `true` and JSON become values; everything else, `$expressions` included, stays text. */
function parseLoose(text: string): unknown {
  const t = text.trim();
  if (t === "") return "";
  if (t === "true") return true;
  if (t === "false") return false;
  if (t === "null") return null;
  if (/^-?\d+(\.\d+)?$/.test(t)) return Number(t);
  if (t.startsWith("{") || t.startsWith("[")) {
    try {
      return JSON.parse(t) as unknown;
    } catch {
      return text;
    }
  }
  return text;
}
