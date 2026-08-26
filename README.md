# App de Inspeções SESMT

Aplicativo de campo do SESMT da Teccel Energia. O inspetor entra com a conta que
o administrador criou, escolhe o departamento e a equipe, responde as perguntas
daquele departamento e envia — a inspeção vai direto para o banco.

Substitui os formulários do Google que eram usados até agosto de 2026.

## Como usar

O acesso é criado pelo administrador, na aba **Ajustes → Inspetores** do
[painel de inspeções](https://teccelia2001-ux.github.io/painel-inspecoes-sesmt/).
Não há cadastro por aqui.

## O que há neste repositório

Só o aplicativo: `index.html` e `app.js`, sem dependência nenhuma.

As perguntas **não estão no código** — são carregadas do banco quando o inspetor
escolhe o departamento. O esquema do banco, o catálogo das perguntas e a função
que cria os acessos ficam fora daqui, junto com o restante do projeto.

A chave que aparece em `app.js` é a publicável (anon), pública por natureza:
quem decide o que pode ser lido e gravado são as políticas do banco, não ela.
