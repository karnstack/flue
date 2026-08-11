import { ArrowDown, ArrowUp, Cloud, HardDrive, Lock, Smartphone } from 'lucide-react'

/**
 * The relay protocol in one picture.
 *
 * Vertical, deliberately. A three-node horizontal flow needs about a
 * thousand pixels before its socket labels stop colliding with the boxes
 * they sit between, and this lives in a reading column half that wide. Read
 * top to bottom, each hop gets a whole row to name itself in.
 *
 * The claim the drawing exists to make is that the middle box is *inside*
 * the encrypted run rather than at the end of it. That is what the teal rail
 * down the left is: it spans all three nodes, not the gap between two.
 */
export function RelayProtocol() {
  return (
    <figure
      className="my-2"
      aria-label="The daemon and the browser each dial a Cloudflare Worker outbound. The Worker bridges the two sockets and forwards frames. A Noise IK channel runs end to end from the browser to the daemon, past the Worker, which holds no key for it."
    >
      {/* The channel is the wrapper's own left border, so it cannot end up
          shorter than the nodes it is meant to run past. */}
      <div className="border-l-2 border-dashed border-primary/40 pl-4 sm:pl-6">
        <Node
          icon={HardDrive}
          title="daemon"
          lines={['on your machine', 'dials out, never listens']}
        />
        <Hop label="wss /daemon/<id>" dir="down" />
        <Node
          icon={Cloud}
          title="Worker, one Durable Object per machine and one for the directory"
          lines={['in your Cloudflare account', 'forwards frames, holds no key']}
        />
        <Hop label="wss /client/<id>" dir="up" />
        <Node
          icon={Smartphone}
          title="browser"
          lines={['any device you paired', 'pins the daemon key']}
        />
      </div>

      <figcaption className="mt-3 rounded-lg border border-dashed border-primary/40 bg-primary/5 px-4 py-3">
        <p className="flex items-center gap-2 font-mono text-xs text-primary">
          <Lock className="size-3.5 shrink-0" aria-hidden="true" />
          Noise IK, end to end: browser initiator, daemon responder
        </p>
        <p className="mt-1.5 font-mono text-xs text-pretty text-muted-foreground">
          frame: [4B channel][payload] &middot; inside: [1B kind][wire protocol bytes]
        </p>
      </figcaption>
    </figure>
  )
}

function Node({
  icon: Icon,
  title,
  lines,
}: {
  icon: typeof Cloud
  title: string
  lines: string[]
}) {
  return (
    <div className="flex items-start gap-3 rounded-lg border border-dashed border-border p-4">
      <Icon className="mt-0.5 size-4 shrink-0 text-primary" aria-hidden="true" />
      <div className="min-w-0">
        <p className="text-sm font-medium text-pretty">{title}</p>
        <p className="mt-1 font-mono text-xs text-pretty text-muted-foreground">
          {lines.join(' · ')}
        </p>
      </div>
    </div>
  )
}

/** The run between two nodes: which socket it is, and which way it dials. */
function Hop({ label, dir }: { label: string; dir: 'down' | 'up' }) {
  const Arrow = dir === 'down' ? ArrowDown : ArrowUp
  return (
    <div className="flex items-center gap-2 py-2 pl-4">
      <span aria-hidden="true" className="h-6 border-l border-dashed border-border" />
      <Arrow className="size-3.5 shrink-0 text-muted-foreground" aria-hidden="true" />
      <p className="font-mono text-xs text-muted-foreground">{label}</p>
    </div>
  )
}
