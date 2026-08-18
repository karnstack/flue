/*
 * The way into a pairing ceremony for a tab that cannot follow links from
 * outside itself.
 *
 * The QR a machine shows is normally read by the phone's camera app, which
 * opens the link in the browser proper. The app saved to a home screen never
 * hears about it: its storage is its own partition, and nothing scanned
 * outside it lands inside. So the machine picker offers this panel instead —
 * the same code read by this page's own camera, or the same link pasted by
 * hand — and either way the tab walks itself to /pair, where the ceremony
 * runs exactly as it always has.
 *
 * The scanner is imported only once the panel is open: it is a wasm-sized
 * dependency the shell never needs, and a tab that pairs once should not
 * carry it on every boot.
 */
import { useEffect, useRef, useState } from 'react'
import type QrScanner from 'qr-scanner'

import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { parsePairLink, type PairLinkFailure } from '@/relay/pair-link'

/** What each refusal says, in words the reader can act on. */
const FAILURE_PROSE: Record<PairLinkFailure, string> = {
  unreadable: 'That is not a pairing link. Copy the whole link, or scan the code it sits beside.',
  foreign:
    'That link was minted for a different relay, so this app cannot follow it. Open it in the browser it belongs to instead.',
  incomplete: 'That link lost its token or key on the way. Copy the whole link and try again.',
}

/** The door pages' shared prose classes — machines.tsx spells out why. */
const PROSE = 'text-base/7 text-pretty text-zinc-600 sm:text-sm/6 dark:text-zinc-400'

export function PairPanel({ onClose }: { onClose: () => void }) {
  const video = useRef<HTMLVideoElement>(null)
  /** Whether the camera preview is live, still warming up, or not to be had. */
  const [camera, setCamera] = useState<'starting' | 'live' | 'gone'>('starting')
  const [failure, setFailure] = useState<PairLinkFailure | null>(null)
  const [link, setLink] = useState('')

  /**
   * One judgement for both mouths: whatever the camera decodes and whatever
   * the paste box holds go through the same parse, so the two paths cannot
   * drift apart on what counts as a pairing link.
   */
  function follow(raw: string) {
    const parsed = parsePairLink(raw, location.origin)
    if (!parsed.ok) {
      setFailure(parsed.reason)
      return
    }
    location.assign(parsed.target)
  }

  useEffect(() => {
    let scanner: QrScanner | null = null
    let open = true
    void (async () => {
      // Answered before the import: a device with no media stack at all has
      // no use for the scanner engine, and the engine's worker would only
      // throw somewhere no catch is waiting.
      if (navigator.mediaDevices === undefined) {
        setCamera('gone')
        return
      }
      let Scanner: typeof QrScanner
      try {
        // Dynamic so the shell bundle stays without it; a failed chunk fetch
        // (offline, most likely) reads the same as having no camera, and the
        // paste box needs neither.
        Scanner = (await import('qr-scanner')).default
      } catch {
        if (open) setCamera('gone')
        return
      }
      if (!open || video.current === null) return
      scanner = new Scanner(video.current, (result) => follow(result.data), {
        returnDetailedScanResult: true,
        preferredCamera: 'environment',
      })
      try {
        await scanner.start()
        if (open) setCamera('live')
      } catch {
        // No camera on the device, or the user said no. Either way the
        // answer is the paste box, which is already on screen.
        if (open) setCamera('gone')
      }
    })()
    return () => {
      open = false
      scanner?.destroy()
    }
    // follow() reads nothing that changes; the scanner outlives every render.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  return (
    <div className="flex flex-col gap-y-5">
      {camera === 'gone' ? (
        <p className={PROSE}>No camera to scan with here, so paste the pairing link instead.</p>
      ) : (
        <video
          ref={video}
          className="aspect-square w-full rounded-lg bg-zinc-950/5 object-cover dark:bg-white/5"
          muted
          playsInline
        />
      )}
      <form
        className="flex items-center gap-x-2"
        onSubmit={(e) => {
          e.preventDefault()
          follow(link)
        }}
      >
        <Input
          aria-label="Pairing link"
          placeholder="Paste the pairing link"
          autoComplete="off"
          value={link}
          onChange={(e) => {
            setLink(e.target.value)
            setFailure(null)
          }}
        />
        <Button type="submit" size="sm" aria-label="Open link">
          Open link
        </Button>
      </form>
      {/*
        Always in the tree for the reason machines.tsx keeps its status line:
        a live region born alongside its first message is a message several
        screen readers never announce.
      */}
      <p role="status" className={PROSE}>
        {failure === null ? null : FAILURE_PROSE[failure]}
      </p>
      <Button
        variant="ghost"
        size="sm"
        className="self-start text-zinc-500 dark:text-zinc-400"
        onClick={onClose}
      >
        Cancel
      </Button>
    </div>
  )
}
