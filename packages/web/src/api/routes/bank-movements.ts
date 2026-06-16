/**
 * Bank Movements Route — /api/bank-movements
 * Fonte única: tabela bank_transactions (Enable Banking via Turso).
 *
 * PATCH /:id/classificacao — classificação MANUAL pelo utilizador:
 *   1. Grava importType + status="booked" + imported=1 (fora do staging buffer)
 *   2. Se for quota (qualquer tipo), tenta criar/actualizar quota na tabela quotas
 *      para a fração inferida do debtorName/description — sem depender do motor
 *   3. Chama recalcularSaldos() directamente → dashboard actualizado imediatamente
 *
 * Não usa processarStagedTransactions() pois esse motor filtra imported=0 e
 * requer score >= 55 de identifyByMultiMatch para criar a quota. Quando o
 * utilizador classifica manualmente, já temos a intenção explícita — o motor
 * é irrelevante e seria um ponto de falha silenciosa.
 */

import { Hono } from "hono";
import { requireAdmin } from "../middleware/auth";
import { db } from "../database";
import * as schema from "../database/schema";
import { bankTransactions, quotas, fracoes } from "../database/schema";
import { eq, desc, and } from "drizzle-orm";
import { recalcularSaldos } from "./dashboard";

// Classificações mapeadas ao domínio real do condomínio
// importType no DB: "quota" | "quota_obras" | "quota_incendio" | "quota_motor" | "despesa"
const VALID_CLASSIFICATIONS = [
  "quota",
  "quota_obras",
  "quota_incendio",
  "quota_motor",
  "despesa",
] as const;
type Classification = typeof VALID_CLASSIFICATIONS[number];

// Mapear campos DB → shape uniforme para o frontend
function mapRow(r: typeof bankTransactions.$inferSelect) {
  const amount = r.amount ?? 0;
  const tipo: "Entrada" | "Saída" = amount >= 0 ? "Entrada" : "Saída";
  const dateStr = r.date
    ? (r.date instanceof Date ? r.date : new Date(r.date as unknown as number)).toISOString().slice(0, 10)
    : "—";
  return {
    id:                r.id,
    dataOperacao:      dateStr,
    descritivo:        r.description ?? "—",
    montante:          parseFloat(amount.toFixed(2)),
    tipo,
    categoria:         r.importType ?? "Não classificado",
    categoriaSource:   r.importType ? "auto" : "unmatched",
    nomeIdentificado:  r.debtorName ?? r.creditorName ?? undefined,
    notaCategorizacao: r.debtorName ?? r.creditorName ?? undefined,
    status:            r.status ?? "pending",
    requiresReview:    !!r.requiresManualReview,
  };
}

export const bankMovementsRoutes = new Hono()

  // GET /api/bank-movements — stats gerais da DB
  .get("/", requireAdmin, async (c) => {
    try {
      const rows = await db.select().from(bankTransactions).orderBy(desc(bankTransactions.date));

      const entradas = rows.filter(r => (r.amount ?? 0) >= 0);
      const saidas   = rows.filter(r => (r.amount ?? 0) < 0);
      const totalEntradas = parseFloat(entradas.reduce((s, r) => s + Math.abs(r.amount ?? 0), 0).toFixed(2));
      const totalSaidas   = parseFloat(saidas.reduce((s, r)   => s + Math.abs(r.amount ?? 0), 0).toFixed(2));
      const saldoFinal    = parseFloat((totalEntradas - totalSaidas).toFixed(2));

      // Categorias únicas
      const catMap: Record<string, { count: number; total: number }> = {};
      for (const r of rows) {
        const cat = r.importType ?? "Não classificado";
        if (!catMap[cat]) catMap[cat] = { count: 0, total: 0 };
        catMap[cat].count++;
        catMap[cat].total += Math.abs(r.amount ?? 0);
      }

      const naoClas = rows.filter(r => !r.importType).length;

      return c.json({
        ok: true,
        fonte: "db",
        csvDisponivel: false,
        condominio: rows.length > 0 ? {
          totalMovimentos: rows.length,
          estatisticas: {
            entradas:     entradas.length,
            saidas:       saidas.length,
            totalEntradas,
            totalSaidas,
            saldoFinal,
            categorizados:      rows.length - naoClas,
            naoCategorizado:    naoClas,
            despesasBancarias:  0,
            porFracao:    {},
            porCategoria: catMap,
            pagamentosNaoIdentificados: [],
          },
        } : null,
        obras: null,
      });
    } catch (e: any) {
      return c.json({ ok: false, error: e.message }, 500);
    }
  })

  // GET /api/bank-movements/condominio — lista paginada com filtros
  .get("/condominio", requireAdmin, async (c) => {
    try {
      const categoria = c.req.query("categoria");
      const tipo      = c.req.query("tipo");   // "Entrada" | "Saída"
      const page      = parseInt(c.req.query("page") ?? "1");
      const pageSize  = parseInt(c.req.query("pageSize") ?? "50");

      const rows = await db.select().from(bankTransactions).orderBy(desc(bankTransactions.date));

      let mapped = rows.map(mapRow);

      if (categoria) mapped = mapped.filter(m => m.categoria === categoria);
      if (tipo)      mapped = mapped.filter(m => m.tipo === tipo);

      const total = mapped.length;
      const start = (page - 1) * pageSize;
      const paged = mapped.slice(start, start + pageSize);

      return c.json({
        ok: true,
        fonte: "db",
        total,
        page,
        pageSize,
        pages: Math.ceil(total / pageSize),
        movimentos: paged,
      });
    } catch (e: any) {
      return c.json({ ok: false, error: e.message }, 500);
    }
  })

  // PATCH /api/bank-movements/:id/classificacao — classificação MANUAL
  //
  // Bypass completo ao motor automático (processarStagedTransactions).
  // Fluxo:
  //   1. Lê a TXN para obter amount, date, debtorName
  //   2. Grava importType + status="booked" + imported=1 (sai do staging buffer)
  //      → com imported=1 a TXN deixa de ser contada como "cativo" em calcularValoresCativos()
  //   3. Se a classificação é uma quota (não "despesa"), mapeia para o tipo DB
  //      e tenta criar/actualizar a quota na tabela quotas usando a fração
  //      inferida do debtorName (ex: "L" → fracaoId real)
  //      → com a quota pago=true, recalcularSaldos() soma o valor ao saldo_conta_corrente
  //   4. Chama recalcularSaldos() directamente — sem depender do motor
  .patch("/:id/classificacao", requireAdmin, async (c) => {
    try {
      const id = c.req.param("id");
      const body = await c.req.json<{ classificacao: string; fracaoId?: string; debtorName?: string }>();
      const classificacao = body.classificacao as Classification;

      if (!VALID_CLASSIFICATIONS.includes(classificacao)) {
        return c.json({
          ok: false,
          error: `Classificação inválida. Valores permitidos: ${VALID_CLASSIFICATIONS.join(", ")}`,
        }, 400);
      }

      // LOG de diagnóstico — visível nos logs do servidor
      console.log(`[PATCH classificacao] id=${id} classificacao=${classificacao} body.debtorName=${body.debtorName ?? "(none)"} fracaoId=${body.fracaoId ?? "(none)"}`);

      // ── Passo 1: Ler TXN ──────────────────────────────────────────────────
      const [txn] = await db
        .select()
        .from(bankTransactions)
        .where(eq(bankTransactions.id, id))
        .limit(1);

      if (!txn) {
        return c.json({ ok: false, error: "Transação não encontrada" }, 404);
      }

      // ── Passo 2: Gravar classificação — imported=1, status=booked ─────────
      // imported=1 → TXN sai do staging buffer:
      //   • calcularValoresCativos() filtra imported=0, logo o montante deixa
      //     de ser contado como "cativo" (dinheiro congelado sem destino)
      //   • O dashboard pára de subtrair este valor do saldo_operacional_disponivel
      // status="booked" → confirmação de que é dinheiro real liquidado
      await db
        .update(bankTransactions)
        .set({
          importType: classificacao,
          status: "booked",
          imported: 1,
          requiresManualReview: 0,
        })
        .where(eq(bankTransactions.id, id));

      // ── Passo 3: Mapear classificação → tipo quota + criar/actualizar quota ─
      // Mapa importType → tipo na tabela quotas
      // "quota"          → "condominio"  (conta corrente principal)
      // "quota_obras"    → "obras"       (gaveta obras)
      // "quota_incendio" → "extra"       (seguro incêndio — tipo extra)
      // "quota_motor"    → "extra"       (portão motor — tipo extra)
      // "despesa"        → null (não gera quota)
      const QUOTA_TIPO_MAP: Record<Classification, string | null> = {
        quota:          "condominio",
        quota_obras:    "obras",
        quota_incendio: "extra",
        quota_motor:    "extra",
        despesa:        null,
      };
      const quotaTipo = QUOTA_TIPO_MAP[classificacao];

      let quotaCriada = false;
      let quotaId: string | null = null;

      if (quotaTipo !== null) {
        // Inferir fração: fracaoId do body > debtorName do frontend > debtorName da DB > creditorName
        // body.debtorName vem do campo nomeIdentificado da linha na UI
        const fracaoNumero = (
          body.fracaoId
          ?? body.debtorName?.trim()
          ?? txn.debtorName?.trim()
          ?? txn.creditorName?.trim()
        )?.toUpperCase();

        console.log(`[PATCH classificacao] quotaTipo=${quotaTipo} fracaoNumero=${fracaoNumero ?? "(none)"} txn.debtorName=${txn.debtorName ?? "(none)"} txn.creditorName=${txn.creditorName ?? "(none)"}`);

        if (fracaoNumero) {
          // Procurar fração na DB (match por numero)
          const allFracoes = await db
            .select({ id: fracoes.id, numero: fracoes.numero })
            .from(fracoes);

          // Tentar match directo ou como prefixo (ex: "L " → "L")
          const fracaoMatch = allFracoes.find(f =>
            f.numero.toUpperCase() === fracaoNumero ||
            fracaoNumero.startsWith(f.numero.toUpperCase() + " ")
          );

          console.log(`[PATCH classificacao] fracaoMatch=${fracaoMatch ? `id=${fracaoMatch.id} num=${fracaoMatch.numero}` : "NENHUMA"}`);

          if (fracaoMatch) {
            const txDate = txn.date instanceof Date
              ? txn.date
              : new Date((txn.date as unknown as number) * 1000);
            const mes = txDate.getMonth() + 1;
            const ano = txDate.getFullYear();
            const valor = Math.abs(txn.amount ?? 0);

            // Dedup: quota já existe para esta fração/mês/ano/tipo?
            const existing = await db
              .select({ id: quotas.id })
              .from(quotas)
              .where(and(
                eq(quotas.fracaoId, fracaoMatch.id),
                eq(quotas.mes, mes),
                eq(quotas.ano, ano),
                eq(quotas.tipo, quotaTipo),
              ))
              .limit(1);

            if (existing.length > 0) {
              // Actualizar para pago=true
              await db
                .update(quotas)
                .set({
                  pago: true,
                  valor,
                  dataPagamento: txDate,
                  metodoPagamento: "transferência",
                  observacoes: `[manual:${classificacao}] id:${id}`,
                })
                .where(eq(quotas.id, existing[0].id));
              quotaId = existing[0].id;
            } else {
              // Criar nova quota paga
              const inserted = await db
                .insert(quotas)
                .values({
                  fracaoId: fracaoMatch.id,
                  tipo: quotaTipo,
                  mes,
                  ano,
                  valor,
                  fundoReserva: parseFloat((valor * 0.1).toFixed(2)),
                  pago: true,
                  dataPagamento: txDate,
                  metodoPagamento: "transferência",
                  observacoes: `[manual:${classificacao}] id:${id}`,
                })
                .returning({ id: quotas.id });
              quotaId = inserted[0].id;
            }

            // Ligar a quota à TXN
            if (quotaId) {
              await db
                .update(bankTransactions)
                .set({ importRefId: quotaId })
                .where(eq(bankTransactions.id, id));
              quotaCriada = true;
            }
          }
        }
      }

      // ── Passo 4: Recalcular saldos do dashboard ────────────────────────────
      // Invocação directa — sem depender do motor.
      // recalcularSaldos() vai agora:
      //   • NÃO contar a TXN como cativo (imported=1)
      //   • Se quota foi criada: somar q.valor ao saldo_conta_corrente (pago=true)
      await recalcularSaldos();

      console.log(`[PATCH classificacao] DONE id=${id} quotaCriada=${quotaCriada} quotaId=${quotaId ?? "none"}`);

      return c.json({
        ok: true,
        id,
        importType: classificacao,
        quotaCriada,
        quotaId,
      });
    } catch (e: any) {
      return c.json({ ok: false, error: e.message }, 500);
    }
  })

  // GET /api/bank-movements/categorias — distribuição por categoria
  .get("/categorias", requireAdmin, async (c) => {
    try {
      const rows = await db.select().from(bankTransactions);

      const catMap: Record<string, { count: number; total: number }> = {};
      for (const r of rows) {
        const cat = r.importType ?? "Não classificado";
        if (!catMap[cat]) catMap[cat] = { count: 0, total: 0 };
        catMap[cat].count++;
        catMap[cat].total += Math.abs(r.amount ?? 0);
      }

      const categorias = Object.entries(catMap)
        .map(([cat, s]) => ({ categoria: cat, count: s.count, total: parseFloat(s.total.toFixed(2)) }))
        .sort((a, b) => b.total - a.total);

      return c.json({ ok: true, categorias });
    } catch (e: any) {
      return c.json({ ok: false, error: e.message }, 500);
    }
  })

  // GET /api/bank-movements/resumo-fracoes — stub (sem CSV, sem dados por fração)
  .get("/resumo-fracoes", requireAdmin, async (c) => {
    return c.json({ ok: true, resumo: [] });
  })

  // GET /api/bank-movements/reconciliacao — reconciliação básica da DB
  .get("/reconciliacao", requireAdmin, async (c) => {
    try {
      const rows = await db.select().from(bankTransactions);

      const bySource = { csv: 0, auto: rows.filter(r => !!r.importType).length, unmatched: rows.filter(r => !r.importType).length };
      const pct = rows.length > 0
        ? parseFloat(((bySource.auto / rows.length) * 100).toFixed(1))
        : 0;

      return c.json({
        ok: true,
        resumo: {
          totalMovimentos: rows.length,
          porSource: bySource,
          percentagemCategorizado: pct,
          totalEntradas: rows.filter(r => (r.amount ?? 0) >= 0).reduce((s, r) => s + (r.amount ?? 0), 0),
          categorizadosAuto: bySource.auto,
        },
        portaoStatus: [],
        autoCatEntradas: rows
          .filter(r => !!r.importType && (r.amount ?? 0) >= 0)
          .map(r => ({
            data:         r.date ? (r.date instanceof Date ? r.date : new Date(r.date as unknown as number)).toISOString().slice(0, 10) : "—",
            descritivo:   r.description ?? "—",
            montante:     r.amount ?? 0,
            categoria:    r.importType ?? "—",
            subCategoria: "",
            nota:         r.debtorName ?? r.creditorName ?? "—",
          }))
          .slice(0, 200),
      });
    } catch (e: any) {
      return c.json({ ok: false, error: e.message }, 500);
    }
  });
