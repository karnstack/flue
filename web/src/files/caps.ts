/*
 * The highlighter's ceilings, in a module of their own so the viewer can
 * check them before building an eight-megabyte string and posting it to a
 * worker whose first act would be answering null. Everything heavier lives
 * behind dynamic imports; these are two numbers.
 */

/** Past either cap a file keeps its plain rows. The size cap is measured in
 * UTF-16 units, a close proxy for bytes in the code this exists for. */
export const HIGHLIGHT_MAX_BYTES = 1 << 20
export const HIGHLIGHT_MAX_LINES = 20_000
