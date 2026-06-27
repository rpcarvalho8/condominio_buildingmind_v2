// @ts-nocheck
/**
 * migration-clean.ts
 * ─────────────────────────────────────────────────────────────────────────────
 * PURGA DE SEEDS ANTIGOS / DADOS QA
 *
 * Remove todos os registos da tabela `quotas` e `bank_transactions` que tenham
 * data anterior a 02 de Junho de 2026 (ANCORA_DATA_MOVIMENTOS).
 *
 * Lógica:
 *   • quotas com (ano < 2026) OU (ano = 2026 AND mes < 6) → DELETE
 *   • bank_transactions com date < unix(2026-06-02) → DELETE
 *
 * Execute a partir da raiz do repo (o Bun lê o .env de packages/web):
 *   cd packages/web && bun migration-clean.ts
 *
 * O Bun carrega automaticamente o .env da pasta de trabalho corrente.
 *
 * AVISO: operação irreversível. Fazer backup da DB antes se necessário.
 * ─────────────────────────────────────────────────────────────────────────────
 */

import { drizzle } from "drizzle-orm/libsql";
import { createClient } from "@libsql/client";
import { and, lt, or, sql, eq } from "drizzle-orm";
import * as schema from "./src/api/database/schema";

const DATABASE_URL = process.env.DATABASE_URL;
const DATABASE_AUTH_TOKEN = process.env.DATABASE_AUTH_TOKEN;

if (!DATABASE_URL) {
  console.error("[migration-clean] ERRO: DATABASE_URL não definido.");
  console.error("  Cria o ficheiro packages/web/.env com DATABASE_URL e DATABASE_AUTH_TOKEN");
  console.error("  e executa: cd packages/web && bun migration-clean.ts");
  process.exit(1);
}

console.log(`\n[migration-clean] A ligar a: ${DATABASE_URL}`);

const client = createClient({
  url: DATABASE_URL,
  authToken: DATABASE_AUTH_TOKEN,
});

const db = drizzle(client, { schema });

// ── Data-âncora: 02/06/2026 ───────────────────────────────────────────────────
const ANCORA_TS = Math.floor(new Date("2026-06-02T00:00:00.000Z").getTime() / 1000);

async function main() {
  // ── 1. Contar antes ─────────────────────────────────────────────────────────
  const [{ total: totalQuotasAntes }] = await db
    .select({ total: sql<number>`count(*)` })
    .from(schema.quotas);

  const [{ total: totalBankAntes }] = await db
    .select({ total: sql<number>`count(*)` })
    .from(schema.bankTransactions);

  console.log(`\n[migration-clean] Antes da purga:`);
  console.log(`  quotas total:            ${totalQuotasAntes}`);
  console.log(`  bank_transactions total: ${totalBankAntes}`);

  // ── 2. Purgar quotas pré-Junho-2026 ─────────────────────────────────────────
  // Condição: (ano < 2026) OR (ano = 2026 AND mes < 6)
  const deletedQuotas = await db
    .delete(schema.quotas)
    .where(
      or(
        lt(schema.quotas.ano, 2026),
        and(
          eq(schema.quotas.ano, 2026),
          lt(schema.quotas.mes, 6),
        ),
      )
    );

  console.log(`\n[migration-clean] ✅ Quotas eliminadas: ${(deletedQuotas as any)?.rowsAffected ?? "n/a"}`);

  // ── 3. Purgar bank_transactions pré-02/06/2026 ──────────────────────────────
  const deletedBank = await db
    .delete(schema.bankTransactions)
    .where(sql`${schema.bankTransactions.date} < ${ANCORA_TS}`);

  console.log(`[migration-clean] ✅ bank_transactions eliminadas: ${(deletedBank as any)?.rowsAffected ?? "n/a"}`);

  // ── 4. Contar depois ────────────────────────────────────────────────────────
  const [{ total: totalQuotasDepois }] = await db
    .select({ total: sql<number>`count(*)` })
    .from(schema.quotas);

  const [{ total: totalBankDepois }] = await db
    .select({ total: sql<number>`count(*)` })
    .from(schema.bankTransactions);

  console.log(`\n[migration-clean] Depois da purga:`);
  console.log(`  quotas total:            ${totalQuotasDepois}`);
  console.log(`  bank_transactions total: ${totalBankDepois}`);
  console.log(`\n[migration-clean] ✅ Concluído — base de dados limpa de seeds antigos.\n`);

  await client.close();
}

main().catch((e) => {
  console.error("[migration-clean] ERRO:", e);
  process.exit(1);
});
