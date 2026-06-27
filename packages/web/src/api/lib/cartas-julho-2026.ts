/**
 * ╔══════════════════════════════════════════════════════════════════╗
 * ║        CARTAS DE COBRANÇA — JULHO 2026                          ║
 * ║  Fonte de verdade para dívidas individuais por fração.          ║
 * ║  Extraído das cartas de cobrança emitidas em junho/julho 2026.  ║
 * ║  Substituí cálculo teórico permilagem × orçamento.              ║
 * ╚══════════════════════════════════════════════════════════════════╝
 *
 * REGRA DE AMORTIZAÇÃO (cascade):
 *   Regra A — descritor explícito: débito directo à rubrica nomeada
 *   Regra B — sem descritor:
 *     1.º Quota Condomínio Geral
 *     2.º Fundo de Reserva
 *     3.º Cotas Extras (Obras → Elevadores → Motor → Incêndio)
 *
 * Frações sem carta emitida (julho) = em dia em todas as rubricas:
 *   A, B, C, D, H, I, K, W
 * Fração L: carta de junho já emitida (2478.69€) — incluída com flag isCartaJunho=true
 */

export interface CartaFracao {
  /** Número/letra da fração (ex: "AA", "G", "L") */
  fracao: string;
  /** Nome do proprietário conforme carta */
  proprietario: string;
  /** Quota mensal Condomínio Geral (julho 2026) */
  quotaJulho: number;
  /** Fundo de Reserva (julho 2026) */
  fundoReservaJulho: number;
  /** Dívida Obras (quota extra) — acumulado até carta */
  obras: number;
  /** Dívida Incêndio (quota extra) — acumulado até carta */
  incendio: number;
  /** Dívida Motor/Portão (quota extra) — acumulado até carta */
  motor: number;
  /** Quotas de condomínio em atraso (meses anteriores) */
  quotasCC_atraso: number;
  /** Multas aplicadas */
  multas: number;
  /** TOTAL da carta emitida (soma de todas as rubricas) */
  totalCarta: number;
  /** True se esta é a carta de junho (fração L) e não julho */
  isCartaJunho?: boolean;
}

/**
 * CARTAS_JULHO_2026
 * Tabela completa extraída das cartas de cobrança emitidas.
 * Frações não listadas estão em dia (sem carta emitida).
 */
export const CARTAS_JULHO_2026: CartaFracao[] = [
  // ── Fracções sem dívida extra — apenas quota corrente julho ──────────────
  {
    fracao: "AA",
    proprietario: "Olívia Lima",
    quotaJulho: 38.02,
    fundoReservaJulho: 3.80,
    obras: 0, incendio: 0, motor: 0, quotasCC_atraso: 0, multas: 0,
    totalCarta: 41.82,
  },
  {
    fracao: "AB",
    proprietario: "Ilídio Marinho",
    quotaJulho: 37.95,
    fundoReservaJulho: 3.80,
    obras: 0, incendio: 0, motor: 0, quotasCC_atraso: 0, multas: 0,
    totalCarta: 41.75,
  },
  {
    fracao: "AE",
    proprietario: "Germano Machado",
    quotaJulho: 40.12,
    fundoReservaJulho: 4.01,
    obras: 0, incendio: 0, motor: 0, quotasCC_atraso: 0, multas: 0,
    totalCarta: 44.13,
  },
  {
    fracao: "AF",
    proprietario: "Rui Torres",
    quotaJulho: 38.18,
    fundoReservaJulho: 3.82,
    obras: 0, incendio: 0, motor: 0, quotasCC_atraso: 0, multas: 0,
    totalCarta: 42.00,
  },
  {
    fracao: "AH",
    proprietario: "Mª Madalena Ramos",
    quotaJulho: 44.41,
    fundoReservaJulho: 4.44,
    obras: 0, incendio: 0, motor: 0, quotasCC_atraso: 0, multas: 0,
    totalCarta: 48.85,
  },
  {
    fracao: "AI",
    proprietario: "Rui Carvalho",
    quotaJulho: 38.87,
    fundoReservaJulho: 3.89,
    obras: 0, incendio: 0, motor: 0, quotasCC_atraso: 0, multas: 0,
    totalCarta: 42.76,
  },
  {
    fracao: "AJ",
    proprietario: "Mariana Reis",
    quotaJulho: 37.49,
    fundoReservaJulho: 3.75,
    obras: 0, incendio: 0, motor: 0, quotasCC_atraso: 0, multas: 0,
    totalCarta: 41.24,
  },
  {
    fracao: "J",
    proprietario: "Mª Conceição Moreira",
    quotaJulho: 42.07,
    fundoReservaJulho: 4.21,
    obras: 0, incendio: 0, motor: 0, quotasCC_atraso: 0, multas: 0,
    totalCarta: 46.28,
  },
  {
    fracao: "O",
    proprietario: "Pedro Santos",
    quotaJulho: 45.28,
    fundoReservaJulho: 4.53,
    obras: 0, incendio: 0, motor: 0, quotasCC_atraso: 0, multas: 0,
    totalCarta: 49.81,
  },
  {
    fracao: "P",
    proprietario: "Nuno Ribeiro",
    quotaJulho: 46.95,
    fundoReservaJulho: 4.70,
    obras: 0, incendio: 0, motor: 0, quotasCC_atraso: 0, multas: 0,
    totalCarta: 51.65,
  },
  {
    fracao: "Q",
    proprietario: "João Barros",
    quotaJulho: 40.27,
    fundoReservaJulho: 4.03,
    obras: 0, incendio: 0, motor: 0, quotasCC_atraso: 0, multas: 0,
    totalCarta: 44.30,
  },
  {
    fracao: "R",
    proprietario: "Vanessa Silva",
    quotaJulho: 61.54,
    fundoReservaJulho: 6.15,
    obras: 0, incendio: 0, motor: 0, quotasCC_atraso: 0, multas: 0,
    totalCarta: 67.69,
  },
  {
    fracao: "S",
    proprietario: "Célia Sá",
    quotaJulho: 35.07,
    fundoReservaJulho: 3.51,
    obras: 0, incendio: 0, motor: 0, quotasCC_atraso: 0, multas: 0,
    totalCarta: 38.58,
  },
  {
    fracao: "T",
    proprietario: "Susana Silva",
    quotaJulho: 41.75,
    fundoReservaJulho: 4.17,
    obras: 0, incendio: 0, motor: 0, quotasCC_atraso: 0, multas: 0,
    totalCarta: 45.92,
  },
  {
    fracao: "U",
    proprietario: "Catarina Silva",
    quotaJulho: 62.04,
    fundoReservaJulho: 6.20,
    obras: 0, incendio: 0, motor: 0, quotasCC_atraso: 0, multas: 0,
    totalCarta: 68.24,
  },
  {
    fracao: "V",
    proprietario: "Sérgio Monteiro",
    quotaJulho: 36.92,
    fundoReservaJulho: 3.69,
    obras: 0, incendio: 0, motor: 0, quotasCC_atraso: 0, multas: 0,
    totalCarta: 40.61,
  },
  {
    fracao: "Z",
    proprietario: "Ana Costa",
    quotaJulho: 59.80,
    fundoReservaJulho: 5.98,
    obras: 0, incendio: 0, motor: 0, quotasCC_atraso: 0, multas: 0,
    totalCarta: 65.78,
  },
  // ── Frações E+F — Tiago Correia (carta conjunta, split proporcional) ─────
  // Total E+F = 4.19€ (E=1.83+0.18=2.01; F=1.98+0.20=2.18; soma=4.19)
  {
    fracao: "E",
    proprietario: "Tiago Correia",
    quotaJulho: 1.83,
    fundoReservaJulho: 0.18,
    obras: 0, incendio: 0, motor: 0, quotasCC_atraso: 0, multas: 0,
    totalCarta: 2.01,
  },
  {
    fracao: "F",
    proprietario: "Tiago Correia",
    quotaJulho: 1.98,
    fundoReservaJulho: 0.20,
    obras: 0, incendio: 0, motor: 0, quotasCC_atraso: 0, multas: 0,
    totalCarta: 2.18,
  },
  // ── Fracções com dívida de obras ─────────────────────────────────────────
  {
    fracao: "AC",
    proprietario: "Mª Fátima Ascenção",
    quotaJulho: 11.02,
    fundoReservaJulho: 1.10,
    obras: 607.35,
    incendio: 0, motor: 0, quotasCC_atraso: 0, multas: 0,
    totalCarta: 619.47,
  },
  {
    fracao: "AD",
    proprietario: "Escutoglamour",
    quotaJulho: 11.37,
    fundoReservaJulho: 1.14,
    obras: 629.51,
    incendio: 49.40,
    motor: 0, quotasCC_atraso: 0, multas: 0,
    totalCarta: 691.42,
  },
  {
    fracao: "M",
    proprietario: "Jannara Santos",
    quotaJulho: 42.83,
    fundoReservaJulho: 4.28,
    obras: 108.85,
    incendio: 0, motor: 0, quotasCC_atraso: 0, multas: 0,
    totalCarta: 155.96,
  },
  {
    fracao: "N",
    proprietario: "Filipe Teixeira",
    quotaJulho: 42.09,
    fundoReservaJulho: 4.21,
    obras: 178.71,
    incendio: 0,
    motor: 33.78,
    quotasCC_atraso: 0, multas: 0,
    totalCarta: 258.79,
  },
  // ── AG — atraso CC + motor + multas ──────────────────────────────────────
  // Quotas CC atraso: 76.80€ (2 meses) + 7.68€ fundo = 84.48€ → arredondado 84.48
  {
    fracao: "AG",
    proprietario: "João Amorim Dias",
    quotaJulho: 38.40,
    fundoReservaJulho: 3.84,
    obras: 284.27,
    incendio: 0,
    motor: 25.04,
    quotasCC_atraso: 84.48,   // 76.80 quota + 7.68 fundo (2 meses em atraso)
    multas: 4.22,
    totalCarta: 440.25,
  },
  // ── X — atraso CC + motor + multas ───────────────────────────────────────
  // Quotas CC atraso: 84.84€ (Mai+Jun) → documentado na carta
  {
    fracao: "X",
    proprietario: "Alexandre Maia",
    quotaJulho: 42.42,
    fundoReservaJulho: 4.24,
    obras: 278.30,
    incendio: 0,
    motor: 27.67,
    quotasCC_atraso: 84.84,   // Mai+Jun em atraso
    multas: 4.67,
    totalCarta: 450.62,
  },
  // ── G — maior devedor — obras + incêndio + motor + atraso CC + multas ───
  // Quotas CC atraso: 95.86€ (Dez25–Jun26, 7 meses)
  {
    fracao: "G",
    proprietario: "Marma Concept",
    quotaJulho: 13.98,
    fundoReservaJulho: 1.40,
    obras: 1160.63,
    incendio: 60.72,
    motor: 16.24,
    quotasCC_atraso: 95.86,   // Dez25–Jun26 (7 meses)
    multas: 9.78,
    totalCarta: 1388.99,
  },
  // ── L — carta de JUNHO 2026 (não julho) ──────────────────────────────────
  // Rubrica: obras 2110.97 + portão 29.53 + quota extra 6×41.76 + FR 73.06 + multas
  // Total carta junho: 2478.69€
  // NOTA: quotaJulho e fundoReservaJulho = 0 (carta de junho, não julho)
  {
    fracao: "L",
    proprietario: "João Coutinho",
    quotaJulho: 0,
    fundoReservaJulho: 0,
    obras: 2110.97,
    incendio: 0,
    motor: 29.53,             // portão garagem
    // quota extra (6 × 41.76 = 250.56) + FR junho (73.06) incluídos no total
    quotasCC_atraso: 0,
    multas: 0,
    totalCarta: 2478.69,
    isCartaJunho: true,
  },
];

/**
 * Lookup por número de fração (case-insensitive).
 * Retorna undefined se não emitida (fração em dia).
 */
export function getCartaFracao(fracao: string): CartaFracao | undefined {
  const upper = fracao.toUpperCase().trim();
  return CARTAS_JULHO_2026.find(c => c.fracao.toUpperCase() === upper);
}

/**
 * Total geral "Por Receber" de todas as cartas emitidas.
 * Soma os totalCarta de todas as frações com carta emitida.
 */
export function totalGeralCartas(): number {
  return Math.round(
    CARTAS_JULHO_2026.reduce((s, c) => s + c.totalCarta, 0) * 100
  ) / 100;
}

/**
 * Constrói um DividaFracao a partir dos dados da carta para uma fração.
 * Usado como fonte de verdade em substituição do cálculo permilagem × orçamento.
 */
export function dividaDaCartaFracao(fracao: string): {
  obras: number;
  motor: number;
  incendio: number;
  elevadores: number;
  quotasCC_atraso: number;
  multas: number;
  totalCarta: number;
} {
  const carta = getCartaFracao(fracao);
  if (!carta) {
    return { obras: 0, motor: 0, incendio: 0, elevadores: 0, quotasCC_atraso: 0, multas: 0, totalCarta: 0 };
  }
  return {
    obras:           carta.obras,
    motor:           carta.motor,
    incendio:        carta.incendio,
    elevadores:      0, // elevadores embutidos em motor/carta (INDAQUA separado)
    quotasCC_atraso: carta.quotasCC_atraso,
    multas:          carta.multas,
    totalCarta:      carta.totalCarta,
  };
}

type MorosoEntry = { fracao: string; proprietario: string; total: number };

/**
 * Lista de frações com cartas emitidas agrupadas por rubrica morosa.
 * Conveniente para alimentar os morosos de cada secção do dashboard.
 */
export function morososPorRubrica(): {
  obras:         MorosoEntry[];
  incendio:      MorosoEntry[];
  motor:         MorosoEntry[];
  contaCorrente: MorosoEntry[];
} {
  const obras:    MorosoEntry[] = [];
  const incendio: MorosoEntry[] = [];
  const motor:    MorosoEntry[] = [];
  const cc:       MorosoEntry[] = [];

  for (const c of CARTAS_JULHO_2026) {
    if (c.obras > 0)           obras.push({ fracao: c.fracao, proprietario: c.proprietario, total: c.obras });
    if (c.incendio > 0)        incendio.push({ fracao: c.fracao, proprietario: c.proprietario, total: c.incendio });
    if (c.motor > 0)           motor.push({ fracao: c.fracao, proprietario: c.proprietario, total: c.motor });
    if (c.quotasCC_atraso > 0) cc.push({ fracao: c.fracao, proprietario: c.proprietario, total: c.quotasCC_atraso });
  }

  const byTotalDesc = (a: MorosoEntry, b: MorosoEntry) => b.total - a.total;
  obras.sort(byTotalDesc);
  incendio.sort(byTotalDesc);
  motor.sort(byTotalDesc);
  cc.sort(byTotalDesc);

  return { obras, incendio, motor, contaCorrente: cc };
}
