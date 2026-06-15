/**
 * Enable Banking Integration
 * Handles OAuth flow, token storage, and transaction sync
 * 
 * Flow:
 *   1. GET  /api/bank/status          → current connection state
 *   2. GET  /api/bank/connect         → redirect to Enable Banking auth
 *   3. GET  /api/bank/callback        → handle OAuth callback, store tokens
 *   4. POST /api/bank/sync            → fetch transactions + import
 *   5. DELETE /api/bank/disconnect    → remove connection
 */

import { Hono } from "hono";
import { requireAdmin } from "../middleware/auth";
import { db } from "../database";
import * as schema from "../database/schema";
import { eq, desc, and } from "drizzle-orm";
import crypto from "node:crypto";
import { recalcularSaldos } from "./dashboard";
import { identifyByMultiMatch, processarCascataAmortizacao } from "../lib/identity-matrix";

const CLIENT_ID = process.env.ENABLE_BANKING_CLIENT_ID ?? "";
// Support both literal newlines and \n escape sequences in .env
const PRIVATE_KEY_PEM = (process.env.ENABLE_BANKING_PRIVATE_KEY ?? "").replace(/\\n/g, "\n");
const REDIRECT_URI = process.env.ENABLE_BANKING_REDIRECT_URI ?? "http://localhost:4200/api/bank/callback";
const API_BASE = "https://api.enablebanking.com";

// ─── JWT signing (RS256) ──────────────────────────────────────────────────────
function makeJWT(clientId: string, privateKeyPem: string): string {
  const header = Buffer.from(JSON.stringify({ alg: "RS256", typ: "JWT", kid: clientId })).toString("base64url");
  const now = Math.floor(Date.now() / 1000);
  const payload = Buffer.from(JSON.stringify({
    iss: clientId,
    aud: "api.enablebanking.com",
    iat: now,
    exp: now + 3600,
  })).toString("base64url");

  const signing = `${header}.${payload}`;
  const sign = crypto.createSign("RSA-SHA256");
  sign.update(signing);
  // Normalize newlines each call (handles env var edge cases)
  const pem = privateKeyPem.replace(/\\n/g, "\n");
  const sig = sign.sign(pem, "base64url");
  return `${signing}.${sig}`;
}

async function enableBankingFetch(path: string, opts: RequestInit = {}): Promise<any> {
  if (!CLIENT_ID || !PRIVATE_KEY_PEM) {
    throw new Error("Enable Banking não configurado — falta CLIENT_ID ou PRIVATE_KEY");
  }
  const jwt = makeJWT(CLIENT_ID, PRIVATE_KEY_PEM);
  const res = await fetch(`${API_BASE}${path}`, {
    ...opts,
    headers: {
      "Authorization": `Bearer ${jwt}`,
      "Content-Type": "application/json",
      ...(opts.headers ?? {}),
    },
  });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`Enable Banking API ${res.status}: ${body}`);
  }
  return res.json();
}

// ─── Category mapping from Enable Banking transaction data ────────────────────
const KW_MAP: Array<[RegExp, string]> = [
  [/limpez/i, "limpeza"],
  [/jardinage|jardin/i, "jardim"],
  [/elevador/i, "elevadores"],
  [/indaqua|agua|água/i, "agua"],
  [/iberdrola|edp|endesa|eletricidade|electricidade/i, "eletricidade"],
  [/seguro/i, "seguros"],
  [/condom/i, "quota"],
  [/honora|administr/i, "honorarios"],
];

// Administradores do condomínio — pagamentos DBIT para eles = honorários
const ADMIN_NAMES = [
  /SERGIO\s+MIGUEL\s+MONTEIRO/i,
  /RUI\s+CARVALHO/i,
  /CATARINA\s+REIS/i,
];

function isHonorarioDesc(desc: string): boolean {
  return ADMIN_NAMES.some((re) => re.test(desc));
}

function inferCatFromDesc(desc: string): string {
  if (isHonorarioDesc(desc)) return "honorarios";
  for (const [re, m] of KW_MAP) if (re.test(desc)) return m;
  return "outros";
}

function isBankFeeDesc(desc: string): boolean {
  const d = (desc ?? "").toUpperCase();
  return d.includes("IMP.SELO") || d.includes("COMISSAO") || d.includes("COMISSÃO") ||
    d.includes("MANUTENCAO DE CONTA") || d.includes("IMPOSTO DO SELO") ||
    d.includes("RETENÇÃO IRS") || d.includes("RETENCAO IRS") ||
    d.includes("JURO ILIQUIDO") || d.includes("DESPESAS BANCÁR");
}

// Motor Garagem — CRDT com "MOTOR GARAGEM" = cota extra de manutenção/garagem
// Padrão: "MOTOR GARAGEM - FRACAO X" — fração identificada no sufixo
function isMotorGaragemDesc(desc: string): boolean {
  return /MOTOR\s+GARAGEM/i.test(desc);
}

// dedup key — primária por descrição normalizada + valor + dia
function despesaKey(desc: string, valor: number, date: Date): string {
  const day = `${date.getFullYear()}-${date.getMonth()}-${date.getDate()}`;
  return `${desc}|${valor.toFixed(2)}|${day}`;
}

// dedup secundária — valor + dia (ignora descrição; evita duplicados CSV manual vs bank sync)
function despesaKeyValorData(valor: number, date: Date): string {
  const day = `${date.getFullYear()}-${date.getMonth()}-${date.getDate()}`;
  return `${valor.toFixed(2)}|${day}`;
}

// ─── Stage raw transactions into bank_transactions before processing ──────────
// Upserts each transaction by its Enable Banking transaction_id (dedup key).
// Returns only the rows that were newly inserted (not already staged + processed).
async function stageTransactions(
  transactions: any[],
  connectionId: string,
): Promise<{ staged: number; skipped: number }> {
  let staged = 0;
  let skipped = 0;

  for (const tx of transactions) {
    const remittance: string[] = tx.remittance_information ?? tx.remittanceInformation ?? [];
    const description = remittance.length > 0
      ? remittance.join(" ")
      : (tx.creditor?.name ?? tx.debtor?.name ?? tx.creditorName ?? tx.debtorName ?? "");
    const amountStr = tx.transaction_amount?.amount ?? tx.transactionAmount?.amount ?? "0";
    const rawAmount = parseFloat(amountStr);
    const indicator = tx.credit_debit_indicator ?? tx.creditDebitIndicator ?? "";
    const isDebit = indicator === "DBIT" || rawAmount < 0;
    // Store as signed: positive = credit, negative = debit
    const amount = isDebit ? -Math.abs(rawAmount) : Math.abs(rawAmount);
    const dateStr = tx.booking_date ?? tx.bookingDate ?? tx.value_date ?? tx.valueDate ?? "";
    const date = dateStr ? new Date(dateStr) : new Date();
    const txId: string | null = tx.transaction_id ?? tx.transactionId ?? null;
    const creditorName: string | null = tx.creditor?.name ?? tx.creditorName ?? null;
    const debtorName: string | null = tx.debtor?.name ?? tx.debtorName ?? null;

    // Skip if already staged by external transaction_id
    if (txId) {
      const existing = await db
        .select({ id: schema.bankTransactions.id, imported: schema.bankTransactions.imported })
        .from(schema.bankTransactions)
        .where(eq(schema.bankTransactions.transactionId, txId))
        .limit(1);
      if (existing.length > 0) {
        skipped++;
        continue;
      }
    }

    await db.insert(schema.bankTransactions).values({
      connectionId,
      transactionId: txId,
      amount,
      currency: tx.transaction_amount?.currency ?? "EUR",
      date,
      description,
      creditorName,
      debtorName,
      type: indicator || (isDebit ? "DBIT" : "CRDT"),
      status: "pending",
      imported: 0,
      rawData: JSON.stringify(tx),
    });
    staged++;
  }

  return { staged, skipped };
}

// ─── Transaction import logic ─────────────────────────────────────────────────
async function importTransactions(transactions: any[], connectionId?: string): Promise<{
  despesasCreated: number;
  quotasCreated: number;
  quotasUpdated: number;
  despesasSkipped: number;
  staged: number;
  stagingSkipped: number;
  errors: string[];
}> {
  // ── STEP 1: Stage all raw transactions first ──────────────────────────────
  const stagingResult = connectionId
    ? await stageTransactions(transactions, connectionId)
    : { staged: 0, skipped: 0 };

  const results = {
    despesasCreated: 0, quotasCreated: 0, quotasUpdated: 0, despesasSkipped: 0,
    staged: stagingResult.staged, stagingSkipped: stagingResult.skipped,
    errors: [] as string[],
  };

  const [allFracoes, existingDespesas, existingQuotas, allQuotaTipos] = await Promise.all([
    db.select().from(schema.fracoes),
    db.select({ id: schema.despesas.id, descricao: schema.despesas.descricao, valor: schema.despesas.valor, data: schema.despesas.data }).from(schema.despesas),
    db.select({ id: schema.quotas.id, fracaoId: schema.quotas.fracaoId, mes: schema.quotas.mes, ano: schema.quotas.ano, tipo: schema.quotas.tipo }).from(schema.quotas),
    db.select().from(schema.quotaTipos),
  ]);

  // Build keyword → quotaTipo map for auto-matching
  // keywords field: "MOTOR GARAGEM,PORTAO" (CSV)
  const extraTiposByKeyword: Array<{ tipo: any; kw: string }> = [];
  for (const qt of allQuotaTipos) {
    if (qt.tipo === "extra" && qt.keywords) {
      for (const kw of qt.keywords.split(",")) {
        const k = kw.trim().toUpperCase();
        if (k) extraTiposByKeyword.push({ tipo: qt, kw: k });
      }
    }
  }

  function findExtraTipo(desc: string): any | null {
    const upper = desc.toUpperCase();
    for (const { tipo, kw } of extraTiposByKeyword) {
      if (upper.includes(kw)) return tipo;
    }
    return null;
  }

  const fracaoByNum = new Map(allFracoes.map(f => [f.numero.toUpperCase(), f]));
  const despesaKeys = new Set<string>();
  const despesaKeysValorData = new Set<string>(); // dedup secundário valor+data
  for (const d of existingDespesas) {
    const dDate = d.data instanceof Date ? d.data : new Date((d.data as number) * 1000);
    despesaKeys.add(despesaKey(d.descricao, d.valor, dDate));
    despesaKeysValorData.add(despesaKeyValorData(d.valor, dDate));
  }
  const quotaKeys = new Set<string>(existingQuotas.map(q => `${q.fracaoId}|${q.mes}|${q.ano}|${q.tipo}`));

  const despesasToInsert: any[] = [];
  const quotasToInsert: any[] = [];
  const quotasToUpdate: any[] = [];
  // Cascata: acumulamos durante o loop para processar após batch inserts
  const cascataPendente: Array<{ idFracao: string; fracaoDBId: string; amount: number; mes: number; ano: number }> = [];

  for (const tx of transactions) {
    try {
      // Enable Banking real API shape (snake_case):
      // tx.booking_date, tx.transaction_amount.amount, tx.credit_debit_indicator
      // tx.remittance_information (array of strings), tx.creditor.name, tx.debtor.name
      const remittance: string[] = tx.remittance_information ?? tx.remittanceInformation ?? [];
      const desc = remittance.length > 0
        ? remittance.join(" ")
        : (tx.creditor?.name ?? tx.debtor?.name ?? tx.creditorName ?? tx.debtorName ?? "Sem descrição");
      const amountStr = tx.transaction_amount?.amount ?? tx.transactionAmount?.amount ?? "0";
      const valor = Math.abs(parseFloat(amountStr));
      const dateStr = tx.booking_date ?? tx.bookingDate ?? tx.value_date ?? tx.valueDate ?? "";
      const date = dateStr ? new Date(dateStr) : new Date();
      const indicator = tx.credit_debit_indicator ?? tx.creditDebitIndicator ?? "";
      const isDebit = indicator === "DBIT" || parseFloat(amountStr) < 0;

      if (valor === 0) continue;
      if (isBankFeeDesc(desc)) { results.despesasSkipped++; continue; }

      if (!isDebit) {
        // Entrada — identificar via Matriz de Identidade (multi-critério + auto-learning)
        const ibanSender: string | undefined = tx.debtor?.account?.iban ?? tx.debtorIban ?? undefined;
        const debtorName: string | undefined = tx.debtor?.name ?? tx.debtorName ?? undefined;

        // ── Tentativa 1: Motor Matricial (identifyByMultiMatch) ───────────────
        const matrixResult = await identifyByMultiMatch({
          descricao: desc,
          amount: valor,
          ibanSender,
          debtorName,
        });

        if (matrixResult && matrixResult.confidence >= 55) {
          // Fração identificada com confiança — registar quota
          const fracaoDB = fracaoByNum.get(matrixResult.fracao.idFracao.toUpperCase());
          if (!fracaoDB) {
            results.errors.push(`Fração matriz ${matrixResult.fracao.idFracao} não existe na BD — sincronizar seed`);
            continue;
          }

          // Determinar tipo: extra (motor/elevador) ou condominio
          const extraTipo = findExtraTipo(desc);
          const isExtra = extraTipo || isMotorGaragemDesc(desc);
          const tipoQuota = isExtra ? "extra" : "condominio";

          const mes = date.getMonth() + 1;
          const ano = date.getFullYear();
          const qKey = `${fracaoDB.id}|${mes}|${ano}|${tipoQuota}`;

          if (isExtra && !quotaKeys.has(qKey)) {
            quotaKeys.add(qKey);
            quotasToInsert.push({
              fracaoId: fracaoDB.id,
              tipo: "extra",
              mes, ano, valor,
              fundoReserva: 0,
              quotaTipoId: extraTipo?.id ?? null,
              pago: true, dataPagamento: date, metodoPagamento: "transferência",
              observacoes: `[motor matricial:${matrixResult.confidence}%] ${desc}`,
            });
            results.quotasCreated++;
          } else if (!isExtra) {
            if (quotaKeys.has(qKey)) {
              quotasToUpdate.push({ fracaoId: fracaoDB.id, mes, ano, tipo: "condominio", valor, data: date });
              quotaKeys.delete(qKey);
              results.quotasUpdated++;
            } else {
              quotaKeys.add(qKey);
              quotasToInsert.push({
                fracaoId: fracaoDB.id, tipo: "condominio", mes, ano, valor,
                fundoReserva: parseFloat((valor * 0.1).toFixed(2)),
                pago: true, dataPagamento: date, metodoPagamento: "transferência",
                observacoes: `[motor matricial:${matrixResult.confidence}% criterios:${matrixResult.criterios.join("+")}]${matrixResult.ibanNovoAprendido ? " [IBAN aprendido]" : ""}`,
              });
              results.quotasCreated++;
            }
            // Cascata: agendar amortização de dívidas com o excesso deste pagamento
            cascataPendente.push({
              idFracao: matrixResult.fracao.idFracao,
              fracaoDBId: fracaoDB.id,
              amount: valor,
              mes,
              ano,
            });
          }
          continue;
        }

        // ── Tentativa 2: Fallback regex simples (compatibilidade legacy) ──────
        const descUpper = desc.toUpperCase();
        const extraTipo = findExtraTipo(desc);
        if (extraTipo || isMotorGaragemDesc(desc)) {
          let fracaoNum = "";
          const mgMatch = descUpper.match(/FRACA[OÃ]O\s+([A-Z]{1,2})\b/);
          if (mgMatch) fracaoNum = mgMatch[1];
          if (!fracaoNum) {
            const mgSimple = descUpper.match(/MOTOR\s+GARAGEM\s*[-–]\s*([A-Z]{1,2})\b/);
            if (mgSimple) fracaoNum = mgSimple[1];
          }
          if (!fracaoNum) {
            const trailingLetter = descUpper.match(/\b([A-Z]{1,2})\s*$/);
            if (trailingLetter) fracaoNum = trailingLetter[1];
          }
          const fracao = fracaoNum ? fracaoByNum.get(fracaoNum) : undefined;
          if (!fracao) {
            results.errors.push(`Cota extra (${extraTipo?.nome ?? "Motor Garagem"}): fração não identificada em "${desc.slice(0, 60)}"`);
            continue;
          }
          const mes = date.getMonth() + 1;
          const ano = date.getFullYear();
          const qKey = `${fracao.id}|${mes}|${ano}|extra`;
          if (!quotaKeys.has(qKey)) {
            quotaKeys.add(qKey);
            quotasToInsert.push({
              fracaoId: fracao.id, tipo: "extra", mes, ano, valor,
              fundoReserva: 0, quotaTipoId: extraTipo?.id ?? null,
              pago: true, dataPagamento: date, metodoPagamento: "transferência",
              observacoes: desc,
            });
            results.quotasCreated++;
          }
          continue;
        }

        const isQuota = descUpper.includes("CONDOM") || descUpper.includes("QUOTA") ||
          descUpper.includes("FRACAO") || descUpper.includes("FRAÇÃO") ||
          /\bENTRADA\b/.test(descUpper);
        if (!isQuota) continue;

        let fracaoNum = "";
        const fracaoExplicit = descUpper.match(/FRACA[OÃ]O\s+([A-Z]{1,2})\b/);
        if (fracaoExplicit) fracaoNum = fracaoExplicit[1];
        if (!fracaoNum) {
          const entradaMatch = descUpper.match(/ENTRADA\s+\d+\s+([A-Z]{1,2})\b/);
          if (entradaMatch) fracaoNum = entradaMatch[1];
        }
        if (!fracaoNum) {
          const standaloneMatch = descUpper.match(/\s([A-Z]{1,2})-\d{5,}/);
          if (standaloneMatch) fracaoNum = standaloneMatch[1];
        }
        const fracao = fracaoNum ? fracaoByNum.get(fracaoNum) : undefined;
        if (!fracao) {
          results.errors.push(`Fração não identificada (matriz+regex): ${desc.slice(0, 60)}`);
          continue;
        }
        const mes = date.getMonth() + 1;
        const ano = date.getFullYear();
        const qKey = `${fracao.id}|${mes}|${ano}|condominio`;
        if (quotaKeys.has(qKey)) {
          quotasToUpdate.push({ fracaoId: fracao.id, mes, ano, tipo: "condominio", valor, data: date });
          quotaKeys.delete(qKey);
          results.quotasUpdated++;
        } else {
          quotaKeys.add(qKey);
          quotasToInsert.push({
            fracaoId: fracao.id, tipo: "condominio", mes, ano, valor,
            fundoReserva: parseFloat((valor * 0.1).toFixed(2)),
            pago: true, dataPagamento: date, metodoPagamento: "transferência",
          });
          results.quotasCreated++;
        }
      } else {
        // Saída — despesa
        const dKey = despesaKey(desc, valor, date);
        const dKeyVD = despesaKeyValorData(valor, date);
        // dedup primário: desc+valor+data; secundário: valor+data (evita CSV manual vs bank sync)
        if (despesaKeys.has(dKey) || despesaKeysValorData.has(dKeyVD)) { results.despesasSkipped++; continue; }
        despesaKeys.add(dKey);
        despesaKeysValorData.add(dKeyVD);
        despesasToInsert.push({
          descricao: desc,
          categoria: inferCatFromDesc(desc),
          valor, data: date,
          recorrente: false, fornecedorId: null, notas: null, faturaUrl: null, subcategoria: null,
        });
        results.despesasCreated++;
      }
    } catch (e: any) {
      results.errors.push(e.message);
    }
  }

  // Batch writes
  const BATCH = 50;
  const insertedDespesaIds: string[] = [];
  for (let i = 0; i < despesasToInsert.length; i += BATCH) {
    const inserted = await db.insert(schema.despesas).values(despesasToInsert.slice(i, i + BATCH)).returning({ id: schema.despesas.id });
    insertedDespesaIds.push(...inserted.map(r => r.id));
  }
  const insertedQuotaIds: string[] = [];
  for (let i = 0; i < quotasToInsert.length; i += BATCH) {
    const inserted = await db.insert(schema.quotas).values(quotasToInsert.slice(i, i + BATCH)).returning({ id: schema.quotas.id });
    insertedQuotaIds.push(...inserted.map(r => r.id));
  }
  for (const q of quotasToUpdate) {
    await db.update(schema.quotas)
      .set({ pago: true, valor: q.valor, dataPagamento: q.data, metodoPagamento: "transferência" })
      .where(and(
        eq(schema.quotas.fracaoId, q.fracaoId),
        eq(schema.quotas.mes, q.mes),
        eq(schema.quotas.ano, q.ano),
        eq(schema.quotas.tipo, q.tipo),
      ));
  }

  // ── STEP 2b: Cascata de Amortização Dinâmica ─────────────────────────────
  // Processa depois dos batch inserts para garantir que a quota foi criada antes de amortizar.
  for (const entrada of cascataPendente) {
    try {
      await processarCascataAmortizacao(
        entrada.idFracao,
        entrada.amount,
        entrada.fracaoDBId,
        entrada.mes,
        entrada.ano,
      );
    } catch (e: any) {
      results.errors.push(`[cascata] ${entrada.idFracao}: ${e.message}`);
    }
  }

  // ── STEP 3: Mark staged transactions as imported=1 ────────────────────────
  // For each processed transaction, find its staged row by transactionId and update.
  // We also mark any CRDT entries that were skipped (bank fees, ignored) as imported=1 status=ignored
  // to prevent them from appearing as "cativos" forever.
  if (connectionId) {
    for (const tx of transactions) {
      const txId: string | null = tx.transaction_id ?? tx.transactionId ?? null;
      if (!txId) continue;
      const amountStr = tx.transaction_amount?.amount ?? tx.transactionAmount?.amount ?? "0";
      const rawAmount = parseFloat(amountStr);
      const indicator = tx.credit_debit_indicator ?? tx.creditDebitIndicator ?? "";
      const isDebit = indicator === "DBIT" || rawAmount < 0;
      const desc = (() => {
        const r: string[] = tx.remittance_information ?? tx.remittanceInformation ?? [];
        return r.length > 0 ? r.join(" ") : (tx.creditor?.name ?? tx.debtor?.name ?? "");
      })();

      // Determine what happened to this tx:
      let importType: string | null = null;
      let status = "processed";
      if (isBankFeeDesc(desc)) {
        importType = null; status = "ignored";
      } else if (isDebit) {
        importType = "despesa";
      } else {
        // credit — quota ou ignored
        const extraTipo = (() => {
          const upper = desc.toUpperCase();
          for (const { tipo, kw } of extraTiposByKeyword) {
            if (upper.includes(kw)) return tipo;
          }
          return null;
        })();
        if (extraTipo || isMotorGaragemDesc(desc)) {
          importType = "quota";
        } else {
          const descUpper = desc.toUpperCase();
          const isQuota = descUpper.includes("CONDOM") || descUpper.includes("QUOTA") ||
            descUpper.includes("FRACAO") || descUpper.includes("FRAÇÃO") ||
            /\bENTRADA\b/.test(descUpper);
          importType = isQuota ? "quota" : null;
          if (!importType) status = "ignored";
        }
      }

      await db.update(schema.bankTransactions)
        .set({ imported: 1, status, importType })
        .where(eq(schema.bankTransactions.transactionId, txId));
    }
  }

  return results;
}

// ─── Process Staged Transactions ─────────────────────────────────────────────
// Lê todas as bank_transactions com imported=0, corre o motor matricial
// e a cascata de amortização, e atualiza flags.
// Retorna sumário do processamento.
export async function processarStagedTransactions(): Promise<{
  processed: number;
  manualReview: number;
  errors: string[];
  details: Array<{ transactionId: string; result: "processed" | "manual_review" | "error"; fracao?: string; score?: number; motivo?: string }>;
}> {
  const summary = {
    processed: 0,
    manualReview: 0,
    errors: [] as string[],
    details: [] as Array<{ transactionId: string; result: "processed" | "manual_review" | "error"; fracao?: string; score?: number; motivo?: string }>,
  };

  // Buscar todas as TXNs pendentes (imported=0)
  const pendentes = await db
    .select()
    .from(schema.bankTransactions)
    .where(eq(schema.bankTransactions.imported, 0));

  if (pendentes.length === 0) return summary;

  // Carregar frações uma vez
  const allFracoes = await db.select().from(schema.fracoes);
  const fracaoByNum = new Map(allFracoes.map(f => [f.numero.toUpperCase(), f]));

  for (const txn of pendentes) {
    const txId = txn.transactionId ?? txn.id;
    try {
      // Só processamos créditos (entradas) — débitos já processados via importTransactions
      if (txn.type === "DBIT" || (txn.amount ?? 0) < 0) {
        // Débito sem connectionId: marcar como processed/ignored sem cascata
        await db.update(schema.bankTransactions)
          .set({ imported: 1, status: "ignored", importType: "despesa" })
          .where(eq(schema.bankTransactions.id, txn.id));
        summary.details.push({ transactionId: txId, result: "processed", motivo: "débito ignorado no process-staged" });
        summary.processed++;
        continue;
      }

      // Extrair IBAN do rawData — suporta tanto o formato Enable Banking real
      // como o formato simplificado dos seeds QA: { iban_sender: "PTxx..." }
      const ibanSender: string | undefined = txn.rawData
        ? (() => {
            try {
              const d = JSON.parse(txn.rawData);
              return d.iban_sender            // formato QA seed / simplificado
                ?? d.debtor?.account?.iban    // Enable Banking real
                ?? d.debtorIban              // camelCase legacy
                ?? undefined;
            } catch { return undefined; }
          })()
        : undefined;

      const matrixResult = await identifyByMultiMatch({
        descricao: txn.description ?? "",
        amount: Math.abs(txn.amount ?? 0),
        ibanSender,
        debtorName: txn.debtorName ?? undefined,
      });

      if (!matrixResult || matrixResult.confidence < 55) {
        // Motor não conseguiu identificar — requires_manual_review
        await db.update(schema.bankTransactions)
          .set({ requiresManualReview: 1, status: "pending" })
          .where(eq(schema.bankTransactions.id, txn.id));
        summary.manualReview++;
        summary.details.push({
          transactionId: txId,
          result: "manual_review",
          score: matrixResult?.confidence ?? 0,
          motivo: matrixResult ? `score ${matrixResult.confidence} < 55 ou < 2 critérios` : "nenhum match",
        });
        continue;
      }

      // Motor identificou — fração confirmada
      const fracaoDB = fracaoByNum.get(matrixResult.fracao.idFracao.toUpperCase());
      if (!fracaoDB) {
        throw new Error(`Fração ${matrixResult.fracao.idFracao} não encontrada na BD`);
      }

      const txDate = txn.date instanceof Date ? txn.date : new Date((txn.date as number) * 1000);
      const mes = txDate.getMonth() + 1;
      const ano = txDate.getFullYear();
      const valor = Math.abs(txn.amount ?? 0);

      // Verificar dedup — não criar quota duplicada
      const existingQuota = await db.select({ id: schema.quotas.id })
        .from(schema.quotas)
        .where(and(
          eq(schema.quotas.fracaoId, fracaoDB.id),
          eq(schema.quotas.mes, mes),
          eq(schema.quotas.ano, ano),
          eq(schema.quotas.tipo, "condominio"),
        ))
        .limit(1);

      let quotaId: string;
      if (existingQuota.length > 0) {
        // Atualizar quota existente para pago=true
        await db.update(schema.quotas)
          .set({ pago: true, valor, dataPagamento: txDate, metodoPagamento: "transferência",
                 observacoes: `[process-staged motor:${matrixResult.confidence}% criterios:${matrixResult.criterios.join("+")}]` })
          .where(eq(schema.quotas.id, existingQuota[0].id));
        quotaId = existingQuota[0].id;
      } else {
        // Inserir nova quota
        const inserted = await db.insert(schema.quotas).values({
          fracaoId: fracaoDB.id,
          tipo: "condominio",
          mes, ano, valor,
          fundoReserva: parseFloat((valor * 0.1).toFixed(2)),
          pago: true,
          dataPagamento: txDate,
          metodoPagamento: "transferência",
          observacoes: `[process-staged motor:${matrixResult.confidence}% criterios:${matrixResult.criterios.join("+")}]${matrixResult.ibanNovoAprendido ? " [IBAN aprendido]" : ""}`,
        }).returning({ id: schema.quotas.id });
        quotaId = inserted[0].id;
      }

      // Cascata de amortização
      await processarCascataAmortizacao(
        matrixResult.fracao.idFracao,
        valor,
        fracaoDB.id,
        mes,
        ano,
      );

      // Marcar TXN como imported=1
      await db.update(schema.bankTransactions)
        .set({
          imported: 1,
          status: "processed",
          importType: "quota",
          importRefId: quotaId,
          requiresManualReview: 0,
        })
        .where(eq(schema.bankTransactions.id, txn.id));

      summary.processed++;
      summary.details.push({
        transactionId: txId,
        result: "processed",
        fracao: matrixResult.fracao.idFracao,
        score: matrixResult.confidence,
        motivo: `criterios: ${matrixResult.criterios.join("+")}`,
      });

    } catch (e: any) {
      summary.errors.push(`[${txId}] ${e.message}`);
      summary.details.push({ transactionId: txId, result: "error", motivo: e.message });
    }
  }

  // Recalcular saldos após processar staged
  try {
    await recalcularSaldos();
  } catch (e: any) {
    summary.errors.push(`[recalcularSaldos] ${e.message}`);
  }

  return summary;
}

// ─── Routes ───────────────────────────────────────────────────────────────────
export const bankRoutes = new Hono()

  // GET /api/bank/status — connection info + last sync
  .get("/status", requireAdmin, async (c) => {
    const isConfigured = !!(CLIENT_ID && PRIVATE_KEY_PEM);
    const conn = await db.select().from(schema.bankConnections).limit(1);
    const lastSync = await db.select().from(schema.bankSyncLogs)
      .orderBy(desc(schema.bankSyncLogs.createdAt)).limit(1);

    return c.json({
      configured: isConfigured,
      connected: conn.length > 0,
      connection: conn[0] ?? null,
      lastSync: lastSync[0] ?? null,
    });
  })

  // GET /api/bank/connect — start OAuth flow
  .get("/connect", requireAdmin, async (c) => {
    if (!CLIENT_ID || !PRIVATE_KEY_PEM) {
      return c.json({ error: "Enable Banking não configurado no servidor" }, 503);
    }
    try {
      // Create a session with Enable Banking — POST /auth
      const data = await enableBankingFetch("/auth", {
        method: "POST",
        body: JSON.stringify({
          aspsp: {
            // Sandbox: "Mock ASPSP" | Produção: "Santander Totta" ou nome exato da API
            name: process.env.ENABLE_BANKING_ASPSP_NAME ?? "Mock ASPSP",
            country: process.env.ENABLE_BANKING_ASPSP_COUNTRY ?? "PT",
          },
          state: crypto.randomUUID(),
          redirect_url: REDIRECT_URI,
          psu_type: "business",
          access: {
            valid_until: new Date(Date.now() + 90 * 24 * 60 * 60 * 1000).toISOString(),
          },
        }),
      });

      return c.json({ authUrl: data.url });
    } catch (err: any) {
      return c.json({ error: err.message }, 500);
    }
  })

  // GET /api/bank/callback — OAuth callback from Enable Banking
  .get("/callback", async (c) => {
    const code = c.req.query("code");
    const state = c.req.query("state");
    const error = c.req.query("error");

    console.log("[bank/callback] code=", code?.slice(0,20), "error=", error, "url=", c.req.url);

    if (error) {
      console.log("[bank/callback] error from provider:", error);
      return c.redirect(`/?bank_error=${encodeURIComponent(error)}`);
    }
    if (!code) {
      return c.redirect("/?bank_error=no_code");
    }

    try {
      // Exchange code for session — POST /sessions
      const data = await enableBankingFetch("/sessions", {
        method: "POST",
        body: JSON.stringify({ code }),
      });

      const sessionId = data.session_id;
      // accounts_data has uid per account
      const accounts: any[] = data.accounts_data ?? data.accounts ?? [];

      // Store connection
      await db.delete(schema.bankConnections); // only one connection at a time
      await db.insert(schema.bankConnections).values({
        sessionId,
        bankName: "Santander Empresas PT",
        accounts: JSON.stringify(accounts),
        status: "active",
        connectedAt: new Date(),
        expiresAt: new Date(Date.now() + 90 * 24 * 60 * 60 * 1000),
      });

      return c.redirect("/importar?bank_connected=1");
    } catch (err: any) {
      return c.redirect(`/importar?bank_error=${encodeURIComponent(err.message)}`);
    }
  })

  // POST /api/bank/sync — fetch transactions + import
  // Body (optional): { date_from: "YYYY-MM-DD", date_to: "YYYY-MM-DD" }
  // If not provided: incremental from last sync, or last 90 days on first run
  .post("/sync", requireAdmin, async (c) => {
    const conn = await db.select().from(schema.bankConnections).limit(1);
    if (conn.length === 0) {
      return c.json({ error: "Sem ligação bancária ativa" }, 400);
    }

    const connection = conn[0];
    const accounts: any[] = JSON.parse(connection.accounts ?? "[]");

    if (accounts.length === 0) {
      return c.json({ error: "Sem contas associadas à ligação" }, 400);
    }

    // Support custom date range from request body
    let body: any = {};
    try { body = await c.req.json(); } catch {}

    let dateFrom: Date;
    let dateTo: Date = new Date();

    if (body.date_from) {
      dateFrom = new Date(body.date_from);
    } else {
      // Incremental: from last sync, or 90 days on first run
      const lastSync = await db.select().from(schema.bankSyncLogs)
        .orderBy(desc(schema.bankSyncLogs.createdAt)).limit(1);
      dateFrom = lastSync[0]?.syncedTo
        ? new Date(lastSync[0].syncedTo as any)
        : new Date(Date.now() - 90 * 24 * 60 * 60 * 1000);
    }
    if (body.date_to) {
      dateTo = new Date(body.date_to);
    }

    // Santander PT via Enable Banking: max ~89 days back from today
    // Cap dateFrom to avoid 422 WRONG_TRANSACTIONS_PERIOD
    const MAX_LOOKBACK_DAYS = 89;
    const earliestAllowed = new Date(Date.now() - MAX_LOOKBACK_DAYS * 24 * 60 * 60 * 1000);
    if (dateFrom < earliestAllowed) {
      console.log(`[bank/sync] dateFrom ${dateFrom.toISOString().slice(0,10)} capped to ${earliestAllowed.toISOString().slice(0,10)} (Santander max ${MAX_LOOKBACK_DAYS} days)`);
      dateFrom = earliestAllowed;
    }

    // Enable Banking has a max window per request (~30 days for Santander PT)
    // Split into 30-day chunks to avoid WRONG_TRANSACTIONS_PERIOD error
    const MAX_DAYS = 30;
    const chunks: Array<{ from: string; to: string }> = [];
    let chunkStart = new Date(dateFrom);
    while (chunkStart < dateTo) {
      const chunkEnd = new Date(chunkStart);
      chunkEnd.setDate(chunkEnd.getDate() + MAX_DAYS);
      if (chunkEnd > dateTo) chunkEnd.setTime(dateTo.getTime());
      chunks.push({
        from: chunkStart.toISOString().slice(0, 10),
        to: chunkEnd.toISOString().slice(0, 10),
      });
      chunkStart = new Date(chunkEnd);
      chunkStart.setDate(chunkStart.getDate() + 1);
    }

    let allTransactions: any[] = [];
    const syncErrors: string[] = [];

    for (const chunk of chunks) {
      for (const acc of accounts) {
        try {
          const data = await enableBankingFetch(
            `/accounts/${acc.uid}/transactions?date_from=${chunk.from}&date_to=${chunk.to}`
          );
          const txns = data.transactions ?? [];
          allTransactions = allTransactions.concat(txns);
          console.log(`[bank/sync] ${chunk.from}→${chunk.to}: ${txns.length} txns`);
        } catch (e: any) {
          syncErrors.push(`Conta ${acc.uid} (${chunk.from}→${chunk.to}): ${e.message}`);
        }
      }
    }

    let importResults = { despesasCreated: 0, quotasCreated: 0, quotasUpdated: 0, despesasSkipped: 0, staged: 0, stagingSkipped: 0, errors: [] as string[] };
    if (allTransactions.length > 0) {
      importResults = await importTransactions(allTransactions, connection.id);
    }

    // Recalcular e persistir saldos em configuracoes após o sync
    // Garante que o dashboard reflicte os dados actualizados na próxima query
    try {
      await recalcularSaldos();
    } catch (e: any) {
      console.error("[bank/sync] Erro ao recalcular saldos:", e.message);
      importResults.errors.push(`recalcularSaldos: ${e.message}`);
    }

    // ── Varrer staging: processar TXNs que ficaram imported=0 ────────────────
    // Inclui TXNs injectadas manualmente ou que falharam durante o sync
    try {
      const stagedResult = await processarStagedTransactions();
      if (stagedResult.processed > 0 || stagedResult.manualReview > 0) {
        console.log(`[bank/sync] process-staged: ${stagedResult.processed} processadas, ${stagedResult.manualReview} para revisão manual`);
      }
      if (stagedResult.errors.length > 0) {
        importResults.errors.push(...stagedResult.errors.map(e => `[staged] ${e}`));
      }
    } catch (e: any) {
      console.error("[bank/sync] Erro ao processar staged:", e.message);
      importResults.errors.push(`[staged] ${e.message}`);
    }

    // Log the sync
    await db.insert(schema.bankSyncLogs).values({
      connectionId: connection.id,
      syncedFrom: dateFrom,
      syncedTo: dateTo,
      transactionsFound: allTransactions.length,
      despesasCreated: importResults.despesasCreated,
      quotasCreated: importResults.quotasCreated,
      quotasUpdated: importResults.quotasUpdated,
      skipped: importResults.despesasSkipped,
      errors: JSON.stringify([...syncErrors, ...importResults.errors]),
      status: syncErrors.length > 0 || importResults.errors.length > 0 ? "partial" : "ok",
    });

    return c.json({
      ok: true,
      period: { from: dateFrom.toISOString().slice(0, 10), to: dateTo.toISOString().slice(0, 10) },
      transactionsFound: allTransactions.length,
      ...importResults,
      syncErrors,
    });
  })

  // DELETE /api/bank/disconnect
  .delete("/disconnect", requireAdmin, async (c) => {
    await db.delete(schema.bankConnections);
    return c.json({ ok: true });
  })

  // POST /api/bank/process-staged — processar TXNs em staging (imported=0)
  // Corre o motor matricial em todas as transações pendentes e aplica a cascata.
  // TXNs identificadas com score >= 55 → imported=1 + quota criada/atualizada
  // TXNs sem match → requires_manual_review=1, imported permanece 0
  .post("/process-staged", requireAdmin, async (c) => {
    try {
      const result = await processarStagedTransactions();
      return c.json({
        ok: true,
        processed: result.processed,
        manualReview: result.manualReview,
        errors: result.errors,
        details: result.details,
      });
    } catch (e: any) {
      return c.json({ ok: false, error: e.message }, 500);
    }
  })

  // GET /api/bank/synclogs — last 10 sync logs
  .get("/synclogs", requireAdmin, async (c) => {
    const logs = await db.select().from(schema.bankSyncLogs)
      .orderBy(desc(schema.bankSyncLogs.createdAt)).limit(10);
    return c.json({ logs });
  });

// ─── Scheduled sync (callable programmatically) ───────────────────────────────
export async function runBankSync(): Promise<void> {
  const conn = await db.select().from(schema.bankConnections).limit(1);
  if (conn.length === 0) return;

  const connection = conn[0];
  const accounts: any[] = JSON.parse(connection.accounts ?? "[]");
  if (accounts.length === 0) return;

  const lastSync = await db.select().from(schema.bankSyncLogs)
    .orderBy(desc(schema.bankSyncLogs.createdAt)).limit(1);

  const dateFrom = lastSync[0]?.syncedTo
    ? new Date(lastSync[0].syncedTo as any)
    : new Date(Date.now() - 90 * 24 * 60 * 60 * 1000);
  const dateTo = new Date();

  const fromStr = dateFrom.toISOString().slice(0, 10);
  const toStr = dateTo.toISOString().slice(0, 10);

  let allTransactions: any[] = [];
  const syncErrors: string[] = [];

  for (const acc of accounts) {
    try {
      const data = await enableBankingFetch(
        `/accounts/${acc.uid}/transactions?date_from=${fromStr}&date_to=${toStr}`
      );
      allTransactions = allTransactions.concat(data.transactions ?? []);
    } catch (e: any) {
      syncErrors.push(`Conta ${acc.uid}: ${e.message}`);
    }
  }

  let importResults = { despesasCreated: 0, quotasCreated: 0, quotasUpdated: 0, despesasSkipped: 0, staged: 0, stagingSkipped: 0, errors: [] as string[] };
  if (allTransactions.length > 0) {
    importResults = await importTransactions(allTransactions, connection.id);
  }

  try {
    await recalcularSaldos();
  } catch (e: any) {
    console.error("[bank-cron] Erro ao recalcular saldos:", e.message);
  }

  await db.insert(schema.bankSyncLogs).values({
    connectionId: connection.id,
    syncedFrom: dateFrom,
    syncedTo: dateTo,
    transactionsFound: allTransactions.length,
    despesasCreated: importResults.despesasCreated,
    quotasCreated: importResults.quotasCreated,
    quotasUpdated: importResults.quotasUpdated,
    skipped: importResults.despesasSkipped,
    errors: JSON.stringify([...syncErrors, ...importResults.errors]),
    status: syncErrors.length > 0 || importResults.errors.length > 0 ? "partial" : "ok",
  });

  console.log(`[bank-cron] Sync concluído: ${allTransactions.length} transações, ${importResults.despesasCreated} despesas criadas`);
}
