// @ts-nocheck
import { serve } from "https://deno.land/std@0.224.0/http/server.ts";
import { z } from "npm:zod@3.23.8";
import { authGuard } from "../_shared/authGuard.ts";
import { roleGuard } from "../_shared/roleGuard.ts";
import { requireMethod, parseBody, getClientIp } from "../_shared/validation.ts";
import { rateLimiter } from "../_shared/rateLimiter.ts";
import { errorHandler } from "../_shared/errorHandler.ts";
import { response, handleCorsPreflight } from "../_shared/response.ts";
import { logRequest } from "../_shared/logger.ts";
import { safeWriteAudit } from "../_shared/auditWriter.ts";
import { clientAdmin } from "../_shared/supabaseClient.ts";

const endpoint = "supervision_drafts_cleanup";
const evidenceBucket = "shift-evidence";

// Scheduler access: a cron job has no user session, so it authenticates with a
// shared secret instead of a JWT. Disabled (fail closed) when the secret isn't
// configured; only unlocks THIS endpoint. Same scheme as email_notifications_dispatch.
const CRON_DISPATCH_SECRET = (Deno.env.get("CRON_DISPATCH_SECRET") ?? "").trim();

function isAuthorizedCronRequest(req: Request): boolean {
  if (CRON_DISPATCH_SECRET.length < 16) return false;
  const provided = (req.headers.get("x-cron-secret") ?? "").trim();
  if (provided.length !== CRON_DISPATCH_SECRET.length) return false;
  let diff = 0;
  for (let i = 0; i < CRON_DISPATCH_SECRET.length; i += 1) {
    diff |= CRON_DISPATCH_SECRET.charCodeAt(i) ^ provided.charCodeAt(i);
  }
  return diff === 0;
}

const payloadSchema = z.object({
  older_than_hours: z.number().int().min(1).max(168).optional(),
  limit: z.number().int().min(1).max(500).optional(),
});

serve(async (req) => {
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

  try {
    requireMethod(req, ["POST"]);

    // Two ways in: the scheduler's shared secret, or a super_admin session (manual).
    const cronRun = isAuthorizedCronRequest(req);
    if (!cronRun) {
      const { user } = await authGuard(req);
      userId = user.id;
      userRole = user.role;
      roleGuard(user, ["super_admin"]);
    }

    const payload = await parseBody(req, payloadSchema);
    await rateLimiter({
      user_id: cronRun ? "cron-supervision-cleanup" : (userId as string),
      ip,
      endpoint,
      limit: 15,
      window_seconds: 60,
    });

    const olderThanHours = payload.older_than_hours ?? 24;
    const limit = payload.limit ?? 100;
    const cutoffIso = new Date(Date.now() - olderThanHours * 3600_000).toISOString();

    // Abandoned = still in draft and untouched past the cutoff. Oldest first so a
    // capped run always makes progress on the biggest backlog.
    const { data: drafts, error: draftsErr } = await clientAdmin
      .from("supervisor_presence_logs")
      .select("id, restaurant_id, supervisor_id, recorded_at")
      .eq("status", "draft")
      .lt("recorded_at", cutoffIso)
      .order("recorded_at", { ascending: true })
      .limit(limit);
    if (draftsErr) {
      throw { code: 500, message: "No se pudieron listar los drafts abandonados", category: "SYSTEM", details: draftsErr };
    }

    let deleted = 0;
    let withEvidence = 0;
    let blobsRemoved = 0;

    for (const d of drafts ?? []) {
      // Gather the draft's evidence blobs BEFORE deleting the log (the FK cascade
      // would remove the evidence rows and we'd lose the paths).
      const { data: evs } = await clientAdmin
        .from("supervisor_presence_evidences")
        .select("storage_path")
        .eq("presence_id", d.id);
      const paths = (evs ?? [])
        .map((e) => e.storage_path)
        .filter((p): p is string => typeof p === "string" && p.length > 0);
      const evidenceCount = paths.length;

      if (paths.length > 0) {
        const { error: rmErr } = await clientAdmin.storage.from(evidenceBucket).remove(paths);
        if (!rmErr) blobsRemoved += paths.length;
      }

      // Delete the draft; the FK cascade removes its supervisor_presence_evidences.
      const { error: delErr } = await clientAdmin
        .from("supervisor_presence_logs")
        .delete()
        .eq("id", d.id)
        .eq("status", "draft");
      if (delErr) continue; // leave it for the next run

      deleted += 1;
      if (evidenceCount > 0) withEvidence += 1;

      // Monitoring event (front request): an inspector started an audit and never
      // finished. High counts -- especially with evidence -- point to a UX/network
      // problem worth a push. Queryable by supervisor via audit_logs.
      const ageHours = Math.round((Date.now() - new Date(d.recorded_at).getTime()) / 3600_000);
      await safeWriteAudit({
        user_id: String(d.supervisor_id),
        action: "SUPERVISION_DRAFT_ABANDONED",
        context: {
          presence_id: d.id,
          restaurant_id: d.restaurant_id,
          evidence_count: evidenceCount,
          age_hours: ageHours,
        },
        request_id,
      });
    }

    return response(
      true,
      {
        scanned: (drafts ?? []).length,
        deleted,
        with_evidence: withEvidence,
        blobs_removed: blobsRemoved,
        older_than_hours: olderThanHours,
      },
      null,
      request_id,
    );
  } catch (err) {
    const apiError = errorHandler(err, request_id);
    status = apiError.code;
    error_code = apiError.category;
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
