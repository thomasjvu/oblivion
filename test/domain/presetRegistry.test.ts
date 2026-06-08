import test from "node:test";
import assert from "node:assert/strict";
import {
  CLEANUP_PRESETS,
  defaultActionTypeForPreset,
  presetSkipsMatchReview,
  presetUsesOfficialPathDiscovery
} from "../../src/domain/cleanup.js";
import type { PresetId } from "../../src/domain/types.js";

const EXPECTED_PRESET_REGISTRY: Record<
  PresetId,
  {
    skipsMatchReview: boolean;
    usesOfficialPathDiscovery: boolean;
    defaultActionTypeUs: string;
    defaultActionTypeUk?: string;
  }
> = {
  "people-search-cleanup": {
    skipsMatchReview: false,
    usesOfficialPathDiscovery: false,
    defaultActionTypeUs: "broker-opt-out"
  },
  "search-result-suppression": {
    skipsMatchReview: true,
    usesOfficialPathDiscovery: true,
    defaultActionTypeUs: "search-result-removal"
  },
  "california-drop": {
    skipsMatchReview: true,
    usesOfficialPathDiscovery: true,
    defaultActionTypeUs: "gdpr-erasure"
  },
  "gdpr-erasure": {
    skipsMatchReview: true,
    usesOfficialPathDiscovery: true,
    defaultActionTypeUs: "gdpr-erasure",
    defaultActionTypeUk: "uk-gdpr-erasure"
  },
  "breach-exposure": {
    skipsMatchReview: true,
    usesOfficialPathDiscovery: true,
    defaultActionTypeUs: "hibp-email-check"
  },
  "high-risk-safety": {
    skipsMatchReview: false,
    usesOfficialPathDiscovery: false,
    defaultActionTypeUs: "broker-opt-out"
  },
  "content-takedown": {
    skipsMatchReview: false,
    usesOfficialPathDiscovery: false,
    defaultActionTypeUs: "dmca-takedown"
  }
};

test("preset registry covers all cleanup presets", () => {
  assert.equal(CLEANUP_PRESETS.length, 7);
  for (const preset of CLEANUP_PRESETS) {
    assert.ok(EXPECTED_PRESET_REGISTRY[preset.id], `missing registry expectations for ${preset.id}`);
  }
});

for (const preset of CLEANUP_PRESETS) {
  test(`presetSkipsMatchReview for ${preset.id}`, () => {
    assert.equal(presetSkipsMatchReview(preset.id), EXPECTED_PRESET_REGISTRY[preset.id].skipsMatchReview);
  });

  test(`presetUsesOfficialPathDiscovery for ${preset.id}`, () => {
    assert.equal(
      presetUsesOfficialPathDiscovery(preset.id),
      EXPECTED_PRESET_REGISTRY[preset.id].usesOfficialPathDiscovery
    );
  });

  test(`defaultActionTypeForPreset for ${preset.id}`, () => {
    assert.equal(
      defaultActionTypeForPreset(preset.id, "US"),
      EXPECTED_PRESET_REGISTRY[preset.id].defaultActionTypeUs
    );
    if (EXPECTED_PRESET_REGISTRY[preset.id].defaultActionTypeUk) {
      assert.equal(
        defaultActionTypeForPreset(preset.id, "UK"),
        EXPECTED_PRESET_REGISTRY[preset.id].defaultActionTypeUk
      );
    }
  });
}