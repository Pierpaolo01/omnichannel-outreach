/** Calls. The focus queue arrives with the daily call list ticket; until then the list is empty. */
export function CallsPage() {
  return (
    <div className="grid grid-cols-1 items-start gap-7 min-[901px]:grid-cols-[250px_minmax(0,1fr)] xl:grid-cols-[290px_minmax(0,1fr)]">
      <aside aria-label="Call queue">
        <h2 className="mb-1.5 ml-2.5 text-[13px] font-semibold text-muted">Ready now, 0</h2>
        <p className="mb-[22px] px-2.5 text-[12.5px] leading-[1.45] text-faint">Nothing to call right now.</p>
        <h2 className="mb-1.5 ml-2.5 text-[13px] font-semibold text-muted">Later today, 0</h2>
        <p className="px-2.5 text-[12.5px] leading-[1.45] text-faint">Nothing else today.</p>
      </aside>
      <section className="overflow-clip rounded-box border border-line bg-base-100">
        <div className="bg-band px-[30px] pb-7 pt-[26px] text-band-ink">
          <h1 className="text-[34px] leading-[1.05] tracking-[-0.03em]">No calls today</h1>
          <p className="mt-1.5 max-w-[60ch] text-[16px] text-band-muted">
            Calls appear here once a launched campaign reaches a call step. You place every call yourself.
          </p>
        </div>
      </section>
    </div>
  );
}
