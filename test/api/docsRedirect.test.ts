import test from "node:test";
import assert from "node:assert/strict";

import { docsUrl, oblivionDocsBaseUrl } from "../../src/api/docsRedirect.js";

test("docsUrl joins configured base without duplicate slashes", () => {
  const previous = process.env.OBLIVION_DOCS_URL;
  process.env.OBLIVION_DOCS_URL = "https://docs.example.com/";
  try {
    assert.equal(docsUrl("/docs/pricing"), "https://docs.example.com/docs/pricing");
    assert.equal(oblivionDocsBaseUrl(), "https://docs.example.com");
  } finally {
    if (previous === undefined) {
      delete process.env.OBLIVION_DOCS_URL;
    } else {
      process.env.OBLIVION_DOCS_URL = previous;
    }
  }
});

test("docsUrl falls back to oblivion docs host", () => {
  const previous = process.env.OBLIVION_DOCS_URL;
  delete process.env.OBLIVION_DOCS_URL;
  try {
    assert.equal(
      docsUrl("/docs/user-guide/overview"),
      "https://oblivion-docs.pages.dev/docs/user-guide/overview"
    );
  } finally {
    if (previous !== undefined) {
      process.env.OBLIVION_DOCS_URL = previous;
    }
  }
});