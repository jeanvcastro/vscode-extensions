const vscode = require('vscode');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFile } = require('child_process');

const HOME = os.homedir();
const SNAPSHOT_KEY = 'agentRestore.snapshot';
const STATE_DIR = path.join(process.env.XDG_CACHE_HOME || path.join(HOME, '.cache'), 'agent-restore');
const HOOK_PATH = path.join(HOME, '.local', 'share', 'agent-restore', 'agent-restore-hook.sh');
const KIMI_HOME = process.env.KIMI_CODE_HOME || path.join(HOME, '.kimi-code');

/**
 * Supported agents.
 * proc: matches the agent's process.  resume/last/pick: resume commands
 * (exact session, latest in folder, picker).  hook: where the session-start hook is installed.
 */
const AGENTS = {
  claude: {
    label: 'Claude Code',
    proc: /(^|\/)claude(\s|$)|\/claude\.js|@anthropic-ai\/claude-code/,
    resume: 'claude --resume {id}', last: 'claude --continue', pick: 'claude --resume',
    hook: 'claude'
  },
  codex: {
    label: 'Codex',
    proc: /(^|\/)codex(\s|$)|@openai\/codex/,
    resume: 'codex resume {id}', last: 'codex resume --last', pick: 'codex resume',
    hook: 'codex'
  },
  cursor: {
    label: 'Cursor CLI',
    proc: /(^|\/)cursor-agent(\s|$)|cursor-agent\/versions\/|(^|\/)agent(\s|$)/,
    resume: 'cursor-agent --resume={id}', last: 'cursor-agent --continue', pick: 'cursor-agent ls',
    hook: 'cursor'
  },
  kimi: {
    label: 'Kimi',
    proc: /(^|\/)kimi(-cli)?(\s|$)|kimi_cli|@moonshot-ai\/kimi/,
    resume: 'kimi --session {id}', last: 'kimi --continue', pick: 'kimi --session',
    hook: 'kimi'
  },
  opencode: {
    label: 'OpenCode',
    proc: /(^|\/)opencode(\s|$)|opencode-ai\//,
    resume: 'opencode --session {id}', last: 'opencode --continue', pick: 'opencode',
    hook: null // no stable hook: resumes the latest session in the folder
  }
};

let log;

// ───────────────────────── processes ─────────────────────────

function processTable() {
  return new Promise((resolve) => {
    execFile('ps', ['-A', '-o', 'pid=,ppid=,args='], { maxBuffer: 16 * 1024 * 1024 }, (err, out) => {
      const children = new Map();
      const args = new Map();
      if (!err) {
        for (const line of out.split('\n')) {
          const m = line.match(/^\s*(\d+)\s+(\d+)\s+(.*)$/);
          if (!m) continue;
          const pid = Number(m[1]), ppid = Number(m[2]);
          args.set(pid, m[3]);
          if (!children.has(ppid)) children.set(ppid, []);
          children.get(ppid).push(pid);
        }
      }
      resolve({ children, args });
    });
  });
}

/** Agent closest to the shell (if Claude runs Codex inside it, Claude wins). */
function agentUnder(table, shellPid) {
  let level = [...(table.children.get(shellPid) || [])];
  while (level.length) {
    for (const pid of level) {
      const a = table.args.get(pid) || '';
      for (const [key, def] of Object.entries(AGENTS)) if (def.proc.test(a)) return key;
    }
    level = level.flatMap((pid) => table.children.get(pid) || []);
  }
  return undefined;
}

function readMarker(shellPid) {
  try {
    const [agent, sessionId, cwd] = fs.readFileSync(path.join(STATE_DIR, String(shellPid)), 'utf8').split('\n');
    return AGENTS[agent] && sessionId ? { agent, sessionId, cwd } : undefined;
  } catch {
    return undefined;
  }
}

function writeMarker(shellPid, { agent, sessionId, cwd }) {
  try {
    fs.mkdirSync(STATE_DIR, { recursive: true });
    fs.writeFileSync(path.join(STATE_DIR, String(shellPid)), `${agent}\n${sessionId}\n${cwd}\n`);
  } catch { /* ignore */ }
}

// ───────────────────────── snapshot ─────────────────────────

// A session that disappears only leaves the snapshot after a grace period: when VS Code
// quits, terminals die a few seconds before the extension host does.
const REMOVAL_GRACE_MS = 8000;
const missingSince = new Map();
const entryKey = (e) => e.sessionId ? `${e.agent}:${e.sessionId}` : `${e.agent}@${e.cwd}#${e.index}`;

async function takeSnapshot(context) {
  const table = await processTable();
  const entries = [];
  const terminals = vscode.window.terminals;
  for (let index = 0; index < terminals.length; index++) {
    const t = terminals[index];
    const pid = await t.processId;
    if (!pid) continue;
    const agent = agentUnder(table, pid);
    if (!agent) continue;
    const marker = readMarker(pid);
    if (marker && marker.agent === agent) {
      entries.push({ index, name: t.name, ...marker });
    } else {
      // No hook (or it has not fired yet): keep the agent and folder to resume the latest session.
      const cwd = t.shellIntegration?.cwd?.fsPath ?? t.creationOptions?.cwd?.fsPath ?? t.creationOptions?.cwd;
      entries.push({ index, name: t.name, agent, sessionId: null, cwd: typeof cwd === 'string' ? cwd : undefined });
    }
  }

  const saved = context.workspaceState.get(SNAPSHOT_KEY) || [];
  const now = Date.now();
  const present = new Set(entries.map(entryKey));
  for (const k of [...missingSince.keys()]) if (present.has(k)) missingSince.delete(k);
  for (const old of saved) {
    const k = entryKey(old);
    if (present.has(k)) continue;
    if (!missingSince.has(k)) missingSince.set(k, now);
    if (now - missingSince.get(k) < REMOVAL_GRACE_MS) entries.push(old);
    else missingSince.delete(k);
  }
  entries.sort((a, b) => a.index - b.index);

  if (JSON.stringify(saved) !== JSON.stringify(entries)) {
    await context.workspaceState.update(SNAPSHOT_KEY, entries);
    log.appendLine(`snapshot: ${entries.map((e) => `#${e.index} ${e.agent} ${e.sessionId ?? '(latest in folder)'}`).join(', ') || '(no sessions)'}`);
  }
}

// ───────────────────────── restore ─────────────────────────

async function waitForRestoredTerminals() {
  const start = Date.now();
  let count = -1, stableSince = Date.now();
  while (Date.now() - start < 20000) {
    const n = vscode.window.terminals.length;
    if (n !== count) { count = n; stableSince = Date.now(); }
    else if (Date.now() - stableSince >= 2000) break;
    await new Promise((r) => setTimeout(r, 400));
  }
}

function waitShellIntegration(t, ms) {
  if (t.shellIntegration) return Promise.resolve(t.shellIntegration);
  return new Promise((resolve) => {
    const timer = setTimeout(() => { sub.dispose(); resolve(undefined); }, ms);
    const sub = vscode.window.onDidChangeTerminalShellIntegration((e) => {
      if (e.terminal === t) { clearTimeout(timer); sub.dispose(); resolve(e.shellIntegration); }
    });
  });
}

const shq = (s) => `'${String(s).replace(/'/g, `'\\''`)}'`;

function commandFor(entry, kind) {
  const overrides = vscode.workspace.getConfiguration('agentRestore').get('commands', {});
  const def = { ...AGENTS[entry.agent], ...(overrides[entry.agent] || {}) };
  const cmd = def[kind].replace('{id}', shq(entry.sessionId));
  return entry.cwd ? `cd ${shq(entry.cwd)} && ${cmd}` : cmd;
}

async function restore(snapshot) {
  if (!snapshot.length) return;
  await waitForRestoredTerminals();
  const terminals = vscode.window.terminals;
  const table = await processTable();
  const usedTerminals = new Set();
  const seenIndex = new Set();
  const lastUsed = new Set(); // agent+folder that already got "continue latest"

  for (const entry of snapshot) {
    if (!AGENTS[entry.agent] || seenIndex.has(entry.index)) continue;
    seenIndex.add(entry.index);

    let t = terminals[entry.index];
    if (!t || t.name !== entry.name || usedTerminals.has(t)) {
      t = terminals.find((x) => x.name === entry.name && !usedTerminals.has(x));
    }
    if (!t) { log.appendLine(`no tab found for ${entry.agent} ${entry.sessionId ?? ''}`); continue; }
    usedTerminals.add(t);

    const pid = await t.processId;
    if (pid && agentUnder(table, pid)) continue; // window reload: the agent is still alive

    let cmd;
    if (entry.sessionId) {
      cmd = commandFor(entry, 'resume');
    } else {
      // No ID: the first tab for this agent+folder resumes the latest session; the others open the picker.
      const k = `${entry.agent}@${entry.cwd}`;
      cmd = commandFor(entry, lastUsed.has(k) ? 'pick' : 'last');
      lastUsed.add(k);
    }

    const si = await waitShellIntegration(t, 4000);
    if (si) si.executeCommand(cmd); else t.sendText(cmd, true);
    if (pid && entry.sessionId) writeMarker(pid, entry); // keeps the link even for agents without a hook
    log.appendLine(`resuming in "${t.name}": ${cmd}`);
  }
}

// ───────────────────────── agent hooks ─────────────────────────

const hookCmd = (agent) => `${HOOK_PATH} ${agent}`;
const OLD_HOOK = 'claude-restore-session.sh'; // previous version (Claude Restore)

function readJson(file) {
  if (!fs.existsSync(file)) return {};
  return JSON.parse(fs.readFileSync(file, 'utf8')); // throws if invalid
}

function writeJson(file, data) {
  if (fs.existsSync(file)) fs.copyFileSync(file, file + '.bak');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(data, null, 2) + '\n');
}

/** Removes the groups that call the Agent Restore hook (or the old Claude Restore one) from an event. */
function removeJsonHooks(file, event) {
  if (!fs.existsSync(file)) return false;
  const s = readJson(file);
  const list = s.hooks?.[event];
  if (!Array.isArray(list)) return false;
  const ours = (x) => JSON.stringify(x).includes(HOOK_PATH) || JSON.stringify(x).includes(OLD_HOOK);
  const kept = list.filter((g) => !ours(g));
  if (kept.length === list.length) return false;
  if (kept.length) s.hooks[event] = kept; else delete s.hooks[event];
  if (!Object.keys(s.hooks).length) delete s.hooks;
  writeJson(file, s);
  return true;
}

/** Per-agent installer: present() tells whether the agent exists; installed()/install()/uninstall() manage the hook. */
const HOOK_TARGETS = {
  claude: {
    file: path.join(HOME, '.claude', 'settings.json'),
    present: () => fs.existsSync(path.join(HOME, '.claude')),
    installed() {
      try { return JSON.stringify(readJson(this.file).hooks?.SessionStart || []).includes(hookCmd('claude')); } catch { return false; }
    },
    uninstall() { return removeJsonHooks(this.file, 'SessionStart'); },
    install() {
      const s = readJson(this.file);
      s.hooks ??= {};
      s.hooks.SessionStart = (s.hooks.SessionStart || []).filter((g) => !JSON.stringify(g).includes(OLD_HOOK));
      s.hooks.SessionStart.push({ hooks: [{ type: 'command', command: hookCmd('claude') }] });
      writeJson(this.file, s);
    }
  },
  codex: {
    file: path.join(HOME, '.codex', 'hooks.json'),
    present: () => fs.existsSync(path.join(HOME, '.codex')),
    installed() {
      try { return JSON.stringify(readJson(this.file).hooks?.SessionStart || []).includes(hookCmd('codex')); } catch { return false; }
    },
    uninstall() { return removeJsonHooks(this.file, 'SessionStart'); },
    install() {
      const s = readJson(this.file);
      s.hooks ??= {};
      s.hooks.SessionStart ??= [];
      s.hooks.SessionStart.push({ hooks: [{ type: 'command', command: hookCmd('codex') }] });
      writeJson(this.file, s);
    },
    note: 'In Codex, open /hooks once and trust the Agent Restore hook.'
  },
  cursor: {
    file: path.join(HOME, '.cursor', 'hooks.json'),
    present: () => fs.existsSync(path.join(HOME, '.cursor')),
    installed() {
      try { return JSON.stringify(readJson(this.file).hooks?.sessionStart || []).includes(hookCmd('cursor')); } catch { return false; }
    },
    uninstall() { return removeJsonHooks(this.file, 'sessionStart'); },
    install() {
      const s = readJson(this.file);
      s.version ??= 1;
      s.hooks ??= {};
      s.hooks.sessionStart ??= [];
      s.hooks.sessionStart.push({ command: hookCmd('cursor') });
      writeJson(this.file, s);
    }
  },
  kimi: {
    file: path.join(KIMI_HOME, 'config.toml'),
    present: () => fs.existsSync(KIMI_HOME),
    installed() {
      try { return fs.readFileSync(this.file, 'utf8').includes('# >>> agent-restore'); } catch { return false; }
    },
    uninstall() {
      if (!fs.existsSync(this.file)) return false;
      const text = fs.readFileSync(this.file, 'utf8');
      const cleaned = text.replace(/\n?# >>> agent-restore[\s\S]*?# <<< agent-restore <<<\n?/g, '\n');
      if (cleaned === text) return false;
      fs.copyFileSync(this.file, this.file + '.bak');
      fs.writeFileSync(this.file, cleaned);
      return true;
    },
    install() {
      const block = [
        '', '# >>> agent-restore (managed by the Agent Restore extension) >>>',
        '[[hooks]]', 'event = "SessionStart"', `command = ${JSON.stringify(hookCmd('kimi'))}`, 'timeout = 10',
        '# <<< agent-restore <<<', ''
      ].join('\n');
      if (fs.existsSync(this.file)) fs.copyFileSync(this.file, this.file + '.bak');
      fs.mkdirSync(path.dirname(this.file), { recursive: true });
      fs.appendFileSync(this.file, block);
    }
  }
};

function copyHookScript(context) {
  fs.mkdirSync(path.dirname(HOOK_PATH), { recursive: true });
  fs.copyFileSync(path.join(context.extensionPath, 'agent-restore-hook.sh'), HOOK_PATH);
  fs.chmodSync(HOOK_PATH, 0o755);
}

function missingHooks() {
  return Object.entries(HOOK_TARGETS).filter(([, t]) => t.present() && !t.installed()).map(([k]) => k);
}

async function installHooks(context, agents = missingHooks()) {
  copyHookScript(context);
  const done = [], notes = [];
  for (const agent of agents) {
    const target = HOOK_TARGETS[agent];
    try {
      target.install();
      done.push(AGENTS[agent].label);
      if (target.note) notes.push(target.note);
    } catch (e) {
      vscode.window.showErrorMessage(`Agent Restore: could not configure ${AGENTS[agent].label} (${target.file}): ${e.message}`);
    }
  }
  if (done.length) {
    vscode.window.showInformationMessage(`Agent Restore: session hook installed for ${done.join(', ')}. It applies to sessions started from now on. ${notes.join(' ')}`);
  } else if (!agents.length) {
    vscode.window.showInformationMessage('Agent Restore: hooks are already installed.');
  }
}

async function uninstallHooks(context) {
  const removed = [];
  for (const [agent, target] of Object.entries(HOOK_TARGETS)) {
    try { if (target.uninstall()) removed.push(AGENTS[agent].label); }
    catch (e) { vscode.window.showErrorMessage(`Agent Restore: could not clean ${target.file}: ${e.message}`); }
  }
  try { fs.unlinkSync(HOOK_PATH); } catch { /* already gone */ }
  await context.globalState.update('agentRestore.declined', Object.keys(HOOK_TARGETS)); // do not offer again
  vscode.window.showInformationMessage(removed.length
    ? `Agent Restore: hooks removed from ${removed.join(', ')} (a .bak backup sits next to each file).`
    : 'Agent Restore: no hooks to remove.');
}

async function offerHookInstall(context) {
  copyHookScript(context); // keep the script up to date
  const missing = missingHooks();
  const declined = context.globalState.get('agentRestore.declined', []);
  const toOffer = missing.filter((a) => !declined.includes(a));
  if (!toOffer.length) return;
  const names = toOffer.map((a) => AGENTS[a].label).join(', ');
  const pick = await vscode.window.showInformationMessage(
    `Agent Restore: install the session hook for ${names}? It lets each terminal reopen exactly its own session.`,
    'Install', 'Not now'
  );
  if (pick === 'Install') await installHooks(context, toOffer);
  else if (pick === 'Not now') await context.globalState.update('agentRestore.declined', [...declined, ...toOffer]);
}

function cleanupOldMarkers() {
  try {
    const limit = Date.now() - 30 * 24 * 3600 * 1000;
    for (const f of fs.readdirSync(STATE_DIR)) {
      const p = path.join(STATE_DIR, f);
      if (fs.statSync(p).mtimeMs < limit) fs.unlinkSync(p);
    }
  } catch { /* folder does not exist yet */ }
}

// ───────────────────────── activation ─────────────────────────

async function activate(context) {
  log = vscode.window.createOutputChannel('Agent Restore');
  context.subscriptions.push(
    log,
    vscode.commands.registerCommand('agentRestore.installHooks', () => installHooks(context)),
    vscode.commands.registerCommand('agentRestore.uninstallHooks', () => uninstallHooks(context))
  );
  if (process.platform === 'win32') return;

  offerHookInstall(context).catch((e) => log.appendLine(`hook setup error: ${e}`));
  cleanupOldMarkers();

  // Restore from the previous snapshot BEFORE it starts being overwritten.
  const previous = context.workspaceState.get(SNAPSHOT_KEY) || [];
  if (vscode.workspace.getConfiguration('agentRestore').get('enabled', true)) {
    try { await restore(previous); } catch (e) { log.appendLine(`restore error: ${e}`); }
  }

  const snap = () => takeSnapshot(context).catch((e) => log.appendLine(`snapshot error: ${e}`));
  const timer = setInterval(snap, 3000);
  context.subscriptions.push(
    { dispose: () => clearInterval(timer) },
    vscode.window.onDidOpenTerminal(snap),
    vscode.window.onDidCloseTerminal(snap),
    vscode.window.onDidEndTerminalShellExecution(snap)
  );
  snap();
}

module.exports = { activate, deactivate() {}, _internal: { HOOK_TARGETS, installHooks, uninstallHooks } };
