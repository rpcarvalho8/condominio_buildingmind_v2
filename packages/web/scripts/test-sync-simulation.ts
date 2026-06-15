/**
 * ╔══════════════════════════════════════════════════════════════════╗
 * ║   QA / Auditoria de Runtime — Pipeline de Staging + Matriz      ║
 * ║   3 Cenários: A (match IBAN), B (cascata), C (falso positivo)   ║
 * ╚══════════════════════════════════════════════════════════════════╝
 *
 * Execução:
 *   cd packages/web
 *   bun scripts/test-sync-simulation.ts
 *
 * NOTA: Este script é DESTRUTIVO para a BD local (insere registos de teste).
 * Limpa os registos de teste automaticamente no final (flag --no-cleanup para manter).
 */

import { db } from "../src/api/database/index.ts";
import { bankTransactions, fracoes, quotas } from "../src/api/database/schema.ts";
import { eq, sql, inArray } from "drizzle-orm";
import {
  identifyByMultiMatch,
  processarCascataAmortizacao,
  getFracaoById,
  MATRIZ_PROPRIEDADES,
} from "../src/api/lib/identity-matrix.ts";

// ─── Flags ────────────────────────────────────────────────────────────────────
const NO_CLEANUP = process.argv.includes("--no-cleanup");
const VERBOSE    = process.argv.includes("--verbose");

// ─── Cores para output ────────────────────────────────────────────────────────
const C = {
  reset:  "\x1b[0m",
  bold:   "\x1b[1m",
  green:  "\x1b[32m",
  red:    "\x1b[31m",
  yellow: "\x1b[33m",
  cyan:   "\x1b[36m",
  grey:   "\x1b[90m",
  blue:   "\x1b[34m",
  magenta:"\x1b[35m",
};

function ok(msg: string)   { console.log(`  ${C.green}✓${C.reset} ${msg}`); }
function fail(msg: string) { console.log(`  ${C.red}✗${C.reset} ${C.red}${msg}${C.reset}`); }
function warn(msg: string) { console.log(`  ${C.yellow}⚠${C.reset} ${msg}`); }
function info(msg: string) { console.log(`  ${C.grey}→${C.reset} ${C.grey}${msg}${C.reset}`); }
function header(msg: string) {
  console.log(`\n${C.bold}${C.cyan}${"─".repeat(60)}${C.reset}`);
  console.log(`${C.bold}${C.cyan}  ${msg}${C.reset}`);
  console.log(`${C.bold}${C.cyan}${"─".repeat(60)}${C.reset}`);
}
function subheader(msg: string) {
  console.log(`\n${C.bold}${C.blue}  ▶ ${msg}${C.reset}`);
}

// ─── Resultados globais ───────────────────────────────────────────────────────
interface TestResult {
  cenario: string;
  nome: string;
  passed: number;
  failed: number;
  warnings: number;
  issues: string[];
}
const resultados: TestResult[] = [];
const txIdsParaLimpar: string[] = [];
const quotaIdsParaLimpar: string[] = [];

// ─── Utilitários ──────────────────────────────────────────────────────────────

/** Constrói um objecto de transação no formato que importTransactions() espera */
function buildTx(opts: {
  amount: number;
  description: string;
  ibanSender: string;
  debtorName: string;
  date?: Date;
  id?: string;
}) {
  const date = opts.date ?? new Date("2026-06-10");
  return {
    transaction_id: opts.id ?? `QA-TEST-${Date.now()}-${Math.random().toString(36).slice(2,8)}`,
    transaction_amount: { amount: opts.amount.toFixed(2), currency: "EUR" },
    credit_debit_indicator: "CRDT",
    booking_date: date.toISOString().slice(0, 10),
    remittance_information: [opts.description],
    debtor: {
      name: opts.debtorName,
      account: { iban: opts.ibanSender },
    },
  };
}

/** Insere uma transação directamente na tabela bank_transactions (imported=0) */
async function inserirTransacaoStaging(tx: ReturnType<typeof buildTx>): Promise<string> {
  const inserted = await db.insert(bankTransactions).values({
    transactionId: tx.transaction_id,
    amount: parseFloat(tx.transaction_amount.amount),
    currency: tx.transaction_amount.currency,
    date: new Date(tx.booking_date),
    description: tx.remittance_information[0],
    debtorName: tx.debtor.name,
    type: tx.credit_debit_indicator,
    status: "pending",
    imported: 0,
    rawData: JSON.stringify(tx),
  }).returning({ id: bankTransactions.id });

  return inserted[0].id;
}

/** Busca um registo da staging table por transactionId */
async function lerStagedTx(transactionId: string) {
  const rows = await db.select().from(bankTransactions)
    .where(eq(bankTransactions.transactionId, transactionId))
    .limit(1);
  return rows[0] ?? null;
}

// ─── PRÉ-AUDITORIA: estado da BD ─────────────────────────────────────────────

async function preAuditoria() {
  header("PRÉ-AUDITORIA — Estado da Base de Dados");

  const countTx = await db.run(sql`SELECT COUNT(*) as n FROM bank_transactions`);
  const countFracoes = await db.run(sql`SELECT COUNT(*) as n FROM fracoes`);
  const countQuotas = await db.run(sql`SELECT COUNT(*) as n FROM quotas`);

  info(`bank_transactions existentes: ${(countTx as any).rows?.[0]?.n ?? "?"}`);
  info(`fracoes na BD: ${(countFracoes as any).rows?.[0]?.n ?? "?"}`);
  info(`quotas existentes: ${(countQuotas as any).rows?.[0]?.n ?? "?"}`);
  info(`fracoes na MATRIZ em memória: ${MATRIZ_PROPRIEDADES.length}`);

  // Verificar que as colunas dívida existem
  const pragmaResult = await db.run(sql`PRAGMA table_info(fracoes)`);
  const cols = ((pragmaResult as any).rows ?? []).map((r: any) => r.name as string);
  const colsDivida = ["obras_divida", "incendio_divida", "indaqua_divida", "motor_divida"];
  for (const col of colsDivida) {
    if (cols.includes(col)) {
      ok(`Coluna BD fracoes.${col} existe`);
    } else {
      fail(`Coluna BD fracoes.${col} NÃO EXISTE — migration em falta!`);
    }
  }

  // Verificar consistência quota_mensal BD vs Matriz memória
  subheader("Consistência quota_mensal: BD vs Matriz");
  const fracoesBD = await db.run(sql`SELECT numero, quota_mensal FROM fracoes ORDER BY numero`);
  let discrepancias = 0;
  for (const row of (fracoesBD as any).rows ?? []) {
    const fMatriz = getFracaoById(row.numero as string);
    if (!fMatriz) {
      warn(`Fração BD '${row.numero}' não encontrada na MATRIZ`);
      continue;
    }
    const quotaMatriz = fMatriz.valoresFixos.condominio + fMatriz.valoresFixos.fundoReserva;
    const quotaBD = parseFloat(row.quota_mensal as string) || 0;
    const diff = Math.abs(quotaBD - quotaMatriz);
    if (diff > 0.05) {
      warn(`Fração ${row.numero}: BD=${quotaBD.toFixed(2)}€ vs MATRIZ=${quotaMatriz.toFixed(2)}€ — delta €${diff.toFixed(2)}`);
      discrepancias++;
    }
  }
  if (discrepancias === 0) {
    ok("Todos os valores quota_mensal estão consistentes entre BD e Matriz");
  } else {
    warn(`${discrepancias} fração(ões) com discrepância quota_mensal — MATRIZ é a fonte de verdade para a cascata`);
  }

  // Verificar dívidas na BD vs Matriz (BD deve ter 0 se nunca processadas; Matriz tem os valores reais do Excel)
  subheader("Auditoria dívidas BD vs Matriz");
  let dividasBDZero = 0;
  let dividasMatrizNaoZero = 0;
  for (const row of (fracoesBD as any).rows ?? []) {
    const fMatriz = getFracaoById(row.numero as string);
    if (!fMatriz) continue;
    const { obras, incendio, indaqua, motor } = fMatriz.dividasAtuais;
    const totalMatriz = obras + incendio + indaqua + motor;
    if (totalMatriz > 0) dividasMatrizNaoZero++;
  }
  const dividasBDRows = await db.run(
    sql`SELECT numero, obras_divida+incendio_divida+indaqua_divida+motor_divida as total FROM fracoes WHERE obras_divida+incendio_divida+indaqua_divida+motor_divida = 0`
  );
  dividasBDZero = ((dividasBDRows as any).rows ?? []).length;

  if (dividasMatrizNaoZero > 0) {
    warn(`${dividasMatrizNaoZero} fração(ões) com dívidas NA MATRIZ (Excel) mas BD tem tudo a 0.`);
    warn("→ Dívidas da Matriz não foram sincronizadas para a BD — a cascata vai usar valores BD (0).");
    warn("→ ACÇÃO RECOMENDADA: Correr script de seed de dívidas ou usar PATCH /api/identity/fracoes/:id/dividas.");
  } else {
    ok("Dívidas BD e Matriz em sincronia");
  }
}

// ─── CENÁRIO A ─────────────────────────────────────────────────────────────

async function testarCenarioA(): Promise<TestResult> {
  header("CENÁRIO A — Match Ideal por IBAN (Fração J)");

  const r: TestResult = { cenario: "A", nome: "Match IBAN Fração J", passed: 0, failed: 0, warnings: 0, issues: [] };

  const txData = buildTx({
    amount: 46.28,
    description: "Transferência Condominio",
    ibanSender: "PT50000700000035112419023",
    debtorName: "CONCEICAO MOREIRA",
  });

  // Step 1: Inserir na staging
  subheader("Step A.1 — Inserir em bank_transactions (imported=0)");
  let stagedId: string;
  try {
    stagedId = await inserirTransacaoStaging(txData);
    txIdsParaLimpar.push(txData.transaction_id);
    ok(`Transação inserida — id: ${stagedId}`);
    info(`transactionId: ${txData.transaction_id}`);
    info(`amount: €${txData.transaction_amount.amount}, description: "${txData.remittance_information[0]}"`);
    info(`ibanSender: ${txData.debtor.account.iban}`);
    r.passed++;
  } catch (e: any) {
    fail(`Falhou inserção staging: ${e.message}`);
    r.failed++;
    r.issues.push(`Staging insert falhou: ${e.message}`);
    return r;
  }

  // Step 2: Verificar que está na staging com imported=0
  subheader("Step A.2 — Verificar staging (imported=0, status=pending)");
  const staged = await lerStagedTx(txData.transaction_id);
  if (!staged) {
    fail("Registo não encontrado na BD após inserção");
    r.failed++; r.issues.push("Registo não encontrado após insert");
    return r;
  }
  if (staged.imported === 0) {
    ok(`imported=0 ✓ | status=${staged.status}`);
    r.passed++;
  } else {
    fail(`imported=${staged.imported} (esperado: 0)`);
    r.failed++; r.issues.push("imported deveria ser 0");
  }
  if (staged.amount === 46.28) {
    ok(`amount=€${staged.amount} ✓`);
    r.passed++;
  } else {
    fail(`amount=${staged.amount} (esperado: 46.28)`);
    r.failed++;
  }

  // Step 3: Testar motor matricial directamente
  subheader("Step A.3 — Motor Matricial identifyByMultiMatch()");
  const matrixResult = await identifyByMultiMatch({
    descricao: txData.remittance_information[0],
    amount: 46.28,
    ibanSender: txData.debtor.account.iban,
    debtorName: txData.debtor.name,
  });

  if (!matrixResult) {
    fail("identifyByMultiMatch() retornou null — fração NÃO identificada");
    r.failed++; r.issues.push("Motor matricial falhou identificação");
  } else {
    if (matrixResult.fracao.idFracao === "J") {
      ok(`Fração identificada: ${matrixResult.fracao.idFracao} — ${matrixResult.fracao.nomeProprietario}`);
      r.passed++;
    } else {
      fail(`Fração errada: ${matrixResult.fracao.idFracao} (esperada: J)`);
      r.failed++; r.issues.push(`Fração errada: ${matrixResult.fracao.idFracao} vs J`);
    }
    if (matrixResult.confidence >= 55) {
      ok(`Confidence: ${matrixResult.confidence}% ≥ 55 ✓`);
      r.passed++;
    } else {
      fail(`Confidence insuficiente: ${matrixResult.confidence}% < 55`);
      r.failed++;
    }
    ok(`Critérios activados: [${matrixResult.criterios.join(", ")}]`);
    info(`IBAN novo aprendido: ${matrixResult.ibanNovoAprendido}`);

    // Verificar que "iban" está entre os critérios
    if (matrixResult.criterios.includes("iban")) {
      ok(`Critério 'iban' activado ✓`);
      r.passed++;
    } else {
      warn(`Critério 'iban' NÃO activado — IBAN não estava no índice ainda`);
      r.warnings++;
    }

    // Step 4: Nota sobre valor
    subheader("Step A.4 — Análise do valor €46.28");
    const fracaoJ = getFracaoById("J")!;
    const quotaTotal = fracaoJ.valoresFixos.condominio + fracaoJ.valoresFixos.fundoReserva;
    info(`Matriz Fração J: condomínio=€${fracaoJ.valoresFixos.condominio} + fundo=€${fracaoJ.valoresFixos.fundoReserva} = €${quotaTotal.toFixed(2)}`);
    const diff = Math.abs(46.28 - quotaTotal);
    if (diff <= 5) {
      ok(`Valor €46.28 ≈ quota total €${quotaTotal.toFixed(2)} (delta=€${diff.toFixed(2)}) ✓`);
      r.passed++;
    } else {
      warn(`Delta €${diff.toFixed(2)} — valor não coincide exactamente com quota BD. IBAN garante match mesmo assim.`);
      r.warnings++;
    }
  }

  // Step 5: Verificar auto-learning IBAN (se foi novo)
  subheader("Step A.5 — Auto-Learning IBAN");
  const fracaoJBD = await db.run(sql`SELECT ibans_conhecidos FROM fracoes WHERE numero = 'J' LIMIT 1`);
  const ibansBD: string[] = JSON.parse((fracaoJBD as any).rows?.[0]?.ibans_conhecidos ?? "[]");
  if (ibansBD.includes("PT50000700000035112419023")) {
    ok("IBAN PT50000700000035112419023 persistido em BD para fração J ✓");
    r.passed++;
  } else {
    // Pode não ter sido aprendido se já estava na matriz estática — verificar
    const fracaoJ = getFracaoById("J")!;
    if (fracaoJ.ibansConhecidos.includes("PT50000700000035112419023")) {
      ok("IBAN já estava na MATRIZ estática — auto-learning não necessário (correcto)");
      r.passed++;
    } else {
      warn("IBAN não encontrado nem na BD nem na Matriz — possível falha de aprendizagem");
      r.warnings++;
    }
  }

  return r;
}

// ─── CENÁRIO B ─────────────────────────────────────────────────────────────

async function testarCenarioB(): Promise<TestResult> {
  header("CENÁRIO B — Match Nome + Cascata de Amortização (Fração L)");

  const r: TestResult = { cenario: "B", nome: "Match Nome + Cascata Fração L", passed: 0, failed: 0, warnings: 0, issues: [] };

  // Nota: amount=300€. Fração L: condomínio=46.98 + fundo=4.53 = 51.51€
  // Resto = 300 - 51.51 = 248.49€ — deve ir para cascata (obras=2110.97, indaqua=250.56, motor=29.53)
  // Mas BD tem dívidas todas a 0 — documentamos este desvio.
  const fracaoL = getFracaoById("L")!;
  const quotaLiquidaMatriz = fracaoL.valoresFixos.condominio + fracaoL.valoresFixos.fundoReserva;
  const restoEsperadoMatriz = parseFloat((300 - quotaLiquidaMatriz).toFixed(2));

  const txData = buildTx({
    amount: 300.00,
    description: "Pagamento Fração L",
    ibanSender: "PT50009999999999999999999", // IBAN fictício → deve accionar auto-learning
    debtorName: "JOÃO MARCO COUTINHO S MOREIRA",
  });

  // Step 1: Inserir staging
  subheader("Step B.1 — Inserir em bank_transactions (imported=0)");
  let stagedId: string;
  try {
    stagedId = await inserirTransacaoStaging(txData);
    txIdsParaLimpar.push(txData.transaction_id);
    ok(`Transação inserida — id: ${stagedId}`);
    info(`Cenário: IBAN fictício + nome real → auto-learning + cascata`);
    info(`Quota Matriz Fração L: €${fracaoL.valoresFixos.condominio} + €${fracaoL.valoresFixos.fundoReserva} = €${quotaLiquidaMatriz.toFixed(2)}`);
    info(`Resto esperado para cascata: €${restoEsperadoMatriz.toFixed(2)}`);
    r.passed++;
  } catch (e: any) {
    fail(`Falhou inserção staging: ${e.message}`);
    r.failed++; r.issues.push(e.message);
    return r;
  }

  // Step 2: Verificar staging
  subheader("Step B.2 — Verificar staging");
  const staged = await lerStagedTx(txData.transaction_id);
  if (staged && staged.imported === 0) {
    ok(`imported=0 ✓ | amount=€${staged.amount} | status=${staged.status}`);
    r.passed++;
  } else {
    fail(`Staging check falhou: ${JSON.stringify(staged?.imported)}`);
    r.failed++; r.issues.push("Staging não confirmado");
  }

  // Step 3: Motor Matricial
  subheader("Step B.3 — Motor Matricial (IBAN desconhecido + nome)");
  const matrixResult = await identifyByMultiMatch({
    descricao: txData.remittance_information[0],
    amount: 300.00,
    ibanSender: txData.debtor.account.iban,
    debtorName: txData.debtor.name,
  });

  if (!matrixResult) {
    fail("identifyByMultiMatch() retornou null — fração NÃO identificada");
    r.failed++; r.issues.push("Motor matricial falhou com IBAN fictício + nome");
    // Diagnóstico adicional
    warn("DIAGNÓSTICO: Verificar se 'JOÃO MARCO COUTINHO S MOREIRA' passa nomeCoincide()");
    warn("→ A descrição 'Pagamento Fração L' pode accionar descricaoMencaonaFracao() → verifcar");
  } else {
    if (matrixResult.fracao.idFracao === "L") {
      ok(`Fração identificada: L — ${matrixResult.fracao.nomeProprietario} ✓`);
      r.passed++;
    } else {
      fail(`Fração errada: ${matrixResult.fracao.idFracao} (esperada: L)`);
      r.failed++; r.issues.push(`Fração errada: ${matrixResult.fracao.idFracao}`);
    }
    if (matrixResult.confidence >= 55) {
      ok(`Confidence: ${matrixResult.confidence}% ≥ 55 ✓`);
      r.passed++;
    } else {
      fail(`Confidence insuficiente: ${matrixResult.confidence}% < 55`);
      r.failed++; r.issues.push(`Confidence ${matrixResult.confidence}% < 55`);
    }
    ok(`Critérios: [${matrixResult.criterios.join(", ")}]`);

    if (!matrixResult.criterios.includes("iban")) {
      ok(`Critério 'iban' correctamente AUSENTE (IBAN fictício) ✓`);
      r.passed++;
    }
    if (matrixResult.criterios.includes("nome")) {
      ok(`Critério 'nome' activado pelo debtorName ✓`);
      r.passed++;
    } else {
      warn("Critério 'nome' não activado — verificar nomeCoincide() para este nome");
      r.warnings++; r.issues.push("Critério 'nome' não activado");
    }

    // Step 4: Auto-learning IBAN fictício
    subheader("Step B.4 — Auto-Learning IBAN fictício");
    if (matrixResult.ibanNovoAprendido) {
      ok("IBAN PT50009999999999999999999 aprendido e associado à fração L ✓");
      r.passed++;
      // Verificar na BD
      const lBD = await db.run(sql`SELECT ibans_conhecidos FROM fracoes WHERE numero = 'L' LIMIT 1`);
      const ibansL = JSON.parse((lBD as any).rows?.[0]?.ibans_conhecidos ?? "[]");
      if (ibansL.includes("PT50009999999999999999999")) {
        ok("IBAN fictício persistido em BD ✓");
        r.passed++;
      } else {
        fail("IBAN fictício NÃO encontrado na BD após learnIBAN()");
        r.failed++; r.issues.push("learnIBAN() falhou persistência");
      }
    } else {
      warn("ibanNovoAprendido=false — IBAN já existia ou learnIBAN não foi chamado");
      r.warnings++;
    }

    // Step 5: Cascata de amortização
    subheader("Step B.5 — Cascata de Amortização Dinâmica");
    const fracaoBD = await db.run(sql`SELECT id, obras_divida, incendio_divida, indaqua_divida, motor_divida FROM fracoes WHERE numero = 'L' LIMIT 1`);
    const rowL = (fracaoBD as any).rows?.[0];
    if (!rowL) {
      fail("Fração L não encontrada na BD");
      r.failed++; r.issues.push("Fração L não encontrada"); return r;
    }

    const dividasAntesCascata = {
      obras:    parseFloat(rowL.obras_divida)    || 0,
      incendio: parseFloat(rowL.incendio_divida) || 0,
      indaqua:  parseFloat(rowL.indaqua_divida)  || 0,
      motor:    parseFloat(rowL.motor_divida)    || 0,
    };
    info(`Dívidas BD antes da cascata: obras=€${dividasAntesCascata.obras} | indaqua=€${dividasAntesCascata.indaqua} | incendio=€${dividasAntesCascata.incendio} | motor=€${dividasAntesCascata.motor}`);
    info(`Dívidas MATRIZ: obras=€${fracaoL.dividasAtuais.obras} | indaqua=€${fracaoL.dividasAtuais.indaqua} | incendio=€${fracaoL.dividasAtuais.incendio} | motor=€${fracaoL.dividasAtuais.motor}`);

    const totalDividaBD = Object.values(dividasAntesCascata).reduce((a, b) => a + b, 0);
    if (totalDividaBD === 0) {
      warn("DESVIO DETECTADO: Dívidas BD = €0 (Matriz tem obras=€2110.97, indaqua=€250.56, motor=€29.53)");
      warn("→ As dívidas do Excel nunca foram sincronizadas para a BD.");
      warn("→ A cascata vai processar com base em BD (€0) — NÃO haverá amortizações reais.");
      warn("→ ACÇÃO RECOMENDADA: Adicionar seed de dívidas ou executar PATCH /api/identity/fracoes/L/dividas");
      r.warnings += 3;
      r.issues.push("BD.dividas=0 vs MATRIZ.dividas!=0 — seed em falta");
    }

    const cascataResult = await processarCascataAmortizacao(
      "L",
      300.00,
      rowL.id as string,
      6,
      2026,
    );

    if (!cascataResult) {
      fail("processarCascataAmortizacao() retornou null");
      r.failed++; r.issues.push("Cascata retornou null");
    } else {
      ok(`Cascata executada para fração L`);
      r.passed++;
      info(`  valorEntrada: €${cascataResult.valorEntrada.toFixed(2)}`);
      info(`  quotaLiquida: €${cascataResult.quotaLiquida.toFixed(2)} (matriz: €${quotaLiquidaMatriz.toFixed(2)})`);
      info(`  restoAmortizacao: €${cascataResult.restoAmortizacao.toFixed(2)}`);
      info(`  sobra final: €${cascataResult.sobra.toFixed(2)}`);

      if (cascataResult.aplicacoes.length === 0) {
        if (totalDividaBD === 0) {
          warn("Sem amortizações — esperado pois BD.dividas=0 (ver DESVIO acima)");
          r.warnings++;
        } else {
          fail("Sem amortizações mas existiam dívidas");
          r.failed++; r.issues.push("Nenhuma amortização aplicada");
        }
      } else {
        for (const ap of cascataResult.aplicacoes) {
          ok(`  Amortização: ${ap.tipo}: €${ap.valorAntes.toFixed(2)} → €${ap.valorDepois.toFixed(2)} (amortizado: -€${ap.valorAmortizado.toFixed(2)})`);
          r.passed++;
        }
      }

      // Verificar que quota_liquida bate com a matriz (tolerância 0.05€)
      const diffQuota = Math.abs(cascataResult.quotaLiquida - quotaLiquidaMatriz);
      if (diffQuota <= 0.05) {
        ok(`quotaLiquida coincide com Matriz (€${quotaLiquidaMatriz.toFixed(2)}) — delta €${diffQuota.toFixed(2)} ✓`);
        r.passed++;
      } else {
        warn(`quotaLiquida €${cascataResult.quotaLiquida.toFixed(2)} != Matriz €${quotaLiquidaMatriz.toFixed(2)} — delta €${diffQuota.toFixed(2)}`);
        warn("→ processarCascataAmortizacao() usa valoresFixos da MATRIZ em memória (correcto)");
        r.warnings++;
      }
    }
  }

  return r;
}

// ─── CENÁRIO C ─────────────────────────────────────────────────────────────

async function testarCenarioC(): Promise<TestResult> {
  header("CENÁRIO C — Falso Positivo / Intervenção Manual");

  const r: TestResult = { cenario: "C", nome: "Falso Positivo", passed: 0, failed: 0, warnings: 0, issues: [] };

  const txData = buildTx({
    amount: 20.00,
    description: "Condominio Garagem",
    ibanSender: "PT50001111111111111111111",
    debtorName: "ALGUEM DESCONHECIDO",
  });

  // Step 1: Inserir staging
  subheader("Step C.1 — Inserir em bank_transactions (imported=0)");
  try {
    const stagedId = await inserirTransacaoStaging(txData);
    txIdsParaLimpar.push(txData.transaction_id);
    ok(`Transação inserida — id: ${stagedId}`);
    r.passed++;
  } catch (e: any) {
    fail(`Falhou inserção: ${e.message}`);
    r.failed++; r.issues.push(e.message); return r;
  }

  // Step 2: Verificar staging
  subheader("Step C.2 — Verificar staging");
  const staged = await lerStagedTx(txData.transaction_id);
  if (staged && staged.imported === 0) {
    ok(`imported=0 ✓ | amount=€${staged.amount} | description="${staged.description}"`);
    r.passed++;
  } else {
    fail("Staging check falhou");
    r.failed++; r.issues.push("Staging não confirmado"); return r;
  }

  // Step 3: Motor Matricial — DEVE falhar (não identificar)
  subheader("Step C.3 — Motor Matricial — ESPERADO: null (não identificar)");
  const matrixResult = await identifyByMultiMatch({
    descricao: txData.remittance_information[0],
    amount: 20.00,
    ibanSender: txData.debtor.account.iban,
    debtorName: txData.debtor.name,
  });

  if (!matrixResult) {
    ok("Motor Matricial retornou null — falso positivo correctamente REJEITADO ✓");
    ok("Transação fica em staging (imported=0) aguardando intervenção manual ✓");
    r.passed += 2;
  } else {
    fail(`Motor Matricial identificou fração: ${matrixResult.fracao.idFracao} (confidence=${matrixResult.confidence}%) — FALSO POSITIVO!`);
    fail(`Critérios: [${matrixResult.criterios.join(", ")}]`);
    r.failed++;
    r.issues.push(`Falso positivo: identificou fração ${matrixResult.fracao.idFracao} com ${matrixResult.confidence}%`);

    // Diagnóstico
    warn("DIAGNÓSTICO DO FALSO POSITIVO:");
    warn(`→ Descrição "Condominio Garagem" pode ter activado critério 'valor_fixo' ou 'descricao_fracao'`);
    warn("→ Verificar threshold: score < 55 ou < 2 critérios deveria rejeitar");
    warn(`→ Score obtido: ${matrixResult.confidence}, criterios: ${matrixResult.criterios.join("+")}`);
  }

  // Step 4: Verificar que IBAN fictício NÃO foi aprendido
  subheader("Step C.4 — IBAN fictício NÃO deve ser aprendido");
  if (!matrixResult || !matrixResult.ibanNovoAprendido) {
    ok("IBAN PT50001111111111111111111 NÃO foi aprendido ✓ (correcto — identificação rejeitada)");
    r.passed++;
  } else {
    fail("IBAN fictício foi aprendido indevidamente — risco de contaminação do índice!");
    r.failed++; r.issues.push("IBAN de falso positivo aprendido indevidamente");
  }

  // Step 5: Verificar que a transação permanece em staging como "cativo"
  subheader("Step C.5 — Transação deve permanecer como 'cativo' (imported=0)");
  const stagedFinal = await lerStagedTx(txData.transaction_id);
  if (stagedFinal && stagedFinal.imported === 0) {
    ok(`Transação permanece imported=0 — vai aparecer como cativo na conta à ordem ✓`);
    ok(`Esta é a situação correcta: gestor deve rever manualmente.`);
    r.passed += 2;
  } else {
    warn("Estado inesperado da transação após tentativa de matching");
    r.warnings++;
  }

  return r;
}

// ─── RELATÓRIO FINAL ────────────────────────────────────────────────────────

function imprimirRelatorio(resultados: TestResult[]) {
  header("RELATÓRIO FINAL DE QA");

  let totalPass = 0, totalFail = 0, totalWarn = 0;
  const issues: string[] = [];

  for (const r of resultados) {
    const status = r.failed === 0
      ? `${C.green}PASSED${C.reset}`
      : `${C.red}FAILED${C.reset}`;
    console.log(`\n  ${C.bold}Cenário ${r.cenario} — ${r.nome}:${C.reset} ${status}`);
    console.log(`    Passed: ${C.green}${r.passed}${C.reset}  |  Failed: ${C.red}${r.failed}${C.reset}  |  Warnings: ${C.yellow}${r.warnings}${C.reset}`);
    if (r.issues.length > 0) {
      console.log(`    Issues:`);
      for (const iss of r.issues) {
        console.log(`      ${C.red}• ${iss}${C.reset}`);
        issues.push(`[Cenário ${r.cenario}] ${iss}`);
      }
    }
    totalPass += r.passed;
    totalFail += r.failed;
    totalWarn += r.warnings;
  }

  console.log(`\n${C.bold}${"═".repeat(60)}${C.reset}`);
  console.log(`${C.bold}  TOTAIS: Passed=${C.green}${totalPass}${C.reset}${C.bold}  Failed=${C.red}${totalFail}${C.reset}${C.bold}  Warnings=${C.yellow}${totalWarn}${C.reset}`);

  const allPassed = resultados.every(r => r.failed === 0);
  if (allPassed) {
    console.log(`\n  ${C.green}${C.bold}✓ TODOS OS CENÁRIOS PASSARAM${C.reset}`);
  } else {
    console.log(`\n  ${C.red}${C.bold}✗ FALHAS DETECTADAS — VER ACIMA${C.reset}`);
  }

  if (issues.length > 0) {
    console.log(`\n${C.bold}${C.red}  ISSUES CRÍTICOS:${C.reset}`);
    for (const i of issues) console.log(`    ${C.red}• ${i}${C.reset}`);
  }

  console.log(`\n${C.bold}${C.yellow}  NOTAS / DESVIOS CONHECIDOS:${C.reset}`);
  console.log(`  ${C.yellow}• BD.fracoes.dividas está tudo a 0 — seed do Excel não foi aplicado à BD.${C.reset}`);
  console.log(`  ${C.yellow}• A cascata de amortização usa BD como fonte de verdade → sem efeito real até seed.${C.reset}`);
  console.log(`  ${C.yellow}• Fração AC partilha IBAN com J; AF partilha com N; AH partilha com AI — issue Excel conhecido.${C.reset}`);
  console.log(`${C.bold}${"═".repeat(60)}${C.reset}\n`);
}

// ─── CLEANUP ─────────────────────────────────────────────────────────────────

async function cleanup() {
  if (NO_CLEANUP) {
    console.log(`\n${C.yellow}  [--no-cleanup] Registos de teste mantidos na BD${C.reset}`);
    console.log(`  Transações inseridas: ${txIdsParaLimpar.join(", ")}`);
    return;
  }

  console.log(`\n${C.grey}  Limpeza: remover registos de teste...${C.reset}`);
  for (const txId of txIdsParaLimpar) {
    await db.delete(bankTransactions).where(eq(bankTransactions.transactionId, txId));
  }
  for (const qId of quotaIdsParaLimpar) {
    await db.delete(quotas).where(eq(quotas.id, qId));
  }
  // Limpar IBAN fictício aprendido para fração L
  try {
    const lBD = await db.run(sql`SELECT ibans_conhecidos FROM fracoes WHERE numero = 'L' LIMIT 1`);
    const ibansL: string[] = JSON.parse((lBD as any).rows?.[0]?.ibans_conhecidos ?? "[]");
    const ibansLimpos = ibansL.filter(i => i !== "PT50009999999999999999999");
    if (ibansLimpos.length !== ibansL.length) {
      await db.run(sql`UPDATE fracoes SET ibans_conhecidos = ${JSON.stringify(ibansLimpos)} WHERE numero = 'L'`);
      console.log(`  ${C.grey}→ IBAN fictício removido da fração L${C.reset}`);
    }
  } catch {}
  console.log(`  ${C.green}✓ Limpeza concluída${C.reset}`);
}

// ─── MAIN ─────────────────────────────────────────────────────────────────────

async function main() {
  console.log(`\n${C.bold}${C.magenta}╔══════════════════════════════════════════════════════════════╗${C.reset}`);
  console.log(`${C.bold}${C.magenta}║   QA Runtime — Condomínio 7663 — Pipeline Staging + Matriz  ║${C.reset}`);
  console.log(`${C.bold}${C.magenta}║   Commit: 08d7a23 / 204f2ad                                 ║${C.reset}`);
  console.log(`${C.bold}${C.magenta}╚══════════════════════════════════════════════════════════════╝${C.reset}`);
  console.log(`  ${C.grey}Flags: --no-cleanup=${NO_CLEANUP} --verbose=${VERBOSE}${C.reset}`);

  await preAuditoria();

  const rA = await testarCenarioA();
  resultados.push(rA);

  const rB = await testarCenarioB();
  resultados.push(rB);

  const rC = await testarCenarioC();
  resultados.push(rC);

  imprimirRelatorio(resultados);

  await cleanup();

  // Exit code: 1 se algum cenário falhou
  const allPassed = resultados.every(r => r.failed === 0);
  process.exit(allPassed ? 0 : 1);
}

main().catch((e) => {
  console.error(`\n${C.red}ERRO FATAL:${C.reset}`, e);
  process.exit(2);
});
