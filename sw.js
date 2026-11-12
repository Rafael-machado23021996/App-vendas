/**
 * sw.js — Service worker: guarda os arquivos do app no aparelho para que ele
 * abra mesmo sem internet. Os DADOS (vendas) não passam por aqui: ficam no
 * localStorage.
 *
 * Estratégia: "cache primeiro, atualiza em segundo plano" (stale-while-revalidate)
 * para os arquivos do app. Abre na hora, mesmo com internet ruim; a versão
 * nova baixada em segundo plano aparece na PRÓXIMA abertura.
 *
 * Ao publicar uma nova versão, AUMENTE o número em VERSAO para que os
 * aparelhos baixem todos os arquivos novos de uma vez.
 */
const VERSAO = 'minhas-vendas-v8';
const ARQUIVOS = [
  './',
  './index.html',
  './manifest.json',
  './css/style.css',
  './js/app.js',
  './js/storage.js',
  './js/ui.js',
  './js/dashboard.js',
  './js/utils.js',
  './js/producao.js',
  './js/insumos.js',
  './icons/icon.svg',
  './icons/icon-192.png',
  './icons/icon-512.png',
  './icons/icon-maskable-512.png',
];

// Instalação: baixa e guarda todos os arquivos (ignorando o cache HTTP do navegador).
self.addEventListener('install', (evento) => {
  evento.waitUntil(
    caches.open(VERSAO)
      .then((cache) => cache.addAll(ARQUIVOS.map((url) => new Request(url, { cache: 'reload' }))))
      .then(() => self.skipWaiting()),
  );
});

// Ativação: apaga caches de versões antigas.
self.addEventListener('activate', (evento) => {
  evento.waitUntil(
    caches.keys()
      .then((chaves) => Promise.all(chaves.filter((c) => c !== VERSAO).map((c) => caches.delete(c))))
      .then(() => self.clients.claim()),
  );
});

/** Busca na rede e, se der certo, atualiza o cache. Nunca rejeita (offline => null). */
function buscarEAtualizar(req, chaveCache) {
  return fetch(req)
    .then((resposta) => {
      if (resposta.ok && resposta.type === 'basic') {
        const copia = resposta.clone();
        caches.open(VERSAO).then((cache) => cache.put(chaveCache, copia));
      }
      return resposta;
    })
    .catch(() => null);
}

// Requisições do próprio site: responde do cache na hora e atualiza em segundo plano.
self.addEventListener('fetch', (evento) => {
  const req = evento.request;
  if (req.method !== 'GET' || new URL(req.url).origin !== self.location.origin) return;
  // Navegação (abrir o app, index.html?utm=..., #rotas): sempre o index.html do cache.
  const navegacao = req.mode === 'navigate';
  const chave = navegacao ? './index.html' : req;
  evento.respondWith((async () => {
    const emCache = await caches.match(chave, { ignoreSearch: true });
    const rede = buscarEAtualizar(navegacao ? new Request('./index.html', { cache: 'no-cache' }) : req, chave);
    if (emCache) {
      evento.waitUntil(rede); // atualiza sem fazer o usuário esperar
      return emCache;
    }
    const resposta = await rede;
    if (resposta) return resposta;
    return (await caches.match('./index.html')) || new Response('Sem conexão.', { status: 503, headers: { 'Content-Type': 'text/plain; charset=utf-8' } });
  })());
});
