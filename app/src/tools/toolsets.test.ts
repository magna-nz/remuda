import "../chat/test/localStorage";
import { beforeEach, describe, expect, it } from "vitest";
import {
  TOOLSETS_STORAGE_KEY,
  loadToolSets,
  parseTools,
  saveToolSets,
  starterToolSets,
  type ToolSet,
} from "./toolsets";
import { toolDefs } from "./validate";

beforeEach(() => {
  window.localStorage.clear();
});

describe("tool set storage", () => {
  it("starts on the two starters, not an empty editor", () => {
    const sets = loadToolSets();
    expect(sets).toHaveLength(2);
    const first = toolDefs(parseTools(sets[0].text).tools ?? []);
    expect(first.map((d) => d.name)).toEqual(["get_weather"]);
    // One required argument, so the first call a user sees exercises the
    // validator rather than passing by default.
    expect(first[0].parameters).toMatchObject({ required: ["city"] });
    expect(toolDefs(parseTools(sets[1].text).tools ?? [])).toHaveLength(2);
  });

  it("round-trips what the user wrote, verbatim", () => {
    const sets: ToolSet[] = [{ id: "ts-1", name: "Mine", text: '[\n  {"name": "f"}\n]' }];
    saveToolSets(sets);
    expect(loadToolSets()).toEqual(sets);
  });

  it("keeps a set whose text does not parse — the text is the source of truth", () => {
    const broken: ToolSet[] = [{ id: "ts-1", name: "Half typed", text: '[{"name": ' }];
    saveToolSets(broken);
    expect(loadToolSets()).toEqual(broken);
    expect(parseTools(broken[0].text).tools).toBeNull();
  });

  it("degrades to the starters on corrupt, non-array or empty storage", () => {
    window.localStorage.setItem(TOOLSETS_STORAGE_KEY, "{not json");
    expect(loadToolSets()).toEqual(starterToolSets());
    window.localStorage.setItem(TOOLSETS_STORAGE_KEY, '{"id":"x"}');
    expect(loadToolSets()).toEqual(starterToolSets());
    window.localStorage.setItem(TOOLSETS_STORAGE_KEY, "[]");
    expect(loadToolSets()).toEqual(starterToolSets());
  });

  it("drops an unreadable entry and keeps the readable ones", () => {
    window.localStorage.setItem(
      TOOLSETS_STORAGE_KEY,
      JSON.stringify([{ id: "ts-1", name: "Mine", text: "[]" }, { id: 7 }, null, { id: "ts-2", name: "No text" }]),
    );
    expect(loadToolSets()).toEqual([{ id: "ts-1", name: "Mine", text: "[]" }]);
  });

  it("does not move the storage key", () => {
    expect(TOOLSETS_STORAGE_KEY).toBe("remuda.toolsets.v1");
  });
});

describe("parseTools", () => {
  it("reads an array of tools", () => {
    expect(parseTools('[{"name":"f"}]')).toEqual({ tools: [{ name: "f" }], error: null });
  });

  it("treats empty text as no tools, not as a failure", () => {
    expect(parseTools("   ")).toEqual({ tools: [], error: null });
  });

  it("reports a syntax error rather than throwing", () => {
    const parsed = parseTools("[{");
    expect(parsed.tools).toBeNull();
    expect(parsed.error).not.toBeNull();
  });

  it("rejects valid JSON that isn't an array — Ollama's `tools` is a list", () => {
    expect(parseTools('{"name":"f"}')).toEqual({
      tools: null,
      error: "the tool schema must be a JSON array of tools",
    });
  });
});
