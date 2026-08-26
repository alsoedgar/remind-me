/* global AudioWorkletProcessor, registerProcessor */

class RemindMeCaptureProcessor extends AudioWorkletProcessor {
  constructor() {
    super()
    this.chunks = []
    this.sampleCount = 0
    this.port.onmessage = (event) => {
      if (event.data?.type !== 'flush') return
      this.flush()
      this.port.postMessage({ type: 'flushed' })
    }
  }

  flush() {
    if (this.sampleCount === 0) return
    const samples = new Float32Array(this.sampleCount)
    let offset = 0
    for (const chunk of this.chunks) {
      samples.set(chunk, offset)
      offset += chunk.length
    }
    this.chunks = []
    this.sampleCount = 0
    this.port.postMessage(samples.buffer, [samples.buffer])
  }

  process(inputs, outputs) {
    const input = inputs[0]?.[0]
    if (input?.length) {
      const copy = new Float32Array(input)
      this.chunks.push(copy)
      this.sampleCount += copy.length
      if (this.sampleCount >= 2048) this.flush()
    }
    const output = outputs[0]
    if (output) {
      for (const channel of output) channel.fill(0)
    }
    return true
  }
}

registerProcessor('remind-me-capture', RemindMeCaptureProcessor)
