import { Hono } from "hono";
import { db } from "../database";
import * as schema from "../database/schema";
import { eq, and, sql, gt, gte, inArray } from "drizzle-orm";
import {
  REGRAS_CATIVO,
  identificarDestinoCativo,
  type GavetaCativo,
} from "./cativo-rules";
import {
  ORCAMENTO_MOTOR,
  ORCAMENTO_INCENDIO,
  ORCAMENTO_ELEVADORES,
  ORCAMENTO_OBRAS,
  ANCORA_SALDO_CC,
  ANCORA_SALDO_FR,
  ANCORA_SALDO_ELEVADORES,
  ANCORA_SALDO_OBRAS,
  ANCORA_DATA_CC,
  ANCORA_DATA_MOVIMENTOS,
  TOTAL_FRACOES,
  MATRIZ_PROPRIEDADES,
} from "../lib/identity-matrix";
import {
  CARTAS_JULHO_2026,
  getCartaFracao,
  totalGeralCartas,
  morososPorRubrica,
} from "../lib/cartas-julho-2026";

// ─────────────────────────────────────────────────────────
// DADOS REAIS DO EXCEL — devedores por conta
// Fonte: Contas_2026.xlsx (verdade até importação completa)
// ─────────────────────────────────────────────────────────

// ─── PAGAMENTOS BANCÁRIOS NÃO CATEGORIZADOS NO EXCEL ────
// Estes pagamentos existem no extracto bancário (Sheet 10 / CSV)
// mas o condomínio NÃO os categorizou, gerando discrepância.
//
// FRAÇÃO L — João Marco Coutinho (Jan 2026):
//   28/01/2026: 563.76€ — "quotas mensais atrasadas"
//   30/01/2026:  25.47€ — "fundo de reserva atrasado"
//   Total pago: 589.23€
//
// CÁLCULO CORRECTO (base: Sheet 3):
//   Dívida quota a 31.12.2025:  167.01€ (pre-2026 arrears)
//   Janeiro 2026 quota:          42.71€
//   Subtotal quota:             209.72€  → 563.76 cobre tudo + crédito 354.04€
//   Crédito quota (354.04/42.71): 8.29 meses → quota paga até ~Out 2026
//
//   Dívida fundo a 31.12.2025:   23.99€ (pre-2026 fundo arrears, Sheet 3/FUNDO_RESERVA)
//   Janeiro 2026 fundo:           4.27€  → parcialmente coberto (25.47 - 23.99 = 1.48€ crédito)
//   Fundo pago até: ~Jan 2026 (restam ~2.79€ de Jan fundo)
//
// POSIÇÃO DO CONDOMÍNIO (alegada, incorrecta):
//   Alega que 563.76€ cobre apenas Jan–Out 2026 sem considerar dívida pre-2026 (167.01€)
//
// NOTA: Obras (2110.97€), Quota Extra (323.24€), Portão (29.53€) são contas SEPARADAS
//       e NÃO são abrangidas por estes pagamentos.
const PAGAMENTOS_NAO_CATEGORIZADOS = [
  {
    fracao: "L",
    proprietario: "João Marco Coutinho S. Moreira",
    pagamentos: [
      { data: "28/01/2026", montante: 563.76, descricao: "Quotas mensais atrasadas", referencia: "DA-284854486" },
      { data: "30/01/2026", montante: 25.47,  descricao: "Fundo de reserva atrasado", referencia: "DA-285074316" },
    ],
    totalPago: 589.23,
    cobreAte: {
      quota: "Outubro 2026 (~8.3 meses crédito a partir de Fev)",
      fundo: "Janeiro 2026 (parcial — restam ~2.79€)",
    },
    disputaCondominio: "Condomínio alega que 563.76€ cobre Jan-Out 2026 ignorando dívida pre-2026 de 167.01€",
    contasNaoCovertas: ["Obras (2110.97€)", "Quota Extra Elevadores (323.24€)", "Portão (29.53€)"],
  },
];

// Sheet 4 — Obras em divida (coluna "VALOR EM DÍVIDA" > 0)
const PORTAO_TIPO_ID   = "06d6dd01-04ac-4ea3-8359-ec705f78de7c";
const ELEV_TIPO_ID     = "4696eef9-bd1f-46ff-a368-47cfd455eeca";
const INCENDIO_TIPO_ID = "dd16bd50-a2ab-4387-9d70-95822b1a61d7";

// ─── ORÇAMENTOS TOTAIS APROVADOS EM ASSEMBLEIA ───────────────────────────────
// Importados de identity-matrix.ts (single source of truth).
// ORCAMENTO_MOTOR, ORCAMENTO_INCENDIO, ORCAMENTO_ELEVADORES, ORCAMENTO_OBRAS

// ─── IBANs DAS POUPANÇAS FÍSICAS (Depósitos a Prazo Santander) ──────────────
// Saídas DBIT da Conta à Ordem para estes IBANs = transferências internas.
// NÃO devem ser registadas como despesas nem reduzir o saldo operacional.
// Fonte: Extratos Santander — contas dos depósitos a prazo do condomínio.
const IBANS_POUPANCA_FISICA = new Set<string>([
  // Depósito a Prazo — Fundo de Reserva
  // Depósito a Prazo — Elevadores / Quota Extra
  // Depósito a Prazo — Obras
  // (adicionar IBANs reais quando disponíveis; usar formato sem espaços)
  // Exemplo: "PT50003300004520936620005"
]);

// ─── ÂNCORAS — importadas de identity-matrix.ts (single source of truth) ────
// ANCORA_DATA_MOVIMENTOS  → 02/06/2026 (início triagem bancária)
// ANCORA_DATA_CC          → 15/06/2026 (saldo CC canónico: 1806.74€)
// NUNCA usar saldo_base_valor/saldo_base_data da DB — valores Enable Banking errados.
const ANCORA_MOVIMENTOS = ANCORA_DATA_MOVIMENTOS;  // alias local para legibilidade
const ANCORA_TS = Math.floor(ANCORA_DATA_MOVIMENTOS.getTime() / 1000);
const ANCORA_CC = ANCORA_DATA_CC;                  // alias local para legibilidade
const ANCORA_CC_TS = Math.floor(ANCORA_DATA_CC.getTime() / 1000);

// ─── MOVIMENTO TESTE (a ignorar sempre) ─────────────────────────────────────
// Transferência de teste de 15,00€ — eliminar do processamento.
const VALOR_TESTE_EUR = 15.00;

// Fonte da verdade: Valores_Condomínio.xlsx col L ("Valores em dívida Quota Extra Obras")
// Actualizado: 2026-06-15 — total real = 5358.51€
const OBRAS_DEVEDORES_EXCEL = [
  { fracao: { id: "L",  numero: "L",  proprietarioNome: "João Marco Coutinho S. Moreira",              andar: 1 }, total: 2110.97, quotas: [] },
  { fracao: { id: "G",  numero: "G",  proprietarioNome: "Marma Concept, Unipessoal Lda",               andar: 0 }, total: 1160.63, quotas: [] },
  { fracao: { id: "AD", numero: "AD", proprietarioNome: "Escutoglamour Unipessoal, Lda",               andar: 0 }, total:  629.51, quotas: [] },
  { fracao: { id: "AC", numero: "AC", proprietarioNome: "Maria de Fátima Martins Ascenção",            andar: 0 }, total:  607.35, quotas: [] },
  { fracao: { id: "AG", numero: "AG", proprietarioNome: "João Pedro Amorim Dias / Maggy Torres Guevara", andar: 2 }, total: 284.27, quotas: [] },
  { fracao: { id: "X",  numero: "X",  proprietarioNome: "Alexandre Ribeiro Maia",                     andar: 1 }, total:  278.30, quotas: [] },
  { fracao: { id: "N",  numero: "N",  proprietarioNome: "Filipe Daniel F. Teixeira",                   andar: 1 }, total:  178.63, quotas: [] },
  { fracao: { id: "M",  numero: "M",  proprietarioNome: "Jannara Maria dos Santos",                    andar: 1 }, total:  108.85, quotas: [] },
].sort((a, b) => b.total - a.total);

// Fonte da verdade: Valores_Condomínio.xlsx col O ("Valores em dívida Quota Extra Incêndio")
// Actualizado: 2026-06-15 — total real = 110.12€
const INCENDIO_DEVEDORES_EXCEL = [
  { fracao: { id: "G3", numero: "G",  proprietarioNome: "Marma Concept, Unipessoal Lda",    andar: 0 }, total: 60.72, quotas: [] },
  { fracao: { id: "AD2",numero: "AD", proprietarioNome: "Escutoglamour Unipessoal, Lda",    andar: 0 }, total: 49.40, quotas: [] },
].sort((a, b) => b.total - a.total);

// Fonte da verdade: Valores_Condomínio.xlsx col R ("Valores em dívida Quota extra Indaqua + elevadores")
// Actualizado: 2026-06-15 — total real = 308.21€
// NOTA: esta coluna substitui QUOTA_EXTRA_DEVEDORES_EXCEL para a gaveta Indaqua+Elevadores
const INDAQUA_DEVEDORES_EXCEL = [
  { fracao: { id: "L_iq",  numero: "L",  proprietarioNome: "João Marco Coutinho S. Moreira",              andar: 1 }, total: 250.56, quotas: [] },
  { fracao: { id: "N_iq",  numero: "N",  proprietarioNome: "Filipe Daniel F. Teixeira",                   andar: 1 }, total:  33.78, quotas: [] },
  { fracao: { id: "G_iq",  numero: "G",  proprietarioNome: "Marma Concept, Unipessoal Lda",               andar: 0 }, total:  23.87, quotas: [] },
].sort((a, b) => b.total - a.total);

// Fonte da verdade: Valores_Condomínio.xlsx col U ("Valores em dívida Quota extra motor")
// Actualizado: 2026-06-15 — total real = 98.48€
const MOTOR_DEVEDORES_EXCEL = [
  { fracao: { id: "L_m",  numero: "L",  proprietarioNome: "João Marco Coutinho S. Moreira",              andar: 1 }, total: 29.53, quotas: [] },
  { fracao: { id: "X_m",  numero: "X",  proprietarioNome: "Alexandre Ribeiro Maia",                     andar: 1 }, total: 27.67, quotas: [] },
  { fracao: { id: "AG_m", numero: "AG", proprietarioNome: "João Pedro Amorim Dias / Maggy Torres Guevara", andar: 2 }, total: 25.04, quotas: [] },
  { fracao: { id: "G_m",  numero: "G",  proprietarioNome: "Marma Concept, Unipessoal Lda",               andar: 0 }, total: 16.24, quotas: [] },
].sort((a, b) => b.total - a.total);

// Sheet 7 — Portão da Garagem — valores por fração (Orçamento OR M/123, 707,25€ com IVA)
// Fonte: Orçamento_Portao_e_Cota_extra_por_fraçao.pdf
// Sheet 5 — Portão da Garagem: valor exacto em dívida por fração
// Cálculo: total_qe_fração = elevadores + portão; portão_pago = max(0, pago - elevadores); portão_divida = portão - portão_pago
// Fonte: Sheet5 Quota Extra (inclui elevadores + portão) + Orçamento portão PDF
// Total portão: 707.25€ | Pago: 59.66€ base + pagamentos posteriores
// Pagamentos confirmados após 31.12.2025:
//   H(11.99) + I(15.56) + AC(12.80) + AD(13.21) + A(2.04) + B(2.02) + C(2.04) = 59.66€
//   AI (Rui Carvalho) pagou 25.35€ em 07/05/2026 — portão AI liquidado
//   AH (Mª Madalena) pagou 28.97€ em 07/05/2026 via transferência de Rui Carvalho (ref: "AH cota extra motor garagem") — portão AH liquidado
//   Total pago: 59.66 + 25.35 + 28.97 = 113.98€ | Em dívida: 707.25 - 113.98 = 593.27€
const PORTAO_DEVEDORES_EXCEL = [
  { fracao: { id: "U_p",  numero: "U",  proprietarioNome: "Catarina Reis Azevedo da Silva",     andar: 2 }, total: 40.46, quotas: [] },
  { fracao: { id: "R_p",  numero: "R",  proprietarioNome: "Vanessa Cristina Araújo Silva",      andar: 2 }, total: 40.14, quotas: [] },
  { fracao: { id: "Z_p",  numero: "Z",  proprietarioNome: "Ana Isabel Dias Costa",              andar: 3 }, total: 39.00, quotas: [] },
  { fracao: { id: "P_p",  numero: "P",  proprietarioNome: "Nuno Ricardo de Sá Ribeiro",         andar: 1 }, total: 30.62, quotas: [] },
  { fracao: { id: "L_p",  numero: "L",  proprietarioNome: "João Marco Coutinho S. Moreira",     andar: 1 }, total: 29.53, quotas: [] },
  { fracao: { id: "O_p",  numero: "O",  proprietarioNome: "Pedro Miguel R. Santos",             andar: 1 }, total: 29.53, quotas: [] },
  // AH (Mª Madalena Costa F. Ramos) — portão PAGO em 07/05/2026 (28.97€ via transf. Rui Carvalho, ref: "AH cota extra motor garagem")
  { fracao: { id: "M_p",  numero: "M",  proprietarioNome: "Jannara Maria dos Santos",           andar: 1 }, total: 27.94, quotas: [] },
  { fracao: { id: "X_p",  numero: "X",  proprietarioNome: "Alexandre Ribeiro Maia",             andar: 1 }, total: 27.67, quotas: [] },
  { fracao: { id: "N_p",  numero: "N",  proprietarioNome: "Filipe Daniel F. Teixeira",          andar: 1 }, total: 27.46, quotas: [] },
  { fracao: { id: "J_p",  numero: "J",  proprietarioNome: "Mª da Conceição S. Moreira",        andar: 0 }, total: 27.44, quotas: [] },
  { fracao: { id: "T_p",  numero: "T",  proprietarioNome: "Susana Daniela Oliveira e Silva",   andar: 2 }, total: 27.23, quotas: [] },
  { fracao: { id: "Q_p",  numero: "Q",  proprietarioNome: "João Carlos Sousa Barros",           andar: 1 }, total: 26.27, quotas: [] },
  { fracao: { id: "AE_p", numero: "AE", proprietarioNome: "Germano A. M. Machado",              andar: 2 }, total: 26.17, quotas: [] },
  // AI (Rui Carvalho) pagou 25.35€ em 07/05/2026 — portão AI liquidado
  { fracao: { id: "AG_p", numero: "AG", proprietarioNome: "João Pedro Amorim Dias",             andar: 2 }, total: 25.04, quotas: [] },
  { fracao: { id: "AF_p", numero: "AF", proprietarioNome: "Rui Alexandre Silva Torres",         andar: 2 }, total: 24.90, quotas: [] },
  { fracao: { id: "AA_p", numero: "AA", proprietarioNome: "Olivia Cândida Ferreira Lima",       andar: 3 }, total: 24.80, quotas: [] },
  { fracao: { id: "AB_p", numero: "AB", proprietarioNome: "Ilídio António Morais Marinho",      andar: 3 }, total: 24.75, quotas: [] },
  { fracao: { id: "AJ_p", numero: "AJ", proprietarioNome: "Mariana da Silva Reis",              andar: 3 }, total: 24.45, quotas: [] },
  { fracao: { id: "V_p",  numero: "V",  proprietarioNome: "Sérgio Miguel da S. Monteiro",       andar: 2 }, total: 24.08, quotas: [] },
  { fracao: { id: "S_p",  numero: "S",  proprietarioNome: "Célia Beatriz Sá",                  andar: 1 }, total: 22.87, quotas: [] },
  { fracao: { id: "G_p",  numero: "G",  proprietarioNome: "Marma Concept, Unipessoal Lda",      andar: 0 }, total: 16.24, quotas: [] },
].sort((a, b) => b.total - a.total);

// Fundo de Reserva — devedores (mesmos da conta corrente morosos)
// NOTA L: 25.47€ pago em 30/01/2026 cobre 23.99€ pre-2026 + 1.48€ crédito Jan
//         Fundo Jan 2026 = 4.27€ → ainda owe 2.79€ de Janeiro
//         O Excel não registou este pagamento → mostramos valor corrigido
const FUNDO_RESERVA_DEVEDORES_EXCEL = [
  { fracao: { id: "L3", numero: "L", proprietarioNome: "João Marco Coutinho S. Moreira",    andar: 1 }, total: 2.79, quotas: [], nota: "Pagou 25.47€ em 30/01 (não registado). Cobre pre-2026 (23.99€) + parcial Jan. Resta 2.79€ de Jan." },
  { fracao: { id: "G4", numero: "G", proprietarioNome: "Marma Concept, Unipessoal Lda",     andar: 0 }, total: 2.64,  quotas: [] },
  { fracao: { id: "N2", numero: "N", proprietarioNome: "Filipe Daniel F. Teixeira",          andar: 1 }, total: 4.37,  quotas: [] },
].sort((a, b) => b.total - a.total);

// Saldos reais a 31.01.2026 (fonte: Contas_2026.xlsx)
// NOTA: contaCorrente inclui ajuste L — 563.76€ pago em 28/01 (não categorizado no Excel)
//   Excel diz L deve 213.99€ (quota+fundo Jan) mas ele pagou 589.23€ → em crédito para quotas futuras
//   O totalEmAtraso real de quotas = Excel total - 213.99 (L já liquidou quota corrente)
//   atraso_fundo_reserva: 28.41 Excel → corrigido: 28.41 - 23.99 (L pré-2026 fundo) + 2.79 (L Jan fundo resto) = 7.21
// ─── SALDOS ANCORADOS A 15 DE JUNHO DE 2026 ─────────────────────────────────
// Fonte: Extratos físicos Santander confirmados em 15/06/2026.
// Estes valores são o ponto de partida (t=0) para o algoritmo de triagem.
// Movimentos processados a partir de 02/06/2026 (ANCORA_MOVIMENTOS).
const SALDO_DEFAULTS: Record<string, number> = {
  saldo_conta_corrente: ANCORA_SALDO_CC,         // Conta à Ordem — âncora 15/06/2026
  saldo_fundo_reserva:  ANCORA_SALDO_FR,         // Dep. a Prazo FR — âncora 15/06/2026
  atraso_fundo_reserva: 7.21,    // corrigido: L pagou 25.47 (23.99 pre-2026 fundo + parcial Jan)
  saldo_obras:          ANCORA_SALDO_OBRAS,      // Dep. a Prazo Obras — âncora 15/06/2026
  saldo_quota_extra:    ANCORA_SALDO_ELEVADORES, // Dep. a Prazo Elevadores — âncora 15/06/2026
  saldo_incendio: 0,
  a_receber_incendio: 157.98,
  a_receber_obras: 6006.05,
  a_receber_quota_extra: 1723.56,  // 1777.88 - 28.97(AH portão pago 07/05) - 25.35(AI portão pago 07/05)
  saldo_portao: 0,
  a_receber_portao: 593.27,  // 707.25 - 59.66(base) - 25.35(AI 07/05) - 28.97(AH 07/05) = 593.27
  portao_pago: 113.98,       // 59.66 + 25.35(AI 07/05) + 28.97(AH 07/05)
  // ── Valores cativos (dinheiro na Conta à Ordem ainda não transferido) ──────
  // Motor e Incêndio ficam retidos como cativos virtuais na Conta à Ordem.
  // FR e Obras são somados imediatamente às gavetas respectivas (não ficam cativos).
  // Recalculados dinamicamente a partir de bank_transactions desde ANCORA_MOVIMENTOS.
  cativo_fundo_reserva: 0,
  cativo_indaqua: 0,
  cativo_incendio: 0,
  cativo_portao: 0,
  cativo_obras: 0,
  // saldo_operacional_disponivel = saldo_conta_corrente − soma de todos os cativos
  saldo_operacional_disponivel: ANCORA_SALDO_CC,
  // ── Dívida global por cota extraordinária ────────────────────────────────────
  // DEFAULTS SEGUROS: totais das listas Excel (fracoes.* seeded), NÃO o orçamento completo.
  // recalcularSaldos() persiste valores correctos na tabela configuracoes;
  // estes defaults só são usados se recalcularSaldos() ainda não correu (first boot).
  // Fonte: OBRAS_DEVEDORES_EXCEL, MOTOR_DEVEDORES_EXCEL, INCENDIO_DEVEDORES_EXCEL, INDAQUA_DEVEDORES_EXCEL
  divida_total_motor:      98.48,    // SUM(fracoes.motor_divida)
  divida_total_incendio:   110.12,   // SUM(fracoes.incendio_divida)
  divida_total_elevadores: 308.21,   // SUM(fracoes.indaqua_divida)
  divida_total_obras:      4357.75,  // SUM(fracoes.obras_divida) — seeded do Excel Junho 2026
};

// ────────────────────────────────────────────────────────────────────────────
// Tipo de retorno de calcularValoresCativos
// ────────────────────────────────────────────────────────────────────────────

export interface ValoresCativos {
  /** Total cativo por gaveta — só movimentos CRDT não importados */
  porGaveta: Record<GavetaCativo, number>;
  /** Total agregado de todos os cativos */
  totalCativos: number;
  /** Número de movimentos classificados como cativos */
  numMovimentos: number;
  /** Detalhe por movimento (para debug/log) */
  movimentos: Array<{
    id: string;
    date: Date;
    amount: number;
    description: string | null;
    debtorName: string | null;
    gaveta: GavetaCativo;
    label: string;
    matchedField: string;
    matchedPattern: string;
  }>;
}

/**
 * calcularValoresCativos
 * ────────────────────────────────────────────────────────────────────────────
 * Lê os movimentos bancários recebidos (CRDT, imported=0) que ainda não foram
 * processados como quotas/despesas e classifica-os como "cativos" usando as
 * REGRAS_CATIVO definidas em cativo-rules.ts.
 *
 * Estes fundos estão fisicamente na Conta à Ordem mas são legalmente
 * destinados a gavetas específicas (FR, INDAQUA, Incêndio, Portão, Obras).
 *
 * Retorna totais por gaveta e detalhe para log/UI.
 */
export async function calcularValoresCativos(): Promise<ValoresCativos> {
  const resultado: ValoresCativos = {
    porGaveta: {
      fundo_reserva: 0,
      indaqua: 0,
      incendio: 0,
      portao: 0,
      obras: 0,
    },
    totalCativos: 0,
    numMovimentos: 0,
    movimentos: [],
  };

  try {
    // Buscar movimentos CRDT não importados (staging buffer)
    // amount > 0 AND imported = 0 AND (type = 'CRDT' OR amount > 0)
    const movimentos = await db
      .select({
        id: schema.bankTransactions.id,
        date: schema.bankTransactions.date,
        amount: schema.bankTransactions.amount,
        description: schema.bankTransactions.description,
        debtorName: schema.bankTransactions.debtorName,
        type: schema.bankTransactions.type,
      })
      .from(schema.bankTransactions)
      .where(and(
        eq(schema.bankTransactions.imported, 0),
        sql`${schema.bankTransactions.amount} > 0`,
      ));

    for (const mov of movimentos) {
      const r = identificarDestinoCativo(
        mov.description,
        mov.debtorName,
        // ibanSender não está mapeado na tabela actual — null por defeito
        null,
      );

      if (r.gaveta === null) continue; // não é cativo — quota corrente normal

      const valor = Math.abs(mov.amount);
      resultado.porGaveta[r.gaveta] += valor;
      resultado.totalCativos += valor;
      resultado.numMovimentos++;
      resultado.movimentos.push({
        id: mov.id,
        date: mov.date instanceof Date ? mov.date : new Date((mov.date as number) * 1000),
        amount: valor,
        description: mov.description,
        debtorName: mov.debtorName,
        gaveta: r.gaveta,
        label: r.label!,
        matchedField: r.matchedField!,
        matchedPattern: r.matchedPattern!,
      });
    }

    // Arredondar gavetas a 2 casas
    for (const k of Object.keys(resultado.porGaveta) as GavetaCativo[]) {
      resultado.porGaveta[k] = Math.round(resultado.porGaveta[k] * 100) / 100;
    }
    resultado.totalCativos = Math.round(resultado.totalCativos * 100) / 100;
  } catch (e) {
    // bank_transactions pode não existir em ambientes antigos — falha silenciosa
    console.warn("[calcularValoresCativos] Tabela bank_transactions inacessível:", e);
  }

  return resultado;
}

async function getSaldos(): Promise<Record<string, number>> {
  try {
    const rows = await db.select().from(schema.configuracoes);
    const result = { ...SALDO_DEFAULTS };
    for (const row of rows) {
      const v = parseFloat(row.valor);
      if (!isNaN(v)) result[row.chave] = v;
    }
    return result;
  } catch {
    return { ...SALDO_DEFAULTS };
  }
}

async function upsertSaldo(chave: string, valor: number): Promise<void> {
  await db
    .insert(schema.configuracoes)
    .values({ chave, valor: String(valor), updatedAt: new Date() })
    .onConflictDoUpdate({
      target: schema.configuracoes.chave,
      set: { valor: String(valor), updatedAt: new Date() },
    });
}

/**
 * Recalcula saldos dinâmicos a partir da DB e persiste em `configuracoes`.
 * Deve ser chamado após cada bank sync para que o dashboard reflicta os dados actuais.
 *
 * Regra de Ouro — gavetas estanques:
 *  - saldo_conta_corrente : saldoBase + SUM(q.valor WHERE tipo='condominio' AND pago=1 AND dataPagamento>=baseTs)
 *                           − SUM(d.valor WHERE data>=baseTs)
 *    ► NUNCA inclui fundoReserva (campo separado), obras, INDAQUA, Incêndio, Portão.
 *  - saldo_fundo_reserva  : 277.89 (estático — sem conta bancária separada na DB)
 *  - atraso_fundo_reserva : SUM(q.fundoReserva WHERE tipo='condominio' AND pago=0)
 *  - a_receber_obras      : SUM(q.valor WHERE tipo='obras' AND pago=0)
 *  - a_receber_indaqua    : SUM("Em dívida" extraído de observacoes LIKE '%INDAQUA%')
 *  - a_receber_incendio   : SUM(q.valor WHERE observacoes LIKE '%ncen%' AND pago=0)
 *  - a_receber_portao     : Excel − pagos DB (quotaTipoId=PORTAO; fallback lista Excel)
 *  - a_receber_quota_extra: Excel − pagos DB (quotaTipoId=ELEV; fallback lista Excel)
 */
/**
 * recalcularSaldos
 * ────────────────────────────────────────────────────────────────────────────
 * Recalcula todos os saldos dinâmicos e persiste em `configuracoes`.
 * Chamado após cada bank sync (bank.ts) e disponível via POST /api/dashboard/recalcular.
 *
 * REGRA DE OURO — gavetas estanques:
 *   saldo_conta_corrente      = saldoBase + receitas_condominio − despesas (desde âncora)
 *                               NÃO inclui fundoReserva, obras, INDAQUA, Incêndio, Portão.
 *   saldo_operacional_disponivel = saldo_conta_corrente − totalCativos
 *                               (dinheiro livre de qualquer compromisso de gaveta)
 *   cativo_<gaveta>           = SUM(bank_transactions.amount WHERE imported=0 AND gaveta=X)
 *                               Aumenta o saldo virtual da gaveta sem duplicar saldo_conta_corrente.
 *   atraso_fundo_reserva      = SUM(q.fundoReserva WHERE tipo='condominio' AND pago=0)
 *   a_receber_obras           = SUM(q.valor WHERE tipo='obras' AND pago=0)
 *   a_receber_indaqua         = "Em dívida" de observacoes LIKE '%INDAQUA%' (pago=0)
 *   a_receber_incendio        = SUM(q.valor WHERE observacoes LIKE '%ncen%' AND pago=0)
 *   a_receber_portao          = Excel fallback − pagos na DB
 *   a_receber_quota_extra     = Excel fallback − pagos na DB
 */
export async function recalcularSaldos(): Promise<void> {

  // ─────────────────────────────────────────────────────────────────────────────
  // 0. TRIAGEM DE MOVIMENTOS BANCÁRIOS DESDE 02/06/2026
  //    Lê bank_transactions com date >= ANCORA_MOVIMENTOS e classifica:
  //      • Receitas Obras (cativo_obras)      → soma IMEDIATA ao saldo_obras
  //      • Receitas FR (cativo_fundo_reserva) → soma IMEDIATA ao saldo_fundo_reserva
  //      • Receitas Motor / Incêndio          → cativo virtual na Conta à Ordem
  //      • Saídas para IBANs de poupanças     → ignorar (transferência interna)
  //      • Movimento 15,00€ (teste)           → ignorar
  // ─────────────────────────────────────────────────────────────────────────────
  // BLINDAGEM: acumuladores sempre zero-init aqui — função não é reentrante
  // (Bun é single-threaded; sem risco de concorrência, mas explícito por clareza).
  let acumObras      = 0; // receitas de obras somadas desde ANCORA_DATA_MOVIMENTOS
  let acumFR         = 0; // receitas FR somadas desde ANCORA_DATA_MOVIMENTOS
  let cativoMotor    = 0; // Motor/Portão retidos na Conta à Ordem (não transferidos)
  let cativoIncendio = 0; // Incêndio retido na Conta à Ordem (não transferido)

  try {
    const movimentos = await db
      .select({
        id:          schema.bankTransactions.id,
        date:        schema.bankTransactions.date,
        amount:      schema.bankTransactions.amount,
        description: schema.bankTransactions.description,
        debtorName:  schema.bankTransactions.debtorName,
        debtorIban:  schema.bankTransactions.debtorIban,

        type:        schema.bankTransactions.type,
        rawData:     schema.bankTransactions.rawData,
      })
      .from(schema.bankTransactions)
      .where(sql`${schema.bankTransactions.date} >= ${ANCORA_TS}`);

    for (const mov of movimentos) {
      const valor = mov.amount ?? 0;
      const desc  = (mov.description ?? "").trim();
      const isCredito = valor > 0;
      const isDebito  = valor < 0;
      const absValor  = Math.abs(valor);

      // ── Ignorar movimento de teste (15,00€ exacto) ──────────────────────
      if (Math.abs(absValor - VALOR_TESTE_EUR) < 0.005) {
        console.log(`[recalcularSaldos] Ignorado movimento teste 15€ — "${desc.slice(0, 60)}"`);
        continue;
      }

      // ── Saídas para contas de poupança físicas (transferências internas) ─
      if (isDebito && IBANS_POUPANCA_FISICA.size > 0) {
        // Tentar extrair IBAN destino do rawData ou de campo dedicado
        let ibanDestino: string | null = null;
        try {
          if (mov.rawData) {
            const raw = JSON.parse(mov.rawData);
            ibanDestino = raw.creditor?.account?.iban ?? raw.creditorIban ?? null;
          }
        } catch {}
        const ibanNorm = (ibanDestino ?? "").replace(/\s/g, "").toUpperCase();
        if (ibanNorm && IBANS_POUPANCA_FISICA.has(ibanNorm)) {
          console.log(`[recalcularSaldos] Ignorada saída para poupança ${ibanNorm} — ${absValor.toFixed(2)}€`);
          continue;
        }
      }

      if (!isCredito) continue; // débitos normais processados noutras secções

      // ── Classificar receita por gaveta ───────────────────────────────────
      const descUp = desc.toUpperCase();
      const isObras    = /\bOBRAS?\b/i.test(desc) || /COTA\s+(EXTRA\s+)?OBRAS/i.test(desc) || /QUOTA\s+(EXTRA\s+)?OBRAS/i.test(desc);
      const isFR       = /FUNDO\s+DE?\s+RESERVA/i.test(desc) || /\bF\.?R\.?\b/.test(desc) || /FUNDO\s+RESERVA/i.test(desc) || /QUOTA\s+RESERVA/i.test(desc);
      const isMotor    = /MOTOR\s+(DA\s+)?GARAGEM/i.test(desc) || /PORT[AÃ]O\s+(GARAGEM|MOTOR)/i.test(desc) || /COTA\s+(EXTRA\s+)?MOTOR/i.test(desc) || /QUOTA\s+(EXTRA\s+)?MOTOR/i.test(desc) || /COTA\s+(EXTRA\s+)?PORT[AÃ]O/i.test(desc) || /\bAH\s+COTA\s+EXTRA/i.test(desc) || /\bAI\s+COTA\s+EXTRA/i.test(desc);
      const isIncendio = /INC[EÊ]NDIO/i.test(desc) || /SEGURO\s+(INCENDIO|INC[EÊ]NDIO)/i.test(desc) || /COTA\s+INC[EÊ]NDIO/i.test(desc) || /QUOTA\s+INC[EÊ]NDIO/i.test(desc);

      if (isObras) {
        // Receita de Obras → soma IMEDIATA ao depósito a prazo Obras
        acumObras += absValor;
        console.log(`[triagem] Obras +${absValor.toFixed(2)}€ — "${desc.slice(0, 60)}"`);
      } else if (isFR) {
        // Receita de FR → soma IMEDIATA ao depósito a prazo FR
        acumFR += absValor;
        console.log(`[triagem] Fundo Reserva +${absValor.toFixed(2)}€ — "${desc.slice(0, 60)}"`);
      } else if (isMotor) {
        // Motor → cativo virtual na Conta à Ordem (isolado visualmente)
        cativoMotor += absValor;
        console.log(`[triagem] Motor (cativo) +${absValor.toFixed(2)}€ — "${desc.slice(0, 60)}"`);
      } else if (isIncendio) {
        // Incêndio → cativo virtual na Conta à Ordem (isolado visualmente)
        cativoIncendio += absValor;
        console.log(`[triagem] Incêndio (cativo) +${absValor.toFixed(2)}€ — "${desc.slice(0, 60)}"`);
      }
      // Receitas normais (quotas condomínio) são processadas na secção 1
    }

    // Arredondar acumuladores
    acumObras      = Math.round(acumObras * 100) / 100;
    acumFR         = Math.round(acumFR * 100) / 100;
    cativoMotor    = Math.round(cativoMotor * 100) / 100;
    cativoIncendio = Math.round(cativoIncendio * 100) / 100;

    if (acumObras > 0 || acumFR > 0 || cativoMotor > 0 || cativoIncendio > 0) {
      console.log(`[recalcularSaldos] Triagem desde ${ANCORA_MOVIMENTOS.toISOString().slice(0,10)}: Obras+${acumObras}€ FR+${acumFR}€ CativoMotor=${cativoMotor}€ CativoIncendio=${cativoIncendio}€`);
    }
  } catch (e) {
    console.error("[recalcularSaldos] triagem movimentos:", e);
  }

  // ─────────────────────────────────────────────────────────────────────────────
  // 1. CONTA CORRENTE
  //    ÂNCORA CANÓNICA: 1806.74€ em 15/06/2026 — IMUTÁVEL.
  //    Ignora saldo_base_valor/saldo_base_data da DB (valores históricos Enable Banking
  //    que produzem incorrectamente 3738.39€).
  //
  //    CC = 1806.74
  //       + SUM(quotas.valor WHERE tipo='condominio' AND pago=true AND dataPagamento >= 15/06/2026)
  //       + SUM(bank_transactions.amount WHERE amount>0 AND date >= 15/06/2026
  //             AND NÃO classificado como Obras/FR/Motor/Incêndio pela triagem)
  //       − SUM(despesas.valor WHERE data >= 15/06/2026)
  //
  //    Nota: fundoReserva NÃO entra aqui. Obras e FR já foram para gavetas próprias.
  //          Motor e Incêndio são cativos — permanecem na CC mas visualmente isolados.
  // ─────────────────────────────────────────────────────────────────────────────
  let saldoContaCorrente = SALDO_DEFAULTS.saldo_conta_corrente;

  try {
    // ── 1a. Receitas de condomínio desde âncora (quotas pagas na DB) ──────────
    const quotasDesdeAnc = await db
      .select({ valor: schema.quotas.valor })
      .from(schema.quotas)
      .where(and(
        eq(schema.quotas.tipo, "condominio"),
        eq(schema.quotas.pago, true),
        sql`${schema.quotas.dataPagamento} >= ${ANCORA_CC_TS}`,
      ));
    const receitasQuotasBD = quotasDesdeAnc.reduce((s, q) => s + q.valor, 0);

    // ── 1b. Créditos bancários genéricos desde âncora (bank_transactions) ─────
    //    Inclui tudo que é CRDT desde 15/06/2026, excepto:
    //      • já classificados como Obras/FR pela triagem (acumObras, acumFR)
    //      • cativos Motor/Incêndio (cativoMotor, cativoIncendio)
    //      • movimentos de teste (15€)
    //    Estes créditos representam quotas de condomínio pagas directamente por
    //    transferência bancária ainda não importadas para a tabela quotas.
    let creditosBancariosCC = 0;
    try {
      const movsBanco = await db
        .select({
          amount:      schema.bankTransactions.amount,
          description: schema.bankTransactions.description,
          rawData:     schema.bankTransactions.rawData,
        })
        .from(schema.bankTransactions)
        .where(and(
          sql`${schema.bankTransactions.date} >= ${ANCORA_CC_TS}`,
          sql`${schema.bankTransactions.amount} > 0`,
        ));

      for (const mov of movsBanco) {
        const valor   = mov.amount ?? 0;
        const desc    = (mov.description ?? "").trim();
        const absVal  = Math.abs(valor);

        // Ignorar teste
        if (Math.abs(absVal - VALOR_TESTE_EUR) < 0.005) continue;

        // Ignorar se já contabilizado nas gavetas da triagem
        const isObras    = /\bOBRAS?\b/i.test(desc) || /COTA\s+(EXTRA\s+)?OBRAS/i.test(desc) || /QUOTA\s+(EXTRA\s+)?OBRAS/i.test(desc);
        const isFR       = /FUNDO\s+DE?\s+RESERVA/i.test(desc) || /\bF\.?R\.?\b/.test(desc) || /FUNDO\s+RESERVA/i.test(desc) || /QUOTA\s+RESERVA/i.test(desc);
        const isMotor    = /MOTOR\s+(DA\s+)?GARAGEM/i.test(desc) || /PORT[AÃ]O\s+(GARAGEM|MOTOR)/i.test(desc) || /COTA\s+(EXTRA\s+)?MOTOR/i.test(desc) || /QUOTA\s+(EXTRA\s+)?MOTOR/i.test(desc) || /COTA\s+(EXTRA\s+)?PORT[AÃ]O/i.test(desc) || /\bAH\s+COTA\s+EXTRA/i.test(desc) || /\bAI\s+COTA\s+EXTRA/i.test(desc);
        const isIncendio = /INC[EÊ]NDIO/i.test(desc) || /SEGURO\s+(INCENDIO|INC[EÊ]NDIO)/i.test(desc) || /COTA\s+INC[EÊ]NDIO/i.test(desc) || /QUOTA\s+INC[EÊ]NDIO/i.test(desc);

        if (isObras || isFR || isMotor || isIncendio) continue;

        // Crédito genérico → conta corrente
        creditosBancariosCC += absVal;
        console.log(`[recalcularSaldos] CC bancário +${absVal.toFixed(2)}€ — "${desc.slice(0, 60)}"`);
      }
      creditosBancariosCC = Math.round(creditosBancariosCC * 100) / 100;
    } catch (eBanco) {
      console.warn("[recalcularSaldos] Leitura bank_transactions para CC falhou:", eBanco);
    }

    // ── 1c. Despesas categorizadas desde âncora ────────────────────────────────
    const despesasDesdeAnc = await db
      .select({ valor: schema.despesas.valor })
      .from(schema.despesas)
      .where(sql`${schema.despesas.data} >= ${ANCORA_CC_TS}`);
    const totalDespesasDesdeAnc = despesasDesdeAnc.reduce((s, d) => s + d.valor, 0);

    saldoContaCorrente = Math.round(
      (SALDO_DEFAULTS.saldo_conta_corrente! + receitasQuotasBD + creditosBancariosCC - totalDespesasDesdeAnc) * 100
    ) / 100;

    console.log(
      `[recalcularSaldos] CC: base=${SALDO_DEFAULTS.saldo_conta_corrente}€ ` +
      `+quotasBD=${receitasQuotasBD.toFixed(2)}€ +bancarioCC=${creditosBancariosCC.toFixed(2)}€ ` +
      `-despesas=${totalDespesasDesdeAnc.toFixed(2)}€ = ${saldoContaCorrente}€`
    );

    await upsertSaldo("saldo_conta_corrente", saldoContaCorrente);
  } catch (e) {
    console.error("[recalcularSaldos] saldo_conta_corrente:", e);
  }

  // ─────────────────────────────────────────────────────────────────────────────
  // 2. VALORES CATIVOS (bank_transactions não importadas + triagem Motor/Incêndio)
  //    Motor e Incêndio ficam retidos como cativos na Conta à Ordem.
  //    FR e Obras vão imediatamente para as gavetas físicas (acumFR, acumObras).
  // ─────────────────────────────────────────────────────────────────────────────
  let cativos = {
    fundo_reserva: 0,
    indaqua: 0,
    incendio: cativoIncendio,
    portao: cativoMotor,     // portão = motor garagem (mesma gaveta visual)
    obras: 0,
    total: 0,
  };

  try {
    // calcularValoresCativos() lê bank_transactions(imported=0) — complementa a triagem
    const resultado = await calcularValoresCativos();

    // Mesclar: cativo Motor/Incêndio da triagem + cativos do motor matricial
    cativos = {
      fundo_reserva: resultado.porGaveta.fundo_reserva,
      indaqua:       resultado.porGaveta.indaqua,
      // Incêndio: triagem (cativoIncendio) + motor matricial (resultado)
      incendio: Math.round((cativoIncendio + resultado.porGaveta.incendio) * 100) / 100,
      // Portão/Motor: triagem (cativoMotor) + motor matricial (resultado)
      portao:   Math.round((cativoMotor + resultado.porGaveta.portao) * 100) / 100,
      obras:    resultado.porGaveta.obras,
      total:    0,
    };
    cativos.total = Math.round(
      (cativos.fundo_reserva + cativos.indaqua + cativos.incendio + cativos.portao + cativos.obras) * 100
    ) / 100;

    // Persistir cativos por gaveta
    await upsertSaldo("cativo_fundo_reserva", cativos.fundo_reserva);
    await upsertSaldo("cativo_indaqua",       cativos.indaqua);
    await upsertSaldo("cativo_incendio",      cativos.incendio);
    await upsertSaldo("cativo_portao",        cativos.portao);
    await upsertSaldo("cativo_obras",         cativos.obras);

    if (resultado.numMovimentos > 0 || cativoMotor > 0 || cativoIncendio > 0) {
      console.log(`[recalcularSaldos] Cativos totais: ${cativos.total.toFixed(2)}€ (Motor:${cativos.portao}€ Incêndio:${cativos.incendio}€ FR:${cativos.fundo_reserva}€)`);
    }
  } catch (e) {
    console.error("[recalcularSaldos] cativos:", e);
  }

  // saldo_operacional_disponivel = saldo bruto − cativos comprometidos com gavetas
  const saldoOperacional = Math.round((saldoContaCorrente! - cativos.total) * 100) / 100;
  await upsertSaldo("saldo_operacional_disponivel", saldoOperacional);

  // ─────────────────────────────────────────────────────────────────────────────
  // 3. FUNDO DE RESERVA
  //    saldo_fundo_reserva = base (651.30) + acumFR (receitas desde âncora) + cativos FR
  //    Receitas FR desde 02/06: somadas imediatamente (já no prazo, não cativos)
  // ─────────────────────────────────────────────────────────────────────────────
  try {
    const fundoEmAtrasoRows = await db
      .select({ fundoReserva: schema.quotas.fundoReserva })
      .from(schema.quotas)
      .where(and(
        eq(schema.quotas.tipo, "condominio"),
        eq(schema.quotas.pago, false),
        // FILTRO TEMPORAL: todas as quotas de 2026 (qualquer mês) — seeds são de 2025 ou anteriores
        sql`${schema.quotas.ano} >= 2026`,
      ));
    const atrasoFundoBD = fundoEmAtrasoRows.reduce((s, q) => s + (q.fundoReserva ?? 0), 0);
    await upsertSaldo("atraso_fundo_reserva", Math.round(atrasoFundoBD * 100) / 100);

    // Saldo FR = base + receitas classificadas desde âncora + cativos FR ainda na conta
    const saldoFRVirtual = Math.round(
      (SALDO_DEFAULTS.saldo_fundo_reserva! + acumFR + cativos.fundo_reserva) * 100
    ) / 100;
    await upsertSaldo("saldo_fundo_reserva", saldoFRVirtual);
  } catch (e) {
    console.error("[recalcularSaldos] fundo_reserva:", e);
  }

  // ─────────────────────────────────────────────────────────────────────────────
  // 4. OBRAS
  //    saldo_obras = base (21185.29) + acumObras (receitas obras desde âncora)
  //    Receitas Obras desde 02/06: somadas imediatamente ao depósito a prazo.
  // ─────────────────────────────────────────────────────────────────────────────
  try {
    const obrasEmAtraso = await db
      .select({ valor: schema.quotas.valor })
      .from(schema.quotas)
      .where(and(
        eq(schema.quotas.tipo, "obras"),
        eq(schema.quotas.pago, false),
        sql`${schema.quotas.ano} >= 2026`,
      ));
    const aReceberObrasBD = obrasEmAtraso.reduce((s, q) => s + q.valor, 0);

    if (aReceberObrasBD > 0) {
      await upsertSaldo("a_receber_obras", Math.round(aReceberObrasBD * 100) / 100);
    }

    // Saldo obras = base + receitas classificadas desde âncora (já no prazo físico)
    const saldoObrasVirtual = Math.round(
      (SALDO_DEFAULTS.saldo_obras! + acumObras) * 100
    ) / 100;
    await upsertSaldo("saldo_obras", saldoObrasVirtual);
  } catch (e) {
    console.error("[recalcularSaldos] obras:", e);
  }

  // ─────────────────────────────────────────────────────────────────────────────
  // 5. INDAQUA (Quota Extra Elevadores)
  //    Identificação via observacoes LIKE '%INDAQUA%'.
  //    saldo_quota_extra (virtual) += cativos INDAQUA ainda na Conta à Ordem.
  // ─────────────────────────────────────────────────────────────────────────────
  try {
    const indaquaRows = await db
      .select({ valor: schema.quotas.valor, pago: schema.quotas.pago, observacoes: schema.quotas.observacoes })
      .from(schema.quotas)
      .where(sql`${schema.quotas.observacoes} LIKE '%INDAQUA%'`);

    const aReceberIndaqua = indaquaRows.reduce((s, q) => {
      if (q.pago) return s;
      const m = q.observacoes?.match(/Em d[ií]vida: ([\d.]+)€/);
      return s + (m ? parseFloat(m[1]!) : q.valor);
    }, 0);

    await upsertSaldo("a_receber_indaqua", Math.round(aReceberIndaqua * 100) / 100);

    const saldoIndaquaVirtual = Math.round(
      (SALDO_DEFAULTS.saldo_quota_extra! + cativos.indaqua) * 100
    ) / 100;
    await upsertSaldo("saldo_quota_extra", saldoIndaquaVirtual);
  } catch (e) {
    console.error("[recalcularSaldos] indaqua:", e);
  }

  // ─────────────────────────────────────────────────────────────────────────────
  // 6. INCÊNDIO
  //    saldo_incendio = cativos de incêndio retidos na Conta à Ordem.
  // ─────────────────────────────────────────────────────────────────────────────
  try {
    const incendioRows = await db
      .select({ valor: schema.quotas.valor })
      .from(schema.quotas)
      .where(and(
        sql`${schema.quotas.observacoes} LIKE '%ncen%'`,
        eq(schema.quotas.pago, false),
        sql`${schema.quotas.ano} >= 2026`,
      ));
    const aReceberIncendio = incendioRows.reduce((s, q) => s + q.valor, 0);
    await upsertSaldo("a_receber_incendio", Math.round(aReceberIncendio * 100) / 100);

    // Saldo incêndio = cativos retidos (cativoIncendio da triagem + motor matricial)
    const saldoIncendioVirtual = Math.round(
      (SALDO_DEFAULTS.saldo_incendio! + cativos.incendio) * 100
    ) / 100;
    await upsertSaldo("saldo_incendio", saldoIncendioVirtual);
  } catch (e) {
    console.error("[recalcularSaldos] incendio:", e);
  }

  // ─────────────────────────────────────────────────────────────────────────────
  // 7. PORTÃO GARAGEM
  //    a_receber_portao = Excel − pagos na DB.
  //    saldo_portao (virtual) = cativos Motor retidos na Conta à Ordem.
  // ─────────────────────────────────────────────────────────────────────────────
  try {
    const portaoPagosRows = await db
      .select({ numero: schema.fracoes.numero })
      .from(schema.quotas)
      .leftJoin(schema.fracoes, eq(schema.quotas.fracaoId, schema.fracoes.id))
      .where(and(
        eq(schema.quotas.tipo, "extra"),
        eq(schema.quotas.quotaTipoId, PORTAO_TIPO_ID),
        eq(schema.quotas.pago, true),
      ));
    const portaoPagosNums = new Set(portaoPagosRows.map(r => r.numero).filter(Boolean));
    const portaoMorosos = PORTAO_DEVEDORES_EXCEL.filter(d => !portaoPagosNums.has(d.fracao.numero));
    const aReceberPortao = Math.round(portaoMorosos.reduce((s, d) => s + d.total, 0) * 100) / 100;

    const portaoPagosValor = await db
      .select({ valor: schema.quotas.valor })
      .from(schema.quotas)
      .where(and(
        eq(schema.quotas.tipo, "extra"),
        eq(schema.quotas.quotaTipoId, PORTAO_TIPO_ID),
        eq(schema.quotas.pago, true),
      ));
    const pagoPortao = Math.round(portaoPagosValor.reduce((s, q) => s + q.valor, 0) * 100) / 100;

    await upsertSaldo("a_receber_portao", aReceberPortao);
    await upsertSaldo("portao_pago", pagoPortao);

    // Saldo portão = cativos Motor retidos na Conta à Ordem
    const saldoPortaoVirtual = Math.round(
      (SALDO_DEFAULTS.saldo_portao! + cativos.portao) * 100
    ) / 100;
    await upsertSaldo("saldo_portao", saldoPortaoVirtual);
  } catch (e) {
    console.error("[recalcularSaldos] portao:", e);
  }

  // ─────────────────────────────────────────────────────────────────────────────
  // 8. QUOTA EXTRA ELEVADORES (ELEV_TIPO_ID)
  //    a_receber_quota_extra = Excel − pagos na DB.
  // ─────────────────────────────────────────────────────────────────────────────
  try {
    const elevPagosRows = await db
      .select({ numero: schema.fracoes.numero })
      .from(schema.quotas)
      .leftJoin(schema.fracoes, eq(schema.quotas.fracaoId, schema.fracoes.id))
      .where(and(
        eq(schema.quotas.tipo, "extra"),
        eq(schema.quotas.quotaTipoId, ELEV_TIPO_ID),
        eq(schema.quotas.pago, true),
      ));
    const elevPagosNums = new Set(elevPagosRows.map(r => r.numero).filter(Boolean));
    const elevMorosos = INDAQUA_DEVEDORES_EXCEL.filter(d => !elevPagosNums.has(d.fracao.numero));
    const aReceberElev = Math.round(elevMorosos.reduce((s, d) => s + d.total, 0) * 100) / 100;
    await upsertSaldo("a_receber_quota_extra", aReceberElev);
  } catch (e) {
    console.error("[recalcularSaldos] quota_extra:", e);
  }

  // ─────────────────────────────────────────────────────────────────────────────
  // 9. MOROSIDADE GLOBAL POR COTA EXTRAORDINÁRIA
  //    REGRA PROTEÇÃO OFFLINE: se não existem quotas importadas para uma rubrica
  //    (total_arrecadado = 0), NÃO fazemos reset para ORCAMENTO_* completo.
  //    Em vez disso, usamos SUM(fracoes.*_divida) como baseline — esses valores
  //    foram seeded directamente do Excel e representam a dívida real conhecida.
  //    Só usamos ORCAMENTO − total_arrecadado quando total_arrecadado > 0
  //    (i.e., existem quotas pagas na DB que provam que o sync correu correctamente).
  // ─────────────────────────────────────────────────────────────────────────────
  try {
    // ── Baseline a partir da tabela fracoes (seeded do Excel) ──────────────────
    const fracoesDividaRows = await db
      .select({
        obrasDivida:    schema.fracoes.obrasDivida,
        motorDivida:    schema.fracoes.motorDivida,
        incendioDivida: schema.fracoes.incendioDivida,
        indaquaDivida:  schema.fracoes.indaquaDivida,
      })
      .from(schema.fracoes);

    const baselineObras    = Math.round(fracoesDividaRows.reduce((s, r) => s + (r.obrasDivida    ?? 0), 0) * 100) / 100;
    const baselineMotor    = Math.round(fracoesDividaRows.reduce((s, r) => s + (r.motorDivida    ?? 0), 0) * 100) / 100;
    const baselineIncendio = Math.round(fracoesDividaRows.reduce((s, r) => s + (r.incendioDivida ?? 0), 0) * 100) / 100;
    const baselineElev     = Math.round(fracoesDividaRows.reduce((s, r) => s + (r.indaquaDivida  ?? 0), 0) * 100) / 100;

    // Motor (Portão) — quotaTipoId = PORTAO_TIPO_ID
    const motorPagoRows = await db
      .select({ valor: schema.quotas.valor })
      .from(schema.quotas)
      .where(and(eq(schema.quotas.quotaTipoId, PORTAO_TIPO_ID), eq(schema.quotas.pago, true)));
    const totalMotorArrecadado = Math.round(motorPagoRows.reduce((s, q) => s + q.valor, 0) * 100) / 100;
    // PROTEÇÃO: só subtrai do orçamento se há quotas importadas; caso contrário usa baseline
    const dividaMotor = totalMotorArrecadado > 0
      ? Math.max(0, Math.round((ORCAMENTO_MOTOR - totalMotorArrecadado) * 100) / 100)
      : baselineMotor;
    await upsertSaldo("divida_total_motor", dividaMotor);

    // Incêndio — quotaTipoId = INCENDIO_TIPO_ID
    const incendioPagoRows = await db
      .select({ valor: schema.quotas.valor })
      .from(schema.quotas)
      .where(and(eq(schema.quotas.quotaTipoId, INCENDIO_TIPO_ID), eq(schema.quotas.pago, true)));
    const totalIncendioArrecadado = Math.round(incendioPagoRows.reduce((s, q) => s + q.valor, 0) * 100) / 100;
    const dividaIncendio = totalIncendioArrecadado > 0
      ? Math.max(0, Math.round((ORCAMENTO_INCENDIO - totalIncendioArrecadado) * 100) / 100)
      : baselineIncendio;
    await upsertSaldo("divida_total_incendio", dividaIncendio);

    // Elevadores — quotaTipoId = ELEV_TIPO_ID
    const elevPagoRows2 = await db
      .select({ valor: schema.quotas.valor })
      .from(schema.quotas)
      .where(and(eq(schema.quotas.quotaTipoId, ELEV_TIPO_ID), eq(schema.quotas.pago, true)));
    const totalElevArrecadado = Math.round(elevPagoRows2.reduce((s, q) => s + q.valor, 0) * 100) / 100;
    const dividaElevadores = totalElevArrecadado > 0
      ? Math.max(0, Math.round((ORCAMENTO_ELEVADORES - totalElevArrecadado) * 100) / 100)
      : baselineElev;
    await upsertSaldo("divida_total_elevadores", dividaElevadores);

    // Obras — tipo='obras'
    const obrasPagoRows = await db
      .select({ valor: schema.quotas.valor })
      .from(schema.quotas)
      .where(and(eq(schema.quotas.tipo, "obras"), eq(schema.quotas.pago, true)));
    const totalObrasArrecadado = Math.round(obrasPagoRows.reduce((s, q) => s + q.valor, 0) * 100) / 100;
    const dividaObras = totalObrasArrecadado > 0
      ? Math.max(0, Math.round((ORCAMENTO_OBRAS - totalObrasArrecadado) * 100) / 100)
      : baselineObras;
    await upsertSaldo("divida_total_obras", dividaObras);

    console.log(
      `[recalcularSaldos] Dívidas globais (baseline fracoes: Obras=${baselineObras}€ Motor=${baselineMotor}€ Incêndio=${baselineIncendio}€ Elev=${baselineElev}€)` +
      ` → Motor:${dividaMotor}€ Incêndio:${dividaIncendio}€ Elevadores:${dividaElevadores}€ Obras:${dividaObras}€`
    );
  } catch (e) {
    console.error("[recalcularSaldos] morosidade global:", e);
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// CÁLCULO DE DÍVIDAS INDIVIDUAIS POR PERMILAGEM
// Fórmula: dívida = max(0, orcamento_rubrica × permilagem/1000 − total_pago)
// Fonte pagamentos: bank_transactions (rubrica_extra + fracaoId preenchidos
// durante processarStagedTransactions).
// ─────────────────────────────────────────────────────────────────────────────

export interface DividaFracao {
  obras:      number;
  motor:      number;
  incendio:   number;
  elevadores: number;
}

/**
 * calcularDividasIndividuais
 * ────────────────────────────────────────────────────────────────────────────
 * FONTE DE VERDADE: cartas de cobrança emitidas (CARTAS_JULHO_2026).
 * Substituiu o cálculo teórico permilagem × orçamento que gerava 62.264€
 * para frações que nunca receberam cobrança de extras.
 *
 * Retorna apenas as frações COM carta emitida e dívidas > 0.
 * Frações sem carta = em dia = não constam no resultado.
 *
 * Amortização pós-carta (pagamentos recebidos desde 26/06/2026):
 *   Cascata genérica: 1.º CC (quotaJulho) → 2.º FR (fundoReservaJulho)
 *                     → 3.º Obras → 4.º Motor → 5.º Incêndio.
 *   Fonte: quotas pago=true com dataPagamento >= 26/06/2026, ligadas à fração.
 */

// unix timestamp de 26/06/2026 00:00:00 UTC — âncora de pagamentos pós-carta
const ANCORA_PAGAMENTOS_CARTA_TS = 1750896000;

export async function calcularDividasIndividuais(): Promise<Record<string, DividaFracao>> {
  // ── 1. Ler pagamentos confirmados desde 26/06/2026 ─────────────────────────
  // Junta bank_transactions importadas (imported=1, amount>0, date>=âncora)
  // com o importRefId → quotas.id → quotas.fracaoId → fracoes.numero
  // para identificar a fração e o montante pago.
  // Usa bank_transactions como fonte primária (captura todos os pagamentos
  // importados pelo motor, incluindo parciais).
  let pagamentosPorFracao: Map<string, number> = new Map();
  try {
    const txRows = await db
      .select({
        amount:   schema.bankTransactions.amount,
        quotaId:  schema.bankTransactions.importRefId,
      })
      .from(schema.bankTransactions)
      .where(and(
        sql`${schema.bankTransactions.date} >= ${ANCORA_PAGAMENTOS_CARTA_TS}`,
        sql`${schema.bankTransactions.amount} > 0`,
        eq(schema.bankTransactions.imported, 1),
      ));

    // Para cada tx importada, resolver fracaoNumero via importRefId → quota
    const quotaIds = txRows
      .map(r => r.quotaId)
      .filter((id): id is string => !!id);

    if (quotaIds.length > 0) {
      // Buscar fracaoId de cada quota referenciada
      const quotaRows = await db
        .select({
          id:       schema.quotas.id,
          fracaoId: schema.quotas.fracaoId,
        })
        .from(schema.quotas)
        .where(inArray(schema.quotas.id, quotaIds));

      const quotaFracaoMap = new Map<string, string>(quotaRows.map(q => [q.id, q.fracaoId]));

      // Buscar numero da fração
      const fracaoIds = [...new Set(quotaRows.map(q => q.fracaoId))];
      const fracaoRows = fracaoIds.length > 0
        ? await db
          .select({ id: schema.fracoes.id, numero: schema.fracoes.numero })
          .from(schema.fracoes)
          .where(inArray(schema.fracoes.id, fracaoIds))
        : [];
      const fracaoNumMap = new Map<string, string>(fracaoRows.map(f => [f.id, f.numero ?? f.id]));

      for (const tx of txRows) {
        if (!tx.quotaId) continue;
        const fracaoId = quotaFracaoMap.get(tx.quotaId);
        if (!fracaoId) continue;
        const num = fracaoNumMap.get(fracaoId);
        if (!num) continue;
        const key = num.toUpperCase();
        pagamentosPorFracao.set(key, (pagamentosPorFracao.get(key) ?? 0) + (tx.amount ?? 0));
      }
    }
  } catch (e) {
    console.warn("[calcularDividasIndividuais] Falha ao ler pagamentos pós-carta:", e);
    // Continua sem abater — mostra valores brutos da carta
  }

  // ── 2. Construir resultado abatendo pagamentos em cascata ──────────────────
  const resultado: Record<string, DividaFracao> = {};

  for (const carta of CARTAS_JULHO_2026) {
    const id = carta.fracao.toUpperCase();

    // Valores brutos da carta
    let cc      = carta.quotaJulho + carta.quotasCC_atraso;
    let fr      = carta.fundoReservaJulho;
    let obras   = carta.obras;
    let motor   = carta.motor;
    let incendio = carta.incendio;

    // Abater pagamentos recebidos desde 26/06/2026 (cascata)
    let restante = pagamentosPorFracao.get(id) ?? 0;
    if (restante > 0) {
      const abate = (val: number): number => {
        if (restante <= 0) return val;
        const d = Math.min(restante, val);
        restante -= d;
        return Math.round((val - d) * 100) / 100;
      };
      cc       = abate(cc);
      fr       = abate(fr);
      obras    = abate(obras);
      motor    = abate(motor);
      incendio = abate(incendio);
    }

    // Só incluir se ainda há dívida em pelo menos uma rubrica de extras
    if (obras === 0 && motor === 0 && incendio === 0 && cc === 0 && fr === 0) continue;

    resultado[id] = {
      obras:      Math.round(obras    * 100) / 100,
      motor:      Math.round(motor    * 100) / 100,
      incendio:   Math.round(incendio * 100) / 100,
      elevadores: 0, // INDAQUA/elevadores tratados via INDAQUA_DEVEDORES_EXCEL separadamente
    };
  }

  return resultado;
}

// ─── Regra de Visibilidade de Faturação ──────────────────────────────────────
// Os dados de dívida e "por receber" de um dado mês/ano SÓ são visíveis
// a partir do dia 1 desse mês (00h00 UTC+0). Até lá o dashboard mantém-se
// focado no mês corrente — as cartas do próximo mês ficam ocultas no backend.
//
// Uso: faturacaoMesVisivel(7, 2026) → true se hoje >= 2026-07-01T00:00:00Z
export function faturacaoMesVisivel(mes: number, ano: number): boolean {
  const agora = Date.now();
  const gatilho = new Date(ano, mes - 1, 1, 0, 0, 0, 0).getTime(); // dia 1 mês, 00h00 local
  return agora >= gatilho;
}

export const dashboard = new Hono()
  .get("/", async (c) => {
    const agora = new Date();
    const mesAtual = agora.getMonth() + 1;
    const anoAtual = agora.getFullYear();

    // ── Gatilho de visibilidade para o mês de faturação actual ───────────────
    // Se ainda não chegámos ao dia 1 do mês das cartas (ex: Julho 2026),
    // o payload omite os dados de dívida das cartas e marca faturacaoVisivel=false.
    // Quando faturacaoVisivel=true, todos os dados de cartas são expostos normalmente.
    // NOTA: as CARTAS_JULHO_2026 são de Julho → mês 7, ano 2026.
    const CARTAS_MES = 7;
    const CARTAS_ANO = 2026;
    const faturacaoVisivel = faturacaoMesVisivel(CARTAS_MES, CARTAS_ANO);

    // Total frações ativas
    const fracaoCountRows = await db
      .select({ totalFracoes: sql<number>`count(*)` })
      .from(schema.fracoes)
      .where(eq(schema.fracoes.ativo, true));
    const totalFracoes = Math.max(fracaoCountRows[0]?.totalFracoes ?? 0, 33);

    // Quotas do mês atual (condomínio + fundo reserva)
    const quotasMes = await db
      .select()
      .from(schema.quotas)
      .where(and(
        eq(schema.quotas.mes, mesAtual),
        eq(schema.quotas.ano, anoAtual),
        eq(schema.quotas.tipo, "condominio")
      ));

    const totalQuotas = quotasMes.length;
    const quotasPagas = quotasMes.filter((q) => q.pago).length;
    const receitaMes = quotasMes.filter((q) => q.pago).reduce((sum, q) => sum + q.valor, 0);
    const receitaPendente = quotasMes.filter((q) => !q.pago).reduce((sum, q) => sum + q.valor, 0);

    // Despesas do mês atual
    const inicioMes = new Date(anoAtual, mesAtual - 1, 1);
    const fimMes = new Date(anoAtual, mesAtual, 0, 23, 59, 59);

    const despesasMes = await db.select().from(schema.despesas).where(
      and(
        sql`${schema.despesas.data} >= ${Math.floor(inicioMes.getTime() / 1000)}`,
        sql`${schema.despesas.data} <= ${Math.floor(fimMes.getTime() / 1000)}`
      )
    );
    const totalDespesasCategorizadasMes = despesasMes.reduce((sum, d) => sum + d.valor, 0);
    // totalDespesasMes inclui débitos bancários não categorizados do mês (calculado abaixo após cativos)
    // Para o cálculo inline do saldoMes usamos só as despesas categorizadas; debitosNaoCat adicionados no JSON final
    const totalDespesasMes = totalDespesasCategorizadasMes;
    const saldoMes = receitaMes - totalDespesasMes;

    // ===== SECÇÃO: CONTA CORRENTE (morosos) =====
    // FILTRO: todas as quotas de 2026 não pagas (qualquer mês).
    // Seeds/QA são de 2025 ou anteriores — ano >= 2026 exclui-os corretamente.
    const todasQuotasEmAtraso = await db
      .select({
        quota: schema.quotas,
        fracao: schema.fracoes,
      })
      .from(schema.quotas)
      .leftJoin(schema.fracoes, eq(schema.quotas.fracaoId, schema.fracoes.id))
      .where(
        and(
          eq(schema.quotas.tipo, "condominio"),
          eq(schema.quotas.pago, false),
          // Todas as quotas de 2026 em atraso — seeds são de 2025 ou anteriores
          sql`${schema.quotas.ano} >= 2026`
        )
      );

    // Agrupar por fração para morosos
    const morososMap = new Map<string, { fracao: any; quotas: any[]; total: number }>();
    for (const row of todasQuotasEmAtraso) {
      if (!row.fracao) continue;
      const id = row.fracao.id;
      if (!morososMap.has(id)) {
        morososMap.set(id, { fracao: row.fracao, quotas: [], total: 0 });
      }
      morososMap.get(id)!.quotas.push(row.quota);
      morososMap.get(id)!.total += row.quota.valor;
    }
    const morosos = Array.from(morososMap.values()).sort((a, b) => b.total - a.total);
    const totalMorosos = morosos.reduce((s, m) => s + m.total, 0);

    // ===== DÍVIDAS INDIVIDUAIS — FONTE: CARTAS DE COBRANÇA EMITIDAS ==========
    // calcularDividasIndividuais() usa CARTAS_JULHO_2026 como fonte de verdade.
    // Nunca usa permilagem × orçamento (gerava 62.264€ incorrectamente).
    // Gatilho dia 1: se faturacaoVisivel=false, retorna mapa vazio (cartas ainda ocultas).
    let dividasIndividuais: Record<string, DividaFracao> = {};
    if (faturacaoVisivel) {
      try {
        dividasIndividuais = await calcularDividasIndividuais();
      } catch (e) {
        console.warn("[dashboard] calcularDividasIndividuais falhou:", e);
      }
    }

    // ===== SECÇÃO: OBRAS =====
    // Fonte: CARTAS_JULHO_2026 (valores reais emitidos nas cartas de cobrança)
    // Fallback (sem cartas): fracoes.obras_divida (seeded do Excel)
    // Gatilho dia 1: se faturacaoVisivel=false, morososPorRubrica retorna estrutura vazia
    //   para que nenhuma rubrica de carta apareça no dashboard antes do dia 1 do mês.
    const cartasMorososReal = morososPorRubrica();
    const cartasMorosos = faturacaoVisivel ? cartasMorososReal : {
      obras: [], motor: [], incendio: [], contaCorrente: [],
    };

    let obrasEmAtraso: Array<{ fracao: any; quotas: any[]; total: number }>;
    let totalObrasAtraso: number;

    if (cartasMorosos.obras.length > 0) {
      // Fonte cartas — usar dados da carta directamente
      obrasEmAtraso = cartasMorosos.obras.map(m => ({
        fracao: {
          id: m.fracao,
          numero: m.fracao,
          proprietarioNome: m.proprietario,
          andar: 0,
        },
        total: m.total,
        quotas: [],
      }));
      totalObrasAtraso = Math.round(obrasEmAtraso.reduce((s, m) => s + m.total, 0) * 100) / 100;
    } else {
      // Fallback: fracoes.obras_divida (seeded do Excel)
      const obrasDividaBD = await db
        .select({ numero: schema.fracoes.numero, proprietarioNome: schema.fracoes.proprietarioNome, andar: schema.fracoes.andar, obrasDivida: schema.fracoes.obrasDivida })
        .from(schema.fracoes).where(gt(schema.fracoes.obrasDivida, 0));
      obrasEmAtraso = obrasDividaBD.map(r => ({
        fracao: { id: r.numero!, numero: r.numero!, proprietarioNome: r.proprietarioNome ?? "", andar: r.andar ?? 0 },
        total: Math.round((r.obrasDivida ?? 0) * 100) / 100,
        quotas: [],
      })).sort((a, b) => b.total - a.total);
      totalObrasAtraso = Math.round(obrasEmAtraso.reduce((s, m) => s + m.total, 0) * 100) / 100;
    }

    // Obras pagas (banco confirmado)
    const quotasObrasPagas = await db
      .select()
      .from(schema.quotas)
      .where(and(eq(schema.quotas.tipo, "obras"), eq(schema.quotas.pago, true)));
    const totalObrasPago = quotasObrasPagas.reduce((s, q) => s + q.valor, 0);
    const totalObrasTotal = totalObrasPago + totalObrasAtraso;

    // ===== SECÇÃO: EXTRAS =====
    const quotaTiposList = await db.select().from(schema.quotaTipos).where(eq(schema.quotaTipos.tipo, "extra"));

    const extrasSecoes = await Promise.all(
      quotaTiposList.map(async (qt) => {
        const quotasExtra = await db
          .select({ quota: schema.quotas, fracao: schema.fracoes })
          .from(schema.quotas)
          .leftJoin(schema.fracoes, eq(schema.quotas.fracaoId, schema.fracoes.id))
          .where(
            and(
              eq(schema.quotas.tipo, "extra"),
              eq(schema.quotas.quotaTipoId, qt.id),
              eq(schema.quotas.pago, false),
              // FILTRO TEMPORAL: todas as extras de 2026 em atraso (qualquer mês)
              sql`${schema.quotas.ano} >= 2026`
            )
          );

        const morososExtra = new Map<string, { fracao: any; quotas: any[]; total: number }>();
        for (const row of quotasExtra) {
          if (!row.fracao) continue;
          const id = row.fracao.id;
          if (!morososExtra.has(id)) morososExtra.set(id, { fracao: row.fracao, quotas: [], total: 0 });
          morososExtra.get(id)!.quotas.push(row.quota);
          morososExtra.get(id)!.total += row.quota.valor;
        }

        const emAtraso = Array.from(morososExtra.values()).sort((a, b) => b.total - a.total);
        const totalAtraso = emAtraso.reduce((s, m) => s + m.total, 0);

        const pagas = await db
          .select()
          .from(schema.quotas)
          .where(and(
            eq(schema.quotas.tipo, "extra"),
            eq(schema.quotas.quotaTipoId, qt.id),
            eq(schema.quotas.pago, true)
          ));
        const totalPago = pagas.reduce((s, q) => s + q.valor, 0);

        return {
          tipo: qt,
          totalPago,
          totalAtraso,
          totalTotal: totalPago + totalAtraso,
          fracoesEmAtraso: emAtraso.length,
          morosos: emAtraso,
        };
      })
    );

    // ===== SALDO CONTA CORRENTE (transacoes) =====
    // Estimativa baseada nas quotas pagas YTD menos despesas YTD
    const inicioAno = new Date(anoAtual, 0, 1);
    const fimMesAtual = new Date(anoAtual, mesAtual, 0, 23, 59, 59);
    const despesasYTD = await db.select().from(schema.despesas).where(
      and(
        sql`${schema.despesas.data} >= ${Math.floor(inicioAno.getTime() / 1000)}`,
        sql`${schema.despesas.data} <= ${Math.floor(fimMesAtual.getTime() / 1000)}`
      )
    );
    const totalDespesasYTD = despesasYTD.reduce((sum, d) => sum + d.valor, 0);

    // Evolução mensal (últimos 6 meses)
    const evolucao = [];
    for (let i = 5; i >= 0; i--) {
      const d = new Date(anoAtual, mesAtual - 1 - i, 1);
      const m = d.getMonth() + 1;
      const a = d.getFullYear();

      const quotasMesX = await db.select().from(schema.quotas).where(
        and(eq(schema.quotas.mes, m), eq(schema.quotas.ano, a), eq(schema.quotas.tipo, "condominio"))
      );
      const inicioMesX = new Date(a, m - 1, 1);
      const fimMesX = new Date(a, m, 0, 23, 59, 59);
      const despesasMesX = await db.select().from(schema.despesas).where(
        and(
          sql`${schema.despesas.data} >= ${Math.floor(inicioMesX.getTime() / 1000)}`,
          sql`${schema.despesas.data} <= ${Math.floor(fimMesX.getTime() / 1000)}`
        )
      );

      const receita = quotasMesX.filter((q) => q.pago).reduce((sum, q) => sum + q.valor, 0);
      const despesa = despesasMesX.reduce((sum, d) => sum + d.valor, 0);

      evolucao.push({
        mes: m,
        ano: a,
        label: d.toLocaleDateString("pt-PT", { month: "short", year: "2-digit" }),
        receita,
        despesa,
        saldo: receita - despesa,
      });
    }

    // Despesas por categoria (mês atual)
    const categorias: Record<string, number> = {};
    for (const d of despesasMes) {
      categorias[d.categoria] = (categorias[d.categoria] || 0) + d.valor;
    }

    // Orçamento anual 2026 por categoria
    const orcamentoMensal: Record<string, number> = {
      eletricidade:   200.00,
      agua:           150.00,
      limpeza:        150.00,
      jardim:         130.00,
      elevadores:     150.00,
      administracao:  138.00,
      manutencao:      75.00,
      diversos:        62.50,
    };

    const categoriasYTD: Record<string, number> = {};
    for (const d of despesasYTD) {
      categoriasYTD[d.categoria] = (categoriasYTD[d.categoria] || 0) + d.valor;
    }

    const mesesDecorridos = mesAtual;
    const orcamentoVsReal = Object.entries(orcamentoMensal).map(([cat, mensal]) => ({
      categoria: cat,
      orcadoAno: Math.round(mensal * 12 * 100) / 100,
      orcadoAcumulado: Math.round(mensal * mesesDecorridos * 100) / 100,
      gastoAcumulado: Math.round((categoriasYTD[cat] || 0) * 100) / 100,
      gastoMes: Math.round((categorias[cat] || 0) * 100) / 100,
      desvio: Math.round(((categoriasYTD[cat] || 0) - mensal * mesesDecorridos) * 100) / 100,
    }));

    const saldos = await getSaldos();

    // ===== VALORES CATIVOS — movimentos bancários não processados na Conta à Ordem =====
    // Lê bank_transactions(imported=0, amount>0) e classifica por gaveta via REGRAS_CATIVO.
    // Falha graciosamente se a tabela não existir (ambientes antigos).
    const cativos = await calcularValoresCativos();

    // ===== DÉBITOS BANCÁRIOS NÃO CATEGORIZADOS (bank_transactions imported=0, amount<0) =====
    // Saídas da conta à ordem ainda não categorizadas como despesas na DB.
    // Reduzem o saldo operacional disponível e são somadas ao totalDespesasMes se forem de junho.
    let debitosBancariosNaoCategorizados: Array<{
      id: string; date: Date; amount: number; description: string | null; type: string | null;
    }> = [];
    let totalDebitosBancariosMes = 0;
    let totalDebitosBancariosGlobal = 0;
    try {
      const debitosRows = await db
        .select({
          id: schema.bankTransactions.id,
          date: schema.bankTransactions.date,
          amount: schema.bankTransactions.amount,
          description: schema.bankTransactions.description,
          type: schema.bankTransactions.type,
        })
        .from(schema.bankTransactions)
        .where(and(
          eq(schema.bankTransactions.imported, 0),
          sql`${schema.bankTransactions.amount} < 0`,
        ));

      debitosBancariosNaoCategorizados = debitosRows.map(r => ({
        ...r,
        date: r.date instanceof Date ? r.date : new Date((r.date as number) * 1000),
        amount: Math.abs(r.amount), // positivo para somar
      }));

      for (const d of debitosBancariosNaoCategorizados) {
        totalDebitosBancariosGlobal += d.amount;
        // Se o débito for do mês actual, conta para despesas do mês
        const dMes = d.date.getMonth() + 1;
        const dAno = d.date.getFullYear();
        if (dMes === mesAtual && dAno === anoAtual) {
          totalDebitosBancariosMes += d.amount;
        }
      }
      totalDebitosBancariosMes = Math.round(totalDebitosBancariosMes * 100) / 100;
      totalDebitosBancariosGlobal = Math.round(totalDebitosBancariosGlobal * 100) / 100;
    } catch (e) {
      console.warn("[dashboard] Débitos bancários não categorizados:", e);
    }

    // saldo_operacional_disponivel persiste em configuracoes via recalcularSaldos().
    // No GET, calculamos inline para garantir frescura mesmo sem sync recente.
    // Cativos CRDT comprometem a conta mas não são despesas.
    // Débitos DBIT (amount<0) não categorizados APÓS a âncora CC (15/06/2026) ainda não
    // estão incluídos em despesas na DB → deduzir. Débitos anteriores já estão no saldo base.
    const totalDebitosBancariosAposAncora = debitosBancariosNaoCategorizados
      .filter(d => d.date.getTime() >= ANCORA_CC.getTime())
      .reduce((s, d) => s + d.amount, 0);
    const saldoOperacionalDisponivel = Math.round(
      (saldos.saldo_conta_corrente! - cativos.totalCativos - Math.round(totalDebitosBancariosAposAncora * 100) / 100) * 100
    ) / 100;

    // ===== PORTÃO GARAGEM e QUOTA EXTRA — derivados do extrasSecoes (100% dinâmico) =====
    // Os extrasSecoes já leram da DB todos os quotaTipos de tipo "extra" e os seus devedores.
    // Identificamos portão e elevadores pelo quotaTipoId conhecido.


    const portaoExtraDB   = extrasSecoes.find(e => e.tipo.id === PORTAO_TIPO_ID);
    const elevExtraDB     = extrasSecoes.find(e => e.tipo.id === ELEV_TIPO_ID);
    const incendioExtraDB = extrasSecoes.find(e => e.tipo.id === INCENDIO_TIPO_ID);

    // --- PORTÃO GARAGEM ---
    // A DB apenas tem quotas PAGAS (importadas via sync).
    // As não pagas nunca foram inseridas — baseamo-nos no Excel para a lista de devedores.
    // Lógica: lista Excel de devedores − quem já pagou na DB = morosos actuais.
    // As fracções que pagaram na DB são identificadas pelo número da fração (campo numero).
    // Buscar fracções que pagaram portão na DB (pago=true)
    const portaoPagosRows = await db
      .select({ numero: schema.fracoes.numero })
      .from(schema.quotas)
      .leftJoin(schema.fracoes, eq(schema.quotas.fracaoId, schema.fracoes.id))
      .where(and(
        eq(schema.quotas.tipo, "extra"),
        eq(schema.quotas.quotaTipoId, PORTAO_TIPO_ID),
        eq(schema.quotas.pago, true)
      ));
    const portaoPagosNums = new Set(portaoPagosRows.map(r => r.numero).filter(Boolean));

    // Morosos = Excel − quem pagou na DB
    const portaoMorososDinamico = PORTAO_DEVEDORES_EXCEL.filter(d => !portaoPagosNums.has(d.fracao.numero));
    const portaoAReceberDinamico = Math.round(portaoMorososDinamico.reduce((s, d) => s + d.total, 0) * 100) / 100;
    // Pago = totalDB (mais preciso que 707.25 - aReceber se o Excel não tiver todos os valores exactos)
    const portaoPagoDinamico = portaoExtraDB?.totalPago
      ? Math.round(portaoExtraDB.totalPago * 100) / 100
      : Math.round((707.25 - portaoAReceberDinamico) * 100) / 100;

    // --- INDAQUA + ELEVADORES (Quota Extra) ---
    // Fonte: INDAQUA_DEVEDORES_EXCEL − quem pagou na DB
    // (As cartas de julho não incluem dívida INDAQUA separada — ainda usamos Excel para esta gaveta)
    let quotaExtraMorososDinamico: Array<{ fracao: any; quotas: any[]; total: number }>;
    let quotaExtraAReceberDinamico: number;

    {
      const elevPagosRows = await db
        .select({ numero: schema.fracoes.numero })
        .from(schema.quotas)
        .leftJoin(schema.fracoes, eq(schema.quotas.fracaoId, schema.fracoes.id))
        .where(and(eq(schema.quotas.tipo, "extra"), eq(schema.quotas.quotaTipoId, ELEV_TIPO_ID), eq(schema.quotas.pago, true)));
      const elevPagosNums = new Set(elevPagosRows.map(r => r.numero).filter(Boolean));
      quotaExtraMorososDinamico = INDAQUA_DEVEDORES_EXCEL.filter(d => !elevPagosNums.has(d.fracao.numero));
      quotaExtraAReceberDinamico = Math.round(quotaExtraMorososDinamico.reduce((s, d) => s + d.total, 0) * 100) / 100;
    }

    // --- MOTOR GARAGEM ---
    // Fonte: CARTAS_JULHO_2026 (valores reais emitidos nas cartas de cobrança)
    // Fallback: MOTOR_DEVEDORES_EXCEL se não há cartas com motor
    let motorMorososDinamico: Array<{ fracao: any; quotas: any[]; total: number }>;
    let motorAReceberDinamico: number;

    if (cartasMorosos.motor.length > 0) {
      motorMorososDinamico = cartasMorosos.motor.map(m => ({
        fracao: { id: m.fracao, numero: m.fracao, proprietarioNome: m.proprietario, andar: 0 },
        total: m.total,
        quotas: [],
      }));
      motorAReceberDinamico = Math.round(motorMorososDinamico.reduce((s, d) => s + d.total, 0) * 100) / 100;
    } else {
      const motorDividaBD = await db.select({
        numero: schema.fracoes.numero, proprietarioNome: schema.fracoes.proprietarioNome,
        andar: schema.fracoes.andar, motor: schema.fracoes.motorDivida,
      }).from(schema.fracoes).where(gt(schema.fracoes.motorDivida, 0));

      motorMorososDinamico = motorDividaBD.length > 0
        ? motorDividaBD.filter(r => r.numero != null).map(r => ({
            fracao: { id: r.numero!, numero: r.numero!, proprietarioNome: r.proprietarioNome ?? "", andar: r.andar ?? 0 },
            total: Math.round((r.motor ?? 0) * 100) / 100, quotas: [],
          })).sort((a, b) => b.total - a.total)
        : MOTOR_DEVEDORES_EXCEL;
      motorAReceberDinamico = Math.round(motorMorososDinamico.reduce((s, d) => s + d.total, 0) * 100) / 100;
    }

    // --- INCÊNDIO ---
    // Fonte: CARTAS_JULHO_2026 (valores reais emitidos nas cartas de cobrança)
    // Fallback: INCENDIO_DEVEDORES_EXCEL − quem pagou na DB
    let incendioMorososDinamico: Array<{ fracao: any; quotas: any[]; total: number }>;
    let incendioAReceberDinamico: number;

    if (cartasMorosos.incendio.length > 0) {
      incendioMorososDinamico = cartasMorosos.incendio.map(m => ({
        fracao: { id: m.fracao, numero: m.fracao, proprietarioNome: m.proprietario, andar: 0 },
        total: m.total,
        quotas: [],
      }));
      incendioAReceberDinamico = Math.round(incendioMorososDinamico.reduce((s, d) => s + d.total, 0) * 100) / 100;
    } else {
      // Fallback: fracoes.incendio_divida (seeded do Excel — baseline Junho 2026)
      const incDividaBD = await db
        .select({ numero: schema.fracoes.numero, proprietarioNome: schema.fracoes.proprietarioNome, andar: schema.fracoes.andar, incendioDivida: schema.fracoes.incendioDivida })
        .from(schema.fracoes).where(gt(schema.fracoes.incendioDivida, 0));
      incendioMorososDinamico = incDividaBD.map(r => ({
        fracao: { id: r.numero!, numero: r.numero!, proprietarioNome: r.proprietarioNome ?? "", andar: r.andar ?? 0 },
        total: Math.round((r.incendioDivida ?? 0) * 100) / 100,
        quotas: [],
      })).sort((a, b) => b.total - a.total);
      incendioAReceberDinamico = Math.round(incendioMorososDinamico.reduce((s, d) => s + d.total, 0) * 100) / 100;
    }

    // --- CONTA CORRENTE (morosos) — fonte: cartas de julho ─────────────────
    // Usa cartasMorosos.contaCorrente (quotasCC_atraso > 0) como base.
    // Complementa com frações que têm quotaJulho e ainda não pagaram (julho corrente).
    // Se não há dados de cartas, cai no fallback BD (morosos).
    let ccMorososDinamico: Array<{ fracao: any; quotas: any[]; total: number }>;
    let ccTotalEmAtraso: number;
    let ccFracoesEmAtraso: number;

    if (cartasMorosos.contaCorrente.length > 0 || (faturacaoVisivel && CARTAS_JULHO_2026.some(c => c.quotaJulho > 0))) {
      // Frações com atraso histórico (quotasCC_atraso > 0) das cartas
      const ccHistorico = cartasMorosos.contaCorrente;
      // Frações que devem quota de julho mas ainda não pagaram (quotaJulho > 0 e não estão já no histórico)
      // Cruzar com quotas BD pago=true para mes=7, ano=2026
      const julhoPagasRows = await db
        .select({ numero: schema.fracoes.numero })
        .from(schema.quotas)
        .leftJoin(schema.fracoes, eq(schema.quotas.fracaoId, schema.fracoes.id))
        .where(and(
          eq(schema.quotas.tipo, "condominio"),
          eq(schema.quotas.mes, 7),
          eq(schema.quotas.ano, 2026),
          eq(schema.quotas.pago, true),
        ));
      const julhoPagosNums = new Set(julhoPagasRows.map(r => r.numero).filter(Boolean));

      // Frações com quotaJulho não paga (não constam nos pagos e têm quotaJulho > 0)
      const historicNums = new Set(ccHistorico.map(m => m.fracao.toUpperCase()));
      const julhoMorosos = CARTAS_JULHO_2026
        .filter(c => c.quotaJulho > 0 && !julhoPagosNums.has(c.fracao) && !historicNums.has(c.fracao.toUpperCase()))
        .map(c => ({
          fracao: { id: c.fracao, numero: c.fracao, proprietarioNome: c.proprietario, andar: 0 },
          total: Math.round((c.quotaJulho + c.fundoReservaJulho) * 100) / 100,
          quotas: [],
        }));

      const ccHistoricoFormatado = ccHistorico.map(m => ({
        fracao: { id: m.fracao, numero: m.fracao, proprietarioNome: m.proprietario, andar: 0 },
        total: m.total,
        quotas: [],
      }));

      ccMorososDinamico = [...ccHistoricoFormatado, ...julhoMorosos]
        .sort((a, b) => b.total - a.total);
      ccTotalEmAtraso = Math.round(ccMorososDinamico.reduce((s, m) => s + m.total, 0) * 100) / 100;
      ccFracoesEmAtraso = ccMorososDinamico.length;
    } else {
      // Fallback: BD quotas (comportamento anterior)
      ccMorososDinamico = morosos;
      ccTotalEmAtraso = totalMorosos;
      ccFracoesEmAtraso = morosos.length;
    }

    // --- FUNDO DE RESERVA (morosos) — fonte: cartas de julho ────────────────
    // Todas as cartas têm fundoReservaJulho > 0.
    // Morosos = frações que não pagaram FR julho (cruzar com quotas BD pago=true)
    let frMorososDinamico: Array<{ fracao: any; quotas: any[]; total: number }>;
    let frTotalEmAtraso: number;
    let frFracoesEmAtraso: number;

    if (faturacaoVisivel && CARTAS_JULHO_2026.some(c => c.fundoReservaJulho > 0)) {
      // Frações que pagaram FR julho na BD
      const frPagasRows = await db
        .select({ numero: schema.fracoes.numero, fundoReserva: schema.quotas.fundoReserva })
        .from(schema.quotas)
        .leftJoin(schema.fracoes, eq(schema.quotas.fracaoId, schema.fracoes.id))
        .where(and(
          eq(schema.quotas.tipo, "condominio"),
          eq(schema.quotas.mes, 7),
          eq(schema.quotas.ano, 2026),
          eq(schema.quotas.pago, true),
        ));
      const frPagosNums = new Set(frPagasRows.map(r => r.numero).filter(Boolean));

      frMorososDinamico = CARTAS_JULHO_2026
        .filter(c => c.fundoReservaJulho > 0 && !frPagosNums.has(c.fracao))
        .map(c => ({
          fracao: { id: c.fracao, numero: c.fracao, proprietarioNome: c.proprietario, andar: 0 },
          total: Math.round(c.fundoReservaJulho * 100) / 100,
          quotas: [],
        }))
        .sort((a, b) => b.total - a.total);

      frTotalEmAtraso = Math.round(frMorososDinamico.reduce((s, m) => s + m.total, 0) * 100) / 100;
      frFracoesEmAtraso = frMorososDinamico.length;
    } else {
      // Fallback dinâmico: quotas.fundo_reserva não pagas de 2026 agrupadas por fração
      const frQuotasEmAtraso = await db
        .select({
          quota: schema.quotas,
          fracao: schema.fracoes,
        })
        .from(schema.quotas)
        .leftJoin(schema.fracoes, eq(schema.quotas.fracaoId, schema.fracoes.id))
        .where(
          and(
            eq(schema.quotas.tipo, "condominio"),
            eq(schema.quotas.pago, false),
            sql`${schema.quotas.ano} >= 2026`,
            sql`${schema.quotas.fundoReserva} > 0`
          )
        );

      const frMap = new Map<string, { fracao: any; total: number }>();
      for (const row of frQuotasEmAtraso) {
        if (!row.fracao) continue;
        const id = row.fracao.id;
        if (!frMap.has(id)) {
          frMap.set(id, { fracao: row.fracao, total: 0 });
        }
        frMap.get(id)!.total += row.quota.fundoReserva ?? 0;
      }

      frMorososDinamico = Array.from(frMap.values())
        .map(e => ({
          fracao: {
            id: e.fracao.id,
            numero: e.fracao.numero ?? "",
            proprietarioNome: e.fracao.proprietarioNome ?? "",
            andar: e.fracao.andar ?? 0,
          },
          total: Math.round(e.total * 100) / 100,
          quotas: [],
        }))
        .filter(e => e.total > 0)
        .sort((a, b) => b.total - a.total);

      frTotalEmAtraso = Math.round(frMorososDinamico.reduce((s, m) => s + m.total, 0) * 100) / 100;
      frFracoesEmAtraso = frMorososDinamico.length;
    }

    return c.json({
      mesAtual,
      anoAtual,
      totalFracoes,
      totalQuotas,
      quotasPagas,
      quotasMorosas: morosos.length,
      receitaMes,
      receitaPendente,
      // Despesas categorizadas na DB + débitos bancários não categorizados do mês
      totalDespesasMes: Math.round((totalDespesasCategorizadasMes + totalDebitosBancariosMes) * 100) / 100,
      totalDespesasCategorizadasMes: Math.round(totalDespesasCategorizadasMes * 100) / 100,
      totalDebitosBancariosMes,
      saldoMes: Math.round((receitaMes - totalDespesasCategorizadasMes - totalDebitosBancariosMes) * 100) / 100,
      evolucao,
      categoriasDespesas: categorias,
      orcamentoVsReal,
      orcamentoMensal,
      // Secções
      contaCorrente: {
        totalEmAtraso: ccTotalEmAtraso,
        fracoesEmAtraso: ccFracoesEmAtraso,
        morosos: ccMorososDinamico,
        saldoConta: saldos.saldo_conta_corrente,
        fonteDados: cartasMorosos.contaCorrente.length > 0 ? "cartas" : "bd",
      },
      obras: {
        totalPago: totalObrasPago,
        // Fonte: cartas de cobrança emitidas (CARTAS_JULHO_2026)
        totalAtraso: totalObrasAtraso,
        totalTotal: totalObrasTotal,
        fracoesEmAtraso: obrasEmAtraso.length,
        morosos: obrasEmAtraso,
        saldoConta: saldos.saldo_obras,
        fonteDados: cartasMorosos.obras.length > 0 ? "cartas" : "excel",
      },
      extras: extrasSecoes,
      fundoReserva: {
        saldoConta: saldos.saldo_fundo_reserva,
        totalEmAtraso: frTotalEmAtraso,
        fracoesEmAtraso: frFracoesEmAtraso,
        morosos: frMorososDinamico,
        fonteDados: CARTAS_JULHO_2026.some(c => c.fundoReservaJulho > 0) ? "cartas" : "excel",
      },
      incendio: {
        // Fonte: cartas de cobrança emitidas (CARTAS_JULHO_2026)
        saldoConta: saldos.saldo_incendio,
        aReceber: incendioAReceberDinamico,
        fracoesEmAtraso: incendioMorososDinamico.length,
        morosos: incendioMorososDinamico,
        fonteDados: cartasMorosos.incendio.length > 0 ? "cartas" : "excel",
      },
      quotaExtra: {
        // Fonte: INDAQUA_DEVEDORES_EXCEL − DB pagos (cartas não desagregam INDAQUA)
        saldoConta: saldos.saldo_quota_extra,
        aReceber: quotaExtraAReceberDinamico,
        fracoesEmAtraso: quotaExtraMorososDinamico.length,
        morosos: quotaExtraMorososDinamico,
        fonteDados: "excel",
      },
      motor: {
        // Fonte: cartas de cobrança emitidas (CARTAS_JULHO_2026)
        aReceber: motorAReceberDinamico,
        fracoesEmAtraso: motorMorososDinamico.length,
        morosos: motorMorososDinamico,
        fonteDados: cartasMorosos.motor.length > 0 ? "cartas" : "excel",
      },
      portaoGaragem: {
        saldoConta: saldos.saldo_portao,
        // Recalcular a_receber e pago a partir dos morosos dinâmicos (DB remove quem pagou)
        aReceber: portaoAReceberDinamico,
        pago: portaoPagoDinamico,
        totalOrcamento: 707.25,
        morosos: portaoMorososDinamico,
      },
      // Pagamentos bancários confirmados mas NÃO categorizados no Excel pelo condomínio
      // Estes criam discrepâncias entre o que o Excel mostra e a realidade bancária
      pagamentosNaoRegistados: PAGAMENTOS_NAO_CATEGORIZADOS,
      // Mapa completo de dívidas por fração por rubrica (fonte: cartas de cobrança)
      dividasIndividuais,
      // Total "Por Receber" real = soma dos totalCarta emitidos
      // Oculto até ao dia 1 do mês de faturação (gatilho de visibilidade)
      totalGeralCartas: faturacaoVisivel ? totalGeralCartas() : 0,
      fonteDividasGlobal: "cartas-julho-2026",
      // ── Metadados de visibilidade de faturação ─────────────────────────────
      // O frontend usa estes campos para saber se deve exibir os valores do mês
      // de faturação ou mostrar apenas os saldos do mês corrente.
      faturacaoVisivel,
      faturacaoMes: CARTAS_MES,
      faturacaoAno: CARTAS_ANO,

      // ── SALDO OPERACIONAL (nova gaveta de topo) ─────────────────────────────
      // saldoContaCorrenteTotal   = saldo físico Conta à Ordem (inclui cativos)
      // saldoLiquidoBanco         = CC + Obras + FR — total real imediato em banco
      // valoresCativos            = dinheiro comprometido retido na Conta à Ordem
      // saldoOperacionalDisponivel = CC − cativos − débitos não categorizados
      saldoContaCorrenteTotal: saldos.saldo_conta_corrente!,
      saldoLiquidoBanco: Math.round(
        (saldos.saldo_conta_corrente! + saldos.saldo_obras! + saldos.saldo_fundo_reserva!) * 100
      ) / 100,
      saldoOperacionalDisponivel,
      valoresCativos: {
        // Totais por gaveta
        fundoReserva: cativos.porGaveta.fundo_reserva,
        indaqua:      cativos.porGaveta.indaqua,
        incendio:     cativos.porGaveta.incendio,
        portao:       cativos.porGaveta.portao,
        obras:        cativos.porGaveta.obras,
        total:        cativos.totalCativos,
        // Número de movimentos não processados classificados como cativos
        numMovimentos: cativos.numMovimentos,
        // Detalhe por movimento (para debug; omitir na UI de produção se necessário)
        movimentos: cativos.movimentos,
      },
      // Regras de classificação activas (permite UI de configuração futura)
      regrasCativo: REGRAS_CATIVO.map(r => ({
        gaveta: r.gaveta,
        label: r.label,
        patterns: r.patterns.map(p => p.toString()),
        ibansSender: r.ibansSender ?? [],
      })),
      // ── DÉBITOS BANCÁRIOS NÃO CATEGORIZADOS ───────────────────────────────
      // Saídas da conta à ordem (amount<0, imported=0) ainda não inseridas em despesas.
      // Já estão incluídos em totalDespesasMes e subtraídos do saldoOperacionalDisponivel.
      debitosBancariosNaoCategorizados: {
        totalMes: totalDebitosBancariosMes,
        totalGlobal: totalDebitosBancariosGlobal,
        movimentos: debitosBancariosNaoCategorizados,
      },
    }, 200);
  })
  // POST /recalcular — força recalculo de todos os saldos e persiste em configuracoes
  // PROTEÇÃO TIMEOUT: responde em no máximo 12 s mesmo que o banco esteja offline.
  // O frontend invalida o React Query após receber 200 — liberta sempre o botão.
  .post("/recalcular", async (c) => {
    const timeout = new Promise<void>((_, reject) =>
      setTimeout(() => reject(new Error("recalcular timeout")), 12_000)
    );
    try {
      await Promise.race([recalcularSaldos(), timeout]);
    } catch (e: any) {
      // Timeout ou erro parcial — continua para devolver saldos actuais
      console.warn("[POST /recalcular] recalcularSaldos incompleto:", e?.message ?? e);
    }

    let dividasIndividuais: Record<string, DividaFracao> = {};
    try {
      dividasIndividuais = await Promise.race([
        calcularDividasIndividuais(),
        new Promise<Record<string, DividaFracao>>((_, reject) =>
          setTimeout(() => reject(new Error("dividasIndividuais timeout")), 5_000)
        ),
      ]);
    } catch {
      // não bloqueia — cartas podem ainda estar a ser calculadas
    }

    const saldos = await getSaldos();
    return c.json({
      ok: true,
      mensagem: "Saldos recalculados com sucesso",
      timestamp: Date.now(),
      invalidateKeys: ["dashboard", "morosos"],
      dividasIndividuais,
      saldos: {
        saldo_conta_corrente:         saldos.saldo_conta_corrente,
        saldo_fundo_reserva:          saldos.saldo_fundo_reserva,
        saldo_obras:                  saldos.saldo_obras,
        saldo_quota_extra:            saldos.saldo_quota_extra,
        saldo_operacional_disponivel: saldos.saldo_operacional_disponivel,
        atraso_fundo_reserva:         saldos.atraso_fundo_reserva,
        a_receber_obras:              saldos.a_receber_obras,
        a_receber_quota_extra:        saldos.a_receber_quota_extra,
        a_receber_portao:             saldos.a_receber_portao,
        cativo_fundo_reserva:         saldos.cativo_fundo_reserva,
        cativo_obras:                 saldos.cativo_obras,
        cativo_indaqua:               saldos.cativo_indaqua,
        // dívidas globais (protegidas contra reset offline)
        divida_total_obras:           saldos.divida_total_obras,
        divida_total_motor:           saldos.divida_total_motor,
        divida_total_incendio:        saldos.divida_total_incendio,
        divida_total_elevadores:      saldos.divida_total_elevadores,
      },
    }, 200);
  })
  // Quick morosos count for sidebar badge
  .get("/morosos-count", async (c) => {
    // Count unique frações com quotas de condomínio em atraso (todos os meses)
    const rows = await db
      .select({ fracaoId: schema.quotas.fracaoId })
      .from(schema.quotas)
      .where(and(
        eq(schema.quotas.tipo, "condominio"),
        eq(schema.quotas.pago, false)
      ));
    const uniq = new Set(rows.map(r => r.fracaoId)).size;
    return c.json({ count: uniq });
  });
