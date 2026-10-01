# Flight Recorder

A Claude Code mod that shows, live, where each turn's time goes.

Type `/flight` to open the pane (type it again to close it). While Claude works, one row per kind of work fills in as it happens:

| Row | What counts |
|---|---|
| Model | Claude writing its answer or deciding the next step |
| Shell | Bash and background shell tools |
| Read | Read, Grep, Glob |
| Edit | Edit, Write, notebook edits |
| Agents | sub-agents and workflows |
| Web | web search and fetch, browser tools |
| Other | everything else (MCP tools, skills) |

The right-hand side shows each row's share of the turn and its total time. When the turn ends, one line names where most of the time went and the slowest single call. After three turns, a second line adds up your last 20 turns. A turn over a minute also ends with a short pop-up summary.

Only the main conversation is drawn. Calls made inside sub-agents are counted in the header but kept off the rows, so the rows add up to the turn you watched.

## Install

Needs Claude Code 2.1.287 or later.

```
/plugin marketplace add robertiuoras/claude-mods
/plugin install flight-recorder@robertiuoras
```

Or try it from a folder: `claude --plugin-dir /path/to/flight-recorder`.

## Good to know

- A tool's time runs from the moment Claude asks for it to the moment its result comes back. That includes any permission step before it runs: your hooks, a permission prompt you answer, or auto mode's safety check. Claude Code does not report when the tool itself starts, so these cannot be split out yet.
- The last 50 turns are kept on your machine (the mod's own store) for the "last 20 turns" line. Nothing is sent anywhere.
- The pane draws in the terminal and the desktop app's Code tab.
