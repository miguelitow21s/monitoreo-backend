# Flujo completo Frontend → Backend → DB

1. Frontend envía request HTTPS a Edge Function con token.
2. Edge Function valida token, rol, payload, estado, antifraude, rate limit.
3. Edge Function llama RPC SQL (validaciones, lógica, triggers, auditoría).
4. RLS filtra acceso según rol.
5. Storage solo accesible con signed URL y metadata.
6. Auditoría registra acción, usuario, contexto, request_id.
7. Edge Function retorna respuesta estándar al frontend.
