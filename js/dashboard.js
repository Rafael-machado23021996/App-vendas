/**
 * dashboard.js — Cálculo dos indicadores e desenho do gráfico de barras.
 *
 * O gráfico é feito em SVG puro (sem bibliotecas), então funciona offline
 * e fica nítido em qualquer tela.
 */
import { calcularLucro } from './storage.js';
import {
  formatarMoeda, hojeISO, somarDias, diaDaSemanaCurto, formatarDataBR, escaparHTML,
  STATUS_FATURADOS,
} from './utils.js';

/**
 * Calcula os números do painel.
 * Regras:
 *  - Faturamento conta vendas pendentes e pagas (pela data da venda).
 *  - Orçamentos e canceladas NÃO contam.
 *  - "A receber" = soma das vendas com status pendente.
 */
export function calcularResumo(vendas, hoje = hojeISO()) {
  const mesAtual = hoje.slice(0, 7); // "AAAA-MM"
  const faturadas = vendas.filter((v) => STATUS_FATURADOS.includes(v.status));
  const doDia = faturadas.filter((v) => v.data_venda === hoje);
  const doMes = faturadas.filter((v) => v.data_venda.startsWith(mesAtual));
  const soma = (lista) => lista.reduce((t, v) => t + v.total, 0);
  const pendentes = vendas.filter((v) => v.status === 'pendente');
  const orcamentos = vendas.filter((v) => v.status === 'orcamento');
  const aEntregar = faturadas.filter((v) => !v.data_entrega);
  const totalMes = soma(doMes);
  // Lucro do mês: só soma vendas com todas as entradas; as outras são contadas à parte.
  const lucros = doMes.map((v) => calcularLucro(v).lucro);
  const comLucro = lucros.filter((l) => l != null);
  return {
    totalDia: soma(doDia),
    qtdDia: doDia.length,
    totalMes,
    qtdMes: doMes.length,
    ticketMedio: doMes.length ? Math.round(totalMes / doMes.length) : 0,
    totalPendente: soma(pendentes),
    qtdPendente: pendentes.length,
    recebidoMes: soma(doMes.filter((v) => v.status === 'pago')),
    qtdOrcamentos: orcamentos.length,
    totalOrcamentos: soma(orcamentos),
    lucroMes: comLucro.length ? comLucro.reduce((t, l) => t + l, 0) : null,
    qtdComLucro: comLucro.length,
    qtdSemLucro: lucros.length - comLucro.length,
    qtdAEntregar: aEntregar.length,
    qtdAtrasadas: aEntregar.filter((v) => v.data_entrega_prevista && v.data_entrega_prevista < hoje).length,
  };
}

/** Soma do faturamento por dia nos últimos N dias (incluindo hoje), em ordem cronológica. */
export function totaisPorDia(vendas, dias, hoje = hojeISO()) {
  const mapa = new Map();
  for (let i = dias - 1; i >= 0; i--) mapa.set(somarDias(hoje, -i), 0);
  for (const v of vendas) {
    if (STATUS_FATURADOS.includes(v.status) && mapa.has(v.data_venda)) {
      mapa.set(v.data_venda, mapa.get(v.data_venda) + v.total);
    }
  }
  return [...mapa.entries()].map(([data, total]) => ({ data, total }));
}

/** Preenche os cards do painel. */
export function renderizarCards(r) {
  const definir = (id, texto) => {
    const el = document.getElementById(id);
    if (el) el.textContent = texto;
  };
  const plural = (n, s, p) => `${n} ${n === 1 ? s : p}`;
  definir('card-total-dia', formatarMoeda(r.totalDia));
  definir('card-total-dia-qtd', plural(r.qtdDia, 'venda hoje', 'vendas hoje'));
  definir('card-total-mes', formatarMoeda(r.totalMes));
  definir('card-total-mes-rec', `${formatarMoeda(r.recebidoMes)} já recebido`);
  definir('card-qtd-mes', String(r.qtdMes));
  definir('card-ticket', formatarMoeda(r.ticketMedio));
  definir('card-pendente', formatarMoeda(r.totalPendente));
  definir('card-pendente-qtd', plural(r.qtdPendente, 'venda a receber', 'vendas a receber'));
  definir('card-orcamentos', r.qtdOrcamentos
    ? `${plural(r.qtdOrcamentos, 'orçamento aberto', 'orçamentos abertos')} · ${formatarMoeda(r.totalOrcamentos)}`
    : '');
  definir('card-qtd-mes-entrega', 'fechadas (pendentes + pagas)');
  definir('card-entregar', String(r.qtdAEntregar));
  definir('card-lucro', r.lucroMes == null ? 'sem preço' : formatarMoeda(r.lucroMes));
  document.getElementById('card-lucro').classList.toggle('sem-preco', r.lucroMes == null);
  definir('card-lucro-detalhe', !r.qtdMes ? 'sem vendas no mês'
    : r.qtdSemLucro === 0 ? 'todas as vendas do mês'
      : r.qtdComLucro === 0 ? 'falta custo ou frete nas vendas do mês'
        : `mês atual, parcial: ${r.qtdSemLucro} ${r.qtdSemLucro === 1 ? 'venda sem custo completo fica' : 'vendas sem custo completo ficam'} fora`);
  definir('card-entregar-atrasadas', r.qtdAtrasadas ? `${r.qtdAtrasadas} com prazo vencido` : r.qtdAEntregar ? 'vendas fechadas não entregues' : 'tudo entregue');
}

/** Desenha o gráfico de barras dentro do elemento informado. */
export function renderizarGrafico(container, serie) {
  const largura = 640;
  const altura = 220;
  const margem = { topo: 16, dir: 8, base: 28, esq: 8 };
  const areaL = largura - margem.esq - margem.dir;
  const areaA = altura - margem.topo - margem.base;
  const maximo = Math.max(...serie.map((d) => d.total), 1);
  const passo = areaL / serie.length;
  const larguraBarra = Math.max(2, passo * 0.68);
  const hoje = hojeISO();
  const mostrarTodosRotulos = serie.length <= 10;

  const total = serie.reduce((t, d) => t + d.total, 0);
  const barras = serie.map((d, i) => {
    const h = d.total > 0 ? Math.max(3, (d.total / maximo) * areaA) : 0;
    const x = margem.esq + i * passo + (passo - larguraBarra) / 2;
    const y = margem.topo + areaA - h;
    const rotulo = mostrarTodosRotulos ? diaDaSemanaCurto(d.data) : d.data.slice(8);
    // Em 30 dias mostramos o número do dia a cada 5 barras para não amontoar.
    const exibirRotulo = mostrarTodosRotulos || i % 5 === 0 || i === serie.length - 1;
    const classe = d.data === hoje ? 'barra barra-hoje' : 'barra';
    return `
      <g>
        <title>${formatarDataBR(d.data)}: ${formatarMoeda(d.total)}</title>
        <rect class="barra-fundo" x="${x}" y="${margem.topo}" width="${larguraBarra}" height="${areaA}" rx="4"></rect>
        ${h ? `<rect class="${classe}" x="${x}" y="${y}" width="${larguraBarra}" height="${h}" rx="4"></rect>` : ''}
        ${exibirRotulo ? `<text class="rotulo" x="${x + larguraBarra / 2}" y="${altura - 8}" text-anchor="middle">${escaparHTML(rotulo)}</text>` : ''}
      </g>`;
  }).join('');

  container.innerHTML = `
    <svg viewBox="0 0 ${largura} ${altura}" role="img" aria-label="Vendas por dia. Total do período: ${formatarMoeda(total)}">
      ${barras}
    </svg>`;
  const legenda = document.getElementById('grafico-total');
  if (legenda) legenda.textContent = `Faturado no período: ${formatarMoeda(total)} · maior dia: ${formatarMoeda(Math.max(...serie.map((d) => d.total)))}`;
}
