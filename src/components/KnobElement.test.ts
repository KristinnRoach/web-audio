// @vitest-environment jsdom
import { describe, it, expect, vi } from "vite-plus/test";
import { KnobElement } from "./KnobElement";

customElements.define("knob-element", KnobElement);

function createKnob(attrs: Record<string, string>): KnobElement {
  const el = document.createElement("knob-element") as KnobElement;
  Object.entries(attrs).forEach(([k, v]) => el.setAttribute(k, v));
  return el;
}

describe("KnobElement init", () => {
  it("initializes to default synchronously on connect", () => {
    const knob = createKnob({
      "min-value": "0",
      "max-value": "100",
      "default-value": "25",
    });
    document.body.appendChild(knob);
    expect(knob.getValue()).toBe(25);
  });

  it("tags programmatic changes in knob-change detail", () => {
    const knob = createKnob({
      "min-value": "0",
      "max-value": "100",
      "default-value": "25",
    });
    document.body.appendChild(knob);
    let source: string | undefined;
    knob.addEventListener("knob-change", (e) => (source = e.detail.source));
    knob.setValue(50);
    expect(source).toBe("programmatic");
  });

  it("honors a default of 0 when min is non-zero", () => {
    const knob = createKnob({
      "min-value": "-50",
      "max-value": "50",
      "default-value": "0",
    });
    document.body.appendChild(knob);
    expect(knob.getValue()).toBe(0);
  });

  it("does not clobber a value set right after appendChild", () => {
    const knob = createKnob({
      "min-value": "0",
      "max-value": "100",
      "default-value": "25",
    });
    document.body.appendChild(knob);
    knob.setValue(80); // consumer restores persisted value
    expect(knob.getValue()).toBe(80);
  });

  it("becomes interactive after being initially disabled", () => {
    const knob = createKnob({
      "min-value": "0",
      "max-value": "100",
      "default-value": "25",
      disabled: "",
    });
    document.body.appendChild(knob);

    knob.setDisabled(false);
    knob.dispatchEvent(new MouseEvent("mousedown", { clientY: 100 }));
    document.dispatchEvent(new MouseEvent("mousemove", { clientY: 90 }));
    document.dispatchEvent(new MouseEvent("mouseup"));

    expect(knob.getValue()).toBeGreaterThan(25);
    expect(Number(knob.getAttribute("aria-valuenow"))).toBe(knob.getValue());
  });

  it("reports double-click resets as user changes", () => {
    const knob = createKnob({
      "min-value": "0",
      "max-value": "100",
      "default-value": "25",
    });
    document.body.appendChild(knob);
    knob.setValue(50);
    let source: string | undefined;
    knob.addEventListener("knob-change", (event) => (source = event.detail.source));
    const mouseDown = new MouseEvent("mousedown");
    const mouseUp = new MouseEvent("mouseup");
    const now = vi.spyOn(Date, "now").mockReturnValueOnce(1_000).mockReturnValueOnce(1_100);

    try {
      knob.dispatchEvent(mouseDown);
      document.dispatchEvent(mouseUp);
      knob.dispatchEvent(mouseDown);

      expect(knob.getValue()).toBe(25);
      expect(source).toBe("user");
    } finally {
      now.mockRestore();
    }
  });

  it("uses normal dragging when pointer lock is rejected", async () => {
    const originalRequest = Object.getOwnPropertyDescriptor(
      HTMLElement.prototype,
      "requestPointerLock",
    );
    const originalPointerLockElement = Object.getOwnPropertyDescriptor(
      document,
      "pointerLockElement",
    );
    const requestPointerLock = vi
      .fn()
      .mockRejectedValue(new DOMException("Pointer lock throttled"));

    Object.defineProperty(HTMLElement.prototype, "requestPointerLock", {
      configurable: true,
      value: requestPointerLock,
    });
    Object.defineProperty(document, "pointerLockElement", {
      configurable: true,
      value: null,
    });

    try {
      const knob = createKnob({
        "min-value": "0",
        "max-value": "100",
        "default-value": "25",
      });
      document.body.appendChild(knob);
      knob.dispatchEvent(new MouseEvent("mousedown", { clientY: 100 }));
      await Promise.resolve();
      document.dispatchEvent(new MouseEvent("mousemove", { clientY: 90 }));
      document.dispatchEvent(new MouseEvent("mouseup"));

      expect(requestPointerLock).toHaveBeenCalledOnce();
      expect(knob.getValue()).toBeGreaterThan(25);
    } finally {
      if (originalRequest) {
        Object.defineProperty(HTMLElement.prototype, "requestPointerLock", originalRequest);
      } else {
        delete (HTMLElement.prototype as Partial<HTMLElement>).requestPointerLock;
      }
      if (originalPointerLockElement) {
        Object.defineProperty(document, "pointerLockElement", originalPointerLockElement);
      } else {
        Reflect.deleteProperty(document, "pointerLockElement");
      }
    }
  });

  it("uses finer drag sensitivity when Shift is held at drag start", () => {
    const drag = (shiftKey: boolean) => {
      const knob = createKnob({
        "min-value": "0",
        "max-value": "100",
        "default-value": "50",
        "snap-increment": "0",
      });
      document.body.appendChild(knob);
      knob.dispatchEvent(new MouseEvent("mousedown", { clientY: 100, shiftKey }));
      document.dispatchEvent(new MouseEvent("mousemove", { clientY: 90, shiftKey }));
      document.dispatchEvent(new MouseEvent("mouseup"));
      return knob.getValue() - 50;
    };

    expect(drag(true)).toBeLessThan(drag(false) / 5);
  });

  it("switches drag sensitivity when Shift changes during a drag", () => {
    const knob = createKnob({
      "min-value": "0",
      "max-value": "100",
      "default-value": "50",
      "snap-increment": "0",
    });
    document.body.appendChild(knob);
    knob.dispatchEvent(new MouseEvent("mousedown", { clientY: 100 }));

    document.dispatchEvent(new MouseEvent("mousemove", { clientY: 90 }));
    const normalChange = knob.getValue() - 50;
    document.dispatchEvent(new MouseEvent("mousemove", { clientY: 80, shiftKey: true }));
    const fineChange = knob.getValue() - 50 - normalChange;
    document.dispatchEvent(new MouseEvent("mouseup"));

    expect(fineChange).toBeLessThan(normalChange / 5);
  });
});

describe("KnobElement keyboard controls", () => {
  it("exposes slider semantics and updates by snap increment as a user change", () => {
    const knob = createKnob({
      "min-value": "0",
      "max-value": "10",
      "default-value": "5",
      "snap-increment": "2",
    });
    document.body.appendChild(knob);
    let source: string | undefined;
    const bubbled = vi.fn();
    knob.addEventListener("knob-change", (event) => (source = event.detail.source));
    document.body.addEventListener("keydown", bubbled);

    const event = new KeyboardEvent("keydown", {
      key: "ArrowRight",
      bubbles: true,
      cancelable: true,
    });
    knob.dispatchEvent(event);

    expect(knob.getValue()).toBe(8);
    expect(source).toBe("user");
    expect(event.defaultPrevented).toBe(true);
    expect(bubbled).not.toHaveBeenCalled();
    expect(knob.getAttribute("role")).toBe("slider");
    expect(knob.getAttribute("aria-valuemin")).toBe("0");
    expect(knob.getAttribute("aria-valuemax")).toBe("10");
    expect(knob.getAttribute("aria-valuenow")).toBe("8");
    expect(knob.tabIndex).toBe(0);
    document.body.removeEventListener("keydown", bubbled);
  });

  it("moves to adjacent allowed values", () => {
    const knob = createKnob({
      "allowed-values": "[0, 5, 20]",
      "default-value": "5",
    });
    document.body.appendChild(knob);

    knob.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowUp" }));
    expect(knob.getValue()).toBe(20);

    knob.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowDown" }));
    expect(knob.getValue()).toBe(5);
  });

  it("uses one percent of the range when no positive snap increment is configured", () => {
    const knob = createKnob({
      "min-value": "0",
      "max-value": "10",
      "default-value": "5",
      "snap-increment": "0",
    });
    document.body.appendChild(knob);

    knob.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowLeft" }));

    expect(knob.getValue()).toBe(4.9);
  });

  it("supports Home and End", () => {
    const knob = createKnob({
      "min-value": "-10",
      "max-value": "10",
      "default-value": "0",
    });
    document.body.appendChild(knob);

    knob.dispatchEvent(new KeyboardEvent("keydown", { key: "End" }));
    expect(knob.getValue()).toBe(10);

    knob.dispatchEvent(new KeyboardEvent("keydown", { key: "Home" }));
    expect(knob.getValue()).toBe(-10);
  });

  it("is not focusable or keyboard-adjustable while disabled", () => {
    const knob = createKnob({
      "min-value": "0",
      "max-value": "10",
      "default-value": "5",
      disabled: "",
    });
    document.body.appendChild(knob);

    knob.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowRight" }));

    expect(knob.getValue()).toBe(5);
    expect(knob.tabIndex).toBe(-1);
    expect(knob.getAttribute("aria-disabled")).toBe("true");
  });
});
