// Roda sozinha todo dia às 11:00 UTC (08:00 em Brasília), depois que o catálogo é atualizado no GitHub.
// Verifica os alertas ativos cuja próxima verificação já chegou e grava as notificações novas.
import { getStore } from "@netlify/blobs";
import { rodarVerificacao, carregarPortfolio } from "../../compat.mjs";

export const config = { schedule: "0 11 * * *" };

export default async () => {
  const store = getStore({ name: "radar-alertas", consistency: "strong" });
  const inicio = new Date();
  const registro = { inicio: inicio.toISOString(), verificados: 0, novos: 0, pulados: 0, erro: null };
  try {
    const portfolio = await carregarPortfolio();
    const { blobs } = await store.list({ prefix: "alerta/" });
    for (const b of blobs) {
      if (Date.now() - inicio.getTime() > 22000) { registro.erro = "Tempo limite: os alertas restantes ficam para a próxima execução."; break; }
      const a = await store.get(b.key, { type: "json" });
      if (!a || a.status !== "ativo" || (a.proximaVerificacao && new Date(a.proximaVerificacao) > inicio)) { registro.pulados++; continue; }
      const r = await rodarVerificacao(store, a, portfolio, { agora: inicio });
      registro.verificados++; registro.novos += r.novos;
    }
    registro.versaoPortfolio = portfolio.atualizado_em;
  } catch (e) {
    registro.erro = e.message;
  }
  registro.fim = new Date().toISOString();
  const log = (await store.get("sistema/log-verificacoes", { type: "json" })) || [];
  await store.setJSON("sistema/log-verificacoes", [registro, ...log].slice(0, 60));
  console.log(JSON.stringify(registro));
};
