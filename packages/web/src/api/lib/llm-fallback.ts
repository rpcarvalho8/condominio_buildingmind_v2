/**
 * ╔══════════════════════════════════════════════════════════════════╗
 * ║           LLM FALLBACK — Camada 2 de Identificação              ║
 * ║  Activada quando identifyByMultiMatch() devolve score < 55.     ║
 * ║  Usa Groq (primário) com fallback para OpenRouter.              ║
 * ╚══════════════════════════════════════════════════════════════════╝
 *
 * Contrato de output (JSON estrito):
 *   { "idFracao": "AB", "confidence": 87, "motivo": "..." }
 *
 * Se a confiança for >= LLM_LEARN_THRESHOLD, o chamador deve invocar
 * learnIBAN() para ancorar o IBAN e evitar nova chamada ao LLM no mês seguinte.
 */

import { MATRIZ_PROPRIEDADES, type FracaoIdentidade } from "./identity-matrix";

// ─── Config ───────────────────────────────────────────────────────────────────

const GROQ_API_KEY     = process.env.GROQ_API_KEY ?? "";
const OPENROUTER_KEY   = process.env.OPENROUTER_API_KEY ?? "";

/** Modelo Groq — rápido e gratuito para este volume */
const GROQ_MODEL       = "llama-3.3-70b-versatile";
/** Modelo OpenRouter fallback */
const OPENROUTER_MODEL = "meta-llama/llama-3.3-70b-instruct:free";

/** Threshold acima do qual se considera confiança suficiente para auto-learning */
export const LLM_LEARN_THRESHOLD = 80;

/** Timeout por chamada LLM (ms) */
const LLM_TIMEOUT_MS = 12_000;

// ─── Tipos públicos ───────────────────────────────────────────────────────────

export interface LLMFallbackInput {
  /** Texto bruto do descritivo da transação bancária */
  descricao: string;
  /** Montante da transferência (€, positivo) */
  amount: number;
  /** Nome do devedor/remetente, se disponível */
  debtorName?: string;
  /** IBAN do remetente, se disponível */
  ibanSender?: string;
}

export type RubricaExtra = "CONDOMINIO" | "OBRAS" | "MOTOR" | "INCENDIO" | "ELEVADORES";

export interface LLMFallbackResult {
  /** ID da fração identificada (ex: "AB") ou null se não identificada */
  idFracao: string | null;
  /** Confiança 0–100 */
  confidence: number;
  /** Fração completa da MATRIZ (null se idFracao for null) */
  fracao: FracaoIdentidade | null;
  /** Motivo textual devolvido pelo LLM */
  motivo: string;
  /** Qual provider respondeu: "groq" | "openrouter" | "none" */
  provider: "groq" | "openrouter" | "none";
  /** Rubrica financeira identificada pelo LLM */
  rubrica: RubricaExtra;
}

// ─── System Prompt ────────────────────────────────────────────────────────────

function buildSystemPrompt(fracoes: FracaoIdentidade[]): string {
  const lista = fracoes
    .map(f => `  - idFracao: "${f.idFracao}" | descricao: "${f.descricao}" | proprietario: "${f.nomeProprietario}" | entrada: "${f.entrada}"`)
    .join("\n");

  return `És um sistema especialista em reconhecimento de transferências bancárias de condomínios em Portugal.

Tens acesso à lista completa de frações do Condomínio 7663:
${lista}

A tua tarefa é identificar a fração a que pertence uma determinada transferência bancária.

REGRAS OBRIGATÓRIAS:
1. Responde EXCLUSIVAMENTE com um JSON válido, sem markdown, sem texto extra, sem explicações fora do JSON.
2. O JSON deve ter exatamente esta estrutura:
   {"idFracao":"<ID ou null>","confidence":<0-100>,"motivo":"<razão curta em português>","rubrica":"<RUBRICA>"}
3. "idFracao" deve ser um dos IDs da lista acima (ex: "J", "AB", "AC") ou null se não conseguires identificar.
4. "confidence" é um inteiro de 0 a 100 que representa a tua certeza.
5. Usa 0 para "impossível determinar" e 100 para "certeza absoluta".
6. Se o nome do proprietário aparecer (mesmo parcialmente ou com erros ortográficos), aumenta a confiança.
7. Se a descrição contiver referências à fração (ex: "2B", "3 ESQ", "GAR 36"), aumenta a confiança.
8. Nunca inventes uma fração que não existe na lista.
9. "rubrica" OBRIGATÓRIO — classifica a natureza do pagamento com UM destes valores exatos:
   - "CONDOMINIO": quota mensal de condomínio (manutenção corrente)
   - "OBRAS": cota extra para fundo de obras / obras extraordinárias
   - "MOTOR": cota extra motor/portão de garagem
   - "INCENDIO": cota extra seguro de incêndio
   - "ELEVADORES": cota extra elevadores / INDAQUA
   Em caso de dúvida, usa "CONDOMINIO".`;
}

function buildUserPrompt(input: LLMFallbackInput): string {
  const linhas = [
    `Descrição da transferência: "${input.descricao}"`,
    `Montante: ${input.amount.toFixed(2)} €`,
  ];
  if (input.debtorName) linhas.push(`Nome do remetente: "${input.debtorName}"`);
  if (input.ibanSender) linhas.push(`IBAN do remetente: "${input.ibanSender}"`);
  linhas.push(`\nIdentifica a fração. Responde apenas com o JSON.`);
  return linhas.join("\n");
}

// ─── Parsers de resposta ──────────────────────────────────────────────────────

const RUBRICAS_VALIDAS: RubricaExtra[] = ["CONDOMINIO", "OBRAS", "MOTOR", "INCENDIO", "ELEVADORES"];

interface RawLLMResponse {
  idFracao: string | null;
  confidence: number;
  motivo: string;
  rubrica: RubricaExtra;
}

function parseResponse(raw: string): RawLLMResponse | null {
  try {
    // Extrair JSON mesmo que venha dentro de markdown code fences
    const match = raw.match(/\{[\s\S]*\}/);
    if (!match) return null;
    const obj = JSON.parse(match[0]);
    if (typeof obj.confidence !== "number") return null;
    const rubricaRaw = typeof obj.rubrica === "string" ? obj.rubrica.trim().toUpperCase() : "CONDOMINIO";
    const rubrica: RubricaExtra = RUBRICAS_VALIDAS.includes(rubricaRaw as RubricaExtra)
      ? (rubricaRaw as RubricaExtra)
      : "CONDOMINIO";
    return {
      idFracao:   typeof obj.idFracao === "string" ? obj.idFracao.trim().toUpperCase() : null,
      confidence: Math.min(100, Math.max(0, Math.round(obj.confidence))),
      motivo:     typeof obj.motivo === "string" ? obj.motivo : "",
      rubrica,
    };
  } catch {
    return null;
  }
}

// ─── Chamadas HTTP aos providers ──────────────────────────────────────────────

async function callGroq(
  systemPrompt: string,
  userPrompt: string
): Promise<string | null> {
  if (!GROQ_API_KEY) return null;
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), LLM_TIMEOUT_MS);
    const res = await fetch("https://api.groq.com/openai/v1/chat/completions", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${GROQ_API_KEY}`,
      },
      body: JSON.stringify({
        model: GROQ_MODEL,
        temperature: 0,
        max_tokens: 120,
        response_format: { type: "json_object" },
        messages: [
          { role: "system",  content: systemPrompt },
          { role: "user",    content: userPrompt   },
        ],
      }),
      signal: controller.signal,
    });
    clearTimeout(timeout);
    if (!res.ok) {
      console.warn(`[llm-fallback] Groq HTTP ${res.status}: ${await res.text()}`);
      return null;
    }
    const data = await res.json() as { choices?: Array<{ message?: { content?: string } }> };
    return data.choices?.[0]?.message?.content ?? null;
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    console.warn(`[llm-fallback] Groq error: ${msg}`);
    return null;
  }
}

async function callOpenRouter(
  systemPrompt: string,
  userPrompt: string
): Promise<string | null> {
  if (!OPENROUTER_KEY) return null;
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), LLM_TIMEOUT_MS);
    const res = await fetch("https://openrouter.ai/api/v1/chat/completions", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${OPENROUTER_KEY}`,
        "HTTP-Referer": "https://buildingmind.pt",
        "X-Title": "BuildingMind Condominium AI",
      },
      body: JSON.stringify({
        model: OPENROUTER_MODEL,
        temperature: 0,
        max_tokens: 120,
        messages: [
          { role: "system",  content: systemPrompt },
          { role: "user",    content: userPrompt   },
        ],
      }),
      signal: controller.signal,
    });
    clearTimeout(timeout);
    if (!res.ok) {
      console.warn(`[llm-fallback] OpenRouter HTTP ${res.status}: ${await res.text()}`);
      return null;
    }
    const data = await res.json() as { choices?: Array<{ message?: { content?: string } }> };
    return data.choices?.[0]?.message?.content ?? null;
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    console.warn(`[llm-fallback] OpenRouter error: ${msg}`);
    return null;
  }
}

// ─── Ponto de entrada público ─────────────────────────────────────────────────

/**
 * Tenta identificar a fração via LLM (Groq → OpenRouter).
 * Retorna sempre um resultado estruturado — nunca lança exceção.
 *
 * @param input  Dados da transação bancária não identificada pelo motor matricial
 * @returns      LLMFallbackResult com idFracao, confidence, fracao e provider
 */
export async function llmIdentifyFracao(
  input: LLMFallbackInput
): Promise<LLMFallbackResult> {
  const NULL_RESULT: LLMFallbackResult = {
    idFracao:   null,
    confidence: 0,
    fracao:     null,
    motivo:     "LLM não disponível ou não identificou",
    provider:   "none",
    rubrica:    "CONDOMINIO",
  };

  // Se não há chaves configuradas, não tentar
  if (!GROQ_API_KEY && !OPENROUTER_KEY) {
    console.warn("[llm-fallback] Nenhuma chave API configurada (GROQ_API_KEY / OPENROUTER_API_KEY)");
    return NULL_RESULT;
  }

  const systemPrompt = buildSystemPrompt(MATRIZ_PROPRIEDADES);
  const userPrompt   = buildUserPrompt(input);

  // Tentativa 1: Groq
  let raw: string | null = null;
  let provider: "groq" | "openrouter" | "none" = "none";

  raw = await callGroq(systemPrompt, userPrompt);
  if (raw) {
    provider = "groq";
  } else {
    // Tentativa 2: OpenRouter
    raw = await callOpenRouter(systemPrompt, userPrompt);
    if (raw) provider = "openrouter";
  }

  if (!raw) return { ...NULL_RESULT, provider: "none" };

  const parsed = parseResponse(raw);
  if (!parsed) {
    console.warn(`[llm-fallback] Resposta não parseable: ${raw.slice(0, 200)}`);
    return { ...NULL_RESULT, provider };
  }

  // Validar que o idFracao existe na MATRIZ
  const fracao = parsed.idFracao
    ? (MATRIZ_PROPRIEDADES.find(f => f.idFracao.toUpperCase() === parsed.idFracao) ?? null)
    : null;

  if (parsed.idFracao && !fracao) {
    // LLM inventou uma fração — rejeitar
    console.warn(`[llm-fallback] LLM devolveu fração desconhecida: "${parsed.idFracao}" — rejeitado`);
    return { ...NULL_RESULT, provider };
  }

  console.log(
    `[llm-fallback] ${provider} → fração ${parsed.idFracao ?? "null"} | ` +
    `confiança ${parsed.confidence}% | motivo: ${parsed.motivo}`
  );

  return {
    idFracao:   fracao ? fracao.idFracao : null,
    confidence: parsed.confidence,
    fracao,
    motivo:     parsed.motivo,
    provider,
    rubrica:    parsed.rubrica,
  };
}
