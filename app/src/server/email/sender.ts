// The seam where email delivery will land.
//
// This plan deliberately ships no provider: wiring a real one (API key, sending
// domain, SPF/DKIM/DMARC, bounce handling) is the operator's last step, and
// guessing at it here would mean committing a half-integration nobody can test.
// What ships instead is the interface everything else codes against, plus the
// one implementation a developer can actually use: it prints the code.
//
// To go live, write a `Sender` that talks to the provider and return it from
// `sender()`. Nothing else in the app has to change.

export interface Sender {
  sendLoginCode(email: string, code: string): Promise<void>
}

/**
 * Development delivery: the login code goes to the log.
 *
 * This is the ONLY place a plaintext code is ever written anywhere — see
 * `server/codes.ts`, which hashes before it stores and never logs. On Workers
 * this line surfaces in `wrangler tail` / the dashboard's live logs, which is
 * exactly why it must not survive contact with real users: anyone who can read
 * the logs can log in as anyone.
 */
export class LogSender implements Sender {
  async sendLoginCode(email: string, code: string): Promise<void> {
    console.log(JSON.stringify({ evt: 'login_code', email, code }))
  }
}

/** The Sender the app uses. Swap the implementation here when email is built. */
export function sender(): Sender {
  return new LogSender()
}
