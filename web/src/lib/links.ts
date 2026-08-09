/**
 * The handful of addresses outside this app that the app points at.
 *
 * Spelled once, here, because every one of them appears in more than one
 * place and two of them differ only by a suffix — a repository and its issue
 * tracker written out separately is exactly the pair that drifts when the
 * project moves.
 */

/** The source, for a reader who wants to know what the daemon actually does. */
export const REPO_URL = 'https://github.com/karnstack/flue'

/**
 * Where feedback goes.
 *
 * The issue list rather than the new-issue form: somebody with a complaint
 * has usually not checked whether it is already filed, and landing them on an
 * empty form asks them to write it before they can find out.
 */
export const ISSUES_URL = `${REPO_URL}/issues`

/**
 * What every release changed, for the version printed in the sidebar.
 *
 * The list rather than a tag. A tag URL would have to be assembled from the
 * version string the daemon reports, which is a guess about how this project
 * spells its tags — and a wrong guess is a 404 on a link that promised
 * release notes.
 */
export const RELEASES_URL = `${REPO_URL}/releases`

/** Whoever is on the other end of the credit line. */
export const AUTHOR_URL = 'https://x.com/gyankarn'
