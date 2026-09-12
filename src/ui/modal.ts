/**
 * Small dialogs over the whole window: a title, a body, an error line and a
 * row of buttons. Escape dismisses; Enter in a single-line field presses the
 * primary button. Keys typed inside never reach the application's shortcuts.
 */

import { h } from "./dom";
import { icon } from "./icons";
import type { IconName } from "./icons";

export interface ModalButton {
  label: string;
  icon?: IconName;
  kind?: "primary" | "danger";
  /** Return false (or a promise of false) to keep the dialog open. */
  run?: () => boolean | void | Promise<boolean | void>;
}

export interface ModalOptions {
  title: string;
  size?: "small" | "medium";
  content: (Node | string)[];
  buttons: ModalButton[];
  /** Escape, the backdrop, or a button without `run`. */
  onDismiss?: () => void;
}

export interface ModalHandle {
  element: HTMLElement;
  close(): void;
  /** A sentence under the body, or "" to clear it. */
  setError(text: string): void;
  /** Disable the buttons while something is in flight. */
  setBusy(busy: boolean): void;
  button(label: string): HTMLButtonElement | undefined;
}

export function openModal(opts: ModalOptions): ModalHandle {
  const error = h("p", { class: "modal-error" });
  error.hidden = true;
  const buttonRow = h("div", { class: "row buttons modal-buttons" }, h("div", { class: "spacer" }));
  const buttons = new Map<string, HTMLButtonElement>();
  const modal = h(
    "div",
    { class: `modal ${opts.size ?? "small"}`, role: "dialog" },
    h("div", { class: "modal-head" }, h("span", { class: "modal-title", text: opts.title })),
    h("div", { class: "modal-body" }, ...opts.content),
    error,
    buttonRow,
  );
  const backdrop = h("div", { class: "modal-backdrop" }, modal);
  let closed = false;

  const close = (): void => {
    if (closed) return;
    closed = true;
    backdrop.remove();
  };
  const dismiss = (): void => {
    close();
    opts.onDismiss?.();
  };

  let primary: HTMLButtonElement | null = null;
  for (const def of opts.buttons) {
    const btn = h("button", { class: def.kind ? `${def.kind}${def.kind === "primary" ? " solid" : ""}` : "" }, ...(def.icon ? [icon(def.icon)] : []), def.label);
    if (def.kind === "primary" && !primary) primary = btn;
    btn.addEventListener("click", () => {
      if (!def.run) {
        dismiss();
        return;
      }
      void Promise.resolve(def.run()).then((keep) => {
        if (keep !== false) close();
      });
    });
    buttons.set(def.label, btn);
    buttonRow.append(btn);
  }

  backdrop.addEventListener("keydown", (ev) => {
    ev.stopPropagation();
    if (ev.key === "Escape") {
      ev.preventDefault();
      dismiss();
    } else if (ev.key === "Enter" && ev.target instanceof HTMLInputElement && ev.target.type !== "checkbox" && primary && !primary.disabled) {
      ev.preventDefault();
      primary.click();
    }
  });
  backdrop.addEventListener("pointerdown", (ev) => {
    if (ev.target === backdrop) dismiss();
  });

  document.body.appendChild(backdrop);
  const first = modal.querySelector<HTMLElement>(".modal-body input:not([type=checkbox]), .modal-body textarea, .modal-body select");
  (first ?? primary ?? modal).focus();

  return {
    element: modal,
    close,
    setError(text: string): void {
      error.textContent = text;
      error.hidden = text === "";
    },
    setBusy(busy: boolean): void {
      for (const b of buttons.values()) b.disabled = busy;
    },
    button: (label) => buttons.get(label),
  };
}

export interface Choice<T extends string> {
  value: T;
  label: string;
  kind?: "primary" | "danger";
}

/** Ask a question with a few answers. Resolves null when it is dismissed. */
export function choose<T extends string>(title: string, sentences: string[], choices: Choice<T>[]): Promise<T | null> {
  return new Promise((resolve) => {
    let answered = false;
    openModal({
      title,
      content: sentences.map((s) => h("p", { class: "prose", text: s })),
      buttons: choices.map((c) => ({
        label: c.label,
        kind: c.kind,
        run: () => {
          answered = true;
          resolve(c.value);
        },
      })),
      onDismiss: () => {
        if (!answered) resolve(null);
      },
    });
  });
}

/** A labelled field for a dialog. */
export function field(label: string, control: HTMLElement, help?: string): HTMLElement {
  const wrap = h("label", { class: "field" }, h("span", { class: "field-label", text: label }), control);
  if (help) wrap.append(h("span", { class: "field-help", text: help }));
  return wrap;
}
