/**
 * Script de teste: desempate IBAN colisão AF vs N
 * TXN 2: QA-V2-IBAN-AF-002 (actualizada com dados realistas)
 *   - IBAN: PT50003508260001938493063  (fração N e AF partilham)
 *   - debtorName: "RUI ALEXANDRE SILVA TORRES"
 *   - description: "ENTRADA 39 AF CONDOMINIO"
 *   - amount: 50
 *
 * Expectativa: desempate → AF
 *   scoreNome(AF): +35 (RUI ALEXANDRE SILVA TORRES match)
 *   scoreNome(N): 0
 *   totalScore AF: 50+35 = 85, N: 50+0 = 50 → AF vence
 */

import { identifyByMultiMatch } from "../src/api/lib/identity-matrix";

// Teste 1: dados reais (nome + entrada na descrição)
async function testeDesempateNome() {
  console.log("=== TESTE 1: Desempate por nome ===");
  const input = {
    descricao: "ENTRADA 39 AF CONDOMINIO",
    amount: 50,
    ibanSender: "PT50003508260001938493063",
    debtorName: "RUI ALEXANDRE SILVA TORRES",
  };
  console.log("Input:", JSON.stringify(input, null, 2));

  const result = await identifyByMultiMatch(input);
  if (!result) {
    console.error("FALHOU: retornou null\n");
    return false;
  }
  console.log(`Identificada: ${result.fracao.idFracao} | confidence=${result.confidence}% | criterios=[${result.criterios.join(",")}] | ibanNovo=${result.ibanNovoAprendido}`);
  const ok = result.fracao.idFracao === "AF";
  console.log(ok ? "✓ PASSOU: AF identificada\n" : `✗ FALHOU: esperava AF, obteve ${result.fracao.idFracao}\n`);
  return ok;
}

// Teste 2: só IBAN, sem desempate possível → null
async function testeEmpate() {
  console.log("=== TESTE 2: Empate (sem dados de desempate) → null ===");
  const input = {
    descricao: "Condominio",
    amount: 50,
    ibanSender: "PT50003508260001938493063",
    debtorName: undefined,
  };
  console.log("Input:", JSON.stringify(input, null, 2));

  const result = await identifyByMultiMatch(input);
  const ok = result === null;
  console.log(ok ? "✓ PASSOU: retornou null (empate correcto)\n" : `✗ FALHOU: esperava null, obteve ${result?.fracao.idFracao}\n`);
  return ok;
}

// Teste 3: desempate por "ENTRADA 39 AF" na descrição
async function testeDesempateDescricao() {
  console.log("=== TESTE 3: Desempate por entrada+fração na descrição ===");
  const input = {
    descricao: "ENTRADA 39 AF",
    amount: 50,
    ibanSender: "PT50003508260001938493063",
    debtorName: undefined,
  };
  console.log("Input:", JSON.stringify(input, null, 2));

  const result = await identifyByMultiMatch(input);
  if (!result) {
    console.error("FALHOU: retornou null\n");
    return false;
  }
  console.log(`Identificada: ${result.fracao.idFracao} | confidence=${result.confidence}% | criterios=[${result.criterios.join(",")}]`);
  const ok = result.fracao.idFracao === "AF";
  console.log(ok ? "✓ PASSOU: AF identificada por entrada+fração\n" : `✗ FALHOU: esperava AF, obteve ${result.fracao.idFracao}\n`);
  return ok;
}

async function main() {
  console.log("╔══════════════════════════════════════════════════════╗");
  console.log("║  RELATÓRIO SCORE DESEMPATE IBAN: FRAÇÃO AF vs N      ║");
  console.log("╠══════════════════════════════════════════════════════╣");
  console.log("║  IBAN partilhado: PT50003508260001938493063           ║");
  console.log("║  Fração N: FILIPE DANIEL F. TEIXEIRA (ENTRADA 21)    ║");
  console.log("║  Fração AF: RUI ALEXANDRE SILVA TORRES (ENTRADA 39)  ║");
  console.log("╚══════════════════════════════════════════════════════╝\n");

  const r1 = await testeDesempateNome();
  const r2 = await testeEmpate();
  const r3 = await testeDesempateDescricao();

  console.log("=== SUMÁRIO ===");
  console.log(`Teste 1 (nome match):        ${r1 ? "✓ PASSOU" : "✗ FALHOU"}`);
  console.log(`Teste 2 (empate → null):     ${r2 ? "✓ PASSOU" : "✗ FALHOU"}`);
  console.log(`Teste 3 (entrada+fração):    ${r3 ? "✓ PASSOU" : "✗ FALHOU"}`);

  const total = [r1, r2, r3].filter(Boolean).length;
  console.log(`\nResultado: ${total}/3 testes passaram`);

  if (total < 3) process.exit(1);
}

main().catch(console.error);
