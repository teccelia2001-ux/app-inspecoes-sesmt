/* Service worker do app de inspeções.

   Serve para duas coisas: deixar o app instalável no celular — instalado, ele
   abre sem a barra de endereço — e fazer abrir sem sinal, com a última versão
   que o aparelho baixou. Inspeção acontece em campo, e campo tem buraco de
   sinal.

   Estratégia, de propósito diferente por tipo de arquivo:
   - a página e o código: REDE PRIMEIRO. Assim uma correção publicada chega no
     próximo acesso com internet. Sem sinal, cai para a cópia guardada.
   - ícones e manifest: CACHE PRIMEIRO. Não mudam quase nunca.

   O que o inspetor responde NÃO passa por aqui. Fica no armazenamento do
   aparelho e vai para o Supabase pela própria página — ver Rascunho, em app.js.
   Chamada ao Supabase nunca é guardada em cache: resposta velha de banco seria
   pior do que erro de rede. */

var VERSAO = "inspecoes-v1";
var ESSENCIAIS = [
  "./",
  "./index.html",
  "./app.js",
  "./manifest.webmanifest",
  "./icones/icone-192.png",
  "./icones/icone-512.png",
  "./icones/icone-512-mascara.png"
];

self.addEventListener("install", function (e) {
  e.waitUntil(
    caches.open(VERSAO)
      .then(function (c) { return c.addAll(ESSENCIAIS); })
      /* Um essencial que falhe não pode impedir a instalação: melhor o app
         instalado com cache parcial do que não instalado. */
      .catch(function () {})
      .then(function () { return self.skipWaiting(); })
  );
});

self.addEventListener("activate", function (e) {
  e.waitUntil(
    caches.keys().then(function (nomes) {
      return Promise.all(nomes.map(function (n) {
        if (n !== VERSAO) return caches.delete(n);
      }));
    }).then(function () { return self.clients.claim(); })
  );
});

self.addEventListener("fetch", function (e) {
  var req = e.request;
  if (req.method !== "GET") return;

  var url = new URL(req.url);

  /* Supabase passa direto, sempre. Guardar resposta de banco em cache faria o
     inspetor ver cadastro velho sem perceber. */
  if (url.origin !== self.location.origin) return;

  var ehEstatico = /\/icones\/|\.webmanifest$/.test(url.pathname);

  if (ehEstatico) {
    e.respondWith(
      caches.match(req).then(function (guardado) {
        return guardado || fetch(req).then(function (r) {
          var copia = r.clone();
          caches.open(VERSAO).then(function (c) { c.put(req, copia); });
          return r;
        });
      })
    );
    return;
  }

  /* Página e código: rede primeiro, cache como rede de segurança. */
  e.respondWith(
    fetch(req).then(function (r) {
      var copia = r.clone();
      caches.open(VERSAO).then(function (c) { c.put(req, copia); });
      return r;
    }).catch(function () {
      return caches.match(req).then(function (guardado) {
        return guardado || caches.match("./index.html");
      });
    })
  );
});
