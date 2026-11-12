/**
 * ui.js — Tudo o que mexe na tela: lista de vendas, formulário com vários
 * itens, filtros, mensagens rápidas (toast) e caixa de confirmação.
 *
 * Este módulo não grava nada: ele desenha dados e devolve os valores do
 * formulário. Quem decide salvar é o app.js.
 */
import {
  formatarMoeda, formatarNumeroBR, formatarDataBR, textoParaCentavos, textoParaNumero,
  hojeISO, somarDias, normalizarTexto, escaparHTML,
  PAGAMENTOS, STATUS, TIPOS, CANAIS,
} from './utils.js';
import { calcularVenda, totalItem, calcularLucro, precoSugerido } from './storage.js';
import * as producao from './producao.js';

/* ------------------------------------------------------------------ */
/* Lista de vendas                                                     */
/* ------------------------------------------------------------------ */

/** Ordena da mais nova para a mais antiga (data da venda, depois número). */
export function ordenarRecentes(vendas) {
  return [...vendas].sort((a, b) => b.data_venda.localeCompare(a.data_venda) || b.numero - a.numero);
}

/** Aplica busca, período, status e tipo de item. */
export function filtrarVendas(vendas, { busca = '', periodo = 'todos', status = 'todos', tipo = 'todos' }, hoje = hojeISO()) {
  const termo = normalizarTexto(busca).replace(/^#/, '');
  let inicio = null;
  if (periodo === 'hoje') inicio = hoje;
  if (periodo === '7dias') inicio = somarDias(hoje, -6); // hoje + 6 dias anteriores = 7 dias
  if (periodo === 'mes') inicio = hoje.slice(0, 7) + '-01';
  return vendas.filter((v) => {
    if (inicio && (v.data_venda < inicio || v.data_venda > hoje)) return false;
    if (status === 'a_entregar') {
      // Vendas fechadas (pendentes ou pagas) que ainda não foram entregues.
      if (!['pendente', 'pago'].includes(v.status) || v.data_entrega) return false;
    } else if (status !== 'todos' && v.status !== status) return false;
    if (tipo !== 'todos' && !v.itens.some((i) => i.tipo === tipo)) return false;
    if (termo) {
      const alvo = normalizarTexto(`${v.itens.map((i) => i.descricao).join(' ')} ${v.cliente_nome} ${v.numero}`);
      if (!alvo.includes(termo)) return false;
    }
    return true;
  });
}

/** Próxima ação rápida de pagamento sugerida para cada status. */
const ACAO_RAPIDA = {
  orcamento: { para: 'pendente', texto: 'Aprovar' },
  pendente: { para: 'pago', texto: 'Marcar pago' },
};

/** HTML de um item da lista. `compacto` esconde botões e detalhes (usado no painel). */
function itemVendaHTML(v, compacto = false) {
  const titulo = v.itens.length === 1
    ? escaparHTML(v.itens[0].descricao)
    : `${escaparHTML(v.itens[0].descricao)} <span class="mais-itens">+${v.itens.length - 1} ${v.itens.length === 2 ? 'item' : 'itens'}</span>`;
  const detalhes = [
    `#${v.numero}`,
    v.cliente_nome ? escaparHTML(v.cliente_nome) : '<em>Sem cliente</em>',
    formatarDataBR(v.data_venda),
    PAGAMENTOS[v.forma_pagamento],
  ].join(' · ');
  const linhasItens = !compacto && v.itens.length > 1
    ? `<ul class="item-sublista">${v.itens.map((i) => `<li>${String(i.quantidade).replace('.', ',')} × ${escaparHTML(i.descricao)} <span>${formatarMoeda(totalItem(i))}</span></li>`).join('')}</ul>`
    : '';
  const extras = [];
  if (!compacto) {
    if (v.itens.length === 1 && v.itens[0].quantidade !== 1) {
      extras.push(`${String(v.itens[0].quantidade).replace('.', ',')} × ${formatarMoeda(v.itens[0].preco_unitario)}`);
    }
    if (v.desconto) extras.push(`desconto ${formatarMoeda(v.desconto)}`);
    if (v.frete_cobrado) extras.push(`frete ${formatarMoeda(v.frete_cobrado)}`);
    if (v.status !== 'orcamento' && v.status !== 'cancelado') {
      const l = calcularLucro(v).lucro;
      extras.push(l == null ? 'lucro: sem preço' : `lucro ${formatarMoeda(l)}`);
    }
    if (v.data_entrega) extras.push(`entregue ${formatarDataBR(v.data_entrega)}`);
    else if (v.data_entrega_prevista && v.status !== 'cancelado') {
      extras.push(`entrega ${formatarDataBR(v.data_entrega_prevista)}`);
    }
  }
  const tipos = [...new Set(v.itens.map((i) => i.tipo))].map((t) => `<span class="selo selo-tipo">${TIPOS[t]}</span>`).join('');
  const acao = ACAO_RAPIDA[v.status];
  const podeEntregar = ['pendente', 'pago'].includes(v.status) && !v.data_entrega;
  // Botões SEMPRE visíveis (editar/excluir); não dependemos de gestos escondidos.
  const acoes = compacto ? '' : `
    <div class="item-acoes">
      ${acao ? `<button type="button" class="botao botao-pequeno botao-suave" data-acao="mudar-status" data-status="${acao.para}" data-id="${v.id}">${acao.texto}</button>` : ''}
      ${podeEntregar ? `<button type="button" class="botao botao-pequeno botao-suave" data-acao="marcar-entregue" data-id="${v.id}">Marcar entregue</button>` : ''}
      <button type="button" class="botao botao-pequeno" data-acao="editar" data-id="${v.id}">Editar</button>
      <button type="button" class="botao botao-pequeno botao-perigo-texto" data-acao="excluir" data-id="${v.id}">Excluir</button>
    </div>`;
  const seloEntrega = v.data_entrega
    ? '<span class="selo selo-entregue">Entregue</span>'
    : ['pendente', 'pago'].includes(v.status) ? '<span class="selo selo-a-entregar">A entregar</span>' : '';
  return `
    <li class="item-venda status-${v.status}" data-id="${v.id}">
      <div class="item-principal">
        <div class="item-info">
          <strong class="item-produto">${titulo}${v.exemplo ? ' <span class="selo selo-exemplo">exemplo</span>' : ''}</strong>
          <span class="item-detalhes">${detalhes}</span>
          ${compacto ? '' : `<span class="item-tipos">${tipos}</span>`}
          ${linhasItens}
          ${extras.length ? `<span class="item-detalhes">${extras.join(' · ')}</span>` : ''}
          ${v.observacoes && !compacto ? `<span class="item-obs">${escaparHTML(v.observacoes)}</span>` : ''}
        </div>
        <div class="item-valor">
          <strong>${formatarMoeda(v.total)}</strong>
          <span class="selo selo-${v.status}">${STATUS[v.status]}</span>
          ${seloEntrega}
        </div>
      </div>
      ${acoes}
    </li>`;
}

/** Desenha a lista do histórico, o resumo do filtro e o estado vazio. */
export function renderizarHistorico(todas, filtradas) {
  const lista = document.getElementById('lista-historico');
  const vazio = document.getElementById('historico-vazio');
  const resumo = document.getElementById('resumo-filtro');
  lista.innerHTML = filtradas.map((v) => itemVendaHTML(v)).join('');
  const semNada = todas.length === 0;
  vazio.hidden = filtradas.length > 0;
  vazio.querySelector('.vazio-acoes').hidden = !semNada;
  document.getElementById('historico-vazio-texto').textContent = semNada
    ? 'Nenhuma venda registrada ainda.'
    : 'Nenhuma venda encontrada com esses filtros.';
  const total = filtradas.reduce((t, v) => t + v.total, 0);
  resumo.textContent = semNada
    ? ''
    : `${filtradas.length} ${filtradas.length === 1 ? 'registro' : 'registros'} · ${formatarMoeda(total)}`;
}

/** Desenha as 5 últimas vendas no painel. */
export function renderizarUltimas(vendas) {
  const el = document.getElementById('ultimas-vendas');
  el.innerHTML = vendas.length
    ? vendas.slice(0, 5).map((v) => itemVendaHTML(v, true)).join('')
    : '<li class="vazio-mini">Nenhuma venda ainda. <a href="#nova">Registre a primeira</a> ou <button type="button" class="link" data-acao="carregar-exemplos">carregue dados de exemplo</button>.</li>';
}

/** Atualiza o autocompletar com itens (mais vendidos primeiro) e clientes já usados. */
export function atualizarSugestoes(itens, clientes) {
  itensConhecidosCache = new Map(itens.map((i) => [normalizarTexto(i.descricao), i]));
  clientesCache = new Map(clientes.map((c) => [normalizarTexto(c.nome), c]));
  const opcoes = (lista) => lista.map((s) => `<option value="${escaparHTML(s)}"></option>`).join('');
  document.getElementById('sugestoes-produtos').innerHTML = opcoes(itens.slice(0, 80).map((i) => i.descricao));
  document.getElementById('sugestoes-clientes').innerHTML = opcoes(clientes.map((c) => c.nome));
}
let itensConhecidosCache = new Map();
let clientesCache = new Map();

/** Preenche um <select> a partir de um objeto { valor: rótulo }. */
export function preencherSelect(select, opcoes, primeira = null) {
  select.innerHTML = (primeira ? `<option value="todos">${primeira}</option>` : '') +
    Object.entries(opcoes).map(([v, r]) => `<option value="${v}">${escaparHTML(r)}</option>`).join('');
}

/* ------------------------------------------------------------------ */
/* Formulário                                                          */
/* ------------------------------------------------------------------ */

const form = () => document.getElementById('form-venda');
const listaItens = () => document.getElementById('lista-itens');
let dataEntregaOriginal = null;
const moedaOuVazio = (c) => (c ? formatarNumeroBR(c) : '');

/** Liga os eventos do formulário (chamado uma vez ao abrir o app). */
export function configurarFormulario() {
  const f = form();
  preencherSelect(f.canal, CANAIS);

  document.getElementById('botao-add-item').addEventListener('click', () => {
    const li = adicionarLinhaItem();
    li.querySelector('[data-campo="descricao"]').focus();
  });

  // Qualquer digitação em itens, desconto ou frete recalcula os totais.
  f.addEventListener('input', (e) => {
    const alvo = e.target;
    limparErroDe(alvo);
    if (producao.aoMudar(e)) { atualizarTotais(); return; } // custo de produção muda o lucro e o preço sugerido
    const li = alvo.closest('.item-form');
    if (li && alvo.dataset.campo === 'descricao') autopreencherItem(li);
    if (li && alvo.dataset.campo === 'quantidade') producao.atualizarProducao(li); // por peça × qtd
    if (alvo.name === 'total') return; // o total digitado só é aplicado ao sair do campo
    if (li || ['desconto', 'frete_cobrado', 'taxa_pagamento', 'frete_custo'].includes(alvo.name)) atualizarTotais();
  });

  // Ao escolher um item já vendido antes, preenche tipo, preço e custo.
  f.addEventListener('change', (e) => {
    if (producao.aoMudar(e)) { atualizarTotais(); return; }
    if (e.target.name === 'status') producao.atualizarTodos(); // orçamento/cancelada não baixam estoque
    if (e.target.name === 'forma_pagamento') atualizarTotais();
    const li = e.target.closest('.item-form');
    if (!li) {
      if (e.target.name === 'cliente_nome') {
        const c = clientesCache.get(normalizarTexto(e.target.value));
        if (c?.whatsapp && !f.cliente_whatsapp.value) f.cliente_whatsapp.value = c.whatsapp;
      }
      return;
    }
    if (e.target.dataset.campo === 'tipo' && e.target.value === 'impressao_3d') {
      li.querySelector('.bloco-producao').open = true; // impressão 3D: custo de produção aberto
    }
  });

  // Remover item.
  listaItens().addEventListener('click', (e) => {
    if (producao.aoClicar(e)) { atualizarTotais(); return; } // + Adicionar insumo / remover insumo
    const usar = e.target.closest('[data-acao="usar-sugerido"]');
    if (usar) {
      const liS = usar.closest('.item-form');
      liS.querySelector('[data-campo="preco_unitario"]').value = formatarNumeroBR(Number(usar.dataset.valor));
      limparErroDe(liS.querySelector('[data-campo="preco_unitario"]'));
      atualizarTotais();
      return;
    }
    if (!e.target.closest('[data-acao="remover-item"]')) return;
    const li = e.target.closest('.item-form');
    if (listaItens().children.length === 1) {
      preencherLinhaItem(li, {}); // a venda precisa de ao menos 1 item: só limpa
    } else {
      li.remove();
    }
    numerarItens();
    atualizarTotais();
  });

  // Total digitado à mão: a diferença vira desconto (ou frete, se o total for maior).
  f.total.addEventListener('change', () => {
    const digitado = textoParaCentavos(f.total.value);
    if (!Number.isFinite(digitado) || digitado < 0) return; // a validação mostra o erro ao salvar
    const { subtotal } = calcularVenda({ itens: lerItensBrutos() });
    const frete = Math.max(0, textoParaCentavos(f.frete_cobrado.value) || 0);
    const diferenca = subtotal + frete - digitado;
    if (diferenca >= 0) {
      f.desconto.value = moedaOuVazio(diferenca);
    } else {
      f.desconto.value = '';
      f.frete_cobrado.value = moedaOuVazio(frete - diferenca);
    }
    atualizarTotais();
  });

  // Ao sair de um campo de dinheiro, mostra no formato "1.234,56".
  f.addEventListener('focusout', (e) => {
    const el = e.target;
    const dinheiro = ['desconto', 'frete_cobrado', 'total', 'taxa_pagamento', 'frete_custo'].includes(el.name) ||
      ['preco_unitario', 'custo_unitario'].includes(el.dataset.campo);
    if (!dinheiro) return;
    const c = textoParaCentavos(el.value);
    if (Number.isFinite(c)) el.value = formatarNumeroBR(c);
  });
}

/**
 * Ao escolher (ou digitar por completo) um item já vendido antes, preenche
 * tipo, preço e custo com os da última venda. Só age se o preço estiver vazio,
 * para nunca sobrescrever o que o usuário digitou.
 */
function autopreencherItem(li) {
  const descricao = li.querySelector('[data-campo="descricao"]');
  const preco = li.querySelector('[data-campo="preco_unitario"]');
  const conhecido = itensConhecidosCache.get(normalizarTexto(descricao.value));
  if (!conhecido || preco.value.trim()) return;
  const quantidade = li.querySelector('[data-campo="quantidade"]').value;
  const texto = descricao.value; // mantém exatamente o que foi digitado/escolhido
  preencherLinhaItem(li, {
    ...conhecido, id: li.dataset.id || undefined, descricao: texto, quantidade,
    producao: producao.linhasComPrecoAtual(conhecido.producao), // preços atuais dos insumos
  });
}

/** Cria uma linha de item a partir do <template> e devolve o <li>. */
function adicionarLinhaItem(item = {}) {
  const li = document.getElementById('modelo-item').content.firstElementChild.cloneNode(true);
  preencherSelect(li.querySelector('[data-campo="tipo"]'), TIPOS);
  listaItens().appendChild(li);
  preencherLinhaItem(li, item);
  numerarItens();
  return li;
}

/** Coloca os valores de um item nos campos da linha. */
function preencherLinhaItem(li, item) {
  const campo = (n) => li.querySelector(`[data-campo="${n}"]`);
  li.dataset.id = item.id || '';
  campo('descricao').value = item.descricao || '';
  campo('tipo').value = item.tipo || 'fisico';
  campo('quantidade').value = item.quantidade != null && item.quantidade !== '' ? String(item.quantidade).replace('.', ',') : '1';
  campo('preco_unitario').value = moedaOuVazio(item.preco_unitario);
  campo('custo_unitario').value = item.custo_unitario != null ? formatarNumeroBR(item.custo_unitario) : '';
  li.querySelectorAll('.erro').forEach((el) => (el.textContent = ''));
  producao.preencherProducao(li, item.producao || null, campo('tipo').value);
  atualizarTotalLinha(li);
}

function numerarItens() {
  [...listaItens().children].forEach((li, i) => (li.querySelector('.item-num').textContent = `Item ${i + 1}`));
}

/** Lê os itens como estão na tela (valores inválidos viram NaN/0). */
function lerItensBrutos() {
  return [...listaItens().children].map((li) => {
    const campo = (n) => li.querySelector(`[data-campo="${n}"]`).value;
    const tipo = campo('tipo');
    const custo = textoParaCentavos(campo('custo_unitario'));
    return {
      id: li.dataset.id || undefined,
      descricao: campo('descricao').trim(),
      tipo,
      quantidade: textoParaNumero(campo('quantidade')),
      preco_unitario: textoParaCentavos(campo('preco_unitario')),
      custo_unitario: Number.isFinite(custo) && custo >= 0 && campo('custo_unitario').trim() ? custo : null,
      _li: li,
    };
  });
}

function atualizarTotalLinha(li) {
  const q = textoParaNumero(li.querySelector('[data-campo="quantidade"]').value);
  const p = textoParaCentavos(li.querySelector('[data-campo="preco_unitario"]').value);
  li.querySelector('[data-saida="total"]').textContent =
    Number.isFinite(q) && Number.isFinite(p) ? formatarMoeda(Math.round(q * p)) : '—';
}

/** Recalcula subtotal e total mostrados no formulário. */
function atualizarTotais() {
  const f = form();
  [...listaItens().children].forEach(atualizarTotalLinha);
  const itens = lerItensBrutos().map((i) => ({
    ...i,
    quantidade: Number.isFinite(i.quantidade) ? i.quantidade : 0,
    preco_unitario: Number.isFinite(i.preco_unitario) ? i.preco_unitario : 0,
  }));
  const r = calcularVenda({
    itens,
    desconto: textoParaCentavos(f.desconto.value) || 0,
    frete_cobrado: textoParaCentavos(f.frete_cobrado.value) || 0,
  });
  document.getElementById('t-subtotal').textContent = formatarMoeda(r.subtotal);
  if (document.activeElement !== f.total) f.total.value = formatarNumeroBR(r.total);

  // Custo de cada item ao vivo => preço sugerido (markup) e lucro da venda.
  const markup = producao.markupAtual();
  const brutos = lerItensBrutos();
  for (const i of brutos) {
    i._custo_total = producao.custoItemAoVivo(i._li, i.custo_unitario);
    const saida = i._li.querySelector('[data-saida="sugerido"]');
    const botao = i._li.querySelector('[data-acao="usar-sugerido"]');
    const q = Number.isFinite(i.quantidade) && i.quantidade > 0 ? i.quantidade : null;
    const sug = q && i._custo_total != null ? precoSugerido(i._custo_total / q, markup) : null;
    if (sug != null) {
      saida.innerHTML = `Preço sugerido (custo + ${formatarNumeroBR(markup * 100).replace(/,00$/, '')}%): <strong>${formatarMoeda(sug)}</strong>/un.`;
      botao.dataset.valor = String(sug);
    } else if (markup == null) {
      saida.textContent = i._custo_total != null ? 'Preço sugerido: defina o markup em Dados → Configurações.' : '';
    } else {
      saida.innerHTML = 'Preço sugerido: <span class="sem-preco">sem preço</span> (falta o custo)';
    }
    botao.hidden = sug == null;
  }
  const taxa = textoParaCentavos(f.taxa_pagamento.value);
  const freteCusto = textoParaCentavos(f.frete_custo.value);
  const l = calcularLucro({
    itens: brutos.map(({ _li, ...i }) => i),
    total: r.total,
    frete_cobrado: r.frete_cobrado,
    forma_pagamento: f.forma_pagamento.value,
    taxa_pagamento: f.taxa_pagamento.value.trim() && Number.isFinite(taxa) && taxa >= 0 ? taxa : null,
    frete_custo: f.frete_custo.value.trim() && Number.isFinite(freteCusto) && freteCusto >= 0 ? freteCusto : null,
  });
  const saidaLucro = document.getElementById('t-lucro');
  saidaLucro.textContent = l.lucro == null ? 'sem preço' : formatarMoeda(l.lucro);
  saidaLucro.className = l.lucro == null ? 'sem-preco' : l.lucro < 0 ? 'negativo' : '';
  document.getElementById('t-lucro-detalhe').textContent = l.lucro == null
    ? `Falta: ${l.faltando.join(', ')}.`
    : `Total ${formatarMoeda(l.total)} − custo ${formatarMoeda(l.custo_total)} − taxa ${formatarMoeda(l.taxas)} − frete ${formatarMoeda(l.frete_custo)}`;
}

/** Preenche o formulário para nova venda (venda = null) ou para edição. */
export function preencherFormulario(venda = null, cliente = null) {
  const f = form();
  f.reset();
  limparErros();
  listaItens().innerHTML = '';
  document.getElementById('titulo-form').textContent = venda ? 'Editar venda' : 'Nova venda';
  document.getElementById('botao-salvar').textContent = venda ? 'Salvar alterações' : 'Salvar venda';
  document.getElementById('numero-venda').textContent = venda ? `Venda #${venda.numero}` : '';
  f.id.value = venda?.id || '';
  (venda?.itens?.length ? venda.itens : [{}]).forEach((i) => adicionarLinhaItem(i));
  f.desconto.value = moedaOuVazio(venda?.desconto);
  f.frete_cobrado.value = moedaOuVazio(venda?.frete_cobrado);
  f.taxa_pagamento.value = venda?.taxa_pagamento != null ? formatarNumeroBR(venda.taxa_pagamento) : '';
  f.frete_custo.value = venda?.frete_custo != null ? formatarNumeroBR(venda.frete_custo) : '';
  f.data_venda.value = venda?.data_venda || hojeISO();
  f.cliente_nome.value = venda?.cliente_nome || '';
  f.cliente_whatsapp.value = cliente?.whatsapp || '';
  f.forma_pagamento.value = venda?.forma_pagamento || 'pix';
  f.status.value = venda?.status || 'pago';
  f.entregue.checked = Boolean(venda?.data_entrega);
  dataEntregaOriginal = venda?.data_entrega || null;
  f.canal.value = venda?.canal || '';
  f.data_entrega_prevista.value = venda?.data_entrega_prevista || '';
  f.observacoes.value = venda?.observacoes || '';
  // Abre "Mais detalhes" na edição se algum desses campos estiver preenchido.
  document.getElementById('mais-detalhes').open = Boolean(
    venda && (venda.canal || venda.data_entrega_prevista || venda.observacoes || cliente?.whatsapp));
  atualizarTotais();
  producao.atualizarTodos(); // avisos de saldo consideram todos os itens
}

function limparErroDe(el) {
  el.removeAttribute('aria-invalid');
  const li = el.closest('.item-form');
  const erro = li && el.dataset.campo
    ? li.querySelector(`[data-erro-item="${el.dataset.campo}"]`)
    : form().querySelector(`[data-erro="${el.name}"]`);
  if (erro) erro.textContent = '';
}

function limparErros() {
  form().querySelectorAll('.erro').forEach((el) => (el.textContent = ''));
  form().querySelectorAll('[aria-invalid]').forEach((el) => el.removeAttribute('aria-invalid'));
}

/**
 * Lê e valida o formulário.
 * Retorna { ok: true, id, dados } ou { ok: false } (e mostra os erros na tela).
 */
export function lerFormulario() {
  const f = form();
  limparErros();
  let primeiroInvalido = null;
  const marcar = (el, msgEl, msg) => {
    msgEl.textContent = msg;
    el.setAttribute('aria-invalid', 'true');
    primeiroInvalido ??= el;
  };

  // Itens: linhas totalmente vazias são ignoradas (exceto se não sobrar nenhuma).
  const brutos = lerItensBrutos().filter((i, idx, todos) =>
    i.descricao || Number.isFinite(i.preco_unitario) || todos.length === 1);
  for (const i of brutos) {
    const campo = (n) => i._li.querySelector(`[data-campo="${n}"]`);
    const erro = (n) => i._li.querySelector(`[data-erro-item="${n}"]`);
    if (!i.descricao) marcar(campo('descricao'), erro('descricao'), 'Informe o produto ou serviço.');
    if (!Number.isFinite(i.quantidade) || i.quantidade <= 0) marcar(campo('quantidade'), erro('quantidade'), 'Maior que zero.');
    if (!Number.isFinite(i.preco_unitario) || i.preco_unitario <= 0) marcar(campo('preco_unitario'), erro('preco_unitario'), 'Ex.: 25,90');
    // Custo de produção (insumos + horas): valida e anexa ao item.
    const r = producao.lerProducao(i._li, i.tipo, i.custo_unitario);
    if (r.erros.length) {
      const msgEl = erro('producao');
      r.erros.forEach((x) => marcar(x.el, msgEl, ''));
      msgEl.textContent = [...new Set(r.erros.map((x) => x.msg))].join(' ');
    }
    i.producao = r.producao;
    if (r.temCalculo) i.custo_unitario = null; // o storage recalcula a partir dos snapshots
  }

  const dinheiroOpcional = (nome) => {
    const t = f[nome].value.trim();
    if (!t) return 0;
    const c = textoParaCentavos(t);
    if (!Number.isFinite(c) || c < 0) {
      marcar(f[nome], f.querySelector(`[data-erro="${nome}"]`), 'Valor inválido.');
      return 0;
    }
    return c;
  };
  // Opcional que distingue "em branco" (null) de R$ 0 digitado.
  const dinheiroOuNulo = (nome) => {
    const t = f[nome].value.trim();
    if (!t) return null;
    const c = textoParaCentavos(t);
    if (!Number.isFinite(c) || c < 0) {
      marcar(f[nome], f.querySelector(`[data-erro="${nome}"]`), 'Valor inválido.');
      return null;
    }
    return c;
  };
  const taxa_pagamento = dinheiroOpcional('taxa_pagamento'); // em branco = R$ 0 em qualquer forma de pagamento
  const frete_custo = dinheiroOuNulo('frete_custo');
  const desconto = dinheiroOpcional('desconto');
  const frete_cobrado = dinheiroOpcional('frete_cobrado');
  if (f.total.value.trim() && !Number.isFinite(textoParaCentavos(f.total.value))) {
    marcar(f.total, f.querySelector('[data-erro="total"]'), 'Valor inválido.');
  }

  const data = f.data_venda.value;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(data)) marcar(f.data_venda, f.querySelector('[data-erro="data_venda"]'), 'Escolha uma data.');
  else if (data > somarDias(hojeISO(), 365)) marcar(f.data_venda, f.querySelector('[data-erro="data_venda"]'), 'Data muito no futuro. Confira o ano.');

  if (!primeiroInvalido) {
    const { subtotal } = calcularVenda({ itens: brutos });
    if (desconto > subtotal + frete_cobrado) {
      marcar(f.desconto, f.querySelector('[data-erro="desconto"]'), 'O desconto é maior que o valor da venda.');
    }
  }

  if (primeiroInvalido) {
    primeiroInvalido.focus();
    return { ok: false };
  }

  return {
    ok: true,
    id: f.id.value || null,
    custoHoraDigitado: producao.custoHoraDigitado(),
    dados: {
      itens: brutos.map(({ _li, ...i }) => i),
      desconto,
      frete_cobrado,
      taxa_pagamento,
      frete_custo,
      data_venda: data,
      cliente_nome: f.cliente_nome.value.trim(),
      cliente_whatsapp: f.cliente_whatsapp.value.trim(),
      forma_pagamento: f.forma_pagamento.value,
      status: f.status.value,
      // Mantém a data original se já estava entregue; senão, entregue hoje.
      data_entrega: f.entregue.checked ? (dataEntregaOriginal || hojeISO()) : null,
      canal: f.canal.value,
      data_entrega_prevista: f.data_entrega_prevista.value || null,
      observacoes: f.observacoes.value.trim(),
    },
  };
}

/* ------------------------------------------------------------------ */
/* Toast e confirmação                                                 */
/* ------------------------------------------------------------------ */

let timerToast;
/**
 * Mostra uma mensagem rápida no rodapé.
 * `acao` opcional: { texto: 'Desfazer', aoClicar: () => {...} }.
 */
/**
 * Mostra um aviso rápido. `opcoes.proximaTela`: o aviso é sobre uma ação que
 * leva a outra tela (ex.: "Venda salva!" e volta ao painel) e deve sobreviver
 * a ESSA navegação; qualquer outro aviso some ao trocar de tela.
 */
export function mostrarToast(mensagem, tipo = 'ok', acao = null, opcoes = {}) {
  const t = document.getElementById('toast');
  t.dataset.manterAoNavegar = opcoes.proximaTela ? '1' : '';
  const botao = document.getElementById('toast-acao');
  document.getElementById('toast-texto').textContent = mensagem;
  t.dataset.tipo = tipo;
  botao.hidden = !acao;
  botao.onclick = acao ? () => { t.hidden = true; acao.aoClicar(); } : null;
  if (acao) botao.textContent = acao.texto;
  t.hidden = false;
  posicionarToast();
  clearTimeout(timerToast);
  timerToast = setTimeout(() => (t.hidden = true), acao ? 6000 : 3200);
}

/** Chamado a cada troca de tela: esconde avisos da tela anterior. */
export function esconderToastAoNavegar() {
  const t = document.getElementById('toast');
  if (t.dataset.manterAoNavegar === '1') {
    t.dataset.manterAoNavegar = ''; // sobrevive só a uma navegação
    requestAnimationFrame(posicionarToast); // depois que a tela nova aparecer
    return;
  }
  t.hidden = true;
  clearTimeout(timerToast);
}

/**
 * Coloca o aviso ACIMA do que estiver preso no rodapé: barra inferior e a
 * barra Cancelar/Salvar (fixa, inclusive com o teclado aberto). A área
 * segura já está na altura dessas barras; sem elas, usa a área segura do CSS.
 */
export function posicionarToast() {
  const t = document.getElementById('toast');
  if (!t || t.hidden) return;
  const vv = window.visualViewport;
  const fundoVisivel = vv ? vv.offsetTop + vv.height : window.innerHeight;
  let topo = fundoVisivel;
  const candidatos = [document.querySelector('.nav-inferior'),
    ...document.querySelectorAll('.tela:not([hidden]) .acoes-fixas')];
  for (const el of candidatos) {
    if (!el || getComputedStyle(el).display === 'none') continue;
    const r = el.getBoundingClientRect();
    // Só conta o que está encostado no rodapé visível (barra fixa/sticky), não no meio da página.
    if (r.height && r.top < fundoVisivel && r.bottom > fundoVisivel - 140) topo = Math.min(topo, r.top);
  }
  if (topo < fundoVisivel) {
    // `bottom` é medido do fundo da janela (layout); o teclado pode cobrir parte dela.
    t.style.bottom = `${Math.round(window.innerHeight - topo + 8)}px`;
  } else {
    t.style.bottom = ''; // CSS: área segura + margem
  }
}

/**
 * Abre a caixa de confirmação e devolve uma Promise<boolean>.
 * Uso: if (await confirmar('Excluir?', 'Detalhes...')) { ... }
 */
export function confirmar(titulo, mensagem, textoOk = 'Excluir') {
  const d = document.getElementById('dialogo-confirmar');
  document.getElementById('dialogo-titulo').textContent = titulo;
  document.getElementById('dialogo-mensagem').textContent = mensagem;
  document.getElementById('dialogo-ok').textContent = textoOk;
  return new Promise((resolver) => {
    d.addEventListener('close', () => resolver(d.returnValue === 'ok'), { once: true });
    d.returnValue = '';
    d.showModal();
    document.getElementById('dialogo-cancelar').focus();
  });
}
