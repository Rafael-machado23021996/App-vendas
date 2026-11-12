/**
 * insumos.js — Tela "Materiais e insumos": cadastrar, editar, desativar e
 * reativar o que é comprado para produzir (filamento, resina, cola, LED...).
 *
 * Custo por unidade = preço pago ÷ quantidade comprada (na unidade escolhida).
 * Para filamento em g ou kg mostramos também o R$/kg. Sem preço = "sem preço"
 * (nunca R$ 0). O SALDO é calculado: comprado + ajustes − consumo das vendas.
 */
import {
  formatarMoeda, formatarNumeroBR, formatarCustoUnidade, formatarDataBR, textoParaCentavos, textoParaNumero, lerNumeroBR,
  numeroParaCampo, escaparHTML, qtdComUnidade, dataParaISO, CATEGORIAS_INSUMO, UNIDADES, MATERIAIS_3D,
} from './utils.js';
import * as db from './storage.js';

/** Unidade sugerida ao escolher a categoria. */
const UNIDADE_PADRAO = { filamento: 'g', resina: 'ml', cola: 'g', eletronica: 'un', fiacao: 'm', fixacao: 'un', embalagem: 'un', outro: 'un' };

let aoMudarDados = () => {};
const form = () => document.getElementById('form-insumo');

/** Liga os eventos da tela. `callback` é chamado após qualquer alteração. */
export function configurarInsumos(callback) {
  aoMudarDados = callback;
  const f = form();
  f.categoria.innerHTML = Object.entries(CATEGORIAS_INSUMO).map(([v, r]) => `<option value="${v}">${r}</option>`).join('');
  f.unidade.innerHTML = Object.entries(UNIDADES).map(([v, r]) => `<option value="${v}">${r}</option>`).join('');
  f.tipo.innerHTML = '<option value="">—</option>' + MATERIAIS_3D.map((t) => `<option>${t}</option>`).join('');
  limparFormulario();

  f.categoria.addEventListener('change', () => {
    // Na edição a unidade não muda sozinha (poderia estragar o saldo de um insumo já usado).
    if (!f.id.value) f.unidade.value = UNIDADE_PADRAO[f.categoria.value] || 'un';
    atualizarFormulario();
  });
  f.addEventListener('input', (e) => {
    const erro = f.querySelector(`[data-erro="${e.target.name}"]`);
    if (erro) { erro.textContent = ''; e.target.removeAttribute('aria-invalid'); }
    atualizarFormulario();
  });
  f.unidade.addEventListener('change', aoTrocarUnidade);
  f.preco_pago.addEventListener('blur', () => {
    const c = textoParaCentavos(f.preco_pago.value);
    if (Number.isFinite(c)) f.preco_pago.value = formatarNumeroBR(c);
  });
  f.addEventListener('submit', salvar);
  document.getElementById('botao-cancelar-insumo').addEventListener('click', limparFormulario);
  document.getElementById('mostrar-inativos').addEventListener('change', renderizarInsumos);

  document.getElementById('lista-insumos').addEventListener('click', (e) => {
    const b = e.target.closest('[data-acao-insumo]');
    if (!b) return;
    const id = b.dataset.id;
    if (b.dataset.acaoInsumo === 'editar') editar(id);
    if (b.dataset.acaoInsumo === 'desativar' || b.dataset.acaoInsumo === 'reativar') {
      let m;
      try { m = db.definirInsumoAtivo(id, b.dataset.acaoInsumo === 'reativar'); } catch (erro) { avisar(erro.message, 'erro'); aoMudarDados(); return; }
      avisar(m.ativo ? `"${m.nome}" reativado.` : `"${m.nome}" desativado. Ele some da escolha nas vendas, mas o histórico continua igual.`);
      aoMudarDados();
    }
  });
}

let avisar = () => {};
export function definirAvisador(fn) { avisar = fn; }

/** Mostra o campo "tipo" só para filamento/resina e calcula o custo por unidade ao vivo. */
function atualizarFormulario() {
  const f = form();
  const ehMaterial3D = ['filamento', 'resina'].includes(f.categoria.value);
  document.getElementById('campo-tipo-insumo').hidden = !ehMaterial3D;
  document.getElementById('i-qtd-unidade').textContent = UNIDADES[f.unidade.value];
  document.getElementById('i-ajuste-unidade').textContent = UNIDADES[f.unidade.value];
  const preco = textoParaCentavos(f.preco_pago.value);
  const qtd = textoParaNumero(f.quantidade_comprada.value);
  const custo = db.calcularCustoUnidade(preco, qtd);
  const saida = document.getElementById('i-custo-saida');
  if (custo == null) {
    saida.innerHTML = qtd > 0
      ? 'Custo por unidade: <strong>sem preço</strong> (informe o preço pago para calcular).'
      : 'Custo por unidade: informe a quantidade comprada (e o preço pago).';
    return;
  }
  const kg = db.precoPorKg({ unidade: f.unidade.value, custo_unidade: custo });
  saida.innerHTML = `Custo por unidade: <strong>${formatarCustoUnidade(custo)}/${UNIDADES[f.unidade.value]}</strong>` +
    (kg ? ` · <strong>${formatarMoeda(kg)}/kg</strong>` : '');
}

const r4 = (n) => Math.round(n * 10000) / 10000;

/**
 * Troca de unidade na edição. Insumo já usado em vendas: só g ↔ kg, e aí a
 * quantidade comprada (e o "somar ao saldo" digitado) são convertidos na hora,
 * com aviso. Outras trocas mostram erro e não são salvas.
 */
function aoTrocarUnidade() {
  const f = form();
  const orig = f.dataset.unidadeOriginal;
  const aviso = document.getElementById('i-aviso-unidade');
  const erro = f.querySelector('[data-erro="unidade"]');
  erro.textContent = '';
  f.unidade.removeAttribute('aria-invalid');
  aviso.hidden = true;
  const uso = Number(f.dataset.uso || 0);
  if (orig && uso > 0) {
    const nova = f.unidade.value;
    const anterior = f.dataset.unidadeAnterior || orig;
    const fator = db.fatorGKg(anterior, nova);
    if (fator != null && db.fatorGKg(orig, nova) != null) {
      for (const campo of [f.quantidade_comprada, f.ajuste]) {
        const q = lerNumeroBR(campo.value);
        if (campo.value.trim() && Number.isFinite(q)) campo.value = numeroParaCampo(r4(q * fator));
      }
      f.dataset.unidadeAnterior = nova;
      const saldo = db.calcularSaldos().get(f.id.value) * db.fatorGKg(orig, nova);
      document.getElementById('i-saldo-atual').textContent = `Saldo atual: ${qtdComUnidade(r4(saldo), nova)}.`;
      if (nova !== orig) {
        aviso.hidden = false;
        aviso.textContent = `Unidade convertida de ${UNIDADES[orig]} para ${UNIDADES[nova]}: quantidade comprada e saldo foram ${nova === 'g' ? 'multiplicados' : 'divididos'} por 1000. O custo continua o mesmo (mesmo R$/kg).`;
      }
    } else {
      erro.textContent = `Já usado em ${uso} ${uso === 1 ? 'venda' : 'vendas'}: só dá para trocar entre g e kg. Para outra unidade, cadastre um insumo novo.`;
      f.unidade.setAttribute('aria-invalid', 'true');
    }
  }
  atualizarFormulario();
}

function limparFormulario() {
  const f = form();
  f.reset();
  f.id.value = '';
  delete f.dataset.unidadeOriginal;
  delete f.dataset.unidadeAnterior;
  delete f.dataset.uso;
  document.getElementById('i-aviso-unidade').hidden = true;
  f.categoria.value = 'filamento';
  f.unidade.value = 'g';
  f.querySelectorAll('.erro').forEach((el) => (el.textContent = ''));
  f.querySelectorAll('[aria-invalid]').forEach((el) => el.removeAttribute('aria-invalid'));
  document.getElementById('titulo-form-insumo').textContent = 'Novo insumo';
  document.getElementById('botao-salvar-insumo').textContent = 'Adicionar insumo';
  document.getElementById('botao-cancelar-insumo').hidden = true;
  document.getElementById('campo-ajuste-saldo').hidden = true;
  atualizarFormulario();
}

function editar(id) {
  const m = db.obterInsumo(id);
  if (!m) return;
  const f = form();
  limparFormulario();
  f.id.value = m.id;
  f.categoria.value = m.categoria;
  f.nome.value = m.nome;
  f.tipo.value = m.tipo || '';
  f.cor.value = m.cor;
  f.marca.value = m.marca;
  f.unidade.value = m.unidade;
  f.dataset.unidadeOriginal = m.unidade;
  f.dataset.unidadeAnterior = m.unidade;
  f.dataset.uso = String(db.contarUsoInsumo(m.id));
  f.preco_pago.value = m.preco_pago ? formatarNumeroBR(m.preco_pago) : '';
  // Na edição dá para somar ao saldo (nova compra) ou corrigir (valor negativo).
  document.getElementById('campo-ajuste-saldo').hidden = false;
  document.getElementById('i-saldo-atual').textContent =
    `Saldo atual: ${qtdComUnidade(db.calcularSaldos().get(m.id), m.unidade)}.` +
    (Number(f.dataset.uso) > 0 ? ' Como já foi usado em vendas, a unidade só pode trocar entre g e kg (com conversão).' : '');
  f.quantidade_comprada.value = numeroParaCampo(m.quantidade_comprada);
  document.getElementById('titulo-form-insumo').textContent = `Editar: ${m.nome}`;
  document.getElementById('botao-salvar-insumo').textContent = 'Salvar alterações';
  document.getElementById('botao-cancelar-insumo').hidden = false;
  atualizarFormulario();
  f.scrollIntoView({ behavior: 'smooth', block: 'start' });
}

function salvar(e) {
  e.preventDefault();
  const f = form();
  const preco = textoParaCentavos(f.preco_pago.value);
  const qtd = textoParaNumero(f.quantidade_comprada.value);
  let invalido = null;
  const marcar = (campo, msg) => {
    f.querySelector(`[data-erro="${campo}"]`).textContent = msg;
    f[campo].setAttribute('aria-invalid', 'true');
    invalido ??= f[campo];
  };
  if (f.preco_pago.value.trim() && !(preco > 0)) marcar('preco_pago', 'Valor inválido. Ex.: 102,50 (ou deixe vazio = sem preço).');
  const ajusteTxt = f.ajuste.value.trim();
  const ajuste = ajusteTxt ? lerNumeroBR(ajusteTxt) : 0;
  if (ajusteTxt && !Number.isFinite(ajuste)) marcar('ajuste', 'Número inválido.');
  if (!(qtd > 0)) marcar('quantidade_comprada', `Informe a quantidade comprada, em ${UNIDADES[f.unidade.value]}.`);
  const orig = f.dataset.unidadeOriginal;
  const trocaUnidade = orig && f.unidade.value !== orig && Number(f.dataset.uso || 0) > 0;
  const fatorTroca = trocaUnidade ? db.fatorGKg(orig, f.unidade.value) : 1;
  if (trocaUnidade && fatorTroca == null) {
    marcar('unidade', `Já usado em vendas: só dá para trocar entre g e kg. Volte para ${UNIDADES[orig]} ou cadastre um insumo novo.`);
  }
  if (invalido) { invalido.focus(); return; }
  const dados = {
    categoria: f.categoria.value,
    nome: f.nome.value.trim(),
    tipo: ['filamento', 'resina'].includes(f.categoria.value) ? f.tipo.value : '',
    cor: f.cor.value.trim(),
    marca: f.marca.value.trim(),
    unidade: f.unidade.value,
    preco_pago: preco > 0 ? preco : 0, // 0 = sem preço (custo fica null, nunca R$ 0)
    quantidade_comprada: qtd,
  };
  const existente = f.id.value ? db.obterInsumo(f.id.value) : null;
  // "Somar ao saldo" está na unidade da tela; o ajuste antigo é convertido se a unidade mudou (g ↔ kg).
  if (existente && ajuste) dados.ajuste_saldo = r4((existente.ajuste_saldo || 0) * fatorTroca + ajuste);
  try {
    const id = f.id.value || null;
    const m = db.salvarInsumo(dados, id);
    avisar(id
      ? (trocaUnidade
        ? `"${m.nome}": unidade convertida de ${UNIDADES[orig]} para ${UNIDADES[m.unidade]} (quantidades × ou ÷ 1000). Vendas já salvas mantêm o custo antigo.`
        : `"${m.nome}" atualizado. Vendas já salvas mantêm o custo antigo.`)
      : `"${m.nome}" cadastrado: ${m.custo_unidade != null ? `${formatarCustoUnidade(m.custo_unidade)}/${UNIDADES[m.unidade]}` : 'sem preço'}.`);
    limparFormulario();
    aoMudarDados();
  } catch (erro) {
    avisar(erro.message, 'erro');
  }
}

/** Desenha a lista de insumos (ativos; inativos só com o interruptor ligado). */
export function renderizarInsumos() {
  const mostrarInativos = document.getElementById('mostrar-inativos').checked;
  const lista = db.listarInsumos({ incluirInativos: mostrarInativos });
  const ul = document.getElementById('lista-insumos');
  const saldos = db.calcularSaldos();
  document.getElementById('insumos-vazio').hidden = lista.length > 0;
  ul.innerHTML = lista.map((m) => {
    const kg = db.precoPorKg(m);
    const uso = db.contarUsoInsumo(m.id);
    const saldo = saldos.get(m.id) ?? 0;
    const saldoTxt = qtdComUnidade(saldo, m.unidade);
    const detalhes = [CATEGORIAS_INSUMO[m.categoria], m.tipo, m.cor, m.marca].filter(Boolean).map(escaparHTML).join(' · ');
    return `
      <li class="item-venda insumo${m.ativo ? '' : ' inativo'}" data-id="${m.id}">
        <div class="item-principal">
          <div class="item-info">
            <strong class="item-produto">${escaparHTML(m.nome)}${m.exemplo ? ' <span class="selo selo-exemplo">exemplo</span>' : ''}${m.ativo ? '' : ' <span class="selo selo-cancelado">inativo</span>'}</strong>
            <span class="item-detalhes">${detalhes}</span>
            <span class="saldo-insumo${saldo < 0 ? ' negativo' : ''}">${saldo < 0 ? '⚠ ' : ''}Saldo: ${saldoTxt}${saldo < 0 ? ' (negativo: registre a compra)' : ''}</span>
            <span class="item-detalhes">${m.preco_pago ? `Pago ${formatarMoeda(m.preco_pago)} por ${qtdComUnidade(m.quantidade_comprada, m.unidade)}` : `Comprado: ${qtdComUnidade(m.quantidade_comprada, m.unidade)}, preço não informado`} · atualizado ${formatarDataBR(dataParaISO(new Date(m.atualizado_em)))}${uso ? ` · usado em ${uso} ${uso === 1 ? 'venda' : 'vendas'}` : ''}</span>
          </div>
          <div class="item-valor">
            <strong>${m.custo_unidade != null ? `${formatarCustoUnidade(m.custo_unidade)}<small>/${UNIDADES[m.unidade]}</small>` : '<span class="sem-preco">sem preço</span>'}</strong>
            ${kg ? `<span class="item-detalhes">${formatarMoeda(kg)}/kg</span>` : ''}
          </div>
        </div>
        <div class="item-acoes">
          <button type="button" class="botao botao-pequeno" data-acao-insumo="editar" data-id="${m.id}">Editar</button>
          ${m.ativo
            ? `<button type="button" class="botao botao-pequeno botao-perigo-texto" data-acao-insumo="desativar" data-id="${m.id}">Desativar</button>`
            : `<button type="button" class="botao botao-pequeno botao-suave" data-acao-insumo="reativar" data-id="${m.id}">Reativar</button>`}
        </div>
      </li>`;
  }).join('');
}
