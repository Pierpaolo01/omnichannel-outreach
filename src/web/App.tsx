import { useState, type ReactNode, type SyntheticEvent } from "react";
import { Link, Route, Switch, useLocation, useRoute } from "wouter";
import { Icon, type IconName } from "./icons.tsx";
import { CallsPage } from "./pages/CallsPage.tsx";
import { CampaignsPage } from "./pages/CampaignsPage.tsx";
import { CompanyPage } from "./pages/CompanyPage.tsx";
import { ImportPage } from "./pages/ImportPage.tsx";
import { ImportResultPage } from "./pages/ImportResultPage.tsx";
import { LeadsPage } from "./pages/LeadsPage.tsx";
import { NotFoundPage } from "./pages/NotFoundPage.tsx";
import { PersonPage } from "./pages/PersonPage.tsx";
import { TodayPage } from "./pages/TodayPage.tsx";

const AREAS: readonly { path: string; label: string; icon: IconName }[] = [
  { path: "/", label: "Today", icon: "today" },
  { path: "/calls", label: "Calls", icon: "call" },
  { path: "/leads", label: "Leads", icon: "leads" },
  { path: "/campaigns", label: "Campaigns", icon: "campaigns" },
];

export function App() {
  const [onLeads] = useRoute("/leads");
  return (
    <div className="grid min-h-screen grid-cols-1 grid-rows-[auto_1fr] min-[901px]:grid-cols-[220px_minmax(0,1fr)] min-[901px]:grid-rows-1">
      <a
        href="#main"
        className="sr-only focus:not-sr-only focus:fixed focus:left-4 focus:top-4 focus:z-50 focus:rounded-field focus:bg-base-100 focus:px-3 focus:py-2"
      >
        Skip to content
      </a>
      <Rail />
      <main id="main" className="min-w-0 px-4 pb-24 pt-5 min-[901px]:pl-10 min-[901px]:pr-4 min-[901px]:pt-8">
        <div className="max-w-[1180px]">
          {!onLeads && <QuickSearch />}
          <Switch>
            <Route path="/" component={TodayPage} />
            <Route path="/calls" component={CallsPage} />
            <Route path="/leads" component={LeadsPage} />
            <Route path="/leads/people/:id">{(params) => <PersonPage id={params.id} />}</Route>
            <Route path="/leads/companies/:id">{(params) => <CompanyPage id={params.id} />}</Route>
            <Route path="/campaigns" component={CampaignsPage} />
            <Route path="/campaigns/new">{() => <ImportPage />}</Route>
            <Route path="/campaigns/:id/import">{(params) => <ImportPage campaignId={params.id} />}</Route>
            <Route path="/campaigns/:id/imports/:importId">
              {(params) => <ImportResultPage campaignId={params.id} importId={params.importId} />}
            </Route>
            <Route component={NotFoundPage} />
          </Switch>
        </div>
      </main>
    </div>
  );
}

function Rail() {
  const [location] = useLocation();
  const isActive = (path: string) => (path === "/" ? location === "/" : location === path || location.startsWith(`${path}/`));
  return (
    <aside className="sticky top-0 z-10 flex items-center gap-3 overflow-x-auto border-b border-line bg-base-100 px-4 py-2.5 min-[901px]:h-dvh min-[901px]:flex-col min-[901px]:items-stretch min-[901px]:gap-7 min-[901px]:border-b-0 min-[901px]:border-r min-[901px]:px-3.5 min-[901px]:pb-5 min-[901px]:pt-6">
      <div className="flex items-center gap-2.5 px-2.5 text-[17px] font-bold tracking-[-0.01em]">
        <span className="grid size-[26px] place-items-center rounded-[7px] bg-base-content text-base-200">
          <Icon name="call" className="size-[15px] [stroke-width:2]" />
        </span>
        <span className="max-[900px]:sr-only">Outreach</span>
      </div>
      <nav aria-label="Areas" className="flex gap-0.5 min-[901px]:flex-col">
        {AREAS.map((area) => {
          const active = isActive(area.path);
          return (
            <Link
              key={area.path}
              href={area.path}
              aria-current={active ? "page" : undefined}
              className={`flex items-center gap-[11px] whitespace-nowrap rounded-field px-2.5 py-[9px] font-medium no-underline max-[900px]:px-[9px] max-[900px]:py-[7px] ${
                active ? "bg-base-200 font-semibold text-base-content [&_svg]:text-call" : "text-ink-2 hover:bg-raised"
              }`}
            >
              <Icon name={area.icon} />
              <span>{area.label}</span>
            </Link>
          );
        })}
      </nav>
    </aside>
  );
}

/** The prototype's search above every page but Leads. Enter opens Leads with the query. */
function QuickSearch() {
  const [, navigate] = useLocation();
  const [text, setText] = useState("");
  const submit = (event: SyntheticEvent) => {
    event.preventDefault();
    const q = text.trim();
    navigate(q ? `/leads?q=${encodeURIComponent(q)}` : "/leads");
  };
  return (
    <form role="search" onSubmit={submit} className="mb-[22px] flex justify-end max-[900px]:hidden">
      <label className="input w-[340px] max-w-full border-line bg-base-100 text-muted">
        <Icon name="search" />
        <input
          type="search"
          value={text}
          onChange={(event) => setText(event.target.value)}
          placeholder="Find a lead by name, company, email or phone"
          aria-label="Find a lead"
          className="text-base-content"
        />
      </label>
    </form>
  );
}

export function PageTitle({ children }: { children: ReactNode }) {
  return <h1 className="text-[30px] leading-[1.15] tracking-[-0.02em]">{children}</h1>;
}
