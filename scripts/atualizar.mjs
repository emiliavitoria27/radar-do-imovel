// Rotina de atualização das bases de dados do Radar do Imóvel.
// Roda sozinha no GitHub Actions nos dias 1 e 16 de cada mês (≈ a cada 15 dias).
// Regras: só baixa quando há versão nova, valida antes de substituir,
// nunca apaga a base anterior e registra tudo em data/atualizacoes.json.

import fs from "node:fs";
import path from "node:path";
import zlib from "node:zlib";
import crypto from "node:crypto";
import { Readable } from "node:stream";

const RAIZ = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..");
const DADOS = path.join(RAIZ, "data");
const HIST = path.join(DADOS, "historico");
const BRUTO = path.join(RAIZ, "bruto"); // arquivos baixados (vão como "artefato" do GitHub, não entram no site)
const ARQ_LOG = path.join(DADOS, "atualizacoes.json");
const ARQ_ESTADO = path.join(DADOS, "estado-fontes.json");
const ARQ_AIRBNB = path.join(DADOS, "airbnb-sp.json");
const ARQ_SERIE = path.join(HIST, "serie-sao-paulo.json");
const ARQ_IND = path.join(DADOS, "indicadores.json");

const FONTE_INSIDE = process.env.RADAR_URL_INSIDE || "https://insideairbnb.com/get-the-data/";
const FONTE_BEWILD = process.env.RADAR_URL_BEWILD || "https://radarbewild.com.br/";
const UA = "RadarImovel-NovaSP/1.0 (atualizacao quinzenal; contato via site novasaopaulo.com.br)";
const MODO_TESTE = process.env.RADAR_TESTE_ARQUIVO || ""; // permite testar com um arquivo local

fs.mkdirSync(HIST, { recursive: true });
fs.mkdirSync(BRUTO, { recursive: true });

const lerJSON = (f, padrao) => { try { return JSON.parse(fs.readFileSync(f, "utf8")); } catch { return padrao; } };
const gravarJSON = (f, obj) => { const tmp = f + ".tmp"; fs.writeFileSync(tmp, JSON.stringify(obj, null, 1)); fs.renameSync(tmp, f); };

const inicio = new Date();
const estado = lerJSON(ARQ_ESTADO, {});
const log = lerJSON(ARQ_LOG, { execucoes: [] });
const execucao = { inicio: inicio.toISOString(), fim: null, gatilho: process.env.GATILHO || "manual", fontes: [], resumo: "" };

async function buscar(url, opcoes = {}, tentativas = 3) {
  let ultimoErro;
  for (let i = 1; i <= tentativas; i++) {
    try {
      const ctrl = new AbortController();
      const t = setTimeout(() => ctrl.abort(), opcoes.tempo || 60000);
      const r = await fetch(url, { ...opcoes, signal: ctrl.signal, headers: { "user-agent": UA, ...(opcoes.headers || {}) } });
      clearTimeout(t);
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      return r;
    } catch (e) {
      ultimoErro = e;
      if (i < tentativas) await new Promise((ok) => setTimeout(ok, 5000 * i));
    }
  }
  throw new Error(`${url} indisponível após ${tentativas} tentativas (${ultimoErro?.message || ultimoErro})`);
}

// ---------- leitor de CSV em fluxo (aguenta textos com quebra de linha) ----------
async function lerCSV(stream, aoLinha) {
  let campo = "", linha = [], aspas = false, cabecalho = null, total = 0;
  const fecharCampo = () => { linha.push(campo); campo = ""; };
  const fecharLinha = () => {
    fecharCampo();
    if (!cabecalho) cabecalho = linha;
    else if (linha.length > 1) { total++; const o = {}; cabecalho.forEach((c, i) => (o[c] = linha[i])); aoLinha(o); }
    linha = [];
  };
  const dec = new TextDecoder("utf-8");
  for await (const pedaco of stream) {
    const s = dec.decode(pedaco, { stream: true });
    for (let i = 0; i < s.length; i++) {
      const c = s[i];
      if (aspas) {
        if (c === '"') { if (s[i + 1] === '"') { campo += '"'; i++; } else aspas = false; }
        else campo += c;
      } else if (c === '"') aspas = true;
      else if (c === ",") fecharCampo();
      else if (c === "\n") fecharLinha();
      else if (c !== "\r") campo += c;
    }
  }
  if (campo || linha.length) fecharLinha();
  return { total, cabecalho: cabecalho || [] };
}

// ---------- agregação ----------
const faixa = (q) => (q === null || isNaN(q) ? "?" : q <= 1 ? "0-1" : q === 2 ? "2" : "3+");
const mediana = (a) => quantil(a, 0.5);
function quantil(a, q) {
  if (!a.length) return null;
  const s = [...a].sort((x, y) => x - y);
  const p = (s.length - 1) * q, b = Math.floor(p);
  return Math.round((s[b] + (s[Math.min(b + 1, s.length - 1)] - s[b]) * (p - b)) * 100) / 100;
}
const preco = (v) => { const n = Number(String(v || "").replace(/[$R\s,]/g, "")); return isFinite(n) && n > 0 ? n : null; };

function novoGrupo() { return { n: 0, ativos: 0, diarias: [], noites: [], receitas: [], mp: [] }; }
function somar(g, l) {
  g.n++;
  if (l.curta && l.diaria) g.diarias.push(l.diaria);
  if (l.ativo) { g.ativos++; if (l.noites !== null) g.noites.push(l.noites); if (l.receita) g.receitas.push(l.receita); }
  if (l.medio && l.diaria) g.mp.push(l.diaria);
}
function resumir(g) {
  return {
    n: g.n, ativos: g.ativos,
    diaria_p25: quantil(g.diarias, 0.25), diaria_p50: mediana(g.diarias), diaria_p75: quantil(g.diarias, 0.75),
    noites_p50: mediana(g.noites), receita_p50: mediana(g.receitas),
    n_medio_prazo: g.mp.length, diaria_medio_prazo_p50: mediana(g.mp),
  };
}

async function processarInsideAirbnb(stream, versao, urlArquivo) {
  const cidade = {}, distritos = {}, celulas = {};
  const add = (mapa, chave, l) => {
    mapa[chave] ||= {};
    for (const k of [faixa(l.quartos), "todos"]) { mapa[chave][k] ||= novoGrupo(); somar(mapa[chave][k], l); }
  };
  let usados = 0, temOcupacao = false;
  const { total, cabecalho } = await lerCSV(stream, (r) => {
    if (r.room_type !== "Entire home/apt") return; // só imóvel inteiro (compara com comprar um imóvel)
    const d = preco(r.price);
    const diaria = d && d >= 40 && d <= 5000 ? d : null;
    const minN = Number(r.minimum_nights) || 1;
    const ltm = Number(r.number_of_reviews_ltm) || 0;
    let noites = r.estimated_occupancy_l365d !== undefined && r.estimated_occupancy_l365d !== "" ? Number(r.estimated_occupancy_l365d) : null;
    if (noites !== null) temOcupacao = true;
    else noites = Math.min(Math.round((ltm / 0.5) * Math.max(3, Math.min(minN, 30))), 255); // método Inside Airbnb (taxa de avaliação 50%, teto 70%)
    const receitaCsv = preco(r.estimated_revenue_l365d);
    const l = {
      diaria, quartos: r.bedrooms === "" || r.bedrooms === undefined ? null : Number(r.bedrooms),
      curta: minN < 28, medio: minN >= 28, ativo: ltm > 0, noites,
      receita: receitaCsv || (diaria && noites ? diaria * noites : null),
    };
    const distrito = (r.neighbourhood_cleansed || r.neighbourhood || "").trim();
    const lat = Number(r.latitude), lng = Number(r.longitude);
    usados++;
    add(cidade, "sao-paulo", l);
    if (distrito) add(distritos, distrito, l);
    if (isFinite(lat) && isFinite(lng)) add(celulas, `${lat.toFixed(2)},${lng.toFixed(2)}`, l);
  });

  // validação antes de aceitar a nova versão
  const faltando = ["room_type", "price", "minimum_nights", "number_of_reviews_ltm", "latitude", "longitude"].filter((c) => !cabecalho.includes(c));
  if (faltando.length) throw new Error(`Arquivo com estrutura diferente do esperado (faltam colunas: ${faltando.join(", ")})`);
  if (total < 5000) throw new Error(`Arquivo parece incompleto: só ${total} anúncios (esperado > 5.000)`);
  if (Object.keys(distritos).length < 30) throw new Error(`Poucos distritos (${Object.keys(distritos).length}); arquivo suspeito`);
  const cid = resumir(cidade["sao-paulo"].todos);
  if (!cid.diaria_p50 || cid.diaria_p50 < 50 || cid.diaria_p50 > 3000) throw new Error(`Diária mediana fora do normal (${cid.diaria_p50})`);

  const fechar = (mapa, minimo) => Object.fromEntries(Object.entries(mapa)
    .map(([k, gs]) => [k, Object.fromEntries(Object.entries(gs).filter(([, g]) => g.n >= minimo).map(([f, g]) => [f, resumir(g)]))])
    .filter(([, v]) => Object.keys(v).length));

  return {
    fonte: "Inside Airbnb", licenca: "CC BY 4.0", url_fonte: FONTE_INSIDE, arquivo: urlArquivo,
    versao, coletado_em: versao, processado_em: new Date().toISOString(),
    anuncios_no_arquivo: total, anuncios_imovel_inteiro: usados,
    metodo_ocupacao: temOcupacao ? "estimated_occupancy_l365d (estimativa do próprio Inside Airbnb)" : "avaliações dos últimos 12 meses ÷ 50% × estadia média (método Inside Airbnb)",
    cidade: Object.fromEntries(Object.entries(cidade["sao-paulo"]).map(([f, g]) => [f, resumir(g)])),
    distritos: fechar(distritos, 5),
    celulas: fechar(celulas, 3),
  };
}

// ---------- fonte 1: Inside Airbnb ----------
async function fonteInsideAirbnb() {
  const reg = { fonte: "Inside Airbnb (São Paulo)", url: FONTE_INSIDE, status: "", versao: null, registros: null, mensagem: "" };
  try {
    let versao, urlGz, urlCsv, stream;
    if (MODO_TESTE) {
      versao = process.env.RADAR_TESTE_VERSAO || "2099-01-01"; urlGz = MODO_TESTE;
      stream = fs.createReadStream(MODO_TESTE).pipe(zlib.createGunzip());
    } else {
      const pagina = await (await buscar(FONTE_INSIDE)).text();
      const re = /https?:\/\/[a-z0-9.:-]+\/brazil\/[^/"'\s]+\/s(?:ã|%C3%A3|%c3%a3|a)o-paulo\/(\d{4}-\d{2}-\d{2})\/data\/listings\.csv\.gz/gi;
      const achados = [...pagina.matchAll(re)].map((m) => ({ url: m[0], data: m[1] })).sort((a, b) => b.data.localeCompare(a.data));
      if (!achados.length) throw new Error("A página de downloads não mostra arquivo de São Paulo (fonte pode ter mudado o layout)");
      versao = achados[0].data; urlGz = achados[0].url; urlCsv = urlGz.replace("/data/listings.csv.gz", "/visualisations/listings.csv");
      reg.versao = versao;
      const atual = lerJSON(ARQ_AIRBNB, null);
      if (estado.insideairbnb?.versao === versao && atual?.versao === versao) {
        reg.status = "sem_novidade"; reg.mensagem = `Versão ${versao} já está na base. Nada foi baixado.`;
        return reg;
      }
      const r = await buscar(urlGz, { tempo: 300000 });
      const destino = path.join(BRUTO, `insideairbnb-sao-paulo-${versao}-listings.csv.gz`);
      const buf = Buffer.from(await r.arrayBuffer());
      fs.writeFileSync(destino, buf);
      reg.sha256 = crypto.createHash("sha256").update(buf).digest("hex");
      reg.tamanho_mb = Math.round((buf.length / 1048576) * 10) / 10;
      stream = Readable.from([buf]).pipe(zlib.createGunzip());
    }
    let base;
    try { base = await processarInsideAirbnb(stream, versao, urlGz); }
    catch (e) {
      if (!urlCsv) throw e;
      // plano B: arquivo resumido (sem nº de quartos)
      const r2 = await buscar(urlCsv, { tempo: 180000 });
      base = await processarInsideAirbnb(Readable.from(Buffer.from(await r2.arrayBuffer())), versao, urlCsv);
      base.observacao = "Usado o arquivo resumido (sem número de quartos) porque o completo falhou: " + e.message;
    }
    // só agora, com tudo validado, substitui a base (a anterior fica no histórico)
    gravarJSON(path.join(HIST, `airbnb-sp-${versao}.json`), base);
    gravarJSON(ARQ_AIRBNB, base);
    const serie = lerJSON(ARQ_SERIE, { fonte: "Inside Airbnb", pontos: [] });
    serie.pontos = serie.pontos.filter((p) => p.versao !== versao);
    serie.pontos.push({ versao, diaria_p50: base.cidade.todos.diaria_p50, noites_p50: base.cidade.todos.noites_p50, receita_p50: base.cidade.todos.receita_p50, anuncios: base.anuncios_imovel_inteiro });
    serie.pontos.sort((a, b) => a.versao.localeCompare(b.versao));
    gravarJSON(ARQ_SERIE, serie);
    estado.insideairbnb = { versao, atualizado_em: new Date().toISOString(), sha256: reg.sha256 || null };
    reg.status = "atualizado"; reg.versao = versao; reg.registros = base.anuncios_no_arquivo;
    reg.mensagem = `Nova versão ${versao}: ${base.anuncios_no_arquivo} anúncios lidos, ${Object.keys(base.distritos).length} distritos. Diária mediana da cidade: R$ ${base.cidade.todos.diaria_p50}.`;
  } catch (e) {
    reg.status = "erro"; reg.mensagem = `${e.message}. A base anterior foi mantida; nova tentativa na próxima execução.`;
  }
  return reg;
}

// ---------- fonte 2: Radar Bewild (apenas monitoramento) ----------
async function fonteRadarBewild() {
  const reg = { fonte: "Radar Bewild", url: FONTE_BEWILD, status: "", versao: null, registros: null, mensagem: "" };
  try {
    if (MODO_TESTE) { reg.status = "pulado"; reg.mensagem = "Modo de teste."; return reg; }
    const html = await (await buscar(FONTE_BEWILD, { tempo: 30000 })).text();
    const limpo = html.replace(/<script[\s\S]*?<\/script>/gi, "").replace(/\s+/g, " ");
    const hash = crypto.createHash("sha256").update(limpo).digest("hex").slice(0, 16);
    const mudou = estado.radarbewild?.hash && estado.radarbewild.hash !== hash;
    reg.versao = hash;
    reg.status = "monitorado";
    reg.mensagem = (mudou ? "O conteúdo do site mudou desde a última verificação. " : estado.radarbewild?.hash ? "Sem mudança desde a última verificação. " : "Primeira verificação registrada. ")
      + "O Radar Bewild não publica arquivo de dados para download, então nenhum número dele é importado automaticamente.";
    estado.radarbewild = { hash, verificado_em: new Date().toISOString(), mudou_em: mudou ? new Date().toISOString() : estado.radarbewild?.mudou_em || null };
  } catch (e) {
    reg.status = "erro"; reg.mensagem = `${e.message}. Nova tentativa na próxima execução.`;
  }
  return reg;
}

// ---------- fonte 3: Banco Central (Selic e IPCA) ----------
async function fonteBancoCentral() {
  const reg = { fonte: "Banco Central (Selic e IPCA)", url: "https://api.bcb.gov.br", status: "", versao: null, registros: null, mensagem: "" };
  try {
    if (MODO_TESTE) { reg.status = "pulado"; reg.mensagem = "Modo de teste."; return reg; }
    // Busca até hoje: a série da meta Selic vem preenchida até a próxima reunião do Copom (datas futuras)
    const fmt = (d) => d.toLocaleDateString("pt-BR", { timeZone: "America/Sao_Paulo", day: "2-digit", month: "2-digit", year: "numeric" });
    const hoje = new Date(), inicio = new Date(hoje.getTime() - 400 * 864e5);
    const serie = async (cod) => {
      const j = await (await buscar(`https://api.bcb.gov.br/dados/serie/bcdata.sgs.${cod}/dados?formato=json&dataInicial=${fmt(inicio)}&dataFinal=${fmt(hoje)}`, { tempo: 30000 })).json();
      const ult = Array.isArray(j) ? j[j.length - 1] : null;
      const v = Number(String(ult?.valor).replace(",", "."));
      if (!isFinite(v)) throw new Error(`série ${cod} sem valor`);
      return { valor: v, data: ult.data };
    };
    const selic = await serie(432), ipca = await serie(13522);
    if (selic.valor < 1 || selic.valor > 40 || ipca.valor < -5 || ipca.valor > 30) throw new Error("valores fora do normal");
    const ind = lerJSON(ARQ_IND, {});
    ind.selic = { valor: selic.valor, data: selic.data, fonte: "Banco Central, série 432 (meta Selic)" };
    ind.ipca12m = { valor: ipca.valor, data: ipca.data, fonte: "Banco Central, série 13522 (IPCA 12 meses)" };
    ind.atualizado_em = new Date().toISOString();
    gravarJSON(ARQ_IND, ind);
    reg.status = "atualizado"; reg.versao = selic.data; reg.registros = 2;
    reg.mensagem = `Selic ${selic.valor}% (${selic.data}); IPCA 12 meses ${ipca.valor}% (${ipca.data}).`;
  } catch (e) {
    reg.status = "erro"; reg.mensagem = `${e.message}. Valores anteriores mantidos.`;
  }
  return reg;
}

execucao.fontes.push(await fonteInsideAirbnb());
execucao.fontes.push(await fonteRadarBewild());
execucao.fontes.push(await fonteBancoCentral());
execucao.fim = new Date().toISOString();
const atualizadas = execucao.fontes.filter((f) => f.status === "atualizado").map((f) => f.fonte);
const erros = execucao.fontes.filter((f) => f.status === "erro").map((f) => f.fonte);
execucao.resumo = (atualizadas.length ? `Atualizado: ${atualizadas.join(", ")}.` : "Nenhum dado novo.") + (erros.length ? ` Com erro: ${erros.join(", ")}.` : "");

const airbnb = lerJSON(ARQ_AIRBNB, null);
log.ultima_execucao = execucao.fim;
log.base_temporada = airbnb?.versao ? { fonte: "Inside Airbnb", coleta: airbnb.versao, carregada_em: airbnb.processado_em } : null;
log.proxima_execucao_prevista = proximaData(new Date());
log.execucoes = [execucao, ...(log.execucoes || [])].slice(0, 200);
gravarJSON(ARQ_LOG, log);
gravarJSON(ARQ_ESTADO, estado);
console.log(JSON.stringify(execucao, null, 2));

function proximaData(d) {
  const a = d.getUTCFullYear(), m = d.getUTCMonth(), dia = d.getUTCDate();
  const prox = dia < 16 ? new Date(Date.UTC(a, m, 16, 9)) : new Date(Date.UTC(a, m + 1, 1, 9));
  return prox.toISOString();
}
