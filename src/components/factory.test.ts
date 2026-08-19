// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { KnobElement } from "./KnobElement";
import { registerKnobElement } from "./factory";

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("registerKnobElement", () => {
  it("registers KnobElement once", () => {
    const definitions = new Map<string, CustomElementConstructor>();
    const define = vi.fn((name: string, constructor: CustomElementConstructor) => {
      definitions.set(name, constructor);
    });

    vi.stubGlobal("customElements", {
      define,
      get: (name: string) => definitions.get(name),
    });

    registerKnobElement();
    registerKnobElement();

    expect(define).toHaveBeenCalledOnce();
    expect(define).toHaveBeenCalledWith("knob-element", KnobElement);
  });
});
