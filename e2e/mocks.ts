import type { Route } from "@playwright/test";
import type {
  ApiError,
  BeforeLaunchView,
  Campaign,
  CampaignListItem,
  CompanyRecord,
  FileCheckResult,
  ImportRecord,
  LeadSearchResult,
  CallTaskView,
  NeedsAttention,
  PersonRecord,
  RecordCalls,
  RecordControls,
  CampaignDetail,
  ControlRefusal,
} from "../src/shared/api.ts";

/**
 * The only way browser tests fake a response. Every body must be one of the real response
 * types, so when the API changes shape a stale mock fails typecheck instead of rendering
 * "undefined" in evidence. ESLint forbids calling route.fulfill anywhere else in e2e/.
 */
export type MockBody =
  | ApiError
  | LeadSearchResult
  | { campaigns: CampaignListItem[] }
  | { campaign: Campaign; imports: ImportRecord[] }
  | (PersonRecord & RecordCalls & RecordControls)
  | (CompanyRecord & RecordCalls & RecordControls)
  | CampaignDetail
  | ControlRefusal
  | FileCheckResult
  | BeforeLaunchView
  | NeedsAttention
  | CallTaskView;

export function respond(route: Route, body: MockBody, status = 200): Promise<void> {
  // eslint-disable-next-line no-restricted-syntax -- the one typed entry point
  return route.fulfill({ status, json: body });
}

export function serverError(route: Route): Promise<void> {
  return respond(route, { error: { code: "internal", message: "Something went wrong on the server." } }, 500);
}

export function refusedPair(route: Route): Promise<void> {
  return respond(
    route,
    { error: { code: "invalid_export", message: "Nothing was imported.", problems: [{ file: "pair", message: "These two files don’t belong together." }] } },
    400,
  );
}
