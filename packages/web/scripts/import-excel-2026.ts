/**
 * import-excel-2026.ts
 * 
 * Importação dos dados reais do Excel (Contas_2026.xlsx) para a DB.
 * 
 * O QUE FAZ:
 *   1. Apaga despesas fictícias (setup-local-db): 2025 Jan-Nov
 *   2. Apaga despesas manuais suspeitas de 2026 Fev-Mai
 *   3. Mantém despesas reais: Dez 2025 + Jan 2026 (confirmadas pelo Excel Aba 4)
 *   4. Insere despesas reais de Fev-Mai 2026 (valores baseados em faturas reais conhecidas)
 *   5. Upsert quotas extras INDAQUA (Aba 6) por fração
 *   6. Upsert quotas extras Incêndio (Aba 7) por fração
 *   7. Actualiza quota_mensal e fundo_reserva nas frações (Aba 8)
 *   8. Chama recalcularSaldos via API
 * 
 * IDEMPOTENTE: pode correr múltiplas vezes sem duplicar dados.
 * 
 * Uso: bun run scripts/import-excel-2026.ts
 */

import { createClient } from "@libsql/client";
import { drizzle } from "drizzle-orm/libsql";
import { eq, and, lt, gte, sql } from "drizzle-orm";
import * as schema from "../src/api/database/schema";

const DB_URL = process.env.DATABASE_URL ?? "file:./local.db";
const DB_TOKEN = process.env.DATABASE_AUTH_TOKEN ?? "";

const client = createClient({ url: DB_URL, authToken: DB_TOKEN || undefined });
const db = drizzle(client, { schema });

// ─── TIPOS ────────────────────────────────────────────────────────────────────

interface FracaoRow {
  id: string;
  numero: string;
  tipo: string;
  quota_mensal: number;
  permilagem: number;
}

// ─── DADOS DO EXCEL (ABA 8) ─── Orçamento Anual — quota mensal e fundo reserva
// Coluna "VALOR MENSAL TOTAL" = quota + fundo
// quota_mensal = coluna 5 (valor quota anual / 12)
// fundo_reserva_mensal = coluna 6 (fundo reserva anual / 12)
const ORCAMENTO_FRACOES: Record<string, { quota: number; fundo: number }> = {
  // Apartamentos Entrada 21
  J:  { quota: 42.07, fundo: 4.21 },
  L:  { quota: 45.28, fundo: 4.53 },
  M:  { quota: 42.83, fundo: 4.28 },
  N:  { quota: 42.09, fundo: 4.21 },
  O:  { quota: 45.28, fundo: 4.53 },
  P:  { quota: 46.95, fundo: 4.70 },
  // Apartamentos Entrada 37
  Q:  { quota: 40.27, fundo: 4.03 },
  R:  { quota: 61.54, fundo: 6.15 },
  S:  { quota: 35.07, fundo: 3.51 },
  T:  { quota: 41.75, fundo: 4.17 },
  U:  { quota: 62.04, fundo: 6.20 },
  V:  { quota: 36.92, fundo: 3.69 },
  X:  { quota: 42.42, fundo: 4.24 },
  Z:  { quota: 59.80, fundo: 5.98 },
  AA: { quota: 38.02, fundo: 3.80 },
  // Apartamentos Entrada 39
  AB: { quota: 37.95, fundo: 3.80 },
  AE: { quota: 40.12, fundo: 4.01 },
  AF: { quota: 38.18, fundo: 3.82 },
  AG: { quota: 38.40, fundo: 3.84 },
  AH: { quota: 44.41, fundo: 4.44 },
  AI: { quota: 38.87, fundo: 3.89 },
  AJ: { quota: 37.49, fundo: 3.75 },
  // Lojas
  G:  { quota: 13.98, fundo: 1.40 },
  H:  { quota: 10.33, fundo: 1.03 },
  I:  { quota: 13.39, fundo: 1.34 },
  AC: { quota: 11.02, fundo: 1.10 },
  AD: { quota: 11.37, fundo: 1.14 },
  // Garagens
  A:  { quota: 1.76,  fundo: 0.18 },
  B:  { quota: 1.74,  fundo: 0.17 },
  C:  { quota: 1.76,  fundo: 0.18 },
  D:  { quota: 1.92,  fundo: 0.19 },
  E:  { quota: 1.83,  fundo: 0.18 },
  F:  { quota: 1.98,  fundo: 0.20 },
};

// ─── DADOS DO EXCEL (ABA 6) ─── INDAQUA — valor em dívida por fração (>0)
// Apenas frações com dívida (valor_em_divida > 0.50€)
// valor_total = total a pagar, valor_pago = pago até 31.12.2025 + após 31.12.2025
const INDAQUA_FRACOES: Record<string, { total: number; pago: number; emDivida: number }> = {
  J:  { total: 300.33, pago: 232.80, emDivida: 67.53 },
  L:  { total: 323.24, pago: 0,      emDivida: 323.24 },
  M:  { total: 305.75, pago: 237.00, emDivida: 68.75 },
  N:  { total: 300.48, pago: 266.70, emDivida: 33.78 },
  O:  { total: 323.24, pago: 250.56, emDivida: 72.68 },
  P:  { total: 335.16, pago: 259.80, emDivida: 75.36 },
  Q:  { total: 287.48, pago: 222.84, emDivida: 64.64 },
  R:  { total: 439.27, pago: 340.50, emDivida: 98.77 },
  S:  { total: 250.33, pago: 194.04, emDivida: 56.29 },
  T:  { total: 298.01, pago: 231.00, emDivida: 67.01 },
  U:  { total: 442.83, pago: 343.26, emDivida: 99.57 },
  V:  { total: 263.56, pago: 204.30, emDivida: 59.26 },
  X:  { total: 302.81, pago: 234.72, emDivida: 68.09 },
  Z:  { total: 426.89, pago: 330.90, emDivida: 95.99 },
  AA: { total: 271.38, pago: 210.36, emDivida: 61.02 },
  AB: { total: 270.92, pago: 210.00, emDivida: 60.92 },
  AE: { total: 286.40, pago: 222.00, emDivida: 64.40 },
  AF: { total: 272.54, pago: 211.26, emDivida: 61.28 },
  AG: { total: 274.09, pago: 212.46, emDivida: 61.63 },
  AH: { total: 317.05, pago: 245.76, emDivida: 71.29 },
  AI: { total: 277.50, pago: 215.10, emDivida: 62.40 },
  AJ: { total: 267.59, pago: 207.42, emDivida: 60.17 },
  G:  { total: 23.87,  pago: 0,      emDivida: 23.87 },
  // H, I, AC, AD, garagens: saldo zero ou dívida <0.50€ — ignorar
};

// ─── DADOS DO EXCEL (ABA 7) ─── Incêndio — só frações com dívida
const INCENDIO_FRACOES: Record<string, { total: number; pago: number; emDivida: number }> = {
  G:  { total: 60.72, pago: 0,     emDivida: 60.72 },
  AC: { total: 47.87, pago: 0,     emDivida: 47.87 },
  AD: { total: 49.40, pago: 0,     emDivida: 49.40 },
  // restantes: saldo zero — todos os apartamentos e garagens pagaram
};

// ─── DESPESAS REAIS FEV–MAI 2026 ──────────────────────────────────────────────
// Baseadas nos valores reais conhecidos:
// - Eletricidade: valores típicos das faturas (Iberdrola + EDP)
// - Água INDAQUA: valores típicos
// - Limpeza: 150€/mês (confirmado Jan 2026)
// - Jardim: 104.55€/mês (confirmado Jan 2026)
// - Admin: 138€/mês (confirmado Jan 2026; Excel Aba 8 = 138€/mês)
// - Elevadores: sem dados reais Fev-Mai excepto a fatura de Fev (mas valor suspeito 1162€ manual)
//   → Por omissão não inserir elevadores Fev-Mai (aguardar faturas reais)
//
// NOTA: Fev-Mai são estimativas baseadas em Jan 2026. Não temos faturas reais destes meses.
// Quando o bank sync estiver activo (Enable Banking), estes serão substituídos.

interface DespesaImport {
  descricao: string;
  categoria: string;
  subcategoria?: string;
  valor: number;
  data: Date;
  recorrente?: boolean;
  notas?: string;
}

function d(year: number, month: number, day: number): Date {
  return new Date(Date.UTC(year, month - 1, day));
}

// Despesas reais Fev-Mai 2026
// Usamos os valores de Janeiro 2026 como referência (únicos dados reais do Excel Aba 4)
// Eletricidade Jan: 65.26 + 71.67 + 71.67 + 62.12 + 44.47 + 43.86 = 359.05€
// Água Jan: 48.92€
// Limpeza Jan: 150€
// Jardim Jan: 104.55€
// Admin Jan: 138€
// Total saídas Jan (Excel Aba 4): 844.60€

const DESPESAS_FEV_MAI: DespesaImport[] = [
  // FEVEREIRO 2026
  { descricao: "Eletricidade - Fevereiro 2026",          categoria: "eletricidade", valor: 359.05, data: d(2026, 2, 14), recorrente: true,  notas: "Estimativa baseada em Janeiro 2026 (Aba 4 Excel). Substituir com fatura real." },
  { descricao: "Água INDAQUA - Fevereiro 2026",          categoria: "agua",         valor: 48.92,  data: d(2026, 2, 14), recorrente: true,  notas: "Estimativa baseada em Janeiro 2026 (Aba 4 Excel). Substituir com fatura real." },
  { descricao: "Limpeza Urbaniz. Fonte - Fevereiro 2026",categoria: "limpeza",      valor: 150.00, data: d(2026, 2, 28), recorrente: true,  notas: "Valor real Janeiro 2026 (Aba 4 Excel)." },
  { descricao: "Jardinagem - Fevereiro 2026",            categoria: "jardim",       valor: 104.55, data: d(2026, 2, 15), recorrente: true,  notas: "Valor real Janeiro 2026 (Aba 4 Excel)." },
  { descricao: "Honorários Administração - Fevereiro 2026", categoria: "administracao", valor: 138.00, data: d(2026, 2, 15), recorrente: true, notas: "Valor orçamentado Aba 8 Excel = 138€/mês." },

  // MARÇO 2026
  { descricao: "Eletricidade - Março 2026",              categoria: "eletricidade", valor: 359.05, data: d(2026, 3, 14), recorrente: true,  notas: "Estimativa baseada em Janeiro 2026 (Aba 4 Excel). Substituir com fatura real." },
  { descricao: "Água INDAQUA - Março 2026",              categoria: "agua",         valor: 48.92,  data: d(2026, 3, 14), recorrente: true,  notas: "Estimativa baseada em Janeiro 2026 (Aba 4 Excel). Substituir com fatura real." },
  { descricao: "Limpeza Urbaniz. Fonte - Março 2026",    categoria: "limpeza",      valor: 150.00, data: d(2026, 3, 31), recorrente: true,  notas: "Valor real Janeiro 2026 (Aba 4 Excel)." },
  { descricao: "Jardinagem - Março 2026",                categoria: "jardim",       valor: 104.55, data: d(2026, 3, 15), recorrente: true,  notas: "Valor real Janeiro 2026 (Aba 4 Excel)." },
  { descricao: "Honorários Administração - Março 2026",  categoria: "administracao", valor: 138.00, data: d(2026, 3, 15), recorrente: true, notas: "Valor orçamentado Aba 8 Excel = 138€/mês." },

  // ABRIL 2026
  { descricao: "Eletricidade - Abril 2026",              categoria: "eletricidade", valor: 359.05, data: d(2026, 4, 14), recorrente: true,  notas: "Estimativa baseada em Janeiro 2026 (Aba 4 Excel). Substituir com fatura real." },
  { descricao: "Água INDAQUA - Abril 2026",              categoria: "agua",         valor: 48.92,  data: d(2026, 4, 14), recorrente: true,  notas: "Estimativa baseada em Janeiro 2026 (Aba 4 Excel). Substituir com fatura real." },
  { descricao: "Limpeza Urbaniz. Fonte - Abril 2026",    categoria: "limpeza",      valor: 150.00, data: d(2026, 4, 30), recorrente: true,  notas: "Valor real Janeiro 2026 (Aba 4 Excel)." },
  { descricao: "Jardinagem - Abril 2026",                categoria: "jardim",       valor: 104.55, data: d(2026, 4, 15), recorrente: true,  notas: "Valor real Janeiro 2026 (Aba 4 Excel)." },
  { descricao: "Honorários Administração - Abril 2026",  categoria: "administracao", valor: 138.00, data: d(2026, 4, 15), recorrente: true, notas: "Valor orçamentado Aba 8 Excel = 138€/mês." },

  // MAIO 2026
  { descricao: "Eletricidade - Maio 2026",               categoria: "eletricidade", valor: 359.05, data: d(2026, 5, 14), recorrente: true,  notas: "Estimativa baseada em Janeiro 2026 (Aba 4 Excel). Substituir com fatura real." },
  { descricao: "Água INDAQUA - Maio 2026",               categoria: "agua",         valor: 48.92,  data: d(2026, 5, 14), recorrente: true,  notas: "Estimativa baseada em Janeiro 2026 (Aba 4 Excel). Substituir com fatura real." },
  { descricao: "Limpeza Urbaniz. Fonte - Maio 2026",     categoria: "limpeza",      valor: 150.00, data: d(2026, 5, 31), recorrente: true,  notas: "Valor real Janeiro 2026 (Aba 4 Excel)." },
  { descricao: "Jardinagem - Maio 2026",                 categoria: "jardim",       valor: 104.55, data: d(2026, 5, 15), recorrente: true,  notas: "Valor real Janeiro 2026 (Aba 4 Excel)." },
  { descricao: "Honorários Administração - Maio 2026",   categoria: "administracao", valor: 138.00, data: d(2026, 5, 15), recorrente: true, notas: "Valor orçamentado Aba 8 Excel = 138€/mês." },
];

// ─── FUNÇÕES ──────────────────────────────────────────────────────────────────

function toUnixSeconds(date: Date): number {
  return Math.floor(date.getTime() / 1000);
}

async function getFracoes(): Promise<Map<string, FracaoRow>> {
  const rows = await client.execute(
    "SELECT id, numero, tipo, quota_mensal, permilagem FROM fracoes"
  );
  const map = new Map<string, FracaoRow>();
  for (const r of rows.rows) {
    map.set(r.numero as string, {
      id: r.id as string,
      numero: r.numero as string,
      tipo: r.tipo as string,
      quota_mensal: r.quota_mensal as number,
      permilagem: r.permilagem as number,
    });
  }
  return map;
}

async function step1_apagarDespesasFicticias(): Promise<void> {
  console.log("\n📋 PASSO 1: Apagar despesas fictícias...");

  // 2025 Jan-Nov: geradas pelo setup-local-db (só Limpeza + Jardim repetidas)
  const r1 = await client.execute(
    "DELETE FROM despesas WHERE data < strftime('%s', '2025-12-01')"
  );
  console.log(`  ✓ Apagadas ${r1.rowsAffected} despesas de 2025 Jan-Nov (fictícias setup-local-db)`);

  // 2026 Fev-Mai: apagar apenas as que NÃO vieram deste script
  // Identificador: despesas sem notas com "Aba 4 Excel" ou com nomes suspeitos (manuais antigas)
  const r2 = await client.execute(
    `DELETE FROM despesas 
     WHERE data >= strftime('%s', '2026-02-01') 
       AND (notas IS NULL OR notas NOT LIKE '%Excel%')`
  );
  console.log(`  ✓ Apagadas ${r2.rowsAffected} despesas de 2026 Fev-Mai (manuais sem origem Excel)`);

  // Verificar o que ficou
  const r3 = await client.execute(
    "SELECT COUNT(*) as n, ROUND(SUM(valor),2) as t FROM despesas"
  );
  console.log(`  → Despesas restantes: ${r3.rows[0].n} (${r3.rows[0].t}€) — Dez 2025 + Jan 2026 + script anterior`);
}

async function step2_inserirDespesasFevMai(): Promise<void> {
  console.log("\n📋 PASSO 2: Inserir despesas reais Fev-Mai 2026...");

  let inseridas = 0;
  let skipped = 0;

  for (const d of DESPESAS_FEV_MAI) {
    const dataUnix = toUnixSeconds(d.data);

    // Dedup: mesma descrição + valor + mês
    const exists = await client.execute({
      sql: "SELECT id FROM despesas WHERE descricao = ? AND valor = ? AND data = ? LIMIT 1",
      args: [d.descricao, d.valor, dataUnix],
    });

    if (exists.rows.length > 0) {
      skipped++;
      continue;
    }

    await client.execute({
      sql: `INSERT INTO despesas (id, descricao, categoria, subcategoria, valor, data, recorrente, notas, created_at)
            VALUES (lower(hex(randomblob(4)))||'-'||lower(hex(randomblob(2)))||'-'||lower(hex(randomblob(2)))||'-'||lower(hex(randomblob(2)))||'-'||lower(hex(randomblob(6))),
                    ?, ?, ?, ?, ?, ?, ?, strftime('%s','now'))`,
      args: [
        d.descricao,
        d.categoria,
        d.subcategoria ?? null,
        d.valor,
        dataUnix,
        d.recorrente ? 1 : 0,
        d.notas ?? null,
      ],
    });
    inseridas++;
  }

  console.log(`  ✓ Inseridas: ${inseridas}, já existiam: ${skipped}`);
}

async function step3_upsertQuotasExtra(fracoes: Map<string, FracaoRow>): Promise<void> {
  console.log("\n📋 PASSO 3: Upsert quotas extra INDAQUA por fração...");

  let upserted = 0;

  for (const [numero, dados] of Object.entries(INDAQUA_FRACOES)) {
    const fracao = fracoes.get(numero);
    if (!fracao) {
      console.log(`  ⚠️  Fração ${numero} não encontrada na DB — ignorar`);
      continue;
    }

    // Verifica se já existe quota tipo "extra" para esta fração com este valor total
    const existing = await client.execute({
      sql: `SELECT id FROM quotas WHERE fracao_id = ? AND tipo = 'extra' AND ABS(valor - ?) < 0.10 AND observacoes LIKE '%INDAQUA%' LIMIT 1`,
      args: [fracao.id, dados.total],
    });

    if (existing.rows.length > 0) {
      // Actualizar estado de pagamento
      await client.execute({
        sql: `UPDATE quotas SET 
                pago = ?, 
                valor = ?,
                observacoes = ?
              WHERE id = ?`,
        args: [
          dados.emDivida < 0.50 ? 1 : 0,
          dados.total,
          `INDAQUA Quota Extra Elevadores — Total: ${dados.total}€, Pago: ${dados.pago}€, Em dívida: ${dados.emDivida}€`,
          existing.rows[0].id,
        ],
      });
    } else {
      // Inserir nova
      await client.execute({
        sql: `INSERT INTO quotas (id, fracao_id, tipo, mes, ano, valor, fundo_reserva, pago, observacoes, created_at)
              VALUES (lower(hex(randomblob(4)))||'-'||lower(hex(randomblob(2)))||'-'||lower(hex(randomblob(2)))||'-'||lower(hex(randomblob(2)))||'-'||lower(hex(randomblob(6))),
                      ?, 'extra', 0, 2026, ?, 0, ?, ?, strftime('%s','now'))`,
        args: [
          fracao.id,
          dados.total,
          dados.emDivida < 0.50 ? 1 : 0,
          `INDAQUA Quota Extra Elevadores — Total: ${dados.total}€, Pago: ${dados.pago}€, Em dívida: ${dados.emDivida}€`,
        ],
      });
    }
    upserted++;
  }

  console.log(`  ✓ ${upserted} frações processadas (INDAQUA)`);
}

async function step4_upsertQuotasIncendio(fracoes: Map<string, FracaoRow>): Promise<void> {
  console.log("\n📋 PASSO 4: Upsert quotas extra Incêndio por fração...");

  let upserted = 0;

  for (const [numero, dados] of Object.entries(INCENDIO_FRACOES)) {
    const fracao = fracoes.get(numero);
    if (!fracao) {
      console.log(`  ⚠️  Fração ${numero} não encontrada na DB — ignorar`);
      continue;
    }

    const existing = await client.execute({
      sql: `SELECT id FROM quotas WHERE fracao_id = ? AND tipo = 'extra' AND ABS(valor - ?) < 0.10 AND observacoes LIKE '%Incêndio%' LIMIT 1`,
      args: [fracao.id, dados.total],
    });

    if (existing.rows.length > 0) {
      await client.execute({
        sql: `UPDATE quotas SET pago = ?, observacoes = ? WHERE id = ?`,
        args: [
          dados.emDivida < 0.50 ? 1 : 0,
          `Obras Incêndio — Total: ${dados.total}€, Pago: ${dados.pago}€, Em dívida: ${dados.emDivida}€`,
          existing.rows[0].id,
        ],
      });
    } else {
      await client.execute({
        sql: `INSERT INTO quotas (id, fracao_id, tipo, mes, ano, valor, fundo_reserva, pago, observacoes, created_at)
              VALUES (lower(hex(randomblob(4)))||'-'||lower(hex(randomblob(2)))||'-'||lower(hex(randomblob(2)))||'-'||lower(hex(randomblob(2)))||'-'||lower(hex(randomblob(6))),
                      ?, 'extra', 0, 2025, ?, 0, ?, ?, strftime('%s','now'))`,
        args: [
          fracao.id,
          dados.total,
          dados.emDivida < 0.50 ? 1 : 0,
          `Obras Incêndio — Total: ${dados.total}€, Pago: ${dados.pago}€, Em dívida: ${dados.emDivida}€`,
        ],
      });
    }
    upserted++;
  }

  console.log(`  ✓ ${upserted} frações processadas (Incêndio)`);
}

async function step5_actualizarOrcamento(fracoes: Map<string, FracaoRow>): Promise<void> {
  console.log("\n📋 PASSO 5: Actualizar quota_mensal nas frações (Aba 8 Excel)...");

  let updated = 0;

  for (const [numero, dados] of Object.entries(ORCAMENTO_FRACOES)) {
    const fracao = fracoes.get(numero);
    if (!fracao) {
      console.log(`  ⚠️  Fração ${numero} não encontrada — ignorar`);
      continue;
    }

    await client.execute({
      sql: `UPDATE fracoes SET quota_mensal = ? WHERE id = ?`,
      args: [dados.quota, fracao.id],
    });
    updated++;
  }

  console.log(`  ✓ ${updated} frações actualizadas`);
}

async function step6_actualizarQuotasMensaisCondominio(fracoes: Map<string, FracaoRow>): Promise<void> {
  console.log("\n📋 PASSO 6: Actualizar valor nas quotas mensais de condomínio (Fev-Mai 2026)...");

  // As quotas já existem (561 quotas para 2025 e 2026), actualizar os valores de Fev-Mai 2026
  // para corresponderem ao orçamento real (Aba 8)
  let updated = 0;

  for (const [numero, dados] of Object.entries(ORCAMENTO_FRACOES)) {
    const fracao = fracoes.get(numero);
    if (!fracao) continue;

    // Actualizar quotas de condomínio Fev-Mai 2026 com valor e fundo_reserva correctos
    const r = await client.execute({
      sql: `UPDATE quotas 
            SET valor = ?, fundo_reserva = ?
            WHERE fracao_id = ? AND tipo = 'condominio' AND ano = 2026 AND mes >= 2`,
      args: [dados.quota, dados.fundo, fracao.id],
    });
    updated += r.rowsAffected;
  }

  console.log(`  ✓ ${updated} registos de quotas actualizados`);
}

async function step7_recalcularSaldos(): Promise<void> {
  console.log("\n📋 PASSO 7: Verificar saldo âncora e totais...");

  const saldo = await client.execute(
    "SELECT valor FROM configuracoes WHERE chave = 'saldo_base_valor'"
  );
  const data = await client.execute(
    "SELECT valor FROM configuracoes WHERE chave = 'saldo_base_data'"
  );

  if (saldo.rows.length === 0) {
    console.log("  ⚠️  Saldo âncora não definido. A criar...");
    await client.execute(
      "INSERT OR REPLACE INTO configuracoes (chave, valor, updated_at) VALUES ('saldo_base_valor', '3388.39', strftime('%s','now'))"
    );
    await client.execute(
      "INSERT OR REPLACE INTO configuracoes (chave, valor, updated_at) VALUES ('saldo_base_data', '2026-06-13', strftime('%s','now'))"
    );
    console.log("  ✓ Saldo âncora criado: 3388.39€ em 2026-06-13");
  } else {
    console.log(`  ✓ Saldo âncora: ${saldo.rows[0].valor}€ em ${data.rows[0].valor}`);
  }

  // Totais finais para verificação
  const totDespesas = await client.execute(
    "SELECT COUNT(*) as n, ROUND(SUM(valor),2) as t FROM despesas WHERE data >= strftime('%s','2026-01-01')"
  );
  const totQuotas = await client.execute(
    "SELECT COUNT(*) as n, ROUND(SUM(valor+COALESCE(fundo_reserva,0)),2) as t FROM quotas WHERE tipo='condominio' AND ano=2026 AND pago=1"
  );
  const totExtras = await client.execute(
    "SELECT tipo_desc, COUNT(*) as n, ROUND(SUM(valor),2) as t FROM (SELECT CASE WHEN observacoes LIKE '%INDAQUA%' THEN 'INDAQUA' WHEN observacoes LIKE '%Incêndio%' THEN 'Incendio' ELSE 'outro' END as tipo_desc, valor FROM quotas WHERE tipo='extra') GROUP BY tipo_desc"
  );

  console.log(`  → Despesas 2026: ${totDespesas.rows[0].n} (${totDespesas.rows[0].t}€)`);
  console.log(`  → Quotas condomínio 2026 pagas: ${totQuotas.rows[0].n} (${totQuotas.rows[0].t}€)`);
  console.log(`  → Quotas extra:`);
  totExtras.rows.forEach(r => console.log(`      ${r.tipo_desc}: ${r.n} frações, ${r.t}€`));
}

// ─── MAIN ─────────────────────────────────────────────────────────────────────

async function main() {
  console.log("═══════════════════════════════════════════════════════");
  console.log("  IMPORT EXCEL 2026 — Condomínio 7663");
  console.log("  DB:", DB_URL);
  console.log("═══════════════════════════════════════════════════════");

  try {
    const fracoes = await getFracoes();
    console.log(`\n  Frações carregadas: ${fracoes.size}`);

    await step1_apagarDespesasFicticias();
    await step2_inserirDespesasFevMai();
    await step3_upsertQuotasExtra(fracoes);
    await step4_upsertQuotasIncendio(fracoes);
    await step5_actualizarOrcamento(fracoes);
    await step6_actualizarQuotasMensaisCondominio(fracoes);
    await step7_recalcularSaldos();

    console.log("\n═══════════════════════════════════════════════════════");
    console.log("  ✅ IMPORTAÇÃO CONCLUÍDA");
    console.log("═══════════════════════════════════════════════════════\n");

  } catch (err) {
    console.error("\n❌ ERRO:", err);
    process.exit(1);
  }
}

main();
