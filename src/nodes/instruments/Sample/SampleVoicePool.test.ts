import { describe, expect, it, vi } from "vite-plus/test";
import type { SampleVoice } from "./SampleVoice";
import type { SamplePlayer } from "./SamplePlayer";
import type { Message, MessageHandler } from "../../../events";
import { VoiceState } from "../VoiceState";

vi.mock("./createSampleVoice", () => {
  class TestVoice {
    state: VoiceState = VoiceState.LOADED;
    currMidiNote: number | null = null;
    handlers = new Map<string, MessageHandler<Message>[]>();

    onMessage(type: string, handler: MessageHandler<Message>) {
      this.handlers.set(type, [...(this.handlers.get(type) ?? []), handler]);
      return () => {};
    }

    emit(type: string) {
      if (type === "voice:started") this.state = VoiceState.PLAYING;
      if (type === "voice:releasing") this.state = VoiceState.RELEASING;
      this.handlers
        .get(type)
        ?.forEach((handler) =>
          handler({ type, senderId: "test", voice: this, midiNote: this.currMidiNote }),
        );
    }

    trigger({ midiNote }: { midiNote: number }): number | null {
      this.state = VoiceState.PLAYING;
      this.currMidiNote = midiNote;
      return midiNote;
    }

    release() {
      this.state = VoiceState.RELEASING;
      return this;
    }

    stop() {}
    setMasterGain() {}
    dispose() {}
  }

  return {
    createSampleVoices: async (numVoices: number) =>
      Array.from({ length: numVoices }, () => new TestVoice()),
  };
});

// Deliver acknowledgements explicitly so regressions do not depend on timing.
function acknowledge(voice: SampleVoice, type: string) {
  (voice as unknown as { emit(type: string): void }).emit(type);
}

describe("SampleVoicePool note ownership", () => {
  async function setup(polyphony = 4) {
    const { SampleVoicePool } = await import("./SampleVoicePool");
    const pool = new SampleVoicePool({} as AudioContext, polyphony);
    await pool.init();
    return pool;
  }

  it("releases the previous same-pitch voice and routes note-off to its replacement", async () => {
    const pool = await setup();
    pool.noteOn(60);
    const first = pool.assignedVoicesMidiMap.get(60)!;
    acknowledge(first, "voice:started");
    const release = vi.spyOn(first, "release");

    pool.noteOn(60, 100, 0.2);
    const second = pool.assignedVoicesMidiMap.get(60)!;
    expect(second).not.toBe(first);
    expect(release).toHaveBeenCalledWith({ secondsFromNow: 0.2 });
    expect(first.state).toBe(VoiceState.RELEASING);
    acknowledge(second, "voice:started");
    pool.noteOff(60);
    expect(second.state).toBe(VoiceState.RELEASING);
    pool.dispose();
  });

  it.each([true, false])(
    "keeps the replacement assigned despite delayed acknowledgements (new first: %s)",
    async (newFirst) => {
      const pool = await setup();
      pool.noteOn(60);
      const first = pool.assignedVoicesMidiMap.get(60)!;
      pool.noteOff(60);
      pool.noteOn(60);
      const second = pool.assignedVoicesMidiMap.get(60)!;

      if (newFirst) acknowledge(second, "voice:started");
      acknowledge(first, "voice:started");
      acknowledge(first, "voice:releasing");
      expect(pool.assignedVoicesMidiMap.get(60)).toBe(second);
      pool.noteOff(60);
      expect(second.state).toBe(VoiceState.RELEASING);
      pool.dispose();
    },
  );

  it("keeps the previous voice when the replacement fails to trigger", async () => {
    const pool = await setup();
    pool.noteOn(60);
    const first = pool.assignedVoicesMidiMap.get(60)!;
    pool.availableVoices.forEach((voice) => vi.spyOn(voice, "trigger").mockReturnValue(null));

    expect(pool.noteOn(60)).toBeNull();
    expect(pool.assignedVoicesMidiMap.get(60)).toBe(first);
    expect(first.state).toBe(VoiceState.PLAYING);
    pool.dispose();
  });

  it("allNotesOff reaches unmapped playing and releasing voices, but skips idle voices", async () => {
    const pool = await setup();
    pool.noteOn(60);
    pool.noteOn(62);
    const playing = pool.assignedVoicesMidiMap.get(60)!;
    const releasing = pool.assignedVoicesMidiMap.get(62)!;
    pool.noteOff(62);
    const playingRelease = vi.spyOn(playing, "release");
    const releasingRelease = vi.spyOn(releasing, "release");
    const idleReleases = [...pool.availableVoices].map((voice) => vi.spyOn(voice, "release"));
    pool.assignedVoicesMidiMap.clear();

    pool.allNotesOff();

    expect(playingRelease).toHaveBeenCalledWith({ releaseTime: 0 });
    expect(releasingRelease).toHaveBeenCalledWith({ releaseTime: 0 });
    idleReleases.forEach((release) => expect(release).not.toHaveBeenCalled());
    expect(pool.assignedVoicesMidiMap.size).toBe(0);
    pool.dispose();
  });
});

describe("SampleVoicePool.init", () => {
  // Pins the invariant SamplePlayer.setPitchEnabled / setPlaybackDirection rely on:
  // the full fixed pool exists once init() resolves, so fan-out at call time reaches
  // every voice. If polyphony ever becomes lazy or resizable, those setters must
  // re-apply their state to voices created later.
  it("allocates the whole pool before resolving", async () => {
    const { SampleVoicePool } = await import("./SampleVoicePool");
    const pool = new SampleVoicePool({} as AudioContext, 16);

    await pool.init();

    expect(pool.allVoices).toHaveLength(16);
  });
});

describe("SamplePlayer.setPitchEnabled", () => {
  it("fans out to every voice", async () => {
    vi.stubGlobal("window", {});
    vi.stubGlobal("AudioContext", class {});
    vi.stubGlobal("AudioWorkletNode", class {});
    const { SamplePlayer } = await import("./SamplePlayer");

    const voices = [0, 1, 2].map(() => ({
      enablePitch: vi.fn(),
      disablePitch: vi.fn(),
    }));
    const player = {
      voicePool: { allVoices: voices as unknown as SampleVoice[] },
    } as unknown as SamplePlayer;

    SamplePlayer.prototype.setPitchEnabled.call(player, true);
    voices.forEach((v) => expect(v.enablePitch).toHaveBeenCalledTimes(1));

    SamplePlayer.prototype.setPitchEnabled.call(player, false);
    voices.forEach((v) => expect(v.disablePitch).toHaveBeenCalledTimes(1));
  });
});
