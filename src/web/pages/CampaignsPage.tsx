import { PageTitle } from "../App.tsx";

/**
 * Campaigns. The campaign list, creation, import and import summary screens are being chosen by
 * the principal; this page stays a placeholder with no controls until that choice is made.
 */
export function CampaignsPage() {
  return (
    <div>
      <PageTitle>Campaigns</PageTitle>
      <p className="mt-2 max-w-[64ch] text-muted">
        Creating campaigns and importing scraper exports will be on this page. It isn’t built yet.
      </p>
    </div>
  );
}
