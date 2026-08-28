/**
 * Tool sets: the schemas the playground validates against (docs/SPEC-tuning.md
 * T3), and their persistence.
 *
 * Same persistence idiom as chat/sessions.ts — exported key, pure
 * load/save, per-field coercion, try/catch returning a safe default. A
 * corrupt payload starts the user on the starters rather than crashing or
 * blanking the editor.
 *
 * **`text` is the source of truth, not a parsed array.** The user is typing
 * raw JSON, and JSON in the middle of an edit does not parse. Storing the
 * parsed form would mean either refusing to persist half-typed schemas or
 * silently reverting to the last good one — both of which throw away what the
 * user typed. So the text is kept verbatim and the tools array is *derived*
 * (parseTools below); an unparseable set persists exactly as written and says
 * so inline.
 */

/**
 * Do not bump this key without a migration: a new key orphans — i.e. deletes —
 * every tool set the user wrote. Any field added later must be optional so a
 * v1 payload still loads (SPEC §6).
 */
export const TOOLSETS_STORAGE_KEY = "remuda.toolsets.v1";

export interface ToolSet {
  id: string;
  name: string;
  /** The user's raw JSON, verbatim. See the note above. */
  text: string;
}

/** The derived form of a set's text: the tools array, or the parse failure. */
export interface ParsedTools {
  /** Null when `text` doesn't parse into a JSON array of tools. */
  tools: unknown[] | null;
  /** Human-readable parse failure, or null when it parsed. */
  error: string | null;
}

const WEATHER_TOOLSET = `[
  {
    "type": "function",
    "function": {
      "name": "get_weather",
      "description": "Current weather",
      "parameters": {
        "type": "object",
        "properties": {
          "city": {
            "type": "string"
          },
          "unit": {
            "type": "string",
            "enum": [
              "celsius",
              "fahrenheit"
            ]
          }
        },
        "required": ["city"]
      }
    }
  }
]`;

const TWO_TOOL_TOOLSET = `[
  {
    "type": "function",
    "function": {
      "name": "search_web",
      "description": "Search the web and return result titles",
      "parameters": {
        "type": "object",
        "properties": {
          "query": {
            "type": "string"
          },
          "limit": {
            "type": "integer"
          }
        },
        "required": ["query"]
      }
    }
  },
  {
    "type": "function",
    "function": {
      "name": "send_email",
      "description": "Send an email",
      "parameters": {
        "type": "object",
        "properties": {
          "to": {
            "type": "string"
          },
          "subject": {
            "type": "string"
          },
          "body": {
            "type": "string"
          },
          "priority": {
            "type": "string",
            "enum": [
              "low",
              "normal",
              "high"
            ]
          }
        },
        "required": ["to", "body"]
      }
    }
  }
]`;

/**
 * Two starters, because an empty JSON editor is a worse first run than a
 * wrong example: the first tool call a user sees should exercise the
 * validator (one required arg, one enum) rather than be a syntax error they
 * wrote themselves.
 */
export function starterToolSets(): ToolSet[] {
  return [
    { id: "ts-starter-weather", name: "Weather", text: WEATHER_TOOLSET },
    { id: "ts-starter-two", name: "Search + email", text: TWO_TOOL_TOOLSET },
  ];
}

export function newToolSetId(): string {
  return `ts-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

/**
 * Derive the tools array from the raw text.
 *
 * Empty text is not an error — it's a set with no tools, which is what a
 * cleared editor means. Anything that isn't a JSON array is: Ollama's `tools`
 * is an array, and sending an object would be rejected by the server with a
 * message the user can't act on.
 */
export function parseTools(text: string): ParsedTools {
  if (text.trim() === "") return { tools: [], error: null };
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (error) {
    return { tools: null, error: error instanceof Error ? error.message : "invalid JSON" };
  }
  if (!Array.isArray(parsed)) {
    return { tools: null, error: "the tool schema must be a JSON array of tools" };
  }
  return { tools: parsed, error: null };
}

function coerceToolSet(value: unknown): ToolSet | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  const raw = value as Record<string, unknown>;
  if (typeof raw.id !== "string" || raw.id === "") return null;
  if (typeof raw.name !== "string") return null;
  // The text is required and taken verbatim — including text that doesn't
  // parse, which is the whole point of storing text instead of tools.
  if (typeof raw.text !== "string") return null;
  return { id: raw.id, name: raw.name, text: raw.text };
}

/**
 * Load the saved tool sets. Missing, empty or corrupt storage degrades to the
 * starters — never a crash, and never an empty editor.
 */
export function loadToolSets(): ToolSet[] {
  try {
    const raw = window.localStorage.getItem(TOOLSETS_STORAGE_KEY);
    if (raw === null) return starterToolSets();
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return starterToolSets();
    const sets: ToolSet[] = [];
    for (const entry of parsed) {
      const set = coerceToolSet(entry);
      if (set !== null) sets.push(set);
    }
    return sets.length > 0 ? sets : starterToolSets();
  } catch {
    return starterToolSets();
  }
}

export function saveToolSets(sets: ToolSet[]): void {
  try {
    window.localStorage.setItem(TOOLSETS_STORAGE_KEY, JSON.stringify(sets));
  } catch {
    // Quota/private-mode failures: the tool sets simply won't survive a restart.
  }
}
