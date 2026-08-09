// The hub logs one `{"evt":"channel_closed",...}` JSON line per retired
// client, on purpose: it is the per-channel counter feed for Workers Logs
// (src/hub.ts, retireClient). Under vitest that purpose does not exist, and
// the suites retire enough clients to bury a CI log in seventy-odd of them —
// so the line is dropped here, at the printing edge, and nowhere else.
//
// Only this line, by its prefix: anything else the Worker says still prints,
// because an unexpected log in a test run is signal. And the test that proves
// the counters ("... logs the counters", test/hub.test.ts) keeps working
// unchanged: its vi.spyOn(console, 'log') wraps this filter, so it records
// the call and its arguments whether or not anything reaches the terminal.

const passThrough = console.log.bind(console)

console.log = (...args: unknown[]) => {
  if (typeof args[0] === 'string' && args[0].startsWith('{"evt":"channel_closed"')) return
  passThrough(...args)
}
