# Oblivion docs

Static documentation site for [Oblivion](https://oblivion.phantasy.bot), built with the [papers](https://github.com/thomasjvu/papers) framework (React, Vite, generated Markdown, Pagefind search).

**Live:** https://oblivion-docs.phantasy.bot

## Local dev

From the repo root:

```bash
npm run docs:dev
```

Or from this directory:

```bash
npm install
npm run dev
```

Runs at http://localhost:3333 (GBA theme).

## Edit content

| What | Where |
|------|--------|
| Pages | `src/docs/content/` |
| Sidebar / homepage / footer | `shared/documentation-config.js` |
| Production URL & site name | `.env.production` |

Only paths listed in `documentationTree` in `documentation-config.js` are published.

After changing the tree or Markdown:

```bash
npm run generate:docs
```

## Ship

```bash
npm test
npm run build
npm run deploy
```

`npm run build` also refreshes SEO, `llms.txt`, and the Pagefind index.

## Framework sync

This folder tracks the shared papers template. See [PAPERS_UPSTREAM.md](PAPERS_UPSTREAM.md) for pulling or pushing framework changes.