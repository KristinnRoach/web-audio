import { KnobElement } from './KnobElement';

const ELEMENTS = { KNOB: 'knob-element' } as const;

export type AudiolibElement = (typeof ELEMENTS)[keyof typeof ELEMENTS];

export function defineElement(
  tagName: AudiolibElement,
  elementClass: CustomElementConstructor,
) {
  if (typeof customElements === 'undefined') return;
  if (!customElements.get(tagName)) {
    customElements.define(tagName, elementClass);
  }
}

export function registerKnobElement(): void {
  defineElement(ELEMENTS.KNOB, KnobElement);
}
