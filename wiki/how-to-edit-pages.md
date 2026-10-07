---
title: How to edit pages
icon: ✏️
tags: [editing, tutorial]
---

# How to edit pages

Click **✎ Edit** at the top right (or press `E`). Everything on the page becomes editable, and nothing is saved until you press **Save**.

## Writing blocks

Every paragraph, heading, list item, and picture is a *block*. Hover a block to see its handles on the left:

- **+** adds a new block below
- **⋮⋮** opens a menu to turn it into something else, duplicate it, or delete it — drag it to move it

Type `/` on an empty line to open the command menu and pick a block type.

## Shortcuts that save time

| You type | You get |
| --- | --- |
| `# ` , `## ` , `### ` | Headings |
| `- ` or `* ` | Bulleted list |
| `1. ` | Numbered list |
| `[] ` | To-do list |
| `> ` | Quote |
| `---` then Enter | Divider |
| `[[` | Link to another page |

Select any text to get the formatting bar: **bold**, *italic*, ~~strikethrough~~, `code`, and links. `Tab` and `Shift+Tab` indent list items.

## Examples

> [!NOTE]
> Click the icon on a callout to cycle through Note, Tip, Important, Warning and Caution.

- [x] Learn the slash menu
- [ ] Link to a page with `[[`
    - [ ] Try nesting this item with Tab

```js
// Code blocks keep their formatting
const greet = (name) => `Hello, ${name}!`;
```

## Saving

When you press **Save**, you will be asked to sign in with a GitHub token the first time. Then either your change goes live right away, or it is sent as a pull request — whichever your permissions allow. See [[Getting started]] for the details.
