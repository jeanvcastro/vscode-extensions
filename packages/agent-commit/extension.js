const vscode = require('vscode');
const { execFile, spawn } = require('child_process');

const cfg = () => vscode.workspace.getConfiguration('agentCommit');

// ───────────────────────── git ─────────────────────────

function git(cwd, args) {
  return new Promise((resolve, reject) => {
    execFile('git', args, { cwd, maxBuffer: 64 * 1024 * 1024 }, (err, stdout, stderr) =>
      err ? reject(new Error(stderr.trim() || err.message)) : resolve(stdout)
    );
  });
}

function gitApi() {
  const ext = vscode.extensions.getExtension('vscode.git');
  return ext?.isActive ? ext.exports.getAPI(1) : undefined;
}

const longestPrefixRepo = (repos, file) =>
  repos
    .filter((r) => file === r.rootUri.fsPath || file.startsWith(r.rootUri.fsPath + '/') || file.startsWith(r.rootUri.fsPath + '\\'))
    .sort((a, b) => b.rootUri.fsPath.length - a.rootUri.fsPath.length)[0];

/** Finds the repository from the clicked button; only asks when there is no way to tell. */
async function resolveRepository(arg) {
  const api = gitApi();
  const repos = api?.repositories ?? [];
  if (!repos.length) return undefined;

  // Repository header button → SourceControl (rootUri); changes group → resourceStates.
  const hint = arg?.rootUri?.fsPath ?? arg?.resourceStates?.[0]?.resourceUri?.fsPath ?? arg?.resourceUri?.fsPath ?? arg?.fsPath;
  if (hint) {
    const repo = repos.find((r) => r.rootUri.fsPath === hint) ?? longestPrefixRepo(repos, hint);
    if (repo) return repo;
  }
  if (repos.length === 1) return repos[0];

  const selected = repos.filter((r) => r.ui?.selected);
  if (selected.length === 1) return selected[0];

  const active = vscode.window.activeTextEditor?.document.uri;
  if (active?.scheme === 'file') {
    const repo = longestPrefixRepo(repos, active.fsPath);
    if (repo) return repo;
  }

  const pick = await vscode.window.showQuickPick(
    repos.map((r) => ({ label: r.rootUri.fsPath.split(/[\\/]/).pop(), description: r.rootUri.fsPath, repo: r })),
    { placeHolder: 'Generate a commit message for which repository?' }
  );
  return pick?.repo;
}

/** Staged changes; if nothing is staged, all changes (including untracked files). */
async function collectChanges(cwd) {
  let diff = await git(cwd, ['diff', '--cached', '--no-color', '--no-ext-diff']);
  let staged = true;
  if (!diff.trim()) {
    staged = false;
    diff = await git(cwd, ['diff', '--no-color', '--no-ext-diff']);
    const untracked = (await git(cwd, ['ls-files', '--others', '--exclude-standard'])).trim();
    if (untracked) diff += `\n\nNew untracked files:\n${untracked}\n`;
  }
  const stat = await git(cwd, staged ? ['diff', '--cached', '--stat'] : ['diff', '--stat']).catch(() => '');
  let recent = '';
  try { recent = await git(cwd, ['log', '-n', '15', '--format=%s']); } catch { /* repository without commits */ }
  return { diff, stat, staged, recent };
}

// ───────────────────────── prompt ─────────────────────────

function buildPrompt({ diff, stat, recent }) {
  const max = cfg().get('maxDiffChars', 60000);
  const truncated = diff.length > max;
  const body = truncated ? diff.slice(0, max) : diff;

  const language = cfg().get('language', 'auto');
  const languageRule = language === 'auto'
    ? 'Write in the same language as the recent commit messages below. If there are none, write in English.'
    : `Write in ${language}.`;
  const format = cfg().get('style', 'conventional') === 'conventional'
    ? 'Use Conventional Commits: "type(optional-scope): summary". Types: feat, fix, refactor, perf, docs, test, build, ci, chore, style, revert. If the recent commits use scopes, follow how they name them.'
    : 'Follow the style of the recent commit messages below.';
  const extra = cfg().get('instructions', '').trim();

  return [
    'You write git commit messages. Reply with ONLY the commit message: no explanation, no quotes, no code fences.',
    format,
    'Summary line: imperative mood, at most 72 characters. Add a body (blank line, then short "- " bullet points) only when the change is not obvious from the summary.',
    languageRule,
    extra && `Extra instructions: ${extra}`,
    '',
    recent.trim() ? `Recent commit messages in this repository:\n${recent.trim()}` : 'This repository has no commits yet.',
    '',
    stat.trim() && `Files changed:\n${stat.trim()}`,
    '',
    `Diff${truncated ? ' (truncated)' : ''}:\n${body}`
  ].filter((l) => l !== false && l !== undefined).join('\n');
}

function cleanMessage(text) {
  let msg = text.replace(/\r/g, '').trim();
  const fenced = msg.match(/^```[\w-]*\n([\s\S]*?)\n```$/);
  if (fenced) msg = fenced[1].trim();
  msg = msg.replace(/^(commit message|mensagem de commit)\s*:\s*\n?/i, '');
  if (/^["'`].*["'`]$/s.test(msg) && !msg.includes('\n')) msg = msg.slice(1, -1);
  return msg.trim();
}

// ───────────────────────── agent ─────────────────────────

/** Runs the configured command (e.g. "claude -p"), sending the prompt through stdin. */
function runAgent(prompt, cwd, token) {
  const command = cfg().get('command', 'claude -p');
  const timeoutMs = cfg().get('timeoutSeconds', 120) * 1000;
  return new Promise((resolve, reject) => {
    const child = spawn(command, { cwd, shell: process.env.SHELL || true, env: process.env });
    let out = '', err = '';
    const timer = setTimeout(() => { child.kill(); reject(new Error(`the command took longer than ${timeoutMs / 1000}s`)); }, timeoutMs);
    token.onCancellationRequested(() => { child.kill(); reject(new vscode.CancellationError()); });
    child.stdout.on('data', (d) => (out += d));
    child.stderr.on('data', (d) => (err += d));
    child.on('error', (e) => { clearTimeout(timer); reject(e); });
    child.on('close', (code) => {
      clearTimeout(timer);
      if (code === 0 && out.trim()) resolve(out);
      else reject(new Error(err.trim() || `"${command}" exited with code ${code}`));
    });
    child.stdin.end(prompt);
  });
}

// ───────────────────────── command ─────────────────────────

async function generate(arg) {
  const repo = await resolveRepository(arg);
  if (!repo) {
    vscode.window.showWarningMessage('Agent Commit: no Git repository found.');
    return;
  }
  const cwd = repo.rootUri.fsPath;

  await vscode.window.withProgress(
    { location: vscode.ProgressLocation.SourceControl, title: 'Generating commit message…', cancellable: true },
    async (_progress, token) => {
      try {
        const changes = await collectChanges(cwd);
        if (!changes.diff.trim()) {
          vscode.window.showInformationMessage(`Agent Commit: nothing to commit in ${cwd.split(/[\\/]/).pop()}.`);
          return;
        }
        const message = cleanMessage(await runAgent(buildPrompt(changes), cwd, token));
        if (!message) throw new Error('the agent returned an empty message');
        repo.inputBox.value = message;
        if (!changes.staged && cfg().get('notifyWhenUnstaged', true)) {
          vscode.window.setStatusBarMessage('Agent Commit: nothing staged, so the message covers all changes', 5000);
        }
      } catch (e) {
        if (e instanceof vscode.CancellationError) return;
        const pick = await vscode.window.showErrorMessage(`Agent Commit: ${e.message}`, 'Configure command');
        if (pick) vscode.commands.executeCommand('workbench.action.openSettings', 'agentCommit.command');
      }
    }
  );
}

function activate(context) {
  context.subscriptions.push(vscode.commands.registerCommand('agentCommit.generate', generate));
}

module.exports = { activate, deactivate() {}, _internal: { buildPrompt, cleanMessage, collectChanges, resolveRepository, longestPrefixRepo } };
