import { useEffect, useRef, useState } from 'react'
import type { FormEvent } from 'react'
import type { NotePatch } from '../api/FinanceApi.ts'
import { useParams, useNavigate, useLocation } from 'react-router-dom'
import { useFinanceData } from '../hooks/useFinanceData.ts'
import { useFinanceMutations } from '../hooks/useFinanceMutations.ts'
import { useInlineRename } from '../hooks/useInlineRename.ts'
import { itemsFor } from '../lib/notes.ts'
import { isTemp } from '../lib/tempId.ts'
import { RichTextEditor } from '../components/RichTextEditor.tsx'
import { brutalPageEditorLook } from '../components/brutalEditorLook.ts'
import { DeleteIcon } from '../components/icons.tsx'
import { PendingBadge } from '../components/PendingBadge.tsx'
import {
  BrutalBackLink,
  BrutalButton,
  BrutalConfirm,
  BrutalIconButton,
  BrutalInput,
  BrutalSecondaryButton,
  checkboxClass,
  detailTitleClass,
  panelClass,
  smallButtonClass,
} from '../components/brutal.tsx'
import { LoadError } from '../components/LoadError.tsx'
import { LoadingScreen } from '../components/LoadingScreen.tsx'

interface Draft {
  title: string
  body: string
  /** Checklist items written before the note exists. */
  items: string[]
}

const EMPTY_DRAFT: Draft = { title: '', body: '', items: [] }

/** Navigation state marking the hop from /notes/new to the note it created. */
interface DraftState {
  draftKey?: string
}

/**
 * /notes/:id, where "new" is a blank note that does not exist yet. It is
 * created the first time something is actually written — a title, a body, a
 * checklist item — so backing out of an untouched one saves nothing.
 *
 * Once created, the URL is swapped for the real id. The key carried in
 * navigation state keeps NotePage mounted across that swap, so the editor
 * (and whatever the cursor is in) is not torn down mid-typing.
 */
export function NoteDetail() {
  const { id = '' } = useParams()
  const location = useLocation()
  const key = (location.state as DraftState | null)?.draftKey ?? id
  return <NotePage key={key} routeId={id} />
}

function NotePage({ routeId }: { routeId: string }) {
  const isNew = routeId === 'new'
  const navigate = useNavigate()
  const { data, isPending, isError, error } = useFinanceData()
  const { addNote, updateNote, deleteNote, addNoteItem, updateNoteItem, deleteNoteItem } = useFinanceMutations()

  // What has been written but not yet sent: the whole note before it exists,
  // and checklist items waiting their turn (they go one at a time, so the
  // server numbers them in the order they were typed). Rendered from state;
  // the ref mirrors it for the async continuations, which outlive renders.
  const [draft, setDraftState] = useState<Draft>(EMPTY_DRAFT)
  const latest = useRef<Draft>(EMPTY_DRAFT)
  const setDraft = (change: Partial<Draft>) => {
    latest.current = { ...latest.current, ...change }
    setDraftState(latest.current)
  }
  // Refs, not state: two writes in one tick (a blur, then the unmount flush)
  // must see each other.
  const creating = useRef(false)
  const sendingItem = useRef(false)
  const [createdId, setCreatedId] = useState<number>()
  const [deleting, setDeleting] = useState(false)
  const [newItemText, setNewItemText] = useState('')
  // Opt-in for this session once "Add checklist" is clicked; once the note
  // actually has items, the section shows regardless (see showChecklist below).
  const [checklistOpen, setChecklistOpen] = useState(false)

  const noteId = isNew ? createdId : Number(routeId)
  const note = noteId === undefined ? undefined : data?.notes.find((n) => n.id === noteId)
  // The cache can lag the create: another write in flight holds back the
  // server's copy (see optimistic() in useFinanceMutations). Until it lands,
  // the draft keeps showing — and writes already go to the real id.
  const shown = note ?? draft

  const hasContent = (d: Draft) => Boolean(d.title || d.body || d.items.length > 0)

  /** Record a write to the not-yet-created note, creating it if it now has content. */
  const writeDraft = (change: Partial<Draft>) => {
    setDraft(change)
    if (!creating.current && hasContent(latest.current)) create()
  }

  const create = () => {
    const sent = latest.current
    const known = new Set(data?.notes.map((n) => n.id))
    creating.current = true
    // mutateAsync rather than mutate's callbacks: those are dropped if this
    // page unmounts first, and Back right after typing must still flush.
    addNote
      .mutateAsync({ title: sent.title || undefined, body: sent.body || undefined })
      .then((result) => {
        // addNote answers with the whole dataset, not the id it assigned, so
        // the new note is the one we had not seen. A note created elsewhere
        // in the same instant would be indistinguishable — accepted here.
        const created = Math.max(...result.notes.filter((n) => !known.has(n.id)).map((n) => n.id))
        if (!Number.isFinite(created)) return
        setCreatedId(created)
        const now = latest.current
        const patch: NotePatch = {}
        if (now.title !== sent.title) patch.title = now.title || null
        if (now.body !== sent.body) patch.body = now.body || null
        if (Object.keys(patch).length > 0) updateNote.mutate({ id: created, patch })
        sendNextItem(created)
      })
      .catch(() => {
        // The mutation's own onError has already rolled back and toasted; the
        // draft stays on screen, and the next write (or leaving) retries.
      })
      .finally(() => {
        creating.current = false
      })
  }

  /** Send the oldest queued checklist item, then the next once it answers. */
  const sendNextItem = (id: number) => {
    const [text, ...rest] = latest.current.items
    if (sendingItem.current || text === undefined) return
    sendingItem.current = true
    setDraft({ items: rest })
    addNoteItem
      .mutateAsync({ noteId: id, input: { text } })
      .catch(() => {
        // Toasted and rolled back by the mutation itself; carry on with the rest.
      })
      .finally(() => {
        sendingItem.current = false
        sendNextItem(id)
      })
  }

  // The id writes go to, once there is one — even before the cache has the note.
  const targetId = note?.id ?? createdId

  // rename only calls this when the title changed.
  const saveTitle = (title: string) => {
    if (targetId === undefined) return writeDraft({ title })
    setDraft({ title })
    updateNote.mutate({ id: targetId, patch: { title: title || null } })
  }

  const saveBody = (html: string) => {
    if (html === (shown.body ?? '')) return
    if (targetId === undefined) return writeDraft({ body: html })
    setDraft({ body: html })
    updateNote.mutate({ id: targetId, patch: { body: html || null } })
  }

  const rename = useInlineRename(shown.title ?? '', saveTitle, { allowEmpty: true })

  // Leaving without a blur — the browser's Back, a swipe — skips the title's
  // save, and a draft whose create failed would otherwise just be dropped.
  // The flush is refreshed every render so the unmount sees current values.
  const flushOnLeave = useRef<() => void>(() => {})
  useEffect(() => {
    flushOnLeave.current = () => {
      if (rename.renaming) rename.save()
      else if (targetId === undefined && !creating.current && hasContent(latest.current)) create()
    }
  })
  useEffect(() => () => flushOnLeave.current(), [])

  useEffect(() => {
    if (isNew && note) {
      void navigate(`/notes/${note.id}`, { replace: true, state: { draftKey: routeId } satisfies DraftState })
    }
  }, [isNew, note, navigate, routeId])

  if (isPending) return <LoadingScreen />
  if (isError || !data) return <LoadError error={error} />
  if (!isNew && !note) return <LoadError error={new Error('Note not found')} />

  const items = targetId === undefined ? [] : itemsFor(data.note_items, targetId)
  const pending = note ? isTemp(note.id) : false
  const showChecklist = checklistOpen || items.length > 0 || draft.items.length > 0
  // Queued items are on their way only once a save is: after a failed
  // create they are just unsaved, and badging them would claim otherwise.
  const queueMoving = targetId !== undefined || addNote.isPending

  const addItem = (e: FormEvent) => {
    e.preventDefault()
    const trimmed = newItemText.trim()
    if (!trimmed) return
    setNewItemText('')
    const queued = [...latest.current.items, trimmed]
    if (targetId === undefined) return writeDraft({ items: queued })
    setDraft({ items: queued })
    sendNextItem(targetId)
  }

  return (
    <div className="space-y-8">
      <BrutalBackLink to="/notes">Notes</BrutalBackLink>

      <div className="flex items-center justify-between gap-4">
        <input
          autoFocus={isNew}
          aria-label="Note title"
          placeholder="Title"
          disabled={pending}
          value={rename.renaming ? rename.draft : (shown.title ?? '')}
          onFocus={rename.start}
          onChange={(e) => {
            if (!rename.renaming) rename.start()
            rename.setDraft(e.target.value)
          }}
          onBlur={rename.save}
          onKeyDown={rename.onKeyDown}
          className={`${detailTitleClass} min-w-0 flex-1 border-b-2 border-transparent bg-transparent placeholder:text-neutral-300 focus:border-black focus:outline-none`}
        />
        {addNote.isPending && <PendingBadge />}
        {note && (
          <BrutalIconButton label="Delete note" onClick={() => setDeleting(true)}>
            <DeleteIcon />
          </BrutalIconButton>
        )}
      </div>

      {pending ? (
        <p className={`${panelClass} p-4 font-mono text-xs text-neutral-500`}>Saving…</p>
      ) : (
        <RichTextEditor look={brutalPageEditorLook} value={shown.body ?? ''} onChange={saveBody} />
      )}

      {!pending && !showChecklist && (
        <BrutalSecondaryButton type="button" className="shadow-hard-xs" onClick={() => setChecklistOpen(true)}>
          + Add checklist
        </BrutalSecondaryButton>
      )}

      {showChecklist && (
        <div className={`${panelClass} space-y-4 p-6`}>
          <form onSubmit={addItem} className="flex items-stretch gap-3">
            <BrutalInput
              aria-label="New checklist item"
              value={newItemText}
              onChange={(e) => setNewItemText(e.target.value)}
              placeholder="Add an item…"
              className="min-w-0 flex-1 placeholder:text-neutral-500"
            />
            <BrutalButton type="submit">
              Add
            </BrutalButton>
          </form>
          {items.length === 0 && draft.items.length === 0 ? (
            <p className="font-mono text-xs text-neutral-500">No items yet.</p>
          ) : (
            <ul className="divide-y divide-black border-y border-black">
              {items.map((item) => {
                const itemPending = isTemp(item.id)
                return (
                  <li key={item.id} className="flex items-center gap-3 py-3">
                    <input
                      type="checkbox"
                      aria-label={item.text}
                      className={checkboxClass}
                      checked={item.done}
                      disabled={itemPending}
                      onChange={(e) => updateNoteItem.mutate({ id: item.id, patch: { done: e.target.checked } })}
                    />
                    <span className={`flex-1 font-mono text-sm ${item.done ? 'text-neutral-400 line-through' : 'text-black'}`}>
                      {item.text}
                    </span>
                    {itemPending ? (
                      <PendingBadge />
                    ) : (
                      <button type="button" className={smallButtonClass} onClick={() => deleteNoteItem.mutate(item.id)}>
                        Remove
                      </button>
                    )}
                  </li>
                )
              })}
              {draft.items.map((text, i) => (
                <li key={`queued-${i}`} className="flex items-center gap-3 py-3">
                  <input type="checkbox" aria-label={text} className={checkboxClass} checked={false} disabled readOnly />
                  <span className="flex-1 font-mono text-sm text-black">{text}</span>
                  {queueMoving && <PendingBadge />}
                </li>
              ))}
            </ul>
          )}
        </div>
      )}

      {note && (
        <BrutalConfirm
          open={deleting}
          title="Delete note"
          message={note.title ? `Delete "${note.title}"? This cannot be undone.` : 'Delete this note? This cannot be undone.'}
          confirmLabel="Delete note"
          onConfirm={() => {
            // Leaving first is safe: the note is already gone from the cached
            // list this navigates to, and a failure restores it and raises a
            // toast — matching BillDetail's own delete-and-leave pattern.
            setDeleting(false)
            void navigate('/notes')
            deleteNote.mutate(note.id)
          }}
          onClose={() => setDeleting(false)}
        />
      )}
    </div>
  )
}
