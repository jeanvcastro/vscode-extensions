# vscode-extensions

VS Code extensions for working with coding agents across multi-root workspaces.

| Extension | What it does |
|---|---|
| [**Agent Restore**](packages/agent-restore) | Reopen VS Code and every terminal resumes the agent session it was running: Claude Code, Codex, Cursor CLI, Kimi, OpenCode. |
| [**Agent Commit**](packages/agent-commit) | Commit messages written by your coding agent, sent to the right repository in multi-root workspaces. |
| [**Workspace Terminals**](packages/workspace-terminals) | One-click terminal at the workspace root. |
| [**Midnight**](packages/midnight-theme) | A quiet dark theme for long coding sessions. |

Plain JavaScript, no build step, no runtime dependencies.

## Development

```sh
npm install
npm run check                                      # syntax + required manifest fields
npm run package                                    # builds every .vsix into dist/
npm run set-publisher -- <publisher> <owner/repo>  # sets publisher and repository everywhere
```

To try an extension locally, run **Extensions: Install from VSIX…** and pick a file from `dist/`.

## Releasing

Each extension is released on its own, triggered by a tag named `<name>@<version>`:

```sh
git tag agent-restore@1.0.0 && git push --tags
```

`.github/workflows/publish.yml` publishes to the **VS Code Marketplace** and to **Open VSX**, which Cursor, Windsurf and VSCodium use, then attaches the `.vsix` to a GitHub release. It needs two repository secrets: `VSCE_PAT` and `OVSX_PAT`.

## License

MIT.
