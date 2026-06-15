import { createClient } from "@libsql/client";
const db = createClient({
  url: "libsql://c42c4bf1-3827-4b9b-89d8-132fcb6cc308-runable.aws-us-east-2.turso.io",
  authToken: "eyJhbGciOiJFZERTQSIsInR5cCI6IkpXVCJ9.eyJpYXQiOjE3NzkwODcxODYsInAiOnsicnciOnsibnMiOlsiMDE5ZTM5ZGMtMTYwMS03ODY0LTgzYmMtOTIzYjliYzdmZTNkIl19fSwicmlkIjoiYjkzNDYyYmEtYjdmOS00YmUyLWE4ZGItMmNlYWZjNGFhZjg1In0.DF7a7Hd0QmAAUC7evHDeMLlAb00AWIfB2X9YToJgkxYFajGAGuYZh-aJsmbQ6RcgFSl9FFrj6ypdiit1yXOaCQ",
});

// Despesas Fev-Mai 2026 actuais
const d = await db.execute(`
  SELECT date(data,'unixepoch') as d, valor, descricao, categoria
  FROM despesas
  WHERE strftime('%Y-%m',datetime(data,'unixepoch')) IN ('2026-02','2026-03','2026-04','2026-05')
  ORDER BY data, valor DESC
`);
console.log("=== DESPESAS FEV-MAI 2026 ACTUAIS NA DB ===");
let total = 0;
for (const r of d.rows) {
  console.log(`  ${r.d}  ${Number(r.valor).toFixed(2)}€  [${r.categoria}]  ${r.descricao}`);
  total += Number(r.valor);
}
console.log(`  TOTAL: ${total.toFixed(2)}€  (${d.rows.length} registos)`);

// Quotas pagas Fev-Mai 2026
const q = await db.execute(`
  SELECT ano, mes, COUNT(*) as n, SUM(valor) as quota, SUM(COALESCE(fundo_reserva,0)) as fundo, tipo
  FROM quotas WHERE pago=1 AND ano=2026 AND mes >= 2
  GROUP BY ano, mes, tipo ORDER BY mes, tipo
`);
console.log("\n=== QUOTAS PAGAS FEV-MAI 2026 ===");
for (const r of q.rows) {
  console.log(`  ${r.ano}-${String(r.mes).padStart(2,'0')}  tipo=${r.tipo}  n=${r.n}  quota=${Number(r.quota).toFixed(2)}€  fundo=${Number(r.fundo).toFixed(2)}€`);
}

// Fracoes
const f = await db.execute("SELECT numero, nome FROM fracoes ORDER BY numero");
console.log("\n=== FRAÇÕES NA DB ===");
for (const r of f.rows) {
  console.log(`  ${r.numero}: ${r.nome}`);
}
