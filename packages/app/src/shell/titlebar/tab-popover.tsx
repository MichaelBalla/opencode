import { HoverCard } from "@kobalte/core/hover-card"
import { frameLoop, prefersReducedMotion, Spring } from "@opencode/ui/motion"
import { motionTuning } from "@opencode/ui/motion-tuning"
import { createEffect, createSignal, on, onCleanup, Show, type JSXElement } from "solid-js"
import { useLanguage } from "@/runtime/i18n/language"
import { createMediaQuery } from "@solid-primitives/media"
import "./tab-popover.css"

// Initial hover delay before the preview appears, per design.
const OPEN_DELAY = 750

const CLOSE_DELAY = 0

// After a preview closes, hovering a neighbouring tab within this window skips
// the open delay — mirrors the tooltip's skipDelayDuration so moving across
// tabs doesn't re-wait the full delay each time.
const SKIP_WINDOW = 500

let lastClosedAt = 0

let activePreview: (() => void) | undefined

const glides = motionTuning.toggle("sidebars.preview.glide", {
  label: "Tab preview glides",
  group: "Sidebars",
  value: true,
})

const spring = motionTuning.spring("sidebars.preview", {
  label: "Tab preview glide",
  group: "Sidebars",
  presets: {
    snappy: { duration: 0.2, bounce: 0 },
    smooth: { duration: 0.28, bounce: 0 },
    calm: { duration: 0.36, bounce: 0 },
  },
})

// In the vertical strip, the next tab's preview starts where the last one was and glides to its own row, so moving
// down the tabs reads as one card following the cursor.
const glide: Glide = {
  closedAt: Number.NEGATIVE_INFINITY,
  offset: Spring.fromDuration(0, spring()),
}

export interface TabPreviewData {
  projectName?: string
  title?: string
  path?: string
  serverName?: string
}

export function TabPreviewPopover(props: {
  trigger: JSXElement
  open: boolean
  onOpenChange: (open: boolean) => void
  data: TabPreviewData
  orientation?: "horizontal" | "vertical"
}) {
  const language = useLanguage()
  const mobile = createMediaQuery("(max-width: 767px)")
  let triggerEl: HTMLDivElement | undefined
  // When opened during a rapid tab-hopping streak, this preview appears and
  // disappears instantly (no repeated enter/exit animation) — only the first,
  // "cold" preview animates. Mirrors how browsers reuse one tab tooltip.
  const [instant, setInstant] = createSignal(false)

  const warm = () => !!activePreview || Date.now() - lastClosedAt < SKIP_WINDOW
  const open = () => props.open && !mobile()
  const close = () => props.onOpenChange(false)

  // Observe accepted, controlled state, including drag/menu suppression in TabNav.
  createEffect(() => {
    if (open()) {
      if (activePreview !== close) activePreview?.()
      activePreview = close

      return
    }

    if (activePreview !== close) return
    activePreview = undefined
    lastClosedAt = Date.now()
  })
  createEffect(
    on(
      open,
      (now, before) => {
        if (before && !now && triggerEl && props.orientation === "vertical" && glides()) leave(triggerEl)
      },
      { defer: true },
    ),
  )
  onCleanup(() => {
    if (activePreview !== close) return
    activePreview = undefined
    lastClosedAt = Date.now()
  })
  // Kobalte reads openDelay lazily when the pointer enters the trigger, so this
  // resolves the skip window per-hover.
  const resolveOpenDelay = () => (warm() ? 0 : OPEN_DELAY)

  const handleOpenChange = (open: boolean) => {
    if (open) setInstant(warm())
    props.onOpenChange(open)
  }

  // Kept out of JSX: an inline nested ternary compiles to a memo created on every read, and Kobalte reads
  // placement from a ResizeObserver callback, where that memo has no owner and is never disposed.
  const placement = () =>
    props.orientation === "vertical" ? (language.direction() === "rtl" ? "left-start" : "right-start") : "bottom-start"

  return (
    <HoverCard
      open={open()}
      onOpenChange={handleOpenChange}
      openDelay={resolveOpenDelay()}
      closeDelay={CLOSE_DELAY}
      // Informational previews belong to their tab, not to a hoverable safe area.
      ignoreSafeArea
      placement={placement()}
      gutter={6}
    >
      <HoverCard.Trigger ref={triggerEl} as="div" data-component="session-tab-popover-trigger" tabIndex={-1}>
        {props.trigger}
      </HoverCard.Trigger>
      <HoverCard.Portal>
        <HoverCard.Content
          ref={(el) => {
            // Portalled content lives outside the themed subtree, so mirror the
            // active theme like the v2 tooltip does.
            const theme = triggerEl?.closest("[data-theme]")?.getAttribute("data-theme")

            if (theme) el.setAttribute("data-theme", theme)

            if (triggerEl && props.orientation === "vertical" && glides()) show(el, triggerEl)
          }}
          data-component="session-tab-popover"
          data-instant={instant() || undefined}
        >
          <div data-slot="header">
            <Show when={props.data.projectName}>
              <span data-slot="project">{props.data.projectName}</span>
            </Show>
            <Show when={props.data.title}>
              <span data-slot="title">{props.data.title}</span>
            </Show>
          </div>

          <Show when={props.data.path}>
            <div data-slot="row">
              <span data-slot="detail">{props.data.path}</span>
            </div>
          </Show>

          <Show when={props.data.serverName}>
            <div data-slot="server">{props.data.serverName}</div>
          </Show>
        </HoverCard.Content>
      </HoverCard.Portal>
    </HoverCard>
  )
}

function show(card: HTMLElement, trigger: HTMLElement) {
  const previous = glide.trigger

  // The last card may still be up (the next one usually opens first) or have closed a moment ago.
  const handover =
    previous !== undefined &&
    previous !== trigger &&
    previous.isConnected &&
    (!!glide.card?.isConnected || performance.now() - glide.closedAt < 100)

  Object.assign(glide, { card, trigger, closedAt: Number.NEGATIVE_INFINITY })

  if (!handover || prefersReducedMotion()) return glide.offset.snap(0)
  // Starts from where the last card is, keeping the velocity of a glide already under way.
  glide.offset.value += previous.getBoundingClientRect().top - trigger.getBoundingClientRect().top
  glide.offset.target = 0
  card.style.transform = `translateY(${glide.offset.value}px)`
  glide.stop ??= frameLoop.add(step)
}

function leave(trigger: HTMLElement) {
  if (trigger !== glide.trigger) return
  glide.card = undefined
  glide.closedAt = performance.now()
}

function step(dt: number) {
  const card = glide.card

  if (!card?.isConnected) {
    glide.stop = undefined

    return false
  }

  glide.offset.omega = (2 * Math.PI) / spring().duration
  glide.offset.zeta = 1 - spring().bounce

  if (prefersReducedMotion()) glide.offset.snap(0)
  const offset = glide.offset.step(dt)

  if (!glide.offset.resting) {
    card.style.transform = `translateY(${offset}px)`

    return true
  }

  card.style.removeProperty("transform")
  glide.stop = undefined

  return false
}

type Glide = {
  // The row whose preview is up, or closed last.
  trigger?: HTMLElement
  card?: HTMLElement
  closedAt: number
  offset: Spring
  stop?: () => void
}
