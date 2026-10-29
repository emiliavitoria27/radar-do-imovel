// Login individual do Radar do Imóvel.
// - Só e-mails @novasaopaulo.com.br.
// - Senhas guardadas com scrypt + sal aleatório (nunca a senha em si).
// - Sessão em cookie HttpOnly assinado com HMAC; o segredo é gerado sozinho e fica no Netlify Blobs.
// - A primeira conta criada vira administradora; as seguintes ficam "pendentes" até um administrador aprovar.
import { getStore } from "@netlify/blobs";
import crypto from "node:crypto";

export const config = { path: "/api/auth" };

export const DOMINIO = "novasaopaulo.com.br";
const COOKIE = "radar_sessao";
const DURACAO_S = 14 * 24 * 3600;
const store = () => getStore({ name: "radar-usuarios", consistency: "strong" });

const json = (obj, status = 200, extra = {}) => new Response(JSON.stringify(obj), { status, headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store", ...extra } });
const hashEmail = (e) => crypto.createHash("sha256").update(e).digest("hex");
const normEmail = (e) => String(e || "").trim().toLowerCase();
const b64u = (buf) => Buffer.from(buf).toString("base64url");

function scrypt(senha, sal) {
  return new Promise((ok, erro) => crypto.scrypt(senha, sal, 64, { N: 16384, r: 8, p: 1, maxmem: 64 * 1024 * 1024 }, (e, k) => (e ? erro(e) : ok(k))));
}
async function gerarHash(senha) { const sal = crypto.randomBytes(16); return { sal: sal.toString("hex"), hash: (await scrypt(senha, sal)).toString("hex") }; }
async function confere(senha, u) { const k = await scrypt(senha, Buffer.from(u.sal, "hex")); const h = Buffer.from(u.hash, "hex"); return h.length === k.length && crypto.timingSafeEqual(h, k); }

async function segredo(s) {
  let seg = await s.get("sistema/segredo-sessao", { type: "text" });
  if (!seg) { seg = crypto.randomBytes(48).toString("hex"); await s.set("sistema/segredo-sessao", seg); seg = (await s.get("sistema/segredo-sessao", { type: "text" })) || seg; }
  return seg;
}
async function assinar(dados, s) { const corpo = b64u(JSON.stringify(dados)); const sig = crypto.createHmac("sha256", await segredo(s)).update(corpo).digest("base64url"); return `${corpo}.${sig}`; }
function lerCookie(req) { const m = (req.headers.get("cookie") || "").match(new RegExp(`(?:^|;\\s*)${COOKIE}=([^;]+)`)); return m ? m[1] : null; }
const cookieSessao = (tok) => `${COOKIE}=${tok}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${DURACAO_S}`;
const cookieApagar = `${COOKIE}=; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=0`;
const publico = (u) => ({ id: u.id, email: u.email, nome: u.nome, papel: u.papel, status: u.status, criadoEm: u.criadoEm, ultimoAcesso: u.ultimoAcesso || null, trocarSenha: !!u.trocarSenha });

// Usado pelas outras funções: devolve o usuário logado e ativo, ou null.
export async function usuarioDaSessao(req) {
  const tok = lerCookie(req); if (!tok) return null;
  const s = store();
  const [corpo, sig] = tok.split("."); if (!corpo || !sig) return null;
  const esperado = crypto.createHmac("sha256", await segredo(s)).update(corpo).digest();
  const recebido = Buffer.from(sig, "base64url");
  if (recebido.length !== esperado.length || !crypto.timingSafeEqual(recebido, esperado)) return null;
  let d; try { d = JSON.parse(Buffer.from(corpo, "base64url").toString()); } catch { return null; }
  if (!d.e || !d.exp || d.exp < Date.now() / 1000) return null;
  const u = await s.get(`usuario/${d.e}`, { type: "json" });
  if (!u || u.status !== "ativo" || u.sessaoVersao !== d.v) return null;
  return u;
}
// Bloqueia pedidos vindos de outros sites (proteção extra além do SameSite).
export function origemValida(req) {
  if (req.method === "GET" || req.method === "HEAD") return true;
  const o = req.headers.get("origin"); if (!o) return true;
  try { return new URL(o).host === new URL(req.url).host; } catch { return false; }
}

async function tentativas(s, chave, falhou) {
  const k = `tentativas/${chave}`; const t = (await s.get(k, { type: "json" })) || { n: 0, ate: 0 };
  if (falhou === undefined) return t;
  const novo = falhou ? { n: t.n + 1, ate: t.n + 1 >= 5 ? Date.now() + 15 * 60e3 : 0 } : { n: 0, ate: 0 };
  await s.setJSON(k, novo); return novo;
}
const senhaFraca = (p) => typeof p !== "string" || p.length < 10 || p.length > 200 || !/[A-Za-z]/.test(p) || !/\d/.test(p);

export default async (req) => {
  const s = store();
  if (!origemValida(req)) return json({ ok: false, erro: "Origem não permitida." }, 403);
  try {
    if (req.method === "GET") {
      const u = await usuarioDaSessao(req);
      return u ? json({ ok: true, usuario: publico(u) }) : json({ ok: false, erro: "Não conectado." }, 401);
    }
    if (req.method !== "POST") return json({ ok: false, erro: "Método não aceito." }, 405);
    const b = await req.json().catch(() => ({}));
    const acao = b.acao;

    if (acao === "cadastrar") {
      const email = normEmail(b.email), nome = String(b.nome || "").replace(/[<>]/g, "").trim().slice(0, 60);
      if (!email.endsWith("@" + DOMINIO) || !/^[a-z0-9._%+-]+@/.test(email)) return json({ ok: false, erro: `Use seu e-mail corporativo @${DOMINIO}.` }, 400);
      if (!nome) return json({ ok: false, erro: "Informe seu nome." }, 400);
      if (senhaFraca(b.senha)) return json({ ok: false, erro: "A senha precisa ter pelo menos 10 caracteres, com letras e números." }, 400);
      const k = `usuario/${hashEmail(email)}`;
      if (await s.get(k, { type: "json" })) return json({ ok: false, erro: "Já existe uma conta com esse e-mail. Use “Entrar”." }, 409);
      const { blobs } = await s.list({ prefix: "usuario/" });
      const primeiro = blobs.length === 0;
      const u = { id: "u-" + crypto.randomBytes(16).toString("hex"), email, nome, ...(await gerarHash(b.senha)), papel: primeiro ? "admin" : "corretor", status: primeiro ? "ativo" : "pendente", criadoEm: new Date().toISOString(), sessaoVersao: 1 };
      await s.setJSON(k, u);
      if (!primeiro) return json({ ok: true, pendente: true, mensagem: "Conta criada. Um administrador precisa aprovar seu acesso antes do primeiro login." });
      const tok = await assinar({ e: hashEmail(email), v: u.sessaoVersao, exp: Math.floor(Date.now() / 1000) + DURACAO_S }, s);
      return json({ ok: true, usuario: publico(u), mensagem: "Você é a primeira pessoa cadastrada e virou administradora. Aprove os próximos acessos em “Equipe”." }, 200, { "set-cookie": cookieSessao(tok) });
    }

    if (acao === "entrar") {
      const email = normEmail(b.email), he = hashEmail(email);
      const t = await tentativas(s, he);
      if (t.ate > Date.now()) return json({ ok: false, erro: "Muitas tentativas erradas. Aguarde 15 minutos e tente de novo." }, 429);
      const u = await s.get(`usuario/${he}`, { type: "json" });
      const certo = u ? await confere(String(b.senha || ""), u) : (await scrypt("x", Buffer.alloc(16)), false); // tempo parecido mesmo sem conta
      if (!certo) { await tentativas(s, he, true); return json({ ok: false, erro: "E-mail ou senha incorretos." }, 401); }
      await tentativas(s, he, false);
      if (u.status === "pendente") return json({ ok: false, erro: "Seu acesso ainda não foi aprovado por um administrador." }, 403);
      if (u.status === "bloqueado") return json({ ok: false, erro: "Seu acesso está bloqueado. Fale com um administrador." }, 403);
      u.ultimoAcesso = new Date().toISOString(); await s.setJSON(`usuario/${he}`, u);
      const tok = await assinar({ e: he, v: u.sessaoVersao, exp: Math.floor(Date.now() / 1000) + DURACAO_S }, s);
      return json({ ok: true, usuario: publico(u) }, 200, { "set-cookie": cookieSessao(tok) });
    }

    if (acao === "sair") return json({ ok: true }, 200, { "set-cookie": cookieApagar });

    const eu = await usuarioDaSessao(req);
    if (!eu) return json({ ok: false, erro: "Sessão expirada. Entre de novo." }, 401);
    const kEu = `usuario/${hashEmail(eu.email)}`;

    if (acao === "trocar-senha") {
      if (!(await confere(String(b.atual || ""), eu))) return json({ ok: false, erro: "A senha atual está incorreta." }, 400);
      if (senhaFraca(b.nova)) return json({ ok: false, erro: "A nova senha precisa ter pelo menos 10 caracteres, com letras e números." }, 400);
      Object.assign(eu, await gerarHash(b.nova), { trocarSenha: false, sessaoVersao: eu.sessaoVersao + 1 });
      await s.setJSON(kEu, eu);
      const tok = await assinar({ e: hashEmail(eu.email), v: eu.sessaoVersao, exp: Math.floor(Date.now() / 1000) + DURACAO_S }, s);
      return json({ ok: true, usuario: publico(eu) }, 200, { "set-cookie": cookieSessao(tok) });
    }

    // ----- administração da equipe -----
    if (eu.papel !== "admin") return json({ ok: false, erro: "Só administradores podem fazer isso." }, 403);
    if (acao === "equipe") {
      const { blobs } = await s.list({ prefix: "usuario/" });
      const us = (await Promise.all(blobs.map((x) => s.get(x.key, { type: "json" })))).filter(Boolean).map(publico);
      return json({ ok: true, usuarios: us.sort((a, b) => a.status.localeCompare(b.status) || a.nome.localeCompare(b.nome)) });
    }
    const kAlvo = `usuario/${hashEmail(normEmail(b.email))}`;
    const alvo = await s.get(kAlvo, { type: "json" });
    if (!alvo) return json({ ok: false, erro: "Usuário não encontrado." }, 404);
    if (alvo.id === eu.id && acao !== "redefinir") return json({ ok: false, erro: "Você não pode alterar o próprio acesso por aqui." }, 400);
    if (acao === "aprovar") { alvo.status = "ativo"; }
    else if (acao === "bloquear") { alvo.status = "bloqueado"; alvo.sessaoVersao++; }
    else if (acao === "tornar-admin") { alvo.papel = alvo.papel === "admin" ? "corretor" : "admin"; }
    else if (acao === "redefinir") {
      const temp = crypto.randomBytes(9).toString("base64url").replace(/[-_]/g, "x") + "7a";
      Object.assign(alvo, await gerarHash(temp), { trocarSenha: true, sessaoVersao: alvo.sessaoVersao + 1 });
      await s.setJSON(kAlvo, alvo);
      return json({ ok: true, senhaTemporaria: temp, usuario: publico(alvo) });
    } else return json({ ok: false, erro: "Ação desconhecida." }, 400);
    await s.setJSON(kAlvo, alvo);
    return json({ ok: true, usuario: publico(alvo) });
  } catch (e) {
    return json({ ok: false, erro: "Não foi possível concluir: " + e.message }, 500);
  }
};
