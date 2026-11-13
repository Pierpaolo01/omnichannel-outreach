/**
 * Why an SMS track has no sender number, from the SMS provider's status (`GET /api/sms-provider`):
 * the one wording the inspector and the launch blocker both use (council on 10121d3, item 3), so it
 * stays true when a provider exists and a number is merely not connected. Null when the status has
 * not loaded: nothing is claimed.
 */
import type { SmsProviderStatus } from "../../shared/api.ts";

export function whyNoSmsNumber(status: SmsProviderStatus | null): string | null {
  if (status === null) return null;
  if (status.provider === "none") return "No SMS provider is set up, so no number can be connected yet.";
  if (status.numbers.length === 0) return "The SMS provider lists no number.";
  if (!status.numbers.some((n) => n.healthy)) return "The SMS provider’s numbers can’t send now.";
  return "The SMS provider has numbers, but none is in this campaign’s SMS senders.";
}
