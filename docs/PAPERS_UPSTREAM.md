# papers framework sync

The `docs/` directory is a [papers](https://github.com/thomasjvu/papers) documentation site with Oblivion-specific content under `src/docs/content/`.

## Pull framework updates

```sh
git subtree pull --prefix=docs https://github.com/thomasjvu/papers.git main --squash
```

Resolve conflicts by keeping Oblivion content in `src/docs/content/` and local config in:

- `shared/documentation-config.js`
- `.env.production`
- `wrangler.toml`

## Push framework fixes upstream

Only push changes that belong in the shared template (theme system, generators, shell components):

```sh
git subtree push --prefix=docs https://github.com/thomasjvu/papers.git main
```

## Local development

```sh
npm run docs:dev
```

Docs run at http://localhost:3333 with the GBA theme (`VITE_PAPERS_THEME=gba`).