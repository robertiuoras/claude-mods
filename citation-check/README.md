# Citation Check

A Claude Code mod that tells you when an answer links to pages Claude never opened.

When a turn ends and Claude's answer has links in it, one line appears under the answer:

```
citation-check: 7 links in this answer · 2 never opened: https://…, https://…
```

Nothing appears when the answer has no links, or when Claude opened every one.

## What counts as opened

| The link | Shown as |
|---|---|
| Claude fetched it: a web fetch, a browser tool going to it, or a shell command that names it (`curl`, `wget`) | opened, not shown |
| It came from you, or from something a tool showed Claude: a file it read, a command's output such as a new pull request's link | not shown |
| A web search listed it, or it was written on a page Claude fetched, but Claude never opened it | only seen in search results or fetched pages |
| Anything else | never opened |

Links match loosely: capitals in the site name, `www.`, `http` or `https`, a `#section`, a trailing slash or full stop make no difference. Pages that sub-agents fetched count as opened. Links inside code blocks, and links to your own machine (`localhost`) or to `example.com`, are not checked.

## Good to know

- It costs no tokens. The line is shown to you and never to Claude, and the mod adds nothing to what Claude reads. A one-word reply used 21,757 input tokens with the mod and 21,757 without it.
- "Never opened" means Claude did not open that page in this session, not that the link is wrong. A link written from memory may still work; open it before you rely on it.
- A link written inside a shell command counts as opened even if the command only printed it. Text a command writes to a file through a heredoc (`<<EOF`) does not count.
- In `claude -p`, the line arrives as a notice in `--output-format stream-json`; plain text output stays the answer alone.

## Try it

Needs Claude Code 2.1.287 or later.

```
claude --plugin-dir /path/to/citation-check
```
