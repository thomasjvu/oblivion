/**
 * Browser smoke: Mermaid node labels must be centered after post-render normalization.
 * Requires dist/ build and @playwright/test (hoisted from repo root).
 */
import { createServer } from 'http';
import { existsSync, readFileSync, statSync } from 'fs';
import { join, extname, normalize } from 'path';
import { chromium } from '@playwright/test';

const rootDir = process.cwd();
const distDir = join(rootDir, 'dist');
const host = '127.0.0.1';
const templatesPath = '/docs/user-guide/templates';
const maxOffsetPx = 2;

function resolveDistFile(pathname) {
  const normalizedPathname = normalize(decodeURIComponent(pathname)).replace(/^\\+/, '');
  const relativePath = normalizedPathname.replace(/^([/\\])+/, '');
  const directFilePath = join(distDir, relativePath);

  if (existsSync(directFilePath) && statSync(directFilePath).isFile()) {
    return directFilePath;
  }

  const indexFilePath = join(distDir, relativePath, 'index.html');
  if (existsSync(indexFilePath) && statSync(indexFilePath).isFile()) {
    return indexFilePath;
  }

  if (!extname(relativePath)) {
    const htmlFilePath = join(distDir, `${relativePath}.html`);
    if (existsSync(htmlFilePath) && statSync(htmlFilePath).isFile()) {
      return htmlFilePath;
    }
  }

  return null;
}

async function withStaticPreviewServer(run) {
  const server = createServer((request, response) => {
    const requestUrl = new URL(request.url || '/', `http://${host}`);
    const targetPath =
      requestUrl.pathname === '/' ? join(distDir, 'index.html') : resolveDistFile(requestUrl.pathname);

    if (!targetPath) {
      response.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
      response.end('Not found');
      return;
    }

    response.writeHead(200, {
      'Content-Type':
        extname(targetPath) === '.html'
          ? 'text/html; charset=utf-8'
          : extname(targetPath) === '.js'
            ? 'text/javascript; charset=utf-8'
            : extname(targetPath) === '.css'
              ? 'text/css; charset=utf-8'
              : 'application/octet-stream',
      'Cache-Control': 'no-store',
    });
    response.end(readFileSync(targetPath));
  });

  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, host, resolve);
  });

  const address = server.address();
  const port = typeof address === 'object' && address ? address.port : null;
  if (!port) {
    throw new Error('Could not determine preview server port.');
  }

  try {
    await run(`http://${host}:${port}`);
  } finally {
    await new Promise((resolve, reject) => {
      server.close((error) => (error ? reject(error) : resolve()));
    });
  }
}

async function assertTemplatesDiagramCentered(baseUrl) {
  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 1400, height: 900 } });

  try {
    await page.goto(`${baseUrl}${templatesPath}`, { waitUntil: 'networkidle' });
    await page.waitForSelector('.mermaid-block__content svg g.node', { timeout: 30000 });
    await page.waitForTimeout(300);

    const report = await page.evaluate((tolerance) => {
      const canvas = document.querySelector('.mermaid-block__content');
      const nodes = [...(canvas?.querySelectorAll('g.node') ?? [])].map((nodeGroup) => {
        const label = nodeGroup.querySelector('.nodeLabel');
        const shape = nodeGroup.querySelector('.label-container');
        const labelGroup = nodeGroup.querySelector('g.label');
        const labelRect = label?.getBoundingClientRect();
        const shapeRect = shape?.getBoundingClientRect();
        const offsetX =
          labelRect && shapeRect
            ? labelRect.left + labelRect.width / 2 - (shapeRect.left + shapeRect.width / 2)
            : null;
        const offsetY =
          labelRect && shapeRect
            ? labelRect.top + labelRect.height / 2 - (shapeRect.top + shapeRect.height / 2)
            : null;

        return {
          text: label?.textContent?.trim() ?? '',
          labelTransform: labelGroup?.getAttribute('transform'),
          offsetX,
          offsetY,
        };
      });

      const bad = nodes.filter(
        (node) =>
          Math.abs(node.offsetX ?? 0) > tolerance || Math.abs(node.offsetY ?? 0) > tolerance
      );

      return { nodeCount: nodes.length, bad, nodes };
    }, maxOffsetPx);

    if (report.bad.length > 0) {
      const details = report.bad
        .map(
          (node) =>
            `${node.text}: offset (${node.offsetX?.toFixed(1)}, ${node.offsetY?.toFixed(1)}), transform=${node.labelTransform}`
        )
        .join('; ');
      throw new Error(`Mermaid labels are off-center: ${details}`);
    }

    if (report.nodes.some((node) => node.labelTransform)) {
      throw new Error('Mermaid label transforms were not stripped after normalization.');
    }
  } finally {
    await browser.close();
  }
}

async function main() {
  if (!existsSync(distDir)) {
    throw new Error('Missing dist/ output. Run `npm run build` first.');
  }

  await withStaticPreviewServer(assertTemplatesDiagramCentered);
  console.log('Mermaid centering smoke checks passed.');
}

main().catch((error) => {
  console.error('Mermaid centering smoke checks failed:', error);
  process.exit(1);
});