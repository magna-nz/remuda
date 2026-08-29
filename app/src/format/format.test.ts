import { describe, expect, it } from "vitest";
import {
  STARTER_SCHEMA,
  defaultFormat,
  formatLabel,
  parseSchema,
  propertyNames,
  propertySchema,
  requiredNames,
  wireFormat,
} from "./format";

describe("parseSchema", () => {
  it("parses a schema object", () => {
    const { schema, error } = parseSchema('{"type":"object"}');
    expect(error).toBeNull();
    expect(schema).toEqual({ type: "object" });
  });

  it("reports a half-typed schema without discarding anything", () => {
    const { schema, error } = parseSchema('{"type":"obj');
    expect(schema).toBeNull();
    expect(error).not.toBeNull();
  });

  it("rejects a JSON array — `format` takes a schema object", () => {
    expect(parseSchema("[1, 2]").error).toBe("the response schema must be a JSON object");
  });

  it("rejects empty text rather than sending an empty constraint", () => {
    // `{}` is a schema that permits anything, which is what the `json`
    // button is for; an empty editor is not a third meaning of it.
    expect(parseSchema("   ").schema).toBeNull();
    expect(parseSchema("").error).toContain("empty");
  });

  it("parses the starter the pane opens on", () => {
    const { schema, error } = parseSchema(STARTER_SCHEMA);
    expect(error).toBeNull();
    expect(propertyNames(schema)).toEqual(["summary", "breaking", "issues", "severity"]);
    expect(requiredNames(schema)).toEqual(["summary", "severity"]);
    expect(propertySchema(schema, "severity")).toMatchObject({ type: "string" });
    expect(propertySchema(schema, "nope")).toBeNull();
  });
});

describe("wireFormat", () => {
  it("omits the field for `off`, and for a session that never had one", () => {
    expect(wireFormat(undefined)).toEqual({ error: null });
    expect(wireFormat({ mode: "off", text: STARTER_SCHEMA })).toEqual({ error: null });
    // Not `""`, not `null` — the key is simply not there.
    expect(wireFormat(undefined).format).toBeUndefined();
  });

  it("sends the literal string for `json`, whatever the editor holds", () => {
    expect(wireFormat({ mode: "json", text: "{ broken" })).toEqual({
      format: "json",
      error: null,
    });
  });

  it("sends the parsed schema object for `schema`", () => {
    expect(wireFormat({ mode: "schema", text: '{"type":"object"}' })).toEqual({
      format: { type: "object" },
      error: null,
    });
  });

  it("refuses the send when the schema doesn't parse", () => {
    // Silently unconstrained output is the one outcome worse than an error:
    // the reply would read as a model ignoring the shape it was never given.
    const result = wireFormat({ mode: "schema", text: '{"type": "obj' });
    expect(result.format).toBeUndefined();
    expect(result.error).toContain("doesn’t parse");
    expect(result.error).toContain("nothing was sent");
  });

  it("refuses an empty schema too", () => {
    expect(wireFormat({ mode: "schema", text: "" }).error).not.toBeNull();
  });
});

describe("defaults and labels", () => {
  it("opens off, with the starter ready to edit", () => {
    expect(defaultFormat()).toEqual({ mode: "off", text: STARTER_SCHEMA });
    expect(wireFormat(defaultFormat())).toEqual({ error: null });
  });

  it("labels the pill with the mode", () => {
    expect(formatLabel(undefined)).toBe("off");
    expect(formatLabel({ mode: "json", text: "" })).toBe("json");
    expect(formatLabel({ mode: "schema", text: "" })).toBe("schema");
  });
});
