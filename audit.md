# Auditoria recalcularSaldos + UI refresh

## BUGS ENCONTRADOS

### BUG 1 — CRÍTICO: recalcularSaldos() tem variáveis mortas (dead code)
`receitaYTD`, `totalDespesasYTD`, `inicioAno`, `fimMesAtual`, `mesAtual`, `saldosActuais`
são declaradas mas **nunca usadas**. TSC não rejeita (sem --noUnusedLocals).
Impacto: ~7 queries desnecessárias por sync. Não é bug de cálculo mas é ruído + risco de confusão.

### BUG 2 — CRÍTICO: atraso_fundo_reserva usa LIKE 'fundo%' que nunca matches
```ts
sql`tipo LIKE 'fundo%'`
```
O sync bancário (importTransactions) **nunca insere** quotas com tipo="fundo_reserva".
O fundo está guardado no campo `fundoReserva` (real) das quotas tipo="condominio".
Logo: `atrasoFundoBD` é sempre 0 → o upsert NUNCA acontece → o dashboard fica com o
SALDO_DEFAULT de 7.21€ para sempre.

Fix: calcular atraso_fundo_reserva como soma de `q.fundoReserva` nas quotas
tipo="condominio" onde pago=false.

### BUG 3 — MÉDIO: configuracoes.ts DEFAULTS têm valores stale/incorrectos
O route GET /api/configuracoes faz merge DEFAULTS + DB.
Se uma chave não está na DB (ex: após fresh deploy), retorna o valor stale dos DEFAULTS:
- `atraso_fundo_reserva`: "28.41" (Excel original) vs dashboard SALDO_DEFAULTS = 7.21 (correcto)
- `a_receber_quota_extra`: "1777.88" vs dashboard = 1723.56 (diferença 54.32€ dos pagamentos AI/AH)
- Faltam: `saldo_portao`, `a_receber_portao`, `portao_pago`

Fix: sincronizar DEFAULTS em configuracoes.ts com SALDO_DEFAULTS em dashboard.ts.

### BUG 4 — MÉDIO: morosos badge no Layout não actualiza após sync
Layout.tsx usa bare fetch em useEffect([], []) — só corre no mount.
Após `queryClient.invalidateQueries()` no sync, o badge NÃO actualiza porque não
é uma React Query — é state local.

Fix: expor função de refresh via contexto ou usar React Query para morosos-count.

### BUG 5 — MINOR: portao_pago NÃO é upsert quando pagoPortao === 0
```ts
if (pagoPortao > 0) await upsertSaldo("portao_pago", pagoPortao);
```
Se DB não tem pagamentos portão, `portao_pago` nunca é escrito em configuracoes.
O getSaldos() vai buscar o SALDO_DEFAULT de 113.98€ — que pode ser correcto (valor histórico
do Excel) mas não reflecte o que a DB sabe. Comportamento aceitável mas inconsistente.

### BUG 6 — MINOR: ne importado mas não usado
```ts
import { eq, and, sql, ne } from "drizzle-orm";
```
`ne` nunca é usado no ficheiro. Não quebra nada mas é import órfão.

## VERIFICAÇÕES OK (sem bug)

- quotas.valor e despesas.valor são `real` na DB → Drizzle retorna number nativo → reduce sem parseFloat é safe ✓
- configuracoes.valor é `text` → getSaldos() faz parseFloat() correctamente ✓
- upsertSaldo usa String(valor) → parseFloat(String(0)) = 0 → round-trip seguro ✓  
- onConflictDoUpdate target: schema.configuracoes.chave (PK) → correcto para Turso/SQLite ✓
- invalidateQueries() sem args no importar.tsx invalida TODAS as queries → dashboard refetch ✓
- staleTime 30s em main.tsx → após invalidateQueries, dados são stale imediatamente → refetch ✓
- Sem ciclo de importação circular (dashboard não importa bank) ✓
- recalcularSaldos() é chamada em ambos os paths (POST /sync + runBankSync()) ✓
- obras: guard `aReceberObrasBD > 0 || pagoObrasBD > 0` correcto ✓
- portão/elevadores/incêndio: lógica Excel − pagos DB correcta ✓
