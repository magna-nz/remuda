import { describe, expect, it } from "vitest";
import { ndjson } from "./ndjson";

/** A ReadableStream that emits each string as one UTF-8 chunk. */
function streamOf(chunks: string[]): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  return new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) {
        controller.enqueue(encoder.encode(chunk));
      }
      controller.close();
    },
  });
}

async function collect<T>(iterable: AsyncIterable<T>): Promise<T[]> {
  const out: T[] = [];
  for await (const value of iterable) {
    out.push(value);
  }
  return out;
}

describe("ndjson", () => {
  it("parses one complete line per chunk", async () => {
    const lines = await collect(
      ndjson<{ n: number }>(streamOf(['{"n":1}\n', '{"n":2}\n'])),
    );
    expect(lines).toEqual([{ n: 1 }, { n: 2 }]);
  });

  it("reassembles a line split across chunk boundaries", async () => {
    const lines = await collect(
      ndjson<{ a?: number; b?: number; c?: number }>(
        streamOf(['{"a":1}\n{"b"', ':2}\n{"c"', ':3}\n']),
      ),
    );
    expect(lines).toEqual([{ a: 1 }, { b: 2 }, { c: 3 }]);
  });

  it("flushes a trailing line with no final newline", async () => {
    const lines = await collect(
      ndjson<{ n: number }>(streamOf(['{"n":1}\n{"n"', ":2}"])),
    );
    expect(lines).toEqual([{ n: 1 }, { n: 2 }]);
  });

  it("ignores empty and whitespace-only lines", async () => {
    const lines = await collect(
      ndjson<{ n: number }>(streamOf(['\n\n{"n":1}\n', '\n  \n{"n":2}\n\n'])),
    );
    expect(lines).toEqual([{ n: 1 }, { n: 2 }]);
  });

  it("handles several lines arriving in a single chunk", async () => {
    const lines = await collect(
      ndjson<{ n: number }>(streamOf(['{"n":1}\n{"n":2}\n{"n":3}\n'])),
    );
    expect(lines).toEqual([{ n: 1 }, { n: 2 }, { n: 3 }]);
  });

  it("rejects once the signal aborts", async () => {
    // A stream that yields one line and then stays open forever.
    const encoder = new TextEncoder();
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(encoder.encode('{"n":1}\n'));
      },
    });
    const controller = new AbortController();
    const iterator = ndjson<{ n: number }>(body, controller.signal)[
      Symbol.asyncIterator
    ]();
    const first = await iterator.next();
    expect(first).toEqual({ done: false, value: { n: 1 } });
    controller.abort();
    await expect(iterator.next()).rejects.toMatchObject({
      name: "AbortError",
    });
  });
});
