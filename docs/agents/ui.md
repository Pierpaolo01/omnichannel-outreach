# UI work

Set by the coordinator on 12 November 2026 from the principal's build request. It applies to every agent that designs, implements, verifies or reviews UI.

## Required process

- Load the installed `impeccable` skill and follow it from design planning through implementation: run its context step, read the references it names, and read its craft floor immediately before editing UI. It is not a final polish pass.
- This product's surfaces are Operate mode: the user completes tasks. Precision, scanability and restraint outrank expression.
- `PRODUCT.md` and `DESIGN.md` at the repository root hold the product context and the design system once the first UI slice creates them. Later slices extend them; they do not start a new visual direction.

## Sources of truth

- Behavior and scope: [the spec](https://github.com/Pierpaolo01/omnichannel-outreach/issues/10) and the ticket.
- Layout, interaction and visual language: the approved prototype, `git show origin/prototype/daily-workspace:prototypes/daily-workspace/index.html`. Use its Today, focus queue, lead search, single-column person page, confirmations, color tokens, type and spacing. The spec lists the prototype shortcuts that are not requirements.
- Approved design selections made after the prototype are recorded in `DESIGN.md` with their date.

## Rules

- Do not reopen an approved design decision, and do not add scope the ticket does not ask for. The agreed interface is simple.
- A UI decision that neither the prototype nor a recorded selection settles is not yours to settle. Stop at that boundary and report it. The coordinator shows the principal two or three lightweight variants and the principal chooses.
- Use the component library and tokens the first UI slice establishes. Add a component only when no existing one fits, and add it to `DESIGN.md`.
- Every slice covers the loading, empty, error and success states its screens can reach. An area a later ticket delivers shows an honest empty state, never invented data.
- Keyboard access, visible focus, labelled controls and sufficient contrast in both light and dark themes are part of done. Laptop widths come first; nothing may break or scroll sideways at narrower widths.
- Look at the rendered result in a browser before reporting. Screenshots in the pull request are the evidence reviewers compare with the prototype.
