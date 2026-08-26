/**
 * Modelfile fixtures shared by the modelfile tests. Each one exercises a
 * corner of the grammar; ROUND_TRIP_FIXTURES drives the property-style
 * parse→serialize identity test over all of them.
 */

/** A typical generated file: comment, blocks, repeated stop, template. */
export const TYPICAL = `# tuned variant of llama3.1
FROM llama3.1:8b

SYSTEM """
You are a terse assistant.
Answer in one sentence.
"""

PARAMETER temperature 0.7
PARAMETER num_ctx 4096
PARAMETER stop <|start_header_id|>
PARAMETER stop <|end_header_id|>

TEMPLATE """{{ .System }}
{{ .Prompt }}"""
`;

/**
 * ADAPTER + MESSAGE + LICENSE with interleaved comments. The LICENSE body
 * contains a line starting with FROM — prose inside a """ block, not an
 * instruction.
 */
export const DECORATED = `# Header comment
# more prose

FROM llama3.1:8b
ADAPTER ./lora.safetensors

# system below
SYSTEM """
The "quoted" system.

With a blank line above.
"""

MESSAGE user Hello there
MESSAGE assistant Hi! How can I help?

PARAMETER temperature 0.4
PARAMETER stop USER:

LICENSE """
MIT License
FROM inside license is prose, not an instruction

Copyright (c) 2026
"""
# trailing comment
`;

/**
 * DECORATED without its ADAPTER line — the create-request tests need a
 * decorated file that toCreateRequest accepts (ADAPTER makes it throw).
 */
export const DECORATED_NO_ADAPTER = DECORATED.replace(
  "ADAPTER ./lora.safetensors\n",
  "",
);

/** Single-line LICENSE, triple-quoted MESSAGE, ADAPTER — all unmanaged. */
export const EXTRAS = `FROM llama3
LICENSE Apache-2.0
MESSAGE user """
What is
a remuda?
"""
MESSAGE assistant A string of saddle horses.
ADAPTER ./lora.safetensors
`;

/** Triple-quoted SYSTEM with embedded quotes and blank lines. */
export const TRIPLE_SYSTEM = `FROM gemma2:9b
SYSTEM """
Say "hello" first.

Then say "goodbye".

"""
`;

export const ONLY_COMMENTS = `# just a comment
# another one
`;

export const EMPTY = "";

/** Tabs, runs of spaces, indentation, trailing spaces on a value line. */
export const ODD_SPACING = `FROM\tllama3.2:3b
PARAMETER  temperature\t 0.9
   # indented comment
SYSTEM   plain single line system${"   "}
`;

export const NO_TRAILING_NEWLINE = `FROM qwen2.5:7b
PARAMETER temperature 1`;

/** A """ block that never closes — everything from it on is passthrough. */
export const UNTERMINATED = `FROM llama3
SYSTEM """
never closed
`;

/** Malformed and unknown lines — all passthrough, never an exception. */
export const JUNK = `FROMAGE cheese
RANDOM junk line
PARAMETER onlykey
FROM
SYSTEM
`;

/** CRLF terminators must survive the round trip byte-for-byte too. */
export const CRLF = "FROM llama3\r\nPARAMETER temperature 1\r\n";

export const ROUND_TRIP_FIXTURES: Array<[string, string]> = [
  ["typical", TYPICAL],
  ["decorated", DECORATED],
  ["decorated without adapter", DECORATED_NO_ADAPTER],
  ["license + block message + adapter", EXTRAS],
  ["triple-quoted system", TRIPLE_SYSTEM],
  ["only comments", ONLY_COMMENTS],
  ["empty", EMPTY],
  ["odd spacing", ODD_SPACING],
  ["no trailing newline", NO_TRAILING_NEWLINE],
  ["unterminated block", UNTERMINATED],
  ["junk", JUNK],
  ["crlf", CRLF],
];
