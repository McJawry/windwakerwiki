# Block-style wiki for GitHub Pages

A Notion-like wiki that runs entirely on GitHub Pages. Pages are Markdown files in `wiki/`; people edit them in a
block editor in the browser and the changes are saved to GitHub as commits or pull requests. No server, no database.

## Publish it

1. Create a GitHub repository and push these files to `main`.
2. **Settings → Pages → Source: GitHub Actions.**
3. The workflow in `.github/workflows/pages.yml` builds `wiki/_index.json` and deploys. Your wiki is at
   `https://<user>.github.io/<repo>/`.

The repository is detected automatically on `github.io`. On a custom domain, set `"repo": "owner/name"` in `config.json`.

## Let others edit

| Contributor | Token to create | What happens on Save |
| --- | --- | --- |
| Has write access | Fine-grained token for this repo: *Contents* and *Pull requests* read & write | Publishes directly, or opens a PR if they choose |
| Anyone else | Classic token with `public_repo` | Forks the repo and opens a PR for you to review |

Tokens live in the contributor's browser (`localStorage`) and are only sent to `api.github.com`.
Set `"directCommit": false` to require a pull request from everyone.

## Config (`config.json`)

| Key | Meaning |
| --- | --- |
| `title`, `icon` | Name and emoji shown in the sidebar |
| `repo` | `owner/name`; auto-detected on github.io |
| `branch` | Base branch; defaults to the repo's default branch |
| `contentDir` | Folder holding the pages (default `wiki`) |
| `directCommit` | `false` = everyone goes through pull requests |

## Content model

- `wiki/foo.md` is page `foo`; `wiki/foo/bar.md` is nested under it in the sidebar. Create pages from the UI or by adding files.
- Optional front matter: `title`, `icon`, `tags: [a, b]`, `order: 1` (sidebar sorting).
- Link with `[[Page title]]` (or `[[Page title|label]]`). Backlinks appear automatically.
- Supported blocks: paragraph, headings 1–3, bulleted / numbered / to-do lists (nestable), quote, callout, toggle,
  code, divider, table, image. They are stored as ordinary Markdown (callouts use GitHub's `> [!NOTE]` syntax, toggles use `<details>`).
- Images uploaded in the editor are committed to `wiki/assets/`.

## Notes and limits

- Edits go live after Pages redeploys (~1 minute). The person who saved sees their change immediately.
- There is no live multi-user editing; concurrent edits are resolved through Git.
- Toggle bodies hold plain text only. Hand-written Markdown that goes beyond the blocks above (HTML, nested quotes) is preserved as text where possible, not as rich blocks.

## Develop locally

```bash
node scripts/build-index.mjs      # regenerate wiki/_index.json after adding pages by hand
python -m http.server 8000        # then open http://localhost:8000
```
