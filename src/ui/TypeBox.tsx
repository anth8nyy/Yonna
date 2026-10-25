import { useEffect, useRef, useState } from 'react'
import { useStore } from '../store'

/**
 * The typing line — T opens it, for anything easier written than said, and
 * for Greek (he answers in English).
 *
 * It sits directly under the conversation, laid out like one more line of it
 * ("YOU  …"), and the text shows as it is typed, like any normal text field.
 * No placeholder, no button. Enter sends; Escape, or leaving it empty, closes.
 */
export function TypeBox({ onSubmit }: { onSubmit: (text: string) => void }) {
  const open = useStore((s) => s.typing)
  const [text, setText] = useState('')
  const input = useRef<HTMLInputElement>(null)

  useEffect(() => {
    if (open) input.current?.focus()
  }, [open])

  const close = () => {
    setText('')
    useStore.getState().setTyping(false)
  }

  if (!open) return null

  return (
    <form
      className="typeline log-line"
      onSubmit={(e) => {
        e.preventDefault()
        const t = text.trim()
        close()
        if (t) onSubmit(t)
      }}
    >
      <span className="log-who">YOU</span>
      {/* What you see: the text and a small white cursor after it. The real
          input sits on top, invisible, and does the typing — a native caret's
          size and colour cannot be styled, so it is drawn here instead. */}
      <span className="typeline-field">
        <span className="typeline-mirror">
          {text}
          <span className="typeline-caret" />
        </span>
      <input
        ref={input}
        className="typeline-input"
        value={text}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Escape') {
            e.preventDefault()
            close()
          }
        }}
        onBlur={() => {
          if (!text.trim()) close()
        }}
        aria-label="Type to Yonna"
        spellCheck={false}
        autoComplete="off"
      />
      </span>
    </form>
  )
}
