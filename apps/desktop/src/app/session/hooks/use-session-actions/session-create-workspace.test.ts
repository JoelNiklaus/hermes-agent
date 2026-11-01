import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { HermesConnection } from '@/global'
import { HermesGateway } from '@/hermes'
import {
  closeSecondaryGateways,
  configureGatewayRegistry,
  setPrimaryGateway,
  setPrimaryGatewayConnection
} from '@/store/gateway'
import { $activeGatewayProfile, type AgentProfileRoute } from '@/store/profile'
import { applyConfiguredDefaultProjectDir, setConnection, setCurrentCwdExplicit } from '@/store/session'
import { FakeWebSocket } from '@/test/fake-gateway-socket'

import { desktopSessionCreateParams } from './session-create-request'

const routes: Array<AgentProfileRoute | null> = [null, { connectionId: 'local', profile: 'work' }]

const sharedLocal: HermesConnection = {
  baseUrl: 'http://primary.invalid',
  connectionId: 'local',
  isFullscreen: false,
  logs: [],
  mode: 'local',
  nativeOverlayWidth: 0,
  profile: 'work',
  sharedPrimary: true,
  token: 'fake-test-token',
  windowButtonPosition: null,
  wsUrl: 'ws://primary.invalid/ws'
}

let primary: HermesGateway
let originalDesktop: typeof window.hermesDesktop

beforeEach(async () => {
  originalDesktop = window.hermesDesktop
  vi.stubGlobal('WebSocket', FakeWebSocket)
  FakeWebSocket.mode = 'open'
  FakeWebSocket.instances.length = 0
  configureGatewayRegistry({ onEvent: vi.fn() })
  primary = new HermesGateway()
  await primary.connect('ws://primary.invalid/ws')
  setPrimaryGateway(primary, 'default')
  setPrimaryGatewayConnection({ connectionId: 'local', mode: 'local' })
  setConnection({ ...sharedLocal, profile: 'default' })
  $activeGatewayProfile.set('default')
  applyConfiguredDefaultProjectDir('/Users/example/Projects')
  setCurrentCwdExplicit(false)
  window.hermesDesktop = {
    getConnection: vi.fn(async () => sharedLocal),
    getConnectionFor: vi.fn(async () => sharedLocal)
  } as never
})

afterEach(() => {
  closeSecondaryGateways()
  setPrimaryGateway(null)
  setPrimaryGatewayConnection(null)
  primary.close()
  window.hermesDesktop = originalDesktop
  applyConfiguredDefaultProjectDir(null)
  setConnection(null)
  $activeGatewayProfile.set('default')
  vi.unstubAllGlobals()
})

describe('session creation through real owner activation', () => {
  it.each(routes)('keeps the local default for a shared-primary profile through route %j', async route => {
    const params = await desktopSessionCreateParams(undefined, route, 'work', route === null)

    expect(params).toMatchObject({ cwd: '/Users/example/Projects', cwd_explicit: false, profile: 'work' })
    expect(FakeWebSocket.instances).toHaveLength(1)
  })

  it.each([
    { connectionId: 'another-source', profile: 'work' },
    { connectionId: 'local', profile: 'another-profile' }
  ])('rejects a shared descriptor for a different owner: %j', async owner => {
    window.hermesDesktop = {
      getConnectionFor: vi.fn(async () => ({ ...sharedLocal, ...owner }))
    } as never

    const params = await desktopSessionCreateParams(undefined, { connectionId: 'local', profile: 'work' })

    expect(params).not.toHaveProperty('cwd')
    expect(params).not.toHaveProperty('cwd_explicit')
  })

  it('matches a shared descriptor against the target profile behind a routing alias', async () => {
    window.hermesDesktop = {
      getConnectionFor: vi.fn(async () => ({ ...sharedLocal, profile: 'backend-work' }))
    } as never

    const params = await desktopSessionCreateParams(undefined, {
      connectionId: 'local',
      profile: 'work',
      targetProfile: 'backend-work'
    })

    expect(params).toMatchObject({ cwd: '/Users/example/Projects', cwd_explicit: false, profile: 'backend-work' })
  })

  it.each(routes)('omits the Mac default for a remote profile override through route %j', async route => {
    const remote: HermesConnection = {
      ...sharedLocal,
      authMode: 'token',
      baseUrl: 'https://remote.invalid',
      mode: 'remote',
      sharedPrimary: false,
      wsUrl: 'wss://remote.invalid/ws'
    }

    window.hermesDesktop = {
      getConnection: vi.fn(async () => remote),
      getConnectionFor: vi.fn(async () => remote)
    } as never

    const params = await desktopSessionCreateParams(undefined, route, 'work', route === null)

    expect(params.profile).toBe('work')
    expect(params).not.toHaveProperty('cwd')
    expect(params).not.toHaveProperty('cwd_explicit')
    expect(FakeWebSocket.instances).toHaveLength(2)
  })
})
