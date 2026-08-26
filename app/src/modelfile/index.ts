/**
 * Modelfile parse/serialize kernel (SPEC §5.4) — public surface.
 * Consumers import from here (or the individual modules); the sync
 * contract's round-trip and update-in-place guarantees are documented in
 * parse.ts and serialize.ts.
 */

export {
  parseModelfile,
  from,
  system,
  template,
  parameters,
  type ModelfileDoc,
  type ModelfileSegment,
  type FromSegment,
  type SystemSegment,
  type ParameterSegment,
  type TemplateSegment,
  type PassthroughSegment,
} from "./parse";
export {
  serializeModelfile,
  setFrom,
  setSystem,
  setTemplate,
  setParameter,
  setStops,
} from "./serialize";
export { toCreateRequest } from "./createRequest";
