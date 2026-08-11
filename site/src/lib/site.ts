export const SITE_URL = 'https://flue.sh'
export const REPO_URL = 'https://github.com/karnstack/flue'
export const X_URL = 'https://x.com/gyankarn'

export const INSTALL_CMD = 'curl -fsSL https://flue.sh/install.sh | sh'
export const BREW_CMD = 'brew install karnstack/tap/flue'

/**
 * The setup walkthrough, on Mux with public playback.
 *
 * There is no signing key here and nothing to mint at runtime. A playback id
 * is the whole of what it takes to watch this, and it is not a secret.
 */
export const WALKTHROUGH_PLAYBACK_ID = 'vnrDD86c33LvJ7Ftv6uIWlEDTGH6dxqnE3cH6e02pZ94'

/** How long it runs. Written in the caption, and read out in the button label. */
export const WALKTHROUGH_RUNTIME = '8:51'

/**
 * One frame, named once and used twice: the closed card paints it, and the
 * player is handed the same URL as its poster when it opens. Naming it twice
 * is what makes the swap seamless, because the second request is a cache hit
 * rather than a fresh fetch across an empty rectangle.
 *
 * 5:30 is the second worth choosing. It is the Ubuntu machine taking the
 * install line with the sessions page already up behind it, which is the most
 * legible frame in the run and one of the few that says what the whole thing
 * is about. Several of the later ones show a relay secret, so they are out.
 */
export const WALKTHROUGH_POSTER = `https://image.mux.com/${WALKTHROUGH_PLAYBACK_ID}/thumbnail.webp?time=330&width=1200`

/**
 * That same frame at 24px across, written out here at 263 bytes so the card
 * has something to paint before anything is fetched. kino lays it under the
 * poster the same way once the player opens, which is why both halves are
 * given it.
 */
export const WALKTHROUGH_BLUR =
  'data:image/webp;base64,UklGRqwAAABXRUJQVlA4IKAAAAAwBACdASoYAA4APlEgjUQjoiEYBAA4BQSzAFiNqALX4WRJCDRqDujU6YwA/v8rl6RU7q8kvuFZDpsXENrifU0Ahz/kXdneUSBeBVkGphdpCdwmD5sUyoP+dwh+2GmbntH5//OW/GnmdJ0Flr88cz3OPlY3GzJprjYUdTTcvQwS8I3YClHd8aXjjLMDn/p/IzRA7SwbBX3zW5/NZT35QAAA'
