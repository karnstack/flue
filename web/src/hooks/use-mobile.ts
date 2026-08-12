import * as React from "react"

const MOBILE_BREAKPOINT = 768

export function useIsMobile() {
  // The first render matters for focus policy: a dialog can run its opening
  // autofocus before this hook's effect. Starting at a desktop-shaped false
  // would briefly focus a mobile input and summon the keyboard before the
  // viewport listener had a chance to correct the answer.
  const [isMobile, setIsMobile] = React.useState(() => window.innerWidth < MOBILE_BREAKPOINT)

  React.useEffect(() => {
    const mql = window.matchMedia(`(max-width: ${MOBILE_BREAKPOINT - 1}px)`)
    const onChange = () => {
      setIsMobile(window.innerWidth < MOBILE_BREAKPOINT)
    }
    mql.addEventListener("change", onChange)
    setIsMobile(window.innerWidth < MOBILE_BREAKPOINT)
    return () => mql.removeEventListener("change", onChange)
  }, [])

  return isMobile
}
