// @ts-nocheck
import { serve } from "https://deno.land/std@0.224.0/http/server.ts";
import { z } from "npm:zod@3.23.8";
import { authGuard } from "../_shared/authGuard.ts";
import { roleGuard } from "../_shared/roleGuard.ts";
import { getActiveLegalTerm, hasAcceptedActiveLegalTerm, requireAcceptedActiveLegalTerm } from "../_shared/legalGuard.ts";
import { clientAdmin } from "../_shared/supabaseClient.ts";
import { requireMethod, parseBody, getClientIp } from "../_shared/validation.ts";
import { errorHandler } from "../_shared/errorHandler.ts";
import { response, handleCorsPreflight } from "../_shared/response.ts";
import { logRequest } from "../_shared/logger.ts";

const endpoint = "admin_user_phone_remove";

const payloadSchema = z.object({
  user_id: z.string().uuid(),
});

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

  try {
    requireMethod(req, ["POST"]);
    const { user } = await authGuard(req);
    userId = user.id;
    userRole = user.role;
    roleGuard(user, ["super_admin"]);
    await requireAcceptedActiveLegalTerm(user.id);

    const parsedPayload = await parseBody(req, payloadSchema);
    const payload = parsedPayload as z.infer<typeof payloadSchema>;

    const { data: updatedRow, error: updateError } = await clientAdmin
      .from("users")
      .update({ phone_e164: null, updated_at: new Date().toISOString() })
      .eq("id", payload.user_id)
      .select("id")
      .maybeSingle();

    if (updateError) {
      throw { code: 500, message: "No se pudo borrar el teléfono", category: "SYSTEM", details: updateError };
    }
    if (!updatedRow?.id) {
      throw { code: 404, message: "Usuario no encontrado", category: "BUSINESS" };
    }

    const activeTerm = await getActiveLegalTerm();
    const consent = await hasAcceptedActiveLegalTerm(payload.user_id);

    return response(
      true,
      {
        legal_consent: {
          accepted: consent.accepted,
          accepted_at: consent.accepted_at,
          active_term: activeTerm,
        },
      },
      null,
      request_id
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
