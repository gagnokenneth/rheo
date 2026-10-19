import { useEffect, useRef } from 'react'
import { EditorContent, useEditor } from '@tiptap/react'
import StarterKit from '@tiptap/starter-kit'
import type { Editor } from '@tiptap/react'

/** Class sets for the editor's chrome — see brutalEditorLook.ts: the Edit
 *  Task modal's and the note page's. */
export interface EditorLook {
  frame: string
  toolbar: string
  button: string
  active: string
  /** Extra classes on the Italic button's own label. */
  italicLabel: string
  content: string
}

const TOOLS: Array<{ label: string; mark: string; toggle: (editor: Editor) => void }> = [
  { label: 'Bold', mark: 'bold', toggle: (e) => e.chain().focus().toggleBold().run() },
  { label: 'Italic', mark: 'italic', toggle: (e) => e.chain().focus().toggleItalic().run() },
  { label: 'Bullets', mark: 'bulletList', toggle: (e) => e.chain().focus().toggleBulletList().run() },
  { label: 'Numbered', mark: 'orderedList', toggle: (e) => e.chain().focus().toggleOrderedList().run() },
]

/**
 * A minimal WYSIWYG editor for a Note's freeform body. Stores content as
 * HTML (editor.getHTML()) — bodyPreview in lib/notes.ts strips tags back out
 * for the one-line list summary.
 */
export function RichTextEditor({
  value,
  onChange,
  autoFocus,
  look: ui,
}: {
  value: string
  onChange: (html: string) => void
  autoFocus?: boolean
  look: EditorLook
}) {
  const editor = useEditor({
    extensions: [StarterKit],
    content: value,
    autofocus: autoFocus ? 'end' : false,
    // An emptied editor still holds "<p></p>"; report it as '' so callers'
    // "empty means cleared" checks work without parsing HTML.
    onBlur: ({ editor }) => onChange(editor.isEmpty ? '' : editor.getHTML()),
  })

  // Re-seed the editor when `value` changes out from under it (a query
  // refetch, an optimistic-update rollback) — useEditor only reads `content`
  // on mount, so without this the editor keeps showing stale text and a
  // later blur would write it back over the newer server value.
  useEffect(() => {
    if (editor && value !== editor.getHTML()) editor.commands.setContent(value)
  }, [editor, value])

  // Leaving without a blur (the browser's Back, a swipe) would drop unsaved
  // text, so unmount hands over anything not yet reported. Refs, refreshed
  // each render, give the cleanup the current value and callback.
  const latest = useRef({ value, onChange })
  useEffect(() => {
    latest.current = { value, onChange }
  })
  useEffect(() => {
    if (!editor) return
    return () => {
      const html = editor.isEmpty ? '' : editor.getHTML()
      if (html !== latest.current.value) latest.current.onChange(html)
    }
  }, [editor])

  if (!editor) return null

  return (
    <div className={ui.frame}>
      <div className={ui.toolbar}>
        {TOOLS.map((tool) => (
          <button
            key={tool.mark}
            type="button"
            onMouseDown={(e) => e.preventDefault()}
            onClick={() => tool.toggle(editor)}
            className={`${ui.button} ${editor.isActive(tool.mark) ? ui.active : ''}`}
          >
            <span className={tool.mark === 'italic' ? ui.italicLabel : ''}>{tool.label}</span>
          </button>
        ))}
      </div>
      <EditorContent
        editor={editor}
        className={`${ui.content} [&_.tiptap]:outline-none [&_ol]:list-decimal [&_ol]:pl-5 [&_p]:my-1 [&_ul]:list-disc [&_ul]:pl-5`}
      />
    </div>
  )
}
