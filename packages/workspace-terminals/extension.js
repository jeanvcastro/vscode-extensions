const vscode = require('vscode');
const path = require('path');

/** Folder containing the .code-workspace file; in single-folder windows, that folder. */
function rootDir() {
  const file = vscode.workspace.workspaceFile;
  if (file && file.scheme === 'file') return path.dirname(file.fsPath);
  return vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
}

function rootOptions() {
  const cwd = rootDir();
  return { name: cwd ? path.basename(cwd) : 'terminal', cwd, iconPath: new vscode.ThemeIcon('root-folder') };
}

function activate(context) {
  context.subscriptions.push(
    vscode.window.registerTerminalProfileProvider('workspaceTerminals.root', {
      provideTerminalProfile: () => new vscode.TerminalProfile(rootOptions())
    }),
    vscode.commands.registerCommand('workspaceTerminals.newAtRoot', () =>
      vscode.window.createTerminal(rootOptions()).show()
    )
  );
}

module.exports = { activate, deactivate() {} };
