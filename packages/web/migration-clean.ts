// @ts-nocheck
/**
 * migration-clean.ts
 * ─────────────────────────────────────────────────────────────────────────────
 * PURGA DE SEEDS ANTIGOS / DADOS QA
 *
 * Remove todos os registos das tabelas `recibos`, `quotas` e `bank_transactions`
 * com data anterior a 02 de Junho de 2026 (ANCORA_DATA_MOVIMENTOS).
 *
 * Lógica:
 *   • recibos com (ano < 2026) OU (ano = 2026 AND mes < 6) → DELETE (FK child)
 *   • quotas com (ano < 2026) OU (ano = 2026 AND mes < 6) → DELETE
 *   • bank_transactions com date < unix(2026-06-02) → DELETE
 *
 * Usa PRAGMA foreign_keys = OFF antes dos DELETEs e reativa no final.
 * Em Turso remoto (HTTP), o PRAGMA é executado via client.batch() para garantir
 * que corre na mesma sessão SQLite. Como fallback, os recibos dependentes são
 * apagados antes das quotas (ordem FK-safe).
 *
 * Execute a partir de packages/web (o Bun lê o .env local):
 *   cd packages/web && bun migration-clean.ts
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

// SQL de filtro temporal reutilizável (ano/mes como inteiros)
const FILTRO_ANTES_JUNHO_2026 = sql`(ano < 2026 OR (ano = 2026 AND mes < 6))`;

async function main() {
  // ── 1. Contar antes ─────────────────────────────────────────────────────────
  const [{ total: totalQuotasAntes }] = await db
    .select({ total: sql<number>`count(*)` })
    .from(schema.quotas);

  const [{ total: totalRecibosAntes }] = await db
    .select({ total: sql<number>`count(*)` })
    .from(schema.recibos);

  const [{ total: totalBankAntes }] = await db
    .select({ total: sql<number>`count(*)` })
    .from(schema.bankTransactions);

  console.log(`\n[migration-clean] Antes da purga:`);
  console.log(`  quotas total:            ${totalQuotasAntes}`);
  console.log(`  recibos total:           ${totalRecibosAntes}`);
  console.log(`  bank_transactions total: ${totalBankAntes}`);

  // ── 2. Desativar FK constraints + purgar em batch ────────────────────────────
  // client.batch() garante execução na mesma sessão SQLite no Turso,
  // o que é necessário para o PRAGMA foreign_keys ter efeito.
  console.log(`\n[migration-clean] A desativar foreign_keys e a purgar...`);

  await client.batch(
    [
      // 2a. Desativar FK verification
      { sql: "PRAGMA foreign_keys = OFF;", args: [] },

      // 2b. Apagar recibos dependentes (FK child de quotas) — por segurança,
      //     mesmo com PRAGMA OFF, apagamos primeiro para manter consistência
      {
        sql: "DELETE FROM recibos WHERE (ano < 2026 OR (ano = 2026 AND mes < 6));",
        args: [],
      },

      // 2c. Apagar quotas antigas
      {
        sql: "DELETE FROM quotas WHERE (ano < 2026 OR (ano = 2026 AND mes < 6));",
        args: [],
      },

      // 2d. Apagar bank_transactions antigas
      {
        sql: `DELETE FROM bank_transactions WHERE date < ${ANCORA_TS};`,
        args: [],
      },

      // 2e. Reativar FK verification
      { sql: "PRAGMA foreign_keys = ON;", args: [] },
    ],
    "write",
  );

  console.log(`[migration-clean] ✅ Purga concluída (batch write com FK OFF/ON).`);

  // ── 3. Contar depois ────────────────────────────────────────────────────────
  const [{ total: totalQuotasDepois }] = await db
    .select({ total: sql<number>`count(*)` })
    .from(schema.quotas);

  const [{ total: totalRecibosDepois }] = await db
    .select({ total: sql<number>`count(*)` })
    .from(schema.recibos);

  const [{ total: totalBankDepois }] = await db
    .select({ total: sql<number>`count(*)` })
    .from(schema.bankTransactions);

  console.log(`\n[migration-clean] Depois da purga:`);
  console.log(`  quotas total:            ${totalQuotasDepois}`);
  console.log(`  recibos total:           ${totalRecibosDepois}`);
  console.log(`  bank_transactions total: ${totalBankDepois}`);
  console.log(`\n[migration-clean] ✅ Concluído — base de dados limpa de seeds antigos.\n`);

  await client.close();
}

main().catch((e) => {
  console.error("[migration-clean] ERRO:", e);
  // Tentar reativar FK constraints mesmo em caso de erro
  client.execute("PRAGMA foreign_keys = ON;").catch(() => {});
  process.exit(1);
});
