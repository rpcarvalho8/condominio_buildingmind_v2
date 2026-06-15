/**
 * Identity Routes — API para a Matriz de Identidade
 *
 * GET  /api/identity/fracoes           — lista completa da matriz
 * GET  /api/identity/fracoes/:id       — detalhe de uma fração
 * GET   /api/identity/fracoes/iban/:iban       — frações associadas a um IBAN
 * POST  /api/identity/identify                — identifica fração por múltiplos critérios
 * POST  /api/identity/learn-iban              — regista manualmente novo IBAN
 * PATCH /api/identity/fracoes/:id/dividas     — amortiza manualmente dívidas de uma fração
 * GET   /api/identity/dividas                 — sumário de dívidas por tipo
 */

import { Hono } from "hono";
import { requireAdmin } from "../middleware/auth";
import { db } from "../database";
import { fracoes } from "../database/schema";
import { eq, sql } from "drizzle-orm";
import {
  MATRIZ_PROPRIEDADES,
  getFracaoById,
  getFracaoByIBAN,
  identifyByMultiMatch,
  learnIBAN,
  getFracoesComDividas,
  totalDividasPorTipo,
  processarCascataAmortizacao,
  type DividasAtuais,
} from "../lib/identity-matrix";

export const identityRoutes = new Hono()

  // ── GET /api/identity/fracoes ──────────────────────────────────────────────
  .get("/fracoes", requireAdmin, (c) => {
    return c.json({
      total: MATRIZ_PROPRIEDADES.length,
      fracoes: MATRIZ_PROPRIEDADES,
    });
  })

  // ── GET /api/identity/fracoes/:id ──────────────────────────────────────────
  .get("/fracoes/:id", requireAdmin, (c) => {
    const id = c.req.param("id");
    const fracao = getFracaoById(id);
    if (!fracao) return c.json({ error: `Fração '${id}' não encontrada` }, 404);
    return c.json(fracao);
  })

  // ── GET /api/identity/fracoes/iban/:iban ───────────────────────────────────
  .get("/fracoes/iban/:iban", requireAdmin, async (c) => {
    const iban = c.req.param("iban");
    const fracoes = await getFracaoByIBAN(iban);
    return c.json({
      iban,
      found: fracoes.length,
      fracoes,
    });
  })

  // ── POST /api/identity/identify ────────────────────────────────────────────
  // Body: { descricao, amount, ibanSender?, debtorName? }
  .post("/identify", requireAdmin, async (c) => {
    let body: any;
    try { body = await c.req.json(); } catch {
      return c.json({ error: "Body JSON inválido" }, 400);
    }

    const { descricao, amount, ibanSender, debtorName } = body;

    if (!descricao || typeof amount !== "number") {
      return c.json({ error: "Campos obrigatórios: descricao (string), amount (number)" }, 400);
    }

    const result = await identifyByMultiMatch({ descricao, amount, ibanSender, debtorName });

    if (!result) {
      return c.json({
        identificado: false,
        mensagem: "Não foi possível identificar a fração com confiança suficiente (score < 55 ou < 2 critérios)",
      });
    }

    return c.json({
      identificado: true,
      fracao: result.fracao,
      confidence: result.confidence,
      criterios: result.criterios,
      ibanNovoAprendido: result.ibanNovoAprendido,
    });
  })

  // ── POST /api/identity/learn-iban ──────────────────────────────────────────
  // Body: { idFracao, iban }
  .post("/learn-iban", requireAdmin, async (c) => {
    let body: any;
    try { body = await c.req.json(); } catch {
      return c.json({ error: "Body JSON inválido" }, 400);
    }

    const { idFracao, iban } = body;
    if (!idFracao || !iban) {
      return c.json({ error: "Campos obrigatórios: idFracao, iban" }, 400);
    }

    const fracao = getFracaoById(idFracao);
    if (!fracao) return c.json({ error: `Fração '${idFracao}' não encontrada` }, 404);

    const aprendido = await learnIBAN(idFracao, iban);

    return c.json({
      ok: true,
      ibanNovoAprendido: aprendido,
      mensagem: aprendido
        ? `IBAN ${iban} registado como novo para fração ${idFracao}`
        : `IBAN ${iban} já estava associado à fração ${idFracao}`,
      ibansConhecidos: fracao.ibansConhecidos,
    });
  })

  // ── PATCH /api/identity/fracoes/:id/dividas ───────────────────────────────
  // Subtrai manualmente valores das dívidas de uma fração (valores pagos, não novos totais).
  // Body: { obras?, incendio?, indaqua?, motor? }  — todos opcionais, todos em €
  .patch("/fracoes/:id/dividas", requireAdmin, async (c) => {
    const id = c.req.param("id");
    const fracao = getFracaoById(id);
    if (!fracao) return c.json({ error: `Fração '${id}' não encontrada na matriz` }, 404);

    let body: Partial<DividasAtuais>;
    try { body = await c.req.json(); } catch {
      return c.json({ error: "Body JSON inválido" }, 400);
    }

    // Validar: todos os valores devem ser números não-negativos
    for (const key of ["obras", "incendio", "indaqua", "motor"] as const) {
      if (key in body && (typeof body[key] !== "number" || body[key]! < 0)) {
        return c.json({ error: `Campo '${key}' deve ser número >= 0` }, 400);
      }
    }

    // Buscar fração na BD para obter o ID UUID
    const rows = await db.run(
      sql`SELECT id, obras_divida, incendio_divida, indaqua_divida, motor_divida
          FROM fracoes WHERE numero = ${fracao.idFracao} LIMIT 1`
    );
    const row = (rows as any).rows?.[0];
    if (!row) return c.json({ error: `Fração '${id}' não encontrada na BD — sincronizar seed` }, 404);

    const fracaoDBId: string = row.id as string;
    const dividasAntes: DividasAtuais = {
      obras:    parseFloat(row.obras_divida as string | number ?? 0) || 0,
      incendio: parseFloat(row.incendio_divida as string | number ?? 0) || 0,
      indaqua:  parseFloat(row.indaqua_divida as string | number ?? 0) || 0,
      motor:    parseFloat(row.motor_divida as string | number ?? 0) || 0,
    };

    // Calcular novos valores (subtrair o pago, clampado a 0)
    const novas: DividasAtuais = {
      obras:    parseFloat(Math.max(0, dividasAntes.obras    - (body.obras    ?? 0)).toFixed(2)),
      incendio: parseFloat(Math.max(0, dividasAntes.incendio - (body.incendio ?? 0)).toFixed(2)),
      indaqua:  parseFloat(Math.max(0, dividasAntes.indaqua  - (body.indaqua  ?? 0)).toFixed(2)),
      motor:    parseFloat(Math.max(0, dividasAntes.motor    - (body.motor    ?? 0)).toFixed(2)),
    };

    // Persistir em BD
    await db.run(
      sql`UPDATE fracoes
          SET obras_divida    = ${novas.obras},
              incendio_divida = ${novas.incendio},
              indaqua_divida  = ${novas.indaqua},
              motor_divida    = ${novas.motor}
          WHERE id = ${fracaoDBId}`
    );

    // Actualizar memória
    fracao.dividasAtuais.obras    = novas.obras;
    fracao.dividasAtuais.incendio = novas.incendio;
    fracao.dividasAtuais.indaqua  = novas.indaqua;
    fracao.dividasAtuais.motor    = novas.motor;

    return c.json({
      ok: true,
      idFracao: id,
      dividasAntes,
      pagoAgora: {
        obras:    body.obras    ?? 0,
        incendio: body.incendio ?? 0,
        indaqua:  body.indaqua  ?? 0,
        motor:    body.motor    ?? 0,
      },
      dividasDepois: novas,
    });
  })

  // ── GET /api/identity/dividas ──────────────────────────────────────────────
  .get("/dividas", requireAdmin, (c) => {
    const totais = totalDividasPorTipo();
    const comDividas = getFracoesComDividas();

    return c.json({
      totais,
      totalGeral: totais.obras + totais.incendio + totais.indaqua + totais.motor,
      fracoesComDividas: comDividas.length,
      detalhe: comDividas.map((f) => ({
        idFracao: f.idFracao,
        nomeProprietario: f.nomeProprietario,
        descricao: f.descricao,
        dividasAtuais: f.dividasAtuais,
        totalDivida: Object.values(f.dividasAtuais).reduce((s, v) => s + v, 0),
      })),
    });
  });
