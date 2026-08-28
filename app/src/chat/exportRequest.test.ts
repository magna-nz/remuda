import { describe, expect, it } from "vitest";
import { asCurl, asOllamaRun, type ExportInput } from "./exportRequest";

function fixture(overrides: Partial<ExportInput> = {}): ExportInput {
  return {
    tag: "llama3.1:8b",
    messages: [{ role: "user", content: "hello" }],
    ...overrides,
  };
}

/** Pulls the `-d '...'` payload back out of an `asCurl()` command and parses
 * it, so tests can assert on the body's shape rather than string-matching
 * quoting noise twice. */
function bodyFromCurl(command: string): Record<string, unknown> {
  const match = /-d '([\s\S]*)'$/.exec(command);
  if (!match) {
    throw new Error(`could not find -d payload in: ${command}`);
  }
  // Undo shellSingleQuote's '\'' escaping so JSON.parse sees the original text.
  const json = match[1].replace(/'\\''/g, "'");
  return JSON.parse(json) as Record<string, unknown>;
}

describe("asCurl", () => {
  it("targets the loopback /api/chat endpoint with stream: true", () => {
    const command = asCurl(fixture());
    expect(command.startsWith("curl http://127.0.0.1:11434/api/chat -d '")).toBe(true);
    expect(bodyFromCurl(command).stream).toBe(true);
  });

  it("correctly quotes a prompt containing a single quote", () => {
    const command = asCurl(
      fixture({ messages: [{ role: "user", content: "it's a nice day" }] }),
    );
    // The whole -d argument must still be one shell-quoted token: an
    // apostrophe in the prompt must not leave the command with an unmatched
    // quote a shell would choke on.
    const body = bodyFromCurl(command);
    expect(body.messages).toEqual([{ role: "user", content: "it's a nice day" }]);
    // The escape sequence itself: close-quote, escaped literal quote, reopen.
    expect(command).toContain("it'\\''s a nice day");
  });

  it("emits literal false for think: off", () => {
    const command = asCurl(fixture({ think: "off" }));
    expect(bodyFromCurl(command).think).toBe(false);
  });

  it("omits think entirely when unset", () => {
    const command = asCurl(fixture());
    expect(bodyFromCurl(command)).not.toHaveProperty("think");
  });

  it("passes a think level through verbatim", () => {
    const command = asCurl(fixture({ think: "high" }));
    expect(bodyFromCurl(command).think).toBe("high");
  });

  it("omits options entirely when none are set", () => {
    const command = asCurl(fixture({ options: {} }));
    expect(bodyFromCurl(command)).not.toHaveProperty("options");
  });

  it("snake_cases only the options that are set, dropping the rest", () => {
    const command = asCurl(
      fixture({ options: { temperature: 0.4, seed: 4417, topP: undefined } }),
    );
    expect(bodyFromCurl(command).options).toEqual({ temperature: 0.4, seed: 4417 });
  });

  it("carries images on the message but never emits thinking", () => {
    const command = asCurl(
      fixture({
        messages: [
          {
            role: "assistant",
            content: "here's the diagram",
            thinking: "the user wants a diagram, let me describe one",
            images: ["aGVsbG8="],
          },
        ],
      }),
    );
    const body = bodyFromCurl(command);
    expect(body.messages).toEqual([
      { role: "assistant", content: "here's the diagram", images: ["aGVsbG8="] },
    ]);
    expect(command).not.toContain("thinking");
    expect(command).not.toContain("let me describe one");
  });

  it("omits images when the array is empty", () => {
    const command = asCurl(fixture({ messages: [{ role: "user", content: "hi", images: [] }] }));
    expect(bodyFromCurl(command).messages).toEqual([{ role: "user", content: "hi" }]);
  });

  it("includes keep_alive when provided and omits it when not", () => {
    const withKeepAlive = bodyFromCurl(asCurl(fixture({ keepAlive: "30m" })));
    expect(withKeepAlive.keep_alive).toBe("30m");
    const withoutKeepAlive = bodyFromCurl(asCurl(fixture()));
    expect(withoutKeepAlive).not.toHaveProperty("keep_alive");
  });

  it("pretty-prints the JSON body", () => {
    const command = asCurl(fixture());
    expect(command).toContain("\n");
  });
});

describe("asOllamaRun", () => {
  it("emits the model tag and the final user prompt", () => {
    const command = asOllamaRun(fixture({ tag: "terse-v2", messages: [{ role: "user", content: "hi there" }] }));
    expect(command).toContain("ollama run terse-v2");
    expect(command).toContain("hi there");
  });

  it("emits a /set parameter line per set option, snake_cased", () => {
    const command = asOllamaRun(fixture({ options: { temperature: 0.4, seed: 4417 } }));
    expect(command).toContain("/set parameter temperature 0.4");
    expect(command).toContain("/set parameter seed 4417");
  });

  it("emits no /set parameter lines when no options are set", () => {
    const command = asOllamaRun(fixture());
    expect(command).not.toContain("/set parameter");
  });

  it("annotates think as not reproducible instead of dropping it silently", () => {
    const command = asOllamaRun(fixture({ think: "medium" }));
    expect(command).toContain("# think: medium");
  });

  it("does not mention think when it is unset", () => {
    const command = asOllamaRun(fixture());
    expect(command).not.toContain("think");
  });

  it("annotates images as not reproducible instead of dropping them silently", () => {
    const command = asOllamaRun(
      fixture({ messages: [{ role: "user", content: "describe this", images: ["aGVsbG8="] }] }),
    );
    expect(command).toMatch(/# .*image/);
  });

  it("annotates multi-turn history as not reproducible, and uses only the final prompt", () => {
    const command = asOllamaRun(
      fixture({
        messages: [
          { role: "system", content: "You are terse." },
          { role: "user", content: "first question" },
          { role: "assistant", content: "first answer" },
          { role: "user", content: "second question" },
        ],
      }),
    );
    expect(command).toMatch(/# .*multi-turn/);
    expect(command).toContain("second question");
    expect(command).not.toContain("first question");
  });

  it("does not annotate a single user-turn request as multi-turn", () => {
    const command = asOllamaRun(fixture());
    expect(command).not.toContain("multi-turn");
  });
});
