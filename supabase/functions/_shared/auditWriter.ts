import { clientAdmin } from "./supabaseClient.ts";

export async function writeAudit(params: {
  user_id: string;
  action: string;
  context: Record<string, unknown>;
  request_id: string;
}) {
  const { error } = await clientAdmin.from("audit_logs").insert({
    user_id: params.user_id,
    action: params.action,
    context: params.context,
    request_id: params.request_id,
    created_at: new Date().toISOString(),
  });

  if (error) {
    throw {
      code: 500,
      message: "No se pudo persistir auditoria",
      category: "SYSTEM",
      details: error,
    };
  }
}

export async function safeWriteAudit(params: {
  user_id: string;
  action: string;
  context: Record<string, unknown>;
  request_id: string;
}) {
  try {
    await writeAudit(params);
  } catch (error) {
    console.error(
      JSON.stringify({
        event: "AUDIT_WRITE_ERROR",
        request_id: params.request_id,
        user_id: params.user_id,
        action: params.action,
        error,
      })
    );
  }
}
