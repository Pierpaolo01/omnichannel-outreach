import { bulkOracle } from "../../test/support/bulk-chunks.ts";

/** Each broken bulk rule fails the invariant it names, on its recorded seed (ADR 0003 "Ticket 18", the mutations). */
bulkOracle();
