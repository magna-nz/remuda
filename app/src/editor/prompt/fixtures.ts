/**
 * Template fixtures for the prompt renderer, taken from real Modelfiles
 * (`ollama show --modelfile`) rather than invented.
 *
 * They are shared by `render.test.ts` and `analyse.test.ts` so the two
 * always argue about the same strings — including the ones the renderer is
 * expected to *refuse*, which are as important as the ones it handles.
 */

/**
 * ChatML, as shown in docs/mockup-proposals-2.html §03 — the shape qwen and
 * the other `<|im_start|>` models use. Entirely inside the subset.
 */
export const CHATML = `{{- if .System }}<|im_start|>system
{{ .System }}<|im_end|>
{{ end }}
{{- range .Messages }}
<|im_start|>{{ .Role }}
{{ .Content }}<|im_end|>
{{ end }}
<|im_start|>assistant
{{- if .Tools }}
<tools>{{ .Tools }}</tools>
{{- end }}
`;

/**
 * The old two-slot completion template Ollama generates when a Modelfile
 * names none — `.Prompt` rather than `.Messages`.
 */
export const SYSTEM_PROMPT_PAIR = `{{ .System }}
{{ .Prompt }}`;

/**
 * Mistral/CodeLlama's instruct template. Real, widely used, and the exact
 * bug the pane exists to catch: no `.System` anywhere, so a `SYSTEM`
 * instruction in the Modelfile never reaches the model.
 */
export const NO_SYSTEM = `[INST] {{ .Prompt }} [/INST]`;

/**
 * Llama 3's template. Uses `eq` and `else`, both outside the subset, so the
 * renderer must refuse it — while the analysis still has to report that it
 * references `.System`.
 */
export const LLAMA3 = `{{ if .System }}<|start_header_id|>system<|end_header_id|>

{{ .System }}<|eot_id|>{{ end }}{{ range .Messages }}{{ if eq .Role "user" }}<|start_header_id|>user<|end_header_id|>

{{ .Content }}<|eot_id|>{{ else }}<|start_header_id|>assistant<|end_header_id|>

{{ .Content }}<|eot_id|>{{ end }}{{ end }}<|start_header_id|>assistant<|end_header_id|>

`;

/** A `range` body with a nested `if` — the common "skip empty turns" shape. */
export const NESTED_IF_IN_RANGE = `{{ range .Messages }}<|{{ .Role }}|>
{{ if .Content }}{{ .Content }}
{{ end }}{{ end }}`;

/**
 * A real Jinja chat template, excerpted from `qwen3.8-27b` as served by
 * Ollama 0.32.15. Newer models embed one of these in their GGUF instead of
 * carrying a Go `text/template`, and it is the case the `.System` indicator
 * must stay silent on: Jinja reaches the system prompt through its
 * `messages` array and never writes `.System`, so a red flag here would be a
 * false alarm rather than a finding.
 */
export const JINJA_QWEN = `{%- set image_count = namespace(value=0) %}
{%- set video_count = namespace(value=0) %}
{%- macro render_content(content, do_vision_count, is_system_content=false) %}
    {%- if content is string %}
        {{- content }}
    {%- elif content is iterable and content is not mapping %}
        {%- for item in content %}
            {%- if 'image' in item or 'image_url' in item or item.type == 'image' %}
                {%- if is_system_content %}
                    {{- raise_exception('System message cannot contain images.') }}
                {%- endif %}
                {%- if do_vision_count %}`;
