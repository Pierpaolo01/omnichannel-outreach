import { measureOracle } from "../../test/support/measure-chunks.ts";

/** Each broken measure fails the invariant it names, on its recorded seed (ADR 0003 "Ticket 22", the mutations). */
measureOracle();
