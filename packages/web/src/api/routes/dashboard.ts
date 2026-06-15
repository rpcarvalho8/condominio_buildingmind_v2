import { Hono } from "hono";
import { db } from "../database";
import * as schema from "../database/schema";
import { eq, and, sql } from "drizzle-orm";
import {
  REGRAS_CATIVO,
  identificarDestinoCativo,
  type GavetaCativo,
} from "./cativo-rules";

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

const OBRAS_DEVEDORES_EXCEL = [
  { fracao: { id: "L",  numero: "L",  proprietarioNome: "João Marco Coutinho S. Moreira",    andar: 1 }, total: 2110.97, quotas: [] },
  { fracao: { id: "AG", numero: "AG", proprietarioNome: "João Pedro Amorim Dias",             andar: 2 }, total: 581.86,  quotas: [] },
  { fracao: { id: "AC", numero: "AC", proprietarioNome: "Maria de Fátima Martins Ascenção",   andar: 0 }, total: 607.35,  quotas: [] },
  { fracao: { id: "AD", numero: "AD", proprietarioNome: "Escutoglamour Unipessoal, Lda",      andar: 0 }, total: 629.51,  quotas: [] },
  { fracao: { id: "G",  numero: "G",  proprietarioNome: "Marma Concept, Unipessoal Lda",      andar: 0 }, total: 1160.63, quotas: [] },
  { fracao: { id: "X",  numero: "X",  proprietarioNome: "Alexandre Ribeiro Maia",             andar: 1 }, total: 315.57,  quotas: [] },
  { fracao: { id: "M",  numero: "M",  proprietarioNome: "Jannara Maria dos Santos",           andar: 1 }, total: 358.85,  quotas: [] },
].sort((a, b) => b.total - a.total);

// Sheet 5 — Quota Extra em dívida (coluna "VALOR EM DÍVIDA" > 1€)
const QUOTA_EXTRA_DEVEDORES_EXCEL = [
  { fracao: { id: "L",  numero: "L",  proprietarioNome: "João Marco Coutinho S. Moreira",    andar: 1 }, total: 323.24,  quotas: [] },
  { fracao: { id: "R",  numero: "R",  proprietarioNome: "Vanessa Cristina Araújo Silva",      andar: 2 }, total: 98.77,   quotas: [] },
  { fracao: { id: "U",  numero: "U",  proprietarioNome: "Catarina Reis Azevedo da Silva",     andar: 2 }, total: 99.57,   quotas: [] },
  { fracao: { id: "P",  numero: "P",  proprietarioNome: "Nuno Ricardo de Sá Ribeiro",         andar: 1 }, total: 75.36,   quotas: [] },
  { fracao: { id: "O",  numero: "O",  proprietarioNome: "Pedro Miguel R. Santos",             andar: 1 }, total: 72.69,   quotas: [] },
  // AH: 71.29€ base - 28.97€ portão pago 07/05/2026 = 42.32€ (só elevadores resta)
  { fracao: { id: "AH", numero: "AH", proprietarioNome: "Mª Madalena Costa F. Ramos",        andar: 2 }, total: 42.32,   quotas: [] },
  { fracao: { id: "J",  numero: "J",  proprietarioNome: "Mª da Conceição S. Moreira",        andar: 0 }, total: 67.53,   quotas: [] },
  { fracao: { id: "M",  numero: "M",  proprietarioNome: "Jannara Maria dos Santos",           andar: 1 }, total: 68.75,   quotas: [] },
  { fracao: { id: "T",  numero: "T",  proprietarioNome: "Susana Daniela Oliveira e Silva",   andar: 2 }, total: 67.01,   quotas: [] },
  // AI: 62.40€ base - 25.35€ portão pago 07/05/2026 = 37.05€ (só elevadores resta)
  { fracao: { id: "AI", numero: "AI", proprietarioNome: "Rui Carvalho",                       andar: 3 }, total: 37.05,   quotas: [] },
  { fracao: { id: "AG", numero: "AG", proprietarioNome: "João Pedro Amorim Dias",             andar: 2 }, total: 61.63,   quotas: [] },
  { fracao: { id: "AF", numero: "AF", proprietarioNome: "Rui Alexandre Silva Torres",         andar: 2 }, total: 61.28,   quotas: [] },
  { fracao: { id: "AA", numero: "AA", proprietarioNome: "Olivia Cândida Ferreira Lima",       andar: 3 }, total: 61.02,   quotas: [] },
  { fracao: { id: "AB", numero: "AB", proprietarioNome: "Ilídio António Morais Marinho",      andar: 3 }, total: 60.92,   quotas: [] },
  { fracao: { id: "AJ", numero: "AJ", proprietarioNome: "Mariana da Silva Reis",              andar: 3 }, total: 60.17,   quotas: [] },
  { fracao: { id: "AE", numero: "AE", proprietarioNome: "Germano A. M. Machado",              andar: 2 }, total: 64.40,   quotas: [] },
  { fracao: { id: "Z",  numero: "Z",  proprietarioNome: "Ana Isabel Dias Costa",              andar: 3 }, total: 95.99,   quotas: [] },
  { fracao: { id: "X2", numero: "X",  proprietarioNome: "Alexandre Ribeiro Maia",             andar: 1 }, total: 68.09,   quotas: [] },
  { fracao: { id: "Q",  numero: "Q",  proprietarioNome: "João Carlos Sousa Barros",           andar: 1 }, total: 64.64,   quotas: [] },
  { fracao: { id: "S",  numero: "S",  proprietarioNome: "Célia Beatriz Sá",                  andar: 1 }, total: 56.29,   quotas: [] },
  { fracao: { id: "V",  numero: "V",  proprietarioNome: "Sérgio Miguel da S. Monteiro",       andar: 2 }, total: 59.26,   quotas: [] },
  { fracao: { id: "N",  numero: "N",  proprietarioNome: "Filipe Daniel F. Teixeira",          andar: 1 }, total: 33.78,   quotas: [] },
  { fracao: { id: "G2", numero: "G",  proprietarioNome: "Marma Concept, Unipessoal Lda",      andar: 0 }, total: 23.87,   quotas: [] },
].sort((a, b) => b.total - a.total);

// Sheet 6 — Incêndio em dívida
const INCENDIO_DEVEDORES_EXCEL = [
  { fracao: { id: "G3", numero: "G",  proprietarioNome: "Marma Concept, Unipessoal Lda",    andar: 0 }, total: 60.72, quotas: [] },
  { fracao: { id: "AC2",numero: "AC", proprietarioNome: "Maria de Fátima Martins Ascenção", andar: 0 }, total: 47.87, quotas: [] },
  { fracao: { id: "AD2",numero: "AD", proprietarioNome: "Escutoglamour Unipessoal, Lda",    andar: 0 }, total: 49.40, quotas: [] },
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
const SALDO_DEFAULTS: Record<string, number> = {
  saldo_conta_corrente: 3388.39, // saldo base confirmado 2026-06-13
  saldo_fundo_reserva: 651.30,   // soma real depósitos a prazo FR: 250+83.58+104.60+85.23+127.89
  atraso_fundo_reserva: 7.21,  // corrigido: L pagou 25.47 (23.99 pre-2026 fundo + parcial Jan)
  saldo_obras: 21185.29,        // soma real 16 depósitos a prazo Obras (extrato Santander)
  saldo_quota_extra: 110.45,    // depósito a prazo "Quota Extra" real (extrato Santander)
  saldo_incendio: 0,
  a_receber_incendio: 157.98,
  a_receber_obras: 6006.05,
  a_receber_quota_extra: 1723.56,  // 1777.88 - 28.97(AH portão pago 07/05) - 25.35(AI portão pago 07/05)
  saldo_portao: 0,
  a_receber_portao: 593.27,  // 707.25 - 59.66(base) - 25.35(AI 07/05) - 28.97(AH 07/05) = 593.27
  portao_pago: 113.98,        // 59.66 + 25.35(AI 07/05) + 28.97(AH 07/05)
  // ── Valores cativos (dinheiro na Conta à Ordem ainda não transferido) ──────
  // Recalculados dinamicamente a partir de bank_transactions com imported=0.
  // Se não houver sync bancário, ficam a zero (nenhum cativo detectado).
  cativo_fundo_reserva: 0,
  cativo_indaqua: 0,
  cativo_incendio: 0,
  cativo_portao: 0,
  cativo_obras: 0,
  // saldo_operacional_disponivel = saldo_conta_corrente − soma de todos os cativos
  saldo_operacional_disponivel: 3388.39,
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
  // 1. CONTA CORRENTE
  //    saldoBase + receitas_condominio_desde_ancora − despesas_desde_ancora
  //    Nota: fundoReserva NÃO entra aqui (gaveta separada).
  // ─────────────────────────────────────────────────────────────────────────────
  let saldoContaCorrente = SALDO_DEFAULTS.saldo_conta_corrente;

  try {
    const cfgRows = await db.select().from(schema.configuracoes);
    const cfg = Object.fromEntries(cfgRows.map(r => [r.chave, r.valor]));
    const saldoBase = parseFloat(cfg.saldo_base_valor ?? "0");
    const saldoBaseData = cfg.saldo_base_data; // "YYYY-MM-DD"

    if (saldoBase > 0 && saldoBaseData) {
      const baseTs = Math.floor(new Date(saldoBaseData).getTime() / 1000);

      // Apenas q.valor (parte operacional) — fundoReserva fica na sua gaveta
      const quotasDesdeBase = await db
        .select({ valor: schema.quotas.valor })
        .from(schema.quotas)
        .where(and(
          eq(schema.quotas.tipo, "condominio"),
          eq(schema.quotas.pago, true),
          sql`${schema.quotas.dataPagamento} >= ${baseTs}`,
        ));
      const receitasDesdeBase = quotasDesdeBase.reduce((s, q) => s + q.valor, 0);

      const despesasDesdeBase = await db
        .select({ valor: schema.despesas.valor })
        .from(schema.despesas)
        .where(sql`${schema.despesas.data} >= ${baseTs}`);
      const totalDespesasDesdeBase = despesasDesdeBase.reduce((s, d) => s + d.valor, 0);

      saldoContaCorrente = Math.round((saldoBase + receitasDesdeBase - totalDespesasDesdeBase) * 100) / 100;
      await upsertSaldo("saldo_conta_corrente", saldoContaCorrente);
    }
  } catch (e) {
    console.error("[recalcularSaldos] saldo_conta_corrente:", e);
  }

  // ─────────────────────────────────────────────────────────────────────────────
  // 2. VALORES CATIVOS (bank_transactions não importadas)
  //    Para cada movimento CRDT ainda não processado, classifica por gaveta.
  //    Subtrai o total de cativos do saldo_conta_corrente para obter o saldo
  //    operacional real disponível para despesas correntes.
  //    Cada cativo aumenta também o saldo virtual da sua gaveta (UI).
  // ─────────────────────────────────────────────────────────────────────────────
  let cativos = {
    fundo_reserva: 0,
    indaqua: 0,
    incendio: 0,
    portao: 0,
    obras: 0,
    total: 0,
  };

  try {
    const resultado = await calcularValoresCativos();

    cativos = {
      ...resultado.porGaveta,
      total: resultado.totalCativos,
    };

    // Persistir cativos por gaveta
    await upsertSaldo("cativo_fundo_reserva", cativos.fundo_reserva);
    await upsertSaldo("cativo_indaqua",       cativos.indaqua);
    await upsertSaldo("cativo_incendio",      cativos.incendio);
    await upsertSaldo("cativo_portao",        cativos.portao);
    await upsertSaldo("cativo_obras",         cativos.obras);

    if (resultado.numMovimentos > 0) {
      console.log(`[recalcularSaldos] ${resultado.numMovimentos} movimentos cativos detectados — total: ${cativos.total.toFixed(2)}€`);
      for (const m of resultado.movimentos) {
        console.log(`  [${m.gaveta}] ${m.amount.toFixed(2)}€ — "${(m.description ?? "").slice(0, 60)}" (match: ${m.matchedField})`);
      }
    }
  } catch (e) {
    console.error("[recalcularSaldos] cativos:", e);
  }

  // saldo_operacional_disponivel = saldo bruto − cativos comprometidos com gavetas
  const saldoOperacional = Math.round((saldoContaCorrente - cativos.total) * 100) / 100;
  await upsertSaldo("saldo_operacional_disponivel", saldoOperacional);

  // ─────────────────────────────────────────────────────────────────────────────
  // 3. FUNDO DE RESERVA
  //    saldo_fundo_reserva = estático (277.89) + cativos classificados como FR.
  //    Nota: cativos.fundo_reserva já foi persistido em cativo_fundo_reserva.
  //    Só actualizamos atraso_fundo_reserva (quotas não pagas).
  // ─────────────────────────────────────────────────────────────────────────────
  try {
    const fundoEmAtrasoRows = await db
      .select({ fundoReserva: schema.quotas.fundoReserva })
      .from(schema.quotas)
      .where(and(
        eq(schema.quotas.tipo, "condominio"),
        eq(schema.quotas.pago, false),
      ));
    const atrasoFundoBD = fundoEmAtrasoRows.reduce((s, q) => s + (q.fundoReserva ?? 0), 0);
    if (atrasoFundoBD > 0) {
      await upsertSaldo("atraso_fundo_reserva", Math.round(atrasoFundoBD * 100) / 100);
    }

    // Saldo virtual FR = base estático + cativos FR ainda não transferidos
    const saldoFRVirtual = Math.round(
      (SALDO_DEFAULTS.saldo_fundo_reserva + cativos.fundo_reserva) * 100
    ) / 100;
    await upsertSaldo("saldo_fundo_reserva", saldoFRVirtual);
  } catch (e) {
    console.error("[recalcularSaldos] fundo_reserva:", e);
  }

  // ─────────────────────────────────────────────────────────────────────────────
  // 4. OBRAS
  //    a_receber_obras = DB (se existir) ou fallback Excel.
  //    saldo_obras (virtual) = base + cativos de obras ainda na Conta à Ordem.
  // ─────────────────────────────────────────────────────────────────────────────
  try {
    const obrasEmAtraso = await db
      .select({ valor: schema.quotas.valor })
      .from(schema.quotas)
      .where(and(eq(schema.quotas.tipo, "obras"), eq(schema.quotas.pago, false)));
    const aReceberObrasBD = obrasEmAtraso.reduce((s, q) => s + q.valor, 0);

    if (aReceberObrasBD > 0) {
      await upsertSaldo("a_receber_obras", Math.round(aReceberObrasBD * 100) / 100);
    }

    // Saldo virtual obras = base real (depósitos a prazo) + cativos ainda na Conta à Ordem
    const saldoObrasVirtual = Math.round(
      (SALDO_DEFAULTS.saldo_obras + cativos.obras) * 100
    ) / 100;
    await upsertSaldo("saldo_obras", saldoObrasVirtual);
  } catch (e) {
    console.error("[recalcularSaldos] obras:", e);
  }

  // ─────────────────────────────────────────────────────────────────────────────
  // 5. INDAQUA (Quota Extra Elevadores)
  //    Identificação via observacoes LIKE '%INDAQUA%' (quotaTipoId=NULL na DB).
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
      return s + (m ? parseFloat(m[1]) : q.valor);
    }, 0);

    await upsertSaldo("a_receber_indaqua", Math.round(aReceberIndaqua * 100) / 100);

    // Saldo virtual INDAQUA += cativos ainda na Conta à Ordem
    // Saldo virtual INDAQUA = base real (depósito a prazo) + cativos ainda na Conta à Ordem
    const saldoIndaquaVirtual = Math.round(
      (SALDO_DEFAULTS.saldo_quota_extra + cativos.indaqua) * 100
    ) / 100;
    await upsertSaldo("saldo_quota_extra", saldoIndaquaVirtual);
  } catch (e) {
    console.error("[recalcularSaldos] indaqua:", e);
  }

  // ─────────────────────────────────────────────────────────────────────────────
  // 6. INCÊNDIO
  //    Identificação via observacoes LIKE '%ncen%'.
  //    saldo_incendio (virtual) += cativos de incêndio ainda na Conta à Ordem.
  // ─────────────────────────────────────────────────────────────────────────────
  try {
    const incendioRows = await db
      .select({ valor: schema.quotas.valor })
      .from(schema.quotas)
      .where(and(
        sql`${schema.quotas.observacoes} LIKE '%ncen%'`,
        eq(schema.quotas.pago, false),
      ));
    const aReceberIncendio = incendioRows.reduce((s, q) => s + q.valor, 0);
    await upsertSaldo("a_receber_incendio", Math.round(aReceberIncendio * 100) / 100);

    // Saldo virtual incêndio += cativos ainda na Conta à Ordem
    if (cativos.incendio > 0) {
      const saldoIncendioVirtual = Math.round(
        (SALDO_DEFAULTS.saldo_incendio + cativos.incendio) * 100
      ) / 100;
      await upsertSaldo("saldo_incendio", saldoIncendioVirtual);
    }
  } catch (e) {
    console.error("[recalcularSaldos] incendio:", e);
  }

  // ─────────────────────────────────────────────────────────────────────────────
  // 7. PORTÃO GARAGEM
  //    a_receber_portao = Excel − pagos na DB (fallback se quotaTipoId vazio).
  //    saldo_portao (virtual) += cativos de portão ainda na Conta à Ordem.
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
    if (pagoPortao > 0) await upsertSaldo("portao_pago", pagoPortao);

    // Saldo virtual portão += cativos ainda na Conta à Ordem
    if (cativos.portao > 0) {
      const saldoPortaoVirtual = Math.round(
        (SALDO_DEFAULTS.saldo_portao + cativos.portao) * 100
      ) / 100;
      await upsertSaldo("saldo_portao", saldoPortaoVirtual);
    }
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
    const elevMorosos = QUOTA_EXTRA_DEVEDORES_EXCEL.filter(d => !elevPagosNums.has(d.fracao.numero));
    const aReceberElev = Math.round(elevMorosos.reduce((s, d) => s + d.total, 0) * 100) / 100;
    await upsertSaldo("a_receber_quota_extra", aReceberElev);
  } catch (e) {
    console.error("[recalcularSaldos] quota_extra:", e);
  }
}

export const dashboard = new Hono()
  .get("/", async (c) => {
    const agora = new Date();
    const mesAtual = agora.getMonth() + 1;
    const anoAtual = agora.getFullYear();

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
    const totalDespesasMes = despesasMes.reduce((sum, d) => sum + d.valor, 0);
    const saldoMes = receitaMes - totalDespesasMes;

    // ===== SECÇÃO: CONTA CORRENTE (morosos) =====
    // Todos os meses em atraso — quotas condomínio não pagas
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
          eq(schema.quotas.pago, false)
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

    // ===== SECÇÃO: OBRAS =====
    const quotasObrasAtraso = await db
      .select({
        quota: schema.quotas,
        fracao: schema.fracoes,
      })
      .from(schema.quotas)
      .leftJoin(schema.fracoes, eq(schema.quotas.fracaoId, schema.fracoes.id))
      .where(
        and(
          eq(schema.quotas.tipo, "obras"),
          eq(schema.quotas.pago, false)
        )
      );
    const morososObras = new Map<string, { fracao: any; quotas: any[]; total: number }>();
    for (const row of quotasObrasAtraso) {
      if (!row.fracao) continue;
      const id = row.fracao.id;
      if (!morososObras.has(id)) morososObras.set(id, { fracao: row.fracao, quotas: [], total: 0 });
      morososObras.get(id)!.quotas.push(row.quota);
      morososObras.get(id)!.total += row.quota.valor;
    }
    const obrasEmAtraso = Array.from(morososObras.values()).sort((a, b) => b.total - a.total);
    const totalObrasAtraso = obrasEmAtraso.reduce((s, m) => s + m.total, 0);

    // Obras pagas
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
              eq(schema.quotas.pago, false)
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

    // saldo_operacional_disponivel persiste em configuracoes via recalcularSaldos().
    // No GET, calculamos inline para garantir frescura mesmo sem sync recente.
    const saldoOperacionalDisponivel = Math.round(
      (saldos.saldo_conta_corrente - cativos.totalCativos) * 100
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

    // --- QUOTA EXTRA (elevadores) ---
    // Mesma lógica: Excel base − quem pagou na DB
    const elevPagosRows = await db
      .select({ numero: schema.fracoes.numero })
      .from(schema.quotas)
      .leftJoin(schema.fracoes, eq(schema.quotas.fracaoId, schema.fracoes.id))
      .where(and(
        eq(schema.quotas.tipo, "extra"),
        eq(schema.quotas.quotaTipoId, ELEV_TIPO_ID),
        eq(schema.quotas.pago, true)
      ));
    const elevPagosNums = new Set(elevPagosRows.map(r => r.numero).filter(Boolean));

    const quotaExtraMorososDinamico = QUOTA_EXTRA_DEVEDORES_EXCEL.filter(d => !elevPagosNums.has(d.fracao.numero));
    const quotaExtraAReceberDinamico = Math.round(quotaExtraMorososDinamico.reduce((s, d) => s + d.total, 0) * 100) / 100;

    // --- INCÊNDIO ---
    // Mesma lógica: Excel base − quem pagou na DB
    const incPagosRows = await db
      .select({ numero: schema.fracoes.numero })
      .from(schema.quotas)
      .leftJoin(schema.fracoes, eq(schema.quotas.fracaoId, schema.fracoes.id))
      .where(and(
        eq(schema.quotas.tipo, "extra"),
        eq(schema.quotas.quotaTipoId, INCENDIO_TIPO_ID),
        eq(schema.quotas.pago, true)
      ));
    const incPagosNums = new Set(incPagosRows.map(r => r.numero).filter(Boolean));
    const incendioMorososDinamico = INCENDIO_DEVEDORES_EXCEL.filter(d => !incPagosNums.has(d.fracao.numero));
    const incendioAReceberDinamico = Math.round(incendioMorososDinamico.reduce((s, d) => s + d.total, 0) * 100) / 100;

    return c.json({
      mesAtual,
      anoAtual,
      totalFracoes,
      totalQuotas,
      quotasPagas,
      quotasMorosas: morosos.length,
      receitaMes,
      receitaPendente,
      totalDespesasMes,
      saldoMes,
      evolucao,
      categoriasDespesas: categorias,
      orcamentoVsReal,
      orcamentoMensal,
      // Secções
      contaCorrente: {
        totalEmAtraso: totalMorosos,
        fracoesEmAtraso: morosos.length,
        morosos,
        saldoConta: saldos.saldo_conta_corrente,
      },
      obras: {
        totalPago: totalObrasPago,
        // Se BD sem dados, usar valor real do Excel
        totalAtraso: totalObrasAtraso > 0 ? totalObrasAtraso : (saldos.a_receber_obras ?? 0),
        totalTotal: totalObrasTotal > 0 ? totalObrasTotal : (totalObrasPago + (saldos.a_receber_obras ?? 0)),
        fracoesEmAtraso: obrasEmAtraso.length > 0 ? obrasEmAtraso.length : OBRAS_DEVEDORES_EXCEL.length,
        morosos: obrasEmAtraso.length > 0 ? obrasEmAtraso : OBRAS_DEVEDORES_EXCEL,
        saldoConta: saldos.saldo_obras,
      },
      extras: extrasSecoes,
      fundoReserva: {
        saldoConta: saldos.saldo_fundo_reserva,
        totalEmAtraso: saldos.atraso_fundo_reserva,
        // Devedores fundo reserva (da sheet 3, quotas condominio inclui FR)
        morosos: FUNDO_RESERVA_DEVEDORES_EXCEL,
      },
      incendio: {
        // Obra paga ao empreiteiro com dinheiro da conta geral
        // Saldo da conta = 0 (obra liquidada)
        // A receber = valor que G/AC/AD ainda não pagaram (dinâmico via DB > Excel fallback)
        saldoConta: saldos.saldo_incendio,
        aReceber: incendioAReceberDinamico,
        morosos: incendioMorososDinamico,
      },
      quotaExtra: {
        saldoConta: saldos.saldo_quota_extra,
        // Recalcular a_receber a partir dos morosos dinâmicos (DB remove quem pagou)
        aReceber: quotaExtraMorososDinamico.length > 0 ? quotaExtraAReceberDinamico : saldos.a_receber_quota_extra,
        morosos: quotaExtraMorososDinamico,
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

      // ── SALDO OPERACIONAL (nova gaveta de topo) ─────────────────────────────
      // saldoContaCorrenteTotal = saldo físico bancário (inclui cativos)
      // valoresCativos          = dinheiro comprometido com gavetas (ainda não transferido)
      // saldoOperacionalDisponivel = o que pode ser gasto em despesas correntes
      saldoContaCorrenteTotal: saldos.saldo_conta_corrente,
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
