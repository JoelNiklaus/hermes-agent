// @vitest-environment node
import { afterEach, beforeEach, expect, test, vi } from 'vitest'

import { HermesGateway } from './client'

class ControlledSocket extends EventTarget {
  static OPEN = 1
  static CLOSED = 3
  static instances: ControlledSocket[] = []
  readyState = 0
  frames: Array<{ id: number; method: string; params: Record<string, unknown> }> = []
  answer = true

  constructor() { super(); ControlledSocket.instances.push(this) }
  open() { this.readyState = ControlledSocket.OPEN; this.dispatchEvent(new Event('open')) }
  close() { this.readyState = ControlledSocket.CLOSED; this.dispatchEvent(new Event('close')) }
  ready(canonical: boolean) {
    this.dispatchEvent(new MessageEvent('message', { data: JSON.stringify({
      jsonrpc: '2.0', method: 'event', params: { type: 'gateway.ready', payload: { session_authority: canonical } }
    }) }))
  }
  send(data: string) {
    const frame = JSON.parse(data)
    this.frames.push(frame)

    if (this.answer) {
      this.dispatchEvent(new MessageEvent('message', { data: JSON.stringify({ jsonrpc: '2.0', id: frame.id, result: {} }) }))
    }
  }
}

beforeEach(() => {
  vi.useFakeTimers()
  ControlledSocket.instances = []
  vi.stubGlobal('WebSocket', ControlledSocket)
})
afterEach(() => { vi.unstubAllGlobals(); vi.useRealTimers() })

test('a canonical clarify redirect spends the readiness wait inside the original request deadline', async () => {
  const client = new HermesGateway()
  const connected = client.connect('ws://fixture/api/ws?token=fixture')
  void connected.catch(() => {})
  const socket = ControlledSocket.instances[0]
  socket.open()
  const delivered = vi.fn()
  client.onRequest(delivered)
  let result = 'pending'

  const request = client.request('clarify.lock', { request_id: 'question', answer: 'staging' }, 20)
    .then(() => { result = 'answered' }, error => { result = error.message })

  try {
    expect(client.connectionState).toBe('connecting')
    expect(client.sessionWire).toBeNull()
    await vi.advanceTimersByTimeAsync(12)
    socket.ready(true)
    // The owner can replay its pending card in the same frame batch as readiness,
    // before the waiting request resumes and resolves clarify.lock to its owner.
    socket.dispatchEvent(new MessageEvent('message', { data: JSON.stringify({
      jsonrpc: '2.0', method: 'event', params: {
        type: 'clarify.request', session_id: 'chat', payload: {
          prompt_id: 'question', execution_generation: 7, question: 'Which target?', choices: ['staging']
        }
      }
    }) }))
    socket.answer = false
    await connected
    await vi.advanceTimersByTimeAsync(0)
    expect(delivered).toHaveBeenCalledOnce()
    expect(socket.frames.at(-1)).toMatchObject({ method: 'session.resume', params: { session_id: 'chat', profile: 'default' } })
    expect(result).toBe('pending')
    await vi.advanceTimersByTimeAsync(9)
    expect(result).toContain('timed out')
    await request
    expect(socket.frames.some(frame => frame.method === 'clarify.respond')).toBe(false)
    expect(client.connectionState).toBe('open')
  } finally { client.close() }
})

test.each([true, false])('request expiry prevents a late write without cancelling readiness (canonical=%s)', async canonical => {
  const client = new HermesGateway()
  const connected = client.connect('ws://fixture/api/ws?token=fixture')
  void connected.catch(() => {})
  const socket = ControlledSocket.instances[0]
  socket.open()
  let result = 'pending'

  const request = client.request('session.create', { source: 'desktop' }, 20)
    .then(() => { result = 'sent' }, error => { result = error.message })

  try {
    await vi.advanceTimersByTimeAsync(21)
    expect(result).toContain('timed out')
    expect(socket.frames).toEqual([])
    socket.ready(canonical)
    await connected
    await request
    await expect(client.request('ping')).resolves.toEqual({})
    expect(socket.frames.map(frame => frame.method)).toEqual(['client.capabilities', 'ping'])
  } finally { client.close() }
})

test.each([true, false])('aborting a request releases its readiness wait without closing the socket (canonical=%s)', async canonical => {
  const client = new HermesGateway()
  const connected = client.connect('ws://fixture/api/ws?token=fixture')
  void connected.catch(() => {})
  const socket = ControlledSocket.instances[0]
  socket.open()
  const controller = new AbortController()
  let result = 'pending'

  const request = client.request('session.create', { source: 'desktop' }, 0, controller.signal)
    .then(() => { result = 'sent' }, error => { result = error.name })

  try {
    controller.abort()
    await vi.advanceTimersByTimeAsync(0)
    expect(result).toBe('AbortError')
    expect(socket.frames).toEqual([])
    socket.ready(canonical)
    await connected
    await request
    await expect(client.request('ping')).resolves.toEqual({})
    expect(socket.frames.map(frame => frame.method)).toEqual(['client.capabilities', 'ping'])
  } finally { client.close() }
})

test.each([true, false])('the wire response uses only the budget left after readiness (canonical=%s)', async canonical => {
  const client = new HermesGateway()
  const connected = client.connect('ws://fixture/api/ws?token=fixture')
  void connected.catch(() => {})
  const socket = ControlledSocket.instances[0]
  socket.open()
  let result = 'pending'

  const request = client.request('session.create', { source: 'desktop' }, 20)
    .then(() => { result = 'answered' }, error => { result = error.message })

  try {
    await vi.advanceTimersByTimeAsync(12)
    socket.answer = false
    socket.ready(canonical)
    await connected
    await vi.advanceTimersByTimeAsync(0)
    expect(socket.frames.filter(frame => frame.method === 'session.create')).toHaveLength(1)
    expect(result).toBe('pending')
    await vi.advanceTimersByTimeAsync(9)
    expect(result).toContain('timed out')
    await request
    expect(client.connectionState).toBe('open')
  } finally { client.close() }
})

test.each([true, false])('a zero deadline still permits a request after delayed readiness (canonical=%s)', async canonical => {
  const client = new HermesGateway()
  const connected = client.connect('ws://fixture/api/ws?token=fixture')
  void connected.catch(() => {})
  const socket = ControlledSocket.instances[0]
  socket.open()
  let result = 'pending'

  const request = client.request('session.create', { source: 'desktop' }, 0)
    .then(() => { result = 'answered' }, error => { result = error.message })

  try {
    await vi.advanceTimersByTimeAsync(100)
    expect(result).toBe('pending')
    expect(socket.frames).toEqual([])
    socket.ready(canonical)
    await connected
    await request
    expect(result).toBe('answered')
    expect(socket.frames.filter(frame => frame.method === 'session.create')).toHaveLength(1)
  } finally { client.close() }
})
