import type { TestContacts } from "../test-contacts.ts";
import { MESSAGE_REQUEST_CHANNELS, SOCIAL_CHANNEL_LIST, SOCIAL_CHANNELS, type MessageRequestChannel, type SocialChannel } from "../social-channels.ts";

/**
 * Run test's boundary (ADR 0003 "Ticket 21"): what it reads, in the transaction that would start the run, and the
 * first reason it is refused for, in this order. Null: it starts.
 */
export interface RunTestFacts {
  readonly running: boolean;
  readonly contacts: TestContacts;
  /** Whether a person's or company's live detail now has the stored test email, or mobile. */
  readonly leadHas: { readonly email: boolean; readonly mobile: boolean } & { readonly [C in SocialChannel]?: boolean };
  readonly leads: number;
  /** The lead to render as is an enrollment of this campaign. */
  readonly renderAsOfCampaign: boolean;
  /** The campaign's main sequence has no live track (question Q9). */
  readonly nothingToLaunch: boolean;
  readonly storedVersion: number;
  readonly expectedVersion: number;
}

export const TEST_REFUSALS = {
  running: "A test is already running. Stop it to run another.",
  noContacts: "Add your own email or mobile first.",
  emailIsALead: "Your test email belongs to a lead now. Test contacts must be your own.",
  mobileIsALead: "Your test mobile belongs to a lead now. Test contacts must be your own.",
  linkedinIsALead: "Your test LinkedIn profile belongs to a lead now. Test contacts must be your own.",
  noLeads: "Import leads first: a test renders its copy for a real lead.",
  renderAs: "That lead is not in this campaign.",
  nothing: "Add a track to test.",
  changed: "The sequence changed since you looked. Look again, then run the test.",
} as const;

export function runTestRefusal(f: RunTestFacts): string | null {
  if (f.running) return TEST_REFUSALS.running;
  if (f.storedVersion !== f.expectedVersion) return TEST_REFUSALS.changed;
  if (f.contacts.email === null && f.contacts.mobile === null && SOCIAL_CHANNEL_LIST.every((c) => (f.contacts[c] ?? null) === null)) return TEST_REFUSALS.noContacts;
  if (f.leadHas.email) return TEST_REFUSALS.emailIsALead;
  if (f.leadHas.mobile) return TEST_REFUSALS.mobileIsALead;
  if (f.leadHas.linkedin === true) return TEST_REFUSALS.linkedinIsALead;
  for (const c of MESSAGE_REQUEST_CHANNELS) if (f.leadHas[c] === true) return `Your test ${SOCIAL_CHANNELS[c].name} account belongs to a lead now. Test contacts must be your own.`;
  if (f.nothingToLaunch) return TEST_REFUSALS.nothing;
  if (f.leads === 0) return TEST_REFUSALS.noLeads;
  if (!f.renderAsOfCampaign) return TEST_REFUSALS.renderAs;
  return null;
}

/** The refusal of a test contact a lead's record has (the boundary): by field. */
export const CONTACT_IS_A_LEAD = {
  email: "This email belongs to a lead. Test contacts must be your own.",
  mobile: "This number belongs to a lead. Test contacts must be your own.",
  linkedin: "This LinkedIn profile belongs to a lead. Test contacts must be your own.",
} as const;

/** A message-request channel's test account a person's or company's record has (ADR 0004 13.8's boundary). */
export const accountIsALead = (channel: MessageRequestChannel): string => `This ${SOCIAL_CHANNELS[channel].name} account belongs to a lead or a company. Test contacts must be your own.`;
