import { useNavigate } from 'react-router-dom'
import { useFinanceData } from '../hooks/useFinanceData.ts'
import { groupItemsByNote, doneCount, bodyPreview } from '../lib/notes.ts'
import { isTemp } from '../lib/tempId.ts'
import { PendingBadge } from '../components/PendingBadge.tsx'
import { BrutalButton, BrutalCardRow, BrutalEmptyState, BrutalPageHeader } from '../components/brutal.tsx'
import { LoadError } from '../components/LoadError.tsx'
import { LoadingScreen } from '../components/LoadingScreen.tsx'

export function Notes() {
  const { data, isPending, isError, error } = useFinanceData()
  const navigate = useNavigate()

  if (isPending) return <LoadingScreen />
  if (isError || !data) return <LoadError error={error} />

  const itemsByNote = groupItemsByNote(data.note_items)

  return (
    <div className="space-y-10">
      <BrutalPageHeader
        title="Notes"
        action={
          <BrutalButton type="button" onClick={() => void navigate('/notes/new')}>
            + Add note
          </BrutalButton>
        }
      />

      {data.notes.length === 0 ? (
        <BrutalEmptyState title="Nothing tracked yet">Jot down a note, or start a checklist on one.</BrutalEmptyState>
      ) : (
        <div className="space-y-3">
          {data.notes.map((note) => {
            const pending = isTemp(note.id)
            const { done, total } = doneCount(itemsByNote.get(note.id) ?? [])
            const summary = [bodyPreview(note), total > 0 ? `${done} of ${total} done` : '']
              .filter(Boolean)
              .join(' · ')
            return (
              <BrutalCardRow
                key={note.id}
                to={`/notes/${note.id}`}
                pending={pending}
                className="flex items-center justify-between gap-4 px-5 py-6"
              >
                <div className="min-w-0 space-y-1">
                  {note.title && <p className="truncate text-base font-bold tracking-tight text-black">{note.title}</p>}
                  {summary && <p className="truncate font-mono text-xs text-neutral-500">{summary}</p>}
                </div>
                {pending ? <PendingBadge /> : <span aria-hidden className="font-mono text-xs text-neutral-500">→</span>}
              </BrutalCardRow>
            )
          })}
        </div>
      )}
    </div>
  )
}
