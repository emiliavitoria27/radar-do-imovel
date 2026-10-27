// Monta o catálogo (portfólio) de imóveis publicados em www.novasaopaulo.com.br.
// Lê as páginas públicas de listagem, com pausa entre pedidos, respeitando o robots.txt.
// Não substitui o catálogo anterior se a leitura vier incompleta.
// Uso: node scripts/portfolio.mjs <pasta-de-saida>
import fs from "node:fs";
import path from "node:path";

const SITE = process.env.RADAR_SITE || "https://www.novasaopaulo.com.br";
const SAIDA = path.resolve(process.argv[2] || "data");
const ARQ = path.join(SAIDA, "portfolio.json");
const ARQ_LOG = path.join(SAIDA, "portfolio-log.json");
const UA = "RadarImovel-NovaSP/1.0 (catalogo interno; 1 pedido a cada 1,5 s)";
const PAUSA_MS = Number(process.env.RADAR_PAUSA_MS ?? 1500);
const MAX_PAGINAS = 300;
const TIPOS = ["Casa Assobradada", "Casa De Vila", "Casa Térrea", "Conj. Comercial", "Ponto Comercial", "Apartamento", "Cobertura", "Duplex", "Garden", "Kit", "Penthouse", "Studio", "Triplex", "Condomínio", "Sobrado", "Comercial", "Galpão", "Loja", "Prédio", "Flat", "Sítio", "Terreno", "Area", "Casa"];

const dormir = (ms) => new Promise((r) => setTimeout(r, ms));
const lerJSON = (f, p) => { try { return JSON.parse(fs.readFileSync(f, "utf8")); } catch { return p; } };
const gravar = (f, o) => { fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f + ".tmp", JSON.stringify(o)); fs.renameSync(f + ".tmp", f); };
const num = (s) => (s == null ? null : Number(String(s).replace(/\./g, "").replace(",", ".")) || null);

async function baixar(url) {
  for (let i = 1; i <= 3; i++) {
    try {
      const c = new AbortController(); const t = setTimeout(() => c.abort(), 30000);
      const r = await fetch(url, { signal: c.signal, headers: { "user-agent": UA, "accept-language": "pt-BR" } });
      clearTimeout(t);
      if (r.status === 404) return null;
      if (!r.ok) throw new Error("HTTP " + r.status);
      return await r.text();
    } catch (e) { if (i === 3) throw new Error(`${url}: ${e.message}`); await dormir(4000 * i); }
  }
}

function texto(html) {
  return html.replace(/<script[\s\S]*?<\/script>/gi, " ").replace(/<style[\s\S]*?<\/style>/gi, " ").replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ").replace(/&amp;/g, "&").replace(/&#(\d+);/g, (_, n) => String.fromCharCode(n)).replace(/\s+/g, " ");
}

// Extrai os cartões de imóveis de uma página de listagem
export function lerCartoes(html, base = SITE) {
  const re = /href=["']((?:https?:\/\/(?:www\.)?novasaopaulo\.com\.br)?\/imovel\/[^"'?#\s]+?\/([A-Z]{2}\d{3,}))\/?["']/g;
  const pos = []; let m;
  while ((m = re.exec(html))) pos.push({ i: m.index, url: m[1].startsWith("http") ? m[1] : base + m[1], ref: m[2] });
  // começo de cada imóvel = primeira vez que a referência aparece em sequência
  const blocos = [];
  for (let k = 0; k < pos.length; k++) {
    if (k > 0 && pos[k].ref === pos[k - 1].ref) continue;
    blocos.push(pos[k]);
  }
  const vistos = new Set(), saida = [];
  for (let k = 0; k < blocos.length; k++) {
    const b = blocos[k];
    if (vistos.has(b.ref)) continue;
    const fim = k + 1 < blocos.length ? blocos[k + 1].i : Math.min(html.length, b.i + 6000);
    const pedaco = html.slice(b.i, fim);
    const t = texto(pedaco);
    if (!/R\$/.test(t)) continue;
    vistos.add(b.ref);
    const partes = new URL(b.url).pathname.split("/").filter(Boolean); // imovel/tipo/finalidade/cidade/bairro/.../REF
    const reTipo = new RegExp(`Ref\\.?:?\\s*${b.ref}\\s+(.+?)\\s+(${TIPOS.map((x) => x.replace(".", "\\.")).join("|")})\\b`, "i");
    const mt = t.match(reTipo);
    const achar = (r) => { const x = t.match(r); return x ? x[1] : null; };
    const area = num(achar(/([\d.,]+)\s*m²/i));
    const areaTipo = /m²\s*Constru/i.test(t) ? "construída" : /m²\s*Total/i.test(t) ? "total" : "útil";
    const tags = [];
    if (/Mobiliado/i.test(t)) tags.push("Mobiliado");
    if (/Permuta/i.test(t)) tags.push("Aceita permuta");
    if (/Metr[ôo]\s+(AZUL|VERDE|VERMELHA|LIL[AÁ]S|AMARELA|PRATA|LARANJA)/i.test(t)) tags.push("Metrô próximo");
    if (/tour\.svg|Tour 360/i.test(pedaco)) tags.push("Tour 360º");
    if (/Com Renda|renda\.svg/i.test(pedaco)) tags.push("Com renda");
    if (/Sele[çc][ãa]o de Im[óo]veis/i.test(t)) tags.push("Seleção de imóveis");
    const linhas = (t.match(/Metr[ôo]\s+((?:AZUL|VERDE|VERMELHA|LIL[AÁ]S|AMARELA|PRATA|LARANJA)(?:\s+(?:AZUL|VERDE|VERMELHA|LIL[AÁ]S|AMARELA|PRATA|LARANJA))*)/i) || [])[1] || null;
    const foto = (pedaco.match(/https:\/\/cdn\.imoview\.com\.br\/[^"'\s)]+\.(?:jpe?g|png|webp)(?:\?[^"'\s)]*)?/i) || [])[0] || null;
    saida.push({
      ref: b.ref, url: b.url,
      tipo: mt ? mt[2].replace(/\s+/g, " ") : (partes[1] || "").replace(/-/g, " "),
      bairro: mt ? mt[1].replace(/\(Zona Sul\)/i, "").trim() : (partes[4] || "").replace(/-/g, " "),
      cidade: "São Paulo",
      preco_venda: num(achar(/Venda\s*R\$\s*([\d.]+)/i)),
      preco_locacao: num(achar(/Loca[çc][ãa]o\s*R\$\s*([\d.]+)/i)),
      area, area_tipo: areaTipo,
      quartos: num(achar(/(\d+)\s*Quartos?/i)), suites: num(achar(/(\d+)\s*Su[ií]tes?/i)),
      vagas: /\bVagas?\b/i.test(t) ? num(achar(/(\d+)\s*Vagas?/i)) : null,
      banheiros: num(achar(/(\d+)\s*(?:WCs?|Banheiros?)/i)),
      endereco: (achar(/R\$\s*[\d.]+\s+(.+?)\s+(?:Condom[ií]nio:|[\d.,]+\s*m²)/i) || "").slice(0, 80) || null,
      condominio_nome: (achar(/Condom[ií]nio:\s*(.+?)\s+[\d.,]+\s*m²/i) || "").slice(0, 60) || null,
      metro_linhas: linhas, foto, tags,
    });
  }
  return saida;
}

// Descobre como o site pagina (?page=, ?pagina=…): primeiro pelos links da própria página, senão testando nomes comuns
function paramDosLinks(html) {
  const m = html.match(/href=["'][^"']*[?&](page|pagina|pg|p)=\d+[^"']*["']/i);
  return m ? m[1] : null;
}
const comPagina = (base, param, n) => { const u = new URL(base); u.searchParams.set(param, n); return u.toString(); };

async function percorrer(caminho, registro) {
  const inicio = SITE + caminho;
  const html1 = await baixar(inicio);
  if (!html1) throw new Error(`${caminho} não encontrado`);
  const todos = new Map(); lerCartoes(html1).forEach((c) => todos.set(c.ref, c));
  const novosDe = (html) => (html ? lerCartoes(html) : []).filter((c) => !todos.has(c.ref));
  let param = paramDosLinks(html1), metodo = param ? `link da página (${param}=)` : null;
  if (!param) {
    for (const cand of ["page", "pagina", "pg"]) {
      await dormir(PAUSA_MS);
      const novos = novosDe(await baixar(comPagina(inicio, cand, 2)));
      if (novos.length) { param = cand; metodo = `testado (${cand}=)`; novos.forEach((c) => todos.set(c.ref, c)); break; }
    }
  }
  let n = param && metodo.startsWith("testado") ? 3 : 2, semNovos = 0;
  while (param && n <= MAX_PAGINAS) {
    await dormir(PAUSA_MS);
    const novos = novosDe(await baixar(comPagina(inicio, param, n)));
    novos.forEach((c) => todos.set(c.ref, c));
    if (!novos.length && ++semNovos >= 2) break;
    if (novos.length) semNovos = 0;
    n++;
  }
  registro.paginas[caminho] = { paginas_lidas: param ? n - 1 : 1, imoveis: todos.size, paginacao: metodo || "não encontrada (só a 1ª página foi lida)" };
  return [...todos.values()];
}

async function principal() {
  const inicio = new Date();
  const registro = { inicio: inicio.toISOString(), status: "", mensagem: "", paginas: {} };
  const anterior = lerJSON(ARQ, { imoveis: [] });
  const log = lerJSON(ARQ_LOG, []);
  try {
    const robots = (await baixar(SITE + "/robots.txt").catch(() => "")) || "";
    const bloqueios = [];
    let agenteTodos = false;
    for (const linha of robots.split(/\r?\n/)) {
      const [k, ...v] = linha.split(":"); const val = v.join(":").trim();
      if (/^user-agent$/i.test(k.trim())) agenteTodos = val === "*";
      else if (agenteTodos && /^disallow$/i.test(k.trim()) && val) bloqueios.push(val);
    }
    const proibido = (p) => bloqueios.some((b) => b === "/" || p.startsWith(b));
    if (proibido("/venda") && proibido("/locacao")) throw new Error("O robots.txt do site não permite ler as listagens. Catálogo não atualizado.");

    const lidos = new Map();
    for (const caminho of ["/venda", "/locacao"]) {
      if (proibido(caminho)) { registro.paginas[caminho] = { pulado: "bloqueado no robots.txt" }; continue; }
      try { for (const c of await percorrer(caminho, registro)) { const j = lidos.get(c.ref); lidos.set(c.ref, j ? { ...c, ...Object.fromEntries(Object.entries(j).filter(([, v]) => v != null)), preco_venda: j.preco_venda ?? c.preco_venda, preco_locacao: j.preco_locacao ?? c.preco_locacao } : c); } }
      catch (e) { registro.paginas[caminho] = { erro: e.message }; }
    }
    const ativosAntes = anterior.imoveis.filter((i) => i.ativo !== false).length;
    if (lidos.size < 10) throw new Error(`Só ${lidos.size} imóveis lidos. O layout do site pode ter mudado. Catálogo anterior mantido.`);
    if (ativosAntes > 50 && lidos.size < ativosAntes * 0.5) throw new Error(`Leitura incompleta: ${lidos.size} imóveis contra ${ativosAntes} na última vez. Catálogo anterior mantido.`);

    const agora = inicio.toISOString();
    const antes = new Map(anterior.imoveis.map((i) => [i.ref, i]));
    const final = [];
    let novos = 0, reducoes = 0;
    for (const [ref, c] of lidos) {
      const a = antes.get(ref);
      const hist = a?.historico_preco || [];
      if (!a) novos++;
      if (a && c.preco_venda && a.preco_venda && c.preco_venda < a.preco_venda) reducoes++;
      const mudou = !a || a.preco_venda !== c.preco_venda || a.preco_locacao !== c.preco_locacao;
      final.push({ ...c, ativo: true, primeira_vez: a?.primeira_vez || agora, visto_em: agora,
        historico_preco: mudou ? [{ data: agora, venda: c.preco_venda, locacao: c.preco_locacao }, ...hist].slice(0, 10) : hist });
    }
    for (const [ref, a] of antes) if (!lidos.has(ref)) {
      const saiuEm = a.ativo === false ? a.saiu_em : agora;
      if (Date.now() - new Date(saiuEm).getTime() < 30 * 864e5) final.push({ ...a, ativo: false, saiu_em: saiuEm });
    }
    gravar(ARQ, { fonte: SITE, atualizado_em: agora, primeira_execucao: anterior.primeira_execucao || agora, total_ativos: lidos.size, imoveis: final });
    registro.status = "atualizado";
    registro.mensagem = `${lidos.size} imóveis ativos (${novos} novos, ${reducoes} com redução de preço).`;
  } catch (e) {
    registro.status = "erro"; registro.mensagem = e.message;
  }
  registro.fim = new Date().toISOString();
  gravar(ARQ_LOG, [registro, ...log].slice(0, 60));
  console.log(JSON.stringify(registro, null, 2));
}

if (process.argv[1] && import.meta.url.endsWith(path.basename(process.argv[1]))) principal();
