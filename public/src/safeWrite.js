import { safeJson } from "../../src/domain/safeLogging.ts";

export function createWrite(output, onCaseStatus) {
  return function write(value) {
    if (output) {
      output.textContent = typeof value === "string" ? value : safeJson(value);
    }
    if (value?.caseStatus) {
      onCaseStatus(value);
    }
  };
}