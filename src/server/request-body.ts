/**
 * Request bodies of the HTTP interface. Every body, and every object inside one, refuses fields it
 * does not know, so a request for behaviour this release does not have is refused with a plain 400
 * instead of being half applied (verifier B4 on a1399ce). `requestObject` is the only way a route
 * declares a body; the lint rule in eslint.config.js refuses `z.object` in src/server.
 */
import { z } from "zod";

export const requestObject = z.strictObject;

/** Fields a later release adds, with what to tell the user who sends one now. */
const LATER_RELEASE: Readonly<Record<string, string>> = {
  redial: "Redial arrives with a later release: log the outcome without it.",
  callbackAt: "Callbacks arrive with a later release: log the outcome without it.",
  callback: "Callbacks arrive with a later release: log the outcome without it.",
  declined: "Not interested arrives with a later release.",
  declinedPath: "Not interested arrives with a later release.",
};

/** One plain message for a body that did not parse; unknown fields are named, and nothing was changed. */
export function invalidBodyMessage(error: z.ZodError): string {
  const unknown = error.issues.flatMap((issue) => (issue.code === "unrecognized_keys" ? issue.keys : []));
  if (unknown.length > 0) {
    const later = [...new Set(unknown.flatMap((k) => (LATER_RELEASE[k] ? [LATER_RELEASE[k]] : [])))];
    return `${later.length > 0 ? `${later.join(" ")} ` : ""}Nothing was changed. (Fields this release does not accept: ${[...new Set(unknown)].join(", ")}.)`;
  }
  return error.issues.map((issue) => issue.message).join(" ") || "The request body is not valid.";
}
