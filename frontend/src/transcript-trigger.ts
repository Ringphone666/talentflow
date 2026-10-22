// Coalesce ASR revisions; keep only the latest evidence while one request runs.
export function transcriptTrigger(run: () => Promise<void>, delay = 400) {
  let latest = '', processed = '', busy = false, closed = false
  let timer: ReturnType<typeof setTimeout> | undefined
  const flush = async () => {
    timer = undefined
    if (closed || busy || latest === processed || latest.trim().length < 8) return
    busy = true
    processed = latest
    try { await run() } finally {
      busy = false
      if (!closed && latest !== processed) timer = setTimeout(() => { void flush() }, delay)
    }
  }
  return {
    update(text: string) {
      if (closed || latest === text) return
      latest = text
      // Do not reset an existing timer: continuous speech must not starve analysis.
      if (!busy && !timer) timer = setTimeout(() => { void flush() }, delay)
    },
    close() { closed = true; if (timer) clearTimeout(timer) },
  }
}
