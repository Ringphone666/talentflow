class InterviewPcmProcessor extends AudioWorkletProcessor {
  constructor() {
    super()
    this.samples = new Int16Array(2048)
    this.count = 0
    this.port.onmessage = ({ data }) => {
      if (data === 'flush') {
        this.emit()
        this.port.postMessage('flushed')
      }
    }
  }
  emit() {
    if (!this.count) return
    const bytes = this.samples.slice(0, this.count).buffer
    this.port.postMessage(bytes, [bytes])
    this.count = 0
  }
  process(inputs) {
    const channel = inputs[0]?.[0]
    if (channel) for (const sample of channel) {
      const clamped = Math.max(-1, Math.min(1, sample))
      this.samples[this.count++] = Math.round(clamped * (clamped < 0 ? 32768 : 32767))
      if (this.count === this.samples.length) this.emit()
    }
    return true
  }
}
registerProcessor('interview-pcm', InterviewPcmProcessor)
