import { Hono } from "hono";
import { db } from "../database";
import * as schema from "../database/schema";
import { eq, and, sql } from "drizzle-orm";

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
  saldo_fundo_reserva: 277.89,
  atraso_fundo_reserva: 7.21,  // corrigido: L pagou 25.47 (23.99 pre-2026 fundo + parcial Jan)
  saldo_obras: 26912.37,
  saldo_quota_extra: 4140.79,
  saldo_incendio: 0,
  a_receber_incendio: 157.98,
  a_receber_obras: 6006.05,
  a_receber_quota_extra: 1723.56,  // 1777.88 - 28.97(AH portão pago 07/05) - 25.35(AI portão pago 07/05)
  saldo_portao: 0,
  a_receber_portao: 593.27,  // 707.25 - 59.66(base) - 25.35(AI 07/05) - 28.97(AH 07/05) = 593.27
  portao_pago: 113.98,        // 59.66 + 25.35(AI 07/05) + 28.97(AH 07/05)
};

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
 * O que recalcula:
 *  - saldo_conta_corrente: soma de quotas condomínio pagas no ano corrente − despesas YTD
 *    (proxy do saldo bancário real; as transferências do sync actualizam quotas/despesas)
 *  - saldo_fundo_reserva: não temos conta separada na DB → mantém valor manual
 *  - atraso_fundo_reserva: quotas fundo_reserva não pagas
 *  - saldo_obras / a_receber_obras: derivado das quotas obras na DB
 *  - saldo_quota_extra / a_receber_quota_extra: derivado das quotas extras (elevadores)
 *  - portao / incendio: a_receber recalculado (Excel − pagos DB)
 */
export async function recalcularSaldos(): Promise<void> {
  // ── Conta corrente: saldo_base + quotas_pagas_desde_base − despesas_desde_base ──
  // saldo_base_valor e saldo_base_data são gravados em configuracoes sempre que
  // o saldo real é confirmado (via Definições ou importação Excel).
  try {
    const cfgRows = await db.select().from(schema.configuracoes);
    const cfg = Object.fromEntries(cfgRows.map(r => [r.chave, r.valor]));
    const saldoBase = parseFloat(cfg.saldo_base_valor ?? "0");
    const saldoBaseData = cfg.saldo_base_data; // "YYYY-MM-DD"

    if (saldoBase > 0 && saldoBaseData) {
      const baseTs = Math.floor(new Date(saldoBaseData).getTime() / 1000);

      // Quotas condomínio pagas desde a data base
      const quotasDesdeBase = await db
        .select({ valor: schema.quotas.valor, fundoReserva: schema.quotas.fundoReserva })
        .from(schema.quotas)
        .where(and(
          eq(schema.quotas.tipo, "condominio"),
          eq(schema.quotas.pago, true),
          sql`${schema.quotas.dataPagamento} >= ${baseTs}`,
        ));
      const receitasDesdeBase = quotasDesdeBase.reduce(
        (s, q) => s + q.valor + (q.fundoReserva ?? 0), 0
      );

      // Despesas desde a data base
      const despesasDesdeBase = await db
        .select({ valor: schema.despesas.valor })
        .from(schema.despesas)
        .where(sql`${schema.despesas.data} >= ${baseTs}`);
      const totalDespesasDesdeBase = despesasDesdeBase.reduce((s, d) => s + d.valor, 0);

      const saldoCorrente = saldoBase + receitasDesdeBase - totalDespesasDesdeBase;
      await upsertSaldo("saldo_conta_corrente", Math.round(saldoCorrente * 100) / 100);
    }
  } catch (e) {
    // falha silenciosa — saldo_conta_corrente mantém último valor
    console.error("[recalcularSaldos] saldo_conta_corrente:", e);
  }

  // ── Obras: a_receber da DB ──────────────────────────────────────────────────
  const obrasEmAtraso = await db
    .select({ valor: schema.quotas.valor })
    .from(schema.quotas)
    .where(and(eq(schema.quotas.tipo, "obras"), eq(schema.quotas.pago, false)));
  const aReceberObrasBD = obrasEmAtraso.reduce((s, q) => s + q.valor, 0);

  const obrasPagas = await db
    .select({ valor: schema.quotas.valor })
    .from(schema.quotas)
    .where(and(eq(schema.quotas.tipo, "obras"), eq(schema.quotas.pago, true)));
  const pagoObrasBD = obrasPagas.reduce((s, q) => s + q.valor, 0);

  // Só actualiza se a DB tiver dados (evitar apagar valores do Excel antes de importação)
  if (aReceberObrasBD > 0 || pagoObrasBD > 0) {
    await upsertSaldo("a_receber_obras", Math.round(aReceberObrasBD * 100) / 100);
  }

  // ── Portão: a_receber = Excel − pagos na DB ─────────────────────────────────
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

  // ── Quota extra (elevadores): a_receber = Excel − pagos na DB ───────────────
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

  // ── Incêndio: a_receber = Excel − pagos na DB ───────────────────────────────
  const incPagosRows = await db
    .select({ numero: schema.fracoes.numero })
    .from(schema.quotas)
    .leftJoin(schema.fracoes, eq(schema.quotas.fracaoId, schema.fracoes.id))
    .where(and(
      eq(schema.quotas.tipo, "extra"),
      eq(schema.quotas.quotaTipoId, INCENDIO_TIPO_ID),
      eq(schema.quotas.pago, true),
    ));
  const incPagosNums = new Set(incPagosRows.map(r => r.numero).filter(Boolean));
  const incMorosos = INCENDIO_DEVEDORES_EXCEL.filter(d => !incPagosNums.has(d.fracao.numero));
  const aReceberInc = Math.round(incMorosos.reduce((s, d) => s + d.total, 0) * 100) / 100;
  await upsertSaldo("a_receber_incendio", aReceberInc);

  // ── Fundo reserva: atraso calculado da DB ───────────────────────────────────
  // O fundo de reserva está no campo `fundoReserva` (real) das quotas tipo="condominio",
  // não em linhas separadas com tipo="fundo_reserva". A query anterior (LIKE 'fundo%') nunca retornava nada.
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
    const totalFracoes = fracaoCountRows[0]?.totalFracoes ?? 0;

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
