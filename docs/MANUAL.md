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
  "defaultDb": "user",
  "databases": {
    "user": { "global": "db", "name": "MeuApp_*.db" },
    "config": { "global": "dbconfig", "name": "MeuAppConfig.db" }
  }
}
```

- **`global`:** com a conexão aberta pelo app, o devbridge usa exatamente o mesmo banco que a tela está usando. Só funciona se a variável for global (`var db` no topo de um script, ou `window.db`).
- **`name` com `*`:** para bancos com parte variável (usuário, tenant). O devbridge lista os arquivos do aparelho via `adb run-as` e escolhe o que casa. Se casar com mais de um e o app ainda não abriu a conexão (antes do login, por exemplo), o comando pede `--db <arquivo.db>`.
- **Escrita e JavaScript no app:** sempre disponíveis, sem opção na config. A escrita no banco exige um pedido explícito em cada chamada (`--write`, `db_exec` ou o checkbox "Escrita" do console) e vai para `.devbridge/sql-history.log`. O `dvb eval`, o `app_eval` do MCP e a linha de comando do console avaliam JavaScript no app; com isso o agente lê o estado do AngularJS (serviços pelo `injector`, `scope()` de um elemento) sem editar código. Toda expressão vai para `.devbridge/eval-history.log`. Configs antigas com `allowWrites` ou `allowEval` continuam válidas; os campos são ignorados.
- **`networkMask`** (opcional, padrão `true`): esconde credenciais no inspetor de rede (cabeçalhos `Authorization`/`Cookie` e campos de senha ou token). Use `false` só se precisar ver o valor exato, por exemplo para depurar um login.
- **`networkMaskFields`** (opcional, padrão `[]`): nomes de campo do seu app que carregam senha ou token sem ter isso no nome, por exemplo `["usr_pass", "dev_key"]` num envelope SOAP. O valor desses campos também vira `***`, para o agente (MCP), o console e a tela de testes não lerem a credencial. A troca vale a partir do próximo `dvb start`.

Para conferir os arquivos que existem no aparelho (exige o APK debug instalado):

```bash
adb shell run-as com.exemplo.meuapp ls databases
```

### 3.4 Ignorar a pasta de trabalho

```bash
echo ".devbridge/" >> .gitignore
```

Nela ficam o histórico de SQL de escrita, as cópias de banco e os screenshots. O `devbridge.config.json` pode ser versionado: não tem segredo. Se o app tiver testes automatizados (seção 8), versione `.devbridge/tests/` com a regra da seção 8.1.

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

Abra `http://localhost:8100/__devbridge/` no navegador do PC. No topo ficam o estado do app (clique na rota para ir a outra tela: Enter navega, Esc cancela) e as ações "Recarregar" e "Tela". A navegação lateral reúne quatro áreas (Alt+1 a Alt+4 trocam de área; o console lembra a última) e o acesso a Testes. Em telas estreitas, a navegação fica horizontal e o explorador pode ser expandido ou recolhido:

- **Banco:** no explorador, o seletor do banco, a lista de tabelas com filtro (tecla `/`, que também expande o explorador) e o "Modo escrita" no rodapé; na área principal, a consulta SQL (Ctrl+Enter executa; o histórico fica no canto do cartão) e o resultado. Com o modo escrita ligado, o topo ganha uma faixa vermelha, a consulta mostra "escrita ligada" e aparecem as ações para incluir com "+ Registro" e excluir com ✕ (com confirmação); duplo clique permite editar células.
- **Console:** os logs do app ao vivo, com filtro de nível, e uma linha de comando de JavaScript no rodapé (Enter executa no app, Shift+Enter quebra linha, ↑/↓ trazem as expressões anteriores). A navegação destaca a quantidade de erros mesmo com outra área aberta.
- **Rede:** as requisições do app ao backend; clique numa linha para ver cabeçalhos e corpos. "Só falhas" filtra status >= 400 e erros de rede; "Locais" inclui templates e scripts do próprio servidor.
- **Storage:** chaves e valores de `localStorage`, `sessionStorage` e NativeStorage (só leitura; gravar e apagar pelo `dvb storage` ou pelo `app_storage`).

As telas complementares:

- "Testes", na seção Automação da navegação, abre a tela de testes (`/__devbridge/tests`), com histórico das rodadas, indicadores, metadados recolhíveis e o formulário Nova rodada dividido em teste, sequência e casos (seção 8).
- "Tela", no topo, abre a tela do celular ao vivo numa janela separada (`/__devbridge/mirror`), com ações Controlar, Pausar e Salvar PNG: 4 a 5 quadros por segundo, espaço pausa e Salvar PNG salva o quadro. Para não pesar no celular, a captura para quando a janela é minimizada ou fechada. Se o navegador bloquear a janela, permita pop-ups de `localhost:8100`.

Não abra `http://localhost:8100/` (sem `/__devbridge/`): é o próprio app, que trava no Chrome do PC. O servidor redireciona essa URL para o console; `/?app` força o app, se for mesmo necessário.

## 7. MCP para agentes de IA

O `dvb mcp` expõe ao Claude Code (ou ao Codex) as ferramentas `app_status`, `app_reload`, `app_logs`, `app_network`, `app_network_entry`, `db_query`, `db_tables`, `db_schema`, `app_screenshot`, `app_tap`, `app_swipe`, `app_type`, `app_key`, `db_snapshot`, `db_restore`, `db_snapshots`, `app_storage`, `app_navigate`, `app_eval`, `db_exec`, `tests_list`, `tests_run`, `tests_status` e `tests_cancel`. `db_query` e `db_exec` aceitam um lote em `statements` (numa transação só), útil para o agente montar massa de teste numa chamada. Ele conversa com o `dvb start`, que precisa estar rodando.

Registro, na raiz do app:

```bash
claude mcp add devbridge -- node ~/Documentos/GitHub/cordova-devbridge/bin/devbridge.js mcp
```

- Esse comando registra só para você, nesse projeto (escopo `local`, em `~/.claude.json`). Com `--scope project`, ele cria um `.mcp.json` versionado no app, para o time inteiro; o caminho do devbridge precisa ser o mesmo em todas as máquinas.
- O MCP é carregado quando a sessão começa: abra uma conversa nova depois de registrar.
- Se `claude` não existir no terminal (você usa só a extensão do VS Code), o binário fica em `~/.vscode/extensions/anthropic.claude-code-<versão>/resources/native-binary/claude`.
- Para conferir: `claude mcp get devbridge` deve mostrar `Connected`. Na conversa, peça o `app_status`.

## 8. Testes automatizados do app

O devbridge roda no aparelho testes que o próprio app escreve. Cada etapa chama funções reais das telas (serviços do AngularJS, escopo do controller) em vez de simular toques. O devbridge não conhece o app: etapas, dados e o que conta como sucesso ficam nos arquivos de teste.

### 8.1 Arquivos

| Arquivo | Versionado | Conteúdo |
|---|---|---|
| `.devbridge/tests/<nome>.test.js` | sim | o teste; roda dentro do app |
| `.devbridge/tests/<nome>.comum.js` | sim | código comum aos testes, carregado antes deles (seção 8.3) |
| `.devbridge/tests/<nome>.local.json` ou `casos.local.json` | não | os casos, um por execução (usuário, senha, código de acesso…) |

Para versionar os testes e deixar o resto de `.devbridge/` fora do Git, troque a linha da seção 3.4 por:

```gitignore
.devbridge/*
!.devbridge/tests/
.devbridge/tests/*.local.json
```

### 8.2 Escrevendo o teste

O arquivo chama `__devbridgeRunner.registrar` uma vez:

```js
(function () {
  'use strict';
  window.__devbridgeRunner.registrar({
    nome: 'login',
    descricao: 'Faz login e chega à home',
    // opcional: testes que precisam rodar antes deste na mesma rodada (seção 8.4)
    requer: [],
    // opcional: preparo; se falhar, o caso termina como "erro" e as etapas ficam puladas
    antes: function (ctx) {
      return ctx.esperar(function () { return ctx.estadoAtual() === 'login'; }, 60000, 'a tela de login');
    },
    // opcional: roda sempre, mesmo depois de falha ou cancelamento
    depois: function (ctx) {},
    etapas: [
      {
        nome: 'Login',
        tempoLimiteMs: 120000, // padrão 60000
        executar: function (ctx) {
          var tela = ctx.escopoCom('entrar');
          ctx.aplicar(tela, function () {
            tela.usuario = ctx.caso.usuario;
            tela.senha = ctx.caso.senha;
            tela.entrar();
          });
          return ctx.esperar(function () { return ctx.estadoAtual() === 'home'; }, 90000, 'a home')
            .then(function () { return 'logado'; }); // o texto vira o detalhe da etapa
        },
      },
    ],
    // opcional: nos casos com falha, recebe cada resposta do período e devolve o problema (ou null)
    analisarResposta: function (r) {
      return r.status === 200 && /"erro"/.test(r.resposta || '') ? 'erro com HTTP 200: ' + r.resposta.slice(0, 300) : null;
    },
  });
})();
```

A etapa passa quando a promessa resolve e falha quando rejeita, lança erro ou passa do `tempoLimiteMs`. Depois de uma falha, as etapas seguintes ficam `pulada`.

O `ctx` tem:

| Campo | Para quê |
|---|---|
| `caso` | o caso desta execução, inteiro (só existe dentro do app) |
| `dados` | objeto livre para as etapas trocarem dados; é o mesmo para todos os testes do caso numa sequência |
| `publico` | o que vai para o relatório e para o `tests_status` (não ponha credencial aqui); também é do caso inteiro |
| `comum` | as funções publicadas pelos `*.comum.js` (o mesmo que `__devbridgeRunner.comum`) |
| `esperar(condicao, tempoMs, descricao)` | promessa que resolve quando `condicao()` fica verdadeira; rejeita no tempo ou no cancelamento |
| `dormir(ms)` | pausa |
| `servico(nome)` | serviço do AngularJS pelo `injector` |
| `estadoAtual()` / `irPara(estado, tempoMs)` | estado atual do ui-router e navegação até outro |
| `escopoCom(propriedade)` | escopo que declara a propriedade, procurado a partir do `$rootScope` (dispensa o debugInfo) |
| `aplicar(escopo, fn)` | roda `fn` dentro do `$apply` |
| `texto(html)` | texto sem tags, para comparar mensagens |
| `progresso(texto)` | mostra o que a etapa está fazendo agora |

Logs e requisições feitos durante uma etapa ficam marcados com ela; o `tests_status` e a tela de testes mostram os de cada etapa. O arquivo entra no app por eval, com o nome `devbridge-tests/<nome>.test.js` nas stack traces e no DevTools; um app com `Content-Security-Policy` sem `'unsafe-eval'` não roda testes.

### 8.3 Código comum

Código que mais de um teste usa (esperar o boot do app, ler as mensagens da tela, a `analisarResposta`) vai num `.devbridge/tests/<nome>.comum.js`. Todos os `*.comum.js` rodam no app antes de qualquer teste, em ordem alfabética, e de novo depois que o app recarrega. Eles publicam funções com `compartilhar`:

```js
// .devbridge/tests/app.comum.js
window.__devbridgeRunner.compartilhar({
  esperarBoot: function (ctx) {
    return ctx.esperar(function () { return ctx.estadoAtual() !== 'carregando'; }, 60000, 'o fim do boot');
  },
});
```

No teste, use `ctx.comum.esperarBoot(ctx)` dentro das funções ou `__devbridgeRunner.comum` no corpo do arquivo, por exemplo `antes: __devbridgeRunner.comum.esperarBoot`. Mudou um `*.comum.js`, os testes são carregados de novo na próxima rodada. O nome `devbridge-tests/<nome>.comum.js` aparece nas stack traces.

### 8.4 Testes em sequência

Uma rodada pode rodar vários testes em ordem: `dvb test run login checkout` ou `tests_run` com `tests: ["login", "checkout"]`. Em cada caso, os testes rodam um depois do outro, sem restaurar o aparelho entre eles: o `checkout` começa com o usuário que o `login` deixou logado, e `ctx.dados` e `ctx.publico` passam de um teste para o outro. A restauração acontece uma vez só, no fim da rodada.

- Se um teste não passa num caso, os seguintes daquele caso ficam `pulado`, e o caso seguinte começa normalmente, desde o primeiro teste.
- Um teste que depende de outro declara `requer: ['login']`. A rodada que não tiver o `login` antes dele é recusada antes de mexer no aparelho, com a ordem certa na mensagem.
- Os casos são os do primeiro teste da lista. Para uma sequência, use `casos.local.json`, que vale para todos.

### 8.5 Casos

`<nome>.local.json` (só daquele teste) ou `casos.local.json` (de todos): uma lista, ou um objeto com a lista, e cada caso com um `nome` único.

```json
{ "casos": [
  { "nome": "Homologação A", "usuario": "teste@a", "senha": "…" },
  { "nome": "Homologação B", "usuario": "teste@b", "senha": "…" }
] }
```

O caso vai para o app pelo canal do devbridge, sem passar pelo `eval-history.log`. Do caso, só o `nome` sai do app: andamento, relatório e histórico não têm os outros campos. Sem arquivo de casos, o teste roda uma vez com um caso vazio.

### 8.6 Rodando

```bash
dvb test list                          # testes, etapas e casos
dvb test run login                     # todos os casos; Ctrl+C cancela e restaura
dvb test run login --case "Homologação A"
dvb test run login checkout            # em cada caso, login e depois checkout
dvb test status                        # tabela caso × teste × etapa
dvb test status --case 1 --step 1      # logs e requisições daquela etapa
dvb test status --case 1 --test checkout --step 2   # numa sequência, diga o teste
dvb test runs                          # histórico das rodadas gravadas
dvb test status <ID> --case 2 --step 1 # etapa de uma rodada anterior
```

Pelo MCP: `tests_list` (também lista o código comum, o `requer` de cada teste e as últimas rodadas), `tests_run` (com `tests` para uma sequência), `tests_status` (com `waitMs` para esperar o fim; com `case`, `test` e `step` para a etapa; com `id` para uma rodada anterior) e `tests_cancel`.

No navegador, o botão "Testes" do console abre `http://localhost:8100/__devbridge/tests`:
- à esquerda, o histórico das rodadas (do mais novo ao mais antigo, agrupado por dia, com filtro por teste); a rodada em andamento fica no topo e a tela acompanha sozinha, mesmo se ela foi iniciada pelo MCP ou pela CLI;
- no topo da rodada, indicadores: casos ok, etapas com falha, requisições com falha, logs de erro e problemas;
- abas: Resumo (tabela caso × etapa, com as etapas agrupadas por teste numa sequência; clique numa célula para abrir a etapa), Casos (linha do tempo de cada caso, teste a teste, com os logs e as requisições de cada etapa e os dados públicos), Problemas (tudo o que falhou, com link para a etapa), Logs e Requisições (com filtro por caso, nível, URL e só falhas; clique numa requisição para ver cabeçalhos e corpo, se ainda estiver no inspetor de rede) e JSON (o relatório, para copiar ou baixar);
- "Nova rodada" escolhe um ou mais testes, a ordem (↑/↓, com aviso se um `requer` ficar fora de ordem) e os casos; "Rodar de novo" repete os testes e os casos de uma rodada.

Uma rodada:
1. guarda `localStorage` e NativeStorage do app e tira um snapshot completo dos bancos (o app fecha e reabre);
2. roda os casos um por vez e, em cada caso, os testes da lista em ordem, mostrando o teste e a etapa atuais, a duração e o erro;
3. no fim de cada caso, junta os logs de erro e as requisições com falha; se o caso falhou, passa as respostas de cada teste à `analisarResposta` dele, se houver;
4. devolve o armazenamento e os bancos ao estado de antes, apagando os bancos criados na rodada (o app fecha e reabre de novo). Isso vale também para rodada com falha ou cancelada.

Só uma rodada por vez. O relatório fica em `.devbridge/test-runs/<id>-<teste>.json` (numa sequência, `<id>-login+checkout.json`), com horários no fuso do PC, e guarda também os logs e o resumo das requisições (sem corpo) de cada etapa, para o histórico; o corpo só fica no inspetor de rede enquanto ele tiver a requisição. O log de cada etapa é o que o app escreveu e o agente o lê pelo `tests_status`, então não registre credenciais no console (a máscara vale só para a rede). O histórico de eventos das rodadas fica em `.devbridge/test-history.log`. Se a restauração der certo, o snapshot e a cópia do armazenamento são apagados; se falhar, ficam lá e o relatório diz como restaurar à mão.

Durante a rodada, o app manda até 256 KB de cada corpo de requisição (32 KB fora dela), para respostas grandes poderem ser analisadas.

## 9. Voltar ao APK normal

O patch do APK dev fica só no `config.xml` gerado em `platforms/`. Qualquer `cordova build android` ou `cordova run android` refaz esse arquivo e gera o APK comum, que funciona sem cabo e sem servidor. Para voltar ao modo dev, `dvb build` de novo.

Lembre que no modo dev a origem é `http://localhost:8100`, e não `file://`: `localStorage` e IndexedDB são separados entre os dois modos. SQLite, NativeStorage e arquivos são os mesmos.

## 10. Solução de problemas

| Sintoma | Causa provável | O que fazer |
|---|---|---|
| O app abre sem live reload, com o código do último build | APK dev aberto sem o `dvb start` ou sem o cabo (fallback para o `www` empacotado) | `dvb start` e depois `dvb launch` |
| O app abre numa página de erro de conexão | APK gerado por uma versão do devbridge sem o fallback | `dvb build` de novo; até lá, `dvb start` e `dvb launch` |
| `dvb status` diz que nenhum app está conectado, com o app aberto | celular bloqueado (WebView pausado), cabo solto ou `adb reverse` caiu | desbloqueie o celular; confira `adb devices` e `adb reverse --list`; o `start` refaz o reverse sozinho quando o cabo volta |
| `INSTALL_FAILED_UPDATE_INCOMPATIBLE` no build | app instalado com outra assinatura | sincronize os dados e `adb uninstall <package>`; o banco local é apagado |
| `{{expressões}}` cruas ou `executeSql` de `null` depois do reload | boot depende da rota inicial | `reloadKeepRoute: false` ou `reloadRestore` (seção 5); `dvb launch` para sair |
| Todo reload volta para o login | `reloadKeepRoute: false` sem restauração | escreva o `devbridge.restore.js` (seção 5) |
| `"user" casa com vários bancos` | nome com `*` e a conexão do app ainda não aberta | faça login no app, ou use `--db <arquivo.db>` |
| `pull-db`/`run-as` falha (`not debuggable`) | APK instalado não é debug | `dvb build` (ele compila em debug) |
| Console web fica carregando para sempre | aba de `localhost:8100/` (o app) aberta no Chrome, travando o processo do site | feche todas as abas de `localhost:8100` (Shift+Esc no Chrome) e abra só `/__devbridge/` |
| SQL ou status parecem vir de outro lugar | outra página com o client conectada | `dvb status` mostra o `userAgent` do client ativo e `server.clients`; feche a aba extra |
| No `chrome://inspect`, todo log aponta para `client.js` | source maps desligados no DevTools; sem o map, o client não entra na ignore list | DevTools → Settings → Preferences → Sources → **Enable JavaScript source maps**; em Settings → Ignore list, deixe ligado **Automatically add known third-party scripts to ignore list** |
| Uma requisição não aparece na aba Rede | é ao próprio servidor e deu certo (escondida por padrão), ou sai por um plugin nativo que não é o `cordova-plugin-advanced-http` (WebSocket, outro plugin HTTP) | ligue "Locais" (`--local`, `local: true` no MCP); requisições de outros plugins nativos não passam pelo WebView e não são capturadas |
| `dvb eval`/`app_eval` responde `EvalError: Refused to evaluate a string` | o `Content-Security-Policy` do `index.html` não tem `'unsafe-eval'` | acrescente `'unsafe-eval'` ao `default-src` (ou `script-src`) só se o time aceitar; sem isso, o eval não funciona nesse app |
| Depois do `db-restore` sumiu um banco do app | o restore deixa `databases/` igual ao snapshot e apaga o que foi criado depois dele (a saída lista os removidos) | tire o snapshot depois de criar esse banco, ou faça o snapshot só do banco que o teste altera (`--db`) |
| `db-restore`/`db_restore` falha com `exec-in` ou tamanho diferente | adb antigo sem `exec-in`, ou o aparelho não terminou de gravar em 20 s | atualize o platform-tools; o app fica parado: rode o restore de novo ou `dvb launch` |
| `type`/`app_type` com acento responde "Nenhum campo de texto com foco" | o texto com acento vai pelo app, no campo que tem o foco no WebView | toque no campo antes (`dvb tap`/`app_tap`); campo nativo (fora do WebView) só recebe ASCII, pelo adb |
| `tests_run`/`dvb test run` responde "Nenhum app pronto" | o app não está aberto no modo dev, ou ainda não disparou `deviceready` | abra o app com o `dvb start` no ar e confira `dvb status` |
| O teste aparece com "não chamou __devbridgeRunner.registrar" | erro de sintaxe no `.test.js` ou `registrar` dentro de código assíncrono | veja `dvb logs --level error`; chame `registrar` direto no arquivo |
| Caso com "O app recarregou durante o caso" | a etapa salvou um arquivo de `www/` (live reload), chamou `location.reload` ou derrubou o app | evite reload durante o teste; o estado do caso fica só na memória do app |
| "FALHA NA RESTAURAÇÃO" no fim da rodada | o app não voltou (cabo, `adb`) ou o NativeStorage recusou a gravação | siga a linha "Restaure à mão" do relatório: `dvb db-restore teste-<id>` e o armazenamento em `.devbridge/test-runs/<id>.storage.json` |
| Mudança de CSS não aparece | o arquivo não está ligado por `<link>` no `index.html` | o devbridge recarrega a página nesse caso; confira `dvb logs` |
| `AVISO: AndroidManifest sem usesCleartextTraffic` no build | falta o plugin de cleartext | instale `cordova-plugin-enable-cleartext-traffic` e rode `dvb build` |
| Mudou plugin nativo, `config.xml`, ícone ou permissão e nada mudou | essas coisas vivem no APK, não no `www/` | `dvb build` |
