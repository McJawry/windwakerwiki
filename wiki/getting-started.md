---
title: Getting started
icon: 🚀
tags: [setup, github]
order: 2
---

# Getting started

You can run your own copy of this wiki for free on GitHub Pages.

1. Create a repository and upload these files (or use it as a template).
2. In the repository, open **Settings → Pages** and set **Source** to **GitHub Actions**.
3. Push to `main`. The included workflow builds the page index and publishes the site.
4. Open `https://<you>.github.io/<repo>/` — your wiki is live.

> [!IMPORTANT]
> On `github.io` addresses the repository is detected automatically. Anywhere else, set `"repo": "owner/name"` in `config.json`.

## Letting people edit

There are two kinds of contributors:

| Who | What they do | What happens |
| --- | --- | --- |
| Collaborators | Create a fine-grained token with *Contents* and *Pull requests* access | Edits publish directly, or as a pull request if they choose |
| Everyone else | Create a classic token with the `public_repo` scope | The editor forks the repo and opens a pull request for you to review |

Tokens never leave the contributor's browser except to talk to GitHub.

## Good to know

- The live site refreshes about a minute after a change lands, because GitHub Pages has to redeploy.
- Set `"directCommit": false` in `config.json` to require review for **everyone**, including you.
- Pages are plain Markdown in the `wiki/` folder, so you can also edit them in any text editor and push as usual.

Back to [[Welcome]].
