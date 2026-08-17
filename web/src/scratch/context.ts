import { createContext, useContext } from 'react'

/**
 * What the rest of the app may ask of the scratch terminal. `toggle` is what
 * the double-Ctrl chord does, exposed for the chip a phone needs — no Ctrl to
 * tap twice there. `enabled` says whether the surface exists at all right
 * now: there is a session on screen to anchor the scratch to, and its daemon
 * has announced the `multiplex` capability.
 */
export interface Scratch {
  toggle(): void
  enabled: boolean
}

/**
 * In its own module rather than beside the provider, and not by taste: the
 * provider renders a Terminal inside its dialog, and the Terminal's control
 * strip reads this context for its chip — a shared file is what keeps that
 * from being an import cycle.
 */
export const ScratchContext = createContext<Scratch | null>(null)

/**
 * The scratch terminal's controls, from a component that cannot be sure the
 * provider is mounted. The no-op default is for tests that mount the terminal
 * alone, exactly as useSwitcher answers them.
 */
export function useScratch(): Scratch {
  return useContext(ScratchContext) ?? { toggle: () => {}, enabled: false }
}
