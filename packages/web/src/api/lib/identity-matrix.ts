/**
 * ╔══════════════════════════════════════════════════════════════════╗
 * ║           MATRIZ DE IDENTIDADE — Condomínio 7663                ║
 * ║  Fonte de verdade para todas as frações, proprietários e IBANs. ║
 * ║  Gerado a partir de: Valores_Condomínio.xlsx (Jun 2026)         ║
 * ╚══════════════════════════════════════════════════════════════════╝
 *
 * Exports principais:
 *   MATRIZ_PROPRIEDADES   — array completo com todas as frações
 *   getFracaoById()       — lookup rápido por idFracao
 *   getFracaoByIBAN()     — lookup por IBAN (incluindo aprendidos)
 *   learnIBAN()           — persiste novo IBAN aprendido (Auto-Learning)
 *   identifyByMultiMatch()— identifica fração via ≥2 critérios, dispara learnIBAN se novo
 */

import { db } from "../database";
import { fracoes } from "../database/schema";
import { eq, sql } from "drizzle-orm";

// ─── Tipos de Cascata ─────────────────────────────────────────────────────────

export interface CascataAplicacao {
  tipo: keyof DividasAtuais;
  valorAntes: number;
  valorAmortizado: number;
  valorDepois: number;
}

export interface CascataResult {
  idFracao: string;
  valorEntrada: number;
  quotaLiquida: number;       // absorvido pela quota mensal (condominio + fundo reserva)
  restoAmortizacao: number;   // montante que entrou na cascata
  aplicacoes: CascataAplicacao[];
  sobra: number;              // valor que ficou sem destino (crédito a favor)
}

// ─── Tipos ────────────────────────────────────────────────────────────────────

export type EntradaLabel = "ENTRADA 21" | "ENTRADA 37" | "ENTRADA 39" | "GARAGEM" | "LOJAS";

export interface ValoresFixos {
  condominio: number;     // quota mensal condomínio (€)
  fundoReserva: number;   // 10% da quota (€)
}

/** Dívidas actuais — valores dinâmicos; actualizados após cada amortização.
 *  NaN / undefined = não aplicável a esta fração.
 */
export interface DividasAtuais {
  obras: number;      // Quota Extra Obras — valor em dívida
  incendio: number;   // Quota Extra Incêndio — valor em dívida
  indaqua: number;    // Quota Extra Indaqua + elevadores — valor em dívida
  motor: number;      // Quota Extra Motor Garagem — valor em dívida
}

export interface FracaoIdentidade {
  /** Identificador curto da fração: J, L, AB, AC, ... */
  idFracao: string;
  /** Entrada do edifício */
  entrada: EntradaLabel;
  /** Descrição humana: "1A + GAR 36", "LUGAR GAR. 7", etc. */
  descricao: string;
  /** Permilagem ‰ do edifício */
  permilagem: number;
  /** Nome completo do proprietário conforme Excel */
  nomeProprietario: string;
  /** IBANs conhecidos (estáticos do Excel + aprendidos em runtime) */
  ibansConhecidos: string[];
  valoresFixos: ValoresFixos;
  dividasAtuais: DividasAtuais;
  /** Tipo: habitação, loja ou garagem */
  tipo: "habitacao" | "loja" | "garagem";
}

// ─── MATRIZ COMPLETA ──────────────────────────────────────────────────────────
// Fonte: Contas_2026.xlsx — Aba 8 "Orçamento Anual" (versão activa Jun 2026)
// Alinhada com import-excel-2026.ts › ORCAMENTO_FRACOES (fonte de verdade BD).
// Colunas: FR | ENT | Descrição Fração | ‰ | NOME | IBAN |
//          Condomínio | Fundo Reserva | [4x Quota Extra: total | em dívida]
// NOTA: quota_mensal BD = condominio + fundoReserva (valor total combinado).

export const MATRIZ_PROPRIEDADES: FracaoIdentidade[] = [
  // ── ENTRADA 21 ────────────────────────────────────────────────────────────
  {
    idFracao: "J",
    entrada: "ENTRADA 21",
    descricao: "1A + GAR 36",
    permilagem: 38.8,
    nomeProprietario: "Mª DA CONCEIÇÃO S. MOREIRA",
    ibansConhecidos: ["PT50000700000035112419023"],
    valoresFixos: { condominio: 42.07, fundoReserva: 4.21 },
    dividasAtuais: { obras: 0, incendio: 0, indaqua: 0, motor: 0 },
    tipo: "habitacao",
  },
  {
    idFracao: "L",
    entrada: "ENTRADA 21",
    descricao: "1B + GAR 37",
    permilagem: 41.76,
    nomeProprietario: "JOÃO MARCO COUTINHO S MOREIRA",
    ibansConhecidos: ["PT50026903300020179024227"],
    valoresFixos: { condominio: 45.28, fundoReserva: 4.53 },
    dividasAtuais: { obras: 2110.97, incendio: 0, indaqua: 250.56, motor: 29.53 },
    tipo: "habitacao",
  },
  {
    idFracao: "M",
    entrada: "ENTRADA 21",
    descricao: "1C + GAR 38",
    permilagem: 39.5,
    nomeProprietario: "JANNARA MARIA DOS SANTOS",
    ibansConhecidos: ["PT50003300004538693622405"],
    valoresFixos: { condominio: 42.83, fundoReserva: 4.28 },
    dividasAtuais: { obras: 108.85, incendio: 0, indaqua: 0, motor: 0 },
    tipo: "habitacao",
  },
  {
    idFracao: "N",
    entrada: "ENTRADA 21",
    descricao: "2A + GAR 35",
    permilagem: 38.82,
    nomeProprietario: "FILIPE DANIEL F. TEIXEIRA",
    ibansConhecidos: ["PT50003508260001938493063"],
    valoresFixos: { condominio: 42.09, fundoReserva: 4.21 },
    dividasAtuais: { obras: 178.63, incendio: 0, indaqua: 33.78, motor: 0 },
    tipo: "habitacao",
  },
  {
    idFracao: "O",
    entrada: "ENTRADA 21",
    descricao: "2B + GAR 34",
    permilagem: 41.76,
    nomeProprietario: "PEDRO MIGUEL R. SANTOS",
    ibansConhecidos: ["PT50001000003568183000147"],
    valoresFixos: { condominio: 45.28, fundoReserva: 4.53 },
    dividasAtuais: { obras: 0, incendio: 0, indaqua: 0, motor: 0 },
    tipo: "habitacao",
  },
  {
    idFracao: "P",
    entrada: "ENTRADA 21",
    descricao: "2C + GAR 32 E 33",
    permilagem: 43.3,
    nomeProprietario: "NUNO RICARDO DE SÁ RIBEIRO",
    ibansConhecidos: ["PT50003508260001217750083"],
    valoresFixos: { condominio: 46.95, fundoReserva: 4.70 },
    dividasAtuais: { obras: 0, incendio: 0, indaqua: 0, motor: 0 },
    tipo: "habitacao",
  },
  // ── ENTRADA 37 ────────────────────────────────────────────────────────────
  {
    idFracao: "Q",
    entrada: "ENTRADA 37",
    descricao: "R/C A + GAR 19",
    permilagem: 37.14,
    nomeProprietario: "JOÃO CARLOS SOUSA BARROS / JOANA SANTOS CAVADAS",
    ibansConhecidos: ["PT50003508260002176173036"],
    valoresFixos: { condominio: 40.27, fundoReserva: 4.03 },
    dividasAtuais: { obras: 0, incendio: 0, indaqua: 0, motor: 0 },
    tipo: "habitacao",
  },
  {
    idFracao: "R",
    entrada: "ENTRADA 37",
    descricao: "R/C B + GAR 4 E 5",
    permilagem: 56.75,
    nomeProprietario: "VANESSA CRISTINA ARAÚJO SILVA",
    ibansConhecidos: ["PT50000700000027906250223"],
    valoresFixos: { condominio: 61.54, fundoReserva: 6.15 },
    dividasAtuais: { obras: 0, incendio: 0, indaqua: 0, motor: 0 },
    tipo: "habitacao",
  },
  {
    idFracao: "S",
    entrada: "ENTRADA 37",
    descricao: "R/C C + GAR 21",
    permilagem: 32.34,
    nomeProprietario: "CÉLIA BEATRIZ SÁ",
    ibansConhecidos: ["PT50001800034307157002049"],
    valoresFixos: { condominio: 35.07, fundoReserva: 3.51 },
    dividasAtuais: { obras: 0, incendio: 0, indaqua: 0, motor: 0 },
    tipo: "habitacao",
  },
  {
    idFracao: "T",
    entrada: "ENTRADA 37",
    descricao: "1A + GAR 16",
    permilagem: 38.5,
    nomeProprietario: "SUSANA DANIELA OLIVEIRA E SILVA",
    ibansConhecidos: ["PT50001800035142286302013"],
    valoresFixos: { condominio: 41.75, fundoReserva: 4.17 },
    dividasAtuais: { obras: 0, incendio: 0, indaqua: 0, motor: 0 },
    tipo: "habitacao",
  },
  {
    idFracao: "U",
    entrada: "ENTRADA 37",
    descricao: "1B + GAR 17 E 18",
    permilagem: 57.21,
    nomeProprietario: "CATARINA REIS AZEVEDO DA SILVA",
    ibansConhecidos: ["PT50001800036098770802066"],
    valoresFixos: { condominio: 62.04, fundoReserva: 6.20 },
    dividasAtuais: { obras: 0, incendio: 0, indaqua: 0, motor: 0 },
    tipo: "habitacao",
  },
  {
    idFracao: "V",
    entrada: "ENTRADA 37",
    descricao: "1C + GAR 6",
    permilagem: 34.05,
    nomeProprietario: "SÉRGIO MIGUEL DA S. MONTEIRO",
    ibansConhecidos: ["PT50003300004541014298905"],
    valoresFixos: { condominio: 36.92, fundoReserva: 3.69 },
    dividasAtuais: { obras: 0, incendio: 0, indaqua: 0, motor: 0 },
    tipo: "habitacao",
  },
  {
    idFracao: "X",
    entrada: "ENTRADA 37",
    descricao: "2A + GAR 1",
    permilagem: 39.12,
    nomeProprietario: "ALEXANDRE RIBEIRO MAIA",
    ibansConhecidos: ["PT50017038900304003236435"],
    valoresFixos: { condominio: 42.42, fundoReserva: 4.24 },
    dividasAtuais: { obras: 278.30, incendio: 0, indaqua: 0, motor: 27.67 },
    tipo: "habitacao",
  },
  {
    idFracao: "Z",
    entrada: "ENTRADA 37",
    descricao: "2B + GAR 2",
    permilagem: 55.15,
    nomeProprietario: "ANA ISABEL DIAS COSTA",
    ibansConhecidos: ["PT50004514414031555122136"],
    valoresFixos: { condominio: 59.80, fundoReserva: 5.98 },
    dividasAtuais: { obras: 0, incendio: 0, indaqua: 0, motor: 0 },
    tipo: "habitacao",
  },
  {
    idFracao: "AA",
    entrada: "ENTRADA 37",
    descricao: "2C + GAR 15",
    permilagem: 35.06,
    nomeProprietario: "OLIVIA CANDIDA FERREIRA LIMA",
    ibansConhecidos: ["PT50003507630000212480082"],
    valoresFixos: { condominio: 38.02, fundoReserva: 3.80 },
    dividasAtuais: { obras: 0, incendio: 0, indaqua: 0, motor: 0 },
    tipo: "habitacao",
  },
  // ── ENTRADA 39 ────────────────────────────────────────────────────────────
  {
    idFracao: "AB",
    entrada: "ENTRADA 39",
    descricao: "R/C A + GAR 8",
    permilagem: 35,
    nomeProprietario: "ILIDIO ANTONIO MORAIS MARINHO",
    ibansConhecidos: ["PT50001800036001413102053"],
    valoresFixos: { condominio: 37.95, fundoReserva: 3.80 },
    dividasAtuais: { obras: 0, incendio: 0, indaqua: 0, motor: 0 },
    tipo: "habitacao",
  },
  {
    idFracao: "AE",
    entrada: "ENTRADA 39",
    descricao: "1A + GAR 13",
    permilagem: 37,
    nomeProprietario: "GERMANO A M MACHADO",
    ibansConhecidos: ["PT50001800036323629302068"],
    valoresFixos: { condominio: 40.12, fundoReserva: 4.01 },
    dividasAtuais: { obras: 0, incendio: 0, indaqua: 0, motor: 0 },
    tipo: "habitacao",
  },
  {
    idFracao: "AF",
    entrada: "ENTRADA 39",
    descricao: "2B + GAR 12",
    permilagem: 35.21,
    nomeProprietario: "RUI ALEXANDRE SILVA TORRES",
    // Nota: Excel tem PT50003508260001938493063 (mesmo IBAN que fração N — possível erro Excel)
    // Mantido para não perder dado; será resolvido via auto-learning quando primeira tx real chegar
    ibansConhecidos: ["PT50003508260001938493063"],
    valoresFixos: { condominio: 38.18, fundoReserva: 3.82 },
    dividasAtuais: { obras: 0, incendio: 0, indaqua: 0, motor: 0 },
    tipo: "habitacao",
  },
  {
    idFracao: "AG",
    entrada: "ENTRADA 39",
    descricao: "1C + GAR 22",
    permilagem: 35.41,
    nomeProprietario: "JOÃO PEDRO AMORIM DIAS / MAGGY DA YESKI TORRES GUEVARA",
    ibansConhecidos: ["PT50000700000042681513323"],
    valoresFixos: { condominio: 38.40, fundoReserva: 3.84 },
    dividasAtuais: { obras: 284.27, incendio: 0, indaqua: 0, motor: 25.04 },
    tipo: "habitacao",
  },
  {
    idFracao: "AH",
    entrada: "ENTRADA 39",
    descricao: "2A + GAR 24 E 25",
    permilagem: 40.96,
    nomeProprietario: "Mª MADALENA COSTA F. RAMOS",
    ibansConhecidos: ["PT50017030430304001852534"],
    valoresFixos: { condominio: 44.41, fundoReserva: 4.44 },
    dividasAtuais: { obras: 0, incendio: 0, indaqua: 0, motor: 0 },
    tipo: "habitacao",
  },
  {
    idFracao: "AI",
    entrada: "ENTRADA 39",
    descricao: "2B + GAR 9",
    permilagem: 35.85,
    nomeProprietario: "RUI CARVALHO",
    // Nota: Excel tem mesmo IBAN que AH (PT50017030430304001852534) — provável erro Excel.
    // Sistema vai usar auto-learning para separar quando primeira tx real chegar.
    ibansConhecidos: ["PT50017030430304001852534"],
    valoresFixos: { condominio: 38.87, fundoReserva: 3.89 },
    dividasAtuais: { obras: 0, incendio: 0, indaqua: 0, motor: 0 },
    tipo: "habitacao",
  },
  {
    idFracao: "AJ",
    entrada: "ENTRADA 39",
    descricao: "2C + GAR 2",
    permilagem: 34.57,
    nomeProprietario: "MARIANA DA SILVA REIS",
    ibansConhecidos: ["PT50003502060001475003092"],
    valoresFixos: { condominio: 37.49, fundoReserva: 3.75 },
    dividasAtuais: { obras: 0, incendio: 0, indaqua: 0, motor: 0 },
    tipo: "habitacao",
  },
  // ── LOJAS ─────────────────────────────────────────────────────────────────
  {
    idFracao: "G",
    entrada: "LOJAS",
    descricao: "LOJA 1 + GAR 31",
    permilagem: 22.96,
    nomeProprietario: "MARMA CONCEPT, UNIPESSOAL LDA",
    ibansConhecidos: ["PT50003300004562915046205"],
    valoresFixos: { condominio: 13.98, fundoReserva: 1.40 },
    dividasAtuais: { obras: 1160.63, incendio: 60.72, indaqua: 23.87, motor: 16.24 },
    tipo: "loja",
  },
  {
    idFracao: "H",
    entrada: "LOJAS",
    descricao: "LOJA 2 + GAR 30",
    permilagem: 16.96,
    nomeProprietario: "FAMALIPET",
    ibansConhecidos: ["PT50003300004560757203605"],
    valoresFixos: { condominio: 10.33, fundoReserva: 1.03 },
    dividasAtuais: { obras: 0, incendio: 0, indaqua: 0, motor: 0 },
    tipo: "loja",
  },
  {
    idFracao: "I",
    entrada: "LOJAS",
    descricao: "LOJA 3 + GAR 29",
    permilagem: 22,
    nomeProprietario: "FAMALIPET",
    ibansConhecidos: ["PT50003300004560757203605"],
    valoresFixos: { condominio: 13.39, fundoReserva: 1.34 },
    dividasAtuais: { obras: 0, incendio: 0, indaqua: 0, motor: 0 },
    tipo: "loja",
  },
  {
    idFracao: "AC",
    entrada: "LOJAS",
    descricao: "LOJA 34 + GAR 10",
    permilagem: 18.1,
    nomeProprietario: "MARIA DE FÁTIMA MARTINS ASCENÇÃO / LIA RUTE ASCENSAO ALMEIDA",
    ibansConhecidos: ["PT50000700000035112419023"],
    valoresFixos: { condominio: 11.02, fundoReserva: 1.10 },
    dividasAtuais: { obras: 607.35, incendio: 0, indaqua: 0, motor: 0 },
    tipo: "loja",
  },
  {
    idFracao: "AD",
    entrada: "LOJAS",
    descricao: "LOJA 5 + GAR 14",
    permilagem: 18.68,
    nomeProprietario: "ESCUTOGLAMOUR UNIPESSOAL, LDA",
    ibansConhecidos: ["PT50001000006288458000152"],
    valoresFixos: { condominio: 11.37, fundoReserva: 1.14 },
    dividasAtuais: { obras: 629.51, incendio: 49.40, indaqua: 0, motor: 0 },
    tipo: "loja",
  },
  // ── GARAGEM (lugares avulso) ───────────────────────────────────────────────
  {
    idFracao: "A",
    entrada: "GARAGEM",
    descricao: "LUGAR GAR. 7",
    permilagem: 2.89,
    nomeProprietario: "UNIVERSE SUSTAINABLE-SA / ELSA RENATA ASCENSAO ALMEIDA / JULIANO PEREIRA DE CASTRO",
    ibansConhecidos: ["PT50003604909910339810645", "LT833250093155739292"],
    valoresFixos: { condominio: 1.76, fundoReserva: 0.18 },
    dividasAtuais: { obras: 0, incendio: 0, indaqua: 0, motor: 0 },
    tipo: "garagem",
  },
  {
    idFracao: "B",
    entrada: "GARAGEM",
    descricao: "LUGAR GAR. 11",
    permilagem: 2.86,
    nomeProprietario: "GERMANO A M MACHADO",
    ibansConhecidos: ["PT50001800036323629302068"], // mesmo que AE — deliberado (garagem associada)
    valoresFixos: { condominio: 1.74, fundoReserva: 0.17 },
    dividasAtuais: { obras: 0, incendio: 0, indaqua: 0, motor: 0 },
    tipo: "garagem",
  },
  {
    idFracao: "C",
    entrada: "GARAGEM",
    descricao: "LUGAR GAR. 20",
    permilagem: 2.89,
    nomeProprietario: "UNIVERSE SUSTAINABLE-SA / ELSA RENATA ASCENSAO ALMEIDA / JULIANO PEREIRA DE CASTRO",
    ibansConhecidos: ["PT50003604909910339810645", "LT833250093155739292"],
    valoresFixos: { condominio: 1.76, fundoReserva: 0.18 },
    dividasAtuais: { obras: 0, incendio: 0, indaqua: 0, motor: 0 },
    tipo: "garagem",
  },
  {
    idFracao: "D",
    entrada: "GARAGEM",
    descricao: "LUGAR GAR. 26",
    permilagem: 3.15,
    nomeProprietario: "SUSANA DANIELA OLIVEIRA E SILVA",
    ibansConhecidos: ["PT50001800035142286302013"], // mesmo que T — garagem associada
    valoresFixos: { condominio: 1.92, fundoReserva: 0.19 },
    dividasAtuais: { obras: 0, incendio: 0, indaqua: 0, motor: 0 },
    tipo: "garagem",
  },
  {
    idFracao: "E",
    entrada: "GARAGEM",
    descricao: "LUGAR GAR. 27",
    permilagem: 3,
    nomeProprietario: "TIAGO PINHEIRO CORREIA / JOANA PATRICIA OLIVEIRA AZEVEDO",
    ibansConhecidos: ["PT50003300004559330052305"],
    valoresFixos: { condominio: 1.83, fundoReserva: 0.18 },
    dividasAtuais: { obras: 0, incendio: 0, indaqua: 0, motor: 0 },
    tipo: "garagem",
  },
  {
    idFracao: "F",
    entrada: "GARAGEM",
    descricao: "LUGAR GAR. 28",
    permilagem: 3.25,
    nomeProprietario: "TIAGO PINHEIRO CORREIA / JOANA PATRICIA OLIVEIRA AZEVEDO",
    ibansConhecidos: ["PT50003300004559330052305"], // mesmo que E — casal, 2 garagens
    valoresFixos: { condominio: 1.98, fundoReserva: 0.20 },
    dividasAtuais: { obras: 0, incendio: 0, indaqua: 0, motor: 0 },
    tipo: "garagem",
  },
];

// ─── Índices de acesso rápido ─────────────────────────────────────────────────

const _byId = new Map<string, FracaoIdentidade>(
  MATRIZ_PROPRIEDADES.map((f) => [f.idFracao.toUpperCase(), f])
);

/** Mapa IBAN → array de frações que o partilham (garagem associada, etc.) */
const _byIban = new Map<string, FracaoIdentidade[]>();
for (const fracao of MATRIZ_PROPRIEDADES) {
  for (const iban of fracao.ibansConhecidos) {
    const norm = normalizeIBAN(iban);
    if (!_byIban.has(norm)) _byIban.set(norm, []);
    _byIban.get(norm)!.push(fracao);
  }
}

/** Remove espaços, uppercase */
function normalizeIBAN(iban: string): string {
  return iban.replace(/\s+/g, "").toUpperCase();
}

// ─── Lookups públicos ─────────────────────────────────────────────────────────

export function getFracaoById(id: string): FracaoIdentidade | undefined {
  return _byId.get(id.toUpperCase());
}

/**
 * Devolve frações associadas a um IBAN.
 * Procura primeiro nos IBANs estáticos da matriz; se não encontrar,
 * consulta a tabela `fracoes` para IBANs aprendidos em runtime.
 */
export async function getFracaoByIBAN(iban: string): Promise<FracaoIdentidade[]> {
  const norm = normalizeIBAN(iban);

  // 1. índice estático (instantâneo)
  const static_ = _byIban.get(norm);
  if (static_?.length) return static_;

  // 2. IBANs aprendidos em runtime (coluna ibans_conhecidos da BD)
  // SQLite: json_each precisa de estar no FROM, não no WHERE — usar db.run() manual.
  const rawRows = await db.run(
    sql`SELECT numero FROM fracoes WHERE EXISTS (
          SELECT 1 FROM json_each(ibans_conhecidos) WHERE value = ${norm}
        )`
  );

  const found: FracaoIdentidade[] = [];
  for (const row of (rawRows as any).rows ?? []) {
    const f = _byId.get((row.numero as string).toUpperCase());
    if (f) found.push(f);
  }
  return found;
}

// ─── Auto-Learning: persistência de novos IBANs ───────────────────────────────

/**
 * Resultado de uma identificação multi-critério.
 * `criterios` lista o que coincidiu (ex: "nome", "descricao", "iban", "valor").
 */
export interface IdentificacaoResult {
  fracao: FracaoIdentidade;
  confidence: number;   // 0–100
  criterios: string[];
  ibanNovoAprendido: boolean;
}

/**
 * Persiste um IBAN novo na tabela `fracoes.ibans_conhecidos` (JSON array)
 * E actualiza o índice em memória para que próximas queries o encontrem.
 *
 * @param idFracao   ID da fração (ex: "U")
 * @param ibanSender IBAN recebido na transação
 * @returns true se foi inserido novo, false se já existia
 */
export async function learnIBAN(
  idFracao: string,
  ibanSender: string
): Promise<boolean> {
  const norm = normalizeIBAN(ibanSender);
  const fracao = getFracaoById(idFracao);
  if (!fracao) return false;

  // Verificar se já existe no array em memória
  const jaExiste = fracao.ibansConhecidos.some(
    (i) => normalizeIBAN(i) === norm
  );
  if (jaExiste) return false;

  // Verificar se já existe na BD (pode ter sido aprendido noutro processo)
  const rows = await db.run(
    sql`SELECT ibans_conhecidos FROM fracoes WHERE numero = ${fracao.idFracao} LIMIT 1`
  );
  const row = (rows as any).rows?.[0];
  if (!row) {
    // Fração não existe em BD — provavelmente sistema fresh; registar apenas em memória
    fracao.ibansConhecidos.push(norm);
    _byIban.set(norm, [...(_byIban.get(norm) ?? []), fracao]);
    console.warn(`[identity-matrix] learnIBAN: fração ${idFracao} não existe em BD; IBAN guardado apenas em memória`);
    return true;
  }

  let current: string[] = [];
  try {
    current = JSON.parse(row.ibans_conhecidos as string ?? "[]");
  } catch {
    current = [];
  }

  if (current.map(normalizeIBAN).includes(norm)) return false; // já estava na BD

  current.push(norm);

  // UPSERT via UPDATE (a fração já existe)
  await db.run(
    sql`UPDATE fracoes SET ibans_conhecidos = ${JSON.stringify(current)} WHERE numero = ${fracao.idFracao}`
  );

  // Actualizar índice em memória
  fracao.ibansConhecidos.push(norm);
  const existing = _byIban.get(norm) ?? [];
  if (!existing.includes(fracao)) existing.push(fracao);
  _byIban.set(norm, existing);

  console.log(`[identity-matrix] Novo IBAN aprendido: ${norm} → fração ${idFracao} (${fracao.nomeProprietario})`);
  return true;
}

// ─── Identificação Multi-Critério ─────────────────────────────────────────────

interface MatchInput {
  /** Texto descritivo da transferência bancária */
  descricao: string;
  /** Montante (positivo) */
  amount: number;
  /** IBAN do remetente, se disponível */
  ibanSender?: string;
  /** Nome do devedor/remetente do banco, se disponível */
  debtorName?: string;
}

type MatchCriterio = "iban" | "nome" | "descricao_fracao" | "valor_fixo" | "valor_quota_extra";

/**
 * Normaliza string para comparação: uppercase, sem acentos, sem pontuação estranha.
 */
function normStr(s: string): string {
  return s
    .toUpperCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^A-Z0-9 ]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Verifica se o nome do remetente coincide com proprietário da fração.
 * Aceitamos match parcial de pelo menos 2 tokens do nome (previne falsos positivos em nomes curtos).
 */
function nomeCoincide(debtorName: string, nomeProprietario: string): boolean {
  const src = normStr(debtorName);
  const ref = normStr(nomeProprietario);

  // Match exacto
  if (src === ref) return true;

  // Match por tokens: o devedor tem pelo menos 2 tokens do nome do proprietário
  const refTokens = ref.split(" ").filter((t) => t.length > 2);
  const matchedTokens = refTokens.filter((t) => src.includes(t));

  // Exige ≥2 tokens ou ≥60% dos tokens (o que for maior)
  const minTokens = Math.max(2, Math.ceil(refTokens.length * 0.6));
  return matchedTokens.length >= minTokens;
}

/**
 * Verifica se a descrição menciona explicitamente a fração
 * (ex: "FRACAO AB", "FRACCAO AE", "AB HAB RC A", "ENTRADA 21 1A").
 */
function descricaoMencaonaFracao(descricao: string, idFracao: string): boolean {
  const d = normStr(descricao);
  const id = idFracao.toUpperCase();

  // "FRACAO X", "FRACCAO X", "FRACÃO X", "FRAÇÃO X"
  if (new RegExp(`(FRACAO|FRACCAO|FRAC[AÃ]O|FRA[CÇ][AÃ]O)\\s+${id}\\b`).test(d)) return true;
  // "AB HAB" ou "AB RC" (lojas/hab + id no início)
  if (new RegExp(`^${id}\\s+(HAB|RC|LOJA|GAR)`).test(d)) return true;
  // "ENTRADA NN XY" onde XY == idFracao (ex: ENTRADA 21 1A... mas 1A != J)
  // Usamos a descricao da fração para este match
  return false;
}

/**
 * Verifica se o montante coincide com a quota mensal (±0.02€ tolerância).
 */
function valorCoincideQuota(amount: number, fracao: FracaoIdentidade): boolean {
  return Math.abs(amount - fracao.valoresFixos.condominio) <= 0.02;
}

/**
 * Verifica se o montante coincide com algum valor de quota extra em dívida (±0.05€).
 */
function valorCoincideExtra(amount: number, fracao: FracaoIdentidade): boolean {
  const { obras, incendio, indaqua, motor } = fracao.dividasAtuais;
  for (const v of [obras, incendio, indaqua, motor]) {
    if (v > 0 && Math.abs(amount - v) <= 0.05) return true;
  }
  return false;
}

// ─── Helpers de desempate IBAN ────────────────────────────────────────────────

/**
 * Score de desempate: nome do remetente vs proprietário (+35).
 * Usa a mesma lógica de tokens que nomeCoincide(), mas devolve pontos em vez de bool.
 */
function scoreDesempateNome(debtorName: string | undefined, nomeProprietario: string): number {
  if (!debtorName) return 0;
  return nomeCoincide(debtorName, nomeProprietario) ? 35 : 0;
}

/**
 * Score de desempate: descrição contém "Entrada NN Fracção X" ou "ENTRADA NN FR X" (+30).
 * Exemplo: "ENTRADA 39 AF" ou "Entrada 39 Fracção AF".
 */
function scoreDesempateEntradaFracao(
  descricao: string | undefined,
  entrada: string,
  idFracao: string,
): number {
  if (!descricao) return 0;
  const d = normStr(descricao);
  const id = idFracao.toUpperCase();
  // Extrair número da entrada, ex: "ENTRADA 39" → "39"
  const entradaNum = entrada.replace(/\D/g, "");
  if (!entradaNum) return 0;
  // "ENTRADA 39 AF" ou "ENTRADA 39 FRACAO AF" ou "ENTRADA 39 FRACCAO AF"
  const re = new RegExp(`ENTRADA\\s+${entradaNum}\\s+(FRACAO\\s+|FRACCAO\\s+|FR\\s+)?${id}\\b`);
  return re.test(d) ? 30 : 0;
}

/**
 * Score de desempate: descrição contém "Entrada NN" + texto da descrição da fração (+25).
 * Exemplo: "ENTRADA 39 2B GAR 12" vs descricao="2B + GAR 12".
 */
function scoreDesempateEntradaDescricao(
  descricao: string | undefined,
  entrada: string,
  descFracao: string,
): number {
  if (!descricao) return 0;
  const d = normStr(descricao);
  const entradaNum = entrada.replace(/\D/g, "");
  const descNorm = normStr(descFracao);
  if (!entradaNum) return 0;
  // Verificar que a descrição menciona o número de entrada
  if (!d.includes(entradaNum)) return 0;
  // Verificar que pelo menos 2 tokens da descricao da fração aparecem na descrição
  const tokens = descNorm.split(" ").filter((t) => t.length > 1);
  const matched = tokens.filter((t) => d.includes(t));
  return matched.length >= 2 ? 25 : 0;
}

/**
 * Score de desempate: descrição contém texto da descrição da fração isolada (+20).
 * Exemplo: "LUGAR GAR. 11" ou "2B + GAR 12" na descrição da TXN.
 */
function scoreDesempateDescricaoIsolada(
  descricao: string | undefined,
  descFracao: string,
): number {
  if (!descricao) return 0;
  const d = normStr(descricao);
  const descNorm = normStr(descFracao);
  const tokens = descNorm.split(" ").filter((t) => t.length > 1);
  if (tokens.length === 0) return 0;
  const matched = tokens.filter((t) => d.includes(t));
  // Exige todos os tokens (ou ≥2 se muitos)
  const minMatch = tokens.length <= 2 ? tokens.length : Math.ceil(tokens.length * 0.7);
  return matched.length >= minMatch ? 20 : 0;
}

/**
 * Calcula score de desempate para uma fração colidida (quando IBAN → múltiplas frações).
 * Sub-critérios: nome(+35), entrada+fração(+30), entrada+desc(+25), desc isolada(+20).
 * Retorna { score, criterios }.
 */
function calcularScoreDesempate(
  input: MatchInput,
  fracao: FracaoIdentidade,
): { score: number; criterios: MatchCriterio[] } {
  let score = 0;
  const criterios: MatchCriterio[] = [];

  const sNome = scoreDesempateNome(input.debtorName, fracao.nomeProprietario);
  if (sNome > 0) { score += sNome; criterios.push("nome"); }

  const sEntFrac = scoreDesempateEntradaFracao(input.descricao, fracao.entrada, fracao.idFracao);
  if (sEntFrac > 0) { score += sEntFrac; criterios.push("descricao_fracao"); }

  const sEntDesc = scoreDesempateEntradaDescricao(input.descricao, fracao.entrada, fracao.descricao);
  if (sEntDesc > 0 && !criterios.includes("descricao_fracao")) {
    score += sEntDesc; criterios.push("descricao_fracao");
  } else if (sEntDesc > 0) {
    score += sEntDesc; // soma mesmo que criterio já contado (pontuação adicional)
  }

  const sDesc = scoreDesempateDescricaoIsolada(input.descricao, fracao.descricao);
  if (sDesc > 0 && criterios.length < 3) { score += sDesc; criterios.push("descricao_fracao"); }

  return { score, criterios };
}

/**
 * Identifica a fração a partir de ≥2 critérios de matching.
 * Se identificação for bem sucedida E o IBAN for novo → chama learnIBAN().
 *
 * Hierarquia de confiança:
 *   iban                → +50
 *   nome                → +30  (critério base, sem colisão)
 *   descricao_fracao    → +25  (critério base, sem colisão)
 *   valor_fixo          → +15
 *   valor_quota_extra   → +10
 *
 * Colisão IBAN (ibanCandidatos.length > 1):
 *   Desempate exclusivo com sub-critérios: nome(+35), entFrac(+30), entDesc(+25), descIsolada(+20)
 *   Threshold desempate: score ≥ 55 E ≥2 critérios
 *
 * Threshold geral para identificação: score ≥ 55 E ≥2 critérios
 */
export async function identifyByMultiMatch(
  input: MatchInput
): Promise<IdentificacaoResult | null> {
  const candidatos: Array<{ fracao: FracaoIdentidade; score: number; criterios: MatchCriterio[] }> = [];

  // Pre-match por IBAN (se disponível)
  let ibanCandidatos: FracaoIdentidade[] = [];
  if (input.ibanSender) {
    ibanCandidatos = await getFracaoByIBAN(input.ibanSender);
  }

  // ── Colisão IBAN: múltiplas frações com o mesmo IBAN ─────────────────────
  // Em vez de pegar a primeira (bug!), calcular score de desempate
  // apenas para as frações colididas.
  if (ibanCandidatos.length > 1) {
    const tieBreakers: Array<{ fracao: FracaoIdentidade; score: number; criterios: MatchCriterio[] }> = [];

    for (const candidato of ibanCandidatos) {
      const { score, criterios } = calcularScoreDesempate(input, candidato);
      tieBreakers.push({ fracao: candidato, score, criterios });
      console.log(
        `[identifyByMultiMatch] IBAN colisão desempate` +
        ` fração=${candidato.idFracao} score=${score} criterios=[${criterios.join(",")}]` +
        ` debtorName="${input.debtorName ?? ""}" descricao="${input.descricao ?? ""}"`,
      );
    }

    // Ordenar por score desc
    tieBreakers.sort((a, b) => b.score - a.score);
    const winner = tieBreakers[0];
    const runnerUp = tieBreakers[1];

    // Empate exacto → não arriscar
    if (winner.score === runnerUp.score) {
      console.warn(
        `[identifyByMultiMatch] IBAN colisão sem desempate claro` +
        ` (${winner.fracao.idFracao} e ${runnerUp.fracao.idFracao} empatam com score=${winner.score})`,
      );
      return null;
    }

    // Threshold: score ≥ 55 E ≥2 critérios (inclui o iban que é garantido nas colididas)
    const totalScore = 50 + winner.score; // +50 IBAN base + score desempate
    const allCriterios: MatchCriterio[] = ["iban", ...winner.criterios];

    if (totalScore < 55 || allCriterios.length < 2) {
      console.warn(
        `[identifyByMultiMatch] IBAN colisão — desempate insuficiente` +
        ` fração=${winner.fracao.idFracao} totalScore=${totalScore} criterios=[${allCriterios.join(",")}]`,
      );
      return null;
    }

    // Vencedor encontrado
    let ibanNovoAprendido = false;
    if (input.ibanSender) {
      ibanNovoAprendido = await learnIBAN(winner.fracao.idFracao, input.ibanSender);
    }

    return {
      fracao: winner.fracao,
      confidence: Math.min(100, totalScore),
      criterios: allCriterios,
      ibanNovoAprendido,
    };
  }

  // ── Sem colisão: fluxo normal ─────────────────────────────────────────────
  for (const fracao of MATRIZ_PROPRIEDADES) {
    let score = 0;
    const criterios: MatchCriterio[] = [];

    // Critério 1: IBAN
    if (input.ibanSender && ibanCandidatos.some((c) => c.idFracao === fracao.idFracao)) {
      score += 50;
      criterios.push("iban");
    }

    // Critério 2: Nome do devedor
    if (input.debtorName && nomeCoincide(input.debtorName, fracao.nomeProprietario)) {
      score += 30;
      criterios.push("nome");
    }

    // Critério 3: Menção explícita à fração na descrição
    if (descricaoMencaonaFracao(input.descricao, fracao.idFracao)) {
      score += 25;
      criterios.push("descricao_fracao");
    }

    // Critério 4: Valor coincide com quota mensal
    if (valorCoincideQuota(input.amount, fracao)) {
      score += 15;
      criterios.push("valor_fixo");
    }

    // Critério 5: Valor coincide com quota extra em dívida
    if (valorCoincideExtra(input.amount, fracao)) {
      score += 10;
      criterios.push("valor_quota_extra");
    }

    if (score >= 30 && criterios.length >= 1) {
      candidatos.push({ fracao, score, criterios });
    }
  }

  if (candidatos.length === 0) return null;

  // Ordenar por score desc — pegar o melhor
  candidatos.sort((a, b) => b.score - a.score);
  const best = candidatos[0];

  // Exigir score mínimo E pelo menos 2 critérios distintos para evitar falsos positivos
  if (best.score < 55 || best.criterios.length < 2) return null;

  // ── Auto-Learning: novo IBAN? ──────────────────────────────────────────────
  let ibanNovoAprendido = false;
  if (input.ibanSender && best.criterios.length >= 2) {
    ibanNovoAprendido = await learnIBAN(best.fracao.idFracao, input.ibanSender);
  }

  return {
    fracao: best.fracao,
    confidence: Math.min(100, best.score),
    criterios: best.criterios,
    ibanNovoAprendido,
  };
}

// ─── Helpers exportados ───────────────────────────────────────────────────────

/** Devolve todas as frações com dívidas activas */
export function getFracoesComDividas(): FracaoIdentidade[] {
  return MATRIZ_PROPRIEDADES.filter((f) => {
    const { obras, incendio, indaqua, motor } = f.dividasAtuais;
    return obras > 0 || incendio > 0 || indaqua > 0 || motor > 0;
  });
}

/** Total de dívidas por tipo no condomínio */
export function totalDividasPorTipo(): Record<keyof DividasAtuais, number> {
  return MATRIZ_PROPRIEDADES.reduce(
    (acc, f) => ({
      obras: acc.obras + f.dividasAtuais.obras,
      incendio: acc.incendio + f.dividasAtuais.incendio,
      indaqua: acc.indaqua + f.dividasAtuais.indaqua,
      motor: acc.motor + f.dividasAtuais.motor,
    }),
    { obras: 0, incendio: 0, indaqua: 0, motor: 0 }
  );
}

/** Actualiza dividasAtuais de uma fração em memória após amortização.
 *  @deprecated Usar processarCascataAmortizacao() para persistência durable.
 */
export function amortizarDivida(
  idFracao: string,
  tipo: keyof DividasAtuais,
  valorPago: number
): void {
  const fracao = getFracaoById(idFracao);
  if (!fracao) return;
  fracao.dividasAtuais[tipo] = Math.max(0, fracao.dividasAtuais[tipo] - valorPago);
}

// ─── Cascata de Amortização Dinâmica ─────────────────────────────────────────

/**
 * Processa a cascata de amortização para uma fração após recepção de pagamento.
 *
 * Ordem de prioridade (estrita): obras → indaqua → incendio → motor
 *
 * Fluxo:
 *   1. Subtrai quota mensal líquida (condominio + fundoReserva) do montante recebido.
 *   2. O restante percorre as dívidas extra por prioridade até esgotar.
 *   3. Persiste os novos saldos em BD (UPDATE fracoes SET obras_divida=... etc).
 *   4. Actualiza o objecto em memória para que lookups subsequentes sejam correctos.
 *
 * @param idFracao   ID da fração (ex: "L")
 * @param amount     Montante total recebido (€)
 * @param fracaoDB   Linha da BD (para obter fracaoId)
 * @param mes        Mês do pagamento (1-12)
 * @param ano        Ano do pagamento
 * @returns CascataResult com breakdown completo, ou null se fração não encontrada
 */
export async function processarCascataAmortizacao(
  idFracao: string,
  amount: number,
  fracaoDBId: string,
  mes: number,
  ano: number,
): Promise<CascataResult | null> {
  const fracao = getFracaoById(idFracao);
  if (!fracao) return null;

  // ── 1. Absorver quota mensal ──────────────────────────────────────────────
  const quotaLiquida = fracao.valoresFixos.condominio + fracao.valoresFixos.fundoReserva;
  let resto = Math.max(0, parseFloat((amount - quotaLiquida).toFixed(2)));

  const result: CascataResult = {
    idFracao,
    valorEntrada: amount,
    quotaLiquida,
    restoAmortizacao: resto,
    aplicacoes: [],
    sobra: 0,
  };

  if (resto <= 0) {
    result.sobra = 0;
    return result;
  }

  // ── 2. Ler dívidas actuais da BD (fonte de verdade durable) ──────────────
  const rows = await db.run(
    sql`SELECT obras_divida, incendio_divida, indaqua_divida, motor_divida
        FROM fracoes WHERE id = ${fracaoDBId} LIMIT 1`
  );
  const row = (rows as any).rows?.[0];

  // Usar BD se disponível; caso contrário cair para memória (sistema fresh/seed)
  const dividasBD: DividasAtuais = row
    ? {
        obras:    parseFloat((row.obras_divida as string | number) ?? 0) || 0,
        incendio: parseFloat((row.incendio_divida as string | number) ?? 0) || 0,
        indaqua:  parseFloat((row.indaqua_divida as string | number) ?? 0) || 0,
        motor:    parseFloat((row.motor_divida as string | number) ?? 0) || 0,
      }
    : { ...fracao.dividasAtuais };

  // ── 3. Aplicar cascata: obras → indaqua → incendio → motor ───────────────
  const ordem: Array<keyof DividasAtuais> = ["obras", "indaqua", "incendio", "motor"];

  const novasDividas = { ...dividasBD };

  for (const tipo of ordem) {
    if (resto <= 0) break;
    const divida = novasDividas[tipo];
    if (divida <= 0) continue;

    const amortizado = parseFloat(Math.min(resto, divida).toFixed(2));
    const antes = divida;
    novasDividas[tipo] = parseFloat(Math.max(0, divida - amortizado).toFixed(2));
    resto = parseFloat(Math.max(0, resto - amortizado).toFixed(2));

    result.aplicacoes.push({
      tipo,
      valorAntes: antes,
      valorAmortizado: amortizado,
      valorDepois: novasDividas[tipo],
    });
  }

  result.sobra = resto;

  // ── 4. Persistir em BD ────────────────────────────────────────────────────
  await db.run(
    sql`UPDATE fracoes
        SET obras_divida    = ${novasDividas.obras},
            incendio_divida = ${novasDividas.incendio},
            indaqua_divida  = ${novasDividas.indaqua},
            motor_divida    = ${novasDividas.motor}
        WHERE id = ${fracaoDBId}`
  );

  // ── 5. Actualizar memória ─────────────────────────────────────────────────
  fracao.dividasAtuais.obras    = novasDividas.obras;
  fracao.dividasAtuais.incendio = novasDividas.incendio;
  fracao.dividasAtuais.indaqua  = novasDividas.indaqua;
  fracao.dividasAtuais.motor    = novasDividas.motor;

  console.log(
    `[cascata] ${idFracao} — entrada €${amount.toFixed(2)}, quota €${quotaLiquida.toFixed(2)}, ` +
    `amortizações: [${result.aplicacoes.map(a => `${a.tipo} -€${a.valorAmortizado}`).join(", ")}], ` +
    `sobra €${result.sobra.toFixed(2)}`
  );

  return result;
}
