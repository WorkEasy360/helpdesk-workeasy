# The AI assistant's UI

The assistant interface: the behaviour, the styles, the robot, and the four things that
would otherwise cost an afternoon. This is the shared WorkEasy360 assistant-UI document,
implemented here.

The backend half — tools, actions, prompt, safety — is a separate document:
[backend/docs/AI-ASSISTANT.md](../../backend/docs/AI-ASSISTANT.md). This one is only what
the user sees and touches, and it works against any backend that answers the contract in
section 6.

Implementation in this product:
[components/assistant/assistant-panel.tsx](../components/assistant/assistant-panel.tsx),
[components/assistant/assistant-avatar.tsx](../components/assistant/assistant-avatar.tsx),
and the `c-fab` / `c-chatbox` / `c-chat-*` block of
[app/components.css](../app/components.css).

---

## 1. What the user sees

- A round **launcher** floats bottom-right on every signed-in page: a navy disc with a
  soft green ring, carrying a robot face. It swaps to a close icon while the chat is open.
- It opens a **chat window** just above it. The window never covers the launcher, and
  never blocks the page.
- **On phones** the chat takes the whole screen, with the close button in its header.
- **Escape** closes the chat and returns focus to the launcher.
- The window is a **fixed frame**: the same size with one message or twenty. The
  conversation scrolls inside it.
- An answer may carry an **"Open …" link button**, and a **confirmation card**: a title,
  the checked facts as label/value rows, one sentence saying what will happen, and one
  button. Nothing changes until the user presses it.
- A standing footer line: **"Nothing changes until you confirm it."**
- History lives in **session storage** — this browser tab only. The server keeps no
  transcript.
- When the backend reports a stub or disabled provider, the panel says so above the
  conversation rather than pretending to be a model.

**Per product:** the launcher renders nothing at all for a role without `ai.use`, so a
light agent never sees it.

---

## 2. Tokens it needs

The styles read these and nothing else. They are all in
[app/tokens.css](../app/tokens.css); see
[DESIGN-SYSTEM.md](./DESIGN-SYSTEM.md) for the full set.

| Token | Light | Dark | Used for |
|---|---|---|---|
| `--we-primary` | `#1B3040` | `#27455A` | the disc, user bubbles, the visor |
| `--we-primary-hover` | `#112532` | `#315770` | launcher hover |
| `--we-on-primary` | `#F1F5F9` | `#F1F5F9` | the robot's white, text on the disc |
| `--we-accent` | `#4ADE80` | `#4ADE80` | the ring, antenna tip, eyes |
| `--we-accent-hover` | `#22C55E` | `#22C55E` | suggestion hover border |
| `--we-accent-ring` | 50% accent | same | the halo, via `color-mix` so it composites on any background |
| `--we-surface` | `#FFFFFF` | `#112532` | the window, the card |
| `--we-surface-muted` | `#F1F5F9` | `#16303F` | assistant bubbles |
| `--we-border` / `--we-border-strong` | `#E2E8F0` / `#CBD5E1` | `#27455A` / `#36576E` | window edges / card and suggestion edges |
| `--we-text-primary` / `-body` / `-secondary` | `#1B3040` / `#334155` / `#64748B` | `#F1F5F9` / `#CBD5E1` / `#94A3B8` | titles / messages / hints |
| `--we-radius-md` / `-lg` / `-full` | 8px / 12px / 9999px | — | bubbles and card / the window / the disc |
| `--we-shadow-lg` | nearly flat, wide | heavier | the window and the disc |
| `--we-space-1…8` | 4, 8, 12, 16, 20, 24, 32 px | — | spacing, on a 4px grid |
| `--we-size-fab` | 56px | — | the launcher, and the window's offset |
| `--we-size-control` | 36px | — | composer minimum height |
| `--we-font-size-xs/sm/base` | 12 / 13 / 14px | — | note / hints / messages |
| `--we-motion-fast` / `-drawer` / `-ease` | 150ms / 200ms / ease | — | hover / open |

This product defines the halo once as `--we-accent-ring` rather than inlining
`color-mix` at each use. Same result, and it is then a token like everything else.

---

## 3. The styles

They live in the `c-fab` / `c-chatbox` / `c-chat-*` block of
[app/components.css](../app/components.css), which is loaded **before** Tailwind's
layers — see section 7, gotcha 1.

---

## 4. The robot

[`AssistantAvatar`](../components/assistant/assistant-avatar.tsx): one component, no
image files, no icon library. Every colour is a token, so it follows light and dark on
its own — and it works unchanged on a customer-branded help centre, where those tokens
are remapped to the organization's colour.

The viewBox is the mark's own bounding box — 32 wide by 30 tall, antenna tip to chin —
which is why `.c-fab-face` can size it as a percentage of the disc.

It appears twice: in the launcher at `.c-fab-face`, and in the chat header inside a
`.c-agent-chip`.

---

## 5. What the panel does

State: `open`, `turns`, `question`, `thinking`, plus the welcome query.

- **On first open**, call `GET /assistant` for `enabled`, `provider` and role-appropriate
  `suggestions`. Not on page load — the panel shouldn't cost a request to every page.
- **Restore history during the first render**, from session storage, with a lazy state
  initialiser. Not in an effect (section 7).
- **Store only** `{id, role, text}`. Never store a proposal: when the tab comes back the
  world may have moved on, and a stale confirm button is a lie.
- **Send** the question plus the last 12 messages as history.
- **While thinking**, show a spinner bubble and disable the send button.
- **On an answer**, append a turn carrying its text, link, proposal and `actionNote`.
- **Confirm** calls the proposal's own `request` verbatim through the product's normal
  API client. On success show a done badge and the optional follow-up link; on failure
  show the server's message and leave the button pressable. Only the server may say a
  change happened.
- **Escape** closes and returns focus to the launcher. **Enter** sends, **Shift+Enter**
  makes a newline.
- **Clear** empties the conversation and the stored copy.

Accessibility: the window is `role="dialog"` with an `aria-label`; the message list is
`aria-live="polite"`; the launcher carries `aria-expanded` and a label that changes with
its state; the textarea has a visually hidden label.

---

## 6. The API contract

```
GET /assistant
  -> { enabled: boolean, provider: string | null, suggestions: string[], dailyLimit: number }

POST /assistant   { question: string, history?: {role, content}[] }
  -> { text: string,
       link: { label: string, path: string } | null,
       proposal: Proposal | null,
       actionNote: string | null }

Proposal = {
  kind, title,
  summary: [string, string][],      // label/value rows: the facts that were checked
  effect: string,                   // one sentence, present tense
  confirmLabel: string,
  danger: boolean,                  // red button for cancels, rejections, anything emailed
  request: { method: "POST" | "PATCH", path: string, body: object },
  done?: { label: string, path: string }
}
```

Status codes the panel surfaces as plain text: **401** (session expired — the normal
client handles it), **429** (allowance spent), **502** (model unavailable), **503**
(assistant not configured).

`actionNote` is the case worth getting right: the model suggested something, the server
checked it and refused. Shown as a hint under the message, with **no** card.

**This product's responses are a superset.** They add `remainingToday` (what the footer
counts down) and `usedTools` (the quiet "Checked:" line). `enabled` is always `true`:
Helpdesk has no on/off switch, and an organization that has configured no model still
gets a working chat from the built-in deterministic provider — so `provider` reports
`STUB` and the panel says so, rather than there being an unavailable state at all.

---

## 7. Four things that will cost you time

1. **A utility class will beat your component CSS.** Component styles load before
   Tailwind's utilities, so an avatar defaulting to `class="size-icon"` silently
   overrides `.c-fab > svg { width: 49% }` and the robot renders at 18px in a 56px disc.
   Give the launcher's avatar its own class — `.c-fab-face` — and pass only that.
2. **`min-height: 0` on the scrolling body.** Without it the `flex: 1` message list
   refuses to shrink below its content and pushes the composer out of the fixed frame.
3. **Fixed height, not max-height.** `max-height` lets the window grow with the
   conversation, which feels unsettled. Set `height` and keep `max-height` only as a
   guard for short viewports.
4. **Restore history in a render-time initialiser, not an effect.** `setState` inside
   `useEffect` trips React's lint rule and causes a cascading render. A lazy
   `useState(loadThread)` is safe here because the panel starts closed, so nothing of the
   conversation reaches the server-rendered markup.

---

## 8. Verifying a build

Typecheck, lint, build — then confirm the compiled CSS actually contains `.c-fab`,
`.c-fab-face` and `.c-chatbox`. A rule can compile away, or lose to a utility, without
any error.
