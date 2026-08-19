import { Badge } from '@/components/ui/badge'
import { cn } from '@/lib/utils'

/**
 * How many tag badges show before the rest fold into a "+n". A session row
 * is one line that must never push the pane sideways, and the terminal's
 * corner strip owes the same restraint to the output under it — so the cap
 * holds the line on both, and the folded remainder rides in the +n badge's
 * tooltip.
 */
export const TAG_CAP = 3

/**
 * The capped run of tag badges the session row and the terminal share.
 * `className` dresses every badge; `overflowClassName` lands on the +n badge
 * alone, which is how the row lifts only the tooltip-holder above its
 * stretched link.
 */
export function TagBadges({
  tags,
  className,
  overflowClassName,
}: {
  tags: string[]
  className?: string
  overflowClassName?: string
}) {
  return (
    <>
      {tags.slice(0, TAG_CAP).map((tag) => (
        <Badge key={tag} variant="secondary" className={className}>
          {tag}
        </Badge>
      ))}
      {tags.length > TAG_CAP && (
        <Badge
          variant="secondary"
          title={tags.slice(TAG_CAP).join(', ')}
          className={cn(className, overflowClassName)}
        >
          +{tags.length - TAG_CAP}
        </Badge>
      )}
    </>
  )
}
