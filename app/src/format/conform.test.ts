import { describe, expect, it } from "vitest";
import { conformance, scanJson, typeBadge } from "./conform";
import { STARTER_SCHEMA, parseSchema } from "./format";

const SCHEMA = parseSchema(STARTER_SCHEMA).schema as Record<string, unknown>;

const GOOD = JSON.stringify({
  summary: "Name the paste chord the platform actually has",
  breaking: false,
  issues: [43, 45],
  severity: "patch",
});

/** The row for one property, or undefined when the card didn't render it. */
function row(text: string, key: string, numPredict?: number) {
  return conformance(text, SCHEMA, numPredict).rows.find((r) => r.key === key);
}

describe("scanJson", () => {
  it("calls a closed document complete", () => {
    expect(scanJson(GOOD).complete).toBe(true);
    expect(scanJson('{"a":[1,{"b":"c"}]}').complete).toBe(true);
  });

  it("calls an unclosed object or string incomplete", () => {
    expect(scanJson('{"a":1').complete).toBe(false);
    expect(scanJson('{"a":"unterm').endedInString).toBe(true);
  });

  it("is not fooled by a brace or a quote inside a string", () => {
    expect(scanJson('{"a":"} not the end \\" either"}').complete).toBe(true);
    expect(scanJson('{"a":"trailing backslash \\\\"').complete).toBe(false);
  });

  it("reads the top-level keys in emission order, and only those", () => {
    // The nested "deep" is not a top-level key and must not be counted as
    // one, or a truncated reply would report a property it never emitted.
    expect(scanJson('{"a":1,"b":{"deep":2},"c"').keys).toEqual(["a", "b"]);
  });
});

describe("conformance — the reply fits", () => {
  it("says so, and badges each property with its declared type", () => {
    const verdict = conformance(GOOD, SCHEMA);
    expect(verdict.status).toBe("conforms");
    expect(verdict.headline).toBe("Conforms");
    expect(verdict.summary).toBe("4 of 4 properties · 2 of 2 required present");
    expect(verdict.rows.map((r) => [r.key, r.badge])).toEqual([
      ["summary", "string"],
      ["breaking", "boolean"],
      ["issues", "integer[]"],
      ["severity", "enum"],
    ]);
    expect(verdict.rows.every((r) => r.tone === "ok")).toBe(true);
  });

  it("badges an array by its item type and an enum as an enum", () => {
    expect(typeBadge({ type: "array", items: { type: "integer" } })).toBe("integer[]");
    expect(typeBadge({ type: "string", enum: ["a"] })).toBe("enum");
    expect(typeBadge({ type: ["string", "null"] })).toBe("string | null");
  });
});

describe("conformance — the reply doesn't fit", () => {
  it("reports a wrong type with validate.ts's own note", () => {
    const bad = JSON.stringify({ summary: 7, severity: "patch" });
    const verdict = conformance(bad, SCHEMA);
    expect(verdict.status).toBe("fails");
    expect(verdict.headline).toBe("Doesn’t conform");
    expect(row(bad, "summary")).toMatchObject({
      badge: "wrong type",
      tone: "no",
      detail: "wrong type · expected string, got integer",
    });
  });

  it("reports a value outside the enum", () => {
    const bad = JSON.stringify({ summary: "s", severity: "catastrophic" });
    expect(row(bad, "severity")).toMatchObject({
      badge: "not in enum",
      detail: "not in enum [patch, minor, major]",
    });
  });

  it("marks a missing required property, in a row of its own", () => {
    const bad = JSON.stringify({ summary: "s" });
    expect(row(bad, "severity")).toMatchObject({ badge: "missing", tone: "miss", value: "—" });
    expect(conformance(bad, SCHEMA).summary).toBe("1 of 4 properties · 1 of 2 required present");
  });

  it("treats an undeclared key as extra, not as a breakage", () => {
    const bad = JSON.stringify({ summary: "s", severity: "patch", mood: "chipper" });
    expect(row(bad, "mood")).toMatchObject({ badge: "extra", tone: "extra" });
  });

  it("judges a non-object reply against the declared root type", () => {
    const verdict = conformance('["a"]', { type: "object" });
    expect(verdict.status).toBe("fails");
    expect(verdict.rows[0]).toMatchObject({ key: "(root)", badge: "wrong type" });
    expect(verdict.rows[0].detail).toBe("wrong type · expected object, got array");
  });
});

describe("conformance — truncation, the failure that actually happens", () => {
  // Under `format` the decoder cannot emit invalid JSON, so a reply that
  // doesn't parse was cut off. Reporting that as a parse error sends the
  // user looking for a bug in the model instead of at num_predict.
  const CUT = '{"summary":"Refactor the Linux bundle path so the AppImage and the .deb share';

  it("names num_predict rather than showing a parse error", () => {
    const verdict = conformance(CUT, SCHEMA, 64);
    expect(verdict.status).toBe("truncated");
    expect(verdict.headline).toBe("Cut off — not valid JSON");
    expect(verdict.summary).toBe("num_predict 64 reached");
    // Not the JSON.parse message, in any form.
    expect(verdict.summary).not.toMatch(/JSON|token|position/i);
  });

  it("still names num_predict when the chat sets no override", () => {
    expect(conformance(CUT, SCHEMA).summary).toContain("num_predict");
  });

  it("says where the cut landed and which properties never arrived", () => {
    const rows = conformance(CUT, SCHEMA, 64).rows;
    expect(rows.find((r) => r.key === "summary")).toMatchObject({
      badge: "incomplete",
      value: "truncated mid-string",
    });
    expect(rows.find((r) => r.key === "severity")).toMatchObject({
      badge: "missing",
      value: "never emitted",
    });
  });

  it("marks the properties that made it out before the cut", () => {
    const cut = '{"summary":"done","breaking":false,"issues":[43,';
    expect(row(cut, "summary")).toMatchObject({ badge: "written", tone: "ok" });
    expect(row(cut, "issues")).toMatchObject({ badge: "incomplete" });
  });

  it("reports a genuinely malformed document as malformed, not as a cut", () => {
    // Unreachable under `format` — but if it ever happens, blaming a limit
    // that wasn't hit would be a wrong answer rather than no answer.
    const verdict = conformance('{"a":1,}', SCHEMA);
    expect(verdict.status).toBe("invalid");
    expect(verdict.headline).toBe("Not valid JSON");
  });
});

describe("conformance — json mode", () => {
  it("confirms valid JSON and judges no shape, because none was asked for", () => {
    const verdict = conformance('{"anything":true}', null);
    expect(verdict.status).toBe("conforms");
    expect(verdict.headline).toBe("Valid JSON");
    expect(verdict.rows).toEqual([]);
  });

  it("still reports a cut-off reply as cut off", () => {
    expect(conformance('{"anything":tru', null).status).toBe("truncated");
  });
});

describe("conformance is derived, never stored", () => {
  it("changes verdict when the schema changes, for the same reply text", () => {
    // The loop the feature exists for: you find a reply that fails, fix the
    // schema, and the card re-judges what is already on screen. Nothing is
    // memoised on the message, so this is just two calls.
    const reply = JSON.stringify({ summary: "s" });
    expect(conformance(reply, SCHEMA).status).toBe("fails");
    const relaxed = { ...SCHEMA, required: ["summary"] };
    expect(conformance(reply, relaxed).status).toBe("conforms");
  });
});
