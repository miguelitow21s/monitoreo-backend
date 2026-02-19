import { serve } from "https://deno.land/std@0.224.0/http/server.ts";
import { z } from "npm:zod@3.23.8";
import { authGuard } from "../_shared/authGuard.ts";
import { getActiveLegalTerm, hasAcceptedActiveLegalTerm } from "../_shared/legalGuard.ts";
import { clientAdmin } from "../_shared/supabaseClient.ts";
import { requireMethod, parseBody, requireIdempotencyKey, getClientIp } from "../_shared/validation.ts";
import { claimIdempotency, replayIdempotentResponse, safeFinalizeIdempotency } from "../_shared/idempotency.ts";
import { errorHandler } from "../_shared/errorHandler.ts";
import { response } from "../_shared/response.ts";
import { logRequest } from "../_shared/logger.ts";
import { safeWriteAudit } from "../_shared/auditWriter.ts";
import { hashCanonicalJson } from "../_shared/crypto.ts";

const endpoint = "legal_consent";

const statusSchema = z.object({
  action: z.literal("status"),
});

const acceptSchema = z.object({
  action: z.literal("accept"),
  legal_terms_id: z.number().int().positive().optional(),
});

const payloadSchema = z.discriminatedUnion("action", [statusSchema, acceptSchema]);

serve(async (req) => {
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
    const { user } = await authGuard(req);
    userId = user.id;
    userRole = user.role;

    const payload = await parseBody(req, payloadSchema);
    const activeTerm = await getActiveLegalTerm();

    if (payload.action === "status") {
      const consent = await hasAcceptedActiveLegalTerm(user.id);
      return response(
        true,
        {
          accepted: consent.accepted,
          accepted_at: consent.accepted_at,
          active_term: activeTerm,
        },
        null,
        request_id
      );
    }

    idempotencyKey = requireIdempotencyKey(req);
    const payloadHash = await hashCanonicalJson(payload);
    const claim = await claimIdempotency({ userId: user.id, endpoint, key: idempotencyKey, payloadHash });
    if (claim.type === "replay") {
      status = claim.stored.status_code;
      return replayIdempotentResponse(claim.stored, request_id);
    }

    if (payload.legal_terms_id && payload.legal_terms_id !== activeTerm.id) {
      throw { code: 409, message: "Version legal desactualizada", category: "BUSINESS" };
    }

    const ipAddress = ip === "trusted-proxy-unknown" ? null : ip;

    const { error: insertError } = await clientAdmin
      .from("user_legal_acceptances")
      .upsert(
        {
          user_id: user.id,
          legal_terms_id: activeTerm.id,
          accepted_at: new Date().toISOString(),
          ip_address: ipAddress,
          user_agent: userAgent,
        },
        { onConflict: "user_id,legal_terms_id" }
      );

    if (insertError) {
      throw { code: 409, message: "No se pudo registrar aceptacion legal", category: "BUSINESS", details: insertError };
    }

    await safeWriteAudit({
      user_id: user.id,
      action: "LEGAL_CONSENT_ACCEPT",
      context: {
        legal_terms_id: activeTerm.id,
        legal_code: activeTerm.code,
        legal_version: activeTerm.version,
      },
      request_id,
    });

    const successPayload = {
      success: true,
      data: {
        accepted: true,
        legal_terms_id: activeTerm.id,
        accepted_at: new Date().toISOString(),
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

