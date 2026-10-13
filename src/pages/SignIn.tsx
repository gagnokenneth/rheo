import { useState } from 'react'
import type { FormEvent } from 'react'
import { useAuth } from '../auth/useAuth.ts'
import { MIN_PASSWORD_LENGTH, USERNAME_RULE, isValidUsername } from '../auth/password.ts'
import { BrutalButton, BrutalField, BrutalFormError, BrutalInput } from '../components/brutal.tsx'
import { isLiveApi } from '../api/index.ts'

type Mode = 'signin' | 'signup'

export function SignIn() {
  const { signIn, signUp } = useAuth()
  const [mode, setMode] = useState<Mode>('signin')
  const [username, setUsername] = useState('')
  const [password, setPassword] = useState('')
  const [inviteCode, setInviteCode] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [pending, setPending] = useState(false)

  const creating = mode === 'signup'
  const needsInvite = isLiveApi()
  const submitLabel = pending
    ? creating
      ? 'Creating account…'
      : 'Signing in…'
    : creating
      ? 'Create account'
      : 'Sign in'

  const switchMode = (next: Mode) => {
    setMode(next)
    setError(null)
    setPassword('')
    setInviteCode('')
  }

  const submit = async (e: FormEvent) => {
    e.preventDefault()
    setError(null)

    if (creating && !isValidUsername(username)) {
      setError(`Use ${USERNAME_RULE}`)
      return
    }
    if (creating && password.length < MIN_PASSWORD_LENGTH) {
      setError(`Use at least ${MIN_PASSWORD_LENGTH} characters for your password.`)
      return
    }

    setPending(true)
    try {
      if (creating) await signUp(username, password, inviteCode)
      else await signIn(username, password)
    } catch (err) {
      // Backend messages are already written for the person reading them.
      setError(err instanceof Error ? err.message : 'Something went wrong. Try again.')
      setPending(false)
    }
  }

  return (
    <div className="flex min-h-screen items-center justify-center bg-neutral-50 px-4">
      <div className="w-full max-w-sm border-2 border-black bg-white p-8 shadow-hard-lg">
        {/* A settled strip: the state this app exists to get you to. */}
        <div aria-hidden className="flex gap-1.5">
          {Array.from({ length: 12 }, (_, i) => (
            <span key={i} className="h-2.5 flex-1 border border-black bg-black" />
          ))}
        </div>

        <h1 className="mt-6 text-3xl font-bold tracking-tight text-black uppercase">Rheo</h1>
        <p className="mt-2 font-mono text-xs text-neutral-500">
          {creating ? 'Create an account to start organizing your money and time.' : 'Your money and time, in one place.'}
        </p>

        <form onSubmit={submit} className="mt-8 flex flex-col gap-5">
          <BrutalField label="Username" htmlFor="signin-username" required>
            <BrutalInput
              id="signin-username"
              value={username}
              onChange={(e) => setUsername(e.target.value)}
              autoComplete="username"
              autoCapitalize="none"
              required
            />
          </BrutalField>
          <BrutalField label="Password" htmlFor="signin-password" required>
            <BrutalInput
              id="signin-password"
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              autoComplete={creating ? 'new-password' : 'current-password'}
              required
            />
          </BrutalField>
          {creating && needsInvite && (
            <BrutalField label="Invite code" htmlFor="signin-invite" required>
              <BrutalInput
                id="signin-invite"
                value={inviteCode}
                onChange={(e) => setInviteCode(e.target.value)}
                required
              />
            </BrutalField>
          )}

          {error && <BrutalFormError>{error}</BrutalFormError>}

          <BrutalButton type="submit" disabled={pending} className="mt-1 w-full">
            {submitLabel}
          </BrutalButton>
        </form>

        <button
          type="button"
          onClick={() => switchMode(creating ? 'signin' : 'signup')}
          className="mt-6 font-mono text-xs text-black underline-offset-4 hover:underline"
        >
          {creating ? 'I already have an account' : 'Create an account'}
        </button>
      </div>
    </div>
  )
}
