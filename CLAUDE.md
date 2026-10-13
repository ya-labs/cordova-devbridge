# cordova-devbridge: guia para agentes

Ferramenta de desenvolvimento para apps Cordova/AngularJS no Android, usada em Linux com o celular via USB/adb. Contexto pessoal (apps, pessoas, memória) fica no `CLAUDE.local.md`, fora do git. O uso está descrito no [README.md](README.md). Este arquivo registra as decisões e o que um agente precisa saber antes de mexer.

## O que o projeto resolve

1. **Build lento a cada alteração.** Um APK "dev" carrega `www/` do PC (`http://localhost:8100` via `adb reverse`). Salvar um arquivo recarrega o app; mudança só de CSS é trocada sem reload.
2. **SQLite do app em tempo real** pela CLI, pelo console web (`/__devbridge/`) ou pelo MCP.
3. **Ciclo do agente:** editar → `app_reload` → `app_logs` / `db_query` / `app_screenshot`.

## Mapa do código

| Arquivo | Papel |
|---|---|
| `bin/devbridge.js` | CLI: parse de argumentos e comandos |
| `src/config.js` | acha e normaliza o `devbridge.config.json` do app; `resolveDatabase` |
| `src/server.js` | `DevServer`: HTTP estático, SSE para o app, API `/__devbridge/api/*`, watcher, histórico de SQL |
| `src/static.js` | resolve arquivos (platform_www sobre www) e injeta o client |
| `src/client/devbridge-client.js` | roda **dentro do app**: logs, reload, troca de CSS, executa SQL |
| `src/sqlguard.js` | classifica o SQL como leitura ou escrita e exige uma instrução por chamada |
| `src/devbuild.js` | prepare → patch do `config.xml` gerado → compile → `adb install` → `launchIfServerUp` (só reabre o app se o servidor responder) |
| `src/adb.js` | reverse, `run-as`, screencap, install |
| `src/mcp.js` | servidor MCP mínimo (JSON-RPC por stdio, sem SDK) |
| `src/ui/index.html` | console web autocontido (sem CDN) |
| `test/` | `units`, `e2e` (o client real em `node:vm`), `mcp` (processo real por stdio) e `devbuild` (decisão de abrir o app) |

## Decisões (não reverter sem motivo)

- **Zero dependências.** Só Node 20+ e adb. Por isso a comunicação usa SSE + POST, e não WebSocket, e o MCP é escrito à mão.
- **Patch só no `config.xml` gerado** (`platforms/android/app/src/main/res/xml/config.xml`), nunca no versionado. O cordova-android aceita um `<content src>` com esquema como URL inicial (`ConfigXmlParser.setStartUrl`). O acesso ao bridge segue o `<allow-navigation>` (`CordovaPlugin.shouldAllowBridgeAccess`). O próximo `cordova prepare` desfaz o patch, então nada vaza para o release.
- **Resolução por arquivo:** primeiro `platform_www`, depois `www`. Há app real com `www/plugins/cordova-plugin-advanced-http/`, com o mesmo nome do plugin Cordova, e uma fusão por diretório quebraria.
- **O client é injetado só em `www/index.html`.** Os templates do AngularJS também são `.html` e chegam por XHR. Ele entra como primeiro script do `<head>`, para capturar logs do boot e continuar recebendo reload mesmo se o app quebrar.
- **O client é ES5** (`var`, `function`), para não depender da versão do WebView.
- **Segurança do banco:**
  - a leitura é o padrão;
  - a escrita exige `allowWrites` na config **e** um pedido explícito (`--write`, `db_exec` ou o checkbox da UI);
  - a leitura roda em `readTransaction`, então o próprio plugin recusa escrita;
  - toda escrita vai para `.devbridge/sql-history.log`.
- **Segurança do servidor:** escuta só em `127.0.0.1`. A API exige o header `X-Devbridge: 1`, que força um preflight CORS e assim barra CSRF de outras páginas abertas no navegador.
- **Reload mantém a rota por padrão** (`reloadKeepRoute: true`). Com `false`, o client limpa o hash via `history.replaceState` antes do `location.reload()`, nos quatro caminhos de reload (arquivo salvo, `reload`/`app_reload`, servidor reiniciado e CSS sem `<link>` correspondente). A opção chega ao client no evento `hello`. Motivo: há apps cujo boot só acontece na rota do `otherwise` (#3).
- **Client ativo:** com mais de um client conectado, o servidor escolhe o mais recente entre os que dispararam `deviceready` (`readyClients`, guardado por id para sobreviver à reconexão do EventSource). Uma aba do PC em `localhost:8100/` também carrega o client, mas nunca dispara `deviceready`; antes disso, ela roubava SQL e status do celular.
- **Bancos:** o client prefere a conexão global que o app já abriu (por exemplo, `db`). Sem ela, abre pelo nome. Um nome com `*` é resolvido via `adb run-as <pkg> ls databases`.

## Convenções

- Mensagens, comentários e documentação em **português**. O código segue o estilo existente: CommonJS, `'use strict'` e poucos comentários, que explicam o porquê.
- Commits: `tipo: descrição curta` (padrão YABook).
- Testes: `npm test`, que roda `node --test test/*.test.js`. Toda mudança de comportamento ganha um teste. O `test/helpers.js` tem o app falso, o `sqlitePlugin` falso e o client em vm.

## Armadilhas já encontradas

- **Não dá para validar o app inteiro no Chrome do PC.** O `cordova.js` do Android usa `prompt()` como ponte nativa e trava a página, mesmo com `window.prompt` neutralizado via CDP. Para testar o client num navegador real, use uma página mínima sem `cordova.js`. O app em si se valida no aparelho (`chrome://inspect` com o APK debug).
- **`pkill -f <padrão>`** com um padrão que aparece na linha do próprio shell mata o comando (exit 144). Mate pelo PID.
- **`$!` de `cd dir && node ... &`** é o PID do subshell, e matar esse PID pode deixar o node vivo. Rode o node direto em background.
- **Chrome headless via CDP:** no Node 20 é preciso `node --experimental-websocket`.
- **APK dev aberto sem servidor:** o WebView mostra uma página de erro de conexão que não tenta de novo. A ordem certa é `start` → `build`. Se o app ficar preso nessa tela, rode `devbridge launch` com o servidor no ar. Corrigido na issue #1.
- **Hook YABook:** a `main` é protegida, então edições vão por branch de issue. O hook também barra `git merge`, inclusive `--ff-only`, sem pedido explícito; para avançar uma branch local atrás da remota, use `git pull --ff-only`.

## Estado (2026-10-13)

**Feito:**
- Tudo do MVP: build, start, sql, tables, schema, pull-db, screenshot, logs, mcp e o console web com grade editável.
- `npm test`: 26/26.
- Contra um app real: os 66 recursos do `index.html` e os 72 módulos de plugin resolvem com 200.
- `devbridge build --no-install` compila em cerca de 35 s, e o APK sai com `content src="http://localhost:8100/index.html"`.
- No Chrome real, com uma página mínima: conexão, SQL, logs, troca de CSS, reload na mesma rota e edição da grade.
- No aparelho (Android 15), pelo pacote #4:
  - `build` instalando por cima do APK debug existente, sem desinstalar (24 s);
  - o app conecta sozinho;
  - logs do boot;
  - SQL no banco global aberto e no banco por arquivo;
  - `pull-db`, `screenshot` e `launch`;
  - troca de CSS sem reload e reload de JS.
  - `reloadKeepRoute: false` (#3): o reload volta sem hash e o boot passa pela rota inicial, sem erro.
  - depois do login: `tables`, `sql` e `schema` pela conexão global e `pull-db` do banco com `*` (copia todos os arquivos que casam);
  - câmera e foto do checklist com a origem `http://localhost`: fotos gravadas no SQLite, nenhum erro nos logs.

**Pendente (não declarar como validado):**
- Escolha de foto pela galeria (confirmar com a pessoa se foi testada).
- Console web contra o app no aparelho.
- MCP registrado num Claude Code de verdade.
- Um segundo app real, com um banco só.

## Situação atual

Confira com `git log` e `gh issue list` antes de confiar nesta seção.

- O remoto é `ya-labs/cordova-devbridge`, um repo **público**. Não registre aqui nem em issues e PRs: branches, commits ou PRs dos apps que usam a ferramenta; serial de aparelho; dados de banco; nome de cliente. Esse contexto vem da pessoa, na conversa.
- Issue pacote #4 ("Validação do devbridge em app real no aparelho"), branch `4-validacao-app-real`:
  - reúne as correções que a validação revelar, cada uma num commit documentado;
  - o PR sai com merge commit;
  - entregas: #3 (`reloadKeepRoute`) e a preferência pelo client com `deviceready` (uma aba do PC roubava o client ativo).
- Issue #1 (PR #2, mergeado). A entrega dela:
  - o `build` só reabre o app se o `start` responder (`launchIfServerUp`/`serverUp`);
  - o comando `devbridge launch` (`adb.restart`: force-stop + abrir);
  - o README com a ordem `start` → `build`.
- A config de cada app (`devbridge.config.json`) mora no repositório do próprio app, não aqui.
- No modo dev, a origem passa a ser `http://localhost:8100`, então o `localStorage` fica separado do build normal. SQLite, NativeStorage e arquivos continuam os mesmos. Confira o que o app guarda no `localStorage` antes de afirmar que é preciso logar de novo.
- `INSTALL_FAILED_UPDATE_INCOMPATIBLE` no `build` significa que o app instalado tem outra assinatura (por exemplo, um build release). A saída é desinstalar, o que apaga o banco local do app; sincronizar antes.

**Roteiro de validação no aparelho**
1. Terminal 1, na raiz do app: `devbridge start`.
2. Terminal 2: `devbridge build`.
3. Testar:
   - live reload (js e css);
   - `logs -f`;
   - `sql` antes e depois do login;
   - `tables`;
   - fluxos com plugins nativos (câmera, galeria);
   - `pull-db`;
   - console web;
   - `screenshot`;
   - `launch`;
   - MCP.

Se algo falhar no aparelho, peça a saída do `build`/`start`, corrija com teste em branch de issue e atualize esta seção.

**Ideias registradas, fora do escopo atual:** suporte a iOS, Wi-Fi como alternativa ao `adb reverse`, e batch de várias instruções SQL.

## Memória

Os registros de memória (escopo, ids) ficam no `CLAUDE.local.md`. Aprendizados técnicos desta ferramenta não levam nome de app, cliente ou pessoa.
