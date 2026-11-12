/**
 * storage.js — Camada de dados do app (modelo, cálculos, persistência, backup).
 *
 * Os dados ficam no localStorage do navegador. Se um dia o app ganhar
 * servidor (Supabase, Firebase...), só este arquivo precisa mudar: o resto
 * do app usa apenas as funções exportadas daqui.
 *
 * MODELO (segue o documento do projeto, com nomes em snake_case para casar
 * com as futuras tabelas do banco):
 *
 *   Venda  { id, numero, data_venda, cliente_id, cliente_nome, status,
 *            forma_pagamento, canal, itens[], subtotal, desconto, frete_cobrado,
 *            total, data_entrega_prevista, data_entrega, observacoes, exemplo,
 *            criado_em, atualizado_em, excluido_em }
 *   Item   { id, descricao, tipo, quantidade, preco_unitario,
 *            custo_unitario (null = não informado), producao | null }
 *   producao { linhas: [{ insumo_id, nome, categoria, unidade, modo ('por_peca'|'por_linha'),
 *                         quantidade, custo_unidade, quantidade_total, custo_linha }],
 *              horas_unit, custo_hora, custo_extra, custo_maquina, custo_total_item,
 *              cor, link_modelo, nota_legado }
 *   Insumo { id, nome, categoria, tipo, cor, marca, unidade, preco_pago (0 = sem preço),
 *            quantidade_comprada, ajuste_saldo, custo_unidade (null = sem preço), ativo,
 *            exemplo, criado_em, atualizado_em, excluido_em }
 *
 * SALDO (estoque) de um insumo — sempre CALCULADO, nunca guardado:
 *   quantidade comprada + ajustes − consumo das vendas ativas
 *   (vendas pendentes ou pagas, não excluídas; orçamento e cancelada não baixam).
 * Assim, cancelar, excluir, editar ou desfazer uma venda devolve/rebaixa o
 * estoque automaticamente e sem erro acumulado. O saldo pode ficar negativo.
 *   Cliente{ id, nome, whatsapp (E.164), criado_em, atualizado_em, excluido_em }
 *   config { custo_hora_maquina (padrão R$ 1,50/h = 150 centavos; markup_pct null até o usuário definir) }
 *
 * `status` é a situação de pagamento (orcamento, pendente, pago, cancelado).
 * A ENTREGA é separada: `data_entrega` preenchida = entregue.
 *
 * CUSTO DE PRODUÇÃO do item = linhas "por peça" (× qtd do item) + linhas
 *   "por linha" (uma vez) + qtd do item × horas × R$/hora. A quantidade usada
 *   no custo é a mesma baixada do saldo. Unidades: só g↔kg convertem (filamento
 *   é sempre digitado em gramas na venda); ml nunca vira g.
 * Cada linha guarda uma CÓPIA (snapshot) do nome e do custo por unidade do
 * insumo, e o item guarda o R$/hora usado: se os preços mudarem depois, as
 * vendas antigas continuam com o custo original. Preço que falta NUNCA vira
 * R$ 0: o formulário pede o valor.
 * Lucro, margem e taxas ainda NÃO são calculados, de propósito: as regras
 * definitivas estão sendo revisadas no documento do projeto. Aqui é só custo.
 *
 * DINHEIRO: todos os valores (preço, custo, desconto, frete, total) são
 * guardados em CENTAVOS inteiros. Ex.: R$ 25,90 => 2590.
 *
 * EXCLUSÃO SUAVE: excluir só preenche `excluido_em`. A venda some das telas,
 * mas continua no backup (necessário para sincronizar no futuro). Registros
 * excluídos há mais de 30 dias são apagados de vez ao abrir o app.
 */
import {
  gerarId, hojeISO, somarDias, formatarNumeroBR, normalizarTexto, normalizarWhatsApp,
  PAGAMENTOS, STATUS, TIPOS, CANAIS, MATERIAIS_3D, CATEGORIAS_INSUMO, UNIDADES, STATUS_FATURADOS,
} from './utils.js';

/** Versão do formato dos dados. Aumente ao mudar a estrutura e escreva a migração. */
export const SCHEMA_VERSION = 3; // v3: insumos, configurações e custo de produção nos itens

/** Padrão de R$/hora de máquina, em centavos (R$ 1,50). Usuários sem valor definido recebem este ao abrir. */
export const CUSTO_HORA_MAQUINA_PADRAO = 150;

const CHAVE = 'appVendas.dados';
const CHAVE_V1 = 'appVendas.vendas.v1'; // formato antigo (lista simples de vendas)
const DIAS_LIXEIRA = 30;

/** Banco em memória: { schema_version, proximo_numero, vendas[], clientes[] }. */
let banco = null;
/** Último JSON gravado/lido com sucesso: usado para desfazer a mudança se a gravação falhar. */
let ultimoGravado = null;
/**
 * Dados salvos ilegíveis (JSON quebrado). Enquanto não for resolvido (restaurar
 * backup ou apagar tudo), NADA é gravado, para não sobrescrever o original.
 * { chave_copia, bruto, erro } ou null.
 */
let corrompido = null;
const PREFIXO_CORROMPIDO = `${CHAVE}.corrompido-`;

/* ------------------------------------------------------------------ */
/* Lucro (Revisão 4)                                                   */
/*   lucro_venda = total − custo_total − taxas − frete_custo            */
/*   Qualquer entrada faltando => lucro null ("sem preço"), nunca 0.     */
/* ------------------------------------------------------------------ */

/** Custo total de um item: produção calculada, ou custo unit. × qtd; null = não informado. */
export function custoTotalItem(i) {
  const p = i.producao;
  if (p && (p.linhas?.length || p.horas_unit || p.custo_extra)) return p.custo_total_item ?? null;
  return i.custo_unitario != null ? Math.round(i.custo_unitario * (Number(i.quantidade) || 0)) : null;
}

/**
 * Lucro de uma venda. A taxa fica no PAGAMENTO (taxa_pagamento), não no item.
 * - taxa em branco: R$ 0 em qualquer forma de pagamento.
 * - custo do frete em branco: R$ 0 só se não houve frete cobrado.
 */
export function calcularLucro(v) {
  const faltando = [];
  let custo_total = 0;
  for (const i of v.itens || []) {
    const c = i._custo_total !== undefined ? i._custo_total : custoTotalItem(i); // _custo_total: valor ao vivo do formulário
    if (c == null) { faltando.push(`custo de "${i.descricao || 'item'}"`); custo_total = null; } else if (custo_total != null) custo_total += c;
  }
  const taxas = v.taxa_pagamento ?? 0; // em branco = R$ 0 (Pix, dinheiro, cartão ou outro)

  let frete_custo = v.frete_custo ?? null;
  if (frete_custo == null) {
    if (!(Number(v.frete_cobrado) > 0)) frete_custo = 0;
    else faltando.push('custo do frete');
  }
  const total = v.total ?? calcularVenda(v).total;
  const lucro = faltando.length ? null : total - custo_total - taxas - frete_custo;
  return { total, custo_total, taxas, frete_custo, lucro, faltando };
}

/** Preço sugerido = custo × (1 + markup%). null se faltar custo ou markup (sem padrão). */
export function precoSugerido(custo, markupPct) {
  if (custo == null || !(Number(markupPct) > 0)) return null;
  return Math.round(custo * (1 + Number(markupPct) / 100));
}

/* ------------------------------------------------------------------ */
/* Cálculos (funções puras, também usadas pelo formulário ao vivo)     */
/* ------------------------------------------------------------------ */

/** Arredonda para 4 casas (custos por unidade podem ser frações de centavo). */
const r4 = (n) => Math.round(n * 10000) / 10000;

/**
 * Custo por unidade de um insumo, em centavos (pode ter fração).
 * Ex.: rolo de 1.000 g por R$ 102,50 => 10,25 centavos por grama.
 * null se faltar preço ou quantidade (nunca R$ 0).
 */
export function calcularCustoUnidade(precoPago, quantidadeComprada) {
  const p = Number(precoPago);
  const q = Number(quantidadeComprada);
  if (!(p > 0) || !(q > 0)) return null;
  return r4(p / q);
}

/** R$/kg (centavos) de um insumo comprado em g ou kg; null para outras unidades. */
export function precoPorKg(insumo) {
  if (insumo?.custo_unidade == null) return null;
  if (insumo.unidade === 'g') return Math.round(insumo.custo_unidade * 1000);
  if (insumo.unidade === 'kg') return Math.round(insumo.custo_unidade);
  return null;
}

/**
 * Converte uma quantidade da unidade da LINHA para a unidade do INSUMO.
 * Só existe conversão entre g e kg (fator 1000). ml nunca vira g, metro nunca vira unidade.
 * Retorna null se as unidades forem incompatíveis.
 */
export function converterUnidade(quantidade, de, para) {
  if (de === para) return quantidade;
  if (de === 'g' && para === 'kg') return quantidade / 1000;
  if (de === 'kg' && para === 'g') return quantidade * 1000;
  return null;
}

/** Unidade usada NA VENDA para um insumo: g/kg são sempre digitados em gramas. */
export function unidadeNaVenda(unidadeInsumo) {
  return unidadeInsumo === 'kg' ? 'g' : unidadeInsumo;
}

/** Custo por unidade da venda (centavos, com fração): converte R$/kg em R$/g quando preciso. */
export function custoNaUnidadeDaVenda(insumo) {
  if (insumo?.custo_unidade == null) return null; // sem preço: nunca R$ 0
  return insumo.unidade === 'kg' ? r4(insumo.custo_unidade / 1000) : insumo.custo_unidade;
}

/** Quantidade TOTAL consumida por uma linha: por peça = qtd do item × qtd; por linha = qtd uma vez. */
export function quantidadeTotalLinha(linha, qtdItem) {
  const q = Number(linha.quantidade);
  if (!(q > 0)) return null;
  return linha.modo === 'por_linha' ? q : q * (Number(qtdItem) || 0);
}

/**
 * Custo de produção do ITEM INTEIRO (todas as unidades), em centavos:
 *   linhas "por peça":  qtd do item × qtd do insumo × custo por unidade
 *   linhas "por linha": qtd do insumo × custo por unidade (uma vez só)
 *   máquina:            qtd do item × horas por unidade × R$/hora
 *   extra:              custo extra da linha (pintura, frete do insumo...) uma vez
 * => custo_linha = qtd × (Σ insumos por peça + horas × R$/h) + Σ insumos por linha + extra
 * Usa EXATAMENTE a mesma quantidade que é baixada do saldo (quantidadeTotalLinha).
 * Se faltar algo (preço de uma linha = "sem preço", R$/hora com horas preenchidas),
 * o total fica null e `faltando` diz o quê — nunca usamos R$ 0 no lugar.
 */
export function calcularProducao(p, qtdItem = 1) {
  const faltando = [];
  const linhas = (p?.linhas || []).map((l) => {
    const total = quantidadeTotalLinha(l, qtdItem);
    const cu = l.custo_unidade == null || l.custo_unidade === '' ? null : Number(l.custo_unidade);
    let custo_linha = null;
    if (total == null) faltando.push(`quantidade de "${l.nome || 'insumo'}"`);
    else if (cu === null || !(cu >= 0)) faltando.push(`"${l.nome || 'insumo'}" está sem preço`);
    else custo_linha = Math.round(total * cu);
    return { ...l, quantidade_total: total, custo_linha };
  });
  const horas = Number(p?.horas_unit) || 0;
  let custo_maquina = null;
  if (horas > 0) {
    if (Number(p.custo_hora) > 0) custo_maquina = Math.round((Number(qtdItem) || 0) * horas * Number(p.custo_hora));
    else faltando.push('R$ por hora de máquina');
  }
  const extra = Math.max(0, Math.round(Number(p?.custo_extra) || 0));
  const temAlgo = linhas.length > 0 || horas > 0 || extra > 0;
  const custo_total_item = !temAlgo || faltando.length
    ? null
    : linhas.reduce((t, l) => t + l.custo_linha, 0) + (custo_maquina || 0) + extra;
  return { linhas, custo_maquina, custo_extra: extra, custo_total_item, faltando };
}

/**
 * Converte um custo unitário digitado à mão numa linha de insumo
 * "Outro (informar preço)", por peça, com quantidade 1.
 * Sem preço (null/0) continua "sem preço" — nunca vira R$ 0.
 */
export const NOME_CUSTO_INFORMADO = 'Custo informado';
export function linhaDeCustoManual(custoUnitarioCentavos, nome = NOME_CUSTO_INFORMADO) {
  const cu = custoUnitarioCentavos == null || custoUnitarioCentavos === '' ? null : Number(custoUnitarioCentavos);
  return {
    insumo_id: null,
    nome,
    categoria: 'outro',
    unidade: 'un',
    modo: 'por_peca',
    quantidade: 1,
    custo_unidade: Number.isFinite(cu) && cu > 0 ? cu : null,
  };
}

/** Total de uma linha (quantidade × preço). */
export function totalItem(item) {
  return Math.round((Number(item.quantidade) || 0) * (Number(item.preco_unitario) || 0));
}

/** Calcula subtotal e total de uma venda a partir dos itens (total = itens − desconto + frete). */
export function calcularVenda(v) {
  const itens = v.itens || [];
  const subtotal = itens.reduce((t, i) => t + totalItem(i), 0);
  const desconto = Math.max(0, Math.round(Number(v.desconto) || 0));
  const frete_cobrado = Math.max(0, Math.round(Number(v.frete_cobrado) || 0));
  const total = Math.max(0, subtotal - desconto + frete_cobrado);
  return { subtotal, desconto, frete_cobrado, total };
}

/* ------------------------------------------------------------------ */
/* Leitura, gravação e migração                                        */
/* ------------------------------------------------------------------ */

function bancoVazio() {
  return {
    schema_version: SCHEMA_VERSION, proximo_numero: 1, vendas: [], clientes: [], insumos: [],
    config: { custo_hora_maquina: CUSTO_HORA_MAQUINA_PADRAO, markup_pct: null },
  };
}

/** Carrega o banco do localStorage (uma vez), migrando o formato antigo se existir. */
function carregar() {
  if (banco) return banco;
  let migrouV1 = false;
  let persistirPadraoHora = false;
  try {
    const bruto = localStorage.getItem(CHAVE);
    if (bruto) {
      const parseado = JSON.parse(bruto);
      persistirPadraoHora = !(Number(parseado?.config?.custo_hora_maquina) > 0);
      banco = migrarBanco(parseado);
    } else if (localStorage.getItem(CHAVE_V1)) {
      // Primeira abertura depois da atualização: converte os dados da v1.
      banco = migrarBanco(JSON.parse(localStorage.getItem(CHAVE_V1)));
      migrouV1 = true;
    } else {
      banco = bancoVazio();
    }
  } catch (erro) {
    registrarCorrupcao(erro);
    banco = bancoVazio();
  }
  ultimoGravado = JSON.stringify(banco);
  if (migrouV1 || persistirPadraoHora) {
    try {
      salvar();
      if (migrouV1) localStorage.removeItem(CHAVE_V1);
    } catch { /* sem espaço: tenta na próxima abertura */ }
  }
  if (!corrompido) limparLixeiraAntiga();
  return banco;
}

/**
 * JSON salvo ilegível: guarda uma CÓPIA do texto original numa chave à parte
 * (appVendas.dados.corrompido-<data ISO>) e bloqueia gravações. A chave
 * original NÃO é tocada.
 */
function registrarCorrupcao(erro) {
  const bruto = localStorage.getItem(CHAVE) ?? localStorage.getItem(CHAVE_V1) ?? '';
  // Já existe cópia idêntica (recarregou a página)? Reaproveita, não duplica.
  let chave = listarCopiasCorrompidas().find((k) => localStorage.getItem(k) === bruto) || null;
  if (!chave) {
    chave = PREFIXO_CORROMPIDO + new Date().toISOString();
    try { localStorage.setItem(chave, bruto); } catch { chave = null; } // sem espaço: o original continua intacto
  }
  corrompido = { chave_copia: chave, bruto, erro: String(erro?.message || erro) };
  console.warn('Dados salvos ilegíveis: gravação bloqueada até restaurar um backup.', erro);
}

/** Chaves das cópias de dados corrompidos guardadas neste aparelho (appVendas.dados.corrompido-*). */
export function listarCopiasCorrompidas() {
  const chaves = [];
  for (let i = 0; i < localStorage.length; i++) {
    const k = localStorage.key(i);
    if (k && k.startsWith(PREFIXO_CORROMPIDO)) chaves.push(k);
  }
  return chaves.sort();
}

/**
 * Apaga as cópias antigas de dados corrompidos. Recusa enquanto a gravação
 * estiver bloqueada (a cópia ainda pode ser a única forma de recuperar).
 * Devolve quantas apagou.
 */
export function apagarCopiasCorrompidas() {
  carregar();
  if (corrompido) throw new Error('Restaure um backup antes: enquanto os dados estiverem corrompidos, a cópia é mantida.');
  const chaves = listarCopiasCorrompidas();
  chaves.forEach((k) => localStorage.removeItem(k));
  return chaves.length;
}

/** Estado da corrupção para a interface: { chave_copia, bruto, erro, tamanho } ou null. */
export function estadoCorrupcao() {
  carregar();
  return corrompido ? { ...corrompido, tamanho: corrompido.bruto.length } : null;
}

/**
 * Grava no localStorage. Se falhar (ex.: QuotaExceededError), DESFAZ a mudança
 * em memória (volta ao último estado gravado) e lança um erro amigável:
 * assim não aparece venda "fantasma" nem duplicada.
 */
function salvar() {
  if (corrompido) {
    banco = JSON.parse(ultimoGravado);
    throw new Error('Gravação bloqueada: os dados salvos estão corrompidos. Restaure um backup (ou baixe os dados originais) antes de continuar.');
  }
  let texto;
  try {
    texto = JSON.stringify(banco);
    localStorage.setItem(CHAVE, texto);
  } catch (erro) {
    banco = ultimoGravado ? JSON.parse(ultimoGravado) : bancoVazio();
    const cheio = erro?.name === 'QuotaExceededError' || /quota/i.test(String(erro?.message));
    throw new Error(cheio
      ? 'Não foi possível salvar: o armazenamento do navegador está cheio. Nada foi alterado. Faça um backup e libere espaço.'
      : 'Não foi possível salvar: o armazenamento do navegador está bloqueado. Nada foi alterado.');
  }
  ultimoGravado = texto;
}

/**
 * Converte qualquer formato conhecido para o atual:
 *  - v1: lista simples de vendas com { produto, quantidade, valorUnitario, ... }
 *  - backup v1: { versao: 1, vendas: [...] }
 *  - v2: { schema_version: 2, vendas, clientes }
 */
function migrarBanco(dados) {
  const novo = bancoVazio();
  const versao = Array.isArray(dados) ? 1 : Number(dados?.schema_version ?? dados?.versao ?? 1);
  if (versao > SCHEMA_VERSION) {
    throw new Error('Este backup foi feito por uma versão mais nova do app. Atualize o app antes de restaurar.');
  }
  const listaVendas = Array.isArray(dados) ? dados : Array.isArray(dados?.vendas) ? dados.vendas : null;
  if (!listaVendas) throw new Error('Arquivo inválido: não encontrei a lista de vendas.');

  // Clientes primeiro (na v1 eles não existem; são criados a partir do nome).
  if (Array.isArray(dados?.clientes)) {
    novo.clientes = dados.clientes.map(normalizarCliente).filter(Boolean);
  }
  // Insumos e configurações só existem a partir da v3; nas versões antigas começam vazios.
  if (Array.isArray(dados?.insumos)) {
    novo.insumos = dados.insumos.map(normalizarInsumo).filter(Boolean);
  }
  novo.config = normalizarConfig(dados?.config);
  for (const bruta of listaVendas) {
    const v = versao === 1 ? migrarVendaV1(bruta) : bruta;
    const venda = normalizarVenda(v);
    if (!venda) continue;
    if (!venda.cliente_id && venda.cliente_nome) {
      venda.cliente_id = obterOuCriarClienteEm(novo, venda.cliente_nome, '').id;
    }
    novo.vendas.push(venda);
  }
  const maiorNumero = novo.vendas.reduce((m, v) => Math.max(m, v.numero || 0), 0);
  // Vendas sem número (vindas da v1) recebem números em ordem cronológica.
  let n = maiorNumero;
  [...novo.vendas]
    .sort((a, b) => a.data_venda.localeCompare(b.data_venda) || a.criado_em.localeCompare(b.criado_em))
    .forEach((v) => { if (!v.numero) v.numero = ++n; });
  novo.proximo_numero = Math.max(Number(dados?.proximo_numero) || 1, n + 1);
  return novo;
}

/** Converte uma venda do formato v1 (um produto por venda) para o v2 (lista de itens). */
function migrarVendaV1(v) {
  if (!v || typeof v !== 'object') return null;
  const quantidade = Number(v.quantidade) > 0 ? Number(v.quantidade) : 1;
  const unitario = Math.round(Number(v.valorUnitario) || 0);
  const subtotal = Math.round(quantidade * unitario);
  const total = Number.isFinite(Number(v.valorTotal)) ? Math.round(Number(v.valorTotal)) : subtotal;
  return {
    id: v.id,
    data_venda: v.data,
    cliente_nome: v.cliente,
    status: v.status === 'pendente' ? 'pendente' : 'pago',
    forma_pagamento: v.pagamento,
    itens: [{ descricao: v.produto, tipo: 'fisico', quantidade, preco_unitario: unitario, custo_unitario: 0 }],
    // Na v1 o total podia ser editado à mão: a diferença vira desconto (ou frete, se for maior).
    desconto: Math.max(0, subtotal - total),
    frete_cobrado: Math.max(0, total - subtotal),
    observacoes: v.observacoes,
    exemplo: v.exemplo,
    criado_em: v.criadoEm,
    atualizado_em: v.atualizadoEm,
  };
}

const texto = (s, max) => String(s ?? '').trim().slice(0, max);
const centavos = (n) => Math.max(0, Math.round(Number(n) || 0));
const centavosOuNulo = (n) => (n === null || n === undefined || n === '' || !Number.isFinite(Number(n)) || Number(n) < 0
  ? null : Math.round(Number(n)));
const dataOuNulo = (d) => (/^\d{4}-\d{2}-\d{2}$/.test(d || '') ? d : null);

/** Garante que um item tem todos os campos no formato certo. */
function normalizarItem(i) {
  if (!i || !texto(i.descricao, 120)) return null;
  const tipo = i.tipo in TIPOS ? i.tipo : 'fisico';
  let custo_unitario = centavosOuNulo(i.custo_unitario);
  const quantidade = Number(i.quantidade) > 0 ? Number(i.quantidade) : 1;
  let producao = null;
  if (i.producao) {
    producao = normalizarProducao(i.producao, quantidade);
  } else if (i.dados_3d && tipo === 'impressao_3d') {
    // v2: dados 3D soltos (material em texto, gramas, horas) sem preço conhecido.
    // Não dá para inventar o custo: guardamos como anotação e mantemos o custo digitado.
    const d = i.dados_3d;
    const partes = [d.material, d.gramas ? `${d.gramas} g` : '', d.horas_impressao ? `${d.horas_impressao} h` : ''].filter(Boolean);
    producao = normalizarProducao({
      linhas: [], horas_unit: null, cor: d.cor, link_modelo: d.link_modelo,
      nota_legado: partes.length ? `Dados antigos: ${partes.join(', ')}` : '',
    }, quantidade);
  }
  // Custo unitário informado = custo do item inteiro ÷ quantidade.
  if (producao?.custo_total_item != null) custo_unitario = Math.round(producao.custo_total_item / quantidade);
  else if (producao && (producao.linhas.length || producao.horas_unit || producao.custo_extra)) custo_unitario = null; // falta dado: não inventamos
  return {
    id: String(i.id || gerarId()),
    descricao: texto(i.descricao, 120),
    tipo,
    quantidade,
    preco_unitario: centavos(i.preco_unitario),
    custo_unitario, // null = não informado (nunca assumimos R$ 0)
    producao,
  };
}

/** Normaliza o bloco de custo de produção de um item e recalcula a partir dos SNAPSHOTS. */
function normalizarProducao(p, qtdItem) {
  const positivoOuNulo = (x) => (Number(x) > 0 ? Number(x) : null);
  const base = {
    linhas: (Array.isArray(p.linhas) ? p.linhas : []).map((l) => ({
      insumo_id: l.insumo_id ? String(l.insumo_id) : null,
      nome: texto(l.nome, 80),
      categoria: l.categoria in CATEGORIAS_INSUMO ? l.categoria : 'outro',
      unidade: l.unidade in UNIDADES ? l.unidade : 'un', // unidade da LINHA (g para filamento)
      modo: l.modo === 'por_linha' ? 'por_linha' : 'por_peca',
      quantidade: positivoOuNulo(l.quantidade),
      custo_unidade: l.custo_unidade == null || l.custo_unidade === '' || !(Number(l.custo_unidade) >= 0)
        ? null : r4(Number(l.custo_unidade)), // snapshot do custo por unidade
    })).filter((l) => l.nome || l.insumo_id),
    horas_unit: positivoOuNulo(p.horas_unit),
    custo_hora: positivoOuNulo(p.custo_hora) == null ? null : Math.round(Number(p.custo_hora)), // snapshot do R$/hora
    custo_extra: positivoOuNulo(p.custo_extra) == null ? 0 : Math.round(Number(p.custo_extra)), // uma vez por linha
    cor: texto(p.cor, 40),
    link_modelo: texto(p.link_modelo, 500),
    nota_legado: texto(p.nota_legado, 200),
  };
  const calc = calcularProducao(base, qtdItem);
  return {
    ...base,
    linhas: calc.linhas,
    custo_maquina: calc.custo_maquina,
    custo_total_item: calc.custo_total_item,
  };
}

/** Garante que uma venda tem todos os campos e recalcula os totais. */
function normalizarVenda(v) {
  if (!v || typeof v !== 'object') return null;
  const itens = (Array.isArray(v.itens) ? v.itens : []).map(normalizarItem).filter(Boolean);
  if (!itens.length) return null;
  const agora = new Date().toISOString();
  const base = {
    id: String(v.id || gerarId()),
    numero: Number.isInteger(v.numero) && v.numero > 0 ? v.numero : 0,
    data_venda: dataOuNulo(v.data_venda) || hojeISO(),
    cliente_id: v.cliente_id ? String(v.cliente_id) : null,
    cliente_nome: texto(v.cliente_nome, 120), // cópia do nome no momento da venda
    // Formato antigo tinha status "entregue": vira "pago" + data de entrega.
    status: v.status === 'entregue' ? 'pago' : v.status in STATUS ? v.status : 'pago',
    forma_pagamento: v.forma_pagamento in PAGAMENTOS ? v.forma_pagamento : 'outro',
    canal: v.canal in CANAIS ? v.canal : '',
    itens,
    desconto: centavos(v.desconto),
    frete_cobrado: centavos(v.frete_cobrado),
    taxa_pagamento: centavosOuNulo(v.taxa_pagamento), // taxa do pagamento (maquininha etc.); null = não informada
    frete_custo: centavosOuNulo(v.frete_custo), // quanto o frete custou para você; null = não informado
    data_entrega_prevista: dataOuNulo(v.data_entrega_prevista),
    data_entrega: dataOuNulo(v.data_entrega) || (v.status === 'entregue' ? dataOuNulo(v.data_venda) || hojeISO() : null),
    observacoes: texto(v.observacoes, 1000),
    exemplo: Boolean(v.exemplo), // marca os dados de demonstração
    criado_em: v.criado_em || agora,
    atualizado_em: v.atualizado_em || v.criado_em || agora,
    excluido_em: v.excluido_em || null,
  };
  return { ...base, ...calcularVenda(base) };
}

function normalizarInsumo(m) {
  if (!m || typeof m !== 'object') return null;
  const categoria = m.categoria in CATEGORIAS_INSUMO ? m.categoria : 'outro';
  const tipo = MATERIAIS_3D.includes(m.tipo) ? m.tipo : '';
  const cor = texto(m.cor, 40);
  const marca = texto(m.marca, 60);
  const nome = texto(m.nome, 80) || [tipo || CATEGORIAS_INSUMO[categoria], cor, marca].filter(Boolean).join(' ');
  const preco_pago = centavos(m.preco_pago);
  const quantidade_comprada = Math.max(0, Number(m.quantidade_comprada) || 0);
  const agora = new Date().toISOString();
  return {
    id: String(m.id || gerarId()),
    nome, categoria, tipo, cor, marca,
    unidade: m.unidade in UNIDADES ? m.unidade : 'un',
    preco_pago, quantidade_comprada,
    ajuste_saldo: Number.isFinite(Number(m.ajuste_saldo)) ? Number(m.ajuste_saldo) : 0, // compras extras/correções
    custo_unidade: calcularCustoUnidade(preco_pago, quantidade_comprada), // null = sem preço
    ativo: m.ativo !== false,
    exemplo: Boolean(m.exemplo),
    criado_em: m.criado_em || agora,
    atualizado_em: m.atualizado_em || m.criado_em || agora,
    excluido_em: m.excluido_em || null,
  };
}

function normalizarConfig(c) {
  const hora = Number(c?.custo_hora_maquina);
  const markup = Number(c?.markup_pct);
  return {
    custo_hora_maquina: hora > 0 ? Math.round(hora) : CUSTO_HORA_MAQUINA_PADRAO,
    markup_pct: markup > 0 ? Math.round(markup * 100) / 100 : null, // markup continua sem valor padrão
  };
}

function normalizarCliente(c) {
  if (!c || !texto(c.nome, 120)) return null;
  const agora = new Date().toISOString();
  return {
    id: String(c.id || gerarId()),
    nome: texto(c.nome, 120),
    whatsapp: normalizarWhatsApp(c.whatsapp), // E.164: +5511912345678
    criado_em: c.criado_em || agora,
    atualizado_em: c.atualizado_em || c.criado_em || agora,
    excluido_em: c.excluido_em || null,
  };
}

/** Apaga de vez o que está na lixeira há mais de 30 dias. */
function limparLixeiraAntiga() {
  const limite = new Date(Date.now() - DIAS_LIXEIRA * 864e5).toISOString();
  const antes = banco.vendas.length;
  banco.vendas = banco.vendas.filter((v) => !v.excluido_em || v.excluido_em > limite);
  if (banco.vendas.length !== antes) {
    try { salvar(); } catch { /* sem espaço: tenta de novo na próxima gravação */ }
  }
}

/* ------------------------------------------------------------------ */
/* Clientes                                                            */
/* ------------------------------------------------------------------ */

/** Procura cliente pelo nome (sem diferenciar acentos/maiúsculas) ou cria um novo. */
function obterOuCriarClienteEm(db, nome, whatsapp) {
  const chave = normalizarTexto(nome);
  let c = db.clientes.find((x) => !x.excluido_em && normalizarTexto(x.nome) === chave);
  if (!c) {
    c = normalizarCliente({ nome, whatsapp });
    db.clientes.push(c);
  } else if (whatsapp && normalizarWhatsApp(whatsapp) !== c.whatsapp) {
    c.whatsapp = normalizarWhatsApp(whatsapp);
    c.atualizado_em = new Date().toISOString();
  }
  return c;
}

/** Lista de clientes ativos (para autocompletar). */
export function listarClientes() {
  return carregar().clientes.filter((c) => !c.excluido_em);
}

export function obterCliente(id) {
  return carregar().clientes.find((c) => c.id === id) || null;
}

/* ------------------------------------------------------------------ */
/* Insumos (filamento, resina, cola, LED, parafusos, embalagem...)     */
/* ------------------------------------------------------------------ */

/** Lista insumos. Por padrão só os ATIVOS (os que aparecem para escolher na venda). */
export function listarInsumos({ incluirInativos = false } = {}) {
  return carregar().insumos
    .filter((m) => !m.excluido_em && (incluirInativos || m.ativo))
    .sort((a, b) => Number(b.ativo) - Number(a.ativo) || a.nome.localeCompare(b.nome, 'pt-BR'));
}

export function obterInsumo(id) {
  return carregar().insumos.find((m) => m.id === id) || null;
}

/** Cria (sem id) ou atualiza (com id) um insumo. Quantidade é obrigatória; preço pode ficar vazio ("sem preço"). */
export function salvarInsumo(dados, id = null) {
  const db = carregar();
  const agora = new Date().toISOString();
  const i = id ? db.insumos.findIndex((m) => m.id === id) : -1;
  if (id && i === -1) throw new Error('Insumo não encontrado.');
  const final = { ...(i >= 0 ? db.insumos[i] : {}), ...dados };
  // Troca de unidade de um insumo JÁ USADO em vendas: só g ↔ kg (convertendo
  // quantidade_comprada e ajuste_saldo). Qualquer outra troca estragaria o saldo.
  if (i >= 0 && dados.unidade && dados.unidade !== db.insumos[i].unidade) {
    const atual = db.insumos[i];
    const uso = contarUsoInsumo(id);
    if (uso > 0) {
      const fator = fatorGKg(atual.unidade, dados.unidade);
      if (fator == null) {
        throw new Error(`"${atual.nome}" já foi usado em ${uso} ${uso === 1 ? 'venda' : 'vendas'}: a unidade não pode mudar de ${UNIDADES[atual.unidade]} para ${UNIDADES[dados.unidade]} (o saldo ficaria errado). Só dá para trocar entre g e kg. Para outra unidade, cadastre um insumo novo.`);
      }
      // Valores que não vieram em `dados` são convertidos; os que vieram já estão na unidade nova.
      if (dados.quantidade_comprada === undefined) final.quantidade_comprada = r4(atual.quantidade_comprada * fator);
      if (dados.ajuste_saldo === undefined) final.ajuste_saldo = r4((atual.ajuste_saldo || 0) * fator);
    }
  }
  if (!(Number(final.quantidade_comprada) > 0)) throw new Error('Informe a quantidade comprada.');
  if (id) {
    db.insumos[i] = normalizarInsumo({ ...final, id, atualizado_em: agora });
    salvar();
    return db.insumos[i];
  }
  const m = normalizarInsumo({ ...dados, id: gerarId(), ativo: true, criado_em: agora, atualizado_em: agora });
  db.insumos.push(m);
  salvar();
  return m;
}

/** Ativa/desativa (exclusão suave): inativo some da escolha na venda, mas fica no histórico. */
export function definirInsumoAtivo(id, ativo) {
  const m = obterInsumo(id);
  if (!m) throw new Error('Insumo não encontrado.');
  m.ativo = Boolean(ativo);
  m.atualizado_em = new Date().toISOString();
  salvar();
  return m;
}

/** Uma venda baixa estoque? Só pendente/paga e não excluída. */
export function vendaBaixaEstoque(v) {
  return !v.excluido_em && STATUS_FATURADOS.includes(v.status);
}

/**
 * Consumo por insumo (na unidade do INSUMO) de uma lista de vendas.
 * Retorna Map(insumo_id => quantidade). Linhas com unidade incompatível são ignoradas
 * e contadas em `incompativeis` (não deveria acontecer: a tela só gera g↔kg).
 */
export function consumoDasVendas(vendas) {
  const db = carregar();
  const porId = new Map(db.insumos.map((m) => [m.id, m]));
  const consumo = new Map();
  for (const v of vendas) {
    if (!vendaBaixaEstoque(v)) continue;
    for (const item of v.itens) {
      for (const l of item.producao?.linhas || []) {
        const ins = l.insumo_id && porId.get(l.insumo_id);
        if (!ins) continue;
        const total = quantidadeTotalLinha(l, item.quantidade);
        const convertido = total == null ? null : converterUnidade(total, l.unidade, ins.unidade);
        if (convertido == null) continue;
        consumo.set(ins.id, (consumo.get(ins.id) || 0) + convertido);
      }
    }
  }
  return consumo;
}

/**
 * Saldos de todos os insumos. Opcional: simular uma venda (nova ou editada)
 * para saber como ficaria o estoque antes de salvar.
 *   calcularSaldos({ simular: { id, ...dados } })
 */
export function calcularSaldos({ simular = null } = {}) {
  const db = carregar();
  let vendas = db.vendas.filter((v) => !v.excluido_em);
  if (simular) {
    vendas = vendas.filter((v) => v.id !== simular.id);
    const n = normalizarVenda({ ...simular, id: simular.id || 'simulada' });
    if (n) vendas.push(n);
  }
  const consumo = consumoDasVendas(vendas);
  const saldos = new Map();
  for (const m of db.insumos) {
    saldos.set(m.id, r4(m.quantidade_comprada + (m.ajuste_saldo || 0) - (consumo.get(m.id) || 0)));
  }
  return saldos;
}

/** Insumos que ficariam com saldo negativo se a venda simulada fosse salva (só os que ela usa). */
export function faltasDeEstoque(dadosVenda) {
  const saldos = calcularSaldos({ simular: dadosVenda });
  const usados = new Set(dadosVenda.itens.flatMap((i) => (i.producao?.linhas || []).map((l) => l.insumo_id)).filter(Boolean));
  return [...usados].map((id) => ({ insumo: obterInsumo(id), saldo: saldos.get(id) }))
    .filter((x) => x.insumo && x.saldo < 0);
}

/** Em quantas vendas um insumo aparece (informação na tela de insumos). */
/** Fator para converter quantidades entre g e kg (kg→g = 1000, g→kg = 0,001). null para outras unidades. */
export function fatorGKg(de, para) {
  if (de === 'kg' && para === 'g') return 1000;
  if (de === 'g' && para === 'kg') return 0.001;
  return de === para ? 1 : null;
}

export function contarUsoInsumo(id) {
  return listarVendas().filter((v) => v.itens.some((i) => i.producao?.linhas.some((l) => l.insumo_id === id))).length;
}

/* ------------------------------------------------------------------ */
/* Configurações                                                       */
/* ------------------------------------------------------------------ */

export function obterConfig() {
  return { ...carregar().config };
}

export function salvarConfig(dados) {
  const db = carregar();
  db.config = normalizarConfig({ ...db.config, ...dados });
  salvar();
  return { ...db.config };
}

/* ------------------------------------------------------------------ */
/* Vendas (CRUD)                                                       */
/* ------------------------------------------------------------------ */

/** Vendas ativas (não excluídas). */
export function listarVendas() {
  return carregar().vendas.filter((v) => !v.excluido_em);
}

export function obterVenda(id) {
  return listarVendas().find((v) => v.id === id) || null;
}

/** Liga a venda ao cadastro de clientes (cria o cliente se for novo). */
function vincularCliente(dados) {
  const nome = texto(dados.cliente_nome, 120);
  if (!nome) return { ...dados, cliente_id: null, cliente_nome: '' };
  const c = obterOuCriarClienteEm(carregar(), nome, dados.cliente_whatsapp || '');
  return { ...dados, cliente_id: c.id, cliente_nome: c.nome };
}

/** Cria uma venda nova e devolve o registro salvo. */
export function adicionarVenda(dados) {
  const db = carregar();
  const agora = new Date().toISOString();
  const venda = normalizarVenda({
    ...vincularCliente(dados), id: gerarId(), numero: db.proximo_numero, criado_em: agora, atualizado_em: agora,
  });
  if (!venda) throw new Error('Adicione pelo menos um item.');
  db.proximo_numero += 1;
  db.vendas.push(venda);
  salvar();
  return venda;
}

/** Atualiza uma venda existente (mantém id, número e data de criação). */
export function atualizarVenda(id, dados) {
  const db = carregar();
  const i = db.vendas.findIndex((v) => v.id === id && !v.excluido_em);
  if (i === -1) throw new Error('Venda não encontrada.');
  const atual = db.vendas[i];
  const mesclado = 'cliente_nome' in dados ? vincularCliente({ ...atual, ...dados }) : { ...atual, ...dados };
  const venda = normalizarVenda({
    ...mesclado, id, numero: atual.numero, criado_em: atual.criado_em, atualizado_em: new Date().toISOString(),
  });
  if (!venda) throw new Error('Adicione pelo menos um item.');
  db.vendas[i] = venda;
  salvar();
  return venda;
}

/** Exclusão suave: a venda vai para a "lixeira" (pode ser desfeita). */
export function excluirVenda(id) {
  const v = carregar().vendas.find((x) => x.id === id);
  if (!v) return;
  v.excluido_em = v.atualizado_em = new Date().toISOString();
  salvar();
}

/** Desfaz uma exclusão. */
export function restaurarVenda(id) {
  const v = carregar().vendas.find((x) => x.id === id);
  if (!v) return;
  v.excluido_em = null;
  v.atualizado_em = new Date().toISOString();
  salvar();
}

/** Apaga TUDO deste aparelho (vendas e clientes). */
export function apagarTudo() {
  // Decisão explícita do usuário: resolve a corrupção (a cópia do original continua guardada).
  corrompido = null;
  ultimoGravado = JSON.stringify(bancoVazio());
  banco = bancoVazio();
  salvar();
}

/** Itens já vendidos, com o último preço/tipo/custo usado (para autocompletar rápido). */
export function itensConhecidos() {
  const mapa = new Map();
  const ordenadas = [...listarVendas()].sort((a, b) => a.atualizado_em.localeCompare(b.atualizado_em));
  for (const v of ordenadas) {
    for (const i of v.itens) {
      const chave = normalizarTexto(i.descricao);
      const anterior = mapa.get(chave);
      mapa.set(chave, { ...i, vezes: (anterior?.vezes || 0) + 1 });
    }
  }
  return [...mapa.values()].sort((a, b) => b.vezes - a.vezes);
}

/* ------------------------------------------------------------------ */
/* Backup, restauração e exportação                                    */
/* ------------------------------------------------------------------ */

/** Gera o backup completo em JSON (inclui excluídos, para futura sincronização). */
export function gerarBackupJSON() {
  const db = carregar();
  return JSON.stringify({
    app: 'minhas-vendas',
    schema_version: SCHEMA_VERSION,
    exportado_em: new Date().toISOString(),
    proximo_numero: db.proximo_numero,
    clientes: db.clientes,
    config: db.config,
    insumos: db.insumos,
    vendas: db.vendas,
  }, null, 2);
}

/**
 * Restaura um backup JSON (de qualquer versão conhecida).
 * modo 'substituir' troca tudo; 'mesclar' junta (mesmo id => fica o mais recente).
 * Retorna quantas vendas ativas vieram no arquivo.
 */
export function importarBackupJSON(conteudo, modo = 'substituir') {
  let dados;
  try {
    dados = JSON.parse(conteudo);
  } catch {
    throw new Error('Arquivo inválido: não é um JSON.');
  }
  const importado = migrarBanco(dados); // lança erro se o formato for inválido
  const brutas = Array.isArray(dados) ? dados : dados.vendas;
  if (brutas.length > 0 && importado.vendas.length === 0) throw new Error('Nenhuma venda válida no arquivo.');

  if (modo === 'mesclar') {
    const db = carregar();
    const juntar = (atuais, novos) => {
      const mapa = new Map(atuais.map((x) => [x.id, x]));
      for (const n of novos) {
        const a = mapa.get(n.id);
        if (!a || n.atualizado_em >= a.atualizado_em) mapa.set(n.id, n);
      }
      return [...mapa.values()];
    };
    db.clientes = juntar(db.clientes, importado.clientes);
    db.insumos = juntar(db.insumos, importado.insumos);
    // Configuração: mantém a atual; só usa a do arquivo se aqui ainda não houver.
    if (!db.config?.custo_hora_maquina && importado.config.custo_hora_maquina) db.config = importado.config;
    db.vendas = juntar(db.vendas, importado.vendas);
    // Renumera se houver números repetidos vindos de aparelhos diferentes.
    const usados = new Set();
    let proximo = Math.max(db.proximo_numero, importado.proximo_numero);
    for (const v of db.vendas.sort((a, b) => a.criado_em.localeCompare(b.criado_em))) {
      if (usados.has(v.numero)) v.numero = proximo++;
      usados.add(v.numero);
    }
    db.proximo_numero = proximo;
  } else {
    banco = importado;
  }
  if (corrompido) {
    // Restaurar um backup resolve a corrupção: agora pode gravar por cima.
    // (A cópia do texto original continua na chave appVendas.dados.corrompido-….)
    corrompido = null;
    if (modo === 'mesclar') banco = importado;
  }
  salvar();
  return importado.vendas.filter((v) => !v.excluido_em).length;
}

/**
 * Gera planilha CSV com UMA LINHA POR ITEM (fica fácil somar por produto/tipo).
 * Separador ";" e vírgula decimal: abre certo no Excel/Google Planilhas em pt-BR.
 */
const lucroCSV = (v) => { const l = calcularLucro(v).lucro; return l == null ? 'sem preço' : formatarNumeroBR(l); };

export function gerarCSV(lista = listarVendas()) {
  const cab = ['Número', 'Data', 'Status', 'Cliente', 'Pagamento', 'Canal', 'Item', 'Tipo', 'Quantidade',
    'Preço unitário', 'Total do item', 'Custo unitário (informado)', 'Desconto (venda)', 'Frete (venda)',
    'Total da venda', 'Taxa do pagamento', 'Custo do frete', 'Lucro da venda', 'Entrega prevista', 'Entregue em', 'Insumos usados (total)', 'Horas/un.', 'R$/hora (na venda)', 'Observações'];
  const esc = (s) => {
    let t = String(s ?? '');
    if (/^[=+\-@]/.test(t)) t = "'" + t; // evita "injeção de fórmula" na planilha
    return /[";\n\r]/.test(t) ? `"${t.replace(/"/g, '""')}"` : t;
  };
  const br = (iso) => (iso ? iso.split('-').reverse().join('/') : '');
  const linhas = [];
  const ordenadas = [...lista].sort((a, b) => a.data_venda.localeCompare(b.data_venda) || a.numero - b.numero);
  for (const v of ordenadas) {
    v.itens.forEach((i, n) => {
      const primeira = n === 0; // valores da venda só na 1ª linha, para não somar em dobro
      linhas.push([
        v.numero, br(v.data_venda), STATUS[v.status], v.cliente_nome, PAGAMENTOS[v.forma_pagamento], CANAIS[v.canal],
        i.descricao, TIPOS[i.tipo], String(i.quantidade).replace('.', ','), formatarNumeroBR(i.preco_unitario),
        formatarNumeroBR(totalItem(i)), i.custo_unitario != null ? formatarNumeroBR(i.custo_unitario) : '',
        primeira ? formatarNumeroBR(v.desconto) : '', primeira ? formatarNumeroBR(v.frete_cobrado) : '',
        primeira ? formatarNumeroBR(v.total) : '',
        primeira && v.taxa_pagamento != null ? formatarNumeroBR(v.taxa_pagamento) : '',
        primeira && v.frete_custo != null ? formatarNumeroBR(v.frete_custo) : '',
        primeira ? (lucroCSV(v)) : '',
        br(v.data_entrega_prevista), br(v.data_entrega),
        (i.producao?.linhas || []).map((l) => `${String(l.quantidade_total ?? '').replace('.', ',')} ${UNIDADES[l.unidade]} ${l.nome}${l.modo === 'por_linha' ? ' (por pedido)' : ''}`).join(' + '),
        i.producao?.horas_unit ? String(i.producao.horas_unit).replace('.', ',') : '',
        i.producao?.custo_hora ? formatarNumeroBR(i.producao.custo_hora) : '',
        primeira ? v.observacoes : '',
      ].map(esc).join(';'));
    });
  }
  return '\uFEFF' + [cab.join(';'), ...linhas].join('\r\n'); // BOM: acentos certos no Excel
}

/* ------------------------------------------------------------------ */
/* Dados de exemplo                                                    */
/* ------------------------------------------------------------------ */

/** Insere ~32 vendas fictícias nos últimos 30 dias, marcadas como exemplo. */
export function carregarExemplos() {
  const db = carregar();
  const catalogo = [
    { descricao: 'Suporte de celular', tipo: 'impressao_3d', preco: 2500, custo: 900, d3: { gramas: 45, horas: 2.5 } },
    { descricao: 'Vaso decorativo', tipo: 'impressao_3d', preco: 4500, custo: 2100, d3: { gramas: 120, horas: 6 } },
    { descricao: 'Miniatura sob encomenda', tipo: 'impressao_3d', preco: 8900, custo: 2000, d3: { gramas: 60, horas: 9 } },
    { descricao: 'Chaveiro personalizado', tipo: 'fisico', preco: 1200, custo: 350 },
    { descricao: 'Caixa organizadora', tipo: 'fisico', preco: 3500, custo: 1400 },
    { descricao: 'Modelo 3D (arquivo STL)', tipo: 'modelo_3d', preco: 1990, custo: 0 },
    { descricao: 'Planilha de orçamento', tipo: 'digital', preco: 3700, custo: 0 },
    { descricao: 'Modelagem 3D (hora)', tipo: 'servico', preco: 6000, custo: 0 },
  ];
  const clientes = ['Ana Souza', 'João Pereira', 'Maria Oliveira', 'Carlos Lima', 'Fernanda Rocha', '', 'Pedro Alves'];
  const pagamentos = ['pix', 'pix', 'pix', 'dinheiro', 'cartao', 'outro'];
  const canais = ['whatsapp', 'whatsapp', 'instagram', 'presencial', 'shopee', ''];
  const hoje = hojeISO();
  // Gerador pseudoaleatório com semente fixa: os exemplos são sempre os mesmos.
  let semente = 42;
  const sorteio = () => ((semente = (semente * 16807) % 2147483647) - 1) / 2147483646;
  const escolher = (lista) => lista[Math.floor(sorteio() * lista.length)];
  const base = Date.now() - 40 * 864e5;
  // Insumos de exemplo (marcados como exemplo, removidos junto com as vendas de exemplo).
  const agoraEx = new Date().toISOString();
  const insEx = [
    { nome: 'PLA Preto (exemplo)', categoria: 'filamento', tipo: 'PLA', cor: 'preto', marca: 'Marca X', unidade: 'g', preco_pago: 30750, quantidade_comprada: 3000 },
    { nome: 'PETG Branco (exemplo)', categoria: 'filamento', tipo: 'PETG', cor: 'branco', marca: 'Marca Y', unidade: 'g', preco_pago: 20400, quantidade_comprada: 3000 },
    { nome: 'Fita LED USB (exemplo)', categoria: 'eletronica', unidade: 'm', preco_pago: 2990, quantidade_comprada: 2 },
    { nome: 'Parafuso M3 (exemplo)', categoria: 'fixacao', unidade: 'un', preco_pago: 1500, quantidade_comprada: 100 },
    { nome: 'Caixa kraft P (exemplo)', categoria: 'embalagem', unidade: 'un', preco_pago: 3000, quantidade_comprada: 20 },
  ].map((m) => normalizarInsumo({ ...m, exemplo: true, criado_em: agoraEx }));
  db.insumos.push(...insEx);
  const linhaEx = (ins, q, modo = 'por_peca') => ({
    insumo_id: ins.id, nome: ins.nome, categoria: ins.categoria, unidade: unidadeNaVenda(ins.unidade),
    modo, quantidade: q, custo_unidade: custoNaUnidadeDaVenda(ins),
  });
  let n = 0;
  for (let k = 0; k < 32; k++) {
    const qtdItens = sorteio() < 0.25 ? 2 : 1;
    const itens = [];
    for (let j = 0; j < qtdItens; j++) {
      const p = escolher(catalogo);
      const item = { descricao: p.descricao, tipo: p.tipo, quantidade: 1 + Math.floor(sorteio() * 3), preco_unitario: p.preco };
      item.custo_unitario = p.custo;
      if (p.d3) {
        // Custo de produção de exemplo: filamento + caixa (sem horas, para o custo bater com o catálogo).
        // A caixa é "por linha": uma caixa para o pedido, não uma por peça.
        item.producao = { linhas: [linhaEx(escolher(insEx.slice(0, 2)), p.d3.gramas), linhaEx(insEx[4], 1, 'por_linha')], cor: escolher(['branco', 'preto']) };
      }
      itens.push(item);
    }
    const r = sorteio();
    const status = r < 0.14 ? 'pendente' : r < 0.22 ? 'orcamento' : r < 0.26 ? 'cancelado' : 'pago';
    const entregue = status !== 'orcamento' && status !== 'cancelado' && sorteio() < 0.6;
    const diasAtras = k < 3 ? 0 : Math.floor(sorteio() * 30);
    const data = somarDias(hoje, -diasAtras);
    const criado = new Date(base + k * 3600e3).toISOString();
    const nomeCliente = escolher(clientes);
    const venda = normalizarVenda({
      id: gerarId(), numero: db.proximo_numero + n++, data_venda: data,
      cliente_id: nomeCliente ? obterOuCriarClienteEm(db, nomeCliente, '').id : null, cliente_nome: nomeCliente,
      status, forma_pagamento: escolher(pagamentos), canal: escolher(canais), itens,
      desconto: sorteio() < 0.15 ? 500 : 0, frete_cobrado: sorteio() < 0.15 ? 1500 : 0,
      data_entrega: entregue ? data : null,
      observacoes: 'Dado de exemplo', exemplo: true, criado_em: criado, atualizado_em: criado,
    });
    db.vendas.push(venda);
  }
  db.proximo_numero += n;
  salvar();
  return n;
}

/** Remove de vez apenas as vendas de exemplo (e clientes que ficaram sem vendas). */
export function removerExemplos() {
  const db = carregar();
  const antes = db.vendas.length;
  db.vendas = db.vendas.filter((v) => !v.exemplo);
  db.insumos = db.insumos.filter((m) => !m.exemplo);
  const usados = new Set(db.vendas.map((v) => v.cliente_id));
  db.clientes = db.clientes.filter((c) => usados.has(c.id));
  salvar();
  return antes - db.vendas.length;
}

export function temExemplos() {
  return listarVendas().some((v) => v.exemplo);
}

/* ------------------------------------------------------------------ */
/* Lembrete de backup                                                  */
/* ------------------------------------------------------------------ */

const CHAVE_ULTIMO_BACKUP = 'appVendas.ultimoBackup';
const CHAVE_ADIADO = 'appVendas.lembreteAdiadoAte';

/** Anota que o usuário acabou de baixar um backup. */
export function registrarBackup() {
  try {
    localStorage.setItem(CHAVE_ULTIMO_BACKUP, new Date().toISOString());
    localStorage.removeItem(CHAVE_ADIADO);
  } catch { /* sem espaço: o lembrete só continua aparecendo */ }
}

/** Data (ISO) do último backup, ou null. */
export function ultimoBackup() {
  return localStorage.getItem(CHAVE_ULTIMO_BACKUP);
}

/** "Lembrar depois": esconde o aviso por alguns dias. */
export function adiarLembrete(dias = 2) {
  try { localStorage.setItem(CHAVE_ADIADO, new Date(Date.now() + dias * 864e5).toISOString()); } catch { /* ignora */ }
}

/**
 * Deve mostrar o lembrete? Sim quando há vendas REAIS e faz mais de `dias`
 * desde o último backup (ou, se nunca houve backup, desde a venda mais antiga).
 */
export function precisaLembreteBackup(dias = 7, agora = Date.now(), maxVendas = 20) {
  return motivoLembreteBackup(dias, agora, maxVendas) !== null;
}

/**
 * Por que lembrar do backup? { tipo: 'dias', dias } quando passou do prazo, ou
 * { tipo: 'vendas', vendas } quando há `maxVendas`+ vendas novas desde o último
 * backup. null = não precisa (ou foi adiado com "Depois").
 */
export function motivoLembreteBackup(dias = 7, agora = Date.now(), maxVendas = 20) {
  const reais = listarVendas().filter((v) => !v.exemplo);
  if (!reais.length) return null;
  const adiado = localStorage.getItem(CHAVE_ADIADO);
  if (adiado && new Date(adiado).getTime() > agora) return null;
  const ultimo = ultimoBackup();
  const novas = ultimo ? reais.filter((v) => v.criado_em > ultimo).length : reais.length;
  const referencia = ultimo || reais.reduce((m, v) => (v.criado_em < m ? v.criado_em : m), reais[0].criado_em);
  const passou = Math.floor((agora - new Date(referencia).getTime()) / 864e5);
  if (agora - new Date(referencia).getTime() > dias * 864e5) return { tipo: 'dias', dias: passou, vendas: novas };
  if (novas >= maxVendas) return { tipo: 'vendas', vendas: novas, dias: passou };
  return null;
}

/** Tamanho aproximado ocupado no localStorage (em KB), para a tela Dados. */
export function tamanhoKB() {
  return Math.round(((localStorage.getItem(CHAVE) || '').length * 2) / 1024);
}
