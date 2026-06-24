/**
 * migration-p1.ts
 * ─────────────────────────────────────────────────────────────────────────────
 * Migração P1: adicionar coluna debtor_iban à tabela bank_transactions.
 *
 * Executa com:
 *   DATABASE_URL=libsql://... DATABASE_AUTH_TOKEN=... bun run migration-p1.ts
 *
 * Seguro para reexecutar (IF NOT EXISTS / try-catch).
 * ─────────────────────────────────────────────────────────────────────────────
 */

import { createClient } from "@libsql/client";

const DATABASE_URL = process.env.DATABASE_URL;
const DATABASE_AUTH_TOKEN = process.env.DATABASE_AUTH_TOKEN;

if (!DATABASE_URL) {
  console.error("[migration-p1] ERRO: DATABASE_URL não definida.");
  console.error("  Executa: DATABASE_URL=libsql://... DATABASE_AUTH_TOKEN=... bun run migration-p1.ts");
  process.exit(1);
}

const client = createClient({
  url: DATABASE_URL,
  authToken: DATABASE_AUTH_TOKEN,
});

async function run() {
  console.log("[migration-p1] A ligar à base de dados:", DATABASE_URL);

  // ── 1. Verificar se a coluna já existe ────────────────────────────────────
  const tableInfo = await client.execute("PRAGMA table_info(bank_transactions)");
  const columns = tableInfo.rows.map((r: any) => r[1] as string); // col index 1 = name
  console.log("[migration-p1] Colunas existentes em bank_transactions:", columns.join(", "));

  if (columns.includes("debtor_iban")) {
    console.log("[migration-p1] ✅ Coluna debtor_iban já existe — migração desnecessária.");
    await client.close();
    return;
  }

  // ── 2. Adicionar coluna ────────────────────────────────────────────────────
  console.log("[migration-p1] A adicionar coluna debtor_iban TEXT...");
  await client.execute("ALTER TABLE bank_transactions ADD COLUMN debtor_iban TEXT");
  console.log("[migration-p1] ✅ Coluna debtor_iban adicionada com sucesso.");

  // ── 3. Verificar resultado ─────────────────────────────────────────────────
  const verify = await client.execute("PRAGMA table_info(bank_transactions)");
  const newCols = verify.rows.map((r: any) => r[1] as string);
  if (newCols.includes("debtor_iban")) {
    console.log("[migration-p1] ✅ Verificação confirmada. Schema atualizado.");
  } else {
    console.error("[migration-p1] ❌ Falha na verificação — coluna não encontrada após ALTER TABLE.");
    process.exit(1);
  }

  // ── 4. Backfill retrocompatibilidade (opcional) ────────────────────────────
  // Tenta extrair o IBAN do campo raw_data para transações já existentes.
  // Só actualiza se raw_data for JSON válido com debtor.account.iban.
  console.log("[migration-p1] A iniciar backfill de debtor_iban a partir de raw_data...");
  const rows = await client.execute(
    "SELECT id, raw_data FROM bank_transactions WHERE debtor_iban IS NULL AND raw_data IS NOT NULL"
  );

  let backfilled = 0;
  for (const row of rows.rows) {
    const id = row[0] as string;
    const rawData = row[1] as string | null;
    if (!rawData) continue;
    try {
      const parsed = JSON.parse(rawData);
      const iban =
        parsed.debtor?.account?.iban   // Enable Banking real
        ?? parsed.iban_sender           // formato QA seed
        ?? parsed.debtorIban            // camelCase legacy
        ?? null;
      if (!iban) continue;
      await client.execute({
        sql: "UPDATE bank_transactions SET debtor_iban = ? WHERE id = ?",
        args: [iban, id],
      });
      backfilled++;
    } catch {
      // JSON inválido — ignorar
    }
  }

  console.log(`[migration-p1] ✅ Backfill concluído: ${backfilled} linha(s) actualizadas.`);

  await client.close();
  console.log("[migration-p1] ✅ Migração P1 concluída com sucesso.");
}

run().catch((err) => {
  console.error("[migration-p1] ERRO FATAL:", err);
  process.exit(1);
});
