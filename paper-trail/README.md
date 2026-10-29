# Paper Trail

A Claude Code mod that keeps a live list of every file Claude changed in this session, with the lines it added and removed, like `git diff --stat` while it happens.

Type `/trail` to open the pane (type it again to close it).

![Paper Trail after Claude renamed a function across code, tests and docs](../media/paper-trail.png)

Each row is one file: lines added and removed, a small bar in the style of `git diff --stat`, the path, **new** if Claude created it, how many times it was changed, and when. The most recently changed file is on top. The header adds it all up.

## Install

Needs Claude Code 2.1.287 or later.

```
/plugin install paper-trail --marketplace robertiuoras/claude-mods
```

## Good to know

- It counts what the Edit, Write and notebook-edit tools report, including edits made by sub-agents. Files changed by shell commands (`sed -i`, a code formatter, `git checkout`) are not listed, because Claude Code does not report what a shell command changed.
- A file Claude rewrote whole counts only the lines that actually differ, the same as git would.
- The list lasts for the session and is kept across mod reloads. Nothing is written to disk or sent anywhere.
- Where no pane can be drawn, `/trail` prints the same list as text.
