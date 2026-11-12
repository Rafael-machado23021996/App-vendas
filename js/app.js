/**
 * app.js — Ponto de entrada. Liga as telas, a navegação e os botões
 * às funções de dados (storage.js) e de tela (ui.js, dashboard.js).
 *
 * Navegação por "hash" na URL (funciona offline e sem servidor especial):
 *   #painel  #nova  #editar=<id>  #historico  #insumos  #dados
 */
import * as db from './storage.js';
import * as ui from './ui.js';
import * as producao from './producao.js';
import * as insumosUI from './insumos.js';
import { calcularResumo, totaisPorDia, renderizarCards, renderizarGrafico } from './dashboard.js';
import {
  baixarArquivo, hojeISO, TIPOS, STATUS, qtdComUnidade, formatarNumeroBR, textoParaCentavos, textoParaNumero, numeroParaCampo,
} from './utils.js';

/** Estado simples da interface. */
const estado = {
  diasGrafico: 7,
  filtros: { busca: '', periodo: 'todos', status: 'todos', tipo: 'todos' },
};

/* ------------------------------------------------------------------ */
/* Renderização geral                                                  */
/* ------------------------------------------------------------------ */

/** Redesenha tudo que depende dos dados (é rápido: são poucas centenas de vendas). */
function atualizarTudo() {
  const vendas = ui.ordenarRecentes(db.listarVendas());
  renderizarCards(calcularResumo(vendas));
  renderizarGrafico(document.getElementById('grafico'), totaisPorDia(vendas, estado.diasGrafico));
  ui.renderizarUltimas(vendas);
  ui.renderizarHistorico(vendas, ui.filtrarVendas(vendas, estado.filtros));
  ui.atualizarSugestoes(db.itensConhecidos(), db.listarClientes());
  producao.definirContexto(db.listarInsumos({ incluirInativos: true }), db.obterConfig());
  insumosUI.renderizarInsumos();
  const cfg = db.obterConfig();
  const campoHora = document.getElementById('c-hora');
  if (document.activeElement !== campoHora) campoHora.value = cfg.custo_hora_maquina ? formatarNumeroBR(cfg.custo_hora_maquina) : '';
  const campoMarkup = document.getElementById('c-markup');
  if (document.activeElement !== campoMarkup) campoMarkup.value = cfg.markup_pct ? numeroParaCampo(cfg.markup_pct) : '';
  atualizarAvisos();
  const ativas = vendas.length;
  document.getElementById('info-armazenamento').textContent =
    `${ativas} ${ativas === 1 ? 'venda salva' : 'vendas salvas'} · ${db.listarClientes().length} clientes · cerca de ${db.tamanhoKB()} KB usados.`;
}

/** Faixas de aviso (exemplos e lembrete de backup) e informações da tela Dados. */
function atualizarAvisos() {
  document.getElementById('aviso-exemplo').hidden = !db.temExemplos();
  const corr = db.estadoCorrupcao();
  document.getElementById('aviso-corrompido').hidden = !corr;
  if (corr) {
    document.getElementById('aviso-corrompido-copia').textContent = corr.chave_copia
      ? 'Uma cópia dos dados originais foi guardada neste aparelho.'
      : 'Os dados originais continuam guardados neste aparelho.';
  }
  // Cópias de dados corrompidos: oferece apagar só depois de resolver (nunca com a gravação bloqueada).
  const copias = db.listarCopiasCorrompidas().length;
  document.getElementById('card-copias-corrompidas').hidden = Boolean(corr) || copias === 0;
  document.getElementById('info-copias-corrompidas').textContent =
    `${copias === 1 ? 'Há 1 cópia antiga' : `Há ${copias} cópias antigas`} de dados que não puderam ser lidos. Se o backup restaurado está certo, pode apagar.`;
  // Lembrete de backup: 7 dias OU 20 vendas novas desde o último backup.
  const motivo = corr ? null : db.motivoLembreteBackup(7, Date.now(), 20);
  document.getElementById('aviso-backup').hidden = !motivo;
  if (motivo) {
    document.getElementById('aviso-backup-texto').textContent = motivo.tipo === 'vendas'
      ? `${motivo.vendas} vendas novas desde o último backup. Suas vendas só existem neste aparelho.`
      : 'Faz mais de 7 dias sem backup. Suas vendas só existem neste aparelho.';
  }
  const ultimo = db.ultimoBackup();
  document.getElementById('info-ultimo-backup').textContent = ultimo
    ? `Último backup: ${new Date(ultimo).toLocaleString('pt-BR', { dateStyle: 'short', timeStyle: 'short' })}.`
    : 'Nenhum backup feito ainda neste aparelho.';
}

/* ------------------------------------------------------------------ */
/* Navegação                                                           */
/* ------------------------------------------------------------------ */

function rotaAtual() {
  const h = location.hash.replace('#', '');
  if (h.startsWith('editar=')) return { tela: 'nova', id: decodeURIComponent(h.slice(7)) };
  return { tela: ['painel', 'nova', 'historico', 'insumos', 'dados'].includes(h) ? h : 'painel', id: null };
}

function navegar() {
  ui.esconderToastAoNavegar(); // aviso da tela anterior não cobre Cancelar/Salvar da nova tela
  const { tela, id } = rotaAtual();
  document.querySelectorAll('.tela').forEach((s) => (s.hidden = s.dataset.tela !== tela));
  document.querySelectorAll('[data-rota]').forEach((a) => {
    a.classList.toggle('ativo', a.dataset.rota === tela);
    if (a.dataset.rota === tela) a.setAttribute('aria-current', 'page');
    else a.removeAttribute('aria-current');
  });
  if (tela === 'nova') {
    const venda = id ? db.obterVenda(id) : null;
    if (id && !venda) {
      ui.mostrarToast('Venda não encontrada.', 'erro', null, { proximaTela: true });
      location.hash = '#historico';
      return;
    }
    // Saldo dos insumos SEM esta venda (para o aviso ao vivo de estoque insuficiente).
    producao.definirSaldoBase(db.calcularSaldos({ simular: { id: venda?.id ?? '__nova__' } }));
    ui.preencherFormulario(venda, venda?.cliente_id ? db.obterCliente(venda.cliente_id) : null);
  }
  window.scrollTo({ top: 0 });
}

/* ------------------------------------------------------------------ */
/* Ações                                                               */
/* ------------------------------------------------------------------ */

/** Texto das faltas de estoque: "PLA Preto: ficará -60 g". */
function descreverFaltas(faltas) {
  return faltas.map(({ insumo, saldo }) => `${insumo.nome}: ficará ${qtdComUnidade(saldo, insumo.unidade)}`).join('; ');
}

async function salvarFormulario(evento) {
  evento.preventDefault();
  const r = ui.lerFormulario();
  if (!r.ok) {
    ui.mostrarToast('Confira os campos destacados.', 'erro');
    return;
  }
  // Estoque insuficiente: avisa e PERGUNTA, mas não impede (o saldo pode ficar negativo).
  const faltas = db.faltasDeEstoque({ ...r.dados, id: r.id || '__nova__' });
  if (faltas.length && !(await ui.confirmar('Saldo insuficiente', `${descreverFaltas(faltas)}. Salvar mesmo assim?`, 'Salvar mesmo assim'))) {
    return;
  }
  // R$/hora digitado no item e ainda sem valor nas Configurações: guarda como padrão.
  try {
    if (r.custoHoraDigitado && !db.obterConfig().custo_hora_maquina) {
      db.salvarConfig({ custo_hora_maquina: r.custoHoraDigitado });
    }
    if (r.id) {
      db.atualizarVenda(r.id, r.dados);
      ui.mostrarToast('Venda atualizada!', 'ok', null, { proximaTela: true });
      atualizarTudo();
      location.hash = '#historico';
    } else {
      const v = db.adicionarVenda(r.dados);
      ui.mostrarToast(v.status === 'orcamento' ? `Orçamento #${v.numero} salvo!` : `Venda #${v.numero} salva!`, 'ok', null, { proximaTela: true });
      atualizarTudo();
      ui.preencherFormulario(null); // já deixa pronto para a próxima venda
      location.hash = '#painel';
    }
  } catch (erro) {
    ui.mostrarToast(erro.message, 'erro');
  }
}

async function excluir(id) {
  const v = db.obterVenda(id);
  if (!v) return;
  const nome = v.itens.length > 1 ? `${v.itens[0].descricao} e mais ${v.itens.length - 1}` : v.itens[0].descricao;
  const ok = await ui.confirmar('Excluir venda?', `Venda #${v.numero}: "${nome}" de ${v.data_venda.split('-').reverse().join('/')}.`);
  if (!ok) return;
  if (!tentar(() => db.excluirVenda(id))) return;
  atualizarTudo();
  ui.mostrarToast('Venda excluída.', 'ok', {
    texto: 'Desfazer',
    aoClicar: () => { if (tentar(() => db.restaurarVenda(id))) { atualizarTudo(); ui.mostrarToast('Venda restaurada.'); } },
  });
}

function mudarStatus(id, status) {
  try {
    const atual = db.obterVenda(id);
    const faltas = atual ? db.faltasDeEstoque({ ...atual, status }) : [];
    const v = db.atualizarVenda(id, { status });
    atualizarTudo();
    // Aprovar um orçamento baixa o estoque: se faltar, avisa (sem bloquear).
    if (faltas.length) ui.mostrarToast(`Venda #${v.numero}: ${STATUS[status].toLowerCase()}. ⚠ Saldo insuficiente — ${descreverFaltas(faltas)}.`, 'erro');
    else ui.mostrarToast(`Venda #${v.numero}: ${STATUS[status].toLowerCase()}.`);
  } catch (erro) {
    ui.mostrarToast(erro.message, 'erro');
  }
}

function marcarEntregue(id) {
  try {
    const v = db.atualizarVenda(id, { data_entrega: hojeISO() });
    atualizarTudo();
    ui.mostrarToast(`Venda #${v.numero} marcada como entregue.`);
  } catch (erro) {
    ui.mostrarToast(erro.message, 'erro');
  }
}

/**
 * Roda uma gravação; se falhar (armazenamento cheio/bloqueado ou dados
 * corrompidos), mostra o erro e devolve false. O storage já desfez a mudança.
 */
function tentar(fn) {
  try {
    fn();
    return true;
  } catch (erro) {
    atualizarTudo();
    ui.mostrarToast(erro.message, 'erro');
    return false;
  }
}

function carregarExemplos() {
  let n = 0;
  if (!tentar(() => { n = db.carregarExemplos(); })) return;
  atualizarTudo();
  ui.mostrarToast(`${n} vendas de exemplo carregadas.`);
}

async function removerExemplos() {
  if (!db.temExemplos()) return ui.mostrarToast('Não há dados de exemplo.');
  if (!(await ui.confirmar('Remover exemplos?', 'Apaga só as vendas de exemplo. Suas vendas reais continuam.', 'Remover'))) return;
  let n = 0;
  if (!tentar(() => { n = db.removerExemplos(); })) return;
  atualizarTudo();
  ui.mostrarToast(`${n} vendas de exemplo removidas.`);
}

function exportarCSV() {
  // No histórico exporta o que está filtrado; na tela Dados, exporta tudo.
  const naHistoria = rotaAtual().tela === 'historico';
  const lista = naHistoria ? ui.filtrarVendas(db.listarVendas(), estado.filtros) : db.listarVendas();
  if (!lista.length) return ui.mostrarToast('Nada para exportar.', 'erro');
  baixarArquivo(`vendas-${hojeISO()}.csv`, db.gerarCSV(lista), 'text/csv;charset=utf-8');
  ui.mostrarToast(`Planilha com ${lista.length} vendas exportada.`);
}

function baixarBackup() {
  if (db.estadoCorrupcao()) {
    ui.mostrarToast('Os dados salvos estão corrompidos: use "Baixar dados originais" no aviso do topo.', 'erro');
    return;
  }
  baixarArquivo(`backup-vendas-${hojeISO()}.json`, db.gerarBackupJSON(), 'application/json');
  db.registrarBackup();
  atualizarAvisos();
  ui.mostrarToast('Backup baixado. Guarde o arquivo em local seguro.');
}

async function importarArquivo(evento) {
  const arquivo = evento.target.files[0];
  evento.target.value = ''; // permite escolher o mesmo arquivo de novo
  if (!arquivo) return;
  const modo = document.querySelector('input[name="modo-importacao"]:checked').value;
  if (modo === 'substituir' && db.listarVendas().length &&
      !(await ui.confirmar('Substituir tudo?', 'As vendas atuais deste aparelho serão trocadas pelas do arquivo.', 'Substituir'))) return;
  try {
    const n = db.importarBackupJSON(await arquivo.text(), modo);
    atualizarTudo();
    ui.mostrarToast(`Backup restaurado: ${n} vendas.`);
  } catch (erro) {
    ui.mostrarToast(erro.message, 'erro');
  }
}

async function apagarTudo() {
  if (!(await ui.confirmar('Apagar TODAS as vendas?', 'Isso não pode ser desfeito. Faça um backup antes, se quiser guardar.', 'Apagar tudo'))) return;
  if (!tentar(() => db.apagarTudo())) return;
  atualizarTudo();
  ui.mostrarToast('Todas as vendas foram apagadas.');
}

/* ------------------------------------------------------------------ */
/* Tema claro/escuro                                                   */
/* ------------------------------------------------------------------ */

function alternarTema() {
  const atual = document.documentElement.dataset.tema ||
    (matchMedia('(prefers-color-scheme: dark)').matches ? 'escuro' : 'claro');
  const novo = atual === 'escuro' ? 'claro' : 'escuro';
  document.documentElement.dataset.tema = novo;
  localStorage.setItem('appVendas.tema', novo);
}

/* ------------------------------------------------------------------ */
/* Recursos do celular                                                 */
/* ------------------------------------------------------------------ */

/**
 * Pede ao navegador para NÃO apagar os dados deste site quando faltar espaço.
 * No Chrome/Android costuma ser concedido para apps instalados ou muito usados.
 */
async function pedirArmazenamentoPersistente() {
  const info = document.getElementById('info-persistencia');
  if (!navigator.storage?.persist) {
    info.textContent = 'Este navegador não permite proteger os dados contra limpeza automática.';
    return;
  }
  try {
    const jaPersistente = await navigator.storage.persisted();
    const ok = jaPersistente || (await navigator.storage.persist());
    info.textContent = ok
      ? 'Armazenamento protegido: o navegador não deve apagar estes dados sozinho.'
      : 'O navegador ainda não protegeu os dados (instalar o app na tela inicial ajuda). Mantenha o backup em dia.';
  } catch {
    info.textContent = '';
  }
}

/**
 * Teclado virtual: mantém a barra "Salvar" visível acima do teclado.
 * Usamos a API visualViewport: a diferença entre a altura da janela e a
 * área visível é o espaço ocupado pelo teclado. Esse valor vai para a
 * variável CSS --teclado, e a classe .teclado-aberto esconde a barra inferior.
 * (Com interactive-widget=resizes-content o Chrome já encolhe a página e o
 * valor fica perto de zero; o cálculo cobre os navegadores que não fazem isso.)
 */
function ajustarTeclado() {
  const vv = window.visualViewport;
  if (!vv) return;
  // Altura "cheia" da janela; recomeça se a largura mudar (girou a tela).
  let alturaCheia = window.innerHeight;
  let largura = window.innerWidth;
  const atualizar = () => {
    if (window.innerWidth !== largura) { largura = window.innerWidth; alturaCheia = window.innerHeight; }
    alturaCheia = Math.max(alturaCheia, window.innerHeight);
    const coberto = Math.max(0, window.innerHeight - vv.height - vv.offsetTop);
    const encolheu = alturaCheia - vv.height; // quando a página é redimensionada pelo teclado
    const aberto = coberto > 120 || encolheu > 120;
    document.documentElement.style.setProperty('--teclado', `${aberto ? coberto : 0}px`);
    document.body.classList.toggle('teclado-aberto', aberto);
    ui.posicionarToast();
  };
  vv.addEventListener('resize', atualizar);
  vv.addEventListener('scroll', atualizar);
  window.addEventListener('scroll', () => ui.posicionarToast(), { passive: true });
  atualizar();
}

/* ------------------------------------------------------------------ */
/* Inicialização                                                       */
/* ------------------------------------------------------------------ */

function iniciar() {
  ui.configurarFormulario();
  insumosUI.configurarInsumos(atualizarTudo);
  insumosUI.definirAvisador(ui.mostrarToast);

  // Configurações: custo da hora de máquina (padrão R$ 1,50/h, editável) e markup.
  document.getElementById('form-config').addEventListener('submit', (e) => {
    e.preventDefault();
    const campo = document.getElementById('c-hora');
    const erro = document.querySelector('[data-erro="custo_hora_maquina"]');
    const t = campo.value.trim();
    const c = textoParaCentavos(t);
    const campoM = document.getElementById('c-markup');
    const erroM = document.querySelector('[data-erro="markup_pct"]');
    const tm = campoM.value.trim();
    const m = textoParaNumero(tm);
    let ok = true;
    if (t && !(c > 0)) { erro.textContent = 'Valor inválido. Ex.: 1,50'; campo.setAttribute('aria-invalid', 'true'); ok = false; }
    else { erro.textContent = ''; campo.removeAttribute('aria-invalid'); }
    if (tm && !(m > 0 && m <= 10000)) { erroM.textContent = 'Valor inválido. Ex.: 100'; campoM.setAttribute('aria-invalid', 'true'); ok = false; }
    else { erroM.textContent = ''; campoM.removeAttribute('aria-invalid'); }
    if (!ok) return;
    if (!tentar(() => db.salvarConfig({ custo_hora_maquina: t ? c : null, markup_pct: tm ? m : null }))) return;
    atualizarTudo();
    ui.mostrarToast('Configurações salvas.');
  });
  ui.preencherSelect(document.getElementById('filtro-tipo'), TIPOS, 'Todos os tipos');

  document.getElementById('form-venda').addEventListener('submit', salvarFormulario);
  document.getElementById('botao-cancelar').addEventListener('click', () => history.length > 1 ? history.back() : (location.hash = '#painel'));

  // Cliques em botões das listas (delegação de eventos: funciona para itens criados depois).
  document.body.addEventListener('click', (e) => {
    const alvo = e.target.closest('[data-acao]');
    if (!alvo) return;
    const { acao, id } = alvo.dataset;
    if (acao === 'editar') location.hash = `#editar=${encodeURIComponent(id)}`;
    if (acao === 'excluir') excluir(id);
    if (acao === 'mudar-status') mudarStatus(id, alvo.dataset.status);
    if (acao === 'marcar-entregue') marcarEntregue(id);
    if (acao === 'carregar-exemplos') carregarExemplos();
  });

  // Filtros do histórico.
  const aplicarFiltros = () => {
    estado.filtros = {
      busca: document.getElementById('busca').value,
      periodo: document.getElementById('filtro-periodo').value,
      status: document.getElementById('filtro-status').value,
      tipo: document.getElementById('filtro-tipo').value,
    };
    const vendas = ui.ordenarRecentes(db.listarVendas());
    ui.renderizarHistorico(vendas, ui.filtrarVendas(vendas, estado.filtros));
  };
  document.getElementById('busca').addEventListener('input', aplicarFiltros);
  ['filtro-periodo', 'filtro-status', 'filtro-tipo'].forEach((id) =>
    document.getElementById(id).addEventListener('change', aplicarFiltros));

  // Botões 7/30 dias do gráfico.
  document.querySelectorAll('[data-dias]').forEach((b) => b.addEventListener('click', () => {
    estado.diasGrafico = Number(b.dataset.dias);
    document.querySelectorAll('[data-dias]').forEach((x) => x.classList.toggle('ativo', x === b));
    renderizarGrafico(document.getElementById('grafico'), totaisPorDia(db.listarVendas(), estado.diasGrafico));
  }));

  document.getElementById('botao-tema').addEventListener('click', alternarTema);
  document.getElementById('botao-backup').addEventListener('click', baixarBackup);
  document.getElementById('botao-exportar-csv').addEventListener('click', exportarCSV);
  document.getElementById('botao-exportar-csv-hist').addEventListener('click', exportarCSV);
  document.getElementById('arquivo-importar').addEventListener('change', importarArquivo);
  document.getElementById('botao-remover-exemplos').addEventListener('click', removerExemplos);
  document.getElementById('botao-remover-exemplos-aviso').addEventListener('click', removerExemplos);
  document.getElementById('botao-apagar-tudo').addEventListener('click', apagarTudo);
  document.getElementById('botao-backup-aviso').addEventListener('click', baixarBackup);
  document.getElementById('botao-adiar-backup').addEventListener('click', () => { db.adiarLembrete(2); atualizarAvisos(); });

  // Aviso de dados corrompidos: restaurar um backup ou baixar o texto original.
  document.getElementById('botao-restaurar-corrompido').addEventListener('click', () => {
    document.querySelector('input[name="modo-importacao"][value="substituir"]').checked = true;
    document.getElementById('arquivo-importar').click();
  });
  document.getElementById('botao-apagar-copias').addEventListener('click', async () => {
    const n = db.listarCopiasCorrompidas().length;
    if (!n || !(await ui.confirmar('Apagar cópias antigas?', `Apaga ${n === 1 ? 'a cópia' : `as ${n} cópias`} de dados corrompidos guardada${n === 1 ? '' : 's'} neste aparelho. Suas vendas atuais não mudam. Não dá para desfazer.`, 'Apagar cópias'))) return;
    let apagadas = 0;
    if (!tentar(() => { apagadas = db.apagarCopiasCorrompidas(); })) return;
    atualizarTudo();
    ui.mostrarToast(apagadas === 1 ? '1 cópia antiga apagada.' : `${apagadas} cópias antigas apagadas.`);
  });
  document.getElementById('botao-baixar-corrompido').addEventListener('click', () => {
    const corr = db.estadoCorrupcao();
    if (!corr) return;
    baixarArquivo(`dados-originais-${hojeISO()}.json`, corr.bruto, 'application/json');
    ui.mostrarToast('Dados originais baixados. Um técnico pode recuperar as vendas a partir deste arquivo.');
  });

  // Se outra aba alterar os dados, recarrega para não sobrescrever.
  window.addEventListener('storage', (e) => { if (e.key === 'appVendas.dados') location.reload(); });

  window.addEventListener('hashchange', navegar);
  atualizarTudo();
  navegar();

  pedirArmazenamentoPersistente();
  ajustarTeclado();

  // Service worker = funciona offline e permite "instalar" o app. Só roda via http(s).
  if ('serviceWorker' in navigator && location.protocol.startsWith('http')) {
    // import.meta.url aponta para js/app.js, então ../sw.js funciona também em subpasta (ex.: /app-vendas/).
    navigator.serviceWorker.register(new URL('../sw.js', import.meta.url)).catch((e) => console.warn('Service worker não registrado:', e));
  }
}

iniciar();
