# Manual do cordova-devbridge

Guia para instalar o devbridge numa máquina e configurá-lo num app Cordova/AngularJS do zero. O [README](../README.md) tem a visão geral e a referência dos comandos; este manual segue a ordem em que as coisas acontecem.

Nos exemplos, o app se chama `MeuApp`, tem o id `com.exemplo.meuapp` e o alias do devbridge é `dvb`.

## 1. Pré-requisitos da máquina

| O quê | Para quê | Como conferir |
|---|---|---|
| Node.js 20 ou mais novo | rodar o devbridge (sem `npm install`: ele não tem dependências) | `node --version` |
| `adb` no PATH | `adb reverse`, instalar o APK, `run-as`, screenshot | `adb version` |
| Ambiente de build do Cordova (Cordova CLI, Android SDK, Java, Gradle) | o `dvb build` roda `cordova prepare` e `cordova compile android --debug` | `cordova build android` funciona no app |
| Celular com **depuração USB** ligada e o PC autorizado | toda a comunicação passa pelo cabo | `adb devices` mostra o aparelho como `device` (não `unauthorized`) |

Não precisa de sudo: tudo roda do diretório do usuário.

## 2. Instalar o devbridge

```bash
git clone https://github.com/ya-labs/cordova-devbridge.git ~/Documentos/GitHub/cordova-devbridge
echo "alias dvb='node ~/Documentos/GitHub/cordova-devbridge/bin/devbridge.js'" >> ~/.bash_aliases
source ~/.bash_aliases
dvb --help
```

Se a sua distribuição não carrega o `~/.bash_aliases`, use o `~/.bashrc`.

**Atualizar:** `git -C ~/Documentos/GitHub/cordova-devbridge pull`. Reinicie o `dvb start` depois. O APK dev só precisa de novo `dvb build` se a atualização disser que mudou algo no build.

## 3. Preparar o app

### 3.1 Plugins obrigatórios

O app precisa ter:
- `cordova-plugin-enable-cleartext-traffic`: o WebView do Android bloqueia `http://` por padrão, e o APK dev carrega `http://localhost:8100`. O `dvb build` avisa se o manifest gerado não tiver `usesCleartextTraffic="true"`.
- um plugin SQLite que exponha `window.sqlitePlugin` (`cordova-sqlite-storage`, `cordova-sqlite-evcore-*`), para o SQL em tempo real.

```bash
grep -o 'cordova-plugin-enable-cleartext-traffic\|cordova-sqlite[a-z-]*' package.json
```

### 3.2 Criar a config

Na raiz do app (onde está o `config.xml`):

```bash
dvb init
```

O `init` lê o `<widget id>` do `config.xml` e cria um `devbridge.config.json` com um banco de exemplo. Ajuste os bancos conforme a seção seguinte.

### 3.3 Descobrir os bancos do app

Cada banco da config tem um `name` (o arquivo) e, de preferência, um `global` (a variável onde o app guarda a conexão aberta). Para achar os dois:

```bash
grep -rn "openDatabase" www/js --include=*.js | grep -v '\.min\.'
```

Exemplo de resultado:

```js
db = window.sqlitePlugin.openDatabase({ name: "MeuApp_" + usuario + ".db", location: 'default' });
dbconfig = window.sqlitePlugin.openDatabase({ name: "MeuAppConfig.db", location: 'default' });
```

Daí sai a config:

```json
{
  "package": "com.exemplo.meuapp",
  "port": 8100,
  "allowWrites": true,
  "defaultDb": "user",
  "databases": {
    "user": { "global": "db", "name": "MeuApp_*.db" },
    "config": { "global": "dbconfig", "name": "MeuAppConfig.db" }
  }
}
```

- **`global`:** com a conexão aberta pelo app, o devbridge usa exatamente o mesmo banco que a tela está usando. Só funciona se a variável for global (`var db` no topo de um script, ou `window.db`).
- **`name` com `*`:** para bancos com parte variável (usuário, tenant). O devbridge lista os arquivos do aparelho via `adb run-as` e escolhe o que casa. Se casar com mais de um e o app ainda não abriu a conexão (antes do login, por exemplo), o comando pede `--db <arquivo.db>`.
- **`allowWrites`:** deixe `false` se ninguém precisa alterar dados pelo PC. Mesmo com `true`, toda escrita exige um pedido explícito (`--write`, `db_exec` ou o checkbox "escrita" do console).

Para conferir os arquivos que existem no aparelho (exige o APK debug instalado):

```bash
adb shell run-as com.exemplo.meuapp ls databases
```

### 3.4 Ignorar a pasta de trabalho

```bash
echo ".devbridge/" >> .gitignore
```

Nela ficam o histórico de SQL de escrita, as cópias de banco e os screenshots. O `devbridge.config.json` pode ser versionado: não tem segredo.

## 4. Primeiro uso

Com o celular no cabo:

```bash
# terminal 1, na raiz do app: deixa rodando
dvb start

# terminal 2: compila e instala o APK dev (~30 s)
dvb build
```

A ordem importa: o `build` só abre o app se o `start` estiver respondendo. Sem servidor, o WebView mostra uma página de erro de conexão e não tenta de novo.

Para conferir:

```bash
dvb status            # "app" com href, deviceReady: true e as conexões abertas
dvb tables            # tabelas do banco padrão
dvb logs              # console do app desde o boot
```

O `dvb build` instala com `adb install -r`, por cima do app que já estiver no aparelho, **sem apagar os dados**. Ele falha com `INSTALL_FAILED_UPDATE_INCOMPATIBLE` se o app instalado foi assinado com outra chave (um build release, por exemplo). Aí só desinstalando (`adb uninstall com.exemplo.meuapp`), o que **apaga o banco local**: sincronize antes.

## 5. Reload: mesma tela, tela inicial ou restauração

Salvar um `.js` ou `.html` em `www/` recarrega o app. Salvar só `.css` troca o estilo sem recarregar. O que acontece depois do reload depende do app:

| Situação do app | Config | Resultado |
|---|---|---|
| O boot funciona em qualquer rota (sem login, sem banco aberto no início) | nada (padrão `reloadKeepRoute: true`) | volta na mesma tela |
| O boot só funciona pela rota inicial (o `otherwise` espera o `deviceready` e abre o banco) | `"reloadKeepRoute": false` | volta pela tela inicial, sem erro |
| Igual ao anterior, mas você quer voltar logado na mesma tela | `"reloadRestore": "devbridge.restore.js"` | volta na mesma tela, com a camada "Recarregando…" enquanto isso |

**Como saber se precisa:** salve um `.js` com o app numa tela interna. Se ele voltar com `{{expressões}}` cruas, ou com `executeSql` de `null` em `dvb logs --level error`, o boot depende da rota inicial. Para sair da tela quebrada: `dvb launch`.

### Escrevendo o `devbridge.restore.js`

O script fica na raiz do app, **fora do `www/`**, então nunca entra no build. O servidor o injeta logo depois do client. Ele registra duas funções:

- `save()`: roda antes do reload. Devolve o que precisa sobreviver (usuário logado, contexto da tela). Vai para o `sessionStorage` em JSON, então não pode ter referência circular nem funções.
- `restore(saved, done)`: roda depois do `deviceready`. Recebe `saved.hash` (a rota de antes) e `saved.app` (o que o `save` devolveu). Refaz o que o login faria, navega para a tela e chama `done()`; `done('motivo')` em caso de erro.

```js
(function () {
  var bridge = window.__devbridge;
  if (!bridge) return;
  // Serviços do AngularJS acessíveis de fora (ng-app no <body>).
  function svc(name) { return angular.element(document.body).injector().get(name); }

  bridge.restore({
    save: function () {
      var user = svc('Sessao').usuario();
      return user ? { user: user } : null;
    },
    restore: function (saved, done) {
      if (!saved.app) return done();              // ninguém logado: segue o boot normal
      // Espera o boot normal chegar na tela de login com o banco de configuração aberto.
      bridge.waitFor(function () { return window.dbconfig && svc('$state').current.name === 'Login'; }, function (err) {
        if (err) return done(err);
        svc('Sessao').entrar(saved.app.user, function () {
          var tela = saved.hash.replace(/^#!?\//, '') || 'Home';
          svc('$rootScope').$evalAsync(function () { svc('$state').go(tela); });
          bridge.waitFor(function () { return svc('$state').current.name === tela; }, done, 10000);
        });
      });
    }
  });
})();
```

Para escrever o seu, leia o que o login do app faz de verdade (geralmente: guarda o usuário num serviço, abre o banco do usuário, navega para a home) e repita esses passos no `restore`. Pontos de atenção:
- callbacks nativos (SQLite, NativeStorage) rodam fora do digest do AngularJS: navegue dentro de `$evalAsync`;
- compare a tela por `$state.current.name`; variáveis globais atualizadas em eventos de rota podem estar atrasadas;
- a restauração é tentada uma vez por reload. Se não terminar em 30 s, a camada some e o motivo aparece em `dvb logs --level warn`.

Para testar: entre numa tela interna, salve um `.js` e confira `dvb status` (o `href` deve ser a mesma tela) e `dvb logs --level warn,error`.

## 6. Console web

Abra `http://localhost:8100/__devbridge/` no navegador do PC:
- lista de tabelas, grade, SQL com Ctrl+Enter e histórico;
- logs do app ao vivo;
- com "escrita" ligada: duplo clique edita a célula, "+ Registro" inclui, ✕ exclui (com confirmação);
- botão para recarregar o app;
- botão "Tela", que abre a tela do celular ao vivo numa janela separada (`/__devbridge/mirror`): 4 a 5 quadros por segundo, espaço pausa e o download salva o quadro em PNG. Para não pesar no celular, a captura para quando a janela é minimizada ou fechada. Se o navegador bloquear a janela, permita pop-ups de `localhost:8100`.

Não abra `http://localhost:8100/` (sem `/__devbridge/`): é o próprio app, que trava no Chrome do PC. O servidor redireciona essa URL para o console; `/?app` força o app, se for mesmo necessário.

## 7. MCP para agentes de IA

O `dvb mcp` expõe ao Claude Code (ou ao Codex) as ferramentas `app_status`, `app_reload`, `app_logs`, `db_query`, `db_tables`, `db_schema`, `app_screenshot` e, com `allowWrites`, `db_exec`. Ele conversa com o `dvb start`, que precisa estar rodando.

Registro, na raiz do app:

```bash
claude mcp add devbridge -- node ~/Documentos/GitHub/cordova-devbridge/bin/devbridge.js mcp
```

- Esse comando registra só para você, nesse projeto (escopo `local`, em `~/.claude.json`). Com `--scope project`, ele cria um `.mcp.json` versionado no app, para o time inteiro; o caminho do devbridge precisa ser o mesmo em todas as máquinas.
- O MCP é carregado quando a sessão começa: abra uma conversa nova depois de registrar.
- Se `claude` não existir no terminal (você usa só a extensão do VS Code), o binário fica em `~/.vscode/extensions/anthropic.claude-code-<versão>/resources/native-binary/claude`.
- Para conferir: `claude mcp get devbridge` deve mostrar `Connected`. Na conversa, peça o `app_status`.

## 8. Voltar ao APK normal

O patch do APK dev fica só no `config.xml` gerado em `platforms/`. Qualquer `cordova build android` ou `cordova run android` refaz esse arquivo e gera o APK comum, que funciona sem cabo e sem servidor. Para voltar ao modo dev, `dvb build` de novo.

Lembre que no modo dev a origem é `http://localhost:8100`, e não `file://`: `localStorage` e IndexedDB são separados entre os dois modos. SQLite, NativeStorage e arquivos são os mesmos.

## 9. Solução de problemas

| Sintoma | Causa provável | O que fazer |
|---|---|---|
| O app abre numa página de erro de conexão | APK dev aberto sem o `dvb start` | `dvb start` e depois `dvb launch` |
| `dvb status` diz que nenhum app está conectado, com o app aberto | celular bloqueado (WebView pausado), cabo solto ou `adb reverse` caiu | desbloqueie o celular; confira `adb devices` e `adb reverse --list`; o `start` refaz o reverse sozinho quando o cabo volta |
| `INSTALL_FAILED_UPDATE_INCOMPATIBLE` no build | app instalado com outra assinatura | sincronize os dados e `adb uninstall <package>`; o banco local é apagado |
| `{{expressões}}` cruas ou `executeSql` de `null` depois do reload | boot depende da rota inicial | `reloadKeepRoute: false` ou `reloadRestore` (seção 5); `dvb launch` para sair |
| Todo reload volta para o login | `reloadKeepRoute: false` sem restauração | escreva o `devbridge.restore.js` (seção 5) |
| `"user" casa com vários bancos` | nome com `*` e a conexão do app ainda não aberta | faça login no app, ou use `--db <arquivo.db>` |
| `pull-db`/`run-as` falha (`not debuggable`) | APK instalado não é debug | `dvb build` (ele compila em debug) |
| Console web fica carregando para sempre | aba de `localhost:8100/` (o app) aberta no Chrome, travando o processo do site | feche todas as abas de `localhost:8100` (Shift+Esc no Chrome) e abra só `/__devbridge/` |
| SQL ou status parecem vir de outro lugar | outra página com o client conectada | `dvb status` mostra o `userAgent` do client ativo e `server.clients`; feche a aba extra |
| No `chrome://inspect`, todo log aponta para `client.js` | source maps desligados no DevTools; sem o map, o client não entra na ignore list | DevTools → Settings → Preferences → Sources → **Enable JavaScript source maps**; em Settings → Ignore list, deixe ligado **Automatically add known third-party scripts to ignore list** |
| Mudança de CSS não aparece | o arquivo não está ligado por `<link>` no `index.html` | o devbridge recarrega a página nesse caso; confira `dvb logs` |
| `AVISO: AndroidManifest sem usesCleartextTraffic` no build | falta o plugin de cleartext | instale `cordova-plugin-enable-cleartext-traffic` e rode `dvb build` |
| Mudou plugin nativo, `config.xml`, ícone ou permissão e nada mudou | essas coisas vivem no APK, não no `www/` | `dvb build` |
