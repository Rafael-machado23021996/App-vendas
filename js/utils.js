/**
 * utils.js — Funções auxiliares puras (sem acesso ao DOM nem ao armazenamento).
 *
 * Convenção importante: todos os valores em dinheiro são guardados em
 * CENTAVOS (números inteiros). Isso evita erros de arredondamento do tipo
 * 0,1 + 0,2 = 0,30000000000000004 que acontecem com números decimais.
 */

/** Formatador de moeda brasileira (R$ 1.234,56). Criado uma vez e reaproveitado. */
const formatadorBRL = new Intl.NumberFormat('pt-BR', { style: 'currency', currency: 'BRL' });

/** Formata centavos como moeda: 123456 -> "R$ 1.234,56". */
export function formatarMoeda(centavos) {
  return formatadorBRL.format((Number(centavos) || 0) / 100);
}

/** Formata centavos como número sem símbolo, para preencher campos: 123456 -> "1.234,56". */
export function formatarNumeroBR(centavos) {
  return ((Number(centavos) || 0) / 100).toLocaleString('pt-BR', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
}

/**
 * Lê um número digitado no padrão brasileiro (ou com ponto decimal) e devolve
 * um número JS, ou NaN se inválido. Regras:
 *   "1.234,56" -> 1234.56   (ponto = milhar, vírgula = decimal)
 *   "1234,56"  -> 1234.56
 *   "1234.56"  -> 1234.56   (um só ponto e sem vírgula = decimal)
 *   "1.500"    -> 1500      (padrão "milhar": 1 a 3 dígitos, ponto, 3 dígitos)
 *   "0.045"    -> 0.045     (começa com 0: é decimal)
 *   "R$ 50"    -> 50
 */
export function lerNumeroBR(texto) {
  if (typeof texto === 'number') return texto;
  let s = String(texto ?? '').trim().replace(/R\$\s?/i, '').replace(/\s/g, '');
  if (!s) return NaN;
  if (s.includes(',')) {
    // pt-BR: vírgula é o decimal e pontos só antes dela, em grupos de 3 ("1.234,56").
    // "1,234.56" (formato americano) ou "1,2,3" são recusados em vez de virar 1,23.
    if ((s.match(/,/g) || []).length > 1) return NaN;
    if (s.includes('.') && !/^-?\d{1,3}(\.\d{3})+,\d*$/.test(s)) return NaN;
    s = s.replace(/\./g, '').replace(',', '.');
  } else if ((s.match(/\./g) || []).length > 1) {
    s = s.replace(/\./g, ''); // "1.234.567"
  } else if (/^[1-9]\d{0,2}\.\d{3}$/.test(s)) {
    s = s.replace('.', ''); // "1.500" = mil e quinhentos
  }
  if (!/^-?\d+(\.\d+)?$/.test(s)) return NaN;
  return parseFloat(s);
}

/** Converte o texto digitado em centavos inteiros ("25,90" -> 2590). NaN se inválido. */
export function textoParaCentavos(texto) {
  const n = lerNumeroBR(texto);
  return Number.isFinite(n) ? Math.round(n * 100) : NaN;
}

/** Como textoParaCentavos, mas mantém frações de centavo (custo por grama: "0,1025" -> 10.25). */
export function textoParaCentavosPreciso(texto) {
  const n = lerNumeroBR(texto);
  return Number.isFinite(n) ? Math.round(n * 1000000) / 10000 : NaN;
}

/** Converte texto de quantidade ("2", "1,5", "0.045") em número ≥ 0. NaN se inválido. */
export function textoParaNumero(texto) {
  const n = lerNumeroBR(texto);
  return Number.isFinite(n) && n >= 0 ? n : NaN;
}

/** Número para exibir em campo pt-BR sem zeros inúteis: 1.5 -> "1,5"; 1000 -> "1000". */
export function numeroParaCampo(n) {
  if (n === null || n === undefined || n === '' || !Number.isFinite(Number(n))) return '';
  return String(Math.round(Number(n) * 10000) / 10000).replace('.', ',');
}

/** Data de hoje no fuso local, no formato ISO "AAAA-MM-DD" (o mesmo do <input type="date">). */
export function hojeISO() {
  return dataParaISO(new Date());
}

/** Converte um objeto Date em "AAAA-MM-DD" usando o horário LOCAL (não UTC). */
export function dataParaISO(data) {
  const a = data.getFullYear();
  const m = String(data.getMonth() + 1).padStart(2, '0');
  const d = String(data.getDate()).padStart(2, '0');
  return `${a}-${m}-${d}`;
}

/** Converte "AAAA-MM-DD" em Date local (meia-noite). Evita o bug de fuso do new Date("AAAA-MM-DD"). */
export function isoParaData(iso) {
  const [a, m, d] = String(iso).split('-').map(Number);
  return new Date(a, (m || 1) - 1, d || 1);
}

/** Soma (ou subtrai) dias a uma data ISO e devolve outra data ISO. */
export function somarDias(iso, dias) {
  const d = isoParaData(iso);
  d.setDate(d.getDate() + dias);
  return dataParaISO(d);
}

/** Exibe "AAAA-MM-DD" como "11/11/2026". */
export function formatarDataBR(iso) {
  if (!iso) return '';
  const [a, m, d] = iso.split('-');
  return `${d}/${m}/${a}`;
}

/** Nome curto do dia para o gráfico: "seg", "ter"... */
export function diaDaSemanaCurto(iso) {
  return isoParaData(iso).toLocaleDateString('pt-BR', { weekday: 'short' }).replace('.', '');
}

/** Gera um identificador único para cada venda. */
export function gerarId() {
  if (globalThis.crypto?.randomUUID) return crypto.randomUUID();
  return 'v-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 10);
}

/** Remove acentos e deixa minúsculo, para a busca achar "joao" em "João". */
export function normalizarTexto(s) {
  return String(s ?? '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .trim();
}

/** Escapa caracteres especiais de HTML (proteção contra injeção de código ao exibir textos). */
export function escaparHTML(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  })[c]);
}

/* ------------------------------------------------------------------ */
/* Listas fixas (enums) — os códigos seguem o modelo de dados do projeto */
/* ------------------------------------------------------------------ */

/** Formas de pagamento. */
export const PAGAMENTOS = { pix: 'Pix', dinheiro: 'Dinheiro', cartao: 'Cartão', outro: 'Outro' };

/**
 * Status da venda = situação COMERCIAL/PAGAMENTO.
 * A entrega é independente e fica no campo `data_entrega` da venda
 * (permite o caso "entregue, mas ainda devendo").
 * orcamento e cancelado NÃO contam no faturamento.
 */
export const STATUS = {
  orcamento: 'Orçamento',
  pendente: 'Pendente',
  pago: 'Pago',
  cancelado: 'Cancelado',
};
/** Status que entram no faturamento (venda fechada). */
export const STATUS_FATURADOS = ['pendente', 'pago'];

/** Tipos de item. */
export const TIPOS = {
  fisico: 'Produto físico',
  digital: 'Produto digital',
  impressao_3d: 'Impressão 3D',
  modelo_3d: 'Modelo 3D (arquivo)',
  servico: 'Serviço',
};

/** Canais de venda. */
export const CANAIS = {
  '': 'Não informado',
  whatsapp: 'WhatsApp',
  instagram: 'Instagram',
  presencial: 'Presencial',
  shopee: 'Shopee',
  mercado_livre: 'Mercado Livre',
  site: 'Site',
  outro: 'Outro',
};

/** Tipos de filamento/resina (campo "tipo" do insumo; útil para filamentos). */
export const MATERIAIS_3D = ['PLA', 'PETG', 'TPU', 'ABS', 'Resina', 'Outro'];

/** Categorias de insumos (tela "Materiais e insumos"). */
export const CATEGORIAS_INSUMO = {
  filamento: 'Filamento',
  resina: 'Resina',
  cola: 'Cola',
  eletronica: 'Eletrônica/LED',
  fiacao: 'Fiação',
  fixacao: 'Parafusos/fixação',
  embalagem: 'Embalagem',
  outro: 'Outro',
};

/** Unidades de compra/uso dos insumos. */
/**
 * Quantidade + unidade com plural em português: plural sempre que |q| ≠ 1
 * ("0 unidades", "1 unidade", "0,5 metros", "2 metros", "-3 unidades").
 * g, kg e ml são símbolos e não mudam.
 */
export function qtdComUnidade(q, u) {
  const nome = UNIDADES[u] || '';
  const arred = Math.round(q * 1000) / 1000;
  const plural = Math.abs(arred) !== 1 && (u === 'un' || u === 'm') ? `${nome}s` : nome;
  return `${numeroParaCampo(Math.round(q * 1000) / 1000)} ${plural}`.trim();
}

export const UNIDADES = { g: 'g', kg: 'kg', ml: 'ml', un: 'unidade', m: 'metro' };

/**
 * Formata custo por unidade, que pode ser fração de centavo (ex.: R$ 0,1025 por grama).
 * Recebe centavos (podendo ter decimais).
 */
export function formatarCustoUnidade(centavos) {
  const reais = (Number(centavos) || 0) / 100;
  const casas = reais > 0 && reais < 1 ? 4 : 2;
  return reais.toLocaleString('pt-BR', { style: 'currency', currency: 'BRL', minimumFractionDigits: 2, maximumFractionDigits: casas });
}

/**
 * Converte um WhatsApp digitado para o padrão internacional E.164 (+5511912345678).
 * Número brasileiro sem DDI ganha +55. Se não parecer um telefone, devolve o texto limpo.
 */
export function normalizarWhatsApp(entrada) {
  const bruto = String(entrada ?? '').trim();
  if (!bruto) return '';
  const digitos = bruto.replace(/\D/g, '');
  if (bruto.startsWith('+') && digitos.length >= 8) return '+' + digitos;
  if (/^55\d{10,11}$/.test(digitos)) return '+' + digitos;
  if (/^0?\d{10,11}$/.test(digitos)) return '+55' + digitos.replace(/^0/, '');
  return bruto.slice(0, 30);
}

/** Dispara o download de um arquivo gerado no navegador. */
export function baixarArquivo(nome, conteudo, tipo) {
  const blob = new Blob([conteudo], { type: tipo });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = nome;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
