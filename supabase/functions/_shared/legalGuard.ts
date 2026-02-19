import { clientAdmin } from "./supabaseClient.ts";

type ActiveLegalTerm = {
  id: number;
  code: string;
  title: string;
  version: string;
  content: string;
};

export async function getActiveLegalTerm(): Promise<ActiveLegalTerm> {
  const { data, error } = await clientAdmin
    .from("legal_terms_versions")
    .select("id, code, title, version, content")
    .eq("is_active", true)
    .order("created_at", { ascending: false })
    .limit(1)
    .single();

  if (error || !data) {
    throw { code: 503, message: "No hay version legal activa configurada", category: "SYSTEM", details: error };
  }

  return data as ActiveLegalTerm;
}

export async function hasAcceptedActiveLegalTerm(userId: string): Promise<{ accepted: boolean; accepted_at: string | null; legal_terms_id: number | null }> {
  const active = await getActiveLegalTerm();
  const { data, error } = await clientAdmin
    .from("user_legal_acceptances")
    .select("accepted_at, legal_terms_id")
    .eq("user_id", userId)
    .eq("legal_terms_id", active.id)
    .order("accepted_at", { ascending: false })
    .limit(1)
    .maybeSingle();

  if (error) {
    throw { code: 500, message: "No se pudo validar consentimiento legal", category: "SYSTEM", details: error };
  }

  return {
    accepted: Boolean(data),
    accepted_at: (data?.accepted_at as string | null) ?? null,
    legal_terms_id: (data?.legal_terms_id as number | null) ?? null,
  };
}

export async function requireAcceptedActiveLegalTerm(userId: string): Promise<void> {
  const status = await hasAcceptedActiveLegalTerm(userId);
  if (!status.accepted) {
    throw { code: 403, message: "Debe aceptar tratamiento de datos para continuar", category: "PERMISSION" };
  }
}

