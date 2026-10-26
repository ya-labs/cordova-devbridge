# cordova-devbridge

Ferramenta de desenvolvimento para apps Cordova/AngularJS no Android:

- **Live reload pelo cabo:** você instala um APK "dev" uma única vez. Depois disso, salvar qualquer arquivo em `www/` atualiza o app no celular em cerca de 1 s, sem build. Mudanças só de CSS são aplicadas sem recarregar a página.
- **Banco em tempo real:** SQL contra o SQLite do app rodando, pelo terminal (`devbridge sql`) ou pelo **console web** (`http://localhost:8100/__devbridge/`). O console tem lista de tabelas, grade editável, histórico e logs ao vivo.
- **Console do app no PC:** os `console.*` e erros não tratados do app aparecem no terminal e no console web.
- **Inspetor de rede:** as requisições do app ao backend (XHR, `fetch` e `cordova-plugin-advanced-http`), com status, duração, cabeçalhos e corpos, no terminal, no console web e no MCP.
- **MCP para agentes de IA:** o Claude Code ou o Codex podem recarregar o app, ler logs e requisições, consultar o banco, avaliar JavaScript no app e tirar screenshot sozinhos.

Não tem dependências: é Node 20+ puro, mais o `adb`.


Para instalar numa máquina nova e configurar um app do zero (pré-requisitos, descobrir os bancos, `reloadRestore`, MCP e solução de problemas), siga o **[manual](docs/MANUAL.md)**.

## Como funciona

```
celular (APK dev)                              PC
WebView ── http://localhost:8100 ─ adb reverse ─► devbridge start
  │  index.html, js, css  ◄─────────────────────  www/ + platforms/android/platform_www
  │  client injetado ── SSE (reload, sql) ◄─────  watcher em www/ · API · console web · MCP
  └─ sqlitePlugin (nativo, o banco real do app)
```

- **`devbuild`:** troca o `<content src>` **só no config.xml gerado** (`platforms/android/.../res/xml/config.xml`), passando a apontar para `http://localhost:8100/index.html`, e compila em debug. O `config.xml` versionado não muda. O próximo `cordova build` ou `cordova run` normal desfaz a troca.
- **Fusão de pastas:** os arquivos vêm de `platform_www` (`cordova.js` e o JS dos plugins) com fallback para `www`. A fusão é por arquivo, então pastas com o mesmo nome nas duas árvores convivem.
- **Injeção do client:** acontece só no `www/index.html`. Os templates `.html` do AngularJS chegam intactos.
- **Banco:** o client usa a conexão que o próprio app já abriu (uma variável global como `db`). Se ela ainda não estiver aberta, por exemplo antes do login, abre o arquivo pelo nome. Quando o nome tem `*`, resolve o arquivo via `adb run-as`.

## Instalação

```bash
git clone <este repo> ~/Documentos/GitHub/cordova-devbridge
# sem sudo: um alias no ~/.bashrc
alias devbridge='node ~/Documentos/GitHub/cordova-devbridge/bin/devbridge.js'
```

Requisitos no app:
- `cordova-plugin-enable-cleartext-traffic`, para o WebView aceitar `http://localhost`. O `devbridge build` avisa se faltar.
- Um plugin SQLite que exponha `window.sqlitePlugin`, como `cordova-sqlite-storage` ou `cordova-sqlite-evcore-*`.

## Configuração por app

Crie `devbridge.config.json` na raiz do app (`devbridge init` gera um esqueleto) e acrescente `.devbridge/` ao `.gitignore`.

Exemplo com dois bancos: um por usuário (o nome tem `*`) e um de configuração:
```json
{
  "package": "com.exemplo.meuapp",
  "port": 8100,
  "defaultDb": "user",
  "databases": {
    "user": { "global": "db", "name": "MeuApp_*.db" },
    "config": { "global": "dbconfig", "name": "MeuAppConfig.db" }
  }
}
```

Com um banco só, a forma curta basta: `"databases": { "main": "MeuApp.db" }`.

| Campo | Significado |
|---|---|
| `package` | id do app (`<widget id>`), usado por `adb run-as` |
| `port` | porta do servidor; é a mesma no celular, via `adb reverse` |
| `databases.<alias>.global` | variável global onde o app guarda a conexão aberta |
| `databases.<alias>.name` | arquivo usado em `sqlitePlugin.openDatabase`; aceita `*` |
| `defaultDb` | alias usado quando `--db` não é informado |
| `reloadKeepRoute` | `true` (padrão): o reload volta para a mesma tela. `false`: volta para a rota inicial, como numa abertura nova do app |
| `networkMask` | `true` (padrão): no inspetor de rede, `Authorization`, `Cookie`, `Set-Cookie`, `X-Api-Key` e campos com senha/password/token/secret (JSON, formulário, query e XML) aparecem como `***`. `false` mostra os valores como vieram |
| `reloadRestore` | script do app (fora do `www/`) que guarda o estado antes do reload e volta para a tela depois do boot; implica reload pela rota inicial |
| `www`, `platformWww`, `cordova` | caminhos e comando, caso fujam do padrão |

## Uso diário

A ordem importa: primeiro o servidor, depois o build.

```bash
# terminal 1: deixa rodando; mantém o adb reverse ativo
devbridge start

# terminal 2: 1x, ou quando mudar plugin nativo/config.xml/ícone/permissão
devbridge build
```

O `build` só abre o app se o `start` já estiver no ar. Sem servidor, o APK dev cai numa página de erro de conexão que não tenta de novo sozinha. Se isso acontecer, com o `start` rodando, use `devbridge launch`, que fecha e reabre o app.

Depois disso é só editar `www/` (você ou o agente) e o app recarrega sozinho na mesma tela, porque o ui-router usa hash.

Se o boot do app depende da rota inicial (por exemplo, um `otherwise('/inicio')` que espera o `deviceready` e abre o SQLite antes de liberar as outras telas), o reload na mesma tela roda o controller antes da hora: aparecem `{{expressões}}` cruas e `executeSql` de `null` nos logs. Nesse caso, use `"reloadKeepRoute": false`. Para sair da tela quebrada sem reinstalar nada, rode `devbridge launch`.

Para voltar à mesma tela mesmo assim (por exemplo, com o usuário logado), use `"reloadRestore": "devbridge.restore.js"`. O script fica na raiz do app, fora do `www/` e portanto fora do build, e o servidor o injeta logo depois do client:

```js
__devbridge.restore({
  // antes do reload: o que precisa sobreviver (vai para o sessionStorage)
  save: function () { return { usuario: Sessao.usuario() }; },
  // depois do deviceready: refaz o login, abre o banco e volta para saved.hash
  restore: function (saved, done) {
    __devbridge.waitFor(function () { return appPronto(); }, function (err) {
      if (err || !saved.app) return done(err);
      Sessao.entrar(saved.app.usuario, function () { location.hash = saved.hash; done(); });
    });
  }
});
```

Em todo reload aparece uma camada "Recarregando…" no app, que some quando o `done()` é chamado. Se o `done()` não vier em 30 s, ou vier com erro, a camada some do mesmo jeito e o motivo vai para os logs.

```bash
devbridge status                                   # app conectado, tela, conexões abertas
devbridge logs -f --level warn,error               # console do app ao vivo
devbridge network -f                               # requisições do app ao backend, ao vivo
devbridge network --failed --url /api/             # só falhas (>= 400, sem resposta, erro de rede)
devbridge network 12                               # cabeçalhos e corpos da requisição #12
devbridge sql "select * from clientes limit 5"     # leitura (banco padrão)
devbridge sql "select * from parametros" --db config
devbridge sql "update clientes set nome = ? where rowid = ?" --params '["Teste",3]' --write
devbridge sql --file massa.sql --write             # várias instruções numa transação só
devbridge tables
devbridge schema pedidos
devbridge storage local                            # chaves do localStorage (session, native também)
devbridge storage native config                    # valor de uma chave do NativeStorage
devbridge storage local tema --set claro           # grava (--remove apaga); vai para .devbridge/storage-history.log
devbridge tap 540 1200                             # toca na tela (pixels da captura)
devbridge swipe 540 1800 540 600                   # arrasta (rolar lista)
devbridge type "Mercado A"                         # digita no campo com foco (acento vai pelo app)
devbridge key back                                 # back, enter, del, tab, home, escape…
devbridge go /pedidos/12                           # leva o app à rota e mostra se ele redirecionou
devbridge eval "location.hash"                     # JavaScript no app
devbridge eval "angular.element(document.body).injector().get('PedidoService').carrinho"
devbridge pull-db --db user                        # copia o .db para .devbridge/db/ (DB Browser, sqlite3)
devbridge db-snapshot antes-do-pedido              # salva os bancos do app (fecha e reabre o app)
devbridge db-restore antes-do-pedido               # volta os bancos a esse ponto
devbridge db-snapshots
devbridge screenshot
```

**Console web:** `http://localhost:8100/__devbridge/`. Clique numa tabela para navegar por ela. Com "escrita" ligada, a grade da tabela aberta permite:
- **editar:** duplo clique na célula; Enter grava, Esc cancela, e `NULL` grava nulo;
- **incluir:** "+ Registro" abre uma linha nova no topo; campo vazio usa o valor padrão da coluna (e o autoincremento), e `NULL` grava nulo; Enter ou ✓ salva;
- **excluir:** o ✕ da linha apaga pelo `rowid`, depois de confirmar.

Ctrl+Enter executa o SQL.

**Rede:** a aba "Rede", ao lado do console do app, lista as requisições; clique numa linha para ver cabeçalhos e corpos (JSON vira árvore). Uma requisição pendente é atualizada no lugar quando termina. Por padrão, a lista esconde as requisições ao próprio servidor de desenvolvimento (templates, scripts) que deram certo; "Locais" mostra todas. O app manda no máximo 32 KB de cada corpo, e o servidor guarda as 500 requisições mais recentes.

**Storage:** a aba "Storage" lista as chaves de `localStorage`, `sessionStorage` ou NativeStorage, com tamanho e prévia; clique numa chave para ver o valor (JSON vira árvore). Ela é só leitura e lê ao abrir a aba ou em "Atualizar"; gravar e apagar ficam no MCP e na CLI. Chaves `devbridge.*` são do próprio devbridge (`reloadRestore`) e não podem ser alteradas.

**Rota:** clique no caminho do app no indicador de status (topo) para editar a rota; Enter leva o app até ela.

**JavaScript no app:** o rodapé do painel "Console do app" tem uma linha de comando, como a do DevTools. Enter executa, Shift+Enter quebra linha e ↑/↓ percorrem as expressões anteriores. A expressão e o resultado entram na lista de logs, com objetos expansíveis e erros em vermelho. Usa a mesma API do `app_eval`, então tudo vai para o `.devbridge/eval-history.log`.

**Tela ao vivo:** o botão "Tela" do console abre `http://localhost:8100/__devbridge/mirror` numa janela separada, espelhando o celular (cerca de 4 a 5 quadros por segundo, por `adb screencap`). Espaço pausa; o botão de download salva o quadro atual em PNG. A captura só roda enquanto a janela está aberta e visível.

Com o botão de mão ("Controlar") ligado, a janela controla o celular: clique toca, arrastar desliza e o teclado digita (Enter, Backspace, Tab e setas viram teclas; Esc é voltar). Desligado, a janela só mostra.

No PC, a raiz `http://localhost:8100/` redireciona para o console. O app em si trava no Chrome do PC, porque o `cordova.js` usa `prompt()` como ponte nativa, e essa aba travada derruba junto as outras abas do mesmo site. Para abrir o app mesmo assim, use `/?app`. Mesmo com essa aba aberta, SQL e status continuam indo para o celular, porque o servidor prefere o client que disparou `deviceready`.

**Segurança:**
- Leitura é o padrão. A escrita exige um pedido explícito (`--write`, `db_exec` ou o checkbox "Escrita"); não há opção na config para ligá-la.
- Leituras rodam em `readTransaction`, então o próprio plugin recusa escrita.
- Uma instrução por chamada, ou um lote explícito: `statements` no MCP/API ou `--file` na CLI, numa transação só (se uma falha, nada é gravado e o erro diz qual foi).
- Toda escrita fica em `.devbridge/sql-history.log`.
- O eval de JavaScript está sempre disponível, e toda expressão fica em `.devbridge/eval-history.log`. Ele roda com os mesmos poderes do app: pode alterar o estado, e um laço infinito trava o app (o timeout só vale para promessas).
- O servidor só escuta em `127.0.0.1`.
- A API exige o header `X-Devbridge`, o que bloqueia CSRF de outras páginas abertas no navegador.

## MCP (Claude Code / Codex)

Com `devbridge start` rodando, registre na raiz do app:

```bash
claude mcp add devbridge -- node ~/Documentos/GitHub/cordova-devbridge/bin/devbridge.js mcp
```

Ferramentas expostas:
- `app_status`
- `app_reload`
- `app_logs`
- `app_network` (lista, com `since`, `url`, `failed` e `local`) e `app_network_entry` (detalhe de uma requisição)
- `db_query`
- `db_tables`
- `db_schema`
- `app_screenshot`
- `app_tap`, `app_swipe`, `app_type` e `app_key` (tocar, arrastar, digitar e teclas, com coordenadas da imagem do `app_screenshot`)
- `db_snapshot`, `db_restore` e `db_snapshots` (salvar e voltar o estado dos bancos para repetir um teste)
- `app_storage` (localStorage, sessionStorage e NativeStorage: lista, lê, grava e apaga)
- `app_navigate` (leva o app a uma rota e diz se ele redirecionou)
- `app_eval`
- `db_exec` (escrita); `db_query` e `db_exec` aceitam `statements` para um lote numa transação só

O ciclo esperado do agente é: editar `www/` → `app_reload` → `app_logs` / `app_network` / `db_query` / `app_screenshot` para validar.

## Limites

- **Mudanças nativas:** plugin, `config.xml`, ícone e permissões exigem `devbridge build` de novo.
- **Origem diferente:** no modo dev a origem é `http://localhost:8100`, e não `file://`. Por isso `localStorage` e IndexedDB ficam separados do build normal. SQLite, NativeStorage e arquivos não mudam, porque são nativos.
- **Depende do cabo:** sem o cabo e sem o `devbridge start`, o APK dev não carrega (`devbridge launch` reabre o app depois que o servidor voltar). Para testar desconectado, gere um build normal (`cordova run android`).
- **iOS:** não suportado; a ferramenta é só para Android.

## Testes

```bash
npm test   # unitários + e2e (client real em node:vm) + MCP por stdio
```
