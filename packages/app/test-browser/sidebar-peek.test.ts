import { afterEach, expect, it } from "bun:test"
import { createRoot } from "solid-js"
import { motionTuning } from "@opencode/ui/motion-tuning"
import { createSidebarPeek, sidebarPeekEnabled } from "../src/shell/sidebar-peek"

const cleanups: (() => void)[] = []

afterEach(() => {
  for (const cleanup of cleanups.splice(0)) cleanup()
  document.body.innerHTML = ""
  setEnabled(true)
})

function setEnabled(on: boolean) {
  const knob = motionTuning.list().find((item) => item.id === "sidebar.peek")

  if (knob?.kind === "toggle") motionTuning.set(knob, on)
}

function mount() {
  const row = document.createElement("div")
  const aside = document.createElement("aside")
  const panel = document.createElement("div")
  const content = document.createElement("main")
  aside.append(panel)
  row.append(aside, content)
  document.body.append(row)

  const peek = createRoot((dispose) => {
    cleanups.push(dispose)

    return createSidebarPeek({
      available: () => true,
      open: () => false,
      aside: () => aside,
      panel: () => panel,
      paint: () => {},
      continues: () => true,
      whenDocked: (run) => run(),
    })
  })

  return { peek, content }
}

// Rests the pointer on the window's start edge, below the header band.
function restOnEdge(target: Element) {
  target.dispatchEvent(
    new PointerEvent("pointermove", { bubbles: true, clientX: 2, clientY: 300, pointerType: "mouse" }),
  )
}

const afterDwell = () => Bun.sleep(160)

it("peeks once the pointer rests on the window's start edge", async () => {
  const view = mount()
  restOnEdge(view.content)
  await afterDwell()
  expect(view.peek.shown()).toBe(true)
})

it("a press, a drag, a dialog or a resize clears the pending peek", async () => {
  const interruptions = [
    () => document.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, pointerType: "mouse" })),
    () => document.dispatchEvent(new Event("dragstart", { bubbles: true })),
    () => window.dispatchEvent(new Event("resize")),
    () => {
      const dialog = document.createElement("div")
      dialog.setAttribute("role", "dialog")
      document.body.append(dialog)
    },
  ]

  for (const interrupt of interruptions) {
    const view = mount()
    restOnEdge(view.content)
    interrupt()
    await afterDwell()
    expect(view.peek.shown()).toBe(false)

    for (const cleanup of cleanups.splice(0)) cleanup()
    document.body.innerHTML = ""
  }
})

it("listens to nothing while the experiment is off", async () => {
  setEnabled(false)
  expect(sidebarPeekEnabled()).toBe(false)
  const view = mount()
  restOnEdge(view.content)
  await afterDwell()
  expect(view.peek.shown()).toBe(false)
})
