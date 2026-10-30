import { act, cleanup, renderHook, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { en } from '@/i18n/en'
import { createClientSessionState } from '@/lib/chat-runtime'
import { $activeGatewayProfile } from '@/store/profile'
import { $connection, $sessions } from '@/store/session'
import { $sessionStates } from '@/store/session-states'

import { useSubmitPrompt } from './submit'
import type { GatewayRequest } from './utils'

vi.mock('@/store/gateway', async original => ({
  ...(await original<Record<string, unknown>>()),
  retainGatewayForSessionTurn: vi.fn(async () => () => undefined)
}))

type ClientSessionState = ReturnType<typeof createClientSessionState>

const previousDesktop = window.hermesDesktop

beforeEach(() => {
  window.localStorage.clear()
  $sessions.set([])
  $sessionStates.set({})
  $connection.set(null)
  $activeGatewayProfile.set('default')
})

afterEach(() => {
  window.hermesDesktop = previousDesktop
  cleanup()
  vi.restoreAllMocks()
})

/**
 * Chat A is open with a live runtime. Enter starts the send; before it reaches
 * prompt.submit the user opens chat B (route, selection and active runtime all
 * move to B), which is what "submit, then go to another session" does.
 */
function navigateAwayHarness() {
  let state: ClientSessionState = createClientSessionState()
  let routeToken = '/stored-a::'
  const activeSessionIdRef = { current: 'runtime-a' as string | null }
  const selectedStoredSessionIdRef = { current: 'stored-a' as string | null }

  const requestGateway = vi.fn(
    async (method: string, params?: Record<string, unknown>) =>
      (method === 'prompt.submit'
        ? { admission_id: params?.submission_id, session_id: params?.session_id, status: 'started' }
        : {}) as never
  )

  const deps = {
    activeSessionIdRef,
    selectedStoredSessionIdRef,
    busyRef: { current: false },
    copy: en.desktop,
    createBackendSessionForSend: vi.fn(async () => null),
    getRoutedStoredSessionId: () => selectedStoredSessionIdRef.current,
    getRuntimeIdForStoredSession: (storedId: string) =>
      ({ 'stored-a': 'runtime-a', 'stored-b': 'runtime-b' })[storedId] ?? null,
    getRouteToken: () => routeToken,
    requestGateway: requestGateway as GatewayRequest,
    runtimeIdByStoredSessionIdRef: {
      current: new Map([
        ['stored-a', 'runtime-a'],
        ['stored-b', 'runtime-b']
      ])
    },
    resumeStoredSession: vi.fn(),
    syncAttachmentsForSubmit: vi.fn(async (sessionId: string) => ({ sessionId, attachments: [] })),
    updateSessionState: vi.fn((_sid: string, updater: (s: ClientSessionState) => ClientSessionState) => {
      state = updater(state)

      return state
    })
  }

  const openChatB = () => {
    routeToken = '/stored-b::'
    selectedStoredSessionIdRef.current = 'stored-b'
    activeSessionIdRef.current = 'runtime-b'
  }

  const submits = () => requestGateway.mock.calls.filter(([method]) => method === 'prompt.submit')
  const userBubbles = () => state.messages.filter(message => message.role === 'user')

  return { deps, openChatB, requestGateway, submits, userBubbles }
}

describe('a send is not cancelled when the user opens another chat right after Enter', () => {
  it('reaches its own chat when the chat switch lands during the journal write', async () => {
    const harness = navigateAwayHarness()

    let releaseJournal: () => void = () => {}
    let journalWrites = 0

    // The native journal write is an IPC round trip to the main process; a busy
    // main process stretches it, which is the window a quick switch lands in.
    window.hermesDesktop = {
      ...previousDesktop,
      preparedSubmissions: {
        read: async () => '{}',
        update: async (_key: string, entry: null | string) => {
          if (entry === null) {
            return
          }

          journalWrites += 1
          await new Promise<void>(resolve => {
            releaseJournal = resolve
          })
        }
      }
    } as never

    const { result } = renderHook(() => useSubmitPrompt(harness.deps as never))
    let sent: Promise<boolean> = Promise.resolve(false)

    act(() => {
      sent = result.current('send this to chat A', { composerScope: 'stored-a', submission_id: 'send-a' })
    })

    await waitFor(() => expect(journalWrites).toBe(1))
    harness.openChatB()
    releaseJournal()

    await act(async () => {
      expect(await sent).toBe(true)
    })

    expect(harness.submits()).toHaveLength(1)
    expect(harness.submits()[0][1]).toMatchObject({
      session_id: 'runtime-a',
      submission_id: 'send-a',
      text: 'send this to chat A'
    })
    expect(harness.userBubbles()).toHaveLength(1)
  })

  it('reaches its own chat when the chat switch lands during attachment sync', async () => {
    const harness = navigateAwayHarness()

    let releaseSync: () => void = () => {}

    harness.deps.syncAttachmentsForSubmit.mockImplementation(async (sessionId: string) => {
      await new Promise<void>(resolve => {
        releaseSync = resolve
      })

      return { sessionId, attachments: [] }
    })

    const { result } = renderHook(() => useSubmitPrompt(harness.deps as never))
    let sent: Promise<boolean> = Promise.resolve(false)

    act(() => {
      sent = result.current('also for chat A', { composerScope: 'stored-a', submission_id: 'send-a2' })
    })

    await waitFor(() => expect(harness.deps.syncAttachmentsForSubmit).toHaveBeenCalledTimes(1))
    harness.openChatB()
    releaseSync()

    await act(async () => {
      expect(await sent).toBe(true)
    })

    expect(harness.submits()).toHaveLength(1)
    expect(harness.submits()[0][1]).toMatchObject({ session_id: 'runtime-a', text: 'also for chat A' })
    expect(harness.userBubbles()).toHaveLength(1)
  })

  it('still refuses a send whose composer scope names another chat (#59305)', async () => {
    const harness = navigateAwayHarness()
    const { result } = renderHook(() => useSubmitPrompt(harness.deps as never))

    await act(async () => {
      expect(await result.current('typed while B was loaded', { composerScope: 'stored-b' })).toBe(false)
    })

    expect(harness.submits()).toHaveLength(0)
    expect(harness.userBubbles()).toHaveLength(0)
  })
})
