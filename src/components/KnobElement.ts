export type KnobElementOptions = {
  minValue: number;
  maxValue: number;
  defaultValue: number;
  minRotation: number;
  maxRotation: number;
  snapIncrement: number;
  allowedValues?: number[];
  curve?: number;
  snapThresholds?: Array<{ maxValue: number; increment: number }>;
  disabled?: boolean;
  borderStyle?: "currentState" | "fullCircle";
  width?: number;
  height?: number;
  color?: string;
  value?: number; // initial value (if different from default)
};

export type KnobChangeEventDetail = {
  value: number;
  rotation: number;
  percentage: number;
  source: "user" | "programmatic";
};

declare global {
  interface HTMLElementEventMap {
    "knob-change": CustomEvent<KnobChangeEventDetail>;
  }
}

export class KnobElement extends HTMLElement {
  private pathElement!: SVGPathElement;

  private static stylesInjected = false;

  private config: KnobElementOptions = {
    minValue: 0,
    maxValue: 100,
    defaultValue: 0,
    minRotation: -170,
    maxRotation: 170,
    snapIncrement: 1,
    curve: 1,
    disabled: false,
    borderStyle: "currentState",
  };

  private currentValue: number = 0;
  private currentRotation: number = 0;
  private rotationToValue!: (rotation: number) => number;
  private valueToRotation!: (value: number) => number;
  private applySnapping!: (value: number) => number;

  private static mapRange(
    inMin: number,
    inMax: number,
    outMin: number,
    outMax: number,
    value: number,
  ): number {
    if (inMax === inMin) return outMin;
    return ((value - inMin) * (outMax - outMin)) / (inMax - inMin) + outMin;
  }

  private static clamp(value: number, min: number, max: number): number {
    return Math.min(Math.max(value, min), max);
  }

  // Observed attributes
  static get observedAttributes(): string[] {
    return [
      "min-value",
      "max-value",
      "default-value",
      "min-rotation",
      "max-rotation",
      "snap-increment",
      "allowed-values",
      "value",
      "disabled",
      "width",
      "height",
      "border-style",
      "curve",
      "color",
    ];
  }

  constructor() {
    super();
  }

  connectedCallback(): void {
    this.injectGlobalStyles();
    this.createUtilityFunctions();
    this.render();
    this.updateColorFromAttribute();

    // Initialize before wiring interactions. ?? (not ||) honors a default of 0.
    this.setValue(this.config.defaultValue ?? this.config.minValue);

    this.createDraggable();
  }

  disconnectedCallback(): void {
    this.cleanup();
  }

  attributeChangedCallback(name: string, oldValue: string, newValue: string): void {
    if (oldValue !== newValue) {
      // Handle min/max changes BEFORE updating config
      if (name === "max-value" || name === "min-value") {
        const oldMin = this.config.minValue;
        const oldMax = this.config.maxValue;

        // Update config first
        this.updateConfigFromAttributes();
        this.updateBorder();

        // Scale current value from old range to new range
        let scaledValue: number;

        if (name === "max-value") {
          scaledValue = KnobElement.mapRange(
            oldMin, // old min
            parseFloat(oldValue), // old max
            this.config.minValue, // new min
            this.config.maxValue, // new max
            this.currentValue,
          );
        } else {
          scaledValue = KnobElement.mapRange(
            parseFloat(oldValue), // old min
            oldMax, // old max
            this.config.minValue, // new min
            this.config.maxValue, // new max
            this.currentValue,
          );
        }

        // Clamp to new bounds and update visually
        this.createUtilityFunctions();
        this.setValue(scaledValue); // This will clamp and update visuals

        return;
      }

      // Handle other attributes normally
      this.updateConfigFromAttributes();
      this.updateBorder();

      if (name === "width" || name === "height") return;
      if (name === "border-style") return;

      if (name === "color") {
        this.updateColorFromAttribute();
        return;
      }

      if (name === "curve") {
        this.createUtilityFunctions();
        this.setValue(this.currentValue); // Refresh with new curve
        return;
      }
    }
  }

  private injectGlobalStyles(): void {
    if (KnobElement.stylesInjected) return;

    const styleElement = document.createElement("style");
    styleElement.id = "knob-element-styles";
    styleElement.textContent = `
      knob-element {
        display: block;
        box-sizing: border-box;
        --knob-size: 120px;
        --knob-stroke: rgb(234, 234, 234);

        width: var(--knob-size, 120px); 
        height: var(--knob-size, 120px);

        touch-action: none; /* Prevents browser touch gestures */
        user-select: none; /* Prevents text selection during drag */
        border-radius: 50%;
        cursor: grab;
      }
      
      knob-element[disabled] {
        opacity: 0.5;
        pointer-events: none; 
      }
    
      knob-element:active {
        cursor: grabbing;
      }
    `;

    document.head.appendChild(styleElement);
    KnobElement.stylesInjected = true;
  }

  private updateConfigFromAttributes(): void {
    const getNumericValue = (attr: string, defaultValue: number): number => {
      const value = this.getAttribute(attr);
      return value !== null ? parseFloat(value) : defaultValue;
    };

    const getStringValue = <T extends string>(attr: string, defaultValue: T): T => {
      return (this.getAttribute(attr) as T) || defaultValue;
    };

    const getJsonValue = <T>(attr: string): T | undefined => {
      const value = this.getAttribute(attr);
      if (!value) return undefined;

      try {
        return JSON.parse(value);
      } catch (e) {
        console.warn(`KnobElement: Invalid ${attr} JSON:`, value);
        return undefined;
      }
    };

    // Get allowedValues first to potentially override min/max
    const allowedValues = getJsonValue<number[]>("allowed-values");
    let minValue = getNumericValue("min-value", 0);
    let maxValue = getNumericValue("max-value", 100);

    // If allowedValues are provided, sort them and set min/max automatically
    if (allowedValues && allowedValues.length > 0) {
      const sortedValues = [...allowedValues].sort((a, b) => a - b);
      const autoMinValue = sortedValues[0];
      const autoMaxValue = sortedValues[sortedValues.length - 1];

      // Log if manually set min/max/snap don't match allowedValues
      if (this.hasAttribute("min-value") && minValue !== autoMinValue) {
        console.debug(
          `KnobElement: min-value (${minValue}) doesn't match first allowedValue (${autoMinValue}). Using ${autoMinValue}.`,
        );
      }
      if (this.hasAttribute("max-value") && maxValue !== autoMaxValue) {
        console.debug(
          `KnobElement: max-value (${maxValue}) doesn't match last allowedValue (${autoMaxValue}). Using ${autoMaxValue}.`,
        );
      }
      if (this.hasAttribute("snap-thresholds")) {
        console.debug("KnobElement: allowedValues overrides snap-increment and snap-thresholds.");
      }

      minValue = autoMinValue;
      maxValue = autoMaxValue;
    }

    this.config = {
      minValue,
      maxValue,
      defaultValue: getNumericValue("default-value", 0),
      minRotation: getNumericValue("min-rotation", -150),
      maxRotation: getNumericValue("max-rotation", 150),
      snapIncrement: getNumericValue("snap-increment", 1),
      curve: getNumericValue("curve", 1),

      borderStyle: getStringValue<"currentState" | "fullCircle">("border-style", "currentState"),

      allowedValues: allowedValues ? [...allowedValues].sort((a, b) => a - b) : undefined,

      snapThresholds:
        getJsonValue<Array<{ maxValue: number; increment: number }>>("snap-thresholds"),
      disabled: this.hasAttribute("disabled"),
    };

    this.updateDimensions();
  }

  private updateDimensions(): void {
    const width = this.getAttribute("width");
    const height = this.getAttribute("height");

    if (width || height) {
      const size = width || height || "120";
      this.style.setProperty("--knob-size", `${size}px`);
    }
  }

  private updateColorFromAttribute(): void {
    const color = this.getAttribute("color");
    if (color) {
      this.style.setProperty("--knob-stroke", color);
    }
  }

  private render(): void {
    this.innerHTML = `
      <svg class="ac-knob" width="100%" height="100%" viewBox="0 0 100 100">
          <path class="knob-path" 
                fill="none" 
                stroke="var(--knob-stroke)" 
                stroke-width="5" 
                stroke-linecap="round"
                stroke-linejoin="round"
                d="M50,50 L50,2"
                />
      </svg>
  `;
    this.pathElement = this.querySelector(".knob-path") as SVGPathElement;
  }

  private cleanup(): void {
    if (this.dragHandlers) {
      this.removeEventListener("mousedown", this.dragHandlers.start);
      this.removeEventListener("touchstart", this.dragHandlers.start);
      document.removeEventListener("mousemove", this.dragHandlers.move);
      document.removeEventListener("mouseup", this.dragHandlers.end);
      document.removeEventListener("touchmove", this.dragHandlers.move);
      document.removeEventListener("touchend", this.dragHandlers.end);
    }
  }

  private createUtilityFunctions(): void {
    // Exponential factor
    const curve = this.config.curve || 1; // 1 = linear, 2 = quadratic, etc.

    this.rotationToValue = (rotation: number) => {
      const normalizedRotation = KnobElement.mapRange(
        this.config.minRotation,
        this.config.maxRotation,
        0,
        1,
        rotation,
      );

      // Apply exponential curve
      const curvedValue = Math.pow(normalizedRotation, curve);

      const value = KnobElement.mapRange(
        0,
        1,
        this.config.minValue,
        this.config.maxValue,
        curvedValue,
      );

      return value;
    };

    this.valueToRotation = (value: number) => {
      const normalizedValue = KnobElement.mapRange(
        this.config.minValue,
        this.config.maxValue,
        0,
        1,
        value,
      );

      const curvedRotation = Math.pow(normalizedValue, 1 / curve);

      return KnobElement.mapRange(
        0,
        1,
        this.config.minRotation,
        this.config.maxRotation,
        curvedRotation,
      );
    };

    this.applySnapping = (value: number): number => {
      // If allowedValues is specified, snap to the nearest allowed value
      if (this.config.allowedValues && this.config.allowedValues.length > 0) {
        return this.config.allowedValues.reduce((closest, current) => {
          return Math.abs(current - value) < Math.abs(closest - value) ? current : closest;
        });
      }

      if (this.config.snapIncrement <= 0) return value;

      let snapIncrement = this.config.snapIncrement;

      if (this.config.snapThresholds) {
        // Find the right increment for current value
        for (const { maxValue, increment } of this.config.snapThresholds) {
          if (value < maxValue) {
            snapIncrement = increment;
            break;
          }
        }
      }

      return Math.round(value / snapIncrement) * snapIncrement;
    };
  }

  private dragHandlers?: {
    start: (e: MouseEvent | TouchEvent) => void;
    move: (e: MouseEvent | TouchEvent) => void;
    end: () => void;
  };

  private lastClickTime = 0;
  private readonly DOUBLE_CLICK_THRESHOLD = 300;

  // TODO(audiolib): Add keyboard controls and slider ARIA semantics in the planned accessibility pass.
  private createDraggable(): void {
    const pointerLockSupported =
      "pointerLockElement" in document && "requestPointerLock" in HTMLElement.prototype;

    let isDragging = false;
    let startY = 0;
    let startRotation = 0;
    let totalDeltaY = 0;
    let isUsingPointerLock = false;

    const requestPointerLockOrUseDragFallback = (event: MouseEvent) => {
      startY = event.clientY;
      isUsingPointerLock = document.pointerLockElement === this;

      if (!pointerLockSupported || document.pointerLockElement) return;

      void this.requestPointerLock().then(
        () => {
          isUsingPointerLock = document.pointerLockElement === this;
        },
        () => {
          isUsingPointerLock = false;
        },
      );
    };

    const handleStart = (e: MouseEvent | TouchEvent) => {
      // Checked per-interaction so toggling `disabled` works after creation.
      if (this.config.disabled) return;

      const now = Date.now();
      const timeDiff = now - this.lastClickTime;

      // Check for double-click BEFORE starting drag or pointer lock
      if (timeDiff < this.DOUBLE_CLICK_THRESHOLD && timeDiff > 0) {
        this.resetToDefault();
        return; // Exit early, don't start dragging
      }

      this.lastClickTime = now;

      isDragging = true;
      startRotation = this.currentRotation;
      totalDeltaY = 0;

      const isTouchEvent = "touches" in e;

      if (isTouchEvent) {
        startY = e.touches[0].clientY;
        isUsingPointerLock = false;
      } else {
        requestPointerLockOrUseDragFallback(e as MouseEvent);
      }
    };

    const handleMove = (e: MouseEvent | TouchEvent) => {
      if (!isDragging) return;

      let deltaY: number;
      const sensitivity = 2.0;

      if (isUsingPointerLock && document.pointerLockElement) {
        // Use movementY for pointer lock (more precise)
        totalDeltaY += (e as MouseEvent).movementY;
        deltaY = -totalDeltaY * sensitivity;
      } else {
        // Use clientY for touch and fallback mouse
        const currentY = "touches" in e ? e.touches[0].clientY : (e as MouseEvent).clientY;
        deltaY = (startY - currentY) * sensitivity;
      }

      const newRotation = startRotation + deltaY;
      const clampedRotation = KnobElement.clamp(
        newRotation,
        this.config.minRotation,
        this.config.maxRotation,
      );

      const rawValue = this.rotationToValue(clampedRotation);
      const snappedValue = this.applySnapping(rawValue);

      this.currentValue = snappedValue;

      if (snappedValue !== rawValue) {
        this.currentRotation = this.valueToRotation(snappedValue);
      } else {
        this.currentRotation = clampedRotation;
      }

      this.updateBorder();
      this.dispatchChangeEvent("user");
      e.preventDefault();
    };

    const handleEnd = () => {
      isDragging = false;

      if (isUsingPointerLock && document.pointerLockElement) {
        document.exitPointerLock();
      }

      isUsingPointerLock = false;
    };

    // Store references for cleanup
    this.dragHandlers = {
      start: handleStart,
      move: handleMove,
      end: handleEnd,
    };

    // Event listeners
    this.addEventListener("mousedown", handleStart);
    this.addEventListener("touchstart", handleStart, { passive: false });

    document.addEventListener("mousemove", handleMove);
    document.addEventListener("mouseup", handleEnd);
    document.addEventListener("touchmove", handleMove, { passive: false });
    document.addEventListener("touchend", handleEnd);
  }

  private updateBorder(): void {
    if (!this.pathElement) return;

    const borderStyle = this.getAttribute("border-style") || "currentState";

    if (borderStyle === "currentState") {
      const r = 48;
      const cx = 50;
      const cy = 50;

      const startAngle = ((this.config.minRotation - 90) * Math.PI) / 180;
      const currentAngle = ((this.currentRotation - 90) * Math.PI) / 180;

      const startX = r * Math.cos(startAngle) + cx;
      const startY = r * Math.sin(startAngle) + cy;
      const endX = r * Math.cos(currentAngle) + cx;
      const endY = r * Math.sin(currentAngle) + cy;

      const totalAngle = this.currentRotation - this.config.minRotation;
      const largeArc = Math.abs(totalAngle) > 180 ? 1 : 0;

      const pathData = `M${cx},${cy} L${startX},${startY} A${r},${r},0,${largeArc},1,${endX},${endY} Z`;
      this.pathElement.setAttribute("d", pathData);
    } else {
      this.pathElement.setAttribute("d", `M50,2 A48,48,0,1,1,49.9,2 Z`);
    }
  }

  private dispatchChangeEvent(source: "user" | "programmatic" = "programmatic"): void {
    const percentage = KnobElement.mapRange(
      this.config.minValue,
      this.config.maxValue,
      0,
      100,
      this.currentValue,
    );

    const event = new CustomEvent<KnobChangeEventDetail>("knob-change", {
      detail: {
        value: this.currentValue,
        rotation: this.currentRotation,
        percentage,
        source,
      },
      bubbles: true,
    });

    this.dispatchEvent(event);
  }

  // Public API
  public setValue(value: number): void {
    // todo: animate?: boolean
    if (!this.valueToRotation || !this.pathElement) return;

    this.currentValue = KnobElement.clamp(value, this.config.minValue, this.config.maxValue);

    this.currentRotation = this.valueToRotation(this.currentValue);

    this.updateBorder();
    this.dispatchChangeEvent();
  }

  /**
   * Sets the knob value using a normalized 0-1 input, automatically handling
   * the knob's range and curve transformation.
   * @param normalizedValue - Value between 0 and 1
   */
  public setValueNormalized(normalizedValue: number): void {
    const { minRotation, maxRotation } = this.config;

    const clamped = Math.max(0, Math.min(1, normalizedValue));

    // Follow mouse handler pattern: normalizedValue → rotation → value
    const rotation = minRotation + clamped * (maxRotation - minRotation);
    const value = this.rotationToValue(rotation);

    this.setValue(value);
  }

  /**
   * Gets the current knob value as a normalized 0-1 value, accounting for
   * the knob's range and curve. Inverse of setValueNormalized().
   * @returns Normalized value between 0 and 1
   */
  public getValueNormalized(): number {
    return (
      (this.currentRotation - this.config.minRotation) /
      (this.config.maxRotation - this.config.minRotation)
    );
  }

  public resetToDefault(): void {
    // animate: boolean = false
    this.setValue(this.config.defaultValue);
  }

  public getValue(): number {
    return this.currentValue;
  }

  public setCurve(curve: number): void {
    this.config.curve = curve;
    this.createUtilityFunctions();
    // Refresh the current value to apply the new curve
    this.setValue(this.currentValue);
  }

  public getCurve(): number {
    return this.config.curve || 1;
  }

  public setDisabled(disabled: boolean): void {
    if (disabled) {
      this.setAttribute("disabled", "");
    } else {
      this.removeAttribute("disabled");
    }
  }

  public isDisabled(): boolean {
    return this.hasAttribute("disabled");
  }

  public getPercentage(): number {
    return KnobElement.mapRange(
      this.config.minValue,
      this.config.maxValue,
      0,
      100,
      this.currentValue,
    );
  }

  // Property getters/setters for easier JS usage
  get value(): number {
    return this.getValue();
  }

  set value(val: number) {
    this.setValue(val);
  }

  get disabled(): boolean {
    return this.isDisabled();
  }

  set disabled(val: boolean) {
    this.setDisabled(val);
  }
}

export default KnobElement;
