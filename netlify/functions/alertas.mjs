// API dos alertas de oportunidades. Guarda tudo no Netlify Blobs (incluído no plano gratuito).
// Cada alerta pertence ao usuário logado (login com e-mail corporativo, ver auth.mjs).
import { getStore } from "@netlify/blobs";
import { usuarioDaSessao, origemValida } from "./auth.mjs";
import { rodarVerificacao, proximaVerificacao, carregarPortfolio } from "../../compat.mjs";

export const config = { path: "/api/alertas" };

const json = (obj, status = 200) => new Response(JSON.stringify(obj), { status, headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" } });
const chaveValida = (c) => typeof c === "string" && /^[a-z0-9-]{24,64}$/.test(c);
const limpa = (s, n = 120) => String(s ?? "").replace(/[<>]/g, "").slice(0, n).trim();
const numOuNulo = (v) => (v === "" || v == null || !isFinite(Number(v)) ? null : Number(v));

function sanitizarCriterios(c = {}) {
  return {
    finalidade: c.finalidade === "investimento" ? "investimento" : "moradia",
    negociacao: c.negociacao === "locacao" ? "locacao" : "venda",
    tipo: limpa(c.tipo, 30),
    bairros: (Array.isArray(c.bairros) ? c.bairros : []).map((b) => limpa(b, 60)).filter(Boolean).slice(0, 15),
    precoMin: numOuNulo(c.precoMin), precoMax: numOuNulo(c.precoMax),
    areaMin: numOuNulo(c.areaMin), areaMax: numOuNulo(c.areaMax),
    quartosMin: numOuNulo(c.quartosMin), banheirosMin: numOuNulo(c.banheirosMin), vagasMin: numOuNulo(c.vagasMin),
    caracteristicas: (Array.isArray(c.caracteristicas) ? c.caracteristicas : []).map((x) => limpa(x, 40)).filter(Boolean).slice(0, 10),
    rendaMin: numOuNulo(c.rendaMin), precoM2Max: numOuNulo(c.precoM2Max),
  };
}

export default async (req) => {
  const store = getStore({ name: "radar-alertas", consistency: "strong" });
  if (!origemValida(req)) return json({ ok: false, erro: "Origem não permitida." }, 403);
  const usuario = await usuarioDaSessao(req);
  if (!usuario) return json({ ok: false, erro: "Entre com seu e-mail e senha para usar os alertas.", login: true }, 401);
  const chave = usuario.id; // espaço de dados do usuário
  try {
    if (req.method === "GET" && new URL(req.url).searchParams.has("sistema")) {
      const log = (await store.get("sistema/log-verificacoes", { type: "json" })) || [];
      return json({ ok: true, log: log.slice(0, 10) });
    }
    if (req.method === "GET") {
      const [la, ln] = await Promise.all([store.list({ prefix: `alerta/${chave}/` }), store.list({ prefix: `notif/${chave}/` })]);
      const alertas = (await Promise.all(la.blobs.map((b) => store.get(b.key, { type: "json" })))).filter(Boolean);
      const notificacoes = (await Promise.all(ln.blobs.map(async (b) => ({ id: b.key.split("/").pop(), ...(await store.get(b.key, { type: "json" })) })))).filter((n) => n.ref);
      alertas.forEach((a) => { a.novas = notificacoes.filter((n) => n.alertaId === a.id && !n.lida).length; delete a.vistos; });
      notificacoes.sort((a, b) => b.criadaEm.localeCompare(a.criadaEm));
      return json({ ok: true, alertas: alertas.sort((a, b) => b.criadoEm.localeCompare(a.criadoEm)), notificacoes: notificacoes.slice(0, 300) });
    }
    if (req.method !== "POST") return json({ ok: false, erro: "Método não aceito." }, 405);
    const corpo = await req.json().catch(() => ({}));
    const { acao } = corpo;

    if (acao === "migrar") {
      // traz para a conta os alertas criados antes do login, com a chave antiga deste aparelho
      const antiga = corpo.chaveAntiga;
      if (!chaveValida(antiga) || antiga === chave) return json({ ok: false, erro: "Chave antiga inválida." }, 400);
      let n = 0;
      for (const prefixo of ["alerta", "notif"]) {
        const { blobs } = await store.list({ prefix: `${prefixo}/${antiga}/` });
        for (const b of blobs) {
          const v = await store.get(b.key, { type: "json" }); if (!v) continue;
          if (prefixo === "alerta") { v.chave = chave; v.corretor = usuario.nome; n++; }
          await store.setJSON(b.key.replace(`${prefixo}/${antiga}/`, `${prefixo}/${chave}/`), v);
          await store.delete(b.key);
        }
      }
      return json({ ok: true, migrados: n });
    }

    if (acao === "salvar") {
      const a = corpo.alerta || {};
      const id = /^[a-z0-9]{8,20}$/.test(a.id || "") ? a.id : Math.random().toString(36).slice(2, 12) + Date.now().toString(36);
      const chaveBlob = `alerta/${chave}/${id}`;
      const antigo = await store.get(chaveBlob, { type: "json" });
      const agora = new Date();
      const novo = {
        ...(antigo || {}), id, chave,
        nome: limpa(a.nome, 100) || "Alerta sem nome",
        corretor: usuario.nome, corretorEmail: usuario.email, cliente: limpa(a.cliente, 60),
        criterios: sanitizarCriterios(a.criterios),
        nivelMin: a.nivelMin === "parcial" ? "parcial" : "alta",
        frequencia: a.frequencia === "semanal" ? "semanal" : "diaria",
        status: a.status === "pausado" ? "pausado" : "ativo",
        criadoEm: antigo?.criadoEm || agora.toISOString(), atualizadoEm: agora.toISOString(),
      };
      const criteriosMudaram = !antigo || JSON.stringify(antigo.criterios) !== JSON.stringify(novo.criterios) || antigo.nivelMin !== novo.nivelMin;
      if (criteriosMudaram) {
        // linha de base: o que já existe hoje aparece em "encontrados"; só anúncios novos geram notificação
        novo.vistos = {};
        try { const p = await carregarPortfolio(); const r = await rodarVerificacao(store, novo, p, { baseline: true, agora }); delete r.alerta.vistos; return json({ ok: true, alerta: r.alerta }); }
        catch (e) { novo.proximaVerificacao = proximaVerificacao(novo.frequencia, agora); await store.setJSON(chaveBlob, novo); delete novo.vistos; return json({ ok: true, alerta: novo, aviso: "Alerta salvo, mas a primeira verificação falhou: " + e.message }); }
      }
      if (novo.status === "ativo" && antigo?.status === "pausado") novo.proximaVerificacao = new Date().toISOString();
      await store.setJSON(chaveBlob, novo);
      delete novo.vistos;
      return json({ ok: true, alerta: novo });
    }
    if (acao === "excluir") {
      const id = limpa(corpo.id, 40);
      await store.delete(`alerta/${chave}/${id}`);
      const ln = await store.list({ prefix: `notif/${chave}/${id}__` });
      await Promise.all(ln.blobs.map((b) => store.delete(b.key)));
      return json({ ok: true });
    }
    if (acao === "verificar") {
      const id = limpa(corpo.id, 40);
      const a = await store.get(`alerta/${chave}/${id}`, { type: "json" });
      if (!a) return json({ ok: false, erro: "Alerta não encontrado." }, 404);
      const p = await carregarPortfolio();
      const r = await rodarVerificacao(store, a, p);
      delete r.alerta.vistos;
      return json({ ok: true, alerta: r.alerta, novos: r.novos });
    }
    if (acao === "lida") {
      const ids = (Array.isArray(corpo.ids) ? corpo.ids : []).slice(0, 300);
      await Promise.all(ids.map(async (nid) => {
        const k = `notif/${chave}/${limpa(nid, 200)}`;
        const n = await store.get(k, { type: "json" });
        if (n && !n.lida) await store.setJSON(k, { ...n, lida: true, lidaEm: new Date().toISOString() });
      }));
      return json({ ok: true });
    }
    return json({ ok: false, erro: "Ação desconhecida." }, 400);
  } catch (e) {
    return json({ ok: false, erro: "Não foi possível concluir: " + e.message }, 500);
  }
};
