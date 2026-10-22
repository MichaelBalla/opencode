import { createEffect, createSignal, on, onCleanup, type Accessor } from "solid-js"
import { makeEventListener } from "@solid-primitives/event-listener"
import { frameLoop, prefersReducedMotion, Spring } from "@opencode/ui/motion"
import { motionTuning } from "@opencode/ui/motion-tuning"
import { panelSpring } from "@/shell/panel-motion"
import "./sidebar-peek.css"

export const sidebarPeekEnabled = motionTuning.toggle("sidebar.peek", {
  label: "Peekable sidebar",
  group: "Experiments",
  value: true,
})

/** Whether any session in the vertical sidebar draws its unread dot, published by the sidebar's tab strip. */
export const [sidebarUnread, setSidebarUnread] = createSignal(false)

const toggles = 'button[aria-controls="vertical-tabs-sidebar"]'

const menus = '[data-component="menu-v2-content"], [role="menu"]'

// How long the pointer rests before the sidebar peeks, in ms. Both sit under the ~100–150ms where a response still reads
// as immediate, and above how long a pointer spends crossing: through the 8px edge strip in well under a frame, over the
// 28px toggle in ~30–60ms on the way to the breadcrumb or the traffic lights. The toggle waits longer because the header
// row is crossed far more often than the bare window edge, and a peek that starts just before a click docks smoothly.
const dwell = { edge: 100, toggle: 150 }

// The strip along the window's start edge that peeks the sidebar: the shell's 8px frame gutter, outside the content's
// card, so no control, scrollbar or text lives in it. It starts below the session header's 56px band, which holds the
// traffic lights and the toggle.
const edge = 8

const header = 56

// How far past the sidebar and toggle the pointer may stray, and for how long, before the peek closes.
const margin = 15

const grace = 100

// Reduced motion fades the peek in place, in about the time it would take to slide.
const fade = { duration: 0.15, bounce: 0 }

type Point = { x: number; y: number }

/**
 * Experiment: while the left sidebar is closed, resting the pointer on the window's start edge or on the sidebar's
 * toggle slides the real sidebar in over the app without moving the layout, on the docked sidebar's own spring and in
 * its own box. Docking from a peek continues from where it is: the sidebar stays and the layout makes room.
 *
 * The peek holds while the pointer stays within the box spanning the toggle and the sidebar, plus a margin, so the way
 * from the toggle into the sidebar never closes it. Closing reads the pointer's last known position on every move,
 * scroll and wheel, and on a slow interval, rather than trusting enter and leave events on elements.
 */
export function createSidebarPeek(input: {
  /** Whether a peek may start: the sidebar is fully closed. */
  available: Accessor<boolean>
  open: Accessor<boolean>
  aside: Accessor<HTMLElement | undefined>
  /** The sidebar's box while it peeks, which doesn't move while the content inside it slides. */
  panel: Accessor<HTMLElement | undefined>
  /** Paints how far in the peek has the sidebar, from 0 to 1, on every frame it moves; undefined once it isn't peeking. */
  paint: (shown: number | undefined) => void
  /** Whether docking continues from the peek; otherwise the docked sidebar's own motion takes over at once. */
  continues: Accessor<boolean>
  /** Runs `run` once the docked sidebar's flight lands. */
  whenDocked: (run: () => void) => void
}) {
  const [shown, setShown] = createSignal(false)
  // Percent shown, so the spring's rest threshold stays well under a pixel.
  const motion = new Spring(0)
  let stop: (() => void) | undefined
  let toggle: HTMLElement | undefined
  let opening: { from: "edge" | "toggle"; timer: ReturnType<typeof setTimeout> } | undefined
  let closing: ReturnType<typeof setTimeout> | undefined
  let watch: ReturnType<typeof setInterval> | undefined
  // The pointer's last position in the window, or undefined once it has left the window.
  let pointer: Point | undefined
  let pressed = false
  let keyboard = false
  // Whether the sidebar last docked from a peek, which already shows it.
  let handedOff = false
  let viewport = window.innerWidth

  const paint = () => input.paint(Math.min(1, Math.max(0, motion.value / 100)))

  const step = (dt: number) => {
    motion.step(dt)
    paint()

    if (!motion.resting) return true
    stop = undefined

    if (motion.target === 0) end()

    return false
  }

  // Retargeting keeps the current position and velocity, so a peek that turns around mid-flight stays smooth.
  const run = (target: number) => {
    const tuning = prefersReducedMotion() ? fade : panelSpring()
    motion.omega = (2 * Math.PI) / tuning.duration
    motion.zeta = 1 - tuning.bounce
    motion.set(target)
    stop ??= frameLoop.add(step)
  }

  const cancelOpen = () => {
    clearTimeout(opening?.timer)
    opening = undefined
  }

  const cancelClose = () => {
    clearTimeout(closing)
    closing = undefined
  }

  const show = () => {
    cancelOpen()
    cancelClose()

    if (!input.panel()) return

    // Painted out of view before the peek's box lays out, so its first frame doesn't show the sidebar in place.
    if (!shown()) {
      paint()
      setShown(true)
    }
    watch ??= setInterval(check, 150)
    run(100)
  }

  const end = () => {
    cancelOpen()
    cancelClose()
    clearInterval(watch)
    watch = undefined
    stop?.()
    stop = undefined
    motion.snap(0)
    toggle = undefined

    if (!shown()) return
    setShown(false)
    input.paint(undefined)
  }

  const hide = (focus?: boolean) => {
    cancelClose()

    if (!shown() || input.open()) return
    clearInterval(watch)
    watch = undefined
    const aside = input.aside()

    if (aside?.contains(document.activeElement)) {
      if (focus && toggle?.isConnected) toggle.focus({ preventScroll: true })

      if (!focus && document.activeElement instanceof HTMLElement) document.activeElement.blur()
    }

    run(0)
  }

  const start = (from: "edge" | "toggle", still: () => boolean) => {
    cancelOpen()
    opening = {
      from,
      timer: setTimeout(() => {
        opening = undefined

        if (sidebarPeekEnabled() && input.available() && still()) show()
      }, dwell[from]),
    }
  }

  // A visible menu, a drag, or typing in one of the sidebar's fields keeps it open wherever the pointer goes.
  const held = () => {
    const active = document.activeElement
    const typing =
      active instanceof HTMLElement &&
      input.aside()?.contains(active) &&
      (active.matches("input, textarea") || active.isContentEditable) &&
      active.getClientRects().length > 0
    const menu = [...document.querySelectorAll(menus)].some((element) => element.getClientRects().length > 0)

    return pressed || typing || menu || !!document.querySelector('[data-dragging="true"]')
  }

  const inside = (point: Point) => {
    const panel = input.panel()

    if (!panel) return false
    const sheet = panel.getBoundingClientRect()
    const button = toggle?.isConnected ? toggle.getBoundingClientRect() : sheet

    // The box spanning both is the corridor from the toggle into the sheet.
    return (
      point.x >= Math.min(sheet.left, button.left) - margin &&
      point.x <= Math.max(sheet.right, button.right) + margin &&
      point.y >= Math.min(sheet.top, button.top) - margin &&
      point.y <= Math.max(sheet.bottom, button.bottom) + margin
    )
  }

  // Reads the sidebar's top only once the pointer is already in the strip.
  const atEdge = (point: Point) => {
    const rtl = document.documentElement.dir === "rtl"

    if (rtl ? point.x < viewport - edge : point.x > edge) return false
    const aside = input.aside()

    return !!aside && point.y >= aside.getBoundingClientRect().top + header
  }

  function check() {
    if (!shown() || input.open() || !watch) return

    if ((pointer && inside(pointer)) || held()) return cancelClose()
    closing ??= setTimeout(() => {
      closing = undefined

      if (!(pointer && inside(pointer)) && !held()) hide()
    }, grace)
  }

  // Starts the edge's dwell while the pointer rests at the window's start edge, and cancels it once the pointer leaves.
  const approach = (event: PointerEvent | WheelEvent) => {
    if (shown() && motion.target === 100) return
    const target = event.target
    const near =
      !pressed &&
      !!pointer &&
      sidebarPeekEnabled() &&
      input.available() &&
      atEdge(pointer) &&
      // Within the shell's own layout, not a dialog or popover portaled over it.
      target instanceof Node &&
      !!input.aside()?.parentElement?.contains(target)

    if (!near) {
      if (opening?.from === "edge") cancelOpen()

      return
    }

    // Back at the edge while it slides out: it turns around at once.
    if (shown()) return show()

    if (opening) return
    start("edge", () => !!pointer && !pressed && !held() && atEdge(pointer))
  }

  const track = (event: PointerEvent | WheelEvent) => {
    if (event instanceof PointerEvent && event.pointerType === "touch") return

    if (event instanceof PointerEvent) pressed = event.buttons !== 0
    pointer = { x: event.clientX, y: event.clientY }
    approach(event)
    check()
  }

  makeEventListener(
    document,
    "pointerover",
    (event) => {
      if (event.pointerType === "touch" || !(event.target instanceof Element)) return
      const button = event.target.closest<HTMLElement>(toggles)

      if (!button || input.aside()?.contains(button)) return
      toggle = button

      if (shown()) return show()

      if (!sidebarPeekEnabled() || !input.available() || opening?.from === "toggle") return
      start("toggle", () => !!toggle?.matches(":hover"))
    },
    { passive: true },
  )
  makeEventListener(
    document,
    "pointerout",
    (event) => {
      // Leaving the window, or into an iframe or native view, reports no related target.
      if (!event.relatedTarget) {
        pointer = undefined
        check()
      }

      if (opening?.from !== "toggle" || !(event.target instanceof Element)) return
      const button = event.target.closest(toggles)

      if (button && !(event.relatedTarget instanceof Node && button.contains(event.relatedTarget))) cancelOpen()
    },
    { passive: true },
  )
  makeEventListener(document, "pointermove", track, { passive: true, capture: true })
  makeEventListener(document, "wheel", track, { passive: true, capture: true })
  makeEventListener(document, "scroll", () => check(), { passive: true, capture: true })
  makeEventListener(
    document,
    "pointerdown",
    (event) => {
      keyboard = false
      pressed = event.pointerType !== "touch"
    },
    { passive: true, capture: true },
  )
  makeEventListener(window, "pointerup", () => (pressed = false), { passive: true, capture: true })
  makeEventListener(window, "pointercancel", () => (pressed = false), { passive: true, capture: true })
  makeEventListener(document.documentElement, "pointerleave", () => {
    pointer = undefined
    check()
  })
  // Resizing the window from its start edge is no reason to peek.
  makeEventListener(window, "resize", () => {
    viewport = window.innerWidth

    if (opening?.from === "edge") cancelOpen()
  })
  makeEventListener(document, "keydown", (event) => {
    keyboard = true

    if (event.key !== "Escape" || !shown() || input.open() || event.defaultPrevented || held()) return
    hide(true)
  })
  makeEventListener(window, "blur", () => {
    pressed = false
    hide()
  })

  // Keyboard focus leaving the peek closes it; pointer clicks elsewhere already close it by leaving.
  createEffect(() => {
    const aside = input.aside()

    if (!aside) return
    const leave = (event: FocusEvent) => {
      const next = event.relatedTarget

      if (!keyboard || !shown() || input.open() || !(next instanceof Element)) return

      if (aside.contains(next) || toggle?.contains(next) || next.closest(menus)) return
      hide()
    }
    aside.addEventListener("focusout", leave)
    onCleanup(() => aside.removeEventListener("focusout", leave))
  })

  // Docking keeps the peeked sidebar where it is, sliding the rest of the way in if it hadn't arrived, while the layout
  // makes room; the docked sidebar takes over once it lands. Closing again before then slides the peek back out.
  createEffect(
    on(
      input.open,
      (open) => {
        if (!open) {
          handedOff = false

          return hide()
        }
        handedOff = shown()

        if (!handedOff) return end()
        cancelOpen()
        cancelClose()
        clearInterval(watch)
        watch = undefined
        run(100)
        // After the docked sidebar's own effect has started its flight, which effects don't order.
        queueMicrotask(() => {
          if (!input.open() || !shown()) return

          if (!input.continues()) {
            handedOff = false

            return end()
          }
          input.whenDocked(() => {
            if (input.open()) end()
          })
        })
      },
      { defer: true },
    ),
  )

  onCleanup(
    motionTuning.subscribe(() => {
      if (!sidebarPeekEnabled()) end()
    }),
  )

  onCleanup(end)

  return {
    shown,
    /** Whether the sidebar last docked from a peek, which already shows it. */
    handedOff: () => handedOff,
  }
}
