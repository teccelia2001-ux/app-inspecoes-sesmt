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

async function auth(caminho, corpo) {
  const r = await fetch(SERVIDOR.url + "/auth/v1/" + caminho, {
    method: "POST",
    headers: { apikey: SERVIDOR.chave, "Content-Type": "application/json" },
    body: JSON.stringify(corpo)
  });
  let j = null;
  try { j = await r.json(); } catch (e) {}
  return { ok: r.ok, corpo: j || {} };
}

async function entrar(email, senha) {
  const r = await auth("token?grant_type=password", { email, password: senha });
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
  const r = await fetch(SERVIDOR.url + "/rest/v1/" + caminho, {
    method: o.method || "GET",
    headers: Object.assign({
      apikey: SERVIDOR.chave,
      Authorization: "Bearer " + Sessao.access,
      "Content-Type": "application/json"
    }, o.headers || {}),
    body: o.body ? JSON.stringify(o.body) : undefined
  });
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
  rascunho: null,                                  // inspeção em preenchimento
  buscaEquipe: ""
};

/* ============================================================
   TELAS
   ============================================================ */
function topo(titulo, mostrarSair) {
  $("#tituloTopo").textContent = titulo;
  $("#btSair").classList.toggle("oculto", !mostrarSair);
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

    const [deps, eqs] = await Promise.all([
      api("sesmt_departamentos?select=codigo,nome&ativo=is.true&order=ordem"),
      api("sesmt_equipes?select=equipe,tipo,supervisor&order=equipe")
    ]);
    App.departamentos = deps;
    App.equipes = eqs;
    telaInicio();
  } catch (e) {
    topo("Inspeções SESMT", true);
    tela().innerHTML = "";
    recado(tela(), "erro", "Não deu para carregar os cadastros: " + e.message);
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

  /* As últimas inspeções deste inspetor, para retomar rascunho */
  try {
    const lista = await api("sesmt_inspecoes?select=id,departamento,equipe,data,enviada_em"
                            + "&order=criada_em.desc&limit=10");
    if (!lista.length) return;
    const nomeDep = c => (App.departamentos.find(d => d.codigo === c) || {}).nome || c;
    $("#minhas").innerHTML = `<h2 style="margin-top:26px">Suas últimas</h2>
      <p class="sub">Rascunho pode ser retomado. Enviada não muda mais.</p>` +
      lista.map(i => `<button class="insp" data-id="${esc(i.id)}" ${i.enviada_em ? "disabled" : ""}>
        <span style="flex:1 1 auto">
          <b>${esc(i.equipe)}</b>
          <small>${esc(nomeDep(i.departamento))} · ${dataBR(i.data)}</small>
        </span>
        <span class="etiq ${i.enviada_em ? "enviada" : "rascunho"}">${
          i.enviada_em ? "enviada" : "rascunho"}</span>
      </button>`).join("");
    $("#minhas").querySelectorAll(".insp:not([disabled])").forEach(b =>
      b.onclick = () => retomar(b.dataset.id));
  } catch (e) { /* lista é conforto, não trava o app */ }
}

/* ---------- 4. Escolher a equipe ---------- */
function telaEquipe(dep) {
  topo(dep.nome, true);
  rodape(`<button class="secundario" id="btVoltar">← Departamento</button>`);
  App.buscaEquipe = "";
  tela().innerHTML = `
    <h2>Qual equipe?</h2>
    <p class="sub">São ${App.equipes.length} equipes cadastradas. Busque pelo nome ou pelo supervisor.</p>
    <div class="busca">
      <input type="search" id="bq" placeholder="Buscar equipe ou supervisor…" aria-label="Buscar equipe">
      <span class="conta" id="cq"></span>
    </div>
    <div class="equipes" id="lq"></div>
    <div class="vazio oculto" id="vq">Nenhuma equipe bate com a busca.</div>`;

  $("#lq").innerHTML = App.equipes.map(e =>
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
    $("#cq").textContent = q ? (n ? n + " de " + App.equipes.length : "") : "";
    $("#vq").classList.toggle("oculto", !(q && !n));
  };
  cx.oninput = () => { App.buscaEquipe = cx.value; filtrar(); };
  $("#lq").querySelectorAll(".equipe").forEach(b =>
    b.onclick = () => telaDados(dep, b.dataset.eq));
  $("#btVoltar").onclick = telaInicio;
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
             autocapitalize="characters" spellcheck="false"></label>`;

  /* A placa vinha suja do Google Forms: "QFD8E92", "QFD8E92 " e
     "Qfd5j42" contavam como três. Aqui normaliza na digitação. */
  $("#pl").oninput = ev => {
    ev.target.value = ev.target.value.toUpperCase().replace(/[^A-Z0-9]/g, "").slice(0, 7);
  };
  $("#btVoltar").onclick = () => telaEquipe(dep);
  $("#btIr").onclick = async () => {
    const dt = $("#dt").value;
    if (!dt) return recado(tela(), "erro", "Escolha a data da inspeção.");
    await abrirPerguntas(dep, equipe, dt, $("#pl").value.trim());
  };
}

/* ---------- 6. Perguntas ---------- */
async function perguntasDe(codigo) {
  if (App.perguntas[codigo]) return App.perguntas[codigo];
  const r = await api("sesmt_pergunta_departamento?select=ordem,sesmt_perguntas(codigo,texto)"
                      + "&departamento=eq." + encodeURIComponent(codigo) + "&order=ordem");
  App.perguntas[codigo] = r
    .filter(x => x.sesmt_perguntas)
    .map(x => ({ codigo: x.sesmt_perguntas.codigo, texto: x.sesmt_perguntas.texto }));
  return App.perguntas[codigo];
}

async function abrirPerguntas(dep, equipe, data, placa) {
  topo("Carregando…", true);
  tela().innerHTML = `<p class="sub">Buscando as perguntas de ${esc(dep.nome)}…</p>`;
  rodape("");
  try {
    const perg = await perguntasDe(dep.codigo);
    /* Cria o rascunho já no banco: se o celular morrer no meio do
       mato, o que foi respondido até ali não se perde. */
    const criada = await api("sesmt_inspecoes", {
      method: "POST",
      headers: { Prefer: "return=representation" },
      body: {
        departamento: dep.codigo, inspetor: Sessao.inspetor, equipe: equipe,
        data: data, placa: placa || null, criada_por: Sessao.uid
      }
    });
    App.rascunho = {
      id: criada[0].id, dep: dep, equipe: equipe, data: data, placa: placa,
      perguntas: perg, respostas: {}, desvios: ""
    };
    telaPerguntas();
  } catch (e) {
    topo(equipe, true);
    tela().innerHTML = "";
    recado(tela(), "erro", "Não deu para começar a inspeção: " + e.message);
    rodape(`<button class="secundario" id="btVoltar">← Voltar</button>`);
    $("#btVoltar").onclick = () => telaDados(dep, equipe);
  }
}

async function retomar(id) {
  topo("Carregando…", true);
  tela().innerHTML = `<p class="sub">Abrindo o rascunho…</p>`;
  try {
    const i = (await api("sesmt_inspecoes?select=*&id=eq." + encodeURIComponent(id)))[0];
    const dep = App.departamentos.find(d => d.codigo === i.departamento);
    const perg = await perguntasDe(i.departamento);
    const resp = await api("sesmt_respostas?select=pergunta,resposta&inspecao=eq."
                           + encodeURIComponent(id));
    App.rascunho = {
      id: i.id, dep: dep, equipe: i.equipe, data: i.data, placa: i.placa || "",
      perguntas: perg, desvios: i.desvios || "",
      respostas: Object.fromEntries(resp.map(r => [r.pergunta, r.resposta]))
    };
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
    </div>
    <div id="lp"></div>
    <label class="campo" style="margin-top:16px"><span>Desvios encontrados</span>
      <textarea id="dv" placeholder="Descreva o que foi encontrado. Se não houve, escreva &quot;Não houve desvios&quot;."></textarea></label>`;

  $("#lp").innerHTML = R.perguntas.map((p, i) => `
    <div class="pergunta pendente" data-cod="${esc(p.codigo)}">
      <div class="texto"><span class="num">${i + 1}</span>${esc(p.texto)}</div>
      <div class="opcoes">
        <button type="button" data-v="conforme">Conforme</button>
        <button type="button" data-v="nao_conforme">Não conforme</button>
        <button type="button" data-v="na">N/A</button>
      </div>
    </div>`).join("");

  $("#dv").value = R.desvios || "";
  $("#dv").oninput = ev => { R.desvios = ev.target.value; };

  $("#lp").querySelectorAll(".pergunta").forEach(bloco => {
    const cod = bloco.dataset.cod;
    bloco.querySelectorAll(".opcoes button").forEach(b => {
      b.onclick = () => { R.respostas[cod] = b.dataset.v; pintar(bloco, cod); atualizar(); };
    });
    pintar(bloco, cod);
  });
  /* o rodapé vem antes de atualizar(): é ele que cria o botão Enviar,
     e atualizar() já mexe no estado desse botão */
  rodape(`<button class="secundario" id="btSalvar">Salvar rascunho</button>
          <button class="principal" id="btEnviar">Enviar</button>`);
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

/* ---------- 7. Gravar ---------- */
async function gravar(enviar) {
  const R = App.rascunho;
  const bs = $("#btSalvar"), be = $("#btEnviar");
  bs.disabled = be.disabled = true;
  const antes = enviar ? be.textContent : bs.textContent;
  (enviar ? be : bs).textContent = "Gravando…";
  try {
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
      method: "PATCH",
      body: Object.assign({ desvios: R.desvios || null },
                          enviar ? { enviada_em: new Date().toISOString() } : {})
    });
    if (enviar) { App.rascunho = null; telaFim(R); }
    else {
      bs.disabled = be.disabled = false;
      bs.textContent = antes;
      recado(tela(), "ok", "Rascunho salvo. Dá para fechar o app e voltar depois.");
      setTimeout(() => { const r = tela().querySelector(".recado.ok"); if (r) r.remove(); }, 3500);
    }
  } catch (e) {
    bs.disabled = be.disabled = false;
    (enviar ? be : bs).textContent = antes;
    recado(tela(), "erro", "Não deu para gravar: " + e.message
      + " — o que você respondeu continua na tela, tente de novo.");
  }
}

function telaFim(R) {
  const nok = Object.values(R.respostas).filter(v => v === "nao_conforme").length;
  topo("Enviada", true);
  rodape(`<button class="principal" id="btNova">Nova inspeção</button>`);
  tela().innerHTML = `
    <h2>Inspeção enviada</h2>
    <p class="sub">${esc(R.equipe)} · ${esc(R.dep.nome)} · ${dataBR(R.data)}</p>
    <div class="recado ok">Registrada com ${R.perguntas.length} respostas${
      nok ? " e " + nok + (nok === 1 ? " não conformidade" : " não conformidades") : ""}.
      A partir de agora ela não muda mais — correção é com o administrador.</div>`;
  $("#btNova").onclick = telaInicio;
}

/* ============================================================
   PARTIDA
   ============================================================ */
$("#logo").src = LOGO;
$("#btSair").onclick = () => { Sessao.esquecer(); telaLogin(); };

(async function () {
  if (!Sessao.restaurar()) return telaLogin();
  /* Token guardado pode ter vencido enquanto o app estava fechado */
  try {
    await api("sesmt_departamentos?select=codigo&limit=1");
    iniciar();
  } catch (e) {
    Sessao.esquecer();
    telaLogin();
  }
})();
