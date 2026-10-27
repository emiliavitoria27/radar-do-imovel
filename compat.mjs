// Regras compartilhadas entre o site (navegador) e as funções do Netlify.
// Compatibilidade imóvel x perfil do cliente, estimativas do portfólio e verificação de alertas.

export const REPO_GITHUB = "emiliavitoria27/radar-do-imovel";
export const URL_PORTFOLIO = `https://raw.githubusercontent.com/${REPO_GITHUB}/dados/data/portfolio.json`;

export async function carregarPortfolio() {
  const r = await fetch(URL_PORTFOLIO + "?t=" + Date.now(), { headers: { "cache-control": "no-cache" } });
  if (!r.ok) throw new Error(r.status === 404 ? "O catálogo de imóveis ainda não foi montado. Rode a rotina “Atualizar catálogo” no GitHub." : `Catálogo indisponível (HTTP ${r.status}).`);
  const p = await r.json();
  if (!Array.isArray(p.imoveis) || !p.imoveis.length) throw new Error("Catálogo vazio ou inválido.");
  return p;
}

export const ALUGUEL_M2_CIDADE = 65.78; // FipeZAP, São Paulo, set/2026 (usado só quando o bairro não tem amostra)

export const normal = (s) => String(s || "").normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase().replace(/\(zona sul\)/g, "").trim();
const mediana = (a) => { if (!a.length) return null; const s = [...a].sort((x, y) => x - y), m = Math.floor(s.length / 2); return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2; };

export const GRUPOS_TIPO = {
  apartamento: ["apartamento", "cobertura", "duplex", "garden", "kit", "penthouse", "studio", "triplex", "flat"],
  casa: ["casa", "casa assobradada", "casa de vila", "casa terrea", "sobrado", "condominio"],
  comercial: ["comercial", "conj. comercial", "galpao", "loja", "ponto comercial", "predio"],
  terreno: ["terreno", "area"],
  rural: ["sitio"],
};
export function grupoTipo(tipo) {
  const t = normal(tipo);
  for (const [g, lista] of Object.entries(GRUPOS_TIPO)) if (lista.some((x) => t === x || t.startsWith(x))) return g;
  return "outro";
}

// Estatísticas do próprio portfólio da Nova São Paulo (preço/m² de venda e aluguel por bairro)
export function estatisticasPortfolio(portfolio) {
  const venda = {}, loc = {};
  for (const im of portfolio?.imoveis || []) {
    if (im.ativo === false || !im.area || im.area < 15) continue;
    const chave = normal(im.bairro) + "|" + grupoTipo(im.tipo);
    if (im.preco_venda) (venda[chave] ||= []).push(im.preco_venda / im.area);
    if (im.preco_locacao) (loc[chave] ||= []).push(im.preco_locacao / im.area);
  }
  const fechar = (o) => Object.fromEntries(Object.entries(o).map(([k, a]) => [k, { n: a.length, mediana: mediana(a) }]));
  return { venda: fechar(venda), locacao: fechar(loc) };
}

export function estimativas(im, stats) {
  const chave = normal(im.bairro) + "|" + grupoTipo(im.tipo);
  const precoM2 = im.preco_venda && im.area ? im.preco_venda / im.area : null;
  const bairroVenda = stats?.venda?.[chave];
  const bairroLoc = stats?.locacao?.[chave];
  const alugM2 = bairroLoc && bairroLoc.n >= 3 ? bairroLoc.mediana : ALUGUEL_M2_CIDADE;
  const fonteAluguel = bairroLoc && bairroLoc.n >= 3 ? `mediana de ${bairroLoc.n} imóveis para alugar da Nova SP no bairro` : "média da cidade (FipeZAP)";
  const aluguelEst = im.area ? Math.round(im.area * alugM2) : null;
  return {
    precoM2,
    medianaBairroM2: bairroVenda && bairroVenda.n >= 3 ? bairroVenda.mediana : null,
    nBairro: bairroVenda?.n || 0,
    difBairro: precoM2 && bairroVenda && bairroVenda.n >= 3 ? precoM2 / bairroVenda.mediana - 1 : null,
    aluguelEst, fonteAluguel,
    rendaBruta: aluguelEst && im.preco_venda ? (aluguelEst * 12) / im.preco_venda : null,
  };
}

// critérios: { negociacao, tipo, bairros[], precoMin, precoMax, areaMin, areaMax, quartosMin, banheirosMin, vagasMin,
//              caracteristicas[], rendaMin(%), precoM2Max }
// Essenciais: tipo, bairro, preço máximo, quartos mínimos, vagas mínimas. Os demais são desejáveis.
export function avaliarCompat(im, c, stats) {
  const preco = c.negociacao === "locacao" ? im.preco_locacao : im.preco_venda;
  const est = estimativas(im, stats);
  const itens = [];
  const add = (nome, essencial, status, detalhe) => itens.push({ nome, essencial, status, detalhe });
  const tem = (v) => v !== undefined && v !== null && v !== "" && !(Array.isArray(v) && !v.length);
  const fmt = (v) => "R$ " + Math.round(v).toLocaleString("pt-BR");

  if (tem(c.tipo)) {
    const ok = grupoTipo(im.tipo) === c.tipo || normal(im.tipo) === normal(c.tipo);
    add("Tipo", true, ok ? "ok" : "falha", ok ? im.tipo : `é ${im.tipo || "outro tipo"}`);
  }
  if (tem(c.bairros)) {
    const b = normal(im.bairro);
    if (!b) add("Bairro", true, "sem", "bairro não informado");
    else { const ok = c.bairros.some((x) => b === normal(x) || b.includes(normal(x)) || normal(x).includes(b)); add("Bairro", true, ok ? "ok" : "falha", ok ? im.bairro : `fica em ${im.bairro}`); }
  }
  if (tem(c.precoMax)) {
    if (!preco) add("Preço máximo", true, "sem", "preço não informado");
    else add("Preço máximo", true, preco <= c.precoMax ? "ok" : "falha", preco <= c.precoMax ? fmt(preco) : `${fmt(preco)}, ${Math.round((preco / c.precoMax - 1) * 100)}% acima do teto`);
  }
  if (tem(c.quartosMin)) {
    if (im.quartos == null) add("Quartos", true, "sem", "não informado");
    else add("Quartos", true, im.quartos >= c.quartosMin ? "ok" : "falha", `${im.quartos} quarto(s)`);
  }
  if (tem(c.vagasMin)) {
    if (im.vagas == null) add("Vagas", true, "sem", "não informado no anúncio");
    else add("Vagas", true, im.vagas >= c.vagasMin ? "ok" : "falha", `${im.vagas} vaga(s)`);
  }
  if (tem(c.precoMin)) { if (preco) add("Preço mínimo", false, preco >= c.precoMin ? "ok" : "falha", fmt(preco)); else add("Preço mínimo", false, "sem", "não informado"); }
  if (tem(c.areaMin)) { if (im.area) add("Área mínima", false, im.area >= c.areaMin ? "ok" : "falha", `${im.area} m²`); else add("Área mínima", false, "sem", "não informada"); }
  if (tem(c.areaMax)) { if (im.area) add("Área máxima", false, im.area <= c.areaMax ? "ok" : "falha", `${im.area} m²`); else add("Área máxima", false, "sem", "não informada"); }
  if (tem(c.banheirosMin)) { if (im.banheiros != null) add("Banheiros", false, im.banheiros >= c.banheirosMin ? "ok" : "falha", `${im.banheiros}`); else add("Banheiros", false, "sem", "não aparece na listagem; confira no anúncio"); }
  for (const car of c.caracteristicas || []) {
    const ok = (im.tags || []).some((t) => normal(t).includes(normal(car)));
    add(car, false, ok ? "ok" : "falha", ok ? "tem" : "não indicado no anúncio");
  }
  if (tem(c.precoM2Max)) { if (est.precoM2) add("Preço por m²", false, est.precoM2 <= c.precoM2Max ? "ok" : "falha", fmt(est.precoM2) + "/m²"); else add("Preço por m²", false, "sem", "sem área ou preço"); }
  if (tem(c.rendaMin)) {
    if (est.rendaBruta == null) add("Renda bruta estimada", false, "sem", "dados insuficientes");
    else add("Renda bruta estimada", false, est.rendaBruta * 100 >= c.rendaMin ? "ok" : "falha", `${(est.rendaBruta * 100).toFixed(1).replace(".", ",")}% ao ano (${est.fonteAluguel})`);
  }

  const ess = itens.filter((i) => i.essencial), des = itens.filter((i) => !i.essencial);
  const essFalha = ess.filter((i) => i.status === "falha").length;
  const essSem = ess.filter((i) => i.status === "sem").length;
  const desFalha = des.filter((i) => i.status === "falha").length;
  const avaliados = itens.filter((i) => i.status !== "sem");
  const taxa = avaliados.length ? avaliados.filter((i) => i.status === "ok").length / avaliados.length : 1;
  let nivel;
  if (essFalha === 0 && essSem === 0 && desFalha === 0) nivel = "alta";
  else if (essFalha <= 1 && taxa >= 0.6) nivel = "parcial";
  else nivel = "baixa";
  // nunca "alta" se estourar orçamento ou faltar exigência essencial
  return { nivel, itens, atendidos: itens.filter((i) => i.status === "ok"), falhas: itens.filter((i) => i.status === "falha"), semDado: itens.filter((i) => i.status === "sem"), taxa, est };
}

export const ORDEM_NIVEL = { alta: 3, parcial: 2, baixa: 1 };

export function filtrarPortfolio(portfolio, c, stats) {
  const neg = c.negociacao || "venda";
  return (portfolio?.imoveis || [])
    .filter((im) => im.ativo !== false && (neg === "locacao" ? im.preco_locacao : im.preco_venda))
    .map((im) => ({ im, r: avaliarCompat(im, c, stats) }));
}

export function proximaVerificacao(freq, agora = new Date()) {
  const h = freq === "semanal" ? 6.5 * 24 : 20;
  return new Date(agora.getTime() + h * 3600e3).toISOString();
}

// Executa a verificação de um alerta e grava notificações novas (sem duplicar).
// store: Netlify Blobs. baseline=true na criação: registra o que já existe sem notificar.
export async function rodarVerificacao(store, alerta, portfolio, { baseline = false, agora = new Date() } = {}) {
  const stats = estatisticasPortfolio(portfolio);
  const minimo = ORDEM_NIVEL[alerta.nivelMin || "alta"];
  const compat = filtrarPortfolio(portfolio, alerta.criterios, stats).filter((x) => ORDEM_NIVEL[x.r.nivel] >= minimo);
  const vistos = alerta.vistos || {};
  const neg = alerta.criterios.negociacao || "venda";
  let novos = 0;
  for (const { im, r } of compat) {
    const preco = neg === "locacao" ? im.preco_locacao : im.preco_venda;
    const anterior = vistos[im.ref];
    let tipo = null;
    if (anterior === undefined) tipo = "novo";
    else if (preco && anterior && preco <= anterior * 0.97) tipo = "reducao";
    vistos[im.ref] = preco;
    if (!tipo || baseline) continue;
    const chave = `notif/${alerta.chave}/${alerta.id}__${im.ref}__${tipo === "novo" ? "novo" : "reducao-" + preco}`;
    const existe = await store.get(chave, { type: "json" });
    if (existe) continue;
    await store.setJSON(chave, {
      alertaId: alerta.id, alertaNome: alerta.nome, ref: im.ref, url: im.url, titulo: `${im.tipo || "Imóvel"} em ${im.bairro || "—"}`,
      bairro: im.bairro, cidade: im.cidade || "São Paulo", preco, precoAnterior: tipo === "reducao" ? anterior : null, foto: im.foto || null,
      area: im.area, quartos: im.quartos, vagas: im.vagas, tipo, nivel: r.nivel,
      motivo: r.atendidos.map((i) => `${i.nome}: ${i.detalhe}`), pendencias: [...r.falhas, ...r.semDado].map((i) => `${i.nome}: ${i.detalhe}`),
      criadaEm: agora.toISOString(), lida: false, canais: ["app"],
    });
    novos++;
  }
  alerta.vistos = vistos;
  alerta.encontrados = compat.length;
  alerta.ultimaVerificacao = agora.toISOString();
  alerta.proximaVerificacao = proximaVerificacao(alerta.frequencia, agora);
  alerta.versaoPortfolio = portfolio.atualizado_em || null;
  alerta.historico = [{ data: agora.toISOString(), encontrados: compat.length, novos, baseline }, ...(alerta.historico || [])].slice(0, 30);
  await store.setJSON(`alerta/${alerta.chave}/${alerta.id}`, alerta);
  return { alerta, novos };
}
