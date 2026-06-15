/**
 * inject-qa-v2-turso.ts
 * Injecta 3 transacções QA directamente no Turso remoto (mesma BD do servidor)
 * Run: bun run inject-qa-v2-turso.ts (a partir de /home/user/Condominio-7663)
 */
import { createClient } from "@libsql/client";
import { drizzle } from "drizzle-orm/libsql";
import * as schema from "./packages/web/src/api/database/schema";
import { sql, eq, and } from "drizzle-orm";

const client = createClient({
  url: process.env.DATABASE_URL!,
  authToken: process.env.DATABASE_AUTH_TOKEN,
});
const db = drizzle(client, { schema });

console.log("🔗 Ligado a:", process.env.DATABASE_URL);

// ── 1. LIMPAR transacções QA anteriores (connection_id IS NULL)
const del = await db.run(sql`DELETE FROM bank_transactions WHERE connection_id IS NULL`);
console.log(`🗑  Limpeza: ${del.rowsAffected} registos removidos`);

const now = Math.floor(Date.now() / 1000);
const dateVal = Math.floor(new Date("2026-06-14").getTime() / 1000);

// ── 2. TXN 1 — Quota Extra Obras L → gaveta: obras (300€)
await db.run(sql`INSERT INTO bank_transactions
  (id, connection_id, transaction_id, amount, currency, date, description,
   creditor_name, debtor_name, type, status, imported, raw_data, created_at)
  VALUES (
    'qa-v2-001-obras',
    NULL, 'QA-V2-OBRAS-L-001',
    300.00, 'EUR', ${dateVal},
    'Quota Extra Obras L',
    NULL, 'JOÃO MARCO COUTINHO S MOREIRA',
    'CRDT', 'pending', 0,
    '{"iban_sender":"PT50026903300020179024227","amount":300.00,"description":"Quota Extra Obras L"}',
    ${now}
  )`);
console.log("✅ TXN 1: Quota Extra Obras L — 300€  [gaveta: obras]");

// ── 3. TXN 2 — Colisão IBAN AF vs N (quota corrente, descrição sem gaveta)
await db.run(sql`INSERT INTO bank_transactions
  (id, connection_id, transaction_id, amount, currency, date, description,
   creditor_name, debtor_name, type, status, imported, raw_data, created_at)
  VALUES (
    'qa-v2-002-iban-af',
    NULL, 'QA-V2-IBAN-AF-002',
    50.00, 'EUR', ${dateVal},
    'Condominio',
    NULL, 'NOME DA FRAÇÃO AF NO EXCEL',
    'CRDT', 'pending', 0,
    '{"iban_sender":"PT50003508260001938493063","amount":50.00,"description":"Condominio"}',
    ${now}
  )`);
console.log("✅ TXN 2: Condominio IBAN AF/N — 50€  [quota corrente, sem gaveta]");

// ── 4. TXN 3 — Desconhecido com descrição Obras → activa CativosAlert
await db.run(sql`INSERT INTO bank_transactions
  (id, connection_id, transaction_id, amount, currency, date, description,
   creditor_name, debtor_name, type, status, imported, raw_data, created_at)
  VALUES (
    'qa-v2-003-desconhecido',
    NULL, 'QA-V2-DESCONHECIDO-003',
    15.00, 'EUR', ${dateVal},
    'Obras - Depósito Indefinido',
    NULL, 'ESTRANHO INDEFINIDO',
    'CRDT', 'pending', 0,
    '{"iban_sender":"PT50000000000000000000000","amount":15.00,"description":"Obras - Depósito Indefinido"}',
    ${now}
  )`);
console.log("✅ TXN 3: Obras Desconhecido — 15€  [gaveta: obras → activa CativosAlert]");

// ── 5. VERIFICAR motor de cativos inline
await new Promise(r => setTimeout(r, 500));
const movimentos = await db
  .select({
    id: schema.bankTransactions.id,
    amount: schema.bankTransactions.amount,
    description: schema.bankTransactions.description,
    debtorName: schema.bankTransactions.debtorName,
    imported: schema.bankTransactions.imported,
  })
  .from(schema.bankTransactions)
  .where(and(
    eq(schema.bankTransactions.imported, 0),
    sql`${schema.bankTransactions.amount} > 0`,
  ));

console.log(`\n📋 bank_transactions(imported=0, amount>0): ${movimentos.length} registos`);
for (const m of movimentos) {
  console.log(`   [${m.id}] ${m.amount}€ | "${m.description}" | ${m.debtorName}`);
}

// ── 6. Simular calcularValoresCativos
const { identificarDestinoCativo } = await import("./packages/web/src/api/routes/cativo-rules");
let totalObras = 0, numCativos = 0;
for (const m of movimentos) {
  const r = identificarDestinoCativo(m.description, m.debtorName, null);
  if (r.gaveta) {
    numCativos++;
    if (r.gaveta === "obras") totalObras += m.amount;
    console.log(`   → CATIVO [${r.gaveta}] match em "${r.matchedField}": ${r.matchedPattern}`);
  } else {
    console.log(`   → QUOTA CORRENTE (sem gaveta): "${m.description}"`);
  }
}

console.log(`\n🔒 Cativos detectados: ${numCativos} movimentos | obras: ${totalObras}€`);
console.log(`\n✅ Dashboard vai mostrar:`);
console.log(`   valoresCativos.numMovimentos = ${numCativos}`);
console.log(`   valoresCativos.obras = ${totalObras}`);
console.log(`   valoresCativos.total = ${totalObras}`);
console.log(`\n🖥  Resultado UI esperado:`);
console.log(`   SaldoOperacionalCard: barra vermelha "Obras: ${totalObras}€"`);
console.log(`   CativosAlert: alerta amarelo com ${numCativos} movimentos`);
