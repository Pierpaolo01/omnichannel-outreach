import { useRef, useState, type DragEvent, type ReactNode, type SyntheticEvent } from "react";
import { Link, useLocation } from "wouter";
import type { Campaign, CampaignListItem, FileCheck, FileCheckResult, ImportRecord } from "../../shared/api.ts";
import { exportProblems, postJson, useApi } from "../api.ts";
import { ErrorState } from "../components.tsx";
import { Icon } from "../icons.tsx";

type Slot = "people" | "businesses";

type ChosenFile =
  | { readonly state: "empty" }
  | { readonly state: "checking"; readonly name: string; readonly text: string }
  | { readonly state: "checked"; readonly name: string; readonly text: string; readonly check: FileCheck };

const SLOT = {
  people: { title: "People file", noun: ["person", "people"], prompt: "Choose the people export, or drop it here.", export: "People" },
  businesses: {
    title: "Businesses file",
    noun: ["business", "businesses"],
    prompt: "Choose the businesses export from the same run.",
    export: "Businesses",
  },
} as const;

/**
 * The guided import form. With no campaign it is New campaign: a name and both files, created and
 * imported in one step. With a campaign it is Import again into that campaign.
 */
export function ImportPage({ campaignId }: { campaignId?: string }) {
  if (campaignId === undefined) return <ImportForm campaign={null} />;
  return <ImportAgain campaignId={campaignId} />;
}

function ImportAgain({ campaignId }: { campaignId: string }) {
  const { result, retry } = useApi<{ campaigns: CampaignListItem[] }>("/api/campaigns");
  if (result.state === "loading") return <div className="skeleton h-40 w-full max-w-[680px]" aria-busy="true" aria-label="Loading" />;
  if (result.state === "error") return <ErrorState title="This campaign didn’t load." message={result.message} onRetry={retry} />;
  const campaign = result.data.campaigns.find((c) => c.id === campaignId);
  if (!campaign) {
    return (
      <div>
        <BackToCampaigns />
        <h1 className="text-[30px] leading-[1.15]">No such campaign</h1>
      </div>
    );
  }
  return <ImportForm campaign={campaign} />;
}

function BackToCampaigns() {
  return (
    <Link href="/campaigns" className="mb-[18px] inline-flex items-center gap-1.5 text-[14px] text-muted no-underline hover:text-base-content">
      <Icon name="back" className="size-4" />
      Campaigns
    </Link>
  );
}

function ImportForm({ campaign }: { campaign: CampaignListItem | null }) {
  const [, navigate] = useLocation();
  const [name, setName] = useState("");
  const [files, setFiles] = useState<Record<Slot, ChosenFile>>({ people: { state: "empty" }, businesses: { state: "empty" } });
  const [pairProblem, setPairProblem] = useState<string | null>(null);
  const [failure, setFailure] = useState<{ message: string; problems: { file: string; message: string }[] } | null>(null);
  const [submitting, setSubmitting] = useState<"import" | "create" | null>(null);
  const latest = useRef(files);

  const check = async (next: Record<Slot, ChosenFile>) => {
    const text = (f: ChosenFile) => (f.state === "empty" ? undefined : f.text);
    try {
      const body = await postJson("/api/scraper-files/check", { peopleCsv: text(next.people), businessesCsv: text(next.businesses) });
      // Same shape as FileCheckResult in src/shared/api.ts.
      const res = body as FileCheckResult;
      if (latest.current !== next) return;
      const settle = (slot: Slot, result: FileCheck | null): ChosenFile => {
        const f = next[slot];
        return f.state === "empty" || result === null ? f : { state: "checked", name: f.name, text: f.text, check: result };
      };
      const settled = { people: settle("people", res.people), businesses: settle("businesses", res.businesses) };
      latest.current = settled;
      setFiles(settled);
      setPairProblem(res.pair);
    } catch (error) {
      const message = error instanceof Error ? error.message : "The file couldn’t be checked.";
      const settled = Object.fromEntries(
        (["people", "businesses"] as const).map((slot) => {
          const f = next[slot];
          return [slot, f.state === "checking" ? { state: "checked", name: f.name, text: f.text, check: { ok: false, message } } : f];
        }),
      ) as Record<Slot, ChosenFile>;
      latest.current = settled;
      setFiles(settled);
    }
  };

  const choose = async (slot: Slot, file: File) => {
    const text = await file.text();
    const next = { ...latest.current, [slot]: { state: "checking", name: file.name, text } satisfies ChosenFile };
    latest.current = next;
    setFiles(next);
    setPairProblem(null);
    setFailure(null);
    void check(next);
  };

  const ready = (f: ChosenFile): f is Extract<ChosenFile, { state: "checked" }> => f.state === "checked" && f.check.ok;
  const bothReady = ready(files.people) && ready(files.businesses) && pairProblem === null;
  const named = campaign !== null || name.trim() !== "";
  const blocker = !named
    ? "Name the campaign first."
    : files.people.state === "empty" || files.businesses.state === "empty"
      ? "Add both files."
      : !bothReady && files.people.state !== "checking" && files.businesses.state !== "checking"
        ? "Fix the file marked above."
        : null;

  const submit = async (mode: "import" | "create") => {
    if (submitting) return;
    setSubmitting(mode);
    setFailure(null);
    const p = files.people;
    const b = files.businesses;
    const filesBody =
      mode === "import" && p.state !== "empty" && b.state !== "empty"
        ? { peopleCsv: p.text, businessesCsv: b.text, fileNames: { people: p.name, businesses: b.name } }
        : {};
    try {
      const body = campaign
        ? await postJson(`/api/campaigns/${campaign.id}/imports`, filesBody)
        : await postJson("/api/campaigns", { name: name.trim(), ...filesBody });
      // Same shape as the create and import responses in src/server/app.ts.
      const created = body as { campaign: Campaign; import?: ImportRecord };
      navigate(created.import ? `/campaigns/${created.campaign.id}/imports/${created.import.id}` : "/campaigns");
    } catch (error) {
      setSubmitting(null);
      setFailure({ message: error instanceof Error ? error.message : "The import failed.", problems: exportProblems(error) });
    }
  };

  const onSubmit = (event: SyntheticEvent) => {
    event.preventDefault();
    if (bothReady && named) void submit("import");
  };

  if (submitting === "import" && ready(files.people) && ready(files.businesses)) {
    return (
      <Importing
        campaignName={campaign?.name ?? name.trim()}
        people={files.people.check.ok ? files.people.check.rows : 0}
        businesses={files.businesses.check.ok ? files.businesses.check.rows : 0}
      />
    );
  }

  const title = campaign ? `Import again into ${campaign.name}` : "New campaign";
  const problemFor = (slot: Slot) => failure?.problems.find((p) => p.file === slot)?.message ?? (slot === "businesses" ? pairProblem : null);

  return (
    <div>
      <BackToCampaigns />
      <h1 className="text-[30px] leading-[1.15] tracking-[-0.02em]">{title}</h1>
      <form onSubmit={onSubmit} className="mt-6 flex max-w-[680px] flex-col gap-[26px]" noValidate>
        {failure && (
          <div role="alert" className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-3 gap-y-1 rounded-xl bg-crit-soft px-4 py-3.5 text-[14px]">
            <Icon name="bad" className="mt-0.5 size-[18px] text-crit" />
            <div>
              <b className="font-semibold">{campaign ? "Nothing was imported." : "Nothing was imported, and the campaign wasn’t created."}</b>
              <p className="text-ink-2">
                {failure.problems.find((p) => p.file === "pair")?.message ?? failure.message}
                {campaign ? "" : " Your campaign name is kept."}
              </p>
            </div>
          </div>
        )}

        {campaign ? (
          <p className="-mt-3 text-[13px] text-muted">
            {campaign.leadCount} {campaign.leadCount === 1 ? "lead" : "leads"} now. Anyone already enrolled is updated with newer details and
            never enrolled twice or restarted.
          </p>
        ) : (
          <div className="flex flex-col gap-1.5">
            <label htmlFor="campaign-name" className="text-[13px] font-semibold text-muted">
              Campaign name
            </label>
            <input
              id="campaign-name"
              type="text"
              className="input h-auto w-full max-w-[460px] border-line-strong bg-base-100 px-3 py-[9px] text-[15px] placeholder:text-faint"
              placeholder="For example: Physiotherapy, Greater London"
              value={name}
              onChange={(event) => setName(event.target.value)}
              autoComplete="off"
            />
          </div>
        )}

        <fieldset className="flex flex-col gap-1.5">
          <legend className="text-[13px] font-semibold text-muted">Scraper files</legend>
          <p className="mb-1.5 mt-[-2px] text-[13px] text-muted">
            The People and Businesses files from one scraper run. Every reachable decision maker becomes a lead; a company with no named
            decision maker becomes a company lead.
          </p>
          <div className="flex max-w-[640px] flex-col gap-2">
            {(["people", "businesses"] as const).map((slot) => (
              <FileRow key={slot} slot={slot} file={files[slot]} problem={problemFor(slot)} onChoose={(file) => void choose(slot, file)} />
            ))}
          </div>
        </fieldset>

        <div className="flex flex-wrap items-center gap-2">
          <button type="submit" className="btn btn-primary font-semibold" disabled={!bothReady || !named || submitting !== null}>
            {campaign ? "Import" : "Create campaign and import"}
          </button>
          {campaign ? (
            <Link href="/campaigns" className="btn btn-ghost font-medium text-muted no-underline">
              Cancel
            </Link>
          ) : (
            <button
              type="button"
              className="btn btn-ghost font-medium text-muted disabled:bg-transparent disabled:text-faint"
              disabled={!named || submitting !== null}
              onClick={() => void submit("create")}
            >
              Create without importing
            </button>
          )}
          {blocker && <span className="text-[13px] text-muted">{blocker}</span>}
        </div>
      </form>
    </div>
  );
}

function FileRow({
  slot,
  file,
  problem,
  onChoose,
}: {
  slot: Slot;
  file: ChosenFile;
  problem: string | null;
  onChoose: (file: File) => void;
}) {
  const input = useRef<HTMLInputElement>(null);
  const [dragging, setDragging] = useState(false);
  const meta = SLOT[slot];
  const failed = file.state === "checked" && !file.check.ok;
  const bad = failed || problem !== null;
  const ok = file.state === "checked" && file.check.ok && problem === null;

  let description: ReactNode = meta.prompt;
  if (file.state === "checking") description = `Checking ${file.name}…`;
  if (file.state === "checked") {
    if (!file.check.ok) description = `${file.name}: ${file.check.message}`;
    else if (problem) description = `${file.name}: ${problem}`;
    else {
      const n = file.check.rows;
      description = `${file.name}. ${n} ${n === 1 ? meta.noun[0] : meta.noun[1]}, matches the scraper’s ${meta.export} export.`;
    }
  }

  const onDrop = (event: DragEvent) => {
    event.preventDefault();
    setDragging(false);
    const dropped = event.dataTransfer.files[0];
    if (dropped) onChoose(dropped);
  };

  return (
    <div
      onDragOver={(event) => {
        event.preventDefault();
        setDragging(true);
      }}
      onDragLeave={() => setDragging(false)}
      onDrop={onDrop}
      className={`grid grid-cols-[auto_minmax(0,1fr)_auto] items-center gap-x-3 gap-y-0.5 rounded-field border px-4 py-3.5 ${
        bad
          ? "border-[color-mix(in_srgb,var(--color-crit)_45%,var(--color-line))] bg-[color-mix(in_srgb,var(--color-crit-soft)_55%,var(--color-base-100))]"
          : dragging
            ? "border-call bg-call-soft"
            : "border-line bg-base-100"
      }`}
    >
      <Icon name={bad ? "bad" : ok ? "ok" : "file"} className={`size-[18px] ${bad ? "text-crit" : ok ? "text-call" : "text-muted"}`} />
      <span className="font-semibold">{meta.title}</span>
      <span className="row-span-2 self-center">
        <input
          ref={input}
          type="file"
          accept=".csv,text/csv"
          className="sr-only"
          tabIndex={-1}
          aria-label={meta.title}
          data-slot={slot}
          onChange={(event) => {
            const chosen = event.target.files?.[0];
            if (chosen) onChoose(chosen);
            event.target.value = "";
          }}
        />
        <button
          type="button"
          className={`btn btn-sm gap-1.5 font-medium ${ok ? "btn-ghost text-muted" : "border-line-strong bg-base-100"}`}
          onClick={() => input.current?.click()}
          aria-label={`${ok ? "Replace" : bad ? "Choose another" : "Choose"} ${meta.title.toLowerCase()}`}
        >
          {!ok && <Icon name="upload" className="size-4" />}
          {ok ? "Replace" : bad ? "Choose another file" : "Choose file"}
        </button>
      </span>
      <span className={`col-start-2 text-[13.5px] [overflow-wrap:anywhere] ${bad ? "text-ink-2" : "text-muted"}`} aria-live="polite">
        {description}
      </span>
    </div>
  );
}

function Importing({ campaignName, people, businesses }: { campaignName: string; people: number; businesses: number }) {
  return (
    <div aria-busy="true">
      <h1 className="text-[30px] leading-[1.15] tracking-[-0.02em]">Importing into {campaignName}</h1>
      <p className="mt-2 text-[15px] text-ink-2">
        Matching {businesses} {businesses === 1 ? "business" : "businesses"} and {people} {people === 1 ? "person" : "people"} against the
        people and companies you already have.
      </p>
      <progress className="progress mt-[18px] h-1.5 w-full max-w-[520px] text-call" aria-label="Import progress" />
      <div className="mt-4 max-w-[900px] rounded-box border border-line bg-base-100 p-4">
        {[0, 1, 2, 3].map((i) => (
          <div key={i} className="flex gap-6 border-line py-3 [&+&]:border-t">
            <div className="skeleton h-3 w-36" />
            <div className="skeleton h-3 w-44" />
            <div className="skeleton h-3 w-20" />
            <div className="skeleton h-3 w-56" />
          </div>
        ))}
      </div>
    </div>
  );
}
