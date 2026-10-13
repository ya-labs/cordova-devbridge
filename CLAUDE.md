# cordova-devbridge: guia para agentes

Ferramenta de desenvolvimento para apps Cordova/AngularJS no Android (Promotor-de-Vendas, Pack-Tracking, Sales-Mobile). Usuários: Nícolas e Marco, ambos em Linux, com o celular via USB/adb. O uso está descrito no [README.md](README.md). Este arquivo registra as decisões e o que um agente precisa saber antes de mexer.

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
| `src/devbuild.js` | prepare → patch do `config.xml` gerado → compile → `adb install` |
| `src/adb.js` | reverse, `run-as`, screencap, install |
| `src/mcp.js` | servidor MCP mínimo (JSON-RPC por stdio, sem SDK) |
| `src/ui/index.html` | console web autocontido (sem CDN) |
| `test/` | `units`, `e2e` (o client real em `node:vm`) e `mcp` (processo real por stdio) |

## Decisões (não reverter sem motivo)

- **Zero dependências.** Só Node 20+ e adb. Por isso a comunicação usa SSE + POST, e não WebSocket, e o MCP é escrito à mão.
- **Patch só no `config.xml` gerado** (`platforms/android/app/src/main/res/xml/config.xml`), nunca no versionado. O cordova-android aceita um `<content src>` com esquema como URL inicial (`ConfigXmlParser.setStartUrl`). O acesso ao bridge segue o `<allow-navigation>` (`CordovaPlugin.shouldAllowBridgeAccess`). O próximo `cordova prepare` desfaz o patch, então nada vaza para o release.
- **Resolução por arquivo:** primeiro `platform_www`, depois `www`. O Pack-Tracking tem `www/plugins/cordova-plugin-advanced-http/`, com o mesmo nome do plugin Cordova, e uma fusão por diretório quebraria.
- **O client é injetado só em `www/index.html`.** Os templates do AngularJS também são `.html` e chegam por XHR. Ele entra como primeiro script do `<head>`, para capturar logs do boot e continuar recebendo reload mesmo se o app quebrar.
- **O client é ES5** (`var`, `function`), para não depender da versão do WebView.
- **Segurança do banco:**
  - a leitura é o padrão;
  - a escrita exige `allowWrites` na config **e** um pedido explícito (`--write`, `db_exec` ou o checkbox da UI);
  - a leitura roda em `readTransaction`, então o próprio plugin recusa escrita;
  - toda escrita vai para `.devbridge/sql-history.log`.
- **Segurança do servidor:** escuta só em `127.0.0.1`. A API exige o header `X-Devbridge: 1`, que força um preflight CORS e assim barra CSRF de outras páginas abertas no navegador.
- **Bancos:** o client prefere a conexão global que o app já abriu (`db`, `dbpar`). Sem ela, abre pelo nome. Um nome com `*` é resolvido via `adb run-as <pkg> ls databases`.

## Convenções

- Mensagens, comentários e documentação em **português**. O código segue o estilo existente: CommonJS, `'use strict'` e poucos comentários, que explicam o porquê.
- Commits: `tipo: descrição curta` (padrão YABook).
- Testes: `npm test`, que roda `node --test test/*.test.js`. Toda mudança de comportamento ganha um teste. O `test/helpers.js` tem o app falso, o `sqlitePlugin` falso e o client em vm.

## Armadilhas já encontradas

- **Não dá para validar o app inteiro no Chrome do PC.** O `cordova.js` do Android usa `prompt()` como ponte nativa e trava a página, mesmo com `window.prompt` neutralizado via CDP. Para testar o client num navegador real, use uma página mínima sem `cordova.js`. O app em si se valida no aparelho (`chrome://inspect` com o APK debug).
- **`pkill -f <padrão>`** com um padrão que aparece na linha do próprio shell mata o comando (exit 144). Mate pelo PID.
- **`$!` de `cd dir && node ... &`** é o PID do subshell, e matar esse PID pode deixar o node vivo. Rode o node direto em background.
- **Chrome headless via CDP:** no Node 20 é preciso `node --experimental-websocket`.

## Estado (2026-10-13)

**Feito:**
- Tudo do MVP: build, start, sql, tables, schema, pull-db, screenshot, logs, mcp e o console web com grade editável.
- `npm test`: 20/20.
- Contra o Promotor-de-Vendas real: os 66 recursos do `index.html` e os 72 módulos de plugin resolvem com 200.
- `devbridge build --no-install` compila em cerca de 35 s, e o APK sai com `content src="http://localhost:8100/index.html"`.
- No Chrome real, com uma página mínima: conexão, SQL, logs, troca de CSS, reload na mesma rota e edição da grade.

**Pendente (não declarar como validado):**
- `devbridge build` instalando num celular real.
- Fluxo completo do Promotor no modo dev: login, sincronização, visita com foto, checklist com galeria.
- SQL contra `db`/`dbpar` reais no aparelho e `pull-db` (o `run-as` exige build debuggable).
- MCP registrado num Claude Code de verdade.
- Pack-Tracking: falta criar o `devbridge.config.json` e testar. A config de exemplo está no README.
- Repo sem commit inicial e sem remoto.

**Ideias registradas, fora do escopo atual:** suporte a iOS, Wi-Fi como alternativa ao `adb reverse`, e batch de várias instruções SQL.

## Memória

Projeto registrado na YABook com o escopo `["Agrosys", "cordova-devbridge"]`. Os aprendizados técnicos desta ferramenta vão para esse escopo, sem nome nem código de cliente.

Os registros da sessão de criação ficaram no escopo de Ferramentas: `kn-fer-cordova-live-reload-content-src`, `kn-fer-cordova-js-android-trava-chrome-desktop` e o episódio `ep-fer-20261013-cordova-devbridge`. Complemente esses registros em vez de duplicá-los.
