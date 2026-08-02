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
import { formatAtSite, safeTimezone } from "../_shared/timezone.ts";
import { WORKTRACE_LOGO_PNG_BASE64 } from "./worktraceLogo.ts";
import { WORKTRACE_LOGO_NEW_PNG_BASE64 } from "./worktraceLogoNew.ts";
import { VERIFIK_LOGO_PNG_BASE64 } from "./verifikLogo.ts";
import { R3_LOGO_PNG_BASE64 } from "./r3Logo.ts";

const endpoint = "reports_generate";
const payloadSchema = z.object({
  // Which dataset the report covers. "shifts" (default) keeps the historic
  // contractor report untouched; "audits" reports quality inspections
  // (supervisor_presence) with the same request/response contract.
  report_type: z.enum(["shifts", "audits"]).optional(),
  restaurant_id: z.union([commonSchemas.restaurantId, z.literal("all"), z.null()]).optional(),
  employee_id: z.union([z.string().uuid(), z.literal("all"), z.null()]).optional(),
  // Only used by the audits report: which inspector to filter by ("all"/null = every one).
  supervisor_id: z.union([z.string().uuid(), z.literal("all"), z.null()]).optional(),
  // Single-shift report: when present the other filters are ignored and the report
  // covers just this shift. period_start/period_end become optional in that case.
  shift_id: commonSchemas.shiftId.optional(),
  period_start: commonSchemas.dateYmd.optional(),
  period_end: commonSchemas.dateYmd.optional(),
  filtros_json: z.record(z.any()).optional(),
  columns: z.array(z.string().min(1).max(64)).max(100).optional(),
  export_format: z.enum(["csv", "pdf", "both", "xlsx", "excel"]).optional(),
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
  early_end_reason: "Observaciones",
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
  }>,
  taskRows?: Array<{
    shift_id: number;
    restaurant_name: string;
    task_id: number;
    task_title: string;
    task_description: string;
    task_status: string;
    requires_evidence: string;
    created_at: string;
    created_by: string;
    completed_at: string;
    completed_by: string;
    notes: string;
    evidence_count: number;
    evidence_urls: string;
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

  if (taskRows && taskRows.length > 0) {
    const taskHeader = [
      "Turno",
      "Restaurante",
      "Tarea",
      "Titulo",
      "Descripcion",
      "Estado",
      "Requiere evidencia",
      "Creada",
      "Creada por (inspector)",
      "Completada",
      "Completada por (contratista)",
      "Notas",
      "N evidencias",
      "URLs evidencia",
    ];
    const taskData: Array<Array<string | number>> = [taskHeader];
    for (const row of taskRows) {
      taskData.push([
        row.shift_id,
        row.restaurant_name,
        row.task_id,
        row.task_title,
        row.task_description,
        row.task_status,
        row.requires_evidence,
        row.created_at,
        row.created_by,
        row.completed_at,
        row.completed_by,
        row.notes,
        row.evidence_count,
        row.evidence_urls,
      ]);
    }

    const taskSheet = XLSX.utils.aoa_to_sheet(taskData as unknown[][]);
    taskSheet["!cols"] = [
      { wch: 10 },
      { wch: 26 },
      { wch: 10 },
      { wch: 32 },
      { wch: 48 },
      { wch: 14 },
      { wch: 16 },
      { wch: 18 },
      { wch: 26 },
      { wch: 18 },
      { wch: 26 },
      { wch: 40 },
      { wch: 12 },
      { wch: 80 },
    ];
    XLSX.utils.book_append_sheet(workbook, taskSheet, "Tareas del sitio");
  }

  return XLSX.write(workbook, { type: "array", bookType: "xlsx", compression: true });
}

type EvidenceForExport = {
  shift_id: number;
  // "Tarea" documents evidence the contractor attached when closing a site task.
  phase: "Antes" | "Despues" | "Tarea";
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

  const fitTextByWidth = (rawTxt: string, maxWidth: number, fontSize: number) => {
    const txt = pdfSafeText(rawTxt); // WinAnsi-safe before measuring/drawing
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
    ["Restaurante", pdfSafeText(params.restaurantLabel), "Periodo", `${params.periodStart} a ${params.periodEnd}`],
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
      page.drawText(pdfSafeText(ev.signed_url).slice(0, 95), { x: frameX + 10, y: frameY + frameH - 48, size: 8, font, color: rgb(0.2, 0.2, 0.2) });
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
    const fit = (rawTxt: string, max = 88) => {
      const txt = pdfSafeText(rawTxt); // WinAnsi-safe before drawing
      return txt.length > max ? `${txt.slice(0, max - 3)}...` : txt;
    };

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

// ---------------------------------------------------------------------------
// Audits report (supervisor_presence). Kept fully self-contained so it never
// touches the contractor-shift pipeline: same request/response contract, its
// own data query and its own XLSX/PDF builders.
// ---------------------------------------------------------------------------

type AuditReportRow = {
  audit_id: number;
  restaurant_id: number;
  restaurant_name: string;
  supervisor_name: string;
  phase: string | null;
  recorded_at: string;
  local_date: string;
  local_time: string;
  timezone: string;
  observations: string;
  evidence_count: number;
  evidences: Array<{ path: string; signed_url: string | null; mime_type: string | null; is_video: boolean }>;
};

function auditPhaseLabel(phase: string | null): string {
  if (phase === "start") return "Inicio";
  if (phase === "end") return "Cierre";
  return phase ? String(phase) : "-";
}

// pdf-lib's built-in Helvetica is WinAnsi (cp1252) and throws on any character it
// can't encode. Intl.DateTimeFormat emits U+202F (narrow no-break space) between
// the time and AM/PM even in en-US, and user-typed names/observations can carry
// curly quotes, dashes or emoji from phone keyboards -- all of which crash the PDF
// before it returns. Normalise the common ones to ASCII, then replace anything
// still outside Latin-1 printable with '?'. Everything drawn into a PDF goes
// through here.
function pdfSafeText(input: unknown): string {
  return String(input ?? "")
    // Every whitespace variant (incl. U+202F narrow no-break from Intl) -> normal space; keep tab/newline/CR.
    .replace(/\s/g, (ch) => (ch === "\t" || ch === "\n" || ch === "\r" ? ch : " "))
    // Typographic punctuation -> ASCII.
    .replace(/[\u2018\u2019\u201A\u201B]/g, "'")
    .replace(/[\u201C\u201D\u201E\u201F]/g, '"')
    .replace(/[\u2013\u2014]/g, "-")
    .replace(/\u2026/g, "...")
    // Keep tab/newline/CR, ASCII printable and Latin-1 printable; drop the rest (WinAnsi-safe).
    .replace(/[^\x09\x0A\x0D\x20-\x7E\xA0-\xFF]/g, "?");
}
function buildAuditsXlsx(
  meta: { restaurantLabel: string; supervisorLabel: string; periodStart: string; periodEnd: string; generatedAt: string },
  rows: AuditReportRow[]
): Uint8Array {
  const header = [
    "Fecha (sitio)",
    "Hora (sitio)",
    "Zona horaria",
    "Sitio",
    "Supervisor",
    "Fase",
    "Observaciones",
    "N.º evidencias",
    "URLs de evidencias",
  ];

  const dataRows = rows.map((r) => [
    r.local_date,
    r.local_time,
    r.timezone,
    r.restaurant_name,
    r.supervisor_name,
    auditPhaseLabel(r.phase),
    r.observations,
    r.evidence_count,
    r.evidences.map((e) => e.signed_url).filter(Boolean).join("\n"),
  ]);

  const aoa: Array<Array<string | number>> = [
    ["Reporte de auditorías de calidad"],
    [`Sitio: ${meta.restaurantLabel}`],
    [`Supervisor: ${meta.supervisorLabel}`],
    [`Periodo: ${meta.periodStart} a ${meta.periodEnd}`],
    [`Generado: ${formatDateTime(meta.generatedAt)}`],
    [`Total auditorías: ${rows.length}`],
    [],
    header,
    ...dataRows,
  ];

  const sheet = XLSX.utils.aoa_to_sheet(aoa);
  sheet["!cols"] = [
    { wch: 14 }, { wch: 12 }, { wch: 20 }, { wch: 24 }, { wch: 24 },
    { wch: 10 }, { wch: 50 }, { wch: 12 }, { wch: 60 },
  ];
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, sheet, "Auditorías");
  return new Uint8Array(XLSX.write(wb, { type: "array", bookType: "xlsx" }));
}

async function buildAuditsPdf(
  meta: { restaurantLabel: string; supervisorLabel: string; periodStart: string; periodEnd: string; generatedAt: string },
  rows: AuditReportRow[]
): Promise<Uint8Array> {
  const pdfDoc = await PDFDocument.create();
  const font = await pdfDoc.embedFont(StandardFonts.Helvetica);
  const bold = await pdfDoc.embedFont(StandardFonts.HelveticaBold);
  const pageW = 595;
  const pageH = 842;
  const marginX = 40;

  // Sanitize here so every string that reaches drawText is WinAnsi-safe.
  const fit = (text: string, size: number, f = font, maxW = pageW - 2 * marginX) => {
    let t = pdfSafeText(text);
    while (t.length > 0 && f.widthOfTextAtSize(t, size) > maxW) t = t.slice(0, -1);
    return t;
  };

  // --- Summary + table pages ---
  const totalEvidence = rows.reduce((acc, r) => acc + r.evidence_count, 0);
  let page = pdfDoc.addPage([pageW, pageH]);
  let y = pageH - 50;

  page.drawRectangle({ x: marginX, y: y - 6, width: pageW - 2 * marginX, height: 30, color: rgb(0.05, 0.05, 0.05) });
  page.drawText("REPORTE DE AUDITORIAS DE CALIDAD", { x: marginX + 10, y: y + 3, size: 13, font: bold, color: rgb(1, 1, 1) });
  y -= 40;

  for (const line of [
    `Sitio: ${meta.restaurantLabel}`,
    `Supervisor: ${meta.supervisorLabel}`,
    `Periodo: ${meta.periodStart} a ${meta.periodEnd}`,
    `Generado: ${formatDateTime(meta.generatedAt)}`,
    `Total auditorias: ${rows.length}   |   Total evidencias: ${totalEvidence}`,
  ]) {
    page.drawText(fit(line, 10), { x: marginX, y, size: 10, font, color: rgb(0.2, 0.2, 0.2) });
    y -= 16;
  }
  y -= 8;

  // Table header
  const cols = [
    { label: "Fecha", x: marginX, w: 62 },
    { label: "Hora", x: marginX + 62, w: 42 },
    { label: "Sitio", x: marginX + 104, w: 96 },
    { label: "Supervisor", x: marginX + 200, w: 104 },
    { label: "Fase", x: marginX + 304, w: 44 },
    { label: "Obs.", x: marginX + 348, w: 130 },
    { label: "Fotos", x: marginX + 478, w: 36 },
  ];
  const drawTableHeader = () => {
    page.drawRectangle({ x: marginX, y: y - 4, width: pageW - 2 * marginX, height: 18, color: rgb(0.9, 0.9, 0.9) });
    for (const c of cols) page.drawText(c.label, { x: c.x + 3, y, size: 8.5, font: bold, color: rgb(0.15, 0.15, 0.15) });
    y -= 20;
  };
  drawTableHeader();

  for (const r of rows) {
    if (y < 60) {
      page = pdfDoc.addPage([pageW, pageH]);
      y = pageH - 50;
      drawTableHeader();
    }
    const cells = [
      r.local_date,
      r.local_time,
      fit(r.restaurant_name, 8, font, cols[2].w - 6),
      fit(r.supervisor_name, 8, font, cols[3].w - 6),
      auditPhaseLabel(r.phase),
      fit(r.observations || "-", 8, font, cols[5].w - 6),
      String(r.evidence_count),
    ];
    // pdfSafeText again on the raw cells (local_time carries the U+202F from Intl).
    cells.forEach((val, i) => page.drawText(pdfSafeText(val), { x: cols[i].x + 3, y, size: 8, font, color: rgb(0.2, 0.2, 0.2) }));
    y -= 14;
  }

  // --- One documented page per photo, embedding the image with a metadata caption.
  // Bounded so a wide date range can't blow the edge-function memory/time budget.
  const MAX_EMBEDDED_PHOTOS = 60;
  let embedded = 0;
  for (const r of rows) {
    for (const ev of r.evidences) {
      if (embedded >= MAX_EMBEDDED_PHOTOS) break;
      if (!ev.signed_url || ev.is_video) continue;
      try {
        const resp = await fetch(ev.signed_url);
        if (!resp.ok) continue;
        const bytes = new Uint8Array(await resp.arrayBuffer());
        const mime = (ev.mime_type ?? "").toLowerCase();
        let img: any = null;
        if (mime.includes("png")) img = await pdfDoc.embedPng(bytes);
        else {
          try { img = await pdfDoc.embedJpg(bytes); } catch { img = await pdfDoc.embedPng(bytes); }
        }
        if (!img) continue;

        const p = pdfDoc.addPage([pageW, pageH]);
        p.drawText("EVIDENCIA DE AUDITORIA", { x: marginX, y: pageH - 45, size: 12, font: bold, color: rgb(0.1, 0.1, 0.1) });

        const maxW = pageW - 2 * marginX;
        const maxH = 520;
        const scale = Math.min(maxW / img.width, maxH / img.height, 1);
        const w = img.width * scale;
        const h = img.height * scale;
        p.drawImage(img, { x: (pageW - w) / 2, y: pageH - 70 - h, width: w, height: h });

        let capY = pageH - 70 - h - 24;
        for (const line of [
          `Sitio: ${r.restaurant_name}`,
          `Supervisor: ${r.supervisor_name}`,
          `Fecha/Hora (sitio): ${r.local_date} ${r.local_time} (${r.timezone})`,
          `Fase: ${auditPhaseLabel(r.phase)}`,
          r.observations ? `Observaciones: ${r.observations}` : "",
        ]) {
          if (!line) continue;
          p.drawText(fit(line, 9), { x: marginX, y: capY, size: 9, font, color: rgb(0.2, 0.2, 0.2) });
          capY -= 14;
        }
        embedded += 1;
      } catch {
        // Skip an unreadable photo rather than fail the whole report.
      }
    }
    if (embedded >= MAX_EMBEDDED_PHOTOS) break;
  }

  return await pdfDoc.save();
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

    const { restaurant_id, employee_id } = payload;
    const singleShiftId = typeof payload.shift_id === "number" ? payload.shift_id : null;
    // Mutable because a single-shift report derives its period from the shift itself.
    let period_start = payload.period_start ?? "";
    let period_end = payload.period_end ?? "";

    // A single-shift report supplies its own period; otherwise the range is required.
    if (singleShiftId == null) {
      if (!period_start || !period_end) {
        throw { code: 422, message: "period_start y period_end son requeridos", category: "VALIDATION" };
      }
      if (period_start > period_end) {
        throw { code: 422, message: "Rango de fechas invalido", category: "VALIDATION" };
      }
    }

    const requestedRestaurantId = typeof restaurant_id === "number" ? restaurant_id : null;
    const requestedEmployeeId = typeof employee_id === "string" && employee_id !== "all" ? employee_id : null;

    // --- Audits report: self-contained branch, returns before any shift logic. ---
    if ((payload.report_type ?? "shifts") === "audits") {
      if (!period_start || !period_end) {
        throw { code: 422, message: "period_start y period_end son requeridos para el reporte de auditorias", category: "VALIDATION" };
      }
      const requestedSupervisorId =
        typeof payload.supervisor_id === "string" && payload.supervisor_id !== "all" ? payload.supervisor_id : null;
      const generatedAtAudits = new Date().toISOString();

      // Whole calendar days at UTC bounds; the front already sends a ±1 day buffer
      // for the Pacific/Bogota offset, and the end day is included in full.
      const startIso = `${period_start}T00:00:00.000Z`;
      const endIso = `${period_end}T23:59:59.999Z`;

      let auditQuery = clientAdmin
        .from("supervisor_presence_logs")
        .select("id, supervisor_id, restaurant_id, phase, recorded_at, notes, evidence_path, evidence_mime_type")
        .gte("recorded_at", startIso)
        .lte("recorded_at", endIso)
        .order("recorded_at", { ascending: false })
        .limit(2000);
      if (requestedRestaurantId != null) auditQuery = auditQuery.eq("restaurant_id", requestedRestaurantId);
      if (requestedSupervisorId != null) auditQuery = auditQuery.eq("supervisor_id", requestedSupervisorId);

      const { data: auditLogs, error: auditErr } = await auditQuery;
      if (auditErr) {
        throw { code: 409, message: "No se pudieron consultar auditorias", category: "BUSINESS", details: auditErr };
      }
      const logs = auditLogs ?? [];

      const rIds = [...new Set(logs.map((l) => Number(l.restaurant_id)).filter((n) => Number.isFinite(n)))];
      const sIds = [...new Set(logs.map((l) => String(l.supervisor_id)).filter(Boolean))];

      const [restRes, supRes, evRes] = await Promise.all([
        rIds.length ? clientAdmin.from("restaurants").select("id, name, timezone").in("id", rIds) : Promise.resolve({ data: [] }),
        sIds.length ? clientAdmin.from("users").select("id, full_name, email").in("id", sIds) : Promise.resolve({ data: [] }),
        logs.length
          ? clientAdmin
              .from("supervisor_presence_evidences")
              .select("id, presence_id, storage_path, mime_type")
              .in("presence_id", logs.map((l) => l.id))
          : Promise.resolve({ data: [] }),
      ]);

      const restMap = new Map((restRes.data ?? []).map((r) => [Number(r.id), r]));
      const supMap = new Map((supRes.data ?? []).map((u) => [String(u.id), u]));
      const evByPresence = new Map<string, Array<Record<string, unknown>>>();
      for (const e of evRes.data ?? []) {
        const key = String(e.presence_id);
        const arr = evByPresence.get(key) ?? [];
        arr.push(e);
        evByPresence.set(key, arr);
      }

      // Sign every evidence path once (multi-evidence table + legacy single photo).
      const allPaths = new Set<string>();
      for (const arr of evByPresence.values()) for (const e of arr) if (e.storage_path) allPaths.add(String(e.storage_path));
      for (const l of logs) if (l.evidence_path) allPaths.add(String(l.evidence_path));
      const signedByPath = new Map<string, string>();
      const paths = [...allPaths];
      if (paths.length > 0) {
        const { data: signed } = await clientAdmin.storage.from("shift-evidence").createSignedUrls(paths, 7200);
        (signed ?? []).forEach((s, i) => {
          if (s && s.signedUrl && !s.error) signedByPath.set(paths[i], s.signedUrl);
        });
      }

      const isVideo = (mime: unknown) => typeof mime === "string" && mime.toLowerCase().startsWith("video/");

      const auditRows: AuditReportRow[] = logs.map((l) => {
        const rest = restMap.get(Number(l.restaurant_id)) as { name?: string; timezone?: string } | undefined;
        const tz = safeTimezone(rest?.timezone);
        const sup = supMap.get(String(l.supervisor_id)) as { full_name?: string; email?: string } | undefined;
        const local = formatAtSite(l.recorded_at, tz);

        const evs = (evByPresence.get(String(l.id)) ?? []).map((e) => ({
          path: String(e.storage_path ?? ""),
          signed_url: e.storage_path ? signedByPath.get(String(e.storage_path)) ?? null : null,
          mime_type: (e.mime_type as string | null) ?? null,
          is_video: isVideo(e.mime_type),
        }));
        if (l.evidence_path && !evs.some((e) => e.path === l.evidence_path)) {
          evs.push({
            path: String(l.evidence_path),
            signed_url: signedByPath.get(String(l.evidence_path)) ?? null,
            mime_type: (l.evidence_mime_type as string | null) ?? null,
            is_video: isVideo(l.evidence_mime_type),
          });
        }

        return {
          audit_id: Number(l.id),
          restaurant_id: Number(l.restaurant_id),
          restaurant_name: String(rest?.name ?? `#${l.restaurant_id}`),
          supervisor_name: String(sup?.full_name ?? sup?.email ?? "—"),
          phase: (l.phase as string | null) ?? null,
          recorded_at: String(l.recorded_at),
          local_date: local?.local_date ?? period_start,
          local_time: local?.local_time ?? "",
          timezone: tz,
          observations: String(l.notes ?? ""),
          evidence_count: evs.length,
          evidences: evs,
        };
      });

      const restaurantLabel =
        requestedRestaurantId != null
          ? String((restMap.get(requestedRestaurantId) as { name?: string } | undefined)?.name ?? `#${requestedRestaurantId}`)
          : "TODOS";
      const supervisorLabel =
        requestedSupervisorId != null
          ? String((supMap.get(requestedSupervisorId) as { full_name?: string; email?: string } | undefined)?.full_name ??
              (supMap.get(requestedSupervisorId) as { email?: string } | undefined)?.email ??
              requestedSupervisorId)
          : "TODOS";

      const auditsMeta = {
        restaurantLabel,
        supervisorLabel,
        periodStart: period_start,
        periodEnd: period_end,
        generatedAt: generatedAtAudits,
      };

      const filtrosAudits = {
        report_type: "audits",
        period_start,
        period_end,
        restaurant_scope: requestedRestaurantId == null ? "all" : requestedRestaurantId,
        supervisor_scope: requestedSupervisorId == null ? "all" : requestedSupervisorId,
        total_audits: auditRows.length,
      };
      const hashAudits = await hashCanonicalJson(filtrosAudits);

      const xlsxBytes = buildAuditsXlsx(auditsMeta, auditRows);
      const pdfBytes = await buildAuditsPdf(auditsMeta, auditRows);

      const scopeR = requestedRestaurantId == null ? "all" : String(requestedRestaurantId);
      const scopeS = requestedSupervisorId == null ? "all" : requestedSupervisorId;
      const basePathA = `reports/audits/${scopeR}/${scopeS}/${period_start}_${period_end}/${request_id}`;
      const xlsxPathA = `${basePathA}.xlsx`;
      const pdfPathA = `${basePathA}.pdf`;

      // Both files always produced: the reports row requires url_pdf and url_excel
      // NOT NULL, and the front picks which to download per export_format.
      await Promise.all([
        clientAdmin.storage.from("reports").upload(
          xlsxPathA,
          new Blob([xlsxBytes], { type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" }),
          { contentType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", upsert: true }
        ),
        clientAdmin.storage.from("reports").upload(
          pdfPathA,
          new Blob([pdfBytes], { type: "application/pdf" }),
          { contentType: "application/pdf", upsert: true }
        ),
      ]);

      const weekSeconds = 60 * 60 * 24 * 7;
      const [{ data: xlsxSigned }, { data: pdfSigned }] = await Promise.all([
        clientAdmin.storage.from("reports").createSignedUrl(xlsxPathA, weekSeconds),
        clientAdmin.storage.from("reports").createSignedUrl(pdfPathA, weekSeconds),
      ]);

      // reports.restaurant_id is NOT NULL; for an all-sites report fall back to the
      // first site in the result, or any active site if the range was empty.
      let persistRestaurantIdA = requestedRestaurantId;
      if (persistRestaurantIdA == null) {
        persistRestaurantIdA = rIds.length > 0 ? Number(rIds[0]) : null;
      }
      if (persistRestaurantIdA == null) {
        const { data: anyRest } = await clientAdmin.from("restaurants").select("id").eq("is_active", true).limit(1).maybeSingle();
        persistRestaurantIdA = anyRest?.id ? Number(anyRest.id) : null;
      }
      if (persistRestaurantIdA == null) {
        throw { code: 409, message: "No hay sitios para asociar el reporte de auditorias", category: "BUSINESS" };
      }

      const insertClientA = user.role === "supervisora" ? clientAdmin : clientUser;
      const { data: reportRowA, error: reportErrA } = await insertClientA
        .from("reports")
        .insert({
          restaurant_id: persistRestaurantIdA,
          period_start,
          period_end,
          generated_by: user.id,
          generado_por: user.id,
          generated_at: generatedAtAudits,
          filtros_json: filtrosAudits,
          file_path: `${basePathA}.pdf`,
          hash_documento: hashAudits,
          url_pdf: pdfSigned?.signedUrl ?? "",
          url_excel: xlsxSigned?.signedUrl ?? "",
        })
        .select("id, generated_at, file_path, hash_documento, url_pdf, url_excel")
        .single();

      if (reportErrA || !reportRowA) {
        throw { code: 409, message: "No se pudo generar reporte de auditorias", category: "BUSINESS", details: reportErrA };
      }

      await safeWriteAudit({
        user_id: user.id,
        action: "REPORT_GENERATE",
        context: {
          report_id: reportRowA.id,
          report_type: "audits",
          restaurant_scope: filtrosAudits.restaurant_scope,
          supervisor_scope: filtrosAudits.supervisor_scope,
          period_start,
          period_end,
          total_audits: auditRows.length,
        },
        request_id,
      });

      const successPayloadA = {
        success: true,
        data: {
          report_id: reportRowA.id,
          report_type: "audits",
          generated_at: reportRowA.generated_at ?? generatedAtAudits,
          file_path: reportRowA.file_path ?? `${basePathA}.pdf`,
          hash_documento: reportRowA.hash_documento ?? hashAudits,
          url_pdf: reportRowA.url_pdf ?? pdfSigned?.signedUrl ?? "",
          url_excel: reportRowA.url_excel ?? xlsxSigned?.signedUrl ?? "",
          totals: { audits: auditRows.length, evidences: auditRows.reduce((a, r) => a + r.evidence_count, 0) },
          rows: auditRows,
        },
        error: null,
        request_id,
      };
      await safeFinalizeIdempotency({ userId: user.id, endpoint, key: idempotencyKey, statusCode: 200, responseBody: successPayloadA });
      return response(true, successPayloadA.data, null, request_id);
    }

    // Supervisora can operate on any active restaurant; scope enforced at UI level.

    // Single-shift report: load the shift up front to derive its period. Setting
    // period_start === period_end makes the pipeline use the single-day evidence
    // PDF (photos embedded with traceability), which is exactly what one shift
    // wants. The date is taken in the SITE's clock so a cross-midnight shift lands
    // on the day it started, not the UTC day.
    if (singleShiftId != null) {
      const preClient = user.role === "supervisora" ? clientAdmin : clientUser;
      const { data: oneShift, error: oneShiftError } = await preClient
        .from("shifts")
        .select("id, restaurant_id, start_time")
        .eq("id", singleShiftId)
        .maybeSingle();
      if (oneShiftError) {
        throw { code: 409, message: "No se pudo consultar el turno", category: "BUSINESS", details: oneShiftError };
      }
      if (!oneShift) {
        throw { code: 404, error_code: "SHIFT_NOT_FOUND", message: "Turno no encontrado", category: "BUSINESS" };
      }
      const { data: siteRow } = await clientAdmin
        .from("restaurants")
        .select("timezone")
        .eq("id", Number(oneShift.restaurant_id))
        .maybeSingle();
      const siteTz = safeTimezone((siteRow as { timezone?: string | null } | null)?.timezone);
      const dayKey = formatAtSite(oneShift.start_time, siteTz)?.local_date ?? String(oneShift.start_time).slice(0, 10);
      period_start = dayKey;
      period_end = dayKey;
    }

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
      shift_id: singleShiftId,
      restaurant_scope: singleShiftId != null ? "single_shift" : requestedRestaurantId == null ? "all" : requestedRestaurantId,
      employee_scope: singleShiftId != null ? "single_shift" : requestedEmployeeId == null ? "all" : requestedEmployeeId,
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
      .order("start_time", { ascending: true });

    if (singleShiftId != null) {
      // The other filters are ignored on purpose: the report covers exactly this shift.
      shiftsQuery = shiftsQuery.eq("id", singleShiftId);
    } else {
      shiftsQuery = shiftsQuery.gte("start_time", fromIso).lte("start_time", toIso);
      if (requestedRestaurantId != null) {
        shiftsQuery = shiftsQuery.eq("restaurant_id", requestedRestaurantId);
      }
      if (requestedEmployeeId != null) {
        shiftsQuery = shiftsQuery.eq("employee_id", requestedEmployeeId);
      }
    }

    const { data: shifts, error: shiftsError } = await shiftsQuery;

    if (shiftsError) {
      throw { code: 409, message: "No se pudieron consultar turnos para el reporte", category: "BUSINESS", details: shiftsError };
    }

    const employeeIds = [...new Set((shifts ?? []).map((s) => String(s.employee_id)).filter((id) => id && id !== "null"))];
    const supervisorIds = [...new Set((shifts ?? []).map((s) => [s.approved_by, s.rejected_by]).flat().filter(Boolean).map((id) => String(id)))];
    const restaurantIds = [...new Set((shifts ?? []).map((s) => Number(s.restaurant_id)).filter((id) => Number.isFinite(id)))];
    const shiftIds = (shifts ?? []).map((s) => s.id);

    // Site tasks are attached to a shift when they were COMPLETED during it
    // (same restaurant), or linked to it directly. Bound the query by the span of
    // the shifts in this report so we don't scan the whole table.
    const shiftInstants = (shifts ?? [])
      .flatMap((s) => [s.start_time, s.end_time])
      .filter((t) => !!t)
      .map((t) => String(t))
      .sort();
    const tasksFrom = shiftInstants[0] ?? null;
    const tasksTo = shiftInstants[shiftInstants.length - 1] ?? null;

    const [usersRes, restaurantsRes, photosRes, incidentsRes, scheduledRes, tasksRes] = await Promise.all([
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
      restaurantIds.length && tasksFrom && tasksTo
        ? clientAdmin
            .from("operational_tasks")
            .select(
              "id, shift_id, restaurant_id, title, description, status, requires_evidence, created_at, created_by, resolved_at, resolved_by, resolution_notes, evidence_path, evidence_mime_type, evidence_items"
            )
            .in("restaurant_id", restaurantIds)
            .not("resolved_at", "is", null)
            .gte("resolved_at", tasksFrom)
            .lte("resolved_at", tasksTo)
            .order("resolved_at", { ascending: true })
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
    if ((tasksRes as { error?: unknown }).error) {
      throw { code: 409, message: "No se pudieron cargar tareas del sitio", category: "BUSINESS", details: (tasksRes as { error?: unknown }).error };
    }
    if ((scheduledRes as { error?: unknown }).error) {
      throw { code: 409, message: "No se pudieron cargar turnos programados", category: "BUSINESS", details: (scheduledRes as { error?: unknown }).error };
    }

    const userNameMap = new Map((usersRes as { data?: Array<{ id: string; full_name: string | null }> }).data?.map((u) => [String(u.id), u.full_name ?? null]) ?? []);
    const restaurantNameMap = new Map((restaurantsRes as { data?: Array<{ id: number; name: string | null }> }).data?.map((r) => [Number(r.id), r.name ?? null]) ?? []);

    const startEvidence = new Map<number, string>();
    const endEvidence = new Map<number, string>();
    // "observations" holds the attachments the contractor adds next to the
    // Observaciones text (uploaded as type='fin' with meta.source='observations').
    // They are reported in their own block, apart from the regular end photos (#4).
    const evidenceByShift = new Map<
      number,
      {
        start: Array<Record<string, unknown>>;
        end: Array<Record<string, unknown>>;
        observations: Array<Record<string, unknown>>;
        startUrls: string[];
        endUrls: string[];
        observationsUrls: string[];
      }
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

      const meta = (photo.meta && typeof photo.meta === "object") ? (photo.meta as Record<string, unknown>) : {};
      // Attachments tied to the Observaciones field are reported separately (#4).
      const isObservation = meta.source === "observations";

      if (photo.type === "inicio" && !startEvidence.has(photo.shift_id)) {
        startEvidence.set(photo.shift_id, photo.storage_path);
      }
      if (photo.type === "fin" && !isObservation && !endEvidence.has(photo.shift_id)) {
        endEvidence.set(photo.shift_id, photo.storage_path);
      }

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

      const entry = evidenceByShift.get(photo.shift_id) ?? { start: [], end: [], observations: [], startUrls: [], endUrls: [], observationsUrls: [] };
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

      const url = signedMap.get(photo.storage_path);
      if (isObservation) {
        // Observaciones attachments (photo or video) go in their own block.
        entry.observations.push(payload);
        if (url) entry.observationsUrls.push(url);
      } else if (photo.type === "inicio") {
        entry.start.push(payload);
        if (url) entry.startUrls.push(url);
      } else if (photo.type === "fin") {
        entry.end.push(payload);
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

    // ---- Site tasks: attach each completed task to the shift it was done in.
    const taskRowsRaw = ((tasksRes as { data?: Array<Record<string, unknown>> }).data ?? []);

    // Inspectors/contractors on tasks may not be in userNameMap yet.
    const missingTaskUserIds = [
      ...new Set(
        taskRowsRaw
          .flatMap((t) => [t.created_by, t.resolved_by])
          .filter((v): v is string => typeof v === "string" && v.length > 0)
      ),
    ].filter((id) => !userNameMap.has(id));

    if (missingTaskUserIds.length > 0) {
      const { data: extraUsers } = await clientAdmin.from("users").select("id, full_name").in("id", missingTaskUserIds);
      for (const u of ((extraUsers ?? []) as Array<{ id: string; full_name: string | null }>)) {
        userNameMap.set(u.id, u.full_name ?? "Sin nombre");
      }
    }

    const taskEvidenceEntries = (t: Record<string, unknown>): Array<{ path: string; mime_type: string | null }> => {
      const items = Array.isArray(t.evidence_items) ? t.evidence_items : null;
      if (items && items.length > 0) {
        return items
          .map((it) => it as { path?: string; mime_type?: string } | null)
          .filter((it): it is { path: string; mime_type?: string } => typeof it?.path === "string" && it.path.length > 0)
          .map((it) => ({ path: it.path, mime_type: it.mime_type ?? null }));
      }
      return typeof t.evidence_path === "string" && t.evidence_path.length > 0
        ? [{ path: t.evidence_path, mime_type: (t.evidence_mime_type as string | null) ?? null }]
        : [];
    };

    const allTaskEvidencePaths = [...new Set(taskRowsRaw.flatMap((t) => taskEvidenceEntries(t).map((e) => e.path)))];
    const taskSignedMap = new Map<string, string>();
    if (allTaskEvidencePaths.length > 0) {
      const { data: signedTaskUrls } = await clientAdmin.storage
        .from("shift-evidence")
        .createSignedUrls(allTaskEvidencePaths, 60 * 60 * 24 * 7);
      ((signedTaskUrls ?? []) as Array<{ signedUrl?: string | null }>).forEach((s, i) => {
        if (s?.signedUrl) taskSignedMap.set(allTaskEvidencePaths[i], s.signedUrl);
      });
    }

    const looksLikeVideo = (path: string, mime: string | null) => {
      if ((mime ?? "").toLowerCase().startsWith("video/")) return true;
      const p = path.toLowerCase();
      return p.endsWith(".mp4") || p.endsWith(".mov") || p.endsWith(".webm");
    };

    const siteTasksByShift = new Map<number, Array<Record<string, unknown>>>();
    for (const shift of (shifts ?? [])) {
      const sid = Number(shift.id);
      const startedAt = shift.start_time ? new Date(String(shift.start_time)).getTime() : null;
      const endedAt = shift.end_time ? new Date(String(shift.end_time)).getTime() : null;

      const matched = taskRowsRaw.filter((t) => {
        if (Number(t.shift_id) === sid) return true; // linked directly at shift start
        if (Number(t.restaurant_id) !== Number(shift.restaurant_id)) return false;
        if (!t.resolved_at || startedAt == null) return false;
        const doneAt = new Date(String(t.resolved_at)).getTime();
        return doneAt >= startedAt && (endedAt == null || doneAt <= endedAt);
      });

      if (matched.length === 0) continue;

      siteTasksByShift.set(
        sid,
        matched.map((t) => {
          const evidences = taskEvidenceEntries(t).map((e) => ({
            path: e.path,
            mime_type: e.mime_type,
            is_video: looksLikeVideo(e.path, e.mime_type),
            signed_url: taskSignedMap.get(e.path) ?? "",
          }));
          return {
            task_id: t.id,
            title: t.title ?? null,
            description: t.description ?? null,
            status: t.status ?? null,
            requires_evidence: t.requires_evidence === true,
            created_at: t.created_at ?? null,
            created_by: t.created_by ?? null,
            created_by_name: t.created_by ? (userNameMap.get(String(t.created_by)) ?? null) : null,
            completed_at: t.resolved_at ?? null,
            completed_by: t.resolved_by ?? null,
            completed_by_name: t.resolved_by ? (userNameMap.get(String(t.resolved_by)) ?? null) : null,
            notes: t.resolution_notes ?? null,
            evidence_count: evidences.length,
            evidences,
            evidence_urls: evidences.map((e) => e.signed_url).filter((u) => !!u),
          };
        })
      );
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
        // Observaciones: text + its own attachments, apart from the end photos (#4).
        observations: (s as { early_end_reason?: string | null }).early_end_reason ?? null,
        observation_evidences: evidenceEntry?.observations ?? [],
        observation_evidence_urls: evidenceEntry?.observationsUrls ?? [],
        observation_evidence_count: evidenceEntry?.observations.length ?? 0,
        // Site tasks completed during this shift, with their evidence (#9 / AB-5).
        site_tasks: siteTasksByShift.get(Number(s.id)) ?? [],
        site_tasks_count: (siteTasksByShift.get(Number(s.id)) ?? []).length,
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

    const exportFormat = (payload.export_format === "excel" ? "xlsx" : payload.export_format) ?? "both";
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

    // Each task evidence file gets its own documented page in the single-day PDF,
    // using the same layout as shift photos. Videos can't be embedded, so the
    // renderer falls back to printing the signed URL (label marks them as video).
    if (includeEvidenceUrls) {
      for (const row of rows as Array<Record<string, unknown>>) {
        const tasks = (row.site_tasks as Array<Record<string, unknown>> | undefined) ?? [];
        for (const t of tasks) {
          const evidences = (t.evidences as Array<Record<string, unknown>> | undefined) ?? [];
          evidences.forEach((ev, idx) => {
            const url = String(ev.signed_url ?? "");
            if (!url) return;
            const label = `Tarea: ${String(t.title ?? "")}${ev.is_video ? " (video)" : ""}`.trim();
            const completedAt = (t.completed_at as string | null) ?? null;
            const restaurantName = String(row.restaurant_name ?? "");
            const doneBy = String(t.completed_by_name ?? "");
            evidenceRowsForExport.push({
              shift_id: Number(row.shift_id),
              phase: "Tarea",
              index: idx + 1,
              path: String(ev.path ?? ""),
              signed_url: url,
              captured_at: completedAt,
              zone: label,
              restaurant_name: restaurantName,
              employee_name: doneBy,
              watermark_text: buildEvidenceWatermarkText({
                captured_at: completedAt,
                zone: label,
                restaurant_name: restaurantName,
                employee_name: doneBy,
              }),
            });
          });
        }
      }
    }

    // One flat row per site task for the "Tareas del sitio" sheet.
    const taskRowsForExport = (rows as Array<Record<string, unknown>>).flatMap((row) => {
      const tasks = (row.site_tasks as Array<Record<string, unknown>> | undefined) ?? [];
      return tasks.map((t) => ({
        shift_id: Number(row.shift_id),
        restaurant_name: String(row.restaurant_name ?? ""),
        task_id: Number(t.task_id),
        task_title: String(t.title ?? ""),
        task_description: String(t.description ?? ""),
        task_status: String(t.status ?? ""),
        requires_evidence: t.requires_evidence ? "SI" : "NO",
        created_at: formatDateTime((t.created_at as string | null) ?? null),
        created_by: String(t.created_by_name ?? ""),
        completed_at: formatDateTime((t.completed_at as string | null) ?? null),
        completed_by: String(t.completed_by_name ?? ""),
        notes: String(t.notes ?? ""),
        evidence_count: Number(t.evidence_count ?? 0),
        evidence_urls: ((t.evidence_urls as string[] | undefined) ?? []).join(" | "),
      }));
    });

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
      })), taskRowsForExport);
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
