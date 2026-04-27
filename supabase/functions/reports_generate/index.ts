// @ts-nocheck
import { serve } from "https://deno.land/std@0.224.0/http/server.ts";
import * as XLSX from "https://esm.sh/xlsx@0.18.5";
import { z } from "npm:zod@3.23.8";
import { PDFDocument, StandardFonts, rgb } from "npm:pdf-lib@1.17.1";
import { authGuard } from "../_shared/authGuard.ts";
import { roleGuard } from "../_shared/roleGuard.ts";
import { requireAcceptedActiveLegalTerm } from "../_shared/legalGuard.ts";
import { clientAdmin } from "../_shared/supabaseClient.ts";
import { requireMethod, parseBody, requireIdempotencyKey, getClientIp, commonSchemas } from "../_shared/validation.ts";
import { rateLimiter } from "../_shared/rateLimiter.ts";
import { claimIdempotency, replayIdempotentResponse, safeFinalizeIdempotency } from "../_shared/idempotency.ts";
import { errorHandler } from "../_shared/errorHandler.ts";
import { response, handleCorsPreflight } from "../_shared/response.ts";
import { logRequest } from "../_shared/logger.ts";
import { safeWriteAudit } from "../_shared/auditWriter.ts";
import { hashCanonicalJson } from "../_shared/crypto.ts";
import { WORKTRACE_LOGO_PNG_BASE64 } from "./worktraceLogo.ts";
import { WORKTRACE_LOGO_NEW_PNG_BASE64 } from "./worktraceLogoNew.ts";
import { VERIFIK_LOGO_PNG_BASE64 } from "./verifikLogo.ts";
import { R3_LOGO_PNG_BASE64 } from "./r3Logo.ts";

const endpoint = "reports_generate";
const payloadSchema = z.object({
  restaurant_id: z.union([commonSchemas.restaurantId, z.literal("all"), z.null()]).optional(),
  employee_id: z.union([z.string().uuid(), z.literal("all"), z.null()]).optional(),
  period_start: commonSchemas.dateYmd,
  period_end: commonSchemas.dateYmd,
  filtros_json: z.record(z.any()).optional(),
  columns: z.array(z.string().min(1).max(64)).max(100).optional(),
  export_format: z.enum(["csv", "pdf", "both", "xlsx"]).optional(),
});

const allowedColumns = [
  "shift_id",
  "employee_id",
  "employee_name",
  "supervisor_name",
  "restaurant_id",
  "restaurant_name",
  "start_time",
  "end_time",
  "hours_worked",
  "scheduled_start",
  "scheduled_end",
  "scheduled_hours",
  "ended_early",
  "early_end_reason",
  "incidents_count",
  "state",
  "status",
  "approved_by",
  "approved_by_name",
  "rejected_by",
  "rejected_by_name",
  "start_evidence_path",
  "end_evidence_path",
  "start_evidence_urls",
  "end_evidence_urls",
  "start_evidence_count",
  "end_evidence_count",
] as const;

const defaultColumns = [
  "shift_id",
  "restaurant_name",
  "employee_name",
  "supervisor_name",
  "start_time",
  "end_time",
  "scheduled_start",
  "scheduled_end",
  "scheduled_hours",
  "hours_worked",
  "ended_early",
  "state",
  "early_end_reason",
  "incidents_count",
  "start_evidence_count",
  "end_evidence_count",
] as const;

const columnLabel: Record<string, string> = {
  shift_id: "Turno",
  employee_id: "Empleado ID",
  employee_name: "Empleado",
  supervisor_name: "Supervisora",
  restaurant_id: "Restaurante ID",
  restaurant_name: "Restaurante",
  start_time: "Inicio",
  end_time: "Fin",
  hours_worked: "Duracion (HH:MM)",
  scheduled_start: "Inicio programado",
  scheduled_end: "Fin programado",
  scheduled_hours: "Horas programadas",
  ended_early: "Salida anticipada",
  early_end_reason: "Motivo salida anticipada",
  incidents_count: "Novedades",
  state: "Estado",
  status: "Status",
  approved_by: "Aprobado por (ID)",
  approved_by_name: "Aprobado por",
  rejected_by: "Rechazado por (ID)",
  rejected_by_name: "Rechazado por",
  start_evidence_path: "Evidencia inicial",
  end_evidence_path: "Evidencia final",
  start_evidence_urls: "URLs evidencia inicio",
  end_evidence_urls: "URLs evidencia fin",
  start_evidence_count: "Fotos inicio",
  end_evidence_count: "Fotos fin",
};

const columnAliases: Record<string, string> = {
  turno: "shift_id",
  restaurante: "restaurant_name",
  empleado: "employee_name",
  supervisora: "supervisor_name",
  inicio: "start_time",
  fin: "end_time",
  estado: "state",
  duracion: "hours_worked",
  inicio_programado: "scheduled_start",
  fin_programado: "scheduled_end",
  horas_programadas: "scheduled_hours",
  salida_anticipada: "ended_early",
  motivo_salida_anticipada: "early_end_reason",
  novedades: "incidents_count",
  evidencia_inicial: "start_evidence_path",
  evidencia_final: "end_evidence_path",
  urls_evidencia_inicial: "start_evidence_urls",
  urls_evidencia_final: "end_evidence_urls",
  fotos_inicio: "start_evidence_count",
  fotos_fin: "end_evidence_count",
};

function csvEscape(value: unknown) {
  const raw = value == null ? "" : String(value);
  if (raw.includes(",") || raw.includes("\n") || raw.includes("\"")) {
    return `"${raw.replaceAll("\"", "\"\"")}"`;
  }
  return raw;
}

function normalizeColumnKey(value: string) {
  return value
    .trim()
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");
}

function formatCell(value: unknown, maxLen = 40) {
  const raw = value == null ? "" : String(value);
  if (raw.length <= maxLen) return raw;
  return `${raw.slice(0, Math.max(0, maxLen - 3))}...`;
}

function formatDateTime(iso: string | null) {
  if (!iso) return "";
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return String(iso);
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/Bogota",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).formatToParts(date);
  const get = (type: string) => parts.find((p) => p.type === type)?.value ?? "";
  return `${get("year")}-${get("month")}-${get("day")} ${get("hour")}:${get("minute")}`;
}

function formatDuration(hoursValue: number | null) {
  if (hoursValue == null || Number.isNaN(hoursValue)) return "";
  const totalMinutes = Math.round(hoursValue * 60);
  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;
  return `${String(hours).padStart(2, "0")}:${String(minutes).padStart(2, "0")}`;
}

function diffHours(startIso: string | null, endIso: string | null) {
  if (!startIso || !endIso) return null;
  const ms = new Date(endIso).getTime() - new Date(startIso).getTime();
  if (Number.isNaN(ms) || ms <= 0) return null;
  return Number((ms / 3600000).toFixed(2));
}

function formatState(value: string | null) {
  const map: Record<string, string> = {
    activo: "Activo",
    finalizado: "Finalizado",
    aprobado: "Aprobado",
    rechazado: "Rechazado",
    scheduled: "Programado",
    started: "Iniciado",
    completed: "Completado",
    cancelled: "Cancelado",
  };
  if (!value) return "";
  return map[value] ?? value;
}

function shortenEvidencePath(path: string, maxLen = 40) {
  const parts = path.split("/");
  const tail = parts.slice(-2).join("/");
  if (tail.length <= maxLen) return tail;
  return `${tail.slice(0, Math.max(0, maxLen - 3))}...`;
}

function formatEvidence(path: string | null, mode: "csv" | "pdf" | "xlsx") {
  if (!path) return "NO";
  if (mode === "pdf") return "SI";
  return `SI (${shortenEvidencePath(path, 48)})`;
}

function formatValue(row: Record<string, unknown>, column: string, mode: "csv" | "pdf" | "xlsx") {
  switch (column) {
    case "start_time":
    case "end_time":
    case "scheduled_start":
    case "scheduled_end":
      return formatDateTime(row[column] as string | null);
    case "hours_worked":
    case "scheduled_hours":
      return formatDuration(row[column] as number | null);
    case "ended_early":
      return row[column] ? "SI" : "NO";
    case "early_end_reason":
      return row[column] ?? "";
    case "state":
    case "status":
      return formatState(row[column] ? String(row[column]) : null);
    case "incidents_count":
      return row[column] == null ? "0" : String(row[column]);
    case "employee_name":
      return (row.employee_name as string | null) ?? (row.employee_id as string | number | null) ?? "";
    case "supervisor_name":
      return (row.supervisor_name as string | null) ?? "";
    case "restaurant_name":
      return (row.restaurant_name as string | null) ?? (row.restaurant_id as string | number | null) ?? "";
    case "approved_by_name":
      return (row.approved_by_name as string | null) ?? (row.approved_by as string | number | null) ?? "";
    case "rejected_by_name":
      return (row.rejected_by_name as string | null) ?? (row.rejected_by as string | number | null) ?? "";
    case "start_evidence_path":
      return formatEvidence(row.start_evidence_path as string | null, mode);
    case "end_evidence_path":
      return formatEvidence(row.end_evidence_path as string | null, mode);
    case "start_evidence_urls": {
      const urls = row.start_evidence_urls as string[] | null | undefined;
      if (!urls || urls.length === 0) return "";
      const joined = urls.join(" | ");
      if (mode === "pdf") return formatCell(joined, 60);
      if (mode === "xlsx") return formatCell(joined, 200);
      return joined;
    }
    case "end_evidence_urls": {
      const urls = row.end_evidence_urls as string[] | null | undefined;
      if (!urls || urls.length === 0) return "";
      const joined = urls.join(" | ");
      if (mode === "pdf") return formatCell(joined, 60);
      if (mode === "xlsx") return formatCell(joined, 200);
      return joined;
    }
    case "start_evidence_count":
    case "end_evidence_count":
      return row[column] == null ? "0" : String(row[column]);
    default:
      return row[column] ?? "";
  }
}

function buildXlsxWorkbook(
  rows: Array<Record<string, unknown>>,
  columns: string[],
  headerLabels: string[],
  meta: {
    restaurantLabel: string;
    period_start: string;
    period_end: string;
    generatedAt: string;
    totalShifts: number;
    totalHours: number;
    totalScheduledHours: number;
  },
  evidenceRows?: Array<{
    shift_id: number;
    phase: "Antes" | "Despues";
    index: number;
    photo_url: string;
    captured_at: string;
    zone: string;
    restaurant_name: string;
    employee_name: string;
    watermark_text: string;
  }>
) {
  const dataRows = rows.map((r) => columns.map((col) => formatValue(r, col, "xlsx")));
  const title = `Reporte de turnos`;
  const headerOffset = 5;
  const sheetData: Array<Array<string | number>> = [
    [title],
    [`Restaurante: ${meta.restaurantLabel}`],
    [`Periodo: ${meta.period_start} a ${meta.period_end}`],
    [`Generado: ${formatDateTime(meta.generatedAt)}`],
    [],
    headerLabels,
    ...dataRows,
    [],
    [
      `Totales: turnos ${meta.totalShifts}, horas trabajadas ${formatDuration(meta.totalHours)}, horas programadas ${formatDuration(meta.totalScheduledHours)}`,
    ],
  ];

  const worksheet = XLSX.utils.aoa_to_sheet(sheetData);
  const lastCol = Math.max(columns.length - 1, 0);

  worksheet["!merges"] = [
    { s: { r: 0, c: 0 }, e: { r: 0, c: lastCol } },
    { s: { r: 1, c: 0 }, e: { r: 1, c: lastCol } },
    { s: { r: 2, c: 0 }, e: { r: 2, c: lastCol } },
    { s: { r: 3, c: 0 }, e: { r: 3, c: lastCol } },
    { s: { r: headerOffset + dataRows.length + 1, c: 0 }, e: { r: headerOffset + dataRows.length + 1, c: lastCol } },
  ];

  const widths = columns.map((col, idx) => {
    const base = Math.max((headerLabels[idx] ?? col).length, 10);
    const maxValue = dataRows.reduce((acc, row) => {
      const value = row[idx];
      const len = value == null ? 0 : String(value).length;
      return Math.max(acc, len);
    }, base);
    return { wch: Math.min(40, Math.max(10, maxValue + 2)) };
  });

  worksheet["!cols"] = widths;

  const workbook = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(workbook, worksheet, "Reporte");

  if (evidenceRows && evidenceRows.length > 0) {
    const evidenceHeader = [
      "Foto",
      "URL Foto",
      "Turno",
      "Fase",
      "Indice",
      "Capturada",
      "Zona",
      "Restaurante",
      "Empleado",
      "Trazabilidad",
    ];
    const evidenceData: Array<Array<string | number | { f: string }>> = [evidenceHeader];
    for (const row of evidenceRows) {
      const safeUrl = row.photo_url.replaceAll('"', '""');
      evidenceData.push([
        { f: `IFERROR(IMAGE("${safeUrl}"),"Ver URL")` },
        row.photo_url,
        row.shift_id,
        row.phase,
        row.index,
        row.captured_at,
        row.zone,
        row.restaurant_name,
        row.employee_name,
        row.watermark_text,
      ]);
    }

    const evidenceSheet = XLSX.utils.aoa_to_sheet(evidenceData as unknown[][]);
    evidenceSheet["!cols"] = [
      { wch: 24 },
      { wch: 58 },
      { wch: 10 },
      { wch: 10 },
      { wch: 8 },
      { wch: 18 },
      { wch: 24 },
      { wch: 28 },
      { wch: 28 },
      { wch: 60 },
    ];
    XLSX.utils.book_append_sheet(workbook, evidenceSheet, "Evidencias");
  }

  return XLSX.write(workbook, { type: "array", bookType: "xlsx", compression: true });
}

type EvidenceForExport = {
  shift_id: number;
  phase: "Antes" | "Despues";
  index: number;
  path: string;
  signed_url: string;
  captured_at: string | null;
  zone: string;
  restaurant_name: string;
  employee_name: string;
  watermark_text: string;
};

function normalizeZone(meta: Record<string, unknown>) {
  const candidates = [
    meta.zone,
    meta.zone_name,
    meta.location,
    meta.location_label,
    meta.place,
    meta.place_label,
    meta.area_label,
    meta.subarea_label,
  ];

  for (const candidate of candidates) {
    if (typeof candidate === "string" && candidate.trim().length > 0) {
      return candidate.trim();
    }
  }
  return "Zona no especificada";
}

function buildZoneWithSubzone(meta: Record<string, unknown>) {
  const area = typeof meta.area_label === "string" ? meta.area_label.trim() : "";
  const subarea = typeof meta.subarea_label === "string" ? meta.subarea_label.trim() : "";

  if (area && subarea) return `${area} - ${subarea}`;
  if (area) return area;
  if (subarea) return subarea;

  return normalizeZone(meta);
}

function buildEvidenceWatermarkText(evidence: {
  captured_at: string | null;
  zone: string;
  restaurant_name: string;
  employee_name: string;
}) {
  const captured = evidence.captured_at ? formatDateTime(evidence.captured_at) : "Fecha/hora no disponible";
  return `Fecha/Hora: ${captured} | Zona: ${evidence.zone} | Restaurante: ${evidence.restaurant_name} | Empleado: ${evidence.employee_name}`;
}

async function buildSingleDayPdfWithEvidence(params: {
  restaurantLabel: string;
  periodStart: string;
  periodEnd: string;
  generatedAt: string;
  totalShifts: number;
  totalHours: number;
  totalScheduledHours: number;
  evidenceRows: EvidenceForExport[];
}): Promise<Uint8Array> {
  const pdfDoc = await PDFDocument.create();
  const font = await pdfDoc.embedFont(StandardFonts.Helvetica);
  const bold = await pdfDoc.embedFont(StandardFonts.HelveticaBold);
  const brandLogoUrl = (Deno.env.get("REPORTS_BRAND_LOGO_URL") ?? "").trim();
  let brandLogo: any = null;
  let verifikLogo: any = null;

  if (brandLogoUrl) {
    try {
      const logoResp = await fetch(brandLogoUrl);
      if (logoResp.ok) {
        const contentType = (logoResp.headers.get("content-type") ?? "").toLowerCase();
        const logoBytes = new Uint8Array(await logoResp.arrayBuffer());
        if (contentType.includes("png")) {
          brandLogo = await pdfDoc.embedPng(logoBytes);
        } else if (contentType.includes("jpg") || contentType.includes("jpeg")) {
          brandLogo = await pdfDoc.embedJpg(logoBytes);
        } else {
          try {
            brandLogo = await pdfDoc.embedPng(logoBytes);
          } catch {
            brandLogo = await pdfDoc.embedJpg(logoBytes);
          }
        }
      }
    } catch {
      brandLogo = null;
    }
  }

  if (!brandLogo) {
    try {
      const src = WORKTRACE_LOGO_NEW_PNG_BASE64 || WORKTRACE_LOGO_PNG_BASE64;
      const logoBinary = atob(src);
      const logoBytes = Uint8Array.from(logoBinary, (ch) => ch.charCodeAt(0));
      brandLogo = await pdfDoc.embedPng(logoBytes);
    } catch {
      brandLogo = null;
    }
  }

  try {
    const vkBinary = atob(VERIFIK_LOGO_PNG_BASE64);
    const vkBytes = Uint8Array.from(vkBinary, (ch) => ch.charCodeAt(0));
    verifikLogo = await pdfDoc.embedPng(vkBytes);
  } catch {
    verifikLogo = null;
  }

  let r3Logo: any = null;
  try {
    const r3Binary = atob(R3_LOGO_PNG_BASE64);
    const r3Bytes = Uint8Array.from(r3Binary, (ch) => ch.charCodeAt(0));
    r3Logo = await pdfDoc.embedPng(r3Bytes);
  } catch {
    r3Logo = null;
  }

  const fitTextByWidth = (txt: string, maxWidth: number, fontSize: number) => {
    if (maxWidth <= 0) return txt;
    if (bold.widthOfTextAtSize(txt, fontSize) <= maxWidth) return txt;
    let base = txt.trim();
    while (base.length > 3 && bold.widthOfTextAtSize(`${base}...`, fontSize) > maxWidth) {
      base = base.slice(0, -1);
    }
    return `${base}...`;
  };

  const totalPageCount = 1 + params.evidenceRows.length;
  let currentPageNum = 0;

  const drawPageHeader = (page: any, pw: number, ph: number) => {
    const logoTopY = ph - 8;
    const logoMaxH = 48;

    // Left: 3R logo
    let r3RightX = 24;
    if (r3Logo) {
      const s = Math.min(90 / r3Logo.width, logoMaxH / r3Logo.height, 1);
      const lw = r3Logo.width * s;
      const lh = r3Logo.height * s;
      page.drawImage(r3Logo, { x: 24, y: logoTopY - lh, width: lw, height: lh });
      r3RightX = 24 + lw;
    }

    // Right: WorkTrace logo
    let wtLeftX = pw - 24;
    if (brandLogo) {
      const s = Math.min(140 / brandLogo.width, logoMaxH / brandLogo.height, 1);
      const lw = brandLogo.width * s;
      const lh = brandLogo.height * s;
      page.drawImage(brandLogo, { x: pw - 24 - lw, y: logoTopY - lh, width: lw, height: lh });
      wtLeftX = pw - 24 - lw;
    }

    // Center: R3 company info (3 lines, centered between logos)
    const cx = (r3RightX + wtLeftX) / 2;
    const cL1 = "R3 Service & Solutions Inc.";
    const cL2 = "Montrose, CA 91020  |  818.795.7744";
    const cL3 = "Danny@r3servicesol.com";
    page.drawText(cL1, { x: cx - bold.widthOfTextAtSize(cL1, 9.5) / 2, y: ph - 16, size: 9.5, font: bold, color: rgb(0.15, 0.15, 0.15) });
    page.drawText(cL2, { x: cx - font.widthOfTextAtSize(cL2, 8) / 2, y: ph - 29, size: 8, font, color: rgb(0.45, 0.45, 0.45) });
    page.drawText(cL3, { x: cx - font.widthOfTextAtSize(cL3, 8) / 2, y: ph - 41, size: 8, font, color: rgb(0.45, 0.45, 0.45) });

    // Subtitle "Sistema de Control de Empleados" + divider
    const divY = ph - logoMaxH - 16;
    page.drawText("Sistema de Control de Empleados", { x: 24, y: divY + 6, size: 7.5, font, color: rgb(0.55, 0.55, 0.55) });
    page.drawLine({ start: { x: 24, y: divY }, end: { x: pw - 24, y: divY }, thickness: 0.5, color: rgb(0.75, 0.75, 0.75) });
  };

  const drawPageFooter = (page: any, pw: number) => {
    page.drawLine({ start: { x: 24, y: 58 }, end: { x: pw - 24, y: 58 }, thickness: 0.5, color: rgb(0.8, 0.8, 0.8) });

    // VerifiK logo on left — allow wider scale so height fills the footer
    let infoX = 24;
    if (verifikLogo) {
      const s = Math.min(100 / verifikLogo.width, 40 / verifikLogo.height, 1);
      const lw = verifikLogo.width * s;
      const lh = verifikLogo.height * s;
      page.drawImage(verifikLogo, { x: 24, y: 8, width: lw, height: lh });
      infoX = 24 + lw + 8;

      // Text vertically centered on logo
      const logoCenterY = 8 + lh / 2;
      page.drawText("VerifiK  —  Desarrollador de WorkTrace", { x: infoX, y: logoCenterY + 7, size: 8.5, font: bold, color: rgb(0.25, 0.25, 0.25) });
      page.drawText("verifikhm@gmail.com  |  +57 324 397 7861  |  www.verifik.com", { x: infoX, y: logoCenterY - 6, size: 8, font, color: rgb(0.4, 0.4, 0.4) });
    } else {
      page.drawText("VerifiK  —  Desarrollador de WorkTrace", { x: infoX, y: 36, size: 8.5, font: bold, color: rgb(0.25, 0.25, 0.25) });
      page.drawText("verifikhm@gmail.com  |  +57 324 397 7861  |  www.verifik.com", { x: infoX, y: 23, size: 8, font, color: rgb(0.4, 0.4, 0.4) });
    }

    // Page number on right
    const pageLabel = `Pag. ${currentPageNum} / ${totalPageCount}`;
    const labelW = bold.widthOfTextAtSize(pageLabel, 9);
    page.drawText(pageLabel, { x: pw - 24 - labelW, y: 32, size: 9, font: bold, color: rgb(0.3, 0.3, 0.3) });
  };

  const summaryPage = pdfDoc.addPage([595, 842]);
  const pageW = 595;
  const pageH = 842;
  const pageMarginX = 40;

  // --- Header (same style as evidence pages) ---
  drawPageHeader(summaryPage, pageW, pageH);

  // Content starts below header divider (divider at pageH - 48 - 16 = 778)
  const headerDivY = pageH - 48 - 16;
  const tableW = pageW - 2 * pageMarginX;

  // --- Black title banner ---
  // bannerY is the BOTTOM of the rectangle; top = bannerY + bannerH must be below headerDivY
  const bannerH = 32;
  const bannerY = headerDivY - bannerH - 22; // 22px gap below the header divider
  summaryPage.drawRectangle({ x: pageMarginX, y: bannerY, width: tableW, height: bannerH, color: rgb(0.05, 0.05, 0.05) });
  const titleTxt = "REPORTE DE TURNOS - EVIDENCIAS DIA UNICO";
  const titleTxtW = bold.widthOfTextAtSize(titleTxt, 12);
  summaryPage.drawText(titleTxt, { x: (pageW - titleTxtW) / 2, y: bannerY + 11, size: 12, font: bold, color: rgb(1, 1, 1) });

  // --- Data table (3 rows × 4 cols: label | value | label | value) ---
  const tblTop = bannerY - 10;
  const cellH = 32;
  const colW = tableW / 4;
  const tblRows: [string, string, string, string][] = [
    ["Restaurante", params.restaurantLabel, "Periodo", `${params.periodStart} a ${params.periodEnd}`],
    ["Generado", formatDateTime(params.generatedAt), "Total de Turnos", String(params.totalShifts)],
    ["Horas Trabajadas", formatDuration(params.totalHours), "Horas Programadas", formatDuration(params.totalScheduledHours)],
  ];
  for (let i = 0; i < tblRows.length; i++) {
    const rowY = tblTop - i * cellH;
    const bg = i % 2 === 0 ? rgb(0.94, 0.94, 0.94) : rgb(1, 1, 1);
    summaryPage.drawRectangle({ x: pageMarginX, y: rowY - cellH, width: tableW, height: cellH, color: bg, borderColor: rgb(0.76, 0.76, 0.76), borderWidth: 0.5 });
    for (let c = 1; c < 4; c++) {
      summaryPage.drawLine({ start: { x: pageMarginX + colW * c, y: rowY }, end: { x: pageMarginX + colW * c, y: rowY - cellH }, thickness: 0.5, color: rgb(0.76, 0.76, 0.76) });
    }
    const ty = rowY - cellH / 2 - 3;
    const [l1, v1, l2, v2] = tblRows[i];
    summaryPage.drawText(l1, { x: pageMarginX + 6, y: ty, size: 8.5, font: bold, color: rgb(0.2, 0.2, 0.2) });
    summaryPage.drawText(v1, { x: pageMarginX + colW + 6, y: ty, size: 8.5, font, color: rgb(0.3, 0.3, 0.3) });
    summaryPage.drawText(l2, { x: pageMarginX + colW * 2 + 6, y: ty, size: 8.5, font: bold, color: rgb(0.2, 0.2, 0.2) });
    summaryPage.drawText(v2, { x: pageMarginX + colW * 3 + 6, y: ty, size: 8.5, font, color: rgb(0.3, 0.3, 0.3) });
  }

  // Note
  summaryPage.drawText("Las siguientes paginas incluyen fotos Antes/Despues con datos de trazabilidad.", {
    x: pageMarginX, y: tblTop - tblRows.length * cellH - 22, size: 9.5, font, color: rgb(0.25, 0.25, 0.25),
  });
  currentPageNum = 1;
  drawPageFooter(summaryPage, pageW);

  for (const ev of params.evidenceRows) {
    currentPageNum++;
    const pageMargin = 24;
    const bottomPadding = 72;
    const headerBlockHeight = 110;
    const titleOffsetFromImage = 22;
    const titleSize = 16;
    const maxImageWidth = 760;
    const maxImageHeight = 1100;

    const zoneLabel = typeof ev.zone === "string" && ev.zone.trim().length > 0 ? ev.zone.trim() : "Zona no especificada";
    const phaseLabel = ev.phase === "Despues" ? "Después" : ev.phase;
    const titleRaw = `${zoneLabel} - ${phaseLabel}`;

    let embedded: unknown = null;
    try {
      const resp = await fetch(ev.signed_url);
      if (resp.ok) {
        const contentType = (resp.headers.get("content-type") ?? "").toLowerCase();
        const bytes = new Uint8Array(await resp.arrayBuffer());
        if (contentType.includes("png")) {
          embedded = await pdfDoc.embedPng(bytes);
        } else {
          embedded = await pdfDoc.embedJpg(bytes);
        }
      }
    } catch {
      embedded = null;
    }

    let page;
    let frameX = pageMargin;
    let frameY = 140;
    let frameW = 595 - pageMargin * 2;
    let frameH = 510;
    let imageDrawn = false;

    if (embedded) {
      const img = embedded as any;
      const imageScale = Math.min(maxImageWidth / img.width, maxImageHeight / img.height, 1);
      const drawW = img.width * imageScale;
      const drawH = img.height * imageScale;
      const pageW = Math.max(340, drawW + pageMargin * 2);
      const pageH = Math.max(420, bottomPadding + drawH + headerBlockHeight);

      page = pdfDoc.addPage([pageW, pageH]);
      const title = fitTextByWidth(titleRaw, pageW - pageMargin * 2, titleSize);
      const titleWidth = bold.widthOfTextAtSize(title, titleSize);
      const titleX = Math.max(pageMargin, (pageW - titleWidth) / 2);
      const titleY = bottomPadding + drawH + titleOffsetFromImage;
      page.drawText(title, { x: titleX, y: titleY, size: titleSize, font: bold, color: rgb(0, 0, 0) });
      drawPageHeader(page, pageW, pageH);
      drawPageFooter(page, pageW);

      frameW = drawW;
      frameH = drawH;
      frameX = (pageW - drawW) / 2;
      frameY = bottomPadding;
      page.drawImage(img, { x: frameX, y: frameY, width: frameW, height: frameH });
      imageDrawn = true;
    } else {
      const fallbackPageW = 595;
      const fallbackPageH = 842;
      page = pdfDoc.addPage([fallbackPageW, fallbackPageH]);

      const title = fitTextByWidth(titleRaw, fallbackPageW - pageMargin * 2, titleSize);
      const titleWidth = bold.widthOfTextAtSize(title, titleSize);
      const titleX = Math.max(pageMargin, (fallbackPageW - titleWidth) / 2);
      const titleY = frameY + (fallbackPageH - frameY - headerBlockHeight - pageMargin) + titleOffsetFromImage;
      page.drawText(title, { x: titleX, y: titleY, size: titleSize, font: bold, color: rgb(0, 0, 0) });
      drawPageHeader(page, fallbackPageW, fallbackPageH);
      drawPageFooter(page, fallbackPageW);

      frameX = pageMargin;
      frameY = 140;
      frameW = fallbackPageW - pageMargin * 2;
      frameH = fallbackPageH - frameY - headerBlockHeight - pageMargin;
      page.drawRectangle({ x: frameX, y: frameY, width: frameW, height: frameH, borderColor: rgb(0.7, 0.7, 0.7), borderWidth: 1 });
      page.drawText("No se pudo incrustar la imagen. URL firmada:", { x: frameX + 10, y: frameY + frameH - 30, size: 10, font });
      page.drawText(ev.signed_url.slice(0, 95), { x: frameX + 10, y: frameY + frameH - 48, size: 8, font, color: rgb(0.2, 0.2, 0.2) });
    }

    if (!imageDrawn) {
      continue;
    }

    const overlayPadding = 8;
    const overlayMinH = 58;
    const overlayH = Math.min(84, Math.max(overlayMinH, frameH * 0.22));
    const overlayX = frameX + overlayPadding;
    const overlayW = Math.max(120, frameW - overlayPadding * 2);
    const overlayY = frameY + overlayPadding;
    const fit = (txt: string, max = 88) => (txt.length > max ? `${txt.slice(0, max - 3)}...` : txt);

    page.drawRectangle({ x: overlayX, y: overlayY, width: overlayW, height: overlayH, color: rgb(1, 1, 1), opacity: 0.6 });
    page.drawText(fit(`Fecha/Hora: ${ev.captured_at ? formatDateTime(ev.captured_at) : "No disponible"}`), {
      x: overlayX + 6,
      y: overlayY + overlayH - 16,
      size: 9,
      font,
      color: rgb(0, 0, 0),
    });
    page.drawText(fit(`Zona: ${ev.zone}`), {
      x: overlayX + 6,
      y: overlayY + overlayH - 29,
      size: 9,
      font,
      color: rgb(0, 0, 0),
    });
    page.drawText(fit(`Restaurante: ${ev.restaurant_name}`), {
      x: overlayX + 6,
      y: overlayY + overlayH - 42,
      size: 9,
      font,
      color: rgb(0, 0, 0),
    });
    page.drawText(fit(`Empleado: ${ev.employee_name}`), {
      x: overlayX + 6,
      y: overlayY + overlayH - 55,
      size: 9,
      font,
      color: rgb(0, 0, 0),
    });
  }

  const bytes = await pdfDoc.save();
  return bytes;
}

function buildSimplePdf(lines: string[]): Uint8Array {
  const escaped = lines.map((line) => line.replaceAll("\\", "\\\\").replaceAll("(", "\\(").replaceAll(")", "\\)").replaceAll("\r", " ").replaceAll("\n", " "));
  const textCommands = escaped.map((line, idx) => `${idx === 0 ? "" : "T* "}(${line}) Tj`).join("\n");
  const stream = `BT\n/F1 10 Tf\n50 780 Td\n14 TL\n${textCommands}\nET`;

  const objects = [
    "1 0 obj << /Type /Catalog /Pages 2 0 R >> endobj\n",
    "2 0 obj << /Type /Pages /Kids [3 0 R] /Count 1 >> endobj\n",
    "3 0 obj << /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >> endobj\n",
    "4 0 obj << /Type /Font /Subtype /Type1 /BaseFont /Helvetica >> endobj\n",
    `5 0 obj << /Length ${stream.length} >> stream\n${stream}\nendstream endobj\n`,
  ];

  let body = "%PDF-1.4\n";
  const offsets: number[] = [0];
  for (const obj of objects) {
    offsets.push(body.length);
    body += obj;
  }

  const xrefStart = body.length;
  body += `xref\n0 ${objects.length + 1}\n`;
  body += "0000000000 65535 f \n";
  for (let i = 1; i <= objects.length; i += 1) {
    body += `${String(offsets[i]).padStart(10, "0")} 00000 n \n`;
  }
  body += `trailer << /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xrefStart}\n%%EOF`;

  return new TextEncoder().encode(body);
}

function buildPagedPdf(
  pages: string[][],
  options?: {
    pageWidth?: number;
    pageHeight?: number;
    fontSize?: number;
    lineHeight?: number;
    startX?: number;
    startY?: number;
  }
): Uint8Array {
  const pageWidth = options?.pageWidth ?? 842;
  const pageHeight = options?.pageHeight ?? 595;
  const fontSize = options?.fontSize ?? 8;
  const lineHeight = options?.lineHeight ?? 10;
  const startX = options?.startX ?? 30;
  const startY = options?.startY ?? pageHeight - 40;

  const fontObjId = 3 + pages.length * 2;
  const objects: string[] = [];

  objects.push("1 0 obj << /Type /Catalog /Pages 2 0 R >> endobj\n");
  const kids = pages.map((_, idx) => `${3 + idx * 2} 0 R`).join(" ");
  objects.push(`2 0 obj << /Type /Pages /Kids [${kids}] /Count ${pages.length} >> endobj\n`);

  pages.forEach((lines, idx) => {
    const pageObjId = 3 + idx * 2;
    const contentObjId = pageObjId + 1;

    const escaped = lines.map((line) =>
      line.replaceAll("\\", "\\\\").replaceAll("(", "\\(").replaceAll(")", "\\)").replaceAll("\r", " ").replaceAll("\n", " ")
    );
    const textCommands = escaped.map((line, i) => `${i === 0 ? "" : "T* "}(${line}) Tj`).join("\n");
    const stream = `BT\n/F1 ${fontSize} Tf\n${startX} ${startY} Td\n${lineHeight} TL\n${textCommands}\nET`;

    objects.push(
      `${pageObjId} 0 obj << /Type /Page /Parent 2 0 R /MediaBox [0 0 ${pageWidth} ${pageHeight}] /Resources << /Font << /F1 ${fontObjId} 0 R >> >> /Contents ${contentObjId} 0 R >> endobj\n`
    );
    objects.push(`${contentObjId} 0 obj << /Length ${stream.length} >> stream\n${stream}\nendstream endobj\n`);
  });

  objects.push(`${fontObjId} 0 obj << /Type /Font /Subtype /Type1 /BaseFont /Courier >> endobj\n`);

  let body = "%PDF-1.4\n";
  const offsets: number[] = [0];
  for (const obj of objects) {
    offsets.push(body.length);
    body += obj;
  }

  const xrefStart = body.length;
  body += `xref\n0 ${objects.length + 1}\n`;
  body += "0000000000 65535 f \n";
  for (let i = 1; i <= objects.length; i += 1) {
    body += `${String(offsets[i]).padStart(10, "0")} 00000 n \n`;
  }
  body += `trailer << /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xrefStart}\n%%EOF`;

  return new TextEncoder().encode(body);
}

serve(async (req: Request) => {
  const preflight = handleCorsPreflight(req);
  if (preflight) return preflight;

  const request_id = crypto.randomUUID();
  const startedAt = Date.now();
  const ip = getClientIp(req);
  const userAgent = req.headers.get("user-agent") ?? "unknown";
  let status = 200;
  let error_code: string | undefined;
  let userId: string | undefined;
  let userRole: "super_admin" | "supervisora" | "empleado" | undefined;
  let idempotencyKey: string | null = null;

  try {
    requireMethod(req, ["POST"]);
    const { user, clientUser } = await authGuard(req);
    userId = user.id;
    userRole = user.role;
    roleGuard(user, ["supervisora", "super_admin"]);
    await requireAcceptedActiveLegalTerm(user.id);

    const parsedPayload = await parseBody(req, payloadSchema);
    const payload = parsedPayload as z.infer<typeof payloadSchema>;
    idempotencyKey = requireIdempotencyKey(req);

    const payloadHash = await hashCanonicalJson(payload);
    const claim = await claimIdempotency({ userId: user.id, endpoint, key: idempotencyKey, payloadHash });
    if (claim.type === "replay") {
      status = claim.stored.status_code;
      return replayIdempotentResponse(claim.stored, request_id);
    }

    await rateLimiter({ user_id: user.id, ip, endpoint, limit: 10, window_seconds: 60 });

    const { restaurant_id, employee_id, period_start, period_end } = payload;
    if (period_start > period_end) {
      throw { code: 422, message: "Rango de fechas invalido", category: "VALIDATION" };
    }

    const requestedRestaurantId = typeof restaurant_id === "number" ? restaurant_id : null;
    const requestedEmployeeId = typeof employee_id === "string" && employee_id !== "all" ? employee_id : null;

    // Supervisora can operate on any active restaurant; scope enforced at UI level.

    const generatedAt = new Date().toISOString();
    const rawColumns = payload.columns && payload.columns.length > 0
      ? payload.columns
      : [...defaultColumns];

    const selectedColumns = rawColumns.map((col) => {
      const normalized = normalizeColumnKey(col);
      return columnAliases[normalized] ?? col;
    });

    const invalidColumns = selectedColumns.filter((col) => !allowedColumns.includes(col as (typeof allowedColumns)[number]));
    if (invalidColumns.length > 0) {
      throw {
        code: 422,
        message: `Columnas no soportadas: ${invalidColumns.join(", ")}`,
        category: "VALIDATION",
        details: { allowed: allowedColumns },
      };
    }

    const filtros_json = {
      period_start,
      period_end,
      restaurant_scope: requestedRestaurantId == null ? "all" : requestedRestaurantId,
      employee_scope: requestedEmployeeId == null ? "all" : requestedEmployeeId,
      filters: payload.filtros_json ?? {},
      columns: selectedColumns,
      export_format: payload.export_format ?? "both",
    };
    const hash_documento = await hashCanonicalJson(filtros_json);
    const scopeRestaurantPath = requestedRestaurantId == null ? "all" : String(requestedRestaurantId);
    const scopeEmployeePath = requestedEmployeeId == null ? "all" : requestedEmployeeId;
    const basePath = `reports/${scopeRestaurantPath}/${scopeEmployeePath}/${period_start}_${period_end}/${request_id}`;
    const file_path = `${basePath}.json`;

    const fromIso = `${period_start}T00:00:00.000Z`;
    const toIso = `${period_end}T23:59:59.999Z`;

    const shiftsClient = user.role === "supervisora" ? clientAdmin : clientUser;
    let shiftsQuery = shiftsClient
      .from("shifts")
      .select("id, employee_id, restaurant_id, start_time, end_time, state, status, approved_by, rejected_by, early_end_reason")
      .gte("start_time", fromIso)
      .lte("start_time", toIso)
      .order("start_time", { ascending: true });

    if (requestedRestaurantId != null) {
      shiftsQuery = shiftsQuery.eq("restaurant_id", requestedRestaurantId);
    }
    if (requestedEmployeeId != null) {
      shiftsQuery = shiftsQuery.eq("employee_id", requestedEmployeeId);
    }

    const { data: shifts, error: shiftsError } = await shiftsQuery;

    if (shiftsError) {
      throw { code: 409, message: "No se pudieron consultar turnos para el reporte", category: "BUSINESS", details: shiftsError };
    }

    const employeeIds = [...new Set((shifts ?? []).map((s) => String(s.employee_id)).filter((id) => id && id !== "null"))];
    const supervisorIds = [...new Set((shifts ?? []).map((s) => [s.approved_by, s.rejected_by]).flat().filter(Boolean).map((id) => String(id)))];
    const restaurantIds = [...new Set((shifts ?? []).map((s) => Number(s.restaurant_id)).filter((id) => Number.isFinite(id)))];
    const shiftIds = (shifts ?? []).map((s) => s.id);

    const [usersRes, restaurantsRes, photosRes, incidentsRes, scheduledRes] = await Promise.all([
      employeeIds.length || supervisorIds.length
        ? clientAdmin.from("users").select("id, full_name").in("id", [...new Set([...employeeIds, ...supervisorIds])])
        : Promise.resolve({ data: [], error: null }),
      restaurantIds.length
        ? clientAdmin.from("restaurants").select("id, name").in("id", restaurantIds)
        : Promise.resolve({ data: [], error: null }),
      (shifts ?? []).length
        ? clientAdmin
            .from("shift_photos")
            .select("shift_id, type, storage_path, captured_at, meta, created_at")
            .in("shift_id", (shifts ?? []).map((s) => s.id))
            .in("type", ["inicio", "fin"])
            .order("created_at", { ascending: true })
        : Promise.resolve({ data: [], error: null }),
      shiftIds.length
        ? clientAdmin
            .from("shift_incidents")
            .select("id, shift_id")
            .in("shift_id", shiftIds)
        : Promise.resolve({ data: [], error: null }),
      shiftIds.length
        ? clientAdmin
            .from("scheduled_shifts")
            .select("started_shift_id, scheduled_start, scheduled_end")
            .in("started_shift_id", shiftIds)
        : Promise.resolve({ data: [], error: null }),
    ]);

    if ((usersRes as { error?: unknown }).error) {
      throw { code: 409, message: "No se pudieron cargar nombres de usuarios", category: "BUSINESS", details: (usersRes as { error?: unknown }).error };
    }
    if ((restaurantsRes as { error?: unknown }).error) {
      throw { code: 409, message: "No se pudieron cargar restaurantes", category: "BUSINESS", details: (restaurantsRes as { error?: unknown }).error };
    }
    if ((photosRes as { error?: unknown }).error) {
      throw { code: 409, message: "No se pudieron cargar evidencias de turnos", category: "BUSINESS", details: (photosRes as { error?: unknown }).error };
    }
    if ((incidentsRes as { error?: unknown }).error) {
      throw { code: 409, message: "No se pudieron cargar incidentes", category: "BUSINESS", details: (incidentsRes as { error?: unknown }).error };
    }
    if ((scheduledRes as { error?: unknown }).error) {
      throw { code: 409, message: "No se pudieron cargar turnos programados", category: "BUSINESS", details: (scheduledRes as { error?: unknown }).error };
    }

    const userNameMap = new Map((usersRes as { data?: Array<{ id: string; full_name: string | null }> }).data?.map((u) => [String(u.id), u.full_name ?? null]) ?? []);
    const restaurantNameMap = new Map((restaurantsRes as { data?: Array<{ id: number; name: string | null }> }).data?.map((r) => [Number(r.id), r.name ?? null]) ?? []);

    const startEvidence = new Map<number, string>();
    const endEvidence = new Map<number, string>();
    const evidenceByShift = new Map<
      number,
      { start: Array<Record<string, unknown>>; end: Array<Record<string, unknown>>; startUrls: string[]; endUrls: string[] }
    >();
    const includeEvidenceUrls = period_start === period_end;
    const signedMap = new Map<string, string>();

    const photosList = (photosRes as {
      data?: Array<{ shift_id: number; type: string; storage_path: string | null; captured_at: string | null; meta: Record<string, unknown> | null }>;
    }).data ?? [];

    if (includeEvidenceUrls && photosList.length > 0) {
      const uniquePaths = [...new Set(photosList.map((p) => p.storage_path).filter((p): p is string => !!p))];
      if (uniquePaths.length > 0) {
        const { data: signedUrls, error: signedError } = await clientAdmin.storage
          .from("shift-evidence")
          .createSignedUrls(uniquePaths, 60 * 60);
        if (signedError) {
          throw { code: 500, message: "No se pudieron firmar evidencias", category: "SYSTEM", details: signedError };
        }
        for (const item of (signedUrls ?? []) as Array<{ path: string; signedUrl?: string | null }>) {
          if (item?.signedUrl) signedMap.set(item.path, item.signedUrl);
        }
      }
    }

    const shiftEmployeeMap = new Map<number, string>();
    for (const shift of (shifts ?? [])) {
      shiftEmployeeMap.set(Number(shift.id), String(shift.employee_id));
    }

    for (const photo of photosList) {
      if (!photo.storage_path) continue;

      if (photo.type === "inicio" && !startEvidence.has(photo.shift_id)) {
        startEvidence.set(photo.shift_id, photo.storage_path);
      }
      if (photo.type === "fin" && !endEvidence.has(photo.shift_id)) {
        endEvidence.set(photo.shift_id, photo.storage_path);
      }

      const meta = (photo.meta && typeof photo.meta === "object") ? (photo.meta as Record<string, unknown>) : {};
      const areaLabel = typeof meta.area_label === "string" ? meta.area_label : null;
      const subareaLabel = typeof meta.subarea_label === "string" ? meta.subarea_label : null;
      const photoLabel = typeof meta.photo_label === "string" ? meta.photo_label : null;
      const zone = buildZoneWithSubzone(meta);
      const shiftRestaurantId = Number((shifts ?? []).find((s) => Number(s.id) === Number(photo.shift_id))?.restaurant_id ?? NaN);
      const restaurantName = Number.isFinite(shiftRestaurantId)
        ? (restaurantNameMap.get(shiftRestaurantId) ?? `#${shiftRestaurantId}`)
        : "N/A";
      const employeeIdForShift = shiftEmployeeMap.get(Number(photo.shift_id)) ?? "";
      const employeeName = userNameMap.get(employeeIdForShift) ?? "Sin nombre";

      const entry = evidenceByShift.get(photo.shift_id) ?? { start: [], end: [], startUrls: [], endUrls: [] };
      const signedUrl = signedMap.get(photo.storage_path) ?? "";
      const payload = {
        path: photo.storage_path,
        captured_at: photo.captured_at ?? null,
        area_label: areaLabel,
        subarea_label: subareaLabel,
        photo_label: photoLabel,
        zone,
        restaurant_name: restaurantName,
        signed_url: signedUrl,
        employee_name: employeeName,
        watermark_text: buildEvidenceWatermarkText({ captured_at: photo.captured_at ?? null, zone, restaurant_name: restaurantName, employee_name: employeeName }),
      };

      if (photo.type === "inicio") {
        entry.start.push(payload);
        const url = signedMap.get(photo.storage_path);
        if (url) entry.startUrls.push(url);
      }
      if (photo.type === "fin") {
        entry.end.push(payload);
        const url = signedMap.get(photo.storage_path);
        if (url) entry.endUrls.push(url);
      }
      evidenceByShift.set(photo.shift_id, entry);
    }

    const scheduledByShiftId = new Map<number, { scheduled_start: string | null; scheduled_end: string | null }>();
    for (const row of ((scheduledRes as { data?: Array<{ started_shift_id: number | null; scheduled_start: string | null; scheduled_end: string | null }> }).data ?? [])) {
      if (row.started_shift_id == null) continue;
      const key = Number(row.started_shift_id);
      if (!Number.isFinite(key)) continue;
      if (!scheduledByShiftId.has(key)) {
        scheduledByShiftId.set(key, { scheduled_start: row.scheduled_start ?? null, scheduled_end: row.scheduled_end ?? null });
      }
    }

    const incidentsCount = new Map<number, number>();
    for (const incident of ((incidentsRes as { data?: Array<{ shift_id: number }> }).data ?? [])) {
      const key = Number(incident.shift_id);
      incidentsCount.set(key, (incidentsCount.get(key) ?? 0) + 1);
    }

    const rows = (shifts ?? []).map((s) => {
      const start = s.start_time ? new Date(String(s.start_time)) : null;
      const end = s.end_time ? new Date(String(s.end_time)) : null;
      const hours = start && end ? Math.max(0, (end.getTime() - start.getTime()) / 3600000) : null;
      const scheduled = scheduledByShiftId.get(Number(s.id));
      const scheduled_hours = diffHours(String(scheduled?.scheduled_start ?? null), String(scheduled?.scheduled_end ?? null));
      const ended_early =
        !!scheduled?.scheduled_end &&
        !!s.end_time &&
        new Date(String(s.end_time)).getTime() < new Date(String(scheduled.scheduled_end)).getTime();
      const evidenceEntry = evidenceByShift.get(Number(s.id));
      const startUrls = evidenceEntry?.startUrls ?? [];
      const endUrls = evidenceEntry?.endUrls ?? [];
      return {
        shift_id: s.id,
        employee_id: s.employee_id,
        employee_name: userNameMap.get(String(s.employee_id)) ?? null,
        restaurant_id: s.restaurant_id,
        restaurant_name: restaurantNameMap.get(Number(s.restaurant_id)) ?? null,
        start_time: s.start_time,
        end_time: s.end_time,
        hours_worked: hours == null ? null : Number(hours.toFixed(2)),
        worked_hours: hours == null ? null : Number(hours.toFixed(2)),
        scheduled_start: scheduled?.scheduled_start ?? null,
        scheduled_end: scheduled?.scheduled_end ?? null,
        scheduled_hours,
        state: s.state,
        status: s.status,
        ended_early,
        early_end_reason: (s as { early_end_reason?: string | null }).early_end_reason ?? null,
        approved_by: s.approved_by ?? null,
        approved_by_name: s.approved_by ? userNameMap.get(String(s.approved_by)) ?? null : null,
        rejected_by: s.rejected_by ?? null,
        rejected_by_name: s.rejected_by ? userNameMap.get(String(s.rejected_by)) ?? null : null,
        supervisor_name: s.approved_by
          ? userNameMap.get(String(s.approved_by)) ?? null
          : s.rejected_by
            ? userNameMap.get(String(s.rejected_by)) ?? null
            : null,
        start_evidence_path: startEvidence.get(Number(s.id)) ?? null,
        end_evidence_path: endEvidence.get(Number(s.id)) ?? null,
        start_evidences: evidenceEntry?.start ?? [],
        end_evidences: evidenceEntry?.end ?? [],
        start_evidence_urls: startUrls,
        end_evidence_urls: endUrls,
        start_evidence_count: evidenceEntry?.start.length ?? 0,
        end_evidence_count: evidenceEntry?.end.length ?? 0,
        incidents_count: incidentsCount.get(Number(s.id)) ?? 0,
      };
    });

    const evidenceRowsForExport: EvidenceForExport[] = [];
    if (includeEvidenceUrls) {
      for (const row of rows) {
        const startEvidences = (row.start_evidences as Array<Record<string, unknown>> | undefined) ?? [];
        const endEvidences = (row.end_evidences as Array<Record<string, unknown>> | undefined) ?? [];

        const startValid = startEvidences.filter((ev) => typeof ev.signed_url === "string" && ev.signed_url.length > 0);
        const endValid = endEvidences.filter((ev) => typeof ev.signed_url === "string" && ev.signed_url.length > 0);

        const startByZone = new Map<string, Array<Record<string, unknown>>>();
        const endByZone = new Map<string, Array<Record<string, unknown>>>();
        const zoneOrder: string[] = [];

        const pushByZone = (target: Map<string, Array<Record<string, unknown>>>, evidence: Record<string, unknown>) => {
          const zoneLabel = String(evidence.zone ?? "Zona no especificada");
          const zoneKey = normalizeColumnKey(zoneLabel);
          if (!target.has(zoneKey)) {
            target.set(zoneKey, []);
          }
          if (!zoneOrder.includes(zoneKey)) {
            zoneOrder.push(zoneKey);
          }
          target.get(zoneKey)?.push(evidence);
        };

        startValid.forEach((ev) => pushByZone(startByZone, ev));
        endValid.forEach((ev) => pushByZone(endByZone, ev));

        for (const zoneKey of zoneOrder) {
          const starts = startByZone.get(zoneKey) ?? [];
          const ends = endByZone.get(zoneKey) ?? [];
          const pairCount = Math.max(starts.length, ends.length);

          for (let idx = 0; idx < pairCount; idx += 1) {
            const evStart = starts[idx];
            if (evStart) {
              evidenceRowsForExport.push({
                shift_id: Number(row.shift_id),
                phase: "Antes",
                index: idx + 1,
                path: String(evStart.path ?? ""),
                signed_url: String(evStart.signed_url),
                captured_at: (evStart.captured_at as string | null) ?? null,
                zone: String(evStart.zone ?? "Zona no especificada"),
                restaurant_name: String(evStart.restaurant_name ?? (row.restaurant_name ?? "N/A")),
                employee_name: String(evStart.employee_name ?? (row.employee_name ?? "Sin nombre")),
                watermark_text: String(evStart.watermark_text ?? ""),
              });
            }

            const evEnd = ends[idx];
            if (evEnd) {
              evidenceRowsForExport.push({
                shift_id: Number(row.shift_id),
                phase: "Despues",
                index: idx + 1,
                path: String(evEnd.path ?? ""),
                signed_url: String(evEnd.signed_url),
                captured_at: (evEnd.captured_at as string | null) ?? null,
                zone: String(evEnd.zone ?? "Zona no especificada"),
                restaurant_name: String(evEnd.restaurant_name ?? (row.restaurant_name ?? "N/A")),
                employee_name: String(evEnd.employee_name ?? (row.employee_name ?? "Sin nombre")),
                watermark_text: String(evEnd.watermark_text ?? ""),
              });
            }
          }
        }
      }
    }

    const totalScheduledHours = rows.reduce((acc, r) => acc + (r.scheduled_hours ?? 0), 0);
    const totalWorkedHours = rows.reduce((acc, r) => acc + (r.hours_worked ?? 0), 0);

    const csvHeader = selectedColumns;
    const csvHeaderLabels = selectedColumns.map((col) => columnLabel[col] ?? col);
    const csvBody = rows
      .map((r) =>
        csvHeader
          .map((h) => csvEscape(formatValue(r as Record<string, unknown>, h, "csv")))
          .join(",")
      )
      .join("\n");
    const csvContent = `sep=,\n${csvHeaderLabels.join(",")}\n${csvBody}`;

    const pdfHeaderLine = selectedColumns.map((col) => {
      const label = columnLabel[col] ?? col;
      return label;
    });

    const baseWidths = selectedColumns.map((col) => {
      const widthMap: Record<string, number> = {
        restaurant_name: 24,
        employee_name: 20,
        supervisor_name: 20,
        start_time: 17,
        end_time: 17,
        scheduled_start: 17,
        scheduled_end: 17,
        scheduled_hours: 10,
        hours_worked: 10,
        incidents_count: 9,
        state: 12,
        status: 12,
        early_end_reason: 18,
        start_evidence_path: 14,
        end_evidence_path: 14,
        start_evidence_count: 10,
        end_evidence_count: 10,
        employee_id: 14,
        restaurant_id: 12,
        shift_id: 10,
        approved_by: 14,
        approved_by_name: 18,
        rejected_by: 14,
        rejected_by_name: 18,
      };
      return widthMap[col] ?? Math.max(10, (columnLabel[col] ?? col).length);
    });

    const minWidths = selectedColumns.map(() => 6);
    const pdfFontSize = 8;
    const pdfLineHeight = 10;
    const pdfPageWidth = 842;
    const pdfPageHeight = 595;
    const pdfStartX = 30;
    const approxCharWidth = pdfFontSize * 0.6;
    const availableWidth = pdfPageWidth - pdfStartX - 30;
    const maxLineWidth = Math.max(100, Math.min(170, Math.floor(availableWidth / approxCharWidth)));
    const widths = [...baseWidths];
    const totalWidth = () => widths.reduce((acc, w) => acc + w, 0) + Math.max(0, widths.length - 1) * 3;
    while (totalWidth() > maxLineWidth) {
      let maxIdx = 0;
      for (let i = 1; i < widths.length; i += 1) {
        if (widths[i] > widths[maxIdx]) maxIdx = i;
      }
      if (widths[maxIdx] <= minWidths[maxIdx]) break;
      widths[maxIdx] -= 1;
    }

    const headerLine = selectedColumns
      .map((col, idx) => formatCell(columnLabel[col] ?? col, widths[idx]).padEnd(widths[idx], " "))
      .join(" | ");
    const separator = "-".repeat(Math.min(headerLine.length, maxLineWidth));

    const dataLines = rows.map((r) =>
      selectedColumns
        .map((col, idx) => formatCell(formatValue(r as Record<string, unknown>, col, "pdf"), widths[idx]).padEnd(widths[idx], " "))
        .join(" | ")
    );

    const totalHours = rows.reduce((acc, r) => acc + (r.hours_worked ?? 0), 0);
    const restaurantLabel = requestedRestaurantId == null
      ? "TODOS"
      : (restaurantNameMap.get(Number(requestedRestaurantId)) ?? `#${requestedRestaurantId}`);
    const infoLines = [
      `Reporte restaurante: ${restaurantLabel}`,
      `Periodo: ${period_start} a ${period_end}`,
      `Generado: ${formatDateTime(generatedAt)}`,
      `Total turnos: ${rows.length}`,
      `Horas trabajadas: ${formatDuration(totalHours)}`,
      `Horas programadas: ${formatDuration(totalScheduledHours)}`,
    ];

    const maxLinesPerPage = Math.max(25, Math.floor((pdfPageHeight - 60) / pdfLineHeight));
    const pages: string[][] = [];
    let current: string[] = [];
    const pushPage = () => {
      if (current.length > 0) pages.push(current);
      current = [];
    };

    const appendLines = (lines: string[]) => {
      for (const line of lines) {
        if (current.length >= maxLinesPerPage) {
          pushPage();
          current.push("Reporte (continuacion)");
          current.push(...[headerLine, separator]);
        }
        current.push(line);
      }
    };

    appendLines(infoLines);
    current.push(headerLine);
    current.push(separator);
    appendLines(dataLines);
    pushPage();

    const reportJson = {
      report_id: null,
      restaurant_id,
      period_start,
      period_end,
      generated_at: generatedAt,
      generated_by: user.id,
      filtros_json,
      totals: {
        shifts: rows.length,
        hours_worked: Number(rows.reduce((acc, r) => acc + (r.hours_worked ?? 0), 0).toFixed(2)),
        total_scheduled_hours: Number(totalScheduledHours.toFixed(2)),
        total_worked_hours: Number(totalWorkedHours.toFixed(2)),
        restaurant_worked_hours_total: Number(totalWorkedHours.toFixed(2)),
        restaurant_scheduled_hours_total: Number(totalScheduledHours.toFixed(2)),
      },
      columns: selectedColumns,
      evidence_mode: includeEvidenceUrls ? "single_day_with_watermark" : "standard",
      rows,
    };

    const uploadOperations: Array<Promise<unknown>> = [];
    const csvPath = `${basePath}.csv`;
    const xlsxPath = `${basePath}.xlsx`;
    const pdfPath = `${basePath}.pdf`;

    const exportFormat = payload.export_format ?? "both";
    const includeCsv = exportFormat === "csv";
    const includeXlsx = exportFormat === "xlsx" || exportFormat === "both";
    const includePdf = exportFormat === "pdf" || exportFormat === "both";

    if (includeCsv) {
      uploadOperations.push(
        clientAdmin.storage.from("reports").upload(csvPath, new Blob([csvContent], { type: "text/csv; charset=utf-8" }), {
          contentType: "text/csv; charset=utf-8",
          upsert: true,
        })
      );
    }

    if (includeXlsx) {
      const xlsxBinary = buildXlsxWorkbook(rows as Array<Record<string, unknown>>, selectedColumns, csvHeaderLabels, {
        restaurantLabel,
        period_start,
        period_end,
        generatedAt,
        totalShifts: rows.length,
        totalHours,
        totalScheduledHours,
      }, evidenceRowsForExport.map((ev) => ({
        shift_id: ev.shift_id,
        phase: ev.phase,
        index: ev.index,
        photo_url: ev.signed_url,
        captured_at: ev.captured_at ? formatDateTime(ev.captured_at) : "No disponible",
        zone: ev.zone,
        restaurant_name: ev.restaurant_name,
        employee_name: ev.employee_name,
        watermark_text: ev.watermark_text,
      })));
      uploadOperations.push(
        clientAdmin.storage.from("reports").upload(
          xlsxPath,
          new Blob([xlsxBinary], {
            type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
          }),
          {
            contentType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
            upsert: true,
          }
        )
      );
    }

    if (includePdf) {
      const pdfBytes = includeEvidenceUrls
        ? await buildSingleDayPdfWithEvidence({
            restaurantLabel,
            periodStart: period_start,
            periodEnd: period_end,
            generatedAt,
            totalShifts: rows.length,
            totalHours,
            totalScheduledHours,
            evidenceRows: evidenceRowsForExport,
          })
        : buildPagedPdf(pages, {
            pageWidth: pdfPageWidth,
            pageHeight: pdfPageHeight,
            fontSize: pdfFontSize,
            lineHeight: pdfLineHeight,
            startX: pdfStartX,
            startY: pdfPageHeight - 40,
          });

      uploadOperations.push(
        clientAdmin.storage.from("reports").upload(
          pdfPath,
          new Blob([pdfBytes], { type: "application/pdf" }),
          {
          contentType: "application/pdf",
          upsert: true,
          }
        )
      );
    }

    uploadOperations.push(
      clientAdmin.storage.from("reports").upload(file_path, new Blob([JSON.stringify(reportJson, null, 2)], { type: "application/json" }), {
        contentType: "application/json",
        upsert: true,
      })
    );

    let persistRestaurantId = requestedRestaurantId;
    if (persistRestaurantId == null) {
      persistRestaurantId = restaurantIds.length > 0 ? Number(restaurantIds[0]) : null;
    }
    if (persistRestaurantId == null) {
      const { data: fallbackRestaurant, error: fallbackRestaurantError } = await clientAdmin
        .from("restaurants")
        .select("id")
        .eq("is_active", true)
        .order("id", { ascending: true })
        .limit(1)
        .single();
      if (fallbackRestaurantError || !fallbackRestaurant?.id) {
        throw {
          code: 409,
          message: "No se encontro restaurante de referencia para guardar el reporte",
          category: "BUSINESS",
          details: fallbackRestaurantError,
        };
      }
      persistRestaurantId = Number(fallbackRestaurant.id);
    }

    const uploads = await Promise.all(uploadOperations);
    for (const uploaded of uploads) {
      const typed = uploaded as { error?: unknown };
      if (typed?.error) {
        throw { code: 500, message: "No se pudieron subir artefactos del reporte", category: "SYSTEM", details: typed.error };
      }
    }

    let url_excel = "";
    let url_pdf = "";

    if (includeCsv) {
      const { data: csvSigned, error: csvSignedError } = await clientAdmin.storage.from("reports").createSignedUrl(csvPath, 60 * 60 * 24 * 7);
      if (csvSignedError || !csvSigned?.signedUrl) {
        throw { code: 500, message: "No se pudo generar URL firmada CSV", category: "SYSTEM", details: csvSignedError };
      }
      url_excel = csvSigned.signedUrl;
    }

    if (includeXlsx) {
      const { data: xlsxSigned, error: xlsxSignedError } = await clientAdmin.storage.from("reports").createSignedUrl(xlsxPath, 60 * 60 * 24 * 7);
      if (xlsxSignedError || !xlsxSigned?.signedUrl) {
        throw { code: 500, message: "No se pudo generar URL firmada XLSX", category: "SYSTEM", details: xlsxSignedError };
      }
      url_excel = xlsxSigned.signedUrl;
    }

    if (includePdf) {
      const { data: pdfSigned, error: pdfSignedError } = await clientAdmin.storage.from("reports").createSignedUrl(pdfPath, 60 * 60 * 24 * 7);
      if (pdfSignedError || !pdfSigned?.signedUrl) {
        throw { code: 500, message: "No se pudo generar URL firmada PDF", category: "SYSTEM", details: pdfSignedError };
      }
      url_pdf = pdfSigned.signedUrl;
    }

    const insertClient = user.role === "supervisora" ? clientAdmin : clientUser;
    const { data, error } = await insertClient
      .from("reports")
      .insert({
        restaurant_id: persistRestaurantId,
        period_start,
        period_end,
        generated_by: user.id,
        generado_por: user.id,
        generated_at: generatedAt,
        filtros_json,
        file_path,
        hash_documento,
        url_pdf,
        url_excel,
      })
      .select("id, generated_at, file_path, hash_documento, url_pdf, url_excel")
      .single();

    if (error || !data) {
      throw { code: 409, message: "No se pudo generar reporte", category: "BUSINESS", details: error };
    }

    await safeWriteAudit({
      user_id: user.id,
      action: "REPORT_GENERATE",
      context: {
        report_id: data.id,
        requested_restaurant_scope: requestedRestaurantId == null ? "all" : requestedRestaurantId,
        requested_employee_scope: requestedEmployeeId == null ? "all" : requestedEmployeeId,
        restaurant_id,
        period_start,
        period_end,
        file_path: data.file_path ?? file_path,
        hash_documento: data.hash_documento ?? hash_documento,
      },
      request_id,
    });

    const successPayload = {
      success: true,
      data: {
        report_id: data.id,
        generated_at: data.generated_at ?? generatedAt,
        file_path: data.file_path ?? file_path,
        hash_documento: data.hash_documento ?? hash_documento,
        url_pdf: data.url_pdf ?? url_pdf,
        url_excel: data.url_excel ?? url_excel,
        totals: reportJson.totals,
      },
      error: null,
      request_id,
    };
    await safeFinalizeIdempotency({ userId: user.id, endpoint, key: idempotencyKey, statusCode: 200, responseBody: successPayload });

    return response(true, successPayload.data, null, request_id);
  } catch (err) {
    const apiError = errorHandler(err, request_id);
    status = apiError.code;
    error_code = apiError.category;

    if (userId && idempotencyKey) {
      const failPayload = { success: false, data: null, error: apiError, request_id };
      await safeFinalizeIdempotency({ userId, endpoint, key: idempotencyKey, statusCode: apiError.code, responseBody: failPayload });
    }

    return response(false, null, apiError, request_id);
  } finally {
    logRequest({
      request_id,
      endpoint,
      method: req.method,
      ip,
      user_agent: userAgent,
      user: userId && userRole ? { id: userId, role: userRole } : undefined,
      duration_ms: Date.now() - startedAt,
      status,
      error_code,
    });
  }
});
