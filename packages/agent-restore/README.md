# Agent Restore

**Reopen VS Code and every terminal goes back to the agent session it was running.**

VS Code restores your terminal tabs, but not the processes in them. Three tabs running three agents come back as three empty shells. Agent Restore fixes that: each restored tab resumes **its own** session automatically, with no menus or prompts.

## Supported agents

| Agent | How the session is tracked | Resumed with |
|---|---|---|
| **Claude Code** | `SessionStart` hook | `claude --resume <id>` |
| **Codex** | `SessionStart` hook | `codex resume <id>` |
| **Cursor CLI** | `sessionStart` hook | `cursor-agent --resume=<id>` |
| **Kimi** | `SessionStart` hook | `kimi --session <id>` |
| **OpenCode** | process detection | `opencode --continue` (latest session in the folder) |

Mix them freely, e.g. Claude in one tab and Codex in another. If an agent's hook doesn't fire, Agent Restore still recognizes the agent in the tab and falls back to that agent's "continue latest session" command.

## How it works

1. **Session hook.** On first run, Agent Restore offers to add a small hook to the agents you have installed. When a session starts, the hook records which session runs in which shell. In Claude Code and Codex it also fires on `/resume` and `/clear`, so switching conversations is tracked too.
2. **Snapshot.** Every few seconds, the extension saves which agent and session each terminal tab is running. The snapshot is kept per workspace.
3. **Restore.** When VS Code reopens, the extension waits for the tabs to come back and runs the resume command in each one. On a plain *Reload Window*, where the agents are still alive, it does nothing.

Turn on VS Code's persistent terminals if you have turned them off: `terminal.integrated.enablePersistentSessions`.

## What it changes on your machine

- **Hooks:** one entry each in `~/.claude/settings.json`, `~/.codex/hooks.json`, `~/.cursor/hooks.json` and `~/.kimi-code/config.toml`, only for agents you have installed. Each file gets a `.bak` backup first, and your existing settings are kept.
- **Hook script:** `~/.local/share/agent-restore/agent-restore-hook.sh`.
- **Session records:** `~/.cache/agent-restore/`, cleaned up after 30 days.

To undo everything, run **Agent Restore: Remove Session Hooks**.

## Notes

- **Codex** asks you to trust new hooks once. Open `/hooks` in Codex and approve the Agent Restore hook.
- **Cursor CLI:** some versions don't run hooks. For those, the fallback (latest session) applies. If your binary is `agent` instead of `cursor-agent`, override it in the settings, as shown below.
- **OpenCode** has no stable session hook yet. With two OpenCode tabs in the same folder, the second one opens OpenCode so you can pick the session.
- Works on **macOS and Linux**. Windows isn't supported.

## Settings

| Setting | Default | Description |
|---|---|---|
| `agentRestore.enabled` | `true` | Resume sessions automatically. |
| `agentRestore.commands` | `{}` | Override commands per agent: `resume` (use `{id}`), `last`, `pick`. |

```json
"agentRestore.commands": {
  "cursor": { "resume": "agent --resume={id}", "last": "agent --continue", "pick": "agent ls" }
}
```

**Troubleshooting:** open **Output → Agent Restore** to see what each snapshot captured and what was resumed.
