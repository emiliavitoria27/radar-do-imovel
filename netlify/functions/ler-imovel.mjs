// Lê um anúncio do site www.novasaopaulo.com.br e devolve os dados em JSON.
// Roda no servidor do Netlify (o navegador não consegue ler outro site direto).

const DOMINIOS_PERMITIDOS = ["novasaopaulo.com.br"];

export default async (req) => {
  const cabecalhos = {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "public, max-age=900", // 15 min de cache: aguenta muita gente ao mesmo tempo
  };
  try {
    const url = new URL(req.url).searchParams.get("url") || "";
    let alvo;
    try { alvo = new URL(url); } catch { return erro("Esse link não parece válido. Copie o endereço completo do anúncio.", 400); }
    const host = alvo.hostname.replace(/^www\./, "");
    if (!DOMINIOS_PERMITIDOS.some((d) => host === d || host.endsWith("." + d))) {
      return erro("Por enquanto a leitura automática funciona só com anúncios do site novasaopaulo.com.br. Preencha os dados à mão.", 400);
    }
    if (!/\/imovel\//.test(alvo.pathname)) {
      return erro("Esse link não é de um imóvel específico. Abra o anúncio e copie o endereço da página dele.", 400);
    }

    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 8000);
    const resp = await fetch(alvo.toString(), {
      signal: ctrl.signal,
      headers: { "user-agent": "RadarImovel/1.0 (analise de anuncio a pedido do usuario)", "accept-language": "pt-BR" },
    });
    clearTimeout(timer);
    if (!resp.ok) return erro(`O site do anúncio respondeu com erro ${resp.status}. Tente de novo em instantes ou preencha à mão.`, 502);
    const html = await resp.text();
    const dados = extrair(html, alvo.toString());
    if (!dados.preco || !dados.area) {
      return new Response(JSON.stringify({ ok: true, parcial: true, dados, aviso: "Li o anúncio, mas faltaram alguns números. Confira os campos." }), { headers: cabecalhos });
    }
    return new Response(JSON.stringify({ ok: true, dados }), { headers: cabecalhos });
  } catch (e) {
    return erro(e.name === "AbortError" ? "O site do anúncio demorou demais para responder. Tente de novo." : "Não consegui ler o anúncio agora. Preencha os dados à mão.", 502);
  }

  function erro(msg, status) {
    return new Response(JSON.stringify({ ok: false, erro: msg }), { status, headers: { "content-type": "application/json; charset=utf-8" } });
  }
};

// ---------- extração ----------
export function extrair(html, url) {
  const meta = (prop) => {
    const m = html.match(new RegExp(`<meta[^>]+(?:property|name)=["']${prop}["'][^>]*content=["']([^"']*)["']`, "i"))
      || html.match(new RegExp(`<meta[^>]+content=["']([^"']*)["'][^>]*(?:property|name)=["']${prop}["']`, "i"));
    return m ? decodificar(m[1]) : "";
  };
  const titulo = meta("og:title") || (html.match(/<title>([^<]*)<\/title>/i) || [])[1] || "";
  const texto = paraTexto(html);
  const corte = texto.search(/Talvez você goste|im[oó]veis similares/i);
  const principal = corte > 0 ? texto.slice(0, corte) : texto;
  const resto = corte > 0 ? texto.slice(corte) : "";

  // "Apartamento para Venda, Vila Guarani(Zona Sul), São Paulo - Ref.: BI52877 - Nova São Paulo"
  const mt = titulo.match(/^(.+?) para (Venda|Loca[çc][ãa]o|Venda e Loca[çc][ãa]o),\s*(.+?),\s*([^,-]+?)\s*-\s*Ref\.?:?\s*([A-Z0-9]+)/i);
  const tipo = mt ? mt[1].trim() : "";
  const finalidade = mt ? mt[2].trim() : "";
  const bairroBruto = mt ? mt[3].trim() : "";
  const cidade = mt ? mt[4].trim() : "";
  const ref = mt ? mt[5] : ((url.match(/\/([A-Z]{2}\d{3,})\/?$/) || [])[1] || "");

  const num = (s) => (s ? Number(String(s).replace(/\./g, "").replace(",", ".")) : null);
  const achar = (re, fonte = principal) => { const m = fonte.match(re); return m ? m[1] : null; };

  const preco = num(achar(/Venda\s*R\$\s*([\d.]+(?:,\d+)?)/i));
  const aluguelAnunciado = num(achar(/Loca[çc][ãa]o\s*R\$\s*([\d.]+(?:,\d+)?)/i));
  const area = num(achar(/([\d.,]+)\s*m²\s*(?:Útil|Util|Privativa)/i)) || num(achar(/([\d.,]+)\s*m²\s*Constru[ií]da/i)) || num(achar(/([\d.,]+)\s*m²/i));
  const areaTipo = /m²\s*Constru/i.test(principal) && !/m²\s*(Útil|Util)/i.test(principal) ? "construída" : "útil";
  const quartos = num(achar(/(\d+)\s*Quartos?/i));
  const suites = num(achar(/(\d+)\s*Su[ií]tes?/i));
  const banheiros = num(achar(/(\d+)\s*(?:WCs?|Banheiros?)/i));
  const vagas = num(achar(/(\d+)\s*Vagas?/i)) ?? 0;
  const condominio = num(achar(/R\$\s*([\d.]+(?:,\d+)?)\s*Condom[ií]nio/i));
  const iptu = num(achar(/R\$\s*([\d.]+(?:,\d+)?)\s*IPTU/i));
  const metro = principal.match(/Metr[ôo]\s+([A-ZÀ-Ú][A-ZÀ-Ú .'-]+?)\s+([\d.]+)\s*metros/);
  const mobiliado = /\bMobiliado\b/i.test(principal);
  const lazer = ["Piscina", "Academia", "Portaria 24h", "Churrasqueira", "Playground", "Salão de Festas"].filter((x) => principal.includes(x));
  const endereco = achar(/São Paulo - SP\s*\|\s*(.+?)\s+(?:Condom[ií]nio:|Venda\b|Loca[çc][ãa]o\b)/i) || "";

  // pontos de interesse que o próprio anúncio mostra (fonte: GeoSampa/OpenStreetMap)
  const pois = [];
  const iniPoi = principal.search(/PONTOS DE INTERESSE/i);
  if (iniPoi >= 0) {
    const trecho = principal.slice(iniPoi, iniPoi + 1500);
    const reP = /(Metr[ôo]|Ônibus|Onibus|Ciclovia|Parque|Clube|Hospital|Escola|Feira|Supermercado|Farm[áa]cia|Shopping|Trem)\s+(.+?)\s+([\d.]+)\s*metros/g;
    let p;
    while ((p = reP.exec(trecho)) && pois.length < 12) pois.push({ tipo: p[1], nome: titleCase(p[2].replace(/\s*,\s*/g, ", ").trim()).slice(0, 60), metros: num(p[3]) });
  }
  const foto = meta("og:image") || null;
  const condominioNome = achar(/Condom[ií]nio:\s*(.+?)\s+(?:Venda|Loca[çc][ãa]o)\s+R\$/i);

  // coordenadas, se a página tiver (mapa)
  let lat = null, lng = null;
  const mc = html.match(/(-2[34]\.\d{3,})[^0-9-]{1,40}(-4[67]\.\d{3,})/);
  if (mc) { lat = Number(mc[1]); lng = Number(mc[2]); }

  // imóveis parecidos listados na própria página (para comparar preço por m²)
  const similares = [];
  const reSim = /Ref\.:\s*([A-Z]{2}\d+)\s+(.+?)\s+(Apartamento|Casa[\wÀ-ú ]*|Cobertura|Studio|Sobrado|Flat|Kit|Duplex|Garden|Penthouse)\s+Venda\s+R\$\s*([\d.]+)[\s\S]*?([\d.,]+)\s*m²\s*(?:Útil|Constru[ií]da)\s*\|\s*(\d+)\s*Quartos?/g;
  let s;
  while ((s = reSim.exec(resto)) && similares.length < 8) {
    const p = num(s[4]), a = num(s[5]);
    if (p && a) similares.push({ ref: s[1], bairro: s[2].trim(), tipo: s[3].trim(), preco: p, area: a, quartos: Number(s[6]), precoM2: Math.round(p / a) });
  }

  return {
    fonte: "novasaopaulo.com.br", url, ref, tipo, finalidade, cidade,
    bairro: bairroBruto.replace(/\s*\(Zona Sul\)\s*/i, "").trim(), bairroOriginal: bairroBruto,
    preco, aluguelAnunciado, area, areaTipo, quartos, suites, banheiros, vagas, condominio, iptu,
    metroEstacao: metro ? titleCase(metro[1].trim()) : null, metroDistancia: metro ? num(metro[2]) : null,
    mobiliado, lazer, endereco: endereco.trim(), lat, lng, similares, foto: foto && !/no-image|logo/i.test(foto) ? foto : null, pois, condominioNome: condominioNome ? condominioNome.slice(0, 60) : null, lidoEm: new Date().toISOString(),
  };
}

function paraTexto(html) {
  return decodificar(
    html.replace(/<script[\s\S]*?<\/script>/gi, " ").replace(/<style[\s\S]*?<\/style>/gi, " ").replace(/<[^>]+>/g, " ")
  ).replace(/[ \t\r\n\u00a0]+/g, " ");
}
function decodificar(s) {
  return s.replace(/&nbsp;/g, " ").replace(/&amp;/g, "&").replace(/&quot;/g, '"').replace(/&#39;|&apos;/g, "'")
    .replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&#(\d+);/g, (_, n) => String.fromCharCode(n))
    .replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCharCode(parseInt(n, 16)));
}
function titleCase(s) { return s.toLowerCase().replace(/(^|\s)\S/g, (c) => c.toUpperCase()); }
