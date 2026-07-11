// runInBackground: execute a promise off the request's critical path so the
// user gets their response immediately. Uses Supabase Edge Runtime's
// `EdgeRuntime.waitUntil` when available (keeps the isolate alive until the task
// finishes); otherwise falls back to a detached best-effort promise.
//
// Used to move slow, non-essential side effects (e.g. dispatching queued emails
// via external HTTP) out of latency-sensitive endpoints like shift start/end.
// The work must be independently durable (the email queue already persists rows),
// because background execution is best-effort, not guaranteed.
export function runInBackground(task: Promise<unknown>): void {
  const safe = Promise.resolve(task).catch((err) => {
    console.error(
      JSON.stringify({ background_task_error: String(err), ts: new Date().toISOString() })
    );
  });

  const edgeRuntime = (globalThis as {
    EdgeRuntime?: { waitUntil?: (p: Promise<unknown>) => void };
  }).EdgeRuntime;

  if (edgeRuntime?.waitUntil) {
    edgeRuntime.waitUntil(safe);
  }
  // Otherwise the promise runs detached (best-effort).
}
