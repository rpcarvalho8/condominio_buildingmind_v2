import { Hono } from "hono";
import { cors } from "hono/cors";
import { auth } from "./auth";
import { authMiddleware } from "./middleware/auth";
import { fracoes } from "./routes/fracoes";
import { quotas } from "./routes/quotas";
import { despesas } from "./routes/despesas";
import { fornecedores } from "./routes/fornecedores";
import { dashboard } from "./routes/dashboard";
import { seed } from "./routes/seed";
import { quotaTiposRoutes } from "./routes/quota-tipos";
import { portal } from "./routes/portal";
import { adminUsers } from "./routes/admin-users";
import { setup } from "./routes/setup";
import { importRoutes } from "./routes/import";
import { bankRoutes, runBankSync } from "./routes/bank";
import { bankMovementsRoutes } from "./routes/bank-movements";
import { recibosRoutes, scheduleRecibosCron, gerarRecibosParaMes } from "./routes/recibos";
import { configuracoesRoutes } from "./routes/configuracoes";
import { relatorioRoutes, scheduleRelatoriosCron } from "./routes/relatorio";
import { avisosRoutes, scheduleAvisosCron, gerarAvisosCobranca, enviarLoteUnificado } from "./routes/avisos";
import { identityRoutes } from "./routes/identity";
import { rehydrateDividasFromDB } from "./lib/identity-matrix";

// ─── Sync imediato no arranque do servidor ────────────────────────────────────
(async () => {
  // P0-1: Rehydratar dívidas da BD antes de qualquer operação matricial
  await rehydrateDividasFromDB();
  try {
    console.log("[bank-startup] A sincronizar banco no arranque...");
    await runBankSync();
    console.log("[bank-startup] Sync concluído.");
  } catch (e) {
    console.error("[bank-startup] Erro no sync inicial:", e);
  }
})();

// ─── 2x daily bank sync (8:00 and 20:00) ─────────────────────────────────────
(function scheduleBankSync() {
  const TWELVE_HOURS = 12 * 60 * 60 * 1000;
  function nextRun() {
    const now = new Date();
    const hours = [8, 20];
    const todayRuns = hours.map(h => {
      const d = new Date(now); d.setHours(h, 0, 0, 0); return d;
    });
    const next = todayRuns.find(d => d > now)
      ?? new Date(todayRuns[0].getTime() + 24 * 60 * 60 * 1000);
    return next.getTime() - now.getTime();
  }
  function scheduleNext() {
    const ms = nextRun();
    console.log(`[bank-cron] Próximo sync em ${Math.round(ms / 60000)} min`);
    setTimeout(async () => {
      try { await runBankSync(); } catch (e) { console.error("[bank-cron] Erro:", e); }
      scheduleNext();
    }, ms);
  }
  scheduleNext();
})();

// ─── Relatório cron (último dia do mês às 23:00) ─────────────────────────────
scheduleRelatoriosCron();

// ─── Aviso legado (substituído pelo cron coordenado abaixo) ──────────────────
scheduleAvisosCron(); // agora é no-op, mantém o export activo

// ─── Cron de Transição Mensal ─────────────────────────────────────────────────
// Regra 2 — Último dia do mês às 23:59:
//   1. Gera Recibos PDF (sem enviar email) para o mês que termina.
//   2. Pré-gera Notas de Cobrança PDF (sem enviar) para o mês que começa.
//
// Regra 3 — Dia 1 do mês às 00:00:
//   1. Envia lote unificado (recibo + nota de cobrança) para cada fração com email.
//   2. O dashboard passa a expor os dados de faturação do novo mês (gatilho de visibilidade).
(function scheduleTransicaoMensalCron() {
  // ── Helper: ms até próximo alvo ──────────────────────────────────────────
  function msUntilTarget(hora: number, minuto: number, diaDeMes: "ultimo" | 1): number {
    const now = new Date();
    let target: Date;
    if (diaDeMes === "ultimo") {
      target = new Date(now.getFullYear(), now.getMonth() + 1, 0, hora, minuto, 0, 0);
      if (target <= now) {
        target = new Date(now.getFullYear(), now.getMonth() + 2, 0, hora, minuto, 0, 0);
      }
    } else {
      target = new Date(now.getFullYear(), now.getMonth() + 1, 1, hora, minuto, 0, 0);
      if (target <= now) {
        target = new Date(now.getFullYear(), now.getMonth() + 2, 1, hora, minuto, 0, 0);
      }
    }
    return target.getTime() - now.getTime();
  }

  // ── Tarefa 23:59 — Último dia do mês ────────────────────────────────────
  function agendarFechoDeMes() {
    const ms = msUntilTarget(23, 59, "ultimo");
    const h = Math.round(ms / 3600000);
    console.log(`[transicao-cron] Fecho de mês agendado em ${h}h (último dia às 23:59)`);
    setTimeout(async () => {
      const now = new Date();
      const mesATerminar = now.getMonth() + 1; // mês corrente que está a fechar
      const anoATerminar = now.getFullYear();
      const mesProximo   = mesATerminar === 12 ? 1 : mesATerminar + 1;
      const anoProximo   = mesATerminar === 12 ? anoATerminar + 1 : anoATerminar;

      console.log(`[transicao-cron] 23:59 — Iniciando fecho de mês ${mesATerminar}/${anoATerminar}`);

      // 1. Gerar recibos do mês que fecha (sem enviar email)
      try {
        const res = await gerarRecibosParaMes(mesATerminar, anoATerminar, { sendEmail: false });
        console.log(`[transicao-cron] Recibos gerados: ${res.gerados} (ignorados: ${res.ignorados}, erros: ${res.erros.length})`);
      } catch (e) {
        console.error("[transicao-cron] Erro ao gerar recibos:", e);
      }

      // 2. Pré-gerar notas de cobrança para o próximo mês (sem enviar email)
      try {
        const res = await gerarAvisosCobranca(mesProximo, anoProximo, { sendEmail: false });
        console.log(`[transicao-cron] Notas de cobrança pré-geradas: ${res.gerados} (mês ${mesProximo}/${anoProximo})`);
      } catch (e) {
        console.error("[transicao-cron] Erro ao pré-gerar notas de cobrança:", e);
      }

      agendarFechoDeMes(); // reagendar para o mês seguinte
    }, ms);
  }

  // ── Tarefa 00:00 — Dia 1 do mês ─────────────────────────────────────────
  function agendarDisparo() {
    const ms = msUntilTarget(0, 0, 1);
    const h = Math.round(ms / 3600000);
    console.log(`[transicao-cron] Disparo agendado em ${h}h (dia 1 às 00:00)`);
    setTimeout(async () => {
      const now = new Date();
      // Mês que acabou = mês anterior ao actual
      const mesRecibo   = now.getMonth() === 0 ? 12 : now.getMonth(); // getMonth() já é o novo mês (0-indexed)
      const anoRecibo   = now.getMonth() === 0 ? now.getFullYear() - 1 : now.getFullYear();
      const mesCobranca = now.getMonth() + 1; // mês actual (novo mês)
      const anoCobranca = now.getFullYear();

      console.log(`[transicao-cron] 00:00 — Enviando lote unificado (recibo ${mesRecibo}/${anoRecibo} + cobrança ${mesCobranca}/${anoCobranca})`);

      try {
        const res = await enviarLoteUnificado(mesRecibo, anoRecibo, mesCobranca, anoCobranca);
        console.log(`[transicao-cron] Lote enviado: ${res.enviados} fracções (erros: ${res.erros.length})`);
        if (res.erros.length > 0) {
          console.error("[transicao-cron] Erros no lote:", res.erros);
        }
      } catch (e) {
        console.error("[transicao-cron] Erro no envio do lote:", e);
      }

      // O dashboard expõe automaticamente os novos valores quando faturacaoMesVisivel()
      // retorna true (dia >= 1 do mês de faturação) — não é necessária acção adicional.
      console.log(`[transicao-cron] Dashboard agora exibe dados de ${mesCobranca}/${anoCobranca} (gatilho automático)`);

      agendarDisparo(); // reagendar para o mês seguinte
    }, ms);
  }

  agendarFechoDeMes();
  agendarDisparo();
})();

// ─── Recibos cron (mantido para compatibilidade — funcionalidade migrada para transicao-cron) ──
scheduleRecibosCron();

const app = new Hono()
  // CORS — must be before everything
  .use(cors({
    origin: (origin) => origin ?? "*",
    credentials: true,
    exposeHeaders: ["set-auth-token"],
  }))
  // Better Auth — mounted BEFORE basePath
  .on(["GET", "POST"], "/api/auth/*", (c) => auth.handler(c.req.raw))
  // Session middleware on all API routes
  .use("/api/*", authMiddleware)
  .basePath("api")
  .get("/health", (c) => c.json({ status: "ok", app: "Gestão Condomínio" }, 200))
  .route("/fracoes", fracoes)
  .route("/quotas", quotas)
  .route("/despesas", despesas)
  .route("/fornecedores", fornecedores)
  .route("/dashboard", dashboard)
  .route("/seed", seed)
  .route("/quota-tipos", quotaTiposRoutes)
  .route("/portal", portal)
  .route("/admin/users", adminUsers)
  .route("/setup", setup)
  .route("/import", importRoutes)
  .route("/bank", bankRoutes)
  .route("/bank-movements", bankMovementsRoutes)
  // Alias para o redirect URI registado na Enable Banking
  .route("/sync/bank", bankRoutes)
  .route("/recibos", recibosRoutes)
  .route("/configuracoes", configuracoesRoutes)
  .route("/relatorio", relatorioRoutes)
  .route("/avisos", avisosRoutes)
  .route("/identity", identityRoutes);

export type AppType = typeof app;
export default app;
