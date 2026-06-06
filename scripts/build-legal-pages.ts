import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { loadMarkdownDoc, projectRoot, staticDocPageFromMarkdown } from "../src/api/markdownPage.js";

const LEGAL_PAGES = [
  { slug: "privacy", md: "PRIVACY_POLICY.md", pageTitle: "Privacy Policy", heading: "Privacy" },
  { slug: "terms", md: "TERMS_OF_SERVICE.md", pageTitle: "Terms of Service", heading: "Terms" }
] as const;

const root = projectRoot();
const publicDir = join(root, "public");

for (const page of LEGAL_PAGES) {
  const markdown = await loadMarkdownDoc(page.md);
  const html = staticDocPageFromMarkdown(markdown, {
    pageTitle: page.pageTitle,
    heading: page.heading
  });
  await writeFile(join(publicDir, `${page.slug}.html`), html, "utf8");
}