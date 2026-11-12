/**
 * producao.js — Bloco "Custo de produção" dentro de cada item do formulário de venda.
 *
 * Um item (ex.: luminária) pode usar VÁRIOS insumos. Cada linha é:
 *   - "por peça": a quantidade é de UMA peça e é multiplicada pela qtd do item;
 *   - "por linha": a quantidade vale uma vez para o item inteiro (ex.: 1 caixa).
 *
 *   custo_linha = qtd × (Σ insumos por peça + horas × R$/h) + Σ insumos por linha + extra
 *
 * A MESMA quantidade usada no custo é a que sai do saldo do insumo.
 * Unidades: filamento (insumo em g ou kg) é SEMPRE digitado em gramas na venda;
 * só g↔kg são convertidos; ml nunca vira g.
 *
 * SNAPSHOT: ao escolher um insumo, copiamos nome, unidade e custo por unidade
 * para a linha. Venda antiga continua com a cópia salva, mesmo se o preço mudar.
 * O R$/hora usado também fica no item.
 *
 * NUNCA R$ 0: insumo sem preço aparece como "sem preço" e o custo fica em aberto;
 * horas sem R$/hora fazem o formulário pedir o valor.
 */
import {
  formatarMoeda, formatarNumeroBR, formatarCustoUnidade, textoParaCentavos, textoParaCentavosPreciso,
  textoParaNumero, numeroParaCampo, qtdComUnidade, escaparHTML, UNIDADES, CATEGORIAS_INSUMO,
} from './utils.js';
import {
  calcularProducao, precoPorKg, unidadeNaVenda, custoNaUnidadeDaVenda, converterUnidade, quantidadeTotalLinha,
} from './storage.js';

const MANUAL = '__manual';

/**
 * Contexto atualizado pelo app: insumos (por id), configurações e o saldo de
 * cada insumo SEM a venda que está aberta no formulário (saldoBase).
 */
let ctx = { insumos: new Map(), config: { custo_hora_maquina: 150 }, saldoBase: new Map() };
export function definirContexto(insumos, config) {
  ctx.insumos = new Map(insumos.map((i) => [i.id, i]));
  ctx.config = config;
}
export function definirSaldoBase(saldos) {
  ctx.saldoBase = saldos;
}

const fmtQtd = (q, u) => qtdComUnidade(q, u);

/** Texto da opção: só o nome (o preço aparece ABAIXO do select, para caber em 412 px). */
function rotuloInsumo(i, inativo = false) {
  return `${inativo ? '(inativo) ' : ''}${i.nome}`;
}

/** Linha abaixo do select: "R$ 0,1025/g · R$ 102,50/kg" ou "sem preço". Usa o preço que a venda vai guardar. */
function mostrarPrecoInsumo(li) {
  const saida = li.querySelector('[data-saida="preco-insumo"]');
  const escolha = li.querySelector('[data-l="insumo_id"]').value;
  const snap = lerSnapshot(li);
  if (!escolha || escolha === MANUAL || !snap) { saida.hidden = true; saida.textContent = ''; return; }
  saida.hidden = false;
  if (snap.custo_unidade == null) {
    saida.innerHTML = '<span class="sem-preco">sem preço</span> — informe o preço pago em Insumos';
    return;
  }
  const kg = snap.unidade === 'g' ? ` · ${formatarMoeda(Math.round(snap.custo_unidade * 1000))}/kg` : '';
  saida.textContent = `${formatarCustoUnidade(snap.custo_unidade)}/${UNIDADES[snap.unidade]}${kg}`;
}

/** Opções do select de uma linha: ativos por categoria + o já usado (mesmo inativo) + manual. */
function opcoesInsumo(select, idAtual, snapshot) {
  const ativos = [...ctx.insumos.values()].filter((i) => i.ativo && !i.excluido_em)
    .sort((a, b) => a.nome.localeCompare(b.nome, 'pt-BR'));
  let html = '<option value="">Escolha o insumo…</option>';
  const grupos = {};
  for (const i of ativos) (grupos[i.categoria] ||= []).push(i);
  for (const [cat, lista] of Object.entries(grupos)) {
    html += `<optgroup label="${escaparHTML(CATEGORIAS_INSUMO[cat])}">` +
      lista.map((i) => `<option value="${i.id}">${escaparHTML(rotuloInsumo(i))}</option>`).join('') + '</optgroup>';
  }
  if (idAtual && !ativos.some((i) => i.id === idAtual)) {
    const base = ctx.insumos.get(idAtual) || { nome: snapshot?.nome || 'insumo', unidade: snapshot?.unidade || 'un' };
    html += `<option value="${escaparHTML(idAtual)}">${escaparHTML(`(inativo) ${base.nome}`)}</option>`;
  }
  html += `<option value="${MANUAL}">Outro (informar preço)</option>`;
  select.innerHTML = html;
}

const qtdDoItem = (liItem) => {
  const q = textoParaNumero(liItem.querySelector('[data-campo="quantidade"]').value);
  return Number.isFinite(q) && q > 0 ? q : 0;
};

/* ------------------------------------------------------------------ */
/* Montagem                                                            */
/* ------------------------------------------------------------------ */

/** Preenche o bloco de produção de um item (producao = null para item novo). */
export function preencherProducao(liItem, producao, tipo) {
  const bloco = liItem.querySelector('.bloco-producao');
  bloco.querySelector('.linhas-insumo').innerHTML = '';
  (producao?.linhas || []).forEach((l) => adicionarLinha(liItem, l));
  const campo = (n) => bloco.querySelector(`[data-p="${n}"]`);
  campo('horas_unit').value = numeroParaCampo(producao?.horas_unit);
  // Na edição usa o R$/hora guardado na venda; em item novo, o das Configurações (se houver).
  const hora = producao ? producao.custo_hora : ctx.config.custo_hora_maquina;
  campo('custo_hora').value = hora ? formatarNumeroBR(hora) : '';
  campo('custo_extra').value = producao?.custo_extra ? formatarNumeroBR(producao.custo_extra) : '';
  campo('cor').value = producao?.cor || '';
  campo('link_modelo').value = producao?.link_modelo || '';
  const nota = bloco.querySelector('[data-saida="nota-legado"]');
  nota.hidden = !producao?.nota_legado;
  nota.textContent = producao?.nota_legado || '';
  bloco.open = tipo === 'impressao_3d' || Boolean(producao?.linhas?.length || producao?.horas_unit || producao?.custo_extra);
  atualizarProducao(liItem);
}

/** Adiciona uma linha de insumo (linha = dados salvos, ou {} para nova). */
export function adicionarLinha(liItem, linha = {}) {
  const li = document.getElementById('modelo-linha-insumo').content.firstElementChild.cloneNode(true);
  const select = li.querySelector('[data-l="insumo_id"]');
  li.querySelector('[data-l="unidade"]').innerHTML =
    Object.entries(UNIDADES).map(([v, r]) => `<option value="${v}">${r}</option>`).join('');
  if (linha.insumo_id) {
    li.dataset.snapshot = JSON.stringify({
      insumo_id: linha.insumo_id, nome: linha.nome, categoria: linha.categoria,
      unidade: linha.unidade, custo_unidade: linha.custo_unidade ?? null,
    });
  }
  opcoesInsumo(select, linha.insumo_id, linha.insumo_id ? lerSnapshotTexto(li.dataset.snapshot) : null);
  if (linha.insumo_id) select.value = linha.insumo_id;
  else if (linha.nome) {
    select.value = MANUAL; // linha manual salva antes
    li.querySelector('[data-l="nome"]').value = linha.nome;
    li.querySelector('[data-l="custo_manual"]').value = linha.custo_unidade != null ? numeroParaCampo(linha.custo_unidade / 100) : '';
    li.querySelector('[data-l="unidade"]').value = linha.unidade || 'un';
  }
  li.querySelector('[data-l="modo"]').value = linha.modo === 'por_linha' ? 'por_linha' : 'por_peca';
  li.querySelector('[data-l="quantidade"]').value = numeroParaCampo(linha.quantidade);
  liItem.querySelector('.linhas-insumo').appendChild(li);
  mostrarModoLinha(li);
  return li;
}

function lerSnapshotTexto(t) {
  try { return t ? JSON.parse(t) : null; } catch { return null; }
}
const lerSnapshot = (li) => lerSnapshotTexto(li.dataset.snapshot);

function mostrarModoLinha(li) {
  const manual = li.querySelector('[data-l="insumo_id"]').value === MANUAL;
  li.querySelectorAll('[data-manual]').forEach((el) => (el.hidden = !manual));
  const unidade = manual ? li.querySelector('[data-l="unidade"]').value : lerSnapshot(li)?.unidade;
  li.querySelector('[data-saida="unidade"]').textContent = unidade ? UNIDADES[unidade] : '';
  mostrarPrecoInsumo(li);
}

/* ------------------------------------------------------------------ */
/* Eventos (chamados pelo ui.js via delegação)                         */
/* ------------------------------------------------------------------ */

/** Trata change/input dentro do bloco. Retorna true se tratou. */
export function aoMudar(evento) {
  const el = evento.target;
  const liItem = el.closest('.item-form');
  if (!liItem || !el.closest('.bloco-producao')) return false;
  const linha = el.closest('.linha-insumo');
  if (linha && el.dataset.l === 'insumo_id' && evento.type === 'change') {
    const ins = ctx.insumos.get(el.value);
    // Trocar o insumo = nova cópia do preço ATUAL, já na unidade da venda (g para filamento).
    if (ins) {
      linha.dataset.snapshot = JSON.stringify({
        insumo_id: ins.id, nome: ins.nome, categoria: ins.categoria,
        unidade: unidadeNaVenda(ins.unidade), custo_unidade: custoNaUnidadeDaVenda(ins),
      });
    } else delete linha.dataset.snapshot;
    mostrarModoLinha(linha);
  }
  if (linha && el.dataset.l === 'unidade') mostrarModoLinha(linha);
  atualizarProducao(liItem);
  return true;
}

/** Trata cliques (adicionar/remover linha). Retorna true se tratou. */
export function aoClicar(evento) {
  const alvo = evento.target.closest('[data-acao="add-linha"], [data-acao="remover-linha"]');
  if (!alvo) return false;
  const liItem = alvo.closest('.item-form');
  if (alvo.dataset.acao === 'add-linha') {
    adicionarLinha(liItem, {}).querySelector('[data-l="insumo_id"]').focus();
  } else {
    alvo.closest('.linha-insumo').remove();
  }
  atualizarProducao(liItem);
  return true;
}

/* ------------------------------------------------------------------ */
/* Leitura, cálculo e validação                                        */
/* ------------------------------------------------------------------ */

/** Lê o bloco como dados (sem validar). */
function lerBruto(liItem) {
  const bloco = liItem.querySelector('.bloco-producao');
  const campo = (n) => bloco.querySelector(`[data-p="${n}"]`).value;
  const linhas = [...bloco.querySelectorAll('.linha-insumo')].map((li) => {
    const escolha = li.querySelector('[data-l="insumo_id"]').value;
    const q = textoParaNumero(li.querySelector('[data-l="quantidade"]').value);
    const base = {
      _li: li, _escolha: escolha,
      modo: li.querySelector('[data-l="modo"]').value,
      quantidade: Number.isFinite(q) && q > 0 ? q : null,
    };
    if (escolha === MANUAL) {
      const c = textoParaCentavosPreciso(li.querySelector('[data-l="custo_manual"]').value);
      return {
        ...base, insumo_id: null, nome: li.querySelector('[data-l="nome"]').value.trim(), categoria: 'outro',
        unidade: li.querySelector('[data-l="unidade"]').value, custo_unidade: Number.isFinite(c) && c > 0 ? c : null,
      };
    }
    const snap = lerSnapshot(li);
    return snap ? { ...base, ...snap } : { ...base, insumo_id: null, nome: '', unidade: 'un', custo_unidade: null };
  });
  const horas = textoParaNumero(campo('horas_unit'));
  const hora = textoParaCentavos(campo('custo_hora'));
  const extra = textoParaCentavos(campo('custo_extra'));
  return {
    linhas,
    horas_unit: Number.isFinite(horas) && horas > 0 ? horas : null,
    custo_hora: Number.isFinite(hora) && hora > 0 ? hora : null,
    custo_extra: Number.isFinite(extra) && extra > 0 ? extra : 0,
    cor: campo('cor').trim(),
    link_modelo: campo('link_modelo').trim(),
    nota_legado: bloco.querySelector('[data-saida="nota-legado"]').textContent,
  };
}

/** Recalcula e mostra o custo do item; bloqueia/preenche o campo "Custo unit.". */
export function atualizarProducao(liItem) {
  const bloco = liItem.querySelector('.bloco-producao');
  const qtd = qtdDoItem(liItem);
  const todas = lerBruto(liItem);
  // Linha recém-adicionada e ainda vazia não conta (igual ao salvar).
  todas.linhas.forEach((l) => {
    if (l._escolha === '' && l.quantidade == null) {
      l._li.querySelector('[data-saida="custo-linha"]').textContent = '—';
      l._li.querySelector('[data-saida="custo-unit-linha"]').textContent = '';
    }
  });
  const p = { ...todas, linhas: todas.linhas.filter((l) => !(l._escolha === '' && l.quantidade == null)) };
  const calc = calcularProducao(p, qtd);
  calc.linhas.forEach((l, idx) => {
    const li = p.linhas[idx]._li;
    li.querySelector('[data-saida="custo-linha"]').textContent =
      l.custo_linha != null ? formatarMoeda(l.custo_linha) : (l.quantidade && p.linhas[idx]._escolha ? 'sem preço' : '—');
    const partes = [];
    // Preço do insumo cadastrado aparece abaixo do select; aqui só o da linha manual.
    if (p.linhas[idx]._escolha === MANUAL && l.custo_unidade != null && l.unidade) partes.push(`${formatarCustoUnidade(l.custo_unidade)}/${UNIDADES[l.unidade]}`);
    if (l.quantidade_total != null && l.modo === 'por_peca' && qtd !== 1) {
      partes.push(`${fmtQtd(l.quantidade, l.unidade)} × ${numeroParaCampo(qtd)} = ${fmtQtd(l.quantidade_total, l.unidade)}`);
    }
    li.querySelector('[data-saida="custo-unit-linha"]').textContent = partes.join(' · ');
  });
  const semInsumos = ![...ctx.insumos.values()].some((i) => i.ativo && !i.excluido_em);
  bloco.querySelector('[data-saida="sem-insumos"]').hidden = !semInsumos;

  const temAlgo = p.linhas.length > 0 || p.horas_unit || p.custo_extra;
  const saida = bloco.querySelector('[data-saida="custo-producao"]');
  const resumo = bloco.querySelector('[data-saida="resumo-producao"]');
  const custoCampo = liItem.querySelector('[data-campo="custo_unitario"]');
  atualizarAvisosSaldo();
  if (!temAlgo) {
    saida.textContent = 'Adicione os insumos usados (por peça ou por pedido) e, se quiser, as horas de máquina.';
    resumo.textContent = '';
    custoCampo.readOnly = false;
    custoCampo.classList.remove('calculado');
    custoCampo.placeholder = '0,00';
    return null;
  }
  // Com produção preenchida, o custo unitário vem do cálculo (campo só leitura).
  custoCampo.readOnly = true;
  custoCampo.classList.add('calculado');
  if (calc.custo_total_item == null) {
    saida.innerHTML = `<span class="pendente-txt">Custo: sem preço. Falta: ${escaparHTML([...new Set(calc.faltando)].join('; '))}.</span>`;
    resumo.textContent = '· sem preço';
    custoCampo.value = '';
    custoCampo.placeholder = 'sem preço';
    return null;
  }
  const insumos = calc.linhas.reduce((t, l) => t + l.custo_linha, 0);
  const partes = [`insumos ${formatarMoeda(insumos)}`];
  if (calc.custo_maquina) partes.push(`máquina ${formatarMoeda(calc.custo_maquina)}`);
  if (calc.custo_extra) partes.push(`extra ${formatarMoeda(calc.custo_extra)}`);
  saida.innerHTML = `Custo de produção do item: <strong>${formatarMoeda(calc.custo_total_item)}</strong> (${partes.join(' + ')})` +
    (qtd > 0 ? ` · ${formatarMoeda(Math.round(calc.custo_total_item / qtd))}/un.` : '');
  resumo.textContent = `· ${formatarMoeda(calc.custo_total_item)}`;
  custoCampo.value = qtd > 0 ? formatarNumeroBR(Math.round(calc.custo_total_item / qtd)) : '';
  return calc.custo_total_item;
}

/** Atualiza todos os itens (ex.: ao mudar o status ou abrir o formulário). */
export function atualizarTodos() {
  document.querySelectorAll('#lista-itens .item-form').forEach((li) => atualizarProducao(li));
}

/** Status atual escolhido no formulário (orçamento e cancelada não baixam estoque). */
const formBaixaEstoque = () => ['pendente', 'pago'].includes(document.querySelector('#form-venda [name="status"]:checked')?.value);

/**
 * Aviso de saldo ao vivo: soma o consumo de TODAS as linhas do formulário por
 * insumo e compara com o saldo sem esta venda. Mostra o aviso em cada linha.
 */
function atualizarAvisosSaldo() {
  const consumo = new Map(); // insumo_id -> quantidade (unidade do insumo)
  const linhas = [];
  for (const liItem of document.querySelectorAll('#lista-itens .item-form')) {
    const qtd = qtdDoItem(liItem);
    for (const li of liItem.querySelectorAll('.linha-insumo')) {
      const snap = lerSnapshot(li);
      const ins = snap && ctx.insumos.get(snap.insumo_id);
      const q = textoParaNumero(li.querySelector('[data-l="quantidade"]').value);
      const total = ins && q > 0 ? quantidadeTotalLinha({ quantidade: q, modo: li.querySelector('[data-l="modo"]').value }, qtd) : null;
      const conv = total != null ? converterUnidade(total, snap.unidade, ins.unidade) : null;
      if (conv != null) consumo.set(ins.id, (consumo.get(ins.id) || 0) + conv);
      linhas.push({ li, ins, snap });
    }
  }
  const baixa = formBaixaEstoque();
  for (const { li, ins, snap } of linhas) {
    const aviso = li.querySelector('[data-saida="saldo"]');
    if (!ins) { aviso.hidden = true; continue; }
    const antes = ctx.saldoBase.get(ins.id) ?? 0;
    const depois = antes - (baixa ? consumo.get(ins.id) || 0 : 0);
    // Mostra na unidade da venda (g para filamento em kg).
    const mostrar = (x) => fmtQtd(converterUnidade(x, ins.unidade, snap.unidade) ?? x, snap.unidade);
    aviso.hidden = false;
    aviso.classList.toggle('negativo', depois < 0);
    aviso.textContent = depois < 0
      ? `⚠ Saldo insuficiente: disponível ${mostrar(antes)}, ficará ${mostrar(depois)}.`
      : `Saldo: ${mostrar(antes)}${baixa ? ` → ${mostrar(depois)} depois desta venda` : ' (orçamento/cancelada não baixa)'}`;
  }
}

/**
 * Valida e devolve a produção do item.
 * Retorna { producao (ou null), erros: [{ el, msg }], temCalculo }.
 */
export function lerProducao(liItem, tipoItem, custoManual) {
  const bloco = liItem.querySelector('.bloco-producao');
  const p = lerBruto(liItem);
  const erros = [];
  p.linhas = p.linhas.filter((l) => !(l._escolha === '' && l.quantidade == null)); // linha totalmente vazia
  for (const l of p.linhas) {
    const sel = l._li.querySelector('[data-l="insumo_id"]');
    if (l._escolha === '') erros.push({ el: sel, msg: 'Escolha o insumo de cada linha.' });
    else if (l._escolha === MANUAL) {
      if (!l.nome) erros.push({ el: l._li.querySelector('[data-l="nome"]'), msg: 'Informe o nome do insumo.' });
      if (l.custo_unidade == null) erros.push({ el: l._li.querySelector('[data-l="custo_manual"]'), msg: `Informe o custo de "${l.nome || 'insumo'}" (não usamos R$ 0).` });
    }
    // Insumo cadastrado SEM preço não bloqueia: o custo fica "sem preço" (nunca R$ 0).
    if (l.quantidade == null) erros.push({ el: l._li.querySelector('[data-l="quantidade"]'), msg: 'Informe a quantidade de cada insumo.' });
  }
  if (p.horas_unit && !p.custo_hora) {
    erros.push({ el: bloco.querySelector('[data-p="custo_hora"]'), msg: 'Informe o R$ por hora de máquina (ou defina em Dados → Configurações).' });
  }
  const temAlgo = p.linhas.length > 0 || p.horas_unit || p.custo_extra;
  if (tipoItem === 'impressao_3d' && !temAlgo && !(custoManual > 0)) {
    erros.push({ el: bloco.querySelector('[data-acao="add-linha"]'), msg: 'Impressão 3D: adicione o filamento usado (ou informe o custo unitário).' });
  }
  if (erros.length) bloco.open = true;
  const extras = p.cor || p.link_modelo || p.nota_legado;
  const producao = temAlgo || extras ? { ...p, linhas: p.linhas.map(({ _li, _escolha, ...l }) => l) } : null;
  return { producao, erros, temCalculo: Boolean(temAlgo) };
}

/**
 * Custo TOTAL do item como está na tela agora (sem marcar erros).
 * Com custo de produção: usa a fórmula; sem: custo unit. digitado × qtd.
 * null = falta algum dado ("sem preço").
 */
export function custoItemAoVivo(liItem, custoManualUnit) {
  const qtd = qtdDoItem(liItem);
  const p = lerBruto(liItem);
  p.linhas = p.linhas.filter((l) => !(l._escolha === '' && l.quantidade == null));
  const temAlgo = p.linhas.length > 0 || p.horas_unit || p.custo_extra;
  if (!temAlgo) return custoManualUnit != null && qtd > 0 ? Math.round(custoManualUnit * qtd) : null;
  if (!(qtd > 0)) return null;
  return calcularProducao(p, qtd).custo_total_item;
}

/** Markup das Configurações (null = não definido; não há padrão). */
export function markupAtual() {
  return ctx.config.markup_pct ?? null;
}

/** R$/hora digitado em algum item (para salvar nas Configurações se ainda não houver). */
export function custoHoraDigitado() {
  for (const el of document.querySelectorAll('#lista-itens [data-p="custo_hora"]')) {
    const c = textoParaCentavos(el.value);
    if (Number.isFinite(c) && c > 0) return c;
  }
  return null;
}

/**
 * Para pré-preencher um item NOVO a partir de uma venda antiga: atualiza nome,
 * unidade e custo das linhas com o preço ATUAL dos insumos ativos.
 * (Vendas já salvas nunca passam por aqui; elas mantêm o snapshot.)
 */
export function linhasComPrecoAtual(producao) {
  if (!producao) return null;
  return {
    ...producao,
    custo_hora: ctx.config.custo_hora_maquina || producao.custo_hora,
    linhas: producao.linhas.map((l) => {
      const ins = l.insumo_id && ctx.insumos.get(l.insumo_id);
      return ins && ins.ativo
        ? { ...l, nome: ins.nome, unidade: unidadeNaVenda(ins.unidade), custo_unidade: custoNaUnidadeDaVenda(ins) }
        : l;
    }),
  };
}
