// What a device is allowed to be called, in one place.
//
// Two callers write `devices.label` and they must agree: `startDeviceAuth`
// takes the name a daemon gives itself over an unauthenticated endpoint, and
// `renameDevice` takes the name its owner types into the dashboard. A bound
// enforced on one path and not the other is not a bound — the label ends up in
// the same column, read by the same readers.
//
// And there are two readers, which is what the rules below are for. The
// dashboard renders it as React text, so it is escaped there; `flue devices`
// prints it into a *terminal* on some other machine, where an escape sequence
// is somebody else's cursor. Control characters are therefore removed rather
// than escaped at the point of display, because there is no single point of
// display.

/** The longest label kept. `devices.label` is shown, not searched. */
export const MAX_LABEL = 64

/**
 * The longest input read before giving up on it.
 *
 * Rejected outright rather than truncated to `MAX_LABEL`: the first 64 bytes
 * of a megabyte are not what anyone typed, and a caller who sends one is not
 * naming a machine. What it costs to be generous here is a megabyte of regex
 * per call, on a path that then writes a bound parameter to D1.
 */
export const MAX_LABEL_INPUT = 1024

/**
 * The label, made safe to store and to print — or `''` when nothing usable
 * survives.
 *
 * Control characters go first (see the note above), then runs of whitespace
 * collapse so a list of machines stays a list, then the result is trimmed and
 * bounded. Trimmed again after the slice, because cutting at 64 can leave a
 * trailing space that was in the middle a moment ago.
 *
 * `''` is a *refusal*, not a value: the two callers disagree about what to do
 * with it — enrolment substitutes a generic name for a daemon that sent
 * nothing, a rename tells the person their machine still needs one — so this
 * function does neither and says only that there is nothing here.
 */
export function normalizeLabel(raw: string): string {
  return raw
    .slice(0, MAX_LABEL_INPUT)
    .replace(/[\u0000-\u001f\u007f-\u009f]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, MAX_LABEL)
    .trim()
}
