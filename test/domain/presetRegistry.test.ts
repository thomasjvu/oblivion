import test from "node:test";
import assert from "node:assert/strict";
import {
  CLEANUP_PRESETS,
  defaultActionTypeForPreset,
  getPreset,
  presetSkipsMatchReview,
  presetUsesOfficialPathDiscovery
} from "../../src/domain/cleanup.js";

test("every cleanup preset has required metadata and resolvable defaults", () => {
  assert.ok(CLEANUP_PRESETS.length >= 1);
  for (const preset of CLEANUP_PRESETS) {
    assert.ok(preset.id);
    assert.ok(preset.title);
    assert.ok(preset.summary);
    assert.ok(preset.jurisdictions.length > 0);
    assert.ok(preset.steps.length > 0);
    assert.equal(getPreset(preset.id).id, preset.id);
    assert.equal(typeof presetSkipsMatchReview(preset.id), "boolean");
    assert.equal(typeof presetUsesOfficialPathDiscovery(preset.id), "boolean");
    assert.ok(defaultActionTypeForPreset(preset.id, "US"));
  }
});