import { access, readFile, writeFile } from "node:fs/promises";
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

const pricingPath = join(publicDir, "pricing.html");
try {
  await access(pricingPath);
  const pricing = await readFile(pricingPath, "utf8");
  if (!pricing.includes("pricing-page")) {
    throw new Error("public/pricing.html is missing required pricing-page markup");
  }
  if (!pricing.includes("site-footer-external-link") || !pricing.includes("SKILL.md")) {
    throw new Error("public/pricing.html footer is out of date — add the SKILL.md external link");
  }
} catch (error) {
  if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  const markdown = await loadMarkdownDoc("PRICING.md");
  const fallback = staticDocPageFromMarkdown(markdown, {
    pageTitle: "Pricing",
    heading: "Pricing"
  });
  await writeFile(pricingPath, fallback, "utf8");
}