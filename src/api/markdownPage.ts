import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

export function projectRoot(): string {
  return join(fileURLToPath(new URL("../..", import.meta.url)));
}

function escapeHelpHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function formatHelpInline(text: string): string {
  let html = escapeHelpHtml(text);
  html = html.replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>");
  html = html.replace(/\*(.+?)\*/g, "<em>$1</em>");
  html = html.replace(/`([^`]+)`/g, "<code>$1</code>");
  html = html.replace(/\[([^\]]+)\]\(([^)]+)\)/g, '<a href="$2">$1</a>');
  return html;
}

export function staticDocPageFromMarkdown(
  markdown: string,
  options: { pageTitle: string; heading: string }
): string {
  const lines = markdown.split("\n");
  const parts: string[] = [];
  let inTable = false;
  let inList = false;
  const closeList = () => {
    if (inList) {
      parts.push("</ul>");
      inList = false;
    }
  };
  for (const line of lines) {
    if (line.startsWith("|")) {
      closeList();
      if (!inTable) {
        parts.push("<table>");
        inTable = true;
      }
      const cells = line
        .split("|")
        .slice(1, -1)
        .map((cell) => cell.trim());
      if (cells.every((cell) => /^-+$/.test(cell.replace(/:/g, "")))) continue;
      parts.push(`<tr>${cells.map((c) => `<td>${formatHelpInline(c)}</td>`).join("")}</tr>`);
      continue;
    }
    if (inTable) {
      parts.push("</table>");
      inTable = false;
    }
    if (line.startsWith("# ")) {
      closeList();
      parts.push(`<h1>${formatHelpInline(line.slice(2))}</h1>`);
    } else if (line.startsWith("## ")) {
      closeList();
      parts.push(`<h2>${formatHelpInline(line.slice(3))}</h2>`);
    } else if (line.startsWith("### ")) {
      closeList();
      parts.push(`<h3>${formatHelpInline(line.slice(4))}</h3>`);
    } else if (/^\d+\.\s/.test(line)) {
      closeList();
      parts.push(`<p class="step-line">${formatHelpInline(line)}</p>`);
    } else if (line.startsWith("- ")) {
      if (!inList) {
        parts.push("<ul>");
        inList = true;
      }
      parts.push(`<li>${formatHelpInline(line.slice(2))}</li>`);
    } else if (line.trim() === "---") {
      closeList();
      parts.push("<hr />");
    } else if (line.trim()) {
      closeList();
      parts.push(`<p>${formatHelpInline(line)}</p>`);
    }
  }
  closeList();
  if (inTable) parts.push("</table>");
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>Oblivion — ${escapeHelpHtml(options.pageTitle)}</title>
  <link rel="stylesheet" href="/styles.css" />
</head>
<body>
  <div class="app help-page">
    <header class="topbar">
      <div class="brand"><div class="mark">O</div><h1>${escapeHelpHtml(options.heading)}</h1></div>
      <div class="nav-actions"><a class="secondary help-back" href="/">← Home</a></div>
    </header>
    <article class="help-article">${parts.join("\n")}</article>
    <footer class="site-footer help-page-footer">
      <nav class="site-footer-legal" aria-label="Help and legal">
        <a class="site-footer-text-link" href="/help">Guide</a>
        <a class="site-footer-text-link" href="/privacy">Privacy</a>
        <a class="site-footer-text-link" href="/terms">Terms</a>
      </nav>
    </footer>
  </div>
</body>
</html>`;
}

export async function loadMarkdownDoc(filename: string): Promise<string> {
  const path = join(projectRoot(), "docs", filename);
  return readFile(path, "utf8");
}