# Handoff — monorepo `vscode-extensions`

Quatro extensões do VS Code para quem trabalha com agentes de código em workspaces multi-root.
O código-fonte de referência está em `vscode-extensions.zip` (JavaScript puro, sem build), e os `.vsix` em `dist/` servem como referência de comportamento correto.

---

## 1. Estrutura

```
vscode-extensions/
├── packages/
│   ├── agent-commit/          # mensagem de commit via CLI de agente
│   ├── agent-restore/         # retoma sessões de agentes nas abas restauradas
│   ├── workspace-terminals/   # terminal na raiz da workspace
│   └── midnight-theme/        # tema
├── scripts/
│   ├── check.mjs              # sintaxe + campos obrigatórios do package.json
│   ├── package-all.mjs        # gera um .vsix por pacote em dist/
│   └── set-publisher.mjs      # define publisher/repository em todos
├── .github/workflows/publish.yml   # publica por tag <nome>@<versão>
├── package.json               # npm workspaces; devDeps: @vscode/vsce, ovsx
└── README.md / LICENSE (MIT)
```

Cada pacote tem `package.json`, `extension.js` (exceto o tema), `README.md`, `CHANGELOG.md`, `LICENSE`, `icon.png` (256×256) e `.vscodeignore`.

Convenções:
- Sem dependências de runtime; só a API `vscode` e módulos do Node.
- **Tudo em inglês**: interface, configurações, mensagens, comentários, READMEs e descrições do Marketplace. Decisão do usuário, pelo alcance.
- Ícones: quadrado arredondado com fundo grafite em gradiente e o símbolo em gradiente na cor de destaque de cada extensão. Para strokes em linha reta, use `gradientUnits="userSpaceOnUse"`, senão a linha some.
- `publisher` está como `your-publisher` e `repository` como `your-user/vscode-extensions`: rode `npm run set-publisher -- <id> <dono/repo>`.

---

## 2. Agent Commit (`packages/agent-commit`)

**Objetivo:** gerar a mensagem de commit com o CLI de agente do usuário, no repositório certo, mesmo com muitos repositórios abertos.

**Comportamento:**
- Botão `$(sparkle)` em `scm/title` (`when: scmProvider == git`), ou seja, no cabeçalho de cada repositório no Source Control.
- O repositório é resolvido nesta ordem, sem perguntar ao usuário:
  1. Argumento do clique: `arg.rootUri` (SourceControl, botão do cabeçalho), `arg.resourceStates[0].resourceUri` (grupo de alterações), `arg.resourceUri` ou `arg.fsPath`. Casar por igualdade e, se não bater, pelo **prefixo mais longo** (repositórios aninhados).
  2. Único repositório aberto.
  3. Repositório selecionado no painel (`repo.ui.selected`).
  4. Repositório do arquivo ativo no editor.
  5. Só então mostrar um QuickPick.
- **Conteúdo enviado ao agente:**
  - `git diff --cached`.
  - Se estiver vazio: `git diff` mais a lista de não rastreados (`git ls-files --others --exclude-standard`), e aviso na status bar.
  - `--stat`.
  - `git log -n 15 --format=%s`, para imitar o estilo e o idioma.
- **Prompt:** devolver só a mensagem; Conventional Commits (ou estilo do repositório); resumo no imperativo, até 72 caracteres; corpo em bullets só se necessário; idioma `auto`, que segue os commits recentes ou cai em inglês.
- **Execução:**
  - `spawn(command, { shell: $SHELL, cwd: raiz do repo })`, com o prompt pelo **stdin**.
  - Timeout configurável.
  - Cancelável pelo progresso (`ProgressLocation.SourceControl`).
- **Limpeza da saída:** remove cercas ```` ``` ````, o prefixo "Commit message:" e aspas em volta de uma linha só.
- **Resultado:** `repo.inputBox.value = mensagem`, usando a API do `vscode.git` (`extensionDependencies: ["vscode.git"]`).
- **Erro:** notificação com o botão "Configure command", que abre `agentCommit.command`.

**Configurações:** `command` (`claude -p`), `language` (`auto`), `style` (`conventional` | `repository`), `instructions`, `maxDiffChars` (60000), `timeoutSeconds` (120), `notifyWhenUnstaged`.

**Contexto:** substitui o uso do `juanlb.claude-commit`, que tinha um bug em multi-root. Ele lia `(uri as any).E?.fsPath || uri.path` do argumento do `scm/title`; como o argumento é um `SourceControl`, sem `.path`, sempre caía no seletor. O código foi escrito do zero, sem copiar o original.

---

## 3. Agent Restore (`packages/agent-restore`)

**Objetivo:** quando o VS Code restaura os terminais (`terminal.integrated.enablePersistentSessions`), cada aba volta **automaticamente**, sem menu, para a sessão do agente que rodava nela.

**Por que é necessário:** o VS Code restaura a aba, a pasta e o scrollback, mas recria o shell. O processo do agente não volta.

**Arquitetura:**

1. **Hook de início de sessão** (`agent-restore-hook.sh <agente>`), copiado para `~/.local/share/agent-restore/agent-restore-hook.sh`:
   - Lê o JSON do stdin e extrai `session_id` (ou `conversation_id`, no Cursor) e `cwd`.
   - Sobe na árvore de processos a partir de `$PPID`: primeiro acha o processo do agente (padrão por agente), depois o primeiro shell acima dele (`zsh|bash|fish`). Esse é o PID do shell da aba.
   - Grava `~/.cache/agent-restore/<pid-do-shell>` com 3 linhas: agente, id da sessão, cwd.
   - No Cursor imprime `{}` (ele espera JSON). Nos outros não imprime nada: no Codex, o stdout de `SessionStart` vira contexto do modelo.
   - No Claude Code e no Codex o hook também dispara em `/resume` e `/clear`, então acompanha a troca de conversa.

2. **Snapshot** (a cada 3 s e em abrir/fechar terminal e fim de comando):
   - Para cada `vscode.window.terminals[i]`, pega `await t.processId` (PID do shell).
   - Monta a árvore com `ps -A -o pid=,ppid=,args=` e acha o agente **mais próximo do shell**, em busca em largura. Se o Claude rodar um Codex por dentro, vale o Claude.
   - Se houver marcador do mesmo agente: grava `{index, name, agent, sessionId, cwd}`. Se não houver (hook não disparou): grava `sessionId: null` e o cwd vindo de `shellIntegration.cwd` ou `creationOptions.cwd`.
   - Salva em `workspaceState['agentRestore.snapshot']`, por workspace.
   - **Carência de remoção de 8 s:** uma entrada que some só é tirada do snapshot depois de 8 s. Ao fechar o VS Code, os shells morrem segundos antes da extensão parar; sem a carência, o snapshot ficaria vazio.

3. **Restauração** (na ativação, `onStartupFinished`, **antes** do primeiro snapshot):
   - Espera a quantidade de terminais ficar estável por 2 s (máximo de 20 s).
   - Casa pela posição (`index`) e pelo nome. Se não bater, usa a primeira aba livre com o mesmo nome. No máximo uma entrada por índice.
   - Se a aba já tem um agente vivo (caso de *Reload Window*), não faz nada.
   - Comando:
     - Com ID: `cd '<cwd>' && <resume com id>`.
     - Sem ID: a primeira aba de cada agente+pasta usa `last` (continuar a última); as demais usam `pick` (seletor).
   - Envia com `shellIntegration.executeCommand` (espera até 4 s) ou, na falta, `sendText`.
   - Depois de retomar com ID, regrava o marcador para o novo PID. Isso mantém o vínculo mesmo em agentes sem hook.

**Agentes:**

| Agente | Hook (instalado pela extensão) | resume | last | pick |
|---|---|---|---|---|
| claude | `~/.claude/settings.json` → `hooks.SessionStart[].hooks[] {type:"command"}` | `claude --resume {id}` | `claude --continue` | `claude --resume` |
| codex | `~/.codex/hooks.json` (mesmo formato) | `codex resume {id}` | `codex resume --last` | `codex resume` |
| cursor | `~/.cursor/hooks.json` → `{version:1, hooks.sessionStart[] {command}}` | `cursor-agent --resume={id}` | `cursor-agent --continue` | `cursor-agent ls` |
| kimi | `$KIMI_CODE_HOME` ou `~/.kimi-code/config.toml` → bloco `[[hooks]] event="SessionStart"`, entre `# >>> agent-restore` e `# <<< agent-restore <<<` | `kimi --session {id}` | `kimi --continue` | `kimi --session` |
| opencode | nenhum (a API de plugins não emite evento ao retomar e está mudando de versão) | `opencode --session {id}` | `opencode --continue` | `opencode` |

Os comandos podem ser trocados por agente em `agentRestore.commands`.

**Instalação e remoção dos hooks:**
- Na ativação, oferece instalar só nos agentes cujo diretório de configuração existe. "Agora não" fica guardado por agente em `globalState`.
- Sempre cria um `.bak` antes de escrever e preserva o conteúdo existente.
- Remove a entrada antiga `claude-restore-session.sh`, de uma versão anterior.
- O comando **Remover hooks** limpa todos os alvos, apaga o script do hook e marca todos como recusados. O teste confirmou que os arquivos voltam idênticos ao original.
- Codex: o usuário precisa aprovar o hook uma vez em `/hooks` (hooks não gerenciados exigem confiança).

**Limitações conhecidas:**
- Windows não é suportado (a extensão sai cedo em `win32`).
- Algumas versões do Cursor CLI não executam hooks; nesse caso vale o fallback `last`.
- O nome atual do binário do Cursor é `agent`, mas o padrão está `cursor-agent`.
- O padrão de processo `(^|/)agent(\s|$)` do Cursor é genérico.
- A extensão depende de o VS Code reabrir as abas na mesma ordem e com o mesmo nome.

**Histórico (para não repetir):**
- Primeira tentativa: um script zsh (`claude-resume.zsh`) com menu interativo. O usuário rejeitou: ele quer retomada automática por aba, não um `--resume` com menu.
- Além disso, o script conflitava com a extensão: o `read` do menu engolia o comando que a extensão digitava.
- Não usar `environmentVariableCollection` para dar um ID por aba. O valor seria o mesmo para todas, e a restauração pode reaplicá-lo.

---

## 4. Workspace Terminals (`packages/workspace-terminals`)

**Objetivo:** abrir um terminal na **raiz da workspace**, que é `dirname(vscode.workspace.workspaceFile)`. Em janela de uma pasta só, é a própria pasta.

**Comportamento:**
- Botão dedicado em `view/title` (`when: view == terminal`), com ícone próprio: pasta com `>_` (`media/root-terminal-{light,dark}.svg`). Abre direto, sem seletor.
- Perfil de terminal `workspaceTerminals.root` ("Workspace Root") no menu nativo ⌄, via `contributes.terminal.profiles` e `registerTerminalProfileProvider`.
- `Ctrl+`` e `Ctrl+Shift+`` com `when: terminalCount == 0` abrem na raiz.

**Restrições da plataforma (já verificadas, não insistir):**
- O seletor nativo "Select current working directory for new terminal" (aberto pelo **+**) **não é extensível**. Ele lista só as pastas da workspace.
- Não dá para esconder uma pasta da workspace no Explorer. O `files.exclude` só esconde o conteúdo, e não há API para isso.
- Não dá para mudar o comportamento do **+** nem do menu **Terminal → New Terminal**.
- `terminal.integrated.cwd: "${workspaceFolder}/.."` funciona, mas faz **todo** terminal abrir na raiz. O usuário rejeitou.

**Histórico de preferência do usuário:** um botão que faz uma coisa só (abrir na raiz). Ele rejeitou o seletor com várias pastas.

---

## 5. Midnight (`packages/midnight-theme`)

- Tema `vs-dark` em `themes/midnight-color-theme.json`, rótulo "Midnight". **Não usar "Orca" no nome.**
- A paleta vem do Orca Midnight (Stably AI, MIT). A licença original fica em `LICENSE.orca-midnight`, e o README dá o crédito e diz que o tema não é afiliado.
- **Tokens:**
  - fundo `#101216`;
  - editor e terminal `#0c0e12`;
  - texto `#e8eaf0`;
  - texto secundário `#9ca7bd`;
  - bordas `#2a2f3a`.
- **Sintaxe:**
  - palavra-chave `#b9a7f8`;
  - função `#86b6ff`;
  - tipo `#76d2d0`;
  - string `#a6d9a0`;
  - número `#f2a97f`;
  - comentário `#7f879a`.
- **ANSI:** normal `#20242c #ff7b7b #a6d9a0 #f0c27b #86b6ff #b9a7f8 #76d2d0 #dfe2e9`; bright `#7f879a #ff9a9a #bfe6ba #f5d49e #a6c9ff #cdc0fa #98e0de #f4f5f8`.
- **Botões:** `button.background #262b36`, hover `#303644`. O botão branco do tema original foi rejeitado pelo usuário.
- Fora do monorepo, já entregues: perfil do Terminal.app (`Orca Midnight.terminal`) e YAML de tema de terminal do Orca com a mesma paleta.

---

## 6. Testes já feitos (simulados, não no VS Code real)

O ambiente de teste usava um mock de `vscode` via `NODE_PATH` e CLIs falsos, que eram scripts com o nome do agente chamando o hook por `sh -c` e depois `sleep`, rodando sob `zsh -c`.

- **Agent Commit:**
  - repositórios Git reais;
  - botão no repo A escreve só no A;
  - só staged entra no diff;
  - sem staged, inclui não rastreados;
  - commits recentes no prompt;
  - limpeza de cercas e prefixos.
- **Agent Restore:**
  - marcadores corretos para claude, codex, cursor e kimi;
  - o Cursor recebe `{}` no stdout e o Codex não recebe nada;
  - snapshot com 5 agentes;
  - restauração enviando o comando certo para cada aba, incluindo o opencode no fallback;
  - carência de 8 s;
  - instalação e remoção de hooks preservando configs, com o TOML do Kimi continuando válido.

**Pendente: validação real.**
- Abrir 2–3 abas com agentes diferentes, fechar o VS Code, reabrir e conferir **Output → Agent Restore**.
- Confirmar o Agent Commit com `claude -p` autenticado.
- Confirmar os ícones e o botão no painel.

O usuário já viu a extensão identificar a sessão certa no mundo real; o problema era só o conflito com o script antigo.

---

## 7. Pendências e decisões em aberto

1. `npm run set-publisher -- <publisher> <dono/repo>`. O nome no `LICENSE` está só "Jean".
2. Segredos do GitHub: `VSCE_PAT` (Azure DevOps, escopo Marketplace → Manage) e `OVSX_PAT` (open-vsx.org). Publicar com `git tag <nome>@<versão> && git push --tags`.
3. Agent Restore: considerar
   - padrão `agent` para o Cursor, detectando qual binário existe;
   - plugin do OpenCode quando a API estabilizar;
   - Windows.
4. Na máquina do usuário:
   - desinstalar as versões antigas (`juanlb.claude-commit` e o fork, Orca Midnight local, Workspace Terminals e Claude/Agent Restore com publisher `jean`);
   - tirar `source claude-resume.zsh` do `~/.zshrc` e apagar `~/.cache/claude-resume`.
