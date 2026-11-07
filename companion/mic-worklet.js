// The phone's microphone, sample by sample, for talking to the Orchestrator. The page gathers
// what this posts, makes it 16 kHz mono, and the computer's whisper turns it into words.

const BATCH = 4096;

class VibeForgeMic extends AudioWorkletProcessor {
  constructor() {
    super();
    this.batch = new Float32Array(BATCH);
    this.filled = 0;
  }

  process(inputs) {
    const channel = inputs[0] && inputs[0][0];
    if (channel) {
      for (let i = 0; i < channel.length; i += 1) {
        this.batch[this.filled] = channel[i];
        this.filled += 1;
        if (this.filled === BATCH) {
          this.port.postMessage(this.batch);
          this.batch = new Float32Array(BATCH);
          this.filled = 0;
        }
      }
    }
    return true;
  }
}

registerProcessor("vibeforge-mic", VibeForgeMic);
