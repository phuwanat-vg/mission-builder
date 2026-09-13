/**
 * Which topics an "Ask for an answer" step (`ros.request`) uses.
 *
 * Every station can have its own pair, so each station's screen or node only
 * receives its own questions. Each of the two topics is picked on its own, in
 * this order, the same as mission_runner:
 *
 * 1. the step's own `request_topic` / `answer_topic`;
 * 2. the topics on the point named by the step's station (`station`, or when
 *    it has none the destination of the last Follow route before it);
 * 3. the project's settings (by default `/iviz/request` and `/iviz/answer`).
 */

import type { Mission, Site, Step } from "./types";
import { DEFAULT_ANSWER_TOPIC, DEFAULT_REQUEST_TOPIC } from "./types";
import { walkSteps } from "./ids";
import { hasExpression } from "./expressions";

/** The project's request and answer topics, used when nothing closer names one. */
export interface TopicDefaults {
  requestTopic: string;
  answerTopic: string;
}

export const DEFAULT_TOPICS: TopicDefaults = { requestTopic: DEFAULT_REQUEST_TOPIC, answerTopic: DEFAULT_ANSWER_TOPIC };

export interface EffectiveTopic {
  topic: string;
  /** Where the topic comes from. */
  from: "step" | "point" | "project";
  /** The point it comes from, when `from` is "point". */
  point?: string;
}

export interface RequestTopics {
  request: EffectiveTopic;
  answer: EffectiveTopic;
  /** The station the step asks at, when it is known before running. */
  station: string | null;
}

const nonEmpty = (v: unknown): v is string => typeof v === "string" && v !== "";

/** The destination of the last Follow route before `step`, in document order. */
export function lastRouteSiteBefore(mission: Mission, step: Step): string | null {
  let last: string | null = null;
  for (const visit of walkSteps(mission)) {
    if (visit.step === step) break;
    if (visit.step.type === "nav.follow_route" && nonEmpty(visit.step.to)) last = visit.step.to;
  }
  return last;
}

/** The station a request asks at: its own, or where the last Follow route ends. Null when only known at run time. */
export function requestStation(step: Step, mission: Mission | null): string | null {
  const own = nonEmpty(step.station) ? step.station : mission ? lastRouteSiteBefore(mission, step) : null;
  return own === null || hasExpression(own) ? null : own;
}

/**
 * The topics a `ros.request` step publishes and listens on. `ignoreOwn` leaves
 * the step's own topic fields out, giving what an empty field falls back to.
 * (Pass the step itself, not a copy: its station default is found by identity.)
 */
export function requestTopics(step: Step, mission: Mission | null, points: Record<string, Site>, defaults: TopicDefaults, ignoreOwn = false): RequestTopics {
  const station = requestStation(step, mission);
  const site = station !== null ? points[station] : undefined;
  const pick = (own: unknown, onSite: unknown, fallback: string): EffectiveTopic => {
    if (!ignoreOwn && nonEmpty(own)) return { topic: own, from: "step" };
    if (station !== null && nonEmpty(onSite)) return { topic: onSite, from: "point", point: station };
    return { topic: fallback, from: "project" };
  };
  return {
    request: pick(step.request_topic, site?.request_topic, defaults.requestTopic),
    answer: pick(step.answer_topic, site?.answer_topic, defaults.answerTopic),
    station,
  };
}

/** Where a topic comes from, as the line under its field says it. */
export function topicSourceText(t: EffectiveTopic): string {
  if (t.from === "step") return "Set on this step";
  if (t.from === "point") return `From point ${t.point ?? ""}`;
  return "Project default";
}

/** The pair suggested for a point: `/station/<name>/request` and `/answer`, the name lowercased with anything but a-z, 0-9 and _ turned into _. */
export function suggestedTopics(pointName: string): { request: string; answer: string } {
  const slug = pointName.toLowerCase().replace(/[^a-z0-9_]/g, "_");
  return { request: `/station/${slug}/request`, answer: `/station/${slug}/answer` };
}

/**
 * A short note for summaries when a request does not use the project's
 * topics, e.g. "on /station/conveyor1/request"; "" when it does.
 */
export function topicNote(topics: RequestTopics, defaults: TopicDefaults): string {
  const req = topics.request.topic !== defaults.requestTopic;
  const ans = topics.answer.topic !== defaults.answerTopic;
  if (req) return `on ${topics.request.topic}`;
  if (ans) return `answer on ${topics.answer.topic}`;
  return "";
}
