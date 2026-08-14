// @vitest-environment jsdom
import { describe, it, expect, vi } from 'vitest';
import { KnobElement } from './KnobElement';

customElements.define('knob-element', KnobElement);

function createKnob(attrs: Record<string, string>): KnobElement {
  const el = document.createElement('knob-element') as KnobElement;
  Object.entries(attrs).forEach(([k, v]) => el.setAttribute(k, v));
  return el;
}

describe('KnobElement init', () => {
  it('initializes to default synchronously on connect', () => {
    const knob = createKnob({
      'min-value': '0',
      'max-value': '100',
      'default-value': '25',
    });
    document.body.appendChild(knob);
    expect(knob.getValue()).toBe(25);
  });

  it('tags programmatic changes in knob-change detail', () => {
    const knob = createKnob({
      'min-value': '0',
      'max-value': '100',
      'default-value': '25',
    });
    document.body.appendChild(knob);
    let source: string | undefined;
    knob.addEventListener('knob-change', (e) => (source = e.detail.source));
    knob.setValue(50);
    expect(source).toBe('programmatic');
  });

  it('honors a default of 0 when min is non-zero', () => {
    const knob = createKnob({
      'min-value': '-50',
      'max-value': '50',
      'default-value': '0',
    });
    document.body.appendChild(knob);
    expect(knob.getValue()).toBe(0);
  });

  it('does not clobber a value set right after appendChild', () => {
    const knob = createKnob({
      'min-value': '0',
      'max-value': '100',
      'default-value': '25',
    });
    document.body.appendChild(knob);
    knob.setValue(80); // consumer restores persisted value
    expect(knob.getValue()).toBe(80);
  });

  it('becomes interactive after being initially disabled', () => {
    const knob = createKnob({
      'min-value': '0',
      'max-value': '100',
      'default-value': '25',
      disabled: '',
    });
    document.body.appendChild(knob);

    knob.setDisabled(false);
    knob.dispatchEvent(new MouseEvent('mousedown', { clientY: 100 }));
    document.dispatchEvent(new MouseEvent('mousemove', { clientY: 90 }));
    document.dispatchEvent(new MouseEvent('mouseup'));

    expect(knob.getValue()).toBeGreaterThan(25);
  });

  it('uses normal dragging when pointer lock is rejected', async () => {
    const originalRequest = Object.getOwnPropertyDescriptor(
      HTMLElement.prototype,
      'requestPointerLock',
    );
    const originalPointerLockElement = Object.getOwnPropertyDescriptor(
      document,
      'pointerLockElement',
    );
    const requestPointerLock = vi
      .fn()
      .mockRejectedValue(new DOMException('Pointer lock throttled'));

    Object.defineProperty(HTMLElement.prototype, 'requestPointerLock', {
      configurable: true,
      value: requestPointerLock,
    });
    Object.defineProperty(document, 'pointerLockElement', {
      configurable: true,
      value: null,
    });

    try {
      const knob = createKnob({
        'min-value': '0',
        'max-value': '100',
        'default-value': '25',
      });
      document.body.appendChild(knob);
      knob.dispatchEvent(new MouseEvent('mousedown', { clientY: 100 }));
      await Promise.resolve();
      document.dispatchEvent(new MouseEvent('mousemove', { clientY: 90 }));
      document.dispatchEvent(new MouseEvent('mouseup'));

      expect(requestPointerLock).toHaveBeenCalledOnce();
      expect(knob.getValue()).toBeGreaterThan(25);
    } finally {
      if (originalRequest) {
        Object.defineProperty(
          HTMLElement.prototype,
          'requestPointerLock',
          originalRequest,
        );
      } else {
        delete (HTMLElement.prototype as Partial<HTMLElement>)
          .requestPointerLock;
      }
      if (originalPointerLockElement) {
        Object.defineProperty(
          document,
          'pointerLockElement',
          originalPointerLockElement,
        );
      } else {
        Reflect.deleteProperty(document, 'pointerLockElement');
      }
    }
  });
});
