/**
 * Avisos de Débito (Notas de Cobrança)
 * Gera PDFs de aviso para frações com quotas por pagar.
 * Formato igual ao 2026.05_AI.pdf
 *
 * Routes:
 *   POST /api/avisos/gerar    { mes, ano, fracaoId? } → gera avisos
 *   GET  /api/avisos          → lista avisos
 *   GET  /api/avisos/pdf/:filename
 *   POST /api/avisos/:id/email → reenviar email
 */

import { Hono } from "hono";
import { requireAdmin } from "../middleware/auth";
import { db } from "../database";
import * as schema from "../database/schema";
import { eq, and } from "drizzle-orm";
import fs from "node:fs";
import path from "node:path";
import { exec } from "node:child_process";
import puppeteer from "puppeteer-core";

// ─── Devedores Extra (fonte: Excel) — espelha dashboard.ts ───────────────────
// Estes valores não estão na DB como quotas não pagas; derivamos Excel − pago na DB.

const PORTAO_TIPO_ID   = "06d6dd01-04ac-4ea3-8359-ec705f78de7c";
const ELEV_TIPO_ID     = "4696eef9-bd1f-46ff-a368-47cfd455eeca";
const INCENDIO_TIPO_ID = "dd16bd50-a2ab-4387-9d70-95822b1a61d7";

const QUOTA_EXTRA_DEVEDORES_EXCEL: { numero: string; total: number }[] = [
  { numero: "L",  total: 323.24 },
  { numero: "R",  total: 98.77 },
  { numero: "U",  total: 99.57 },
  { numero: "P",  total: 75.36 },
  { numero: "O",  total: 72.69 },
  { numero: "AH", total: 42.32 },
  { numero: "J",  total: 67.53 },
  { numero: "M",  total: 68.75 },
  { numero: "T",  total: 67.01 },
  { numero: "AI", total: 37.05 },
  { numero: "AG", total: 61.63 },
  { numero: "AF", total: 61.28 },
  { numero: "AA", total: 61.02 },
  { numero: "AB", total: 60.92 },
  { numero: "AJ", total: 60.17 },
  { numero: "AE", total: 64.40 },
  { numero: "Z",  total: 95.99 },
  { numero: "X",  total: 68.09 },
  { numero: "Q",  total: 64.64 },
  { numero: "S",  total: 56.29 },
  { numero: "V",  total: 59.26 },
  { numero: "N",  total: 33.78 },
  { numero: "G",  total: 23.87 },
];

const PORTAO_DEVEDORES_EXCEL: { numero: string; total: number }[] = [
  { numero: "U",  total: 40.46 },
  { numero: "R",  total: 40.14 },
  { numero: "Z",  total: 39.00 },
  { numero: "P",  total: 30.62 },
  { numero: "L",  total: 29.53 },
  { numero: "O",  total: 29.53 },
  { numero: "M",  total: 27.94 },
  { numero: "X",  total: 27.67 },
  { numero: "N",  total: 27.46 },
  { numero: "J",  total: 27.44 },
  { numero: "T",  total: 27.23 },
  { numero: "Q",  total: 26.27 },
  { numero: "AE", total: 26.17 },
  { numero: "AG", total: 25.04 },
  { numero: "AF", total: 24.90 },
  { numero: "AA", total: 24.80 },
  { numero: "AB", total: 24.75 },
  { numero: "AJ", total: 24.45 },
  { numero: "V",  total: 24.08 },
  { numero: "S",  total: 22.87 },
  { numero: "G",  total: 16.24 },
];

const INCENDIO_DEVEDORES_EXCEL: { numero: string; total: number }[] = [
  { numero: "G",  total: 60.72 },
  { numero: "AC", total: 47.87 },
  { numero: "AD", total: 49.40 },
];

const FUNDO_RESERVA_DEVEDORES_EXCEL: { numero: string; total: number }[] = [
  { numero: "L",  total: 2.79 },
  { numero: "G",  total: 2.64 },
  { numero: "N",  total: 4.37 },
];

// Retorna os devedores do Excel que ainda não pagaram na DB (para um dado quotaTipoId)
async function getExtraDevedoresPorPagar(
  excelList: { numero: string; total: number }[],
  quotaTipoId: string
): Promise<Map<string, number>> {
  const pagosRows = await db.select({ numero: schema.fracoes.numero })
    .from(schema.quotas)
    .innerJoin(schema.fracoes, eq(schema.quotas.fracaoId, schema.fracoes.id))
    .where(
      and(
        eq(schema.quotas.pago, true),
        eq(schema.quotas.tipo, "extra"),
        eq(schema.quotas.quotaTipoId, quotaTipoId),
      )
    );
  const pagosNums = new Set(pagosRows.map(r => r.numero).filter(Boolean) as string[]);
  const result = new Map<string, number>();
  for (const d of excelList) {
    if (!pagosNums.has(d.numero)) result.set(d.numero, d.total);
  }
  return result;
}

// ─── Config ──────────────────────────────────────────────────────────────────
const CONDOMINIO = {
  nome: "Condomínio Urbanização da Fonte",
  morada: "Rua Poeta António Boto, 21, 37 e 39",
  localidade: "4785-390 Trofa",
  nif: "901932027",
  iban: "PT50 0018 0003 4978 3806 0206 5",
};

const MESES = [
  "", "Janeiro", "Fevereiro", "Março", "Abril", "Maio", "Junho",
  "Julho", "Agosto", "Setembro", "Outubro", "Novembro", "Dezembro",
];

const PDF_DIR = path.join(process.cwd(), "data", "avisos");
fs.mkdirSync(PDF_DIR, { recursive: true });

const LOGO_PATH = path.join(process.cwd(), "public", "logo_condominio.png");
let LOGO_B64 = "";
try { LOGO_B64 = fs.readFileSync(LOGO_PATH).toString("base64"); } catch {}

// Stored avisos list (in-memory, simple log)
interface AvisoRecord {
  id: string;
  fracaoId: string;
  fracaoNumero: string;
  proprietarioNome: string;
  mes: number;
  ano: number;
  total: number;
  filename: string;
  pdfUrl: string;
  emailEnviado: boolean;
  geradoEm: string;
}
const avisosLog: AvisoRecord[] = [];

function fmt(v: number): string {
  return v.toFixed(2).replace(".", ",");
}
function formatDate(d: Date | null | undefined): string {
  if (!d) return "—";
  return d.toLocaleDateString("pt-PT", { day: "2-digit", month: "2-digit", year: "numeric" });
}

// ─── HTML Template (igual ao aviso PDF original) ─────────────────────────────
function buildAvisoHtml(data: {
  dataEmissao: string;
  fracao: { numero: string };
  proprietario: { nome: string; morada: string; nif?: string };
  linhas: {
    fracao: string; descritivo: string;
    emissao: string; vencimento: string; valor: number;
  }[];
  total: number;
}): string {
  const logoSrc = LOGO_B64 ? `data:image/png;base64,${LOGO_B64}` : "";

  const linhasHtml = data.linhas.map(l => `
    <tr>
      <td>${l.fracao}</td>
      <td>${l.descritivo}</td>
      <td>${l.emissao}</td>
      <td>${l.vencimento}</td>
      <td class="right">${fmt(l.valor)}</td>
    </tr>
  `).join("");

  return `<!DOCTYPE html>
<html lang="pt">
<head>
<meta charset="UTF-8">
<style>
  * { margin: 0; padding: 0; box-sizing: border-box; }
  body {
    font-family: "Calibri", "Arial", sans-serif;
    font-size: 11pt;
    color: #1a1a1a;
    background: white;
    padding: 28mm 20mm 20mm 20mm;
    position: relative;
  }
  .corner-tl {
    position: fixed; top: 0; left: 0;
    width: 0; height: 0; border-style: solid;
    border-width: 55px 55px 0 0;
    border-color: #b5a99a transparent transparent transparent;
    opacity: 0.55;
  }
  .corner-br {
    position: fixed; bottom: 0; right: 0;
    width: 0; height: 0; border-style: solid;
    border-width: 0 0 55px 55px;
    border-color: transparent transparent #b5a99a transparent;
    opacity: 0.55;
  }
  .sidebar-line {
    position: fixed; top: 0; right: 18mm;
    width: 1.5px; height: 100%;
    background: #b5a99a; opacity: 0.4;
  }
  .header { display: flex; justify-content: flex-end; margin-bottom: 8px; }
  .logo-img { width: 130px; opacity: 0.9; }
  .aviso-info { text-align: right; margin-bottom: 20px; }
  .aviso-info .titulo { font-size: 14pt; font-weight: bold; color: #3a3128; }
  .aviso-info .nif-data { font-size: 10pt; color: #555; margin-top: 4px; }
  .partes {
    display: flex; justify-content: space-between;
    margin-bottom: 24px;
  }
  .condominio { font-size: 10.5pt; }
  .condominio strong { font-size: 11pt; display: block; margin-bottom: 2px; }
  .destinatario { text-align: left; font-size: 10.5pt; max-width: 55%; }
  .destinatario .label { font-style: italic; color: #555; margin-bottom: 2px; font-size: 9.5pt; }
  .nif-row { margin-bottom: 18px; font-size: 10.5pt; }
  .intro { margin-bottom: 10px; font-size: 10.5pt; }
  table {
    width: 100%;
    border-collapse: collapse;
    font-size: 10pt;
    margin-bottom: 6px;
  }
  thead tr { border-bottom: 1.5px solid #333; }
  thead th {
    padding: 5px 6px; font-weight: 600;
    text-align: left; font-size: 9.5pt;
    text-decoration: underline;
  }
  thead th.right, tbody td.right { text-align: right; }
  tbody tr { border-bottom: 0.5px solid #ddd; }
  tbody td { padding: 5px 6px; }
  .total-box {
    border-top: 1px solid #333;
    padding-top: 5px;
    margin-top: 2px;
    text-align: right;
    font-size: 11pt;
    font-weight: 700;
  }
  .iva-note {
    font-size: 8.5pt; color: #555;
    margin-top: 4px; margin-bottom: 16px;
  }
  .pagamento-info {
    font-size: 10pt;
    margin-bottom: 30px;
    line-height: 1.8;
  }
  .pagamento-info .label { font-weight: 600; }
  .nota {
    font-size: 9.5pt; color: #555;
    margin-bottom: 20px;
    font-style: italic;
  }
  .assinatura { margin-top: 16px; font-size: 10.5pt; }
  .assinatura .admin-label { margin-bottom: 28px; }
  .assinatura .linha { width: 200px; border-bottom: 1px solid #333; }
  .pagina {
    position: fixed; bottom: 10mm; right: 25mm;
    font-size: 9pt; color: #888;
  }
</style>
</head>
<body>
  <div class="corner-tl"></div>
  <div class="corner-br"></div>
  <div class="sidebar-line"></div>

  <!-- Logo -->
  <div class="header">
    ${logoSrc ? `<img class="logo-img" src="${logoSrc}" />` : ""}
  </div>

  <!-- Condomínio + destinatário -->
  <div class="partes">
    <div class="condominio">
      <strong>${CONDOMINIO.nome}</strong>
      ${CONDOMINIO.morada}<br>
      ${CONDOMINIO.localidade}<br>
      NIF: ${CONDOMINIO.nif}
    </div>
    <div class="destinatario">
      <div class="label">Exmo/a Sr/a.:</div>
      ${data.proprietario.nome}<br>
      ${data.proprietario.morada}
    </div>
  </div>

  <!-- Aviso info -->
  <div class="aviso-info">
    <div class="titulo">AVISO DE DÉBITO</div>
    <div class="nif-data">
      ${data.proprietario.nif ? `V/ NIF: ${data.proprietario.nif}<br>` : ""}
      Data: ${data.dataEmissao}
    </div>
  </div>

  <!-- Intro -->
  <div class="intro">Estimado/a Condómino/a,</div>
  <div class="intro">Solicitamos que proceda ao pagamento das seguintes quotas do Condomínio:</div>

  <!-- Tabela -->
  <table>
    <thead>
      <tr>
        <th style="width:8%">Fração</th>
        <th>Descritivo</th>
        <th style="width:14%">Emissão</th>
        <th style="width:14%">Vencimento</th>
        <th class="right" style="width:13%">Valor (€)</th>
      </tr>
    </thead>
    <tbody>
      ${linhasHtml}
    </tbody>
  </table>

  <div class="iva-note">Isento de I.V.A. nos termos do artigo 9.º do n.º 21 do CIVA</div>

  <div class="total-box">Total em débito: &nbsp;&nbsp; ${fmt(data.total)}</div>

  <br>

  <!-- Nota -->
  <div class="nota">
    Caso existam valores que já estejam pagos, queira por favor enviar-nos o respetivo comprovativo.
  </div>

  <!-- Meios de pagamento -->
  <div class="pagamento-info">
    <span class="label">Meios de pagamento:</span><br>
    a) transferência ou depósito bancário para o IBAN <strong>${CONDOMINIO.iban}</strong>.<br>
    b) envio de cheque traçado à ordem de ${CONDOMINIO.nome}.
  </div>

  <div style="font-size:10pt; margin-bottom:30px;">
    Mantemo-nos ao seu dispor e apresentamos os melhores cumprimentos.
  </div>

  <!-- Assinatura -->
  <div class="assinatura">
    <div class="admin-label">A Administração do Condomínio</div>
    <div class="linha"></div>
  </div>

  <div class="pagina">Página 1 / 1</div>
</body>
</html>`;
}

async function htmlToPdf(html: string, outPath: string): Promise<void> {
  const browser = await puppeteer.launch({
    executablePath: "/usr/bin/google-chrome-stable",
    args: ["--no-sandbox", "--disable-setuid-sandbox", "--disable-dev-shm-usage"],
    headless: true,
  });
  try {
    const page = await browser.newPage();
    await page.setContent(html, { waitUntil: "networkidle0" });
    await page.pdf({ path: outPath, format: "A4", printBackground: true });
  } finally {
    await browser.close();
  }
}

async function sendAvisoEmail(params: {
  para: string;
  nomeProprietario: string;
  fracaoNumero: string;
  mes: number;
  ano: number;
  total: number;
  pdfPath: string;
}): Promise<void> {
  const mesNome = MESES[params.mes];
  const subject = `Aviso de Débito — ${mesNome} ${params.ano} — Fração ${params.fracaoNumero}`;
  const html = `
    <p>Exmo/a Sr/a. ${params.nomeProprietario},</p>
    <p>Segue em anexo o <strong>Aviso de Débito</strong> referente à fração <strong>${params.fracaoNumero}</strong>,
    no valor total de <strong>€${params.total.toFixed(2).replace(".", ",")}</strong>.</p>
    <p>Solicitamos que proceda ao pagamento até à data indicada no documento.</p>
    <p>Meios de pagamento: transferência para o IBAN <strong>${CONDOMINIO.iban}</strong></p>
    <br>
    <p>Com os melhores cumprimentos,</p>
    <p><strong>A Administração do Condomínio</strong><br>${CONDOMINIO.nome}</p>
  `;
  const tmpHtml = path.join(PDF_DIR, `_email_${Date.now()}.html`);
  fs.writeFileSync(tmpHtml, html, "utf8");
  await new Promise<void>((resolve, reject) => {
    const cmd = `cat "${tmpHtml}" | send-email --to "${params.para}" --subject "${subject}" --html - --attach "${params.pdfPath}"`;
    exec(cmd, (err, _stdout, stderr) => {
      fs.unlinkSync(tmpHtml);
      if (err) reject(new Error(stderr || err.message));
      else resolve();
    });
  });
}

// ─── Core: gerar avisos ───────────────────────────────────────────────────────
export async function gerarAvisosCobranca(mes: number, ano: number, opts: {
  sendEmail?: boolean;
  fracaoId?: string;
} = {}): Promise<{
  gerados: number;
  ignorados: number;
  erros: string[];
  avisos: AvisoRecord[];
}> {
  const { sendEmail = false, fracaoId } = opts;
  const erros: string[] = [];
  let gerados = 0;
  let ignorados = 0;
  const avisos: AvisoRecord[] = [];

  // Get frações
  let fracoesList = await db.select().from(schema.fracoes).where(eq(schema.fracoes.ativo, true));
  if (fracaoId) fracoesList = fracoesList.filter(f => f.id === fracaoId);

  const dataEmissao = new Date(ano, mes - 1, 1);
  const dataVencimento = new Date(ano, mes - 1, 10);
  const dataEmissaoStr = `1 de ${MESES[mes]} de ${ano}`;

  // Pré-carregar devedores extra (Excel − pago na DB) para todo o loop
  const [elevDevedores, portaoDevedores, incendioDevedores] = await Promise.all([
    getExtraDevedoresPorPagar(QUOTA_EXTRA_DEVEDORES_EXCEL, ELEV_TIPO_ID),
    getExtraDevedoresPorPagar(PORTAO_DEVEDORES_EXCEL, PORTAO_TIPO_ID),
    getExtraDevedoresPorPagar(INCENDIO_DEVEDORES_EXCEL, INCENDIO_TIPO_ID),
  ]);
  // Fundo de reserva: usar lista estática (não tem quotaTipo na DB)
  const fundoDevedoresMap = new Map(FUNDO_RESERVA_DEVEDORES_EXCEL.map(d => [d.numero, d.total]));

  for (const fracao of fracoesList) {
    try {
      // Find ALL unpaid quotas for this fração (across all months/years)
      const quotasEmAtraso = await db.select().from(schema.quotas).where(
        and(
          eq(schema.quotas.fracaoId, fracao.id),
          eq(schema.quotas.pago, false)
        )
      );

      // Also include current month quotas (even if not yet in atraso)
      const quotasMesAtual = await db.select().from(schema.quotas).where(
        and(
          eq(schema.quotas.fracaoId, fracao.id),
          eq(schema.quotas.mes, mes),
          eq(schema.quotas.ano, ano)
        )
      );

      // Combine: all unpaid (any month) + current month not paid
      const todasQuotas = [
        ...quotasEmAtraso,
        ...quotasMesAtual.filter(q => !quotasEmAtraso.some(a => a.id === q.id)),
      ].filter(q => !q.pago);

      if (todasQuotas.length === 0) {
        ignorados++;
        continue;
      }

      // Build linhas
      const linhas: {
        fracao: string; descritivo: string;
        emissao: string; vencimento: string; valor: number;
      }[] = [];

      for (const q of todasQuotas.sort((a, b) => (a.ano * 12 + a.mes) - (b.ano * 12 + b.mes))) {
        const mesNomeQ = MESES[q.mes];
        const emissao = formatDate(new Date(q.ano, q.mes - 1, 1));
        const venc = formatDate(new Date(q.ano, q.mes - 1, 10));

        if (q.tipo === "condominio") {
          linhas.push({
            fracao: fracao.numero,
            descritivo: `${mesNomeQ} ${q.ano} - Orçamento`,
            emissao,
            vencimento: venc,
            valor: q.valor,
          });
          if (q.fundoReserva && q.fundoReserva > 0) {
            linhas.push({
              fracao: fracao.numero,
              descritivo: `${mesNomeQ} ${q.ano} - Fundo de Reserva`,
              emissao,
              vencimento: venc,
              valor: q.fundoReserva,
            });
          }
        } else if (q.tipo === "obras") {
          linhas.push({
            fracao: fracao.numero,
            descritivo: q.observacoes ?? `${mesNomeQ} ${q.ano} - Fundo de Obras`,
            emissao,
            vencimento: venc,
            valor: q.valor,
          });
        } else if (q.tipo === "extra") {
          linhas.push({
            fracao: fracao.numero,
            descritivo: q.observacoes ?? `Quota Extra`,
            emissao,
            vencimento: venc,
            valor: q.valor,
          });
        } else if (q.tipo === "fundo_reserva") {
          linhas.push({
            fracao: fracao.numero,
            descritivo: `${mesNomeQ} ${q.ano} - Fundo de Reserva`,
            emissao,
            vencimento: venc,
            valor: q.valor,
          });
        }
      }

      // ── Linhas extra (Excel − pago na DB) ──────────────────────────────────
      const dataExtraEmissao = "—";
      const dataExtraVenc    = "—";

      const elevDivida = elevDevedores.get(fracao.numero);
      if (elevDivida) {
        linhas.push({
          fracao: fracao.numero,
          descritivo: "Quota Extra — Elevadores (em dívida)",
          emissao: dataExtraEmissao,
          vencimento: dataExtraVenc,
          valor: elevDivida,
        });
      }

      const portaoDivida = portaoDevedores.get(fracao.numero);
      if (portaoDivida) {
        linhas.push({
          fracao: fracao.numero,
          descritivo: "Quota Extra — Portão Garagem (em dívida)",
          emissao: dataExtraEmissao,
          vencimento: dataExtraVenc,
          valor: portaoDivida,
        });
      }

      const incendioDivida = incendioDevedores.get(fracao.numero);
      if (incendioDivida) {
        linhas.push({
          fracao: fracao.numero,
          descritivo: "Incêndio — Obra (em dívida)",
          emissao: dataExtraEmissao,
          vencimento: dataExtraVenc,
          valor: incendioDivida,
        });
      }

      const fundoDivida = fundoDevedoresMap.get(fracao.numero);
      if (fundoDivida) {
        linhas.push({
          fracao: fracao.numero,
          descritivo: "Fundo de Reserva (em dívida)",
          emissao: dataExtraEmissao,
          vencimento: dataExtraVenc,
          valor: fundoDivida,
        });
      }

      if (linhas.length === 0) { ignorados++; continue; }

      const total = linhas.reduce((s, l) => s + l.valor, 0);

      // Build HTML & PDF
      const morada = fracao.proprietarioMorada ?? `Rua Poeta António Boto, Urbanização da Fonte, 4785-390 Trofa`;
      const html = buildAvisoHtml({
        dataEmissao: dataEmissaoStr,
        fracao,
        proprietario: {
          nome: fracao.proprietarioNome ?? "Proprietário",
          morada: `${morada}`,
          nif: fracao.proprietarioNif ?? undefined,
        },
        linhas,
        total,
      });

      const safeFracao = fracao.numero.replace(/[^a-zA-Z0-9]/g, "");
      const filename = `aviso_${ano}_${String(mes).padStart(2, "0")}_${safeFracao}.pdf`;
      const pdfPath = path.join(PDF_DIR, filename);
      await htmlToPdf(html, pdfPath);

      let emailEnviado = false;
      if (sendEmail && fracao.proprietarioEmail) {
        try {
          await sendAvisoEmail({
            para: fracao.proprietarioEmail,
            nomeProprietario: fracao.proprietarioNome ?? "Proprietário",
            fracaoNumero: fracao.numero,
            mes, ano, total, pdfPath,
          });
          emailEnviado = true;
        } catch (e: any) {
          console.error(`[avisos] Email erro ${fracao.numero}:`, e?.message);
        }
      }

      const record: AvisoRecord = {
        id: `${ano}${mes}${safeFracao}`,
        fracaoId: fracao.id,
        fracaoNumero: fracao.numero,
        proprietarioNome: fracao.proprietarioNome ?? "—",
        mes, ano, total,
        filename, pdfUrl: `/api/avisos/pdf/${filename}`,
        emailEnviado,
        geradoEm: new Date().toISOString(),
      };
      avisosLog.push(record);
      avisos.push(record);
      gerados++;

    } catch (err: any) {
      const msg = `Fração ${fracao.numero}: ${err?.message ?? err}`;
      erros.push(msg);
      console.error("[avisos] Erro:", msg);
    }
  }

  return { gerados, ignorados, erros, avisos };
}

// ─── Routes ──────────────────────────────────────────────────────────────────
export const avisosRoutes = new Hono()

  .post("/gerar", requireAdmin, async (c) => {
    const body = await c.req.json().catch(() => ({}));
    const now = new Date();
    const mes = Number(body.mes ?? now.getMonth() + 1);
    const ano = Number(body.ano ?? now.getFullYear());
    const sendEmail = body.sendEmail === true;
    const fracaoId = body.fracaoId;

    if (mes < 1 || mes > 12) return c.json({ error: "mes inválido" }, 400);

    const result = await gerarAvisosCobranca(mes, ano, { sendEmail, fracaoId });
    return c.json({
      ok: true,
      gerados: result.gerados,
      ignorados: result.ignorados,
      erros: result.erros,
      avisos: result.avisos.map(a => ({
        fracaoNumero: a.fracaoNumero,
        proprietarioNome: a.proprietarioNome,
        total: a.total,
        pdfUrl: a.pdfUrl,
        emailEnviado: a.emailEnviado,
      })),
    });
  })

  .get("/", requireAdmin, async (c) => {
    // List all generated aviso PDFs from disk
    const files = fs.readdirSync(PDF_DIR)
      .filter(f => f.startsWith("aviso_") && f.endsWith(".pdf"))
      .map(f => {
        const parts = f.replace("aviso_", "").replace(".pdf", "").split("_");
        const ano = parseInt(parts[0]);
        const mes = parseInt(parts[1]);
        const fracao = parts.slice(2).join("_");
        const stat = fs.statSync(path.join(PDF_DIR, f));
        return {
          filename: f,
          mes, ano,
          mesNome: MESES[mes] ?? "?",
          fracaoNumero: fracao,
          pdfUrl: `/api/avisos/pdf/${f}`,
          geradoEm: stat.mtime.toISOString(),
        };
      })
      .sort((a, b) => b.ano - a.ano || b.mes - a.mes || a.fracaoNumero.localeCompare(b.fracaoNumero));
    return c.json(files);
  })

  .get("/pdf/:filename", async (c) => {
    const filename = c.req.param("filename");
    if (filename.includes("..") || filename.includes("/")) return c.text("Not found", 404);
    const p = path.join(PDF_DIR, filename);
    if (!fs.existsSync(p)) return c.text("Not found", 404);
    const buf = fs.readFileSync(p);
    return new Response(buf, {
      headers: {
        "Content-Type": "application/pdf",
        "Content-Disposition": `inline; filename="${filename}"`,
      },
    });
  });

// ─── Lote Unificado: Recibo + Nota de Cobrança ──────────────────────────────
// Enviado no dia 1 de cada mês às 00h00 como parte do fecho mensal automático.
// Envia por email para cada fração:
//   1. Recibo do mês que terminou (mes anterior)
//   2. Nota de cobrança do mês que começa (mes actual)
// Retorna contagem de envios e erros.
export async function enviarLoteUnificado(
  mesRecibo: number,   // mês que terminou (ex: 6 para Junho)
  anoRecibo: number,   // ano do recibo (ex: 2026)
  mesCobranca: number, // mês que começa (ex: 7 para Julho)
  anoCobranca: number, // ano da nota de cobrança (ex: 2026)
): Promise<{ enviados: number; erros: string[] }> {
  const erros: string[] = [];
  let enviados = 0;

  // Buscar fracões activas com email
  const fracoesList = await db
    .select()
    .from(schema.fracoes)
    .where(eq(schema.fracoes.ativo, true));

  // Pré-carregar recibos gerados para o mês anterior
  const recibosRows = await db
    .select({
      fracaoId: schema.recibos.fracaoId,
      numeroRecibo: schema.recibos.numeroRecibo,
      pdfUrl: schema.recibos.pdfUrl,
      valor: schema.recibos.valor,
    })
    .from(schema.recibos)
    .where(and(
      eq(schema.recibos.mes, mesRecibo),
      eq(schema.recibos.ano, anoRecibo),
    ));
  const recibosByFracao = new Map(recibosRows.map(r => [r.fracaoId, r]));

  // Pré-carregar avisos gerados para o mês de cobrança
  // Os ficheiros estão em data/avisos/aviso_{ano}_{mes}_{fracao}.pdf
  const avisoDir = path.join(process.cwd(), "data", "avisos");
  const RECIBOS_PDF_DIR = path.join(process.cwd(), "data", "recibos");
  const mesStr = String(mesCobranca).padStart(2, "0");
  const anoStr = String(anoCobranca);

  const mesNomeRecibo = MESES[mesRecibo] ?? String(mesRecibo);
  const mesNomeCobranca = MESES[mesCobranca] ?? String(mesCobranca);

  for (const fracao of fracoesList) {
    if (!fracao.proprietarioEmail) continue;

    try {
      // Encontrar PDF do recibo
      const reciboRow = recibosByFracao.get(fracao.id);
      const reciboPdfFilename = reciboRow?.pdfUrl?.split("/").pop();
      const reciboPdfPath = reciboPdfFilename
        ? path.join(RECIBOS_PDF_DIR, reciboPdfFilename)
        : null;

      // Encontrar PDF do aviso (nota de cobrança)
      const safeFracao = fracao.numero.replace(/[^a-zA-Z0-9]/g, "");
      const avisoPdfFilename = `aviso_${anoStr}_${mesStr}_${safeFracao}.pdf`;
      const avisoPdfPath = path.join(avisoDir, avisoPdfFilename);

      const hasRecibo = reciboPdfPath && fs.existsSync(reciboPdfPath);
      const hasAviso = fs.existsSync(avisoPdfPath);

      if (!hasRecibo && !hasAviso) {
        // Nada a enviar para esta fração
        continue;
      }

      // Construir subject e corpo do email
      const subject = hasRecibo && hasAviso
        ? `Recibo ${mesNomeRecibo} ${anoRecibo} + Nota de Cobrança ${mesNomeCobranca} ${anoCobranca} — Fração ${fracao.numero}`
        : hasRecibo
          ? `Recibo ${mesNomeRecibo} ${anoRecibo} — Fração ${fracao.numero}`
          : `Nota de Cobrança ${mesNomeCobranca} ${anoCobranca} — Fração ${fracao.numero}`;

      const valorRecibo = reciboRow?.valor ?? 0;
      const html = `
        <p>Exmo/a Sr/a. ${fracao.proprietarioNome ?? "Proprietário"},</p>
        ${hasRecibo ? `<p>Segue em anexo o <strong>Recibo n.º ${reciboRow?.numeroRecibo}</strong> 
          referente a <strong>${mesNomeRecibo} ${anoRecibo}</strong>, 
          no valor de <strong>€${valorRecibo.toFixed(2).replace(".", ",")}</strong>.</p>` : ""}
        ${hasAviso ? `<p>Segue também em anexo a <strong>Nota de Cobrança</strong> 
          para <strong>${mesNomeCobranca} ${anoCobranca}</strong>. 
          Solicitamos que proceda ao pagamento até ao dia 10.</p>
          <p>Meios de pagamento: transferência para o IBAN <strong>${CONDOMINIO.iban}</strong></p>` : ""}
        <br>
        <p>Com os melhores cumprimentos,</p>
        <p><strong>A Administração do Condomínio</strong><br>${CONDOMINIO.nome}</p>
      `;

      // Escrever HTML para ficheiro temporário
      const tmpHtml = path.join(avisoDir, `_lote_${Date.now()}_${safeFracao}.html`);
      fs.writeFileSync(tmpHtml, html, "utf8");

      // Construir argumentos --attach
      const attachArgs = [
        hasRecibo ? `--attach "${reciboPdfPath}"` : "",
        hasAviso  ? `--attach "${avisoPdfPath}"` : "",
      ].filter(Boolean).join(" ");

      const subjectEscaped = subject.replace(/"/g, '\\"');
      const cmd = `cat "${tmpHtml}" | send-email --to "${fracao.proprietarioEmail}" --subject "${subjectEscaped}" --html - ${attachArgs}`;

      await new Promise<void>((resolve, reject) => {
        exec(cmd, (err, _stdout, stderr) => {
          fs.unlinkSync(tmpHtml);
          if (err) reject(new Error(stderr || err.message));
          else resolve();
        });
      });

      // Marcar recibo como enviado
      if (hasRecibo && reciboRow?.numeroRecibo) {
        await db.update(schema.recibos)
          .set({ enviadoEmail: true })
          .where(eq(schema.recibos.fracaoId, fracao.id));
      }

      enviados++;
      console.log(`[lote-unificado] Enviado para ${fracao.proprietarioEmail} (fração ${fracao.numero})`);
    } catch (err: any) {
      const msg = `Fração ${fracao.numero}: ${err?.message ?? err}`;
      erros.push(msg);
      console.error("[lote-unificado] Erro:", msg);
    }
  }

  return { enviados, erros };
}

// ─── Cron: 1º dia do mês às 08:00 (legado — substituído pelo cron coordenado em index.ts) ──
// Mantido apenas como fallback manual. O envio automático é feito pelo cron de 00h00 em index.ts.
export function scheduleAvisosCron() {
  // Desactivado — o cron coordenado em index.ts gere recibos+avisos como lote unificado.
  // Este cron foi substituído pelo scheduleTransicaoMensalCron().
  console.log("[avisos-cron] Substituído pelo cron de transição mensal (scheduleTransicaoMensalCron).");
}
