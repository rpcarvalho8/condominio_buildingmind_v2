/**
 * CSV Bank Parser — Santander Condomínio CSV
 * Parses and auto-categorises all movements from Santander bank CSV exports.
 *
 * CSV format (latin-1, 2-row header):
 *   Row 0: title
 *   Row 1: headers
 *   Row 2+: data [seq, data_op, data_val, mes, ano, tipo, descritivo, montante, saldo, categoria, sub_categoria, ...]
 */

import fs from "node:fs";
import path from "node:path";
import { fullReconcile, matchSpecialCases } from "./reconciliation-engine";

// ─── Owner / Fração map ────────────────────────────────────────────────────────
export const FRACOES_INFO: Record<string, { nome: string; tipo: string; permilage: number }> = {
  J:  { nome: "Mª da Conceição S. Moreira",           tipo: "habitacao", permilage: 38.80 },
  L:  { nome: "João Marco Coutinho S. Moreira",        tipo: "habitacao", permilage: 41.76 },
  M:  { nome: "Jannara Maria dos Santos",              tipo: "habitacao", permilage: 39.50 },
  N:  { nome: "Filipe Daniel F. Teixeira",             tipo: "habitacao", permilage: 38.82 },
  O:  { nome: "Pedro Miguel R. Santos",                tipo: "habitacao", permilage: 41.76 },
  P:  { nome: "Nuno Ricardo de Sá Ribeiro",            tipo: "habitacao", permilage: 43.30 },
  Q:  { nome: "João Carlos Sousa Barros",              tipo: "habitacao", permilage: 37.14 },
  R:  { nome: "Vanessa Cristina Araújo Silva",         tipo: "habitacao", permilage: 56.75 },
  S:  { nome: "Célia Beatriz Sá",                     tipo: "habitacao", permilage: 32.34 },
  T:  { nome: "Susana Daniela Oliveira e Silva",       tipo: "habitacao", permilage: 38.50 },
  U:  { nome: "Catarina Reis Azevedo da Silva",        tipo: "habitacao", permilage: 57.21 },
  V:  { nome: "Sérgio Miguel da S. Monteiro",          tipo: "habitacao", permilage: 34.05 },
  X:  { nome: "Alexandre Ribeiro Maia",                tipo: "habitacao", permilage: 39.12 },
  Z:  { nome: "Ana Isabel Dias Costa",                 tipo: "habitacao", permilage: 55.15 },
  AA: { nome: "Olivia Cândida Ferreira Lima",          tipo: "habitacao", permilage: 35.06 },
  AB: { nome: "Ilídio António Morais Marinho",         tipo: "habitacao", permilage: 35.00 },
  AE: { nome: "Germano A. M. Machado",                 tipo: "habitacao", permilage: 37.00 },
  AF: { nome: "Rui Alexandre Silva Torres",            tipo: "habitacao", permilage: 35.21 },
  AG: { nome: "João Pedro Amorim Dias",                tipo: "habitacao", permilage: 35.41 },
  AH: { nome: "Mª Madalena Costa F. Ramos",           tipo: "habitacao", permilage: 40.96 },
  AI: { nome: "Rui Carvalho",                         tipo: "habitacao", permilage: 35.85 },
  AJ: { nome: "Mariana da Silva Reis",                 tipo: "habitacao", permilage: 34.57 },
  G:  { nome: "Marma Concept, Unipessoal Lda",         tipo: "loja",      permilage: 22.96 },
  H:  { nome: "Joana Andreia Azevedo Dias",            tipo: "loja",      permilage: 16.96 },
  I:  { nome: "Joana Andreia Azevedo Dias",            tipo: "loja",      permilage: 22.00 },
  AC: { nome: "Maria de Fátima Martins Ascenção",      tipo: "loja",      permilage: 18.10 },
  AD: { nome: "Escutoglamour Unipessoal, Lda",         tipo: "loja",      permilage: 18.68 },
  A:  { nome: "Universe Sustainable, SA",             tipo: "garagem",   permilage: 2.89 },
  B:  { nome: "Germano A. M. Machado",                 tipo: "garagem",   permilage: 2.86 },
  C:  { nome: "Universe Sustainable, SA",             tipo: "garagem",   permilage: 2.89 },
  D:  { nome: "Susana Daniela Oliveira e Silva",       tipo: "garagem",   permilage: 3.15 },
  E:  { nome: "Tiago Pinheiro Correia",                tipo: "garagem",   permilage: 3.00 },
  F:  { nome: "Tiago Pinheiro Correia",                tipo: "garagem",   permilage: 3.25 },
};

// ─── Name → Fração map (from bank descritivos, incl. past tenants) ─────────────
// Normalised uppercase, diacritic-free fragments → fração ID
const NAME_FRACAO_MAP: Array<[string, string | null]> = [
  // === CONFIRMED (amount-matched) ===
  ["JOAO MARCO COUTINHO",         "L"],
  ["MARCO COUTINHO",              "L"],
  ["FILIPE DANIEL FERREIRA",      "N"],
  ["FILIPE DANIEL F TEIXEIRA",    "N"],
  ["NUNO RICARDO SA RIBEIRO",     "P"],
  ["NUNO RIBEIRO",                "P"],   // TRF.A CRED.SEPA+ short name
  ["PEDRO MIGUEL R SANTOS",       "O"],
  ["PEDRO MIGUEL RODRIGUES",      "O"],   // same person diff bank name
  ["VANESSA CRISTINA ARAUJO",     "R"],
  ["VANESSA CRISTINA",            "R"],
  ["DRA VANESSA CRISTINA",        "R"],
  ["CELIA BEATRIZ SA",            "S"],
  ["CELIA BEATRIZ AZEVE",         "S"],   // truncated intrabanc
  ["CATARINA REIS AZEVEDO",       "U"],
  ["SERGIO MIGUEL SILVA MONTEIRO","V"],
  ["SERGIO MIGUEL DA S MONTEIRO", "V"],
  ["ALEXANDRE RIBEIRO MAIA",      "X"],
  ["ANA ISABEL DIAS COSTA",       "Z"],
  ["OLIVIA CANDIDA FERREIRA LIMA","AA"],
  ["OLIVIA LIMA",                 "AA"],  // TRF.A short
  ["ILIDIO ANTONIO MORAIS",       "AB"],
  ["ILIDIO MARINHO",              "AB"],
  ["GERMANO AUGUSTO MAR",         "AE"],  // INTRABANC truncated
  ["GERMANO MACH",                "AE"],  // "Germano Macahdo" typo in CSV
  ["JOAO PEDRO AMORIM DIAS",      "AG"],
  ["RUI PEDRO MAIA OLIVEIRA",     "AI"],  // current owner (Rui Carvalho)
  ["RUI CARVALHO",                "AI"],
  ["JANNARA MARIA SANTOS",        "M"],
  ["JANNARA MARIA DOS SANTOS",    "M"],
  // === PREVIOUS TENANTS (amount-verified) ===
  ["TIAGO FILIPE MOREIRA GOMES",  "AF"],  // 30.84€ = AF in 2023
  ["TIAGO FILIPE MOREIRA G",      "AF"],
  ["JOANA SANTOS CAVADAS",        "Q"],   // 32.53€ = Q in 2023
  ["MAGGY DA YESKI TORRES",       "AG"],  // 31€ ≈ AG in 2023
  ["GUSTAVO ADOLFO PIMENTA",      "AJ"],  // Pays ~40€, likely prev AJ tenant
  ["GUSTAVO ADOLFO P COUTO",      "AJ"],
  ["GUSTAVO HARDMAN",             "AJ"],  // TRF.A short name
  ["CAMILO AUGUSTO SOARES SILVA", "AH"],  // 46.08€, 87.04€ → AH
  ["JOANA PATRICIA OLIVEIRA",     "H"],   // Joana Andreia Azevedo = current H/I owner
  ["JOANA PATRICIA OLIVEIR",      "H"],   // truncated
  ["JOANA ANDREIA AZEVEDO",       "H"],
  ["EURICA CAMARA SILVA",         "X"],   // 33.50€ ≈ X 2023 (39.12 × 0.8759 = 34.26... close)
  ["PEDRO MIGUEL DA SILVA",       "G"],   // 33.50€ → G loja prev tenant
  ["MARMA CONCEPT",               "G"],   // current G loja owner
  ["UNIVERSE SUSTAINABLE",        "A"],   // garagem A (also has C but both same company)
  ["SUSANA SILVA",                "T"],   // Susana pays for T and D (combined)
  ["SUSANA DANIELA",              "T"],
  // Truncated names that miss the suffix match
  ["SERGIO MIGUEL SILVA MO",      "V"],   // truncated at 22 chars
  ["SERGIO MIGUEL DA S MONTE",    "V"],
  ["RUI PEDRO MAIA OLIVEIR",      "AI"],  // truncated (= Rui Carvalho)
  ["RUI PEDRO MAIA OLIVEI",       "AI"],
  // === NOT RESIDENTS / UNKNOWN ===
  ["FAMALIPET CLINICA",           null],  // vet clinic, prev loja tenant (external)
  ["COND RUA CIMO DE VILA",       null],  // another building / shared cost
  ["ENG JOAO MOREIRA",            null],  // unknown
  ["JOAQUIM JORGE PEREIRA",       null],  // unknown lump sum
  ["CAMARA",                      null],
];

function normalise(s: string): string {
  return s.toUpperCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^A-Z0-9 ]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function matchNameToFracao(name: string): string | null | undefined {
  const norm = normalise(name);
  for (const [fragment, fracao] of NAME_FRACAO_MAP) {
    if (norm.includes(fragment)) return fracao;
  }
  return undefined; // not found — different from null (null = confirmed not a resident)
}

// ─── Amount parser (Portuguese format) ────────────────────────────────────────
function parseAmount(s: string): number {
  s = s.replace(/[\u0080€\s]/g, "").trim();
  if (!s) return 0;
  if (s.includes(",") && s.includes(".")) {
    const ci = s.lastIndexOf(",");
    const di = s.lastIndexOf(".");
    s = di > ci ? s.replace(/,/g, "") : s.replace(/\./g, "").replace(",", ".");
  } else if (s.includes(",")) {
    s = s.replace(",", ".");
  }
  const n = parseFloat(s);
  return isNaN(n) ? 0 : n;
}

// ─── Descritivo → categoria (expenses) ────────────────────────────────────────
function inferExpenseCategory(desc: string): string {
  const u = normalise(desc);
  if (/LIMPEZA|LIMPZ|TANQUELUZ/.test(u))          return "Limpeza";
  if (/JARDIM|JARDINEIRO|JARDINAGE|JPR|URB.*FONTE/.test(u)) return "Jardim";
  if (/INDAQUA|AGUA/.test(u))                      return "Água";
  if (/EDP|IBERDROLA|ENDESA|ELETRICIDADE/.test(u)) return "Eletricidade";
  if (/HONORA|AVENCA ADM|ADM/.test(u))             return "Honorários Administração";
  if (/MANUTENCAO|EQUIP|REBIMOTOR|QUESTAO MODERNA/.test(u)) return "Manutenção";
  if (/PORTAO|CARTAO NOS/.test(u))                 return "Manutenção";
  if (/INJUNCAO/.test(u))                          return "Diversos";
  if (/FATURA|FAC |FT\d/.test(u))                  return "Manutenção";
  if (/ELEVADOR/.test(u))                          return "Elevadores";
  if (/INCENDIO|INCÊNDIO/.test(u))                 return "Obra-Incêndio";
  return "Diversos";
}

// ─── Movement record ──────────────────────────────────────────────────────────
export interface BankMovement {
  seq: number;
  dataOperacao: string;
  dataValor: string;
  mes: string;
  ano: string;
  tipo: "Entrada" | "Saída" | string;
  descritivo: string;
  montante: number;
  saldo: number;
  // Assigned by parser:
  categoria: string;
  subCategoria: string;           // fração ID for resident payments
  // Categorisation metadata:
  categoriaSource: "csv" | "auto" | "unmatched";
  nomeIdentificado?: string;      // name parsed from descritivo
  fracaoIdentificada?: string | null;  // fração matched (null = confirmed non-resident)
  notaCategorizacao?: string;
}

export interface ParseResult {
  conta: "condominio" | "obras";
  ficheiro: string;
  totalMovimentos: number;
  movimentos: BankMovement[];
  estatisticas: {
    entradas: number;
    saidas: number;
    totalEntradas: number;
    totalSaidas: number;
    saldoFinal: number;
    categorizados: number;
    naoCategorizado: number;
    despesasBancarias: number;
    porFracao: Record<string, { count: number; total: number }>;
    porCategoria: Record<string, { count: number; total: number }>;
    pagamentosNaoIdentificados: BankMovement[];
  };
}

// ─── Simple CSV parser (no external deps) ─────────────────────────────────────
function parseCSVRow(line: string): string[] {
  const fields: string[] = [];
  let cur = "";
  let inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (ch === '"') {
      inQuotes = !inQuotes;
    } else if (ch === "," && !inQuotes) {
      fields.push(cur);
      cur = "";
    } else {
      cur += ch;
    }
  }
  fields.push(cur);
  return fields;
}

// ─── Main parser ──────────────────────────────────────────────────────────────
export function parseCSV(filePath: string, conta: "condominio" | "obras"): ParseResult {
  // Read file as latin-1 → convert to utf-8
  const rawBuffer = fs.readFileSync(filePath);
  // Decode latin-1 manually (including euro sign 0x80 → 0x20AC)
  let content = "";
  for (let i = 0; i < rawBuffer.length; i++) {
    const code = rawBuffer[i];
    content += code > 127 ? String.fromCodePoint(code === 0x80 ? 0x20AC : code) : String.fromCodePoint(code);
  }

  // Handle both \r\n and \n line endings
  const lines = content.split(/\r?\n/);
  // Row 0 = title, Row 1 = headers, Row 2+ = data
  const dataLines = lines.slice(2);

  const movimentos: BankMovement[] = [];
  let seqCounter = 0;

  for (const line of dataLines) {
    if (!line.trim()) continue;
    const cols = parseCSVRow(line);
    if (cols.length < 8) continue;

    // The CSV seq column is only filled on the first row per date group
    // All subsequent rows of the same date have empty seq — we still want them
    const seqRaw = cols[0]?.trim();
    const hasDate = cols[1]?.trim().match(/^\d{2}-\d{2}-\d{4}$/);
    if (!hasDate) continue; // skip non-data rows

    seqCounter++;
    const seq = seqRaw && !isNaN(Number(seqRaw)) ? Number(seqRaw) : seqCounter;

    const descritivo = cols[6]?.trim() ?? "";
    if (!descritivo) continue;

    const montante = parseAmount(cols[7] ?? "");
    const saldo    = parseAmount(cols[8] ?? "");
    const catCSV   = cols[9]?.trim() ?? "";
    const subCSV   = cols[10]?.trim() ?? "";

    const mov: BankMovement = {
      seq,
      dataOperacao: cols[1]?.trim() ?? "",
      dataValor:    cols[2]?.trim() ?? "",
      mes:          cols[3]?.trim() ?? "",
      ano:          cols[4]?.trim() ?? "",
      tipo:         cols[5]?.trim() ?? "",
      descritivo,
      montante,
      saldo,
      categoria:    catCSV || "",
      subCategoria: subCSV || "",
      categoriaSource: catCSV ? "csv" : "unmatched",
    };

    // If already categorised in CSV, keep it
    if (catCSV) {
      mov.categoriaSource = "csv";
      movimentos.push(mov);
      continue;
    }

    const descUp = normalise(descritivo);

    // ── 1. Bank charges ──
    if (/COMISSAO|COMISS[AÃ]O|IMP\.SELO|IMPOSTO DO SELO|MANUTENCAO DE CONTA|COMISSAO DE TRAMITACAO/.test(descUp)) {
      mov.categoria = "Despesas bancárias";
      mov.categoriaSource = "auto";
      mov.notaCategorizacao = "Encargo bancário";
      movimentos.push(mov);
      continue;
    }

    // ── 2. Outgoing transfers (P/ = para = to) ──
    const outMatch = descritivo.match(/^(?:TRF\.IMED\.\s+P\/|TRF\s+CRED\s+SEPA\+\s+P\/)\s*(.+?)(?:-[A-Z0-9]+)?\s*$/i);
    if (outMatch || /^TRF\.IMED\.\s+P\//i.test(descritivo)) {
      const label = outMatch?.[1]?.trim()?.toUpperCase() ?? "";
      mov.categoria = inferExpenseCategory(descritivo);
      mov.categoriaSource = "auto";
      mov.notaCategorizacao = `Saída para: ${label}`;
      movimentos.push(mov);
      continue;
    }

    // ── 3. Direct debits (utilities) ──
    if (/D[ÉE]BITO DIRETO/.test(descUp)) {
      mov.categoria = inferExpenseCategory(descritivo);
      mov.categoriaSource = "auto";
      mov.notaCategorizacao = "Débito direto";
      movimentos.push(mov);
      continue;
    }

    // ── 4. Known expense descriptions (outgoing) ──
    if (mov.tipo === "Saída" || montante < 0) {
      mov.categoria = inferExpenseCategory(descritivo);
      mov.categoriaSource = "auto";
      movimentos.push(mov);
      continue;
    }

    // ── 5. Incoming transfers — try to match to fração ──
    let nameRaw: string | null = null;

    const sepaMatch  = descritivo.match(/TRF\s+CRED\s+(?:SEPA\+\s+)?(?:INTRABANC\s+)?DE\s+(.+?)(?:-[A-Z0-9]+)?\s*$/i);
    const imedMatch  = descritivo.match(/TRF\.IMED\.\s+DE\s+(.+?)(?:-[A-Z0-9]+)?\s*$/i);
    const acredMatch = descritivo.match(/TRF\.A\s+CRED\.SEPA\+\s+(.+?)\s*$/i);

    if (sepaMatch)  nameRaw = sepaMatch[1].trim();
    else if (imedMatch) nameRaw = imedMatch[1].trim();
    else if (acredMatch) nameRaw = acredMatch[1].trim();

    if (nameRaw) {
      const fracaoMatch = matchNameToFracao(nameRaw);
      mov.nomeIdentificado = nameRaw;

      if (fracaoMatch === null) {
        // Confirmed not a resident
        mov.categoria = "Diversos";
        mov.categoriaSource = "auto";
        mov.fracaoIdentificada = null;
        mov.notaCategorizacao = `Pagador externo: ${nameRaw}`;
      } else if (fracaoMatch) {
        // Matched to a fração
        mov.categoria = "Condomínio";
        mov.subCategoria = fracaoMatch;
        mov.fracaoIdentificada = fracaoMatch;
        mov.categoriaSource = "auto";
        mov.notaCategorizacao = `Identificado: ${nameRaw} → Fração ${fracaoMatch}`;
      } else {
        // Unknown payer — flag as unmatched
        mov.categoria = "Condomínio";
        mov.categoriaSource = "unmatched";
        mov.notaCategorizacao = `Nome não identificado: ${nameRaw}`;
      }
      movimentos.push(mov);
      continue;
    }

    // ── 6. Reconciliation engine — pattern + amount matching ──
    {
      // First try special cases (named patterns + amount combos)
      const special = matchSpecialCases(descritivo, Math.abs(montante));
      if (special) {
        mov.categoria    = special.categoria;
        mov.subCategoria = special.subCategoria;
        mov.fracaoIdentificada = special.fracao || undefined;
        mov.categoriaSource = "auto";
        mov.notaCategorizacao = special.explanation;
        movimentos.push(mov);
        continue;
      }

      // Then try fração-from-name + full reconciliation
      const fracaoFromNameLocal = mov.fracaoIdentificada ?? undefined;
      if (fracaoFromNameLocal !== undefined) {
        const rec = fullReconcile(descritivo, Math.abs(montante), fracaoFromNameLocal ?? undefined);
        if (rec) {
          mov.categoria    = rec.categoria;
          mov.subCategoria = rec.subCategoria || fracaoFromNameLocal || "";
          mov.categoriaSource = "auto";
          mov.notaCategorizacao = rec.explanation;
          movimentos.push(mov);
          continue;
        }
      }

      // Pattern match fração from descritivo text
      const fracaoInDesc = descUp.match(/FRACC?A?O\s+(A[A-J]|[A-Z]{1,2})\b/);
      if (fracaoInDesc) {
        const fr = fracaoInDesc[1];
        mov.categoria = "Condomínio";
        mov.subCategoria = fr;
        mov.fracaoIdentificada = fr;
        mov.categoriaSource = "auto";
        mov.notaCategorizacao = `Fração mencionada no descritivo: ${fr}`;
        movimentos.push(mov);
        continue;
      }
    }

    // ── 7. Outgoing expense categories ──
    const inferredCat = inferExpenseCategory(descritivo);
    if (inferredCat !== "Diversos") {
      mov.categoria = inferredCat;
      mov.categoriaSource = "auto";
      movimentos.push(mov);
      continue;
    }

    // ── 8. Remaining — flag as unmatched ──
    mov.categoriaSource = "unmatched";
    mov.notaCategorizacao = "Não categorizado automaticamente";
    movimentos.push(mov);
  }

  // ── Build statistics ────────────────────────────────────────────────────────
  const entradas = movimentos.filter(m => m.montante > 0);
  const saidas   = movimentos.filter(m => m.montante < 0);
  const porFracao: Record<string, { count: number; total: number }> = {};
  const porCategoria: Record<string, { count: number; total: number }> = {};
  const naoCat: BankMovement[] = [];
  const bancarias: BankMovement[] = [];

  for (const m of movimentos) {
    if (m.categoriaSource === "unmatched") naoCat.push(m);
    if (m.categoria === "Despesas bancárias") bancarias.push(m);

    // By fração
    if (m.subCategoria && m.subCategoria !== "") {
      const fr = m.subCategoria;
      if (!porFracao[fr]) porFracao[fr] = { count: 0, total: 0 };
      porFracao[fr].count++;
      porFracao[fr].total += Math.abs(m.montante);
    }

    // By category
    const cat = m.categoria || "Sem categoria";
    if (!porCategoria[cat]) porCategoria[cat] = { count: 0, total: 0 };
    porCategoria[cat].count++;
    porCategoria[cat].total += Math.abs(m.montante);
  }

  const saldoFinal = movimentos.length > 0 ? movimentos[0].saldo : 0;

  return {
    conta,
    ficheiro: path.basename(filePath),
    totalMovimentos: movimentos.length,
    movimentos,
    estatisticas: {
      entradas: entradas.length,
      saidas: saidas.length,
      totalEntradas: entradas.reduce((s, m) => s + m.montante, 0),
      totalSaidas:   Math.abs(saidas.reduce((s, m) => s + m.montante, 0)),
      saldoFinal,
      categorizados: movimentos.filter(m => m.categoriaSource !== "unmatched").length,
      naoCategorizado: naoCat.length,
      despesasBancarias: bancarias.length,
      porFracao,
      porCategoria,
      pagamentosNaoIdentificados: naoCat,
    },
  };
}

// ─── CSV search paths ──────────────────────────────────────────────────────────
// Ordem de prioridade: pasta persistente do projecto primeiro, /tmp como fallback
const CSV_SEARCH_PATHS = [
  // 1. packages/web/data/ — pasta persistente no repositório (destino preferido)
  path.join(process.cwd(), "data"),
  path.join(process.cwd(), "packages/web/data"),
  path.join(process.cwd(), "../data"),
  // 2. /tmp — fallback legado (volátil entre reinicios)
  "/tmp/bank_pdfs/2026/2026",
  "/tmp/bank_pdfs/2025_a/2025",
  "/tmp/bank_pdfs/2025/2025",
  "/tmp/bank_pdfs",
];

const CSV_NAMES = {
  condominio: ["movimento_condominio_2026.csv", "movimentos_condominio_2025.csv", "movimento_condominio.csv"],
  obras:      ["movimentos_obras_2026.csv",      "movimentos_obras_2025.csv",      "movimentos_obras.csv"],
};

function findCSV(tipo: "condominio" | "obras"): string | null {
  for (const dir of CSV_SEARCH_PATHS) {
    for (const name of CSV_NAMES[tipo]) {
      const p = path.join(dir, name);
      if (fs.existsSync(p)) return p;
    }
  }
  return null;
}

// ─── Cached results ────────────────────────────────────────────────────────────
let _cache: { condominio: ParseResult | null; obras: ParseResult | null; ts: number } = {
  condominio: null,
  obras: null,
  ts: 0,
};

const CACHE_TTL_MS = 60 * 1000; // 1 minute

export function getCSVResults(force = false): { condominio: ParseResult | null; obras: ParseResult | null } {
  const now = Date.now();
  if (!force && _cache.ts && (now - _cache.ts) < CACHE_TTL_MS) {
    return { condominio: _cache.condominio, obras: _cache.obras };
  }

  const condPath = findCSV("condominio");
  const obrasPath = findCSV("obras");

  _cache.condominio = condPath ? parseCSV(condPath, "condominio") : null;
  _cache.obras      = obrasPath ? parseCSV(obrasPath, "obras") : null;
  _cache.ts = now;

  return { condominio: _cache.condominio, obras: _cache.obras };
}

// ─── Per-fração payment summary ───────────────────────────────────────────────
export function getFracaoPaymentHistory(fracao: string): {
  fracao: string;
  nome: string;
  pagamentos: BankMovement[];
  total: number;
  ultimoPagamento: string | null;
} {
  const { condominio } = getCSVResults();
  if (!condominio) return { fracao, nome: FRACOES_INFO[fracao]?.nome ?? "?", pagamentos: [], total: 0, ultimoPagamento: null };

  const pagamentos = condominio.movimentos.filter(
    m => m.subCategoria === fracao || m.fracaoIdentificada === fracao
  );
  const total = pagamentos.reduce((s, m) => s + Math.abs(m.montante), 0);
  const ultimoPagamento = pagamentos[0]?.dataOperacao ?? null;

  return {
    fracao,
    nome: FRACOES_INFO[fracao]?.nome ?? "?",
    pagamentos,
    total,
    ultimoPagamento,
  };
}
