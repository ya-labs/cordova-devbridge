# cordova-devbridge

Ferramenta de desenvolvimento para apps Cordova/AngularJS no Android:

- **Live reload pelo cabo:** você instala um APK "dev" uma única vez. Depois disso, salvar qualquer arquivo em `www/` atualiza o app no celular em cerca de 1 s, sem build. Mudanças só de CSS são aplicadas sem recarregar a página.
- **Banco em tempo real:** SQL contra o SQLite do app rodando, pelo terminal (`devbridge sql`) ou pelo **console web** (`http://localhost:8100/__devbridge/`). O console tem lista de tabelas, grade editável, histórico e logs ao vivo.
- **Console do app no PC:** os `console.*` e erros não tratados do app aparecem no terminal e no console web.
- **MCP para agentes de IA:** o Claude Code ou o Codex podem recarregar o app, ler logs, consultar o banco e tirar screenshot sozinhos.

Não tem dependências: é Node 20+ puro, mais o `adb`.

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
  "allowWrites": true,
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
| `allowWrites` | libera `--write`, o `db_exec` do MCP e a edição da grade (padrão `false`) |
| `reloadKeepRoute` | `true` (padrão): o reload volta para a mesma tela. `false`: volta para a rota inicial, como numa abertura nova do app |
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

```bash
devbridge status                                   # app conectado, tela, conexões abertas
devbridge logs -f --level warn,error               # console do app ao vivo
devbridge sql "select * from clientes limit 5"     # leitura (banco padrão)
devbridge sql "select * from parametros" --db config
devbridge sql "update clientes set nome = ? where rowid = ?" --params '["Teste",3]' --write
devbridge tables
devbridge schema pedidos
devbridge pull-db --db user                        # copia o .db para .devbridge/db/ (DB Browser, sqlite3)
devbridge screenshot
```

**Console web:** `http://localhost:8100/__devbridge/`. Clique numa tabela para navegar por ela. Com "escrita" ligada, um duplo clique na célula edita o valor: Enter grava, Esc cancela, e `NULL` grava nulo. Ctrl+Enter executa o SQL.

**Segurança:**
- Leitura é o padrão. A escrita exige `allowWrites` **e** um pedido explícito (`--write`, `db_exec` ou o checkbox).
- Leituras rodam em `readTransaction`, então o próprio plugin recusa escrita.
- Uma instrução por chamada.
- Toda escrita fica em `.devbridge/sql-history.log`.
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
- `db_query`
- `db_tables`
- `db_schema`
- `app_screenshot`
- `db_exec`, só com `allowWrites`

O ciclo esperado do agente é: editar `www/` → `app_reload` → `app_logs` / `db_query` / `app_screenshot` para validar.

## Limites

- **Mudanças nativas:** plugin, `config.xml`, ícone e permissões exigem `devbridge build` de novo.
- **Origem diferente:** no modo dev a origem é `http://localhost:8100`, e não `file://`. Por isso `localStorage` e IndexedDB ficam separados do build normal. SQLite, NativeStorage e arquivos não mudam, porque são nativos.
- **Depende do cabo:** sem o cabo e sem o `devbridge start`, o APK dev não carrega (`devbridge launch` reabre o app depois que o servidor voltar). Para testar desconectado, gere um build normal (`cordova run android`).
- **iOS:** fora do escopo por enquanto.

## Testes

```bash
npm test   # unitários + e2e (client real em node:vm) + MCP por stdio
```
