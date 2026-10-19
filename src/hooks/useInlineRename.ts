import { useState } from 'react'
import type { KeyboardEvent } from 'react'

/**
 * Shared click-to-rename state machine: click the label to start editing,
 * blur or Enter saves (skipped if the draft is empty or unchanged), Escape
 * cancels without saving — and only the rename: it is marked handled, so a
 * modal around the input (useEscape) stays open. Used by NoteDetail (note
 * title — its input is always shown, editing from focus, and may be emptied),
 * TaskColumnLane (column name) and ManageSourcesModal (a source) — each
 * renders its own markup; this hook owns the state and the rules.
 */
export function useInlineRename(
  currentValue: string,
  onSave: (trimmed: string) => void,
  { allowEmpty = false }: { allowEmpty?: boolean } = {},
) {
  const [renaming, setRenaming] = useState(false)
  const [draft, setDraft] = useState('')

  const start = () => {
    setDraft(currentValue)
    setRenaming(true)
  }

  const save = () => {
    // Not renaming means Escape already cancelled — the blur that follows
    // must not save the abandoned draft.
    if (!renaming) return
    setRenaming(false)
    const trimmed = draft.trim()
    if ((trimmed || allowEmpty) && trimmed !== currentValue) onSave(trimmed)
  }

  const cancel = () => setRenaming(false)

  const onKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
    // Blur (not a direct save() call) so onBlur remains the single place a
    // save happens — calling both would unmount the input mid-render and
    // let the resulting native blur fire a second, stale save with the same
    // value.
    if (e.key === 'Enter') e.currentTarget.blur()
    if (e.key === 'Escape') {
      e.preventDefault()
      cancel()
    }
  }

  return { renaming, draft, setDraft, start, save, cancel, onKeyDown }
}
