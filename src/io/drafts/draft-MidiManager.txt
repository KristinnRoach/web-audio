class WebMidiDemo {
  midiAcess: MIDIAccess | null = null;
  inputDevicesList = new MIDIInputMap();
  outputDevicesList = new MIDIOutputMap();
  selectedInputDevice: MIDIInput | null = null;
  selectedOutputDevice: MIDIOutput | null = null;

  constructor() {}

  async enableMIDIAcess() {
    try {
      const midiAccess = await navigator.requestMIDIAccess();
      this.onMIDISuccess(midiAccess);
    } catch (err) {
      this.onMIDIFailure(String(err));
    }
  }

  onMIDISuccess(midiAccess: MIDIAccess) {
    this.inputDevicesList = midiAccess.inputs;
    this.outputDevicesList = midiAccess.outputs;
  }

  onMIDIFailure(err: string) {
    console.warn(`Failed to get MIDI access - ${err}`);
  }

  onMidiInputPortSelected(selection: Event) {
    if (this.selectedInputDevice) {
      this.selectedInputDevice.close();
    }
    const selectedInputDeviceId = (selection.target as HTMLOptionElement).value;
    console.log('Input port', selectedInputDeviceId);
    this.selectedInputDevice = this.inputDevicesList.get(
      selectedInputDeviceId
    )!;
    this.selectedInputDevice.onmidimessage = this.handleMIDIMessage.bind(this);
  }

  onMidiOutputPortSelected(selection: Event) {
    if (this.selectedOutputDevice) {
      this.selectedOutputDevice.close();
    }
    const selectedOutputDeviceId = (selection.target as HTMLOptionElement)
      .value;
    console.log('Output port', selectedOutputDeviceId);
    this.selectedOutputDevice = this.outputDevicesList.get(
      selectedOutputDeviceId
    )!;
  }

  watchMidiInput(): void {
    if (this.midiAcess) {
      this.midiAcess.inputs.forEach((inputDevice) => {
        inputDevice.onmidimessage = (x) => this.handleMIDIMessage(x);
      });
    } else {
      console.warn(`MIDIAcess not initialized!`);
    }
  }

  handleMIDIMessage(event: MIDIMessageEvent) {
    if (!event.data || typeof event.data[Symbol.iterator] !== 'function') {
      console.error('Invalid MIDI message data');
      return;
    }
    const [action, keyId, velocity] = event.data;
    console.log([action, keyId, velocity]);
    if (action === 144) {
      // Handle note on event
    }
  }
}
