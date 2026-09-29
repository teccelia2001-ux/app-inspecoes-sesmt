/* ============================================================
   APP DE INSPEÇÕES SESMT
   O inspetor entra, escolhe o departamento e a equipe, responde
   as perguntas daquele departamento e envia.

   Mesmo projeto Supabase do painel (painel-sesmt). A chave abaixo
   é a publicável (anon): é pública por natureza, quem manda no
   que pode ser lido e gravado são as políticas do banco, no
   arquivo estrutura/03-acesso.sql.
   ============================================================ */
"use strict";

const SERVIDOR = {
  url: "https://ldqegnfcjeljvywbravl.supabase.co",
  chave: "sb_publishable_4IcV3231DtKqDuBdoPdG8A_sgt8vbOP"
};

/* Versão do código, mostrada no rodapé da tela inicial e da de login.

   Existe porque em 27/08/2026 gastei três tentativas sem saber se o celular
   estava rodando a correção ou uma cópia guardada pelo service worker. Sem
   isso, "não funcionou" não distingue código errado de código velho.
   Subir JUNTO com a VERSAO do sw.js. */
const VERSAO_APP = "v15 · 29/09/2026";

/* Logo em SVG para o app não depender de arquivo externo */
const LOGO = "data:image/svg+xml;utf8," + encodeURIComponent(
  '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 120 24">' +
  '<rect width="120" height="24" rx="4" fill="#fb4513"/>' +
  '<text x="60" y="16.5" font-family="Segoe UI,sans-serif" font-size="12" font-weight="800" ' +
  'fill="#fff" text-anchor="middle" letter-spacing="1">TECCEL</text></svg>');

/* ---------- utilidades ---------- */
const $ = s => document.querySelector(s);
const tela = () => $("#tela");
const esc = s => String(s == null ? "" : s)
  .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
/* Compara ignorando acento e maiúscula: "plantao" acha "PLANTÃO" */
const semAcento = s => String(s || "").normalize("NFD")
  .replace(/[\u0300-\u036f]/g, "").toLowerCase().trim();
const hoje = () => new Date().toISOString().slice(0, 10);
const dataBR = s => s ? s.slice(8, 10) + "/" + s.slice(5, 7) + "/" + s.slice(0, 4) : "";

function recado(host, tipo, txt) {
  host.insertAdjacentHTML("afterbegin",
    `<div class="recado ${tipo}">${esc(txt)}</div>`);
}

/* ============================================================
   SESSÃO — a conta é criada pelo administrador, não há cadastro
   aqui. Guardamos o token para o inspetor não ter de digitar a
   senha a cada vez que abre o app no campo.
   ============================================================ */
const CHAVE_SESSAO = "sesmt-inspecoes.sessao.v1";

const Sessao = {
  access: null, refresh: null, uid: null, email: null, inspetor: null,

  guardar() {
    try {
      localStorage.setItem(CHAVE_SESSAO, JSON.stringify(
        { access: this.access, refresh: this.refresh, uid: this.uid, email: this.email }));
    } catch (e) { /* aparelho sem armazenamento: segue só nesta aba */ }
  },
  esquecer() {
    this.access = this.refresh = this.uid = this.email = this.inspetor = null;
    try { localStorage.removeItem(CHAVE_SESSAO); } catch (e) {}
  },
  restaurar() {
    try {
      const g = JSON.parse(localStorage.getItem(CHAVE_SESSAO) || "null");
      if (g && g.access) Object.assign(this, g);
    } catch (e) {}
    return !!this.access;
  }
};

/* Erro de REDE não é erro de servidor, e o app trata os dois de forma
   diferente: sem sinal ele guarda e segue; recusado pelo banco ele avisa.
   Por isso todo erro de conexão sai daqui marcado com .rede = true. */
function erroDeRede() {
  const e = new Error("sem sinal");
  e.rede = true;
  return e;
}
const semRede = e => !!(e && e.rede) || !navigator.onLine;

async function auth(caminho, corpo) {
  let r;
  try {
    r = await fetch(SERVIDOR.url + "/auth/v1/" + caminho, {
      method: "POST",
      headers: { apikey: SERVIDOR.chave, "Content-Type": "application/json" },
      body: JSON.stringify(corpo)
    });
  } catch (e) { return { ok: false, rede: true, corpo: {} }; }
  let j = null;
  try { j = await r.json(); } catch (e) {}
  return { ok: r.ok, corpo: j || {} };
}

async function entrar(email, senha) {
  const r = await auth("token?grant_type=password", { email, password: senha });
  if (r.rede) return { erro: "Sem sinal. A primeira entrada precisa de internet — "
    + "depois disso o app abre e funciona no campo, mesmo sem conexão." };
  if (!r.ok || !r.corpo.access_token) {
    const m = String(r.corpo.error_description || r.corpo.msg || "").toLowerCase();
    return { erro: m.includes("invalid") ? "E-mail ou senha não conferem."
      : m.includes("confirm") ? "Esta conta ainda não foi confirmada. Fale com o administrador."
      : "Não foi possível entrar. Tente de novo em instantes." };
  }
  Sessao.access = r.corpo.access_token;
  Sessao.refresh = r.corpo.refresh_token;
  Sessao.uid = r.corpo.user && r.corpo.user.id;
  Sessao.email = email;
  Sessao.guardar();
  return {};
}

async function renovar() {
  if (!Sessao.refresh) return false;
  const r = await auth("token?grant_type=refresh_token", { refresh_token: Sessao.refresh });
  if (!r.ok || !r.corpo.access_token) { Sessao.esquecer(); return false; }
  Sessao.access = r.corpo.access_token;
  Sessao.refresh = r.corpo.refresh_token || Sessao.refresh;
  Sessao.uid = (r.corpo.user && r.corpo.user.id) || Sessao.uid;
  Sessao.guardar();
  return true;
}

/* ============================================================
   BANCO — PostgREST. Toda chamada leva o token do inspetor, então
   o que ele enxerga é o que as políticas deixam.
   ============================================================ */
async function api(caminho, opcoes, jaRenovou) {
  const o = opcoes || {};
  let r;
  try {
    r = await fetch(SERVIDOR.url + "/rest/v1/" + caminho, {
      method: o.method || "GET",
      headers: Object.assign({
        apikey: SERVIDOR.chave,
        Authorization: "Bearer " + Sessao.access,
        "Content-Type": "application/json"
      }, o.headers || {}),
      body: o.body ? JSON.stringify(o.body) : undefined
    });
  } catch (e) { throw erroDeRede(); }
  /* token vencido no meio do campo: renova uma vez e repete */
  if (r.status === 401 && !jaRenovou && await renovar()) return api(caminho, o, true);
  let j = null;
  try { j = await r.json(); } catch (e) {}
  if (!r.ok) {
    const msg = (j && (j.message || j.hint)) || ("erro " + r.status);
    throw new Error(msg);
  }
  return j;
}

/* ============================================================
   ESTADO
   ============================================================ */
const App = {
  departamentos: [], equipes: [], perguntas: {},   // por departamento
  tipos: [],                                       // tipo de equipe -> departamento
  rascunho: null,                                  // inspeção em preenchimento
  buscaEquipe: "",
  semSinal: false,                                 // rodando com o cadastro guardado
  fotosPendentes: 0                                // fotos gravadas aqui e ainda não enviadas
};

/* ============================================================
   CADASTRO GUARDADO NO APARELHO

   Departamentos, equipes, tipos e perguntas mudam raramente e são
   pequenos. Guardá-los é o que permite começar uma inspeção no meio
   do mato: sem isto o app abria (o service worker entrega a página),
   mas parava em "Buscando cadastros…" para sempre.

   Toda vez que o app consegue falar com o servidor, a cópia é
   refeita. Sem sinal, vale a última — e a tela diz que é ela.
   ============================================================ */
const CHAVE_CADASTROS = "sesmt-inspecoes.cadastros.v1";

const Cadastros = {
  ler() {
    try { return JSON.parse(localStorage.getItem(CHAVE_CADASTROS) || "null"); }
    catch (e) { return null; }
  },
  guardar() {
    try {
      localStorage.setItem(CHAVE_CADASTROS, JSON.stringify({
        inspetor: Sessao.inspetor, uid: Sessao.uid,
        departamentos: App.departamentos, equipes: App.equipes,
        tipos: App.tipos, perguntas: App.perguntas, em: Date.now()
      }));
    } catch (e) { /* sem espaço: o app segue, só não abre sem sinal */ }
  },
  /* Só serve a cópia de quem está logado agora: dois inspetores no mesmo
     aparelho não podem herdar o cadastro um do outro. */
  aplicar() {
    const c = this.ler();
    if (!c || !c.departamentos || !c.departamentos.length) return false;
    if (c.uid && Sessao.uid && c.uid !== Sessao.uid) return false;
    App.departamentos = c.departamentos;
    App.equipes = c.equipes || [];
    App.tipos = c.tipos || [];
    App.perguntas = c.perguntas || {};
    Sessao.inspetor = c.inspetor || Sessao.inspetor;
    return !!Sessao.inspetor;
  }
};

/* Identificador criado no próprio aparelho.

   A inspeção nascia com um POST no banco, e o id vinha de lá — o que
   tornava impossível começar uma inspeção sem sinal. Agora o id é gerado
   aqui e a linha no banco é criada quando houver conexão, com esse mesmo
   id. É um uuid: a chance de colisão com outro aparelho é desprezível. */
function novoId() {
  if (window.crypto && crypto.randomUUID) return crypto.randomUUID();
  return "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g, c => {
    const r = Math.random() * 16 | 0;
    return (c === "x" ? r : (r & 0x3 | 0x8)).toString(16);
  });
}

/* Cria no banco a linha da inspeção, se ela ainda não existir lá.

   Idempotente de propósito: pode ser chamada a cada tentativa de subida,
   e o banco resolve a repetição pelo id (on_conflict). */
async function garantirInspecao(R) {
  if (!R || R.noServidor) return;
  await api("sesmt_inspecoes?on_conflict=id", {
    method: "POST",
    headers: { Prefer: "resolution=merge-duplicates" },
    body: {
      id: R.id, departamento: R.dep.codigo, inspetor: R.inspetor || Sessao.inspetor,
      equipe: R.equipe, data: R.data, placa: R.placa || null,
      numero_obra: R.numeroObra || null,
      criada_por: R.criada_por || Sessao.uid
    }
  });
  R.noServidor = true;
}

/* ============================================================
   FILA DE ENVIO — o que o campo produziu e o servidor ainda não tem

   O rascunho do aparelho guarda UMA inspeção, a que está aberta. Quem
   termina uma inspeção sem sinal e começa outra precisa que a primeira
   fique em algum lugar até a conexão voltar: é esta fila.

   Cada item é uma inspeção inteira (respostas e desvios), com o id que
   ela já tem. Vai para o banco na ordem, quando der, e some da fila.
   Foto não entra aqui: arquivo não cabe no armazenamento do aparelho —
   sem sinal, ela continua não subindo, e o app diz isso.
   ============================================================ */
const CHAVE_FILA = "sesmt-inspecoes.fila.v1";

const Fila = {
  enviando: false,

  itens() {
    try { return JSON.parse(localStorage.getItem(CHAVE_FILA) || "[]") || []; }
    catch (e) { return []; }
  },
  gravar(lista) {
    try { localStorage.setItem(CHAVE_FILA, JSON.stringify(lista)); return true; }
    catch (e) { return false; }
  },
  achar(id) { return this.itens().find(x => x.id === id) || null; },

  /* Entra na fila, ou atualiza o que já estava lá com o mesmo id. */
  por(R, enviada) {
    const lista = this.itens().filter(x => x.id !== R.id);
    lista.push({
      id: R.id, dep: R.dep, equipe: R.equipe, data: R.data, placa: R.placa || "",
      numeroObra: R.numeroObra || "",
      respostas: R.respostas || {}, desvios: R.desvios || "",
      perguntas: R.perguntas || [], noServidor: !!R.noServidor,
      inspetor: R.inspetor || Sessao.inspetor, criada_por: R.criada_por || Sessao.uid,
      enviada_em: enviada ? new Date().toISOString() : null, em: Date.now()
    });
    return this.gravar(lista);
  },
  tirar(id) { this.gravar(this.itens().filter(x => x.id !== id)); },

  async subirUm(it) {
    /* Sem o nome do inspetor a política do banco recusa a inserção, e a
       inspeção ficaria presa na fila tomando erro. Melhor esperar a próxima
       rodada, quando o cadastro já tiver dito quem é. */
    if (!it.inspetor && !Sessao.inspetor) throw erroDeRede();
    if (!it.inspetor) it.inspetor = Sessao.inspetor;
    await garantirInspecao(it);
    const linhas = Object.entries(it.respostas || {})
      .map(([pergunta, resposta]) => ({ inspecao: it.id, pergunta, resposta }));
    if (linhas.length) {
      await api("sesmt_respostas?on_conflict=inspecao,pergunta", {
        method: "POST",
        headers: { Prefer: "resolution=merge-duplicates" },
        body: linhas
      });
    }
    /* enviada_em vai por último e junto com os desvios: inspeção marcada
       como enviada não aceita mais alteração, pela política do banco. */
    await api("sesmt_inspecoes?id=eq." + encodeURIComponent(it.id), {
      method: "PATCH",
      body: { desvios: it.desvios || null, enviada_em: it.enviada_em || null }
    });
    this.tirar(it.id);
  },

  /* Manda tudo o que dá. Erro de rede interrompe (não adianta insistir nos
     outros); erro do servidor num item guarda o motivo e passa ao próximo —
     nunca joga o item fora, que seria perder a inspeção do inspetor. */
  async enviarTudo() {
    if (this.enviando || !Sessao.inspetor) return 0;
    this.enviando = true;
    let mandou = 0;
    try {
      for (const it of this.itens()) {
        if (App.rascunho && App.rascunho.id === it.id) continue;  // ainda aberta
        try { await this.subirUm(it); mandou++; }
        catch (e) {
          if (semRede(e)) break;
          const lista = this.itens();
          const alvo = lista.find(x => x.id === it.id);
          if (alvo) { alvo.erro = e.message; this.gravar(lista); }
        }
      }
    } finally { this.enviando = false; }
    return mandou;
  }
};

/* ============================================================
   RASCUNHO — a resposta não pode se perder

   Inspeção é feita em campo, com sinal ruim e celular que morre.
   Antes, o que o inspetor respondia só saía da memória quando ele
   apertava "Salvar rascunho": fechar o app no meio custava tudo.

   Agora são duas camadas:
   1. O APARELHO, a cada toque. Gravação síncrona no localStorage,
      sem rede envolvida — é o que sobrevive a fechar o app, acabar
      a bateria ou o navegador descartar a aba.
   2. O SERVIDOR, sozinho, alguns segundos depois da última resposta.
      Sem sinal, fica pendente e vai quando a conexão voltar.

   O que manda é a camada 1: enquanto houver cópia no aparelho, nada
   se perdeu, mesmo que o servidor nunca tenha sido alcançado.
   ============================================================ */
const CHAVE_RASCUNHO = "sesmt-inspecoes.rascunho.v1";
const ESPERA_SYNC = 1500;   // ms de quietude antes de mandar ao servidor

const Rascunho = {
  timer: null,
  sincronizando: false,
  emCurso: null,            // promessa da subida no ar, para quem chegar depois
  pendente: false,          // há coisa gravada aqui que o servidor não tem
  aoMudarEstado: null,      // a tela liga aqui para mostrar a situação

  /* Camada 1: instantânea, sem rede. */
  guardar() {
    const R = App.rascunho;
    if (!R) return;
    this.pendente = true;
    try {
      localStorage.setItem(CHAVE_RASCUNHO, JSON.stringify({
        id: R.id, dep: R.dep, equipe: R.equipe, data: R.data, placa: R.placa,
        numeroObra: R.numeroObra || "",
        respostas: R.respostas, desvios: R.desvios, perguntas: R.perguntas,
        noServidor: !!R.noServidor, criada_por: R.criada_por || Sessao.uid,
        inspetor: R.inspetor || Sessao.inspetor, em: Date.now()
      }));
    } catch (e) {
      /* Sem armazenamento (aba privada, disco cheio) o app segue
         funcionando, só perde a rede de segurança. Avisa a tela. */
      this.semArmazenamento = true;
    }
    this.avisar();
    this.agendar();
  },

  lerGuardado() {
    try { return JSON.parse(localStorage.getItem(CHAVE_RASCUNHO) || "null"); }
    catch (e) { return null; }
  },

  limpar() {
    this.pendente = false;
    clearTimeout(this.timer);
    try { localStorage.removeItem(CHAVE_RASCUNHO); } catch (e) {}
    this.avisar();
  },

  /* Camada 2: espera o inspetor parar de responder e manda. Cada
     resposta nova adia o envio, para não disparar 36 chamadas
     seguidas enquanto ele preenche. */
  agendar() {
    clearTimeout(this.timer);
    this.timer = setTimeout(() => this.sincronizar(), ESPERA_SYNC);
  },

  /* Já existe uma subida no ar? ESPERA ela acabar e sobe de novo — não
     devolve false.

     Devolver false quebrava os dois botões que dependem disto. O rascunho
     sobe sozinho 1,5 s depois de cada resposta; quem responde e toca em
     "← Início" ou "Enviar" logo em seguida cai bem no meio dessa subida, e
     recebia "o servidor não respondeu" com a rede perfeita. */
  async sincronizar(forcar) {
    if (this.emCurso) {
      await this.emCurso.catch(() => {});
      if (!forcar && !this.pendente) return true;
    }
    this.emCurso = this.subir(forcar);
    try { return await this.emCurso; }
    finally { this.emCurso = null; }
  },

  async subir(forcar) {
    const R = App.rascunho;
    if (!R || (!this.pendente && !forcar)) return true;
    this.sincronizando = true;
    this.avisar();
    try {
      /* A inspeção pode ter nascido sem sinal, só no aparelho: a linha dela
         no banco é criada aqui, na primeira subida que der certo. */
      await garantirInspecao(R);
      const linhas = Object.entries(R.respostas)
        .map(([pergunta, resposta]) => ({ inspecao: R.id, pergunta, resposta }));
      if (linhas.length) {
        await api("sesmt_respostas?on_conflict=inspecao,pergunta", {
          method: "POST",
          headers: { Prefer: "resolution=merge-duplicates" },
          body: linhas
        });
      }
      await api("sesmt_inspecoes?id=eq." + encodeURIComponent(R.id), {
        method: "PATCH", body: { desvios: R.desvios || null }
      });
      this.pendente = false;
      return true;
    } catch (e) {
      /* Falhou: o que importa é que a camada 1 continua de pé. */
      this.pendente = true;
      return false;
    } finally {
      this.sincronizando = false;
      this.avisar();
    }
  },

  situacao() {
    if (this.semArmazenamento) return { txt: "sem memória no aparelho", cls: "aviso" };
    if (this.sincronizando) return { txt: "salvando…", cls: "" };
    if (this.pendente) return navigator.onLine
      ? { txt: "salvo no aparelho", cls: "" }
      : { txt: "sem sinal — salvo no aparelho", cls: "aviso" };
    return { txt: "salvo", cls: "ok" };
  },

  avisar() { if (this.aoMudarEstado) this.aoMudarEstado(this.situacao()); }
};

/* Voltou o sinal: manda o que estiver pendente, sem o inspetor pedir —
   a inspeção aberta e também as que ficaram na fila. */
window.addEventListener("online", async () => {
  App.semSinal = false;
  await Rascunho.sincronizar();
  const n = await Fila.enviarTudo();
  /* Fotos depois das inspeções: é a linha da inspeção que a foto precisa
     ter no banco para poder existir. */
  await FotosLocais.enviarTudo();
  pintarSinal();
  baixarTodasAsPerguntas();
  if (n) mostrarInicioSePuder();
});
window.addEventListener("offline", () => { App.semSinal = true; pintarSinal(); });

/* Só redesenha a tela inicial se for ela que está aberta: no meio de uma
   inspeção, trocar a tela por baixo do inspetor apagaria o que ele vê. */
function mostrarInicioSePuder() {
  if (!App.rascunho && Sessao.inspetor && document.querySelector("#deps")) telaInicio();
}

/* Saindo da tela (trocou de app, bloqueou o celular): grava agora, sem
   esperar o temporizador. É o momento em que o navegador mais mata aba. */
document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "hidden" && App.rascunho) {
    Rascunho.guardar();
    Rascunho.sincronizar();
  }
});

/* ============================================================
   TELAS
   ============================================================ */
function topo(titulo, mostrarSair) {
  $("#tituloTopo").textContent = titulo;
  $("#btSair").classList.toggle("oculto", !mostrarSair);
  pintarSinal();
}

/* Etiqueta de conexão no alto da tela: "sem sinal" quando não há rede, e
   "N a enviar" quando há inspeção esperando para subir. */
function pintarSinal() {
  const el = $("#sinal");
  if (!el) return;
  const fora = !navigator.onLine || App.semSinal;
  const n = Fila.itens().length + (App.fotosPendentes || 0);
  el.classList.toggle("fila", !fora && n > 0);
  if (fora) el.textContent = n ? "sem sinal · " + n + " a enviar" : "sem sinal";
  else if (n) el.textContent = n + " a enviar";
  el.classList.toggle("oculto", !fora && !n);
}

/* Carimbo de versão no fim da tela. Toque nele para forçar a busca de uma
   versão nova: pede ao service worker que se atualize e recarrega. */
function carimboVersao(host) {
  const d = document.createElement("p");
  d.className = "versao";
  d.textContent = VERSAO_APP + " · toque para atualizar";
  d.onclick = async () => {
    d.textContent = "Procurando versão nova…";
    try {
      if (navigator.serviceWorker) {
        const regs = await navigator.serviceWorker.getRegistrations();
        await Promise.all(regs.map(r => r.update()));
      }
      if (window.caches) {
        const nomes = await caches.keys();
        await Promise.all(nomes.map(n => caches.delete(n)));
      }
    } catch (e) { /* sem SW ou sem cache: recarregar já basta */ }
    location.reload(true);
  };
  host.appendChild(d);
}
function rodape(html) {
  const r = $("#rodape");
  r.classList.toggle("oculto", !html);
  $("#rodapeDentro").innerHTML = html || "";
}

/* ---------- 1. Entrar ---------- */
function telaLogin(aviso) {
  topo("Inspeções SESMT", false);
  rodape("");
  tela().innerHTML = `
    <h2>Entrar</h2>
    <p class="sub">Use a conta que o administrador criou para você.
      Se ainda não tem, fale com ele — não há cadastro por aqui.</p>
    <form id="fLogin" novalidate>
      <label class="campo"><span>E-mail</span>
        <input type="email" id="email" autocomplete="username" required
               inputmode="email" autocapitalize="none" spellcheck="false"></label>
      <label class="campo"><span>Senha</span>
        <input type="password" id="senha" autocomplete="current-password" required></label>
      <button class="principal" type="submit" id="btEntrar">Entrar</button>
    </form>`;
  if (aviso) recado(tela(), "erro", aviso);
  carimboVersao(tela());

  $("#fLogin").onsubmit = async ev => {
    ev.preventDefault();
    const b = $("#btEntrar");
    const email = $("#email").value.trim(), senha = $("#senha").value;
    if (!email || !senha) return telaLogin("Preencha e-mail e senha.");
    b.disabled = true; b.textContent = "Entrando…";
    const r = await entrar(email, senha);
    if (r.erro) { telaLogin(r.erro); $("#email").value = email; return; }
    iniciar();
  };
}

/* ---------- 2. Carregar cadastros e decidir para onde ir ---------- */
async function iniciar() {
  topo("Carregando…", true);
  tela().innerHTML = `<p class="sub">Buscando cadastros…</p>`;
  rodape("");
  try {
    /* Quem é este inspetor? Vem do cadastro pelo user_id, nunca do
       aparelho — foi digitar o nome à mão que criou "Arisleudo". */
    const eu = await api("sesmt_inspetores?select=inspetor,polo,funcao&user_id=eq."
                         + encodeURIComponent(Sessao.uid) + "&ativo=is.true");
    if (!eu.length) {
      topo("Inspeções SESMT", true);
      tela().innerHTML = "";
      recado(tela(), "aviso",
        "Sua conta entrou, mas ainda não está ligada a nenhum inspetor do cadastro. "
        + "Peça ao administrador para fazer essa ligação — sem ela o app não deixa criar inspeção.");
      return;
    }
    Sessao.inspetor = eu[0].inspetor;

    const [deps, eqs, tipos] = await Promise.all([
      api("sesmt_departamentos?select=codigo,nome&ativo=is.true&order=ordem"),
      api("sesmt_equipes?select=equipe,tipo,supervisor&order=equipe"),
      api("sesmt_tipos_equipe?select=tipo,nome,departamento&order=ordem")
    ]);
    App.departamentos = deps;
    App.equipes = eqs;
    App.tipos = tipos;
    App.semSinal = false;
    Cadastros.guardar();          // é esta cópia que faz o app abrir sem sinal
    Fila.enviarTudo().then(() => FotosLocais.enviarTudo());
    baixarTodasAsPerguntas();     // deixa o aparelho pronto para o campo
    telaInicio();
  } catch (e) {
    /* Sem sinal, com cadastro guardado, o app trabalha igual: o que muda é
       que a lista de inspeções vem do aparelho e o envio fica para depois. */
    if (semRede(e) && Cadastros.aplicar()) {
      App.semSinal = true;
      telaInicio();
      return;
    }
    topo("Inspeções SESMT", true);
    tela().innerHTML = "";
    recado(tela(), "erro", semRede(e)
      ? "Sem sinal, e este aparelho ainda não tem o cadastro guardado. "
        + "Abra o app uma vez com internet — depois disso ele funciona no campo."
      : "Não deu para carregar os cadastros: " + e.message);
  }
}

/* ---------- 3. Início: nova inspeção ou continuar ---------- */
async function telaInicio() {
  topo(Sessao.inspetor, true);
  rodape("");
  tela().innerHTML = `
    <h2>Nova inspeção</h2>
    <p class="sub">Escolha o departamento da equipe que você vai inspecionar.</p>
    <div class="cartoes" id="deps"></div>
    <div id="minhas"></div>`;

  $("#deps").innerHTML = App.departamentos.map(d =>
    `<button class="cartao" data-cod="${esc(d.codigo)}">
       <span><b>${esc(d.nome)}</b></span>
       <span class="seta">›</span>
     </button>`).join("");
  $("#deps").querySelectorAll(".cartao").forEach(b =>
    b.onclick = () => telaEquipe(App.departamentos.find(d => d.codigo === b.dataset.cod)));
  marcarDepsSemPerguntas();

  /* Sobrou rascunho no aparelho de uma sessão anterior? Aparece primeiro,
     antes de tudo: é o que o inspetor mais precisa ver ao abrir. */
  /* O resgate vem ANTES do aviso e do envio: é ele que põe na fila a inspeção
     que só existia no aparelho, e sem essa ordem ela ficaria esperando a
     próxima abertura para subir. */
  const guardado = resgatarRascunhoSolto();

  const naFilaAgora = Fila.itens().length;
  if (!navigator.onLine || App.semSinal) {
    recado(tela(), "aviso",
      "Sem sinal: o app está usando o cadastro guardado neste aparelho. "
      + "Dá para inspecionar e fotografar normalmente; tudo sobe quando a conexão voltar"
      + (naFilaAgora ? `. ${naFilaAgora} inspeção(ões) esperando para subir.` : "."));
  } else if (naFilaAgora) {
    recado(tela(), "aviso", `${naFilaAgora} inspeção(ões) ainda não chegaram ao `
      + "sistema. Estão subindo agora — deixe o app aberto um instante.");
    Fila.enviarTudo().then(n => { if (n) { FotosLocais.enviarTudo(); telaInicio(); } });
  }

  if (guardado && guardado.inspetor === Sessao.inspetor) {
    const quando = new Date(guardado.em);
    const n = Object.keys(guardado.respostas || {}).length;
    recado(tela(), "aviso",
      `Você tem uma inspeção começada em ${esc(guardado.equipe)} — ${n} `
      + `${n === 1 ? "resposta" : "respostas"}, de `
      + `${quando.toLocaleDateString("pt-BR")} às `
      + `${quando.toLocaleTimeString("pt-BR", { hour: "2-digit", minute: "2-digit" })}. `
      + "Ela está na lista abaixo, como rascunho.");
    pintarSinal();
  }

  /* As últimas inspeções deste inspetor, para retomar rascunho */
  try {
    /* TODOS os rascunhos e SÓ a última enviada.

       Antes eram "as 10 últimas", sem filtrar por inspetor — e depois que as
       122 do histórico entraram no banco, a tela virava uma pilha de inspeções
       de abril, todas enviadas, que não servem para nada aqui: enviada não se
       edita. O que o inspetor precisa ver é o que ele ainda pode retomar. A
       última enviada fica como recibo do que acabou de mandar. */
    const meu = "&inspetor=eq." + encodeURIComponent(Sessao.inspetor);
    let rascunhos = [], ultima = [];
    if (!App.semSinal && navigator.onLine) {
      [rascunhos, ultima] = await Promise.all([
        api("sesmt_inspecoes?select=id,departamento,equipe,data,enviada_em"
            + "&enviada_em=is.null" + meu + "&order=criada_em.desc"),
        api("sesmt_inspecoes?select=id,departamento,equipe,data,enviada_em"
            + "&enviada_em=not.is.null" + meu + "&order=enviada_em.desc&limit=1")
      ]);
    }
    /* O que está na fila do aparelho aparece primeiro e não pode sumir da
       lista só porque o servidor ainda não sabe dele. Item já enviado pelo
       inspetor entra como "a enviar": ele não deve mexer mais nisso. */
    const naFila = Fila.itens().map(x => ({
      id: x.id, departamento: x.dep && x.dep.codigo, equipe: x.equipe, data: x.data,
      enviada_em: null, fila: true, jaEnviada: !!x.enviada_em
    }));
    const idsFila = new Set(naFila.map(x => x.id));
    const lista = naFila.concat(rascunhos.filter(r => !idsFila.has(r.id))).concat(ultima);
    /* Sem nada para mostrar não desenha a seção — mas segue em frente:
       um return aqui pulava o carimbo de versão no fim da função. */
    if (!lista.length) { carimboVersao(tela()); return; }
    const nomeDep = c => (App.departamentos.find(d => d.codigo === c) || {}).nome || c;
    const nRasc = naFila.filter(x => !x.jaEnviada).length + rascunhos.filter(r => !idsFila.has(r.id)).length;
    const nEspera = naFila.filter(x => x.jaEnviada).length;
    $("#minhas").innerHTML = `<h2 style="margin-top:26px">Suas inspeções</h2>
      <p class="sub">${nRasc
        ? `${nRasc} em rascunho, que dá para retomar.`
        : "Nenhum rascunho aberto."}${nEspera
        ? ` ${nEspera} esperando sinal para subir.` : ""}${ultima.length
        ? " Abaixo, a última que você enviou." : ""}</p>` +
      lista.map(i => {
        const espera = i.fila && i.jaEnviada;      // pronta, só falta chegar ao servidor
        const trava = !!i.enviada_em || espera;
        return `<div class="insp-linha">
        <button class="insp" data-id="${esc(i.id)}" ${trava ? "disabled" : ""}>
          <span style="flex:1 1 auto">
            <b>${esc(i.equipe)}</b>
            <small>${esc(nomeDep(i.departamento))} · ${dataBR(i.data)}</small>
          </span>
          <span class="etiq ${i.enviada_em ? "enviada" : espera ? "espera" : "rascunho"}">${
            i.enviada_em ? "enviada" : espera ? "a enviar" : "rascunho"}</span>
        </button>
        ${trava ? "" : `<button class="insp-x" data-id="${esc(i.id)}"
          data-equipe="${esc(i.equipe)}" title="Excluir este rascunho"
          aria-label="Excluir o rascunho de ${esc(i.equipe)}">✕</button>`}
      </div>`; }).join("");
    $("#minhas").querySelectorAll(".insp:not([disabled])").forEach(b =>
      b.onclick = () => retomar(b.dataset.id));
    $("#minhas").querySelectorAll(".insp-x").forEach(b =>
      b.onclick = () => excluirRascunho(b.dataset.id, b.dataset.equipe));
  } catch (e) { /* lista é conforto, não trava o app */ }
  carimboVersao(tela());
}

/* Inspeção que ficou só no aparelho tem de aparecer na lista.

   Até a v11 ela sumia, e o relato do campo foi exatamente esse: inspeção
   começada sem sinal, app fechado, e ao abrir com internet o rascunho tinha
   desaparecido. O motivo: a lista da tela inicial vinha do SERVIDOR, e uma
   inspeção criada offline ainda não existe lá. Antes da v9 isso não acontecia
   porque a inspeção nascia com um POST — foi essa mudança que abriu o buraco.

   Aqui o rascunho guardado passa para a FILA, que é o que a tela lista e o que
   sobe sozinho quando o sinal volta. Retomar tira da fila de volta; nada é
   apagado antes de o servidor ter as respostas.

   Devolve o rascunho encontrado, para a tela poder avisar sobre ele. */
function resgatarRascunhoSolto() {
  const g = Rascunho.lerGuardado();
  if (!g || !g.id) return null;
  if (App.rascunho && App.rascunho.id === g.id) return g;   // está aberta agora
  if (g.inspetor && Sessao.inspetor && g.inspetor !== Sessao.inspetor) return null;
  if (!Fila.achar(g.id)) Fila.por(g, false);
  Rascunho.limpar();          // a fila é a dona dele agora
  return g;
}

/* Excluir rascunho — apaga do BANCO, não só do aparelho.

   O rascunho nasce no banco antes da primeira resposta, para o celular
   morrer no mato sem levar junto o que já foi respondido. O preço disso é
   que rascunho abandonado fica lá: em 27/08/2026 havia dois, de 26/08, um
   deles com 36 respostas. As respostas somem junto, por cascata.

   Só rascunho: a política do banco (sesmt_inspecoes_apaga) recusa apagar
   inspeção enviada, e o botão nem aparece nela. */
async function excluirRascunho(id, equipe) {
  if (!confirm(`Excluir o rascunho de ${equipe}?\n\n`
      + "As respostas já dadas nele serão perdidas. Não dá para desfazer."))
    return;
  /* Rascunho que só existe no aparelho morre aqui mesmo — pedir ao banco
     para apagar o que ele nunca teve daria erro na cara do inspetor. */
  /* As fotos guardadas desta inspeção vão junto: sem a inspeção, elas
     nunca seriam aceitas pelo banco e ficariam tentando subir para sempre. */
  for (const f of await FotosLocais.daInspecao(id)) await FotosLocais.apagar(f.id);
  pintarSinal();

  const naFila = Fila.achar(id);
  if (naFila) {
    Fila.tirar(id);
    const local = Rascunho.lerGuardado();
    if (local && local.id === id) Rascunho.limpar();
    if (!naFila.noServidor) {
      await telaInicio();
      recado(tela(), "ok", `Rascunho de ${equipe} excluído.`);
      return;
    }
  }
  try {
    await api("sesmt_inspecoes?id=eq." + encodeURIComponent(id), { method: "DELETE" });
    /* Era este que estava guardado no aparelho? Então limpa também, senão
       o app ofereceria retomar uma inspeção que não existe mais. */
    const local = Rascunho.lerGuardado();
    if (local && local.id === id) {
      Rascunho.limpar();
      if (App.rascunho && App.rascunho.id === id) App.rascunho = null;
    }
    await telaInicio();
    recado(tela(), "ok", `Rascunho de ${equipe} excluído.`);
  } catch (e) {
    recado(tela(), "erro", "Não deu para excluir: " + e.message);
  }
}

/* As equipes de um departamento saem do TIPO delas: linha morta e
   manutenção são de DCMD C&M, poda é de DCMD PODA, e assim por diante.
   A regra mora no banco (sesmt_tipos_equipe) para o app e o painel
   lerem a mesma — duas cópias divergem com o tempo. */
function equipesDo(codigo) {
  const meus = new Set(App.tipos.filter(t => t.departamento === codigo).map(t => t.tipo));
  return App.equipes.filter(e => meus.has(e.tipo));
}

/* ---------- 4. Escolher a equipe ---------- */
function telaEquipe(dep) {
  topo(dep.nome, true);
  rodape(`<button class="secundario" id="btVoltar">← Departamento</button>`);
  App.buscaEquipe = "";
  const equipes = equipesDo(dep.codigo);

  if (!equipes.length) {
    tela().innerHTML = "";
    recado(tela(), "aviso", `Nenhuma equipe de ${dep.nome} está cadastrada. `
      + "Fale com o administrador — o departamento de uma equipe vem do tipo dela.");
    $("#btVoltar").onclick = telaInicio;
    return;
  }

  tela().innerHTML = `
    <h2>Qual equipe?</h2>
    <p class="sub">${equipes.length} ${equipes.length === 1 ? "equipe" : "equipes"} de
      ${esc(dep.nome)}. Busque pelo nome ou pelo supervisor.</p>
    <div class="busca">
      <input type="search" id="bq" placeholder="Buscar equipe ou supervisor…" aria-label="Buscar equipe">
      <span class="conta" id="cq"></span>
    </div>
    <div class="equipes" id="lq"></div>
    <div class="vazio oculto" id="vq">Nenhuma equipe bate com a busca.</div>`;

  $("#lq").innerHTML = equipes.map(e =>
    `<button class="equipe" data-eq="${esc(e.equipe)}"
       data-busca="${esc(e.equipe + " " + (e.supervisor || ""))}">
       <span><b>${esc(e.equipe)}</b>
         <small>${esc(e.supervisor || "sem supervisor")}</small></span>
     </button>`).join("");

  const cx = $("#bq");
  const filtrar = () => {
    const q = semAcento(cx.value);
    let n = 0;
    $("#lq").querySelectorAll(".equipe").forEach(b => {
      const bate = !q || semAcento(b.dataset.busca).includes(q);
      b.hidden = !bate;
      if (bate) n++;
    });
    $("#cq").textContent = q ? (n ? n + " de " + equipes.length : "") : "";
    $("#vq").classList.toggle("oculto", !(q && !n));
  };
  cx.oninput = () => { App.buscaEquipe = cx.value; filtrar(); };
  $("#lq").querySelectorAll(".equipe").forEach(b =>
    b.onclick = () => telaDados(dep, b.dataset.eq));
  $("#btVoltar").onclick = telaInicio;
}

/* Equipes dos departamentos de linha viva e C&M acompanham uma obra — as
   demais não têm esse número, então o campo só aparece para elas, e sempre
   opcional. É o DEPARTAMENTO (ex.: "DCMD C&M") que carrega esse nome, não
   a equipe em si (ex.: "CNT 01"). Comparação tolerante (maiúsculas, sem
   acento, sem espaço extra) porque o nome exato é quem o banco cadastrou,
   não uma constante daqui. */
function precisaObra(dep) {
  const e = (dep && dep.nome || "").toUpperCase().normalize("NFD").replace(/[̀-ͯ]/g, "");
  return e.includes("LINHA VIVA") || e.replace(/\s+/g, "").includes("C&M");
}

/* ---------- 5. Dados da inspeção ---------- */
function telaDados(dep, equipe) {
  topo(equipe, true);
  rodape(`<button class="secundario" id="btVoltar">← Equipe</button>
          <button class="principal" id="btIr">Começar</button>`);
  tela().innerHTML = `
    <h2>${esc(equipe)}</h2>
    <p class="sub">${esc(dep.nome)} · inspetor ${esc(Sessao.inspetor)}</p>
    <label class="campo"><span>Data da inspeção</span>
      <input type="date" id="dt" value="${hoje()}" max="${hoje()}"></label>
    <label class="campo"><span>Placa do veículo</span>
      <input type="text" id="pl" placeholder="AAA1A11" maxlength="8"
             autocapitalize="characters" spellcheck="false"></label>
    ${precisaObra(dep) ? `<label class="campo"><span>Número da obra (opcional)</span>
      <input type="text" id="ob" inputmode="numeric" placeholder="0000000000" maxlength="10"></label>` : ""}`;

  /* A placa vinha suja do Google Forms: "QFD8E92", "QFD8E92 " e
     "Qfd5j42" contavam como três. Aqui normaliza na digitação. */
  $("#pl").oninput = ev => {
    ev.target.value = ev.target.value.toUpperCase().replace(/[^A-Z0-9]/g, "").slice(0, 7);
  };
  /* Número da obra: só dígito, padrão de 10 dígitos. */
  const obCampo = $("#ob");
  if (obCampo) obCampo.oninput = ev => {
    ev.target.value = ev.target.value.replace(/\D/g, "").slice(0, 10);
  };
  $("#btVoltar").onclick = () => telaEquipe(dep);
  $("#btIr").onclick = async () => {
    const dt = $("#dt").value;
    if (!dt) return recado(tela(), "erro", "Escolha a data da inspeção.");
    const ob = $("#ob");
    await abrirPerguntas(dep, equipe, dt, $("#pl").value.trim(), ob ? ob.value.trim() : "");
  };
}

/* ---------- 6. Perguntas ---------- */
async function perguntasDe(codigo, forcar) {
  if (App.perguntas[codigo] && !forcar) return App.perguntas[codigo];
  const r = await api("sesmt_pergunta_departamento?select=ordem,sesmt_perguntas(codigo,texto)"
                      + "&departamento=eq." + encodeURIComponent(codigo) + "&order=ordem");
  App.perguntas[codigo] = r
    .filter(x => x.sesmt_perguntas)
    .map(x => ({ codigo: x.sesmt_perguntas.codigo, texto: x.sesmt_perguntas.texto }));
  Cadastros.guardar();      // guarda as perguntas junto: é o que falta para o campo
  return App.perguntas[codigo];
}

/* Baixa as perguntas de TODOS os departamentos, em segundo plano.

   Antes só era guardado o departamento que o inspetor tivesse aberto com
   internet — e no campo, ao escolher outro, o app dizia "as perguntas de DEOP
   ainda não estão guardadas neste aparelho", que é exatamente a hora em que
   não há como buscá-las. São poucas centenas de linhas de texto no total:
   guardar tudo custa menos do que uma foto.

   Roda solta, sem travar a tela, e a cada abertura com internet — assim
   pergunta corrigida no banco chega ao aparelho sozinha. */
async function baixarTodasAsPerguntas() {
  for (const d of App.departamentos) {
    try { await perguntasDe(d.codigo, true); }
    catch (e) { if (semRede(e)) break; }   // sem sinal: fica para a próxima abertura
  }
  Cadastros.guardar();
  if (document.querySelector("#deps")) marcarDepsSemPerguntas();
}

/* Sem sinal, departamento sem perguntas guardadas não abre — melhor dizer
   isso no próprio cartão do que deixar tocar e bater num erro. */
function marcarDepsSemPerguntas() {
  const fora = !navigator.onLine || App.semSinal;
  document.querySelectorAll("#deps .cartao").forEach(b => {
    const falta = fora && !(App.perguntas[b.dataset.cod] || []).length;
    b.classList.toggle("indisponivel", falta);
    b.disabled = falta;
    b.title = falta ? "As perguntas deste departamento ainda não estão guardadas "
                    + "no aparelho. Abra-o uma vez com internet." : "";
    const marca = b.querySelector(".dep-falta");
    if (falta && !marca) b.insertAdjacentHTML("afterbegin",
      `<span class="dep-falta">precisa de internet</span>`);
    if (!falta && marca) marca.remove();
  });
}

async function abrirPerguntas(dep, equipe, data, placa, numeroObra) {
  topo("Carregando…", true);
  tela().innerHTML = `<p class="sub">Buscando as perguntas de ${esc(dep.nome)}…</p>`;
  rodape("");
  try {
    const perg = await perguntasDe(dep.codigo);
    /* A inspeção nasce no APARELHO, com id gerado aqui. A linha no banco
       vem depois, na primeira subida com sinal — é o que permite começar
       uma inspeção no meio do mato. O que protege as respostas continua
       sendo a gravação local a cada toque. */
    App.rascunho = {
      id: novoId(), dep: dep, equipe: equipe, data: data, placa: placa,
      numeroObra: numeroObra || "",
      perguntas: perg, respostas: {}, desvios: "",
      noServidor: false, inspetor: Sessao.inspetor, criada_por: Sessao.uid
    };
    Rascunho.guardar();
    telaPerguntas();
    if (!navigator.onLine) recado(tela(), "aviso",
      "Sem sinal: a inspeção está sendo gravada no aparelho e sobe sozinha "
      + "quando a conexão voltar. As fotos também — ficam guardadas aqui até subirem.");
  } catch (e) {
    topo(equipe, true);
    tela().innerHTML = "";
    recado(tela(), "erro", semRede(e)
      ? "Sem sinal, e as perguntas de " + esc(dep.nome) + " ainda não estão "
        + "guardadas neste aparelho. Abra este departamento uma vez com internet."
      : "Não deu para começar a inspeção: " + e.message);
    rodape(`<button class="secundario" id="btVoltar">← Voltar</button>`);
    $("#btVoltar").onclick = () => telaDados(dep, equipe);
  }
}

async function retomar(id) {
  topo("Carregando…", true);
  tela().innerHTML = `<p class="sub">Abrindo o rascunho…</p>`;

  /* Rascunho que ainda está na fila do aparelho abre daqui mesmo, sem
     perguntar ao servidor — ele é a versão mais nova que existe. */
  const naFila = Fila.achar(id);
  if (naFila && !naFila.enviada_em) {
    Fila.tirar(id);
    App.rascunho = {
      id: naFila.id, dep: naFila.dep, equipe: naFila.equipe, data: naFila.data,
      placa: naFila.placa || "", numeroObra: naFila.numeroObra || "",
      perguntas: naFila.perguntas || [],
      respostas: naFila.respostas || {}, desvios: naFila.desvios || "",
      noServidor: !!naFila.noServidor, inspetor: naFila.inspetor,
      criada_por: naFila.criada_por
    };
    if (!App.rascunho.perguntas.length) {
      try { App.rascunho.perguntas = await perguntasDe(naFila.dep.codigo); }
      catch (e) { /* segue com o que houver */ }
    }
    Rascunho.guardar();
    telaPerguntas();
    return;
  }

  try {
    const i = (await api("sesmt_inspecoes?select=*&id=eq." + encodeURIComponent(id)))[0];
    const dep = App.departamentos.find(d => d.codigo === i.departamento);
    const perg = await perguntasDe(i.departamento);
    const resp = await api("sesmt_respostas?select=pergunta,resposta&inspecao=eq."
                           + encodeURIComponent(id));
    App.rascunho = {
      id: i.id, dep: dep, equipe: i.equipe, data: i.data, placa: i.placa || "",
      numeroObra: i.numero_obra || "",
      perguntas: perg, desvios: i.desvios || "", noServidor: true,
      inspetor: Sessao.inspetor, criada_por: i.criada_por || Sessao.uid,
      respostas: Object.fromEntries(resp.map(r => [r.pergunta, r.resposta]))
    };
    /* Se o aparelho tiver uma cópia desta mesma inspeção com mais
       respostas do que o servidor, é porque ficou pendente: vale a
       do aparelho, que é a mais nova. */
    const local = Rascunho.lerGuardado();
    if (local && local.id === i.id) {
      const nLocal = Object.keys(local.respostas || {}).length;
      const nServidor = Object.keys(App.rascunho.respostas).length;
      if (nLocal >= nServidor) {
        App.rascunho.respostas = local.respostas || {};
        App.rascunho.desvios = local.desvios || App.rascunho.desvios;
        App.rascunho.numeroObra = local.numeroObra || App.rascunho.numeroObra;
        Rascunho.pendente = nLocal > nServidor;
      }
    }
    Rascunho.guardar();
    telaPerguntas();
  } catch (e) {
    tela().innerHTML = "";
    recado(tela(), "erro", "Não deu para abrir: " + e.message);
    rodape(`<button class="secundario" id="btVoltar">← Início</button>`);
    $("#btVoltar").onclick = telaInicio;
  }
}

function telaPerguntas() {
  const R = App.rascunho;
  topo(R.equipe, true);
  tela().innerHTML = `
    <div class="progresso">
      <div class="barra"><i id="bi" style="width:0%"></i></div>
      <div class="txt"><span id="bt">0 de ${R.perguntas.length}</span>
        <span id="bn"></span></div>
      <div class="situacao" id="bs"></div>
    </div>
    <div id="lp"></div>
    <label class="campo" style="margin-top:16px"><span>Desvios encontrados</span>
      <textarea id="dv" placeholder="Descreva o que foi encontrado. Se não houve, escreva &quot;Não houve desvios&quot;."></textarea></label>

    <div class="campo"><span>Fotos</span>
      <p class="sub" style="margin:0 0 8px">Tire na hora ou escolha da galeria.
        Cada foto sobe assim que é escolhida.</p>
      ${["desvio", "boa_pratica"].map(t => `
      <div class="fotos-grupo" data-tipo="${t}">
        <div class="fotos-tit">${t === "desvio" ? "Desvios" : "Boas práticas"}</div>
        <div class="fotos-lista"></div>
        <div class="fotos-botoes">
          <label class="fotos-add">
            <input type="file" accept="image/*" capture="environment" hidden>
            <span>📷 Tirar foto</span></label>
          <label class="fotos-add">
            <input type="file" accept="image/*" multiple hidden>
            <span>🖼 Da galeria</span></label>
        </div>
      </div>`).join("")}
    </div>`;

  $("#lp").innerHTML = R.perguntas.map((p, i) => `
    <div class="pergunta pendente" data-cod="${esc(p.codigo)}">
      <div class="texto"><span class="num">${i + 1}</span>${esc(p.texto)}</div>
      <div class="opcoes">
        <button type="button" data-v="conforme">Conforme</button>
        <button type="button" data-v="nao_conforme">Não conforme</button>
        <button type="button" data-v="na">N/A</button>
      </div>
    </div>`).join("");

  Rascunho.aoMudarEstado = est => {
    const el = $("#bs");
    if (!el) return;
    el.textContent = est.txt;
    el.className = "situacao " + est.cls;
  };
  Rascunho.avisar();

  $("#dv").value = R.desvios || "";
  $("#dv").oninput = ev => { R.desvios = ev.target.value; Rascunho.guardar(); };

  ligarFotos();

  $("#lp").querySelectorAll(".pergunta").forEach(bloco => {
    const cod = bloco.dataset.cod;
    bloco.querySelectorAll(".opcoes button").forEach(b => {
      b.onclick = () => {
        R.respostas[cod] = b.dataset.v;
        pintar(bloco, cod); atualizar();
        Rascunho.guardar();          // no aparelho agora, no servidor daqui a pouco
      };
    });
    pintar(bloco, cod);
  });
  /* o rodapé vem antes de atualizar(): é ele que cria o botão Enviar,
     e atualizar() já mexe no estado desse botão */
  rodape(`<button class="secundario" id="btInicio">← Início</button>
          <button class="secundario" id="btSalvar"
                  title="Salvar o rascunho e continuar nesta inspeção">Salvar</button>
          <button class="principal" id="btEnviar">Enviar</button>`);
  $("#btInicio").onclick = () => deixarComoRascunho();
  $("#btSalvar").onclick = () => gravar(false);
  $("#btEnviar").onclick = () => gravar(true);
  atualizar();

  function pintar(bloco, cod) {
    const v = R.respostas[cod];
    bloco.classList.toggle("pendente", !v);
    bloco.classList.toggle("nok", v === "nao_conforme");
    bloco.querySelectorAll(".opcoes button").forEach(b =>
      b.classList.toggle("on", b.dataset.v === v));
  }
  function atualizar() {
    const n = Object.keys(R.respostas).length, t = R.perguntas.length;
    const nok = Object.values(R.respostas).filter(v => v === "nao_conforme").length;
    $("#bi").style.width = (t ? n / t * 100 : 0).toFixed(1) + "%";
    $("#bt").textContent = n + " de " + t + " respondidas";
    $("#bn").textContent = nok ? nok + (nok === 1 ? " não conforme" : " não conformes") : "";
    $("#btEnviar").disabled = n < t;
    $("#btEnviar").textContent = n < t ? "Faltam " + (t - n) : "Enviar";
  }
}

/* ============================================================
   FOTOS DA INSPEÇÃO

   Vão para o Storage do Supabase, bucket privado "inspecoes", em
   <id-da-inspecao>/<arquivo>. A tabela sesmt_fotos guarda só o caminho —
   é o caminho que liga o arquivo à inspeção e decide quem pode ver.

   Três decisões que valem explicação:

   1. A foto é gravada NA HORA no depósito do aparelho e sobe assim que dá,
      uma por uma — não fica esperando o fim da inspeção. O depósito é o
      IndexedDB, não o localStorage: este só guarda texto e tem poucos
      megabytes, e uma foto sozinha já o comprometeria.

   2. É REDUZIDA antes de subir: 1280px no maior lado, JPEG 0.7. A câmera de
      celular entrega 4 MB por foto; assim fica entre 150 e 300 KB. O plano
      gratuito tem 1 GB, então o tamanho não é detalhe — é o que decide se
      cabem 300 ou 4 mil fotos.

   3. Sem sinal ela fica GUARDADA no aparelho, no IndexedDB, e sobe sozinha
      depois — igual às respostas. Até 08/09/2026 era o contrário: sem sinal o
      app recusava a foto, e o inspetor tinha de lembrar de tirá-la de novo com
      internet. O arquivo só sai do aparelho depois que o servidor confirma.
   ============================================================ */
const FOTO_LADO = 1280, FOTO_QUALIDADE = 0.7;

/* ============================================================
   FOTOS GUARDADAS NO APARELHO

   O localStorage não serve para foto: guarda só texto e tem poucos
   megabytes no total — três fotos estourariam o limite e derrubariam
   junto o rascunho das respostas. O IndexedDB guarda o arquivo binário
   como ele é, e com folga.

   A regra é uma só: a foto SÓ é apagada daqui depois que o servidor
   confirma. Fechar o app, reiniciar o celular ou passar o dia sem sinal
   não a perde; ela sobe sozinha junto com a fila das inspeções.

   O que ainda pode perdê-la é o inspetor desinstalar o app ou limpar os
   dados do navegador antes de subir — por isso o app pede armazenamento
   persistente na partida, o que impede o próprio sistema de descartar.
   ============================================================ */
const BD_NOME = "sesmt-inspecoes", BD_LOJA = "fotos";

const FotosLocais = {
  bd: null,
  enviando: false,
  aoSubir: null,        // a tela de perguntas liga aqui para se redesenhar

  abrir() {
    if (this.bd) return Promise.resolve(this.bd);
    return new Promise((ok, falha) => {
      if (!window.indexedDB) return falha(new Error("sem IndexedDB"));
      const p = indexedDB.open(BD_NOME, 1);
      p.onupgradeneeded = () => {
        const b = p.result;
        if (!b.objectStoreNames.contains(BD_LOJA)) {
          const loja = b.createObjectStore(BD_LOJA, { keyPath: "id" });
          loja.createIndex("inspecao", "inspecao", { unique: false });
        }
      };
      p.onsuccess = () => { this.bd = p.result; ok(this.bd); };
      p.onerror = () => falha(p.error || new Error("não deu para abrir o depósito"));
    });
  },

  async operar(modo, fn) {
    const bd = await this.abrir();
    return new Promise((ok, falha) => {
      const t = bd.transaction(BD_LOJA, modo);
      const pedido = fn(t.objectStore(BD_LOJA));
      t.oncomplete = () => ok(pedido && pedido.result);
      t.onerror = t.onabort = () => falha(t.error || new Error("falha ao gravar a foto"));
    });
  },

  /* Devolve false em vez de estourar: sem depósito o app tem um plano B. */
  async guardar(reg) {
    try {
      await this.operar("readwrite", loja => loja.put(reg));
      await this.contar();
      return true;
    } catch (e) { return false; }
  },
  async todas() {
    try { return (await this.operar("readonly", loja => loja.getAll())) || []; }
    catch (e) { return []; }
  },
  async daInspecao(id) {
    return (await this.todas()).filter(f => f.inspecao === id);
  },
  async apagar(id) {
    try { await this.operar("readwrite", loja => loja.delete(id)); } catch (e) {}
    App.fotosPendentes = Math.max(0, (App.fotosPendentes || 1) - 1);
  },
  /* Mantém à mão quantas estão esperando: a etiqueta do topo é desenhada
     em cima disso, e ler o IndexedDB a cada pintura seria exagero. */
  async contar() {
    App.fotosPendentes = (await this.todas()).length;
    pintarSinal();
    return App.fotosPendentes;
  },

  /* Manda o que dá, na ordem em que foi tirada. Cada foto só sai do
     aparelho depois que a linha dela existe no banco. */
  async enviarTudo() {
    if (this.enviando || !navigator.onLine) return 0;
    this.enviando = true;
    let mandou = 0;
    try {
      const lista = (await this.todas()).sort((a, b) => a.em - b.em);
      for (const f of lista) {
        try {
          /* A inspeção da foto pode ainda não existir no banco. Se é a que
             está aberta, cria agora; se está na fila, a fila cria — e aí
             esta foto fica para a próxima rodada, sem se perder. */
          if (App.rascunho && App.rascunho.id === f.inspecao) await garantirInspecao(App.rascunho);
          else if (Fila.achar(f.inspecao)) continue;
          await Fotos.subir(f.blob, f.tipo, f.inspecao, f.nome);
          await this.apagar(f.id);
          mandou++;
        } catch (e) {
          if (semRede(e)) break;      // sem sinal: as outras também não vão
          /* Recusa do servidor não apaga a foto: ela fica para a próxima
             tentativa. Pior do que insistir é jogar fora o que o inspetor
             não tem como tirar de novo. */
        }
      }
    } finally { this.enviando = false; }
    await this.contar();
    if (mandou && this.aoSubir) { try { await this.aoSubir(); } catch (e) {} }
    return mandou;
  }
};


const Fotos = {
  /* Reduz no próprio aparelho. Sem isso o inspetor gasta o pacote de dados
     dele mandando 4 MB de uma foto que será vista num quadrado de 3 cm. */
  async reduzir(arquivo) {
    const bmp = await createImageBitmap(arquivo);
    const escala = Math.min(1, FOTO_LADO / Math.max(bmp.width, bmp.height));
    const l = Math.round(bmp.width * escala), a = Math.round(bmp.height * escala);
    const cv = document.createElement("canvas");
    cv.width = l; cv.height = a;
    cv.getContext("2d").drawImage(bmp, 0, 0, l, a);
    bmp.close && bmp.close();
    return new Promise(ok => cv.toBlob(ok, "image/jpeg", FOTO_QUALIDADE));
  },

  /* Sobe um arquivo já reduzido. Separado de enviar() porque a fila também
     usa isto, muito depois, para as fotos que ficaram no aparelho. */
  async subir(blob, tipo, inspecao, nome) {
    const caminho = `${inspecao}/${nome}`;
    let r;
    try {
      r = await fetch(`${SERVIDOR.url}/storage/v1/object/inspecoes/${caminho}`, {
        method: "POST",
        headers: {
          apikey: SERVIDOR.chave,
          Authorization: "Bearer " + Sessao.access,
          "Content-Type": "image/jpeg"
        },
        body: blob
      });
    } catch (e) { throw erroDeRede(); }
    /* 409 é "esse arquivo já existe": acontece quando a subida anterior
       chegou ao Storage e caiu antes de gravar a linha. Não é erro — segue
       para a linha, que é o que liga a foto à inspeção. */
    if (!r.ok && r.status !== 409) {
      let d = ""; try { d = (await r.json()).message || ""; } catch (e) {}
      throw new Error(d || `o servidor recusou o arquivo (${r.status})`);
    }

    /* A linha na tabela vem DEPOIS do arquivo: linha sem arquivo apontaria
       para o vazio, e é pior do que arquivo sem linha, que só ocupa espaço. */
    const [linha] = await api("sesmt_fotos", {
      method: "POST",
      headers: { Prefer: "return=representation" },
      body: { inspecao, tipo, caminho }
    });
    return linha;
  },

  /* Guarda no aparelho e sobe. Nunca o contrário: enquanto o servidor não
     confirmar, a foto continua gravada aqui — é isso que impede a foto de
     se perder no caminho. */
  async enviar(arquivo, tipo) {
    const R = App.rascunho;
    if (!R) throw new Error("nenhuma inspeção aberta");

    const menor = await this.reduzir(arquivo);
    /* Nome com hora e sorteio: duas fotos tiradas no mesmo segundo, de dois
       aparelhos, não podem se sobrescrever. E o nome é decidido AGORA, não
       na hora de subir: assim uma tentativa que falhou no meio não deixa
       duas cópias do mesmo arquivo no Storage. */
    const nome = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}.jpg`;
    const guardada = await FotosLocais.guardar({
      id: novoId(), inspecao: R.id, tipo, nome, blob: menor, em: Date.now()
    });
    if (!guardada) {
      /* Sem IndexedDB (aba privada de alguns navegadores) volta ao jeito
         antigo: ou sobe agora, ou avisa que não deu. */
      if (!navigator.onLine) throw new Error("sem sinal, e este navegador não deixa guardar a foto");
      await garantirInspecao(R);
      return this.subir(menor, tipo, R.id, nome);
    }
    pintarSinal();
    if (navigator.onLine) await FotosLocais.enviarTudo();
    return null;
  },

  /* O bucket é privado: para mostrar a miniatura é preciso pedir uma URL
     assinada, que expira. Uma hora basta para o tempo de uma inspeção. */
  async ver(caminho) {
    const r = await fetch(`${SERVIDOR.url}/storage/v1/object/sign/inspecoes/${caminho}`, {
      method: "POST",
      headers: {
        apikey: SERVIDOR.chave,
        Authorization: "Bearer " + Sessao.access,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({ expiresIn: 3600 })
    });
    if (!r.ok) throw new Error("não deu para abrir a foto");
    const j = await r.json();
    /* O campo já se chamou signedURL e signedUrl conforme a versão do
       Storage; aceitar os dois evita quebrar numa atualização do Supabase. */
    const url = j.signedURL || j.signedUrl || "";
    return url.startsWith("http") ? url : SERVIDOR.url + "/storage/v1" + url;
  },

  async listar() {
    const R = App.rascunho;
    if (!R) return [];
    return api("sesmt_fotos?select=id,tipo,caminho&inspecao=eq."
               + encodeURIComponent(R.id) + "&order=enviada_em");
  },

  async apagar(foto) {
    /* Foto que ainda está no aparelho não tem arquivo no servidor para
       apagar: sai só do depósito local. */
    if (!foto.caminho) return FotosLocais.apagar(foto.id);
    await fetch(`${SERVIDOR.url}/storage/v1/object/inspecoes/${foto.caminho}`, {
      method: "DELETE",
      headers: { apikey: SERVIDOR.chave, Authorization: "Bearer " + Sessao.access }
    });
    /* Some da lista mesmo que o arquivo resista: linha órfã confunde o
       inspetor, arquivo órfão só ocupa espaço. */
    await api("sesmt_fotos?id=eq." + encodeURIComponent(foto.id), { method: "DELETE" });
  }
};

/* Sair da inspeção deixando-a como rascunho, para começar outra.

   É o que permite ter VÁRIAS inspeções em rascunho ao mesmo tempo: o campo
   pede isso — o inspetor começa numa equipe, a turma se desloca, e ele abre
   outra sem perder a primeira. Os rascunhos vivem no banco, um por inspeção.

   Sobe antes de sair, e NÃO sai se não conseguir. O aparelho guarda um
   rascunho só (é uma chave só no localStorage): começar outra inspeção
   sobrescreve a cópia local. Enquanto o servidor não tiver as respostas,
   sair seria perdê-las — então o botão insiste em vez de enganar. */
async function deixarComoRascunho() {
  const b = $("#btInicio");
  const antes = b.textContent;
  b.disabled = true; b.textContent = "Guardando…";
  try {
    Rascunho.guardar();
    const subiu = await Rascunho.sincronizar(true);
    if (!subiu) {
      /* Sem sinal, a inspeção vai para a FILA do aparelho e o inspetor sai
         livre para começar outra. Antes o botão recusava sair, porque a
         cópia local é uma só — a fila é o que resolve isso. */
      const R = App.rascunho;
      if (!Fila.por(R, false)) throw new Error("o aparelho está sem memória");
      Rascunho.limpar();
      App.rascunho = null;
      await telaInicio();
      recado(tela(), "aviso", `Sem sinal: a inspeção de ${esc(R.equipe)} ficou `
        + "guardada no aparelho e sobe sozinha quando a conexão voltar. "
        + "Dá para começar outra agora.");
      return;
    }
    Rascunho.limpar();        // o banco já tem: o aparelho pode largar
    App.rascunho = null;
    await telaInicio();
    recado(tela(), "ok", "Guardado como rascunho. Ele está na lista abaixo, "
      + "e dá para começar outra inspeção agora.");
  } catch (e) {
    b.disabled = false; b.textContent = antes;
    recado(tela(), "erro", "Não deu para guardar no servidor: " + e.message
      + ". Você continua nesta inspeção — nada se perdeu. Tente de novo quando "
      + "a conexão voltar, ou termine e envie por aqui mesmo.");
  }
}

/* Liga os dois grupos de foto da tela de perguntas.

   Redesenha a lista a partir do BANCO, não de uma cópia na memória: se a
   inspeção foi retomada em outro aparelho, as fotos já enviadas aparecem
   aqui também. */
function ligarFotos() {
  const grupos = [...document.querySelectorAll(".fotos-grupo")];
  if (!grupos.length) return;

  /* Duas origens na mesma lista: as que já estão no servidor e as que ainda
     esperam no aparelho. Para o inspetor é uma lista só — a diferença é a
     etiqueta "a enviar", que some quando a foto chega ao sistema. */
  const desenhar = async () => {
    let fotos = [];
    try { fotos = await Fotos.listar(); }
    catch (e) { /* lista é conforto; sem ela ainda dá para adicionar */ }
    const locais = App.rascunho ? await FotosLocais.daInspecao(App.rascunho.id) : [];
    grupos.forEach(g => {
      const lista = g.querySelector(".fotos-lista");
      const minhas = fotos.filter(f => f.tipo === g.dataset.tipo);
      const daqui = locais.filter(f => f.tipo === g.dataset.tipo);
      lista.innerHTML = (minhas.length + daqui.length) ? ""
        : `<span class="fotos-vazio">nenhuma foto</span>`;

      daqui.forEach(f => {
        const d = document.createElement("div");
        d.className = "foto esperando";
        d.innerHTML = `<img alt="foto da inspeção guardada no aparelho">
          <span class="foto-espera">a enviar</span>
          <button type="button" class="foto-x" aria-label="Remover foto">✕</button>`;
        lista.appendChild(d);
        /* A prévia sai do próprio arquivo guardado: não custa rede nenhuma.
           O endereço temporário é liberado quando a imagem carrega. */
        const url = URL.createObjectURL(f.blob);
        const img = d.querySelector("img");
        img.onload = () => URL.revokeObjectURL(url);
        img.src = url;
        d.querySelector(".foto-x").onclick = async () => {
          if (!confirm("Remover esta foto? Ela ainda não foi enviada, e não dá para desfazer."))
            return;
          d.classList.add("indo");
          await FotosLocais.apagar(f.id);
          await desenhar();
        };
      });

      minhas.forEach(f => {
        const d = document.createElement("div");
        d.className = "foto";
        d.innerHTML = `<img alt="foto da inspeção">
          <button type="button" class="foto-x" aria-label="Remover foto">✕</button>`;
        lista.appendChild(d);
        Fotos.ver(f.caminho).then(u => { d.querySelector("img").src = u; })
          .catch(() => d.classList.add("sem-previa"));
        d.querySelector(".foto-x").onclick = async () => {
          if (!confirm("Remover esta foto? Não dá para desfazer.")) return;
          d.classList.add("indo");
          try { await Fotos.apagar(f); await desenhar(); }
          catch (e) { d.classList.remove("indo");
            recado(tela(), "erro", "Não deu para remover: " + e.message); }
        };
      });
    });
  };
  /* A tela se redesenha quando uma foto guardada consegue subir. */
  FotosLocais.aoSubir = desenhar;

  /* DOIS campos por grupo, e não um só com capture="environment".

     Com capture, o Android e o iOS abrem a câmera DIRETO e não oferecem a
     galeria — foto já tirada antes, ou vinda do WhatsApp, ficava inacessível.
     Sem capture, alguns aparelhos abrem só o seletor de arquivos e escondem a
     câmera. Nenhum dos dois sozinho atende, então cada um vira um botão:
     "Tirar foto" com capture, "Da galeria" sem. */
  grupos.forEach(g => g.querySelectorAll("input[type=file]").forEach(input => {
    const bt = input.parentElement.querySelector("span");
    const rotulo = bt.textContent;
    input.onchange = async () => {
      const arquivos = [...input.files];
      input.value = "";                 // permite reescolher a mesma foto
      if (!arquivos.length) return;
      for (let i = 0; i < arquivos.length; i++) {
        bt.textContent = arquivos.length > 1
          ? `Guardando ${i + 1} de ${arquivos.length}…` : "Guardando…";
        try {
          await Fotos.enviar(arquivos[i], g.dataset.tipo);
        } catch (e) {
          recado(tela(), "erro", "Não deu para guardar a foto: " + e.message
            + ". As respostas continuam guardadas.");
          break;
        }
      }
      bt.textContent = rotulo;
      await desenhar();
    };
  }));

  desenhar();
}

/* ---------- 7. Gravar ---------- */
async function gravar(enviar) {
  const R = App.rascunho;
  const bs = $("#btSalvar"), be = $("#btEnviar");
  bs.disabled = be.disabled = true;
  const antes = enviar ? be.textContent : bs.textContent;
  (enviar ? be : bs).textContent = "Gravando…";
  try {
    Rascunho.guardar();
    /* Sobe tudo primeiro. Marcar como enviada sem as respostas terem
       chegado deixaria no banco uma inspeção enviada e vazia. */
    const subiu = await Rascunho.sincronizar(true);
    if (!subiu && enviar && !navigator.onLine) {
      /* Sem sinal, ENVIAR não pode falhar: a inspeção está completa e o
         inspetor não vai ficar no mato esperando. Ela entra na fila já
         marcada como enviada e chega ao banco assim que houver conexão —
         a data de envio é a de agora, não a da subida. */
      if (!Fila.por(R, true)) throw new Error("o aparelho está sem memória");
      Rascunho.limpar();
      App.rascunho = null;
      telaFim(R, true);
      return;
    }
    if (!subiu) throw new Error(navigator.onLine
      ? "o servidor não respondeu"
      : "sem sinal — o que você respondeu está guardado no aparelho");

    if (enviar) {
      await api("sesmt_inspecoes?id=eq." + encodeURIComponent(R.id), {
        method: "PATCH", body: { enviada_em: new Date().toISOString() }
      });
      Rascunho.limpar();
      App.rascunho = null;
      telaFim(R);
    }
    else {
      bs.disabled = be.disabled = false;
      bs.textContent = antes;
      recado(tela(), "ok", "Rascunho salvo no servidor. Dá para fechar o app "
        + "e voltar depois, de qualquer aparelho.");
      setTimeout(() => { const r = tela().querySelector(".recado.ok"); if (r) r.remove(); }, 3500);
    }
  } catch (e) {
    bs.disabled = be.disabled = false;
    (enviar ? be : bs).textContent = antes;
    recado(tela(), "erro", "Não deu para enviar: " + e.message
      + ". Nada se perdeu: as respostas estão guardadas no aparelho e sobem "
      + "sozinhas quando a conexão voltar.");
  }
}

function telaFim(R, naFila) {
  const nok = Object.values(R.respostas).filter(v => v === "nao_conforme").length;
  topo(naFila ? "Guardada" : "Enviada", true);
  rodape(`<button class="principal" id="btNova">Nova inspeção</button>`);
  tela().innerHTML = `
    <h2>${naFila ? "Inspeção concluída" : "Inspeção enviada"}</h2>
    <p class="sub">${esc(R.equipe)} · ${esc(R.dep.nome)} · ${dataBR(R.data)}</p>
    <div class="recado ${naFila ? "aviso" : "ok"}">${naFila
      ? `Você está sem sinal, então ela ficou guardada no aparelho com
         ${R.perguntas.length} respostas${nok ? " e " + nok
           + (nok === 1 ? " não conformidade" : " não conformidades") : ""}.
         Vai sozinha para o sistema assim que a conexão voltar — pode fechar o app,
         mas mantenha-o instalado até a etiqueta "a enviar" sumir da lista.`
      : `Registrada com ${R.perguntas.length} respostas${nok ? " e " + nok
           + (nok === 1 ? " não conformidade" : " não conformidades") : ""}.
         A partir de agora ela não muda mais — correção é com o administrador.`}</div>`;
  $("#btNova").onclick = telaInicio;

  /* Fotos desta inspeção que ainda não subiram: o inspetor precisa saber
     que elas estão guardadas, e que o app tem de continuar instalado. */
  FotosLocais.daInspecao(R.id).then(fs => {
    if (!fs.length || !$("#btNova")) return;
    recado(tela(), "aviso", `${fs.length} ${fs.length === 1 ? "foto guardada" : "fotos guardadas"} `
      + "no aparelho, esperando sinal. Elas sobem sozinhas quando a conexão voltar — "
      + "mantenha o app instalado até lá.");
  });
}

/* ============================================================
   PARTIDA
   ============================================================ */

/* O service worker é o que deixa o app instalável — instalado, ele abre
   sem a barra de endereço — e o que faz abrir sem sinal. Falhar aqui não
   pode derrubar o app: sem ele o app funciona, só não instala. */
if ("serviceWorker" in navigator) {
  /* Registrar não basta: o app instalado quase nunca faz uma navegação nova,
     então o navegador pode passar horas sem sequer PERGUNTAR se há versão
     nova. Foi o que aconteceu em 28/08/2026 — o servidor já tinha a v7 e o
     celular continuava na v6.

     Aqui o app pergunta a cada abertura, e recarrega sozinho quando um
     service worker novo assume. O recarregamento acontece UMA vez: sem a
     trava, cada troca de controlador dispararia outra, em laço. */
  let jaRecarregou = false;
  navigator.serviceWorker.addEventListener("controllerchange", () => {
    if (jaRecarregou) return;
    jaRecarregou = true;
    location.reload();
  });
  window.addEventListener("load", () =>
    navigator.serviceWorker.register("./sw.js")
      .then(reg => reg.update())
      .catch(() => {}));
}
/* Armazenamento persistente: sem isto o navegador pode descartar o depósito
   sozinho quando o celular ficar sem espaço — justamente com a foto dentro.
   Concedido ou não, o app funciona; com ele, funciona mais seguro. */
if (navigator.storage && navigator.storage.persist) {
  navigator.storage.persisted().then(ja => { if (!ja) navigator.storage.persist(); })
    .catch(() => {});
}
FotosLocais.contar();

$("#logo").src = LOGO;
$("#btSair").onclick = () => { Sessao.esquecer(); telaLogin(); };

(async function () {
  if (!Sessao.restaurar()) return telaLogin();
  /* Token guardado pode ter vencido enquanto o app estava fechado.

     Falha de REDE aqui não é sessão vencida. Antes, qualquer erro caía em
     esquecer() e o inspetor era jogado na tela de login — justo no lugar
     onde não há sinal para entrar de novo. Agora só o servidor recusando
     desloga; sem sinal, o app segue com o cadastro guardado. */
  if (!navigator.onLine) { App.semSinal = true; return iniciar(); }
  try {
    await api("sesmt_departamentos?select=codigo&limit=1");
    iniciar();
  } catch (e) {
    if (semRede(e)) { App.semSinal = true; return iniciar(); }
    Sessao.esquecer();
    telaLogin();
  }
})();
