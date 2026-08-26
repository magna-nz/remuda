/**
 * Parse an NDJSON byte stream (Ollama's streaming responses) into typed
 * values. Decodes UTF-8 incrementally, reassembles lines split across chunk
 * boundaries, ignores empty lines, and flushes a trailing unterminated line
 * when the stream ends.
 */
export async function* ndjson<T>(
  body: ReadableStream<Uint8Array>,
  signal?: AbortSignal,
): AsyncGenerator<T> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  try {
    for (;;) {
      if (signal?.aborted) {
        throw signal.reason ?? new DOMException("Aborted", "AbortError");
      }
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let newline = buffer.indexOf("\n");
      while (newline !== -1) {
        const line = buffer.slice(0, newline).trim();
        buffer = buffer.slice(newline + 1);
        if (line !== "") {
          yield JSON.parse(line) as T;
        }
        newline = buffer.indexOf("\n");
      }
    }
    buffer += decoder.decode();
    const tail = buffer.trim();
    if (tail !== "") {
      yield JSON.parse(tail) as T;
    }
  } finally {
    // Cancel first so a consumer that stops iterating early (e.g. `break`
    // in a `for await`) actually drops the stream and stops server-side
    // generation, rather than merely releasing our lock on it. A no-op
    // if the stream is already fully consumed or closed.
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}
