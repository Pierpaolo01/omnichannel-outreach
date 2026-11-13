/** Limits the server enforces and the web client explains. */
export const CAMPAIGN_NAME_MAX = 100;

/**
 * The largest save of a campaign's sequence, as its JSON body, in bytes: 56 KiB, below the 64 KiB a
 * browser lets a request carry past the page's end (keepalive), so a save on leaving can always
 * carry the newest draft (ADR 0003 1.1.1).
 */
export const DEFINITION_MAX_BYTES = 57_344;

/** An email's copy and subject, in characters (the server refuses longer). */
export const STEP_BODY_MAX = 20_000;
export const STEP_SUBJECT_MAX = 1_000;
