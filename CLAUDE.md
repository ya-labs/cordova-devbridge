# cordova-devbridge: guia para agentes

Ferramenta de desenvolvimento para apps Cordova/AngularJS no Android, usada em Linux com o celular via USB/adb. O uso está descrito no [README.md](README.md) e no [manual](docs/MANUAL.md). Este arquivo registra o que é estável: o mapa do código, as decisões, as convenções e as armadilhas. O andamento do projeto (o que foi feito, o que falta, validações) fica nas issues e nos PRs, nunca aqui.

## O que o projeto resolve

1. **Build lento a cada alteração.** Um APK "dev" carrega `www/` do PC (`http://localhost:8100` via `adb reverse`). Salvar um arquivo recarrega o app; mudança só de CSS é trocada sem reload.
2. **SQLite do app em tempo real** pela CLI, pelo console web (`/__devbridge/`) ou pelo MCP.
3. **Ciclo do agente pelo MCP:** editar → `app_reload` → `app_logs` / `app_network` / `db_query` / `app_eval` / `app_screenshot`, chegando às telas com `app_navigate` ou `app_tap`.

## Mapa do código

| Arquivo | Papel |
|---|---|
| `bin/devbridge.js` | CLI: parse de argumentos e comandos |
| `src/config.js` | acha e normaliza o `devbridge.config.json` do app; `resolveDatabase` |
| `src/server.js` | `DevServer`: HTTP estático, SSE para o app, API `/__devbridge/api/*`, watcher, histórico de SQL |
| `src/static.js` | resolve arquivos (platform_www sobre www) e injeta o client |
| `src/client/devbridge-client.js` | roda **dentro do app**: logs, reload, troca de CSS, executa SQL |
| `src/sqlguard.js` | classifica o SQL como leitura ou escrita, exige uma instrução por chamada e divide scripts (`splitSql`) |
| `src/devbuild.js` | prepare → patch do `config.xml` gerado → compile → `adb install` → `launchIfServerUp` (só reabre o app se o servidor responder) |
| `src/adb.js` | reverse, `run-as` (ler, gravar e apagar arquivos do app), screencap, install, force-stop |
| `src/snapshot.js` | snapshot e restore dos bancos do app, usado pela CLI e pelo servidor |
| `src/input.js` | argumentos do `adb shell input` (tap, swipe, text, keyevent) |
| `src/network.js` | inspetor de rede: buffer das requisições do app (eventos start/end), filtros e máscara de credenciais |
| `src/mirror.js` | espelho da tela: capturas `screencap -p` em paralelo, só enquanto há quem peça quadros |
| `src/ui/mirror.html` | janela do espelho (long-poll em `/api/mirror/frame`) |
| `src/mcp.js` | servidor MCP mínimo (JSON-RPC por stdio, sem SDK) |
| `src/ui/index.html` | console web autocontido (sem CDN) |
| `docs/MANUAL.md` | instalação e configuração de um app do zero, na ordem dos passos; solução de problemas. Mantenha em sincronia com o README e o código |
| `test/` | `units`, `e2e` (o client real em `node:vm`), `network` (wrappers de rede no vm contra um backend falso), `eval` (eval no vm e `app_eval` por stdio), `navigate` (rota, prefixo e redirecionamento no vm), `batch` (lote, rollback, `splitSql` e `--file`), `storage` (local/session/native no vm), `snapshot` (aparelho em memória), `input` (argumentos do adb e texto pelo DOM), `mcp` (processo real por stdio) e `devbuild` (decisão de abrir o app) |

## Decisões (não reverter sem motivo)

- **Zero dependências.** Só Node 20+ e adb. Por isso a comunicação usa SSE + POST, e não WebSocket, e o MCP é escrito à mão.
- **Patch só no `config.xml` gerado** (`platforms/android/app/src/main/res/xml/config.xml`), nunca no versionado. O cordova-android aceita um `<content src>` com esquema como URL inicial (`ConfigXmlParser.setStartUrl`). O acesso ao bridge segue o `<allow-navigation>` (`CordovaPlugin.shouldAllowBridgeAccess`). O próximo `cordova prepare` desfaz o patch, então nada vaza para o release.
- **Resolução por arquivo:** primeiro `platform_www`, depois `www`. Há app real com `www/plugins/cordova-plugin-advanced-http/`, com o mesmo nome do plugin Cordova, e uma fusão por diretório quebraria.
- **O client é injetado só em `www/index.html`.** Os templates do AngularJS também são `.html` e chegam por XHR. Ele entra como primeiro script do `<head>`, para capturar logs do boot e continuar recebendo reload mesmo se o app quebrar.
- **O client é ES5** (`var`, `function`), para não depender da versão do WebView.
- **Client na ignore list do DevTools.** O wrapper de `console.*` faria todo log apontar para a linha dele no `chrome://inspect`. O servidor acrescenta `//# sourceMappingURL=/__devbridge/client.js.map` ao `client.js` e gera um map de identidade com `x_google_ignoreList`. Com isso o DevTools pula os frames do client e linka a linha do app.
- **Segurança do banco:**
  - a leitura é o padrão;
  - a escrita exige um pedido explícito em cada chamada (`--write`, `db_exec` ou o checkbox da UI). Não há trava na config, porque é ferramenta de desenvolvimento num aparelho de teste;
  - a leitura roda em `readTransaction`, então o próprio plugin recusa escrita;
  - toda escrita vai para `.devbridge/sql-history.log`.
- **Segurança do servidor:** escuta só em `127.0.0.1`. A API exige o header `X-Devbridge: 1`, que força um preflight CORS e assim barra CSRF de outras páginas abertas no navegador.
- **Reload mantém a rota por padrão** (`reloadKeepRoute: true`). Com `false`, o client limpa o hash via `history.replaceState` antes do `location.reload()`, nos quatro caminhos de reload (arquivo salvo, `reload`/`app_reload`, servidor reiniciado e CSS sem `<link>` correspondente). A opção chega ao client no evento `hello`. Motivo: há apps cujo boot só acontece na rota do `otherwise` (#3).
- **`reloadRestore`:** a volta à tela depois do reload é do app, não do devbridge, porque login e banco são específicos de cada app. O client guarda `{hash, app: hook.save()}` no `sessionStorage` (`devbridge.reload`, lido e apagado no boot seguinte, uma tentativa só) e chama `hook.restore(saved, done)` no `deviceready`. A camada "Recarregando…" vale para todo reload; sem hook, ela some no `deviceready`. O servidor injeta `/__devbridge/restore.js` depois do client e força o reload pela rota inicial.
- **Logs com objetos:** cada entrada mantém `msg` (texto, usado pela CLI e pelo MCP) e, se algum argumento for objeto, `args` com uma cópia JSON para a árvore expansível do console web. Valores que o JSON não representa viram `{ __dvb: texto }` (undefined, função, circular, Error, Date, nó do DOM); a cópia para em 3000 nós ou 12 níveis. Erro é detectado pelo tipo interno, não por `instanceof`, que falha entre contextos.
- **Inspetor de rede:**
  - o client faz patch no `prototype` do XHR (preserva `instanceof`, `readyState` e os handlers do app), embrulha `fetch` (corpo lido de um clone, só se for texto) e corrige no lugar os métodos de `cordova.plugin.http` (no load e no `deviceready`), porque o advanced-http sai pelo nativo sem passar pelo XHR;
  - o `post` do próprio client marca o XHR (`__dvbOwn`) e URLs `/__devbridge/` ficam de fora; sem isso, cada envio geraria outro envio;
  - `post`/`get` do advanced-http chamam `sendRequest` por dentro: um contador de profundidade evita registrar duas vezes;
  - cada chamada gera `start` e `end`; o servidor dá um `seq` novo a cada mudança, então `since` traz também as que terminaram depois;
  - corpo cortado em 32 KB no app; 500 entradas no servidor; requisições locais que deram certo ficam fora da lista por padrão;
  - `networkMask` (padrão `true`) mascara credenciais por regex, e não por parse, porque o corpo pode chegar cortado.
- **Eval no app:** sempre disponível, sem opção na config. O client usa eval indireto `(0, eval)(expr)`, que roda no escopo global e fora do `'use strict'` do client. Resultado thenable é esperado até `timeoutMs` (100 ms a 120 s); o servidor espera 2 s a mais para o timeout do app chegar primeiro. O valor volta pela mesma cópia JSON dos logs (`cloneArg`); toda expressão vai para `.devbridge/eval-history.log`. Código síncrono não tem como ser interrompido: um laço infinito trava o app. A stack de erro é cortada no frame `at runEval`, porque o que vem abaixo é o canal do client. O console web tem um prompt no rodapé do painel de logs, que chama a mesma API; o resultado é uma linha local (não conta como log do app).
- **Navegação:** `app_navigate`/`devbridge go` mudam o `location.hash` no app já iniciado (recusado antes do `deviceready`). Sem `#`, a rota usa o prefixo que o app já usa (`#!` ou `#`). A resposta espera o hash ficar parado por 300 ms (máximo 3 s), por polling e não por `hashchange`, para pegar o redirecionamento de uma guarda de login ou do `otherwise`; `redirected` diz se o app foi para outro lugar.
- **Toque, texto e teclas:** `src/input.js` monta os argumentos do `adb shell input` (coordenadas em pixels da captura, que seguem a rotação da tela). O `input text` só aceita ASCII e passa pelo shell do aparelho: metacaracteres levam barra e espaço vira `%s`. Texto com acento ou quebra de linha vai pelo client (`type`): insere no campo com foco do WebView e dispara `input`/`change` para o `ng-model`; valor de senha não volta. No espelho, o modo "Controlar" converte o clique para pixels do aparelho descontando as faixas do `object-fit: contain`, e as ações vão em fila para texto e teclas chegarem na ordem. Nos testes, o `adbRun` do servidor é injetável.
- **Snapshot do banco:** `src/snapshot.js`, usado pela CLI (direto, sem servidor) e pelo servidor (MCP). O app é parado (`am force-stop`) durante a cópia e a restauração e reaberto no fim (na CLI, só se o `start` estiver no ar). Sem `db`, copia todos os arquivos de `databases/`. A restauração troca o conjunto inteiro: journal/wal/shm que não estavam no snapshot são apagados antes, senão o SQLite aplicaria um WAL de outro estado. A escrita usa `adb exec-in run-as <pkg> sh -c 'cat > …'`, que **volta antes de o aparelho terminar de gravar** (medido: 250 a 500 ms com 0,3 a 5 MB); o `writeAppFile` só termina quando o `stat` bate com o tamanho. Snapshot de outro pacote é recusado; histórico em `.devbridge/snapshot-history.log`.
- **Storage:** `app_storage`/`devbridge storage` em `local`, `session` e `native` (NativeStorage, assíncrono e com o valor já interpretado; JSON válido em `set` vira objeto). Sem chave lista com prévia de 120 caracteres; com chave devolve até 64 KB, mais a cópia JSON (`cloneArg`) se for objeto. `set`/`remove` exigem `action` explícita e vão para `.devbridge/storage-history.log`. Chaves `devbridge.*` (o `reloadRestore` grava `devbridge.reload` no `sessionStorage`) são recusadas em `set`/`remove`. A aba do console é só leitura e não faz polling.
- **SQL em lote:** a API e o MCP recebem `statements: [{ sql, params }]` (lista explícita, sem dividir texto); a CLI divide o `--file` com `splitSql` (respeita string, identificador entre aspas, comentário e `CREATE TRIGGER … END`; tira comentários do início de cada instrução). Cada instrução passa pelo `sqlguard`; no client, os `executeSql` são encadeados na mesma transação e a primeira falha desfaz o lote, com o índice no erro. O lote vira uma linha só no `sql-history.log`. O `sqlitePlugin` falso desfaz a transação em caso de falha.
- **Espelho da tela sem dependência:** sem scrcpy/ffmpeg, o espelho é feito com `adb exec-out screencap -p` (~0,6 s por quadro no aparelho). Três capturas em paralelo dão ~4,7 qps (medido; 4 dão ~5,4, mas pesam mais no app em teste). Capturas terminam fora de ordem, então só se publica quadro de captura iniciada depois da que gerou o último (contador, não relógio). A janela pede por long-poll na API (com `X-Devbridge`); sem pedidos por 4 s os workers param, e a janela para de pedir quando fica oculta.
- **Client ativo:** com mais de um client conectado, o servidor escolhe o mais recente entre os que dispararam `deviceready` (`readyClients`, guardado por id para sobreviver à reconexão do EventSource). Uma aba do PC em `localhost:8100/` também carrega o client, mas nunca dispara `deviceready`; antes disso, ela roubava SQL e status do celular.
- **Navegador de PC em `/` ou `/index.html` vai para `/__devbridge/` (302)**, a menos que use `?app`. A aba do app travava no `prompt()` do `cordova.js` e, por dividir o processo do Chrome com as outras abas do mesmo site, travava também o console. Navegador de PC é `Mozilla` sem `Android`; o fetch do Node passa direto.
- **Bancos:** o client prefere a conexão global que o app já abriu (por exemplo, `db`). Sem ela, abre pelo nome. Um nome com `*` é resolvido via `adb run-as <pkg> ls databases`.

## Convenções

- Mensagens, comentários e documentação em **português**. O código segue o estilo existente: CommonJS, `'use strict'` e poucos comentários, que explicam o porquê.
- Commits: `tipo: descrição curta` (padrão YABook).
- Testes: `npm test`, que roda `node --test test/*.test.js`. Toda mudança de comportamento ganha um teste. O `test/helpers.js` tem o app falso, o `sqlitePlugin` falso (com rollback), o storage falso e o client em vm.
- A UI não tem teste automatizado de clique: telas novas se conferem num Chrome headless via CDP, contra o app falso do `test/helpers.js`.
- Andamento, pendências e validações ficam nas issues e nos PRs. Não acrescente a este arquivo seções de estado, pendências, roteiros ou ideias futuras.
- **Critério das features:** o valor de cada uma é medido pelo que o agente consegue fazer com ela, então a ferramenta MCP é a entrega principal e entra nos critérios de aceite; CLI e console web vêm junto. Recurso com efeito colateral não ganha opção na config: exige pedido explícito por chamada e fica em histórico em `.devbridge/`.

## Armadilhas já encontradas

- **Não dá para validar o app inteiro no Chrome do PC.** O `cordova.js` do Android usa `prompt()` como ponte nativa e trava a página, mesmo com `window.prompt` neutralizado via CDP. Para testar o client num navegador real, use uma página mínima sem `cordova.js`. O app em si se valida no aparelho (`chrome://inspect` com o APK debug).
- **`pkill -f <padrão>`** com um padrão que aparece na linha do próprio shell mata o comando (exit 144). Mate pelo PID.
- **`$!` de `cd dir && node ... &`** é o PID do subshell, e matar esse PID pode deixar o node vivo. Rode o node direto em background.
- **Chrome headless via CDP:** no Node 20 é preciso `node --experimental-websocket`.
- **APK dev aberto sem servidor:** o WebView mostra uma página de erro de conexão que não tenta de novo. A ordem certa é `start` → `build`. Se o app ficar preso nessa tela, rode `devbridge launch` com o servidor no ar; o `build` só reabre o app se o `start` responder.
- **Testes no vm:** objetos criados dentro do vm têm outro `Object.prototype`, e o `deepStrictEqual` falha; compare por JSON. O client apaga `devbridge.reload` do `sessionStorage` no boot, então grave essa chave depois de subir o client.
- **Chrome headless com captura falsa:** um `screencap` falso que resolve na hora faz os workers do espelho girarem em microtarefas e trava o event loop; dê um atraso.
- **`adb exec-in`** volta antes de o aparelho terminar de gravar (250 a 500 ms com 0,3 a 5 MB): confira o tamanho com `stat` antes de seguir.
- **Hook YABook:** a `main` é protegida, então edições vão por branch de issue. O hook também barra `git merge`, inclusive `--ff-only`, sem pedido explícito; para avançar uma branch local atrás da remota, use `git pull --ff-only`.

## Regras e fatos do ambiente

- O remoto é `ya-labs/cordova-devbridge`, um repo **público**. Não registre aqui nem em issues e PRs: branches, commits ou PRs dos apps que usam a ferramenta; serial de aparelho; dados de banco; nome de cliente.
- A config de cada app (`devbridge.config.json`) mora no repositório do próprio app, não aqui.
- No modo dev, a origem passa a ser `http://localhost:8100`, então o `localStorage` fica separado do build normal. SQLite, NativeStorage e arquivos continuam os mesmos. Confira o que o app guarda no `localStorage` antes de afirmar que é preciso logar de novo.
- `INSTALL_FAILED_UPDATE_INCOMPATIBLE` no `build` significa que o app instalado tem outra assinatura (por exemplo, um build release). A saída é desinstalar, o que apaga o banco local do app; sincronizar antes.

## Memória

Aprendizados técnicos desta ferramenta não levam nome de app, cliente ou pessoa.
