import { describe, expect, it } from "vitest";
import { jsonTypeOf, tally, toolDefs, validateCall } from "./validate";
import type { ToolCall } from "../api/types";

const WEATHER = [
  {
    type: "function",
    function: {
      name: "get_weather",
      description: "Current weather",
      parameters: {
        type: "object",
        properties: {
          city: { type: "string" },
          unit: { type: "string", enum: ["celsius", "fahrenheit"] },
          days: { type: "integer" },
          verbose: { type: "boolean" },
          tags: { type: "array" },
          origin: { type: "object" },
        },
        required: ["city"],
      },
    },
  },
];

function call(name: string, args: Record<string, unknown>): ToolCall {
  return { name, arguments: args };
}

describe("validateCall", () => {
  it("passes a fully valid call — matched, every argument ok, nothing missing", () => {
    const verdict = validateCall(call("get_weather", { city: "Wellington", unit: "celsius" }), WEATHER);
    expect(verdict.matched).toBe(true);
    expect(verdict.args.map((a) => a.verdict)).toEqual(["ok", "ok"]);
    expect(verdict.missing).toEqual([]);
    expect(verdict.valid).toBe(true);
  });

  it("reports a wrong type, naming what was declared and what arrived", () => {
    const verdict = validateCall(call("get_weather", { city: 7 }), WEATHER);
    expect(verdict.args[0].verdict).toBe("wrong type");
    expect(verdict.args[0].detail).toBe("wrong type · expected string, got integer");
    expect(verdict.valid).toBe(false);
  });

  it("reports a value outside the enum, and lists the enum", () => {
    const verdict = validateCall(call("get_weather", { city: "Wellington", unit: "F" }), WEATHER);
    expect(verdict.args[1].verdict).toBe("not in enum");
    expect(verdict.args[1].detail).toBe("not in enum [celsius, fahrenheit]");
    expect(verdict.valid).toBe(false);
  });

  it("reports a key the schema never declared", () => {
    const verdict = validateCall(call("get_weather", { city: "Wellington", country: "NZ" }), WEATHER);
    expect(verdict.args[1]).toMatchObject({ key: "country", verdict: "unknown key", detail: "unknown key" });
    expect(verdict.valid).toBe(false);
  });

  it("lists required keys the model omitted separately from the arguments it sent", () => {
    const verdict = validateCall(call("get_weather", { unit: "celsius" }), WEATHER);
    expect(verdict.args.map((a) => a.verdict)).toEqual(["ok"]);
    expect(verdict.missing).toEqual(["city"]);
    expect(verdict.valid).toBe(false);
  });

  it("badges a call naming an unknown tool as no such tool, and judges no arguments", () => {
    const verdict = validateCall(call("get_wether", { city: "Wellington" }), WEATHER);
    expect(verdict.matched).toBe(false);
    expect(verdict.args).toEqual([]);
    expect(verdict.missing).toEqual([]);
    expect(verdict.valid).toBe(false);
  });

  it("never parses arguments — an object is read as an object, a JSON string is not", () => {
    // Ollama sends `arguments` already parsed. A string here is a *value*,
    // and the validator must judge it as one rather than "helpfully" parsing.
    const verdict = validateCall(call("get_weather", { city: '{"city":"Wellington"}' }), WEATHER);
    expect(verdict.args[0].verdict).toBe("ok");
    expect(verdict.args[0].value).toBe('{"city":"Wellington"}');
  });
});

describe("validateCall — the type traps", () => {
  it("integer rejects 1.5 but number accepts it", () => {
    expect(validateCall(call("get_weather", { city: "x", days: 1.5 }), WEATHER).args[1]).toMatchObject({
      verdict: "wrong type",
      detail: "wrong type · expected integer, got number",
    });
    expect(validateCall(call("get_weather", { city: "x", days: 3 }), WEATHER).args[1].verdict).toBe("ok");
  });

  it("integer satisfies a declared number", () => {
    const tools = [{ type: "function", function: { name: "f", parameters: { type: "object", properties: { n: { type: "number" } } } } }];
    expect(validateCall(call("f", { n: 3 }), tools).args[0].verdict).toBe("ok");
    expect(validateCall(call("f", { n: 3.5 }), tools).args[0].verdict).toBe("ok");
  });

  it("null is not an object — typeof says otherwise", () => {
    const verdict = validateCall(call("get_weather", { city: "x", origin: null }), WEATHER);
    expect(verdict.args[1]).toMatchObject({
      verdict: "wrong type",
      detail: "wrong type · expected object, got null",
    });
  });

  it("an array is not an object either, and an object is not an array", () => {
    expect(validateCall(call("get_weather", { city: "x", origin: [1, 2] }), WEATHER).args[1]).toMatchObject({
      verdict: "wrong type",
      detail: "wrong type · expected object, got array",
    });
    expect(validateCall(call("get_weather", { city: "x", tags: { a: 1 } }), WEATHER).args[1]).toMatchObject({
      verdict: "wrong type",
      detail: "wrong type · expected array, got object",
    });
  });

  it("booleans are not strings and strings are not booleans", () => {
    expect(validateCall(call("get_weather", { city: "x", verbose: "true" }), WEATHER).args[1].verdict).toBe(
      "wrong type",
    );
    expect(validateCall(call("get_weather", { city: true }), WEATHER).args[0].verdict).toBe("wrong type");
  });

  it("accepts any of a type union, and does not judge a keyword it doesn't implement", () => {
    const tools = [
      {
        type: "function",
        function: {
          name: "f",
          parameters: { type: "object", properties: { a: { type: ["string", "null"] }, b: { type: "date-time" } } },
        },
      },
    ];
    expect(validateCall(call("f", { a: null }), tools).args[0].verdict).toBe("ok");
    expect(validateCall(call("f", { a: 3 }), tools).args[0].verdict).toBe("wrong type");
    expect(validateCall(call("f", { b: "whenever" }), tools).args[0].verdict).toBe("ok");
  });

  it("checks type before enum, so a mistyped enum member reads as a type error", () => {
    const verdict = validateCall(call("get_weather", { city: "x", unit: 3 }), WEATHER);
    expect(verdict.args[1].verdict).toBe("wrong type");
  });
});

describe("validateCall — schemas that don't say much", () => {
  it("judges no keys when the tool declares no parameters at all", () => {
    const tools = [{ type: "function", function: { name: "now" } }];
    const verdict = validateCall(call("now", { tz: "UTC" }), tools);
    expect(verdict.matched).toBe(true);
    expect(verdict.args[0].verdict).toBe("ok");
    expect(verdict.valid).toBe(true);
  });

  it("treats every key as unknown when properties is declared but empty", () => {
    const tools = [{ type: "function", function: { name: "now", parameters: { type: "object", properties: {} } } }];
    expect(validateCall(call("now", { tz: "UTC" }), tools).args[0].verdict).toBe("unknown key");
  });
});

describe("toolDefs", () => {
  it("reads the OpenAI function shape Ollama takes, and a flat one too", () => {
    const defs = toolDefs([...WEATHER, { name: "flat", parameters: { type: "object", properties: {} } }]);
    expect(defs.map((d) => d.name)).toEqual(["get_weather", "flat"]);
    expect(defs[0].description).toBe("Current weather");
  });

  it("skips entries with no usable name rather than inventing one", () => {
    expect(toolDefs([null, 3, {}, { function: {} }, { function: { name: "" } }])).toEqual([]);
  });
});

describe("jsonTypeOf", () => {
  it("names the JSON type, keeping integer apart from number", () => {
    expect(jsonTypeOf(null)).toBe("null");
    expect(jsonTypeOf([])).toBe("array");
    expect(jsonTypeOf({})).toBe("object");
    expect(jsonTypeOf(3)).toBe("integer");
    expect(jsonTypeOf(3.5)).toBe("number");
    expect(jsonTypeOf("s")).toBe("string");
    expect(jsonTypeOf(true)).toBe("boolean");
  });
});

describe("tally", () => {
  it("counts valid and malformed calls", () => {
    const verdicts = [
      validateCall(call("get_weather", { city: "Wellington" }), WEATHER),
      validateCall(call("get_weather", { city: "Wellington", unit: "F" }), WEATHER),
      validateCall(call("get_wether", { city: "Wellington" }), WEATHER),
    ];
    expect(tally(verdicts)).toEqual({ calls: 3, valid: 1, malformed: 2 });
  });

  it("is empty before anything is called", () => {
    expect(tally([])).toEqual({ calls: 0, valid: 0, malformed: 0 });
  });
});
