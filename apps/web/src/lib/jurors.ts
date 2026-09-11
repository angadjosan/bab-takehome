import { JURORS_URL } from "./config";

/**
 * Fire-and-forget nudge to the juror service after openDispute. It only tells the service to look at
 * the chain; nothing here is trusted or awaited. A text/plain body keeps it a simple CORS request
 * (no preflight), and keepalive lets it finish even if the page navigates away.
 */
export function wakeJurors(disputeId: bigint): void {
  if (!JURORS_URL) return;
  try {
    void fetch(`${JURORS_URL}/api/wake`, {
      method: "POST",
      headers: { "content-type": "text/plain" },
      body: JSON.stringify({ disputeId: disputeId.toString() }),
      keepalive: true,
    }).catch(() => undefined);
  } catch {
    /* never block the dispute flow */
  }
}
