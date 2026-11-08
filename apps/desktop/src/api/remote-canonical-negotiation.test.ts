// @vitest-environment node
import type { IncomingMessage } from 'node:http'

import { expect, test, vi } from 'vitest'

import { type FixtureFrame, type FixtureSocket, listen, publicUrl, readyFrame, reply, shut, transportOpened } from '../test/ws-gateway-fixture'

import { HermesGateway } from './client'

const snapshot = {
  session_id: 'chat', stored_session_id: 'chat', messages: [], prompts: [], pending: [],
  revision: 1, execution_generation: 1, authority_epoch: 1, replay_epoch: 'fixture',
  last_sequence: 0, running: false, info: { profile_name: 'engineer' }
}

test('a public authenticated canonical gateway retains the attached profile and prepares submissions', async () => {
  const server = await listen()
  const frames: FixtureFrame[] = []
  let protocol: unknown
  server.on('connection', (socket: FixtureSocket, request: IncomingMessage) => {
    protocol = request.headers['sec-websocket-protocol']
    socket.on('message', bytes => {
      const frame = JSON.parse(bytes.toString())
      frames.push(frame)

      if (frame.method === 'prompt.submit' && (frame.params.profile !== 'engineer' || typeof frame.params.submission_id !== 'string')) {
        socket.send(JSON.stringify({ jsonrpc: '2.0', id: frame.id, error: { code: 4001, message: 'permission_denied' } }))

        return
      }

      reply(socket, frame, frame.method === 'session.resume' ? snapshot : frame.method === 'prompt.submit'
        ? { admission_id: 'admission', ref: { session_id: 'chat' }, sequence: 1, status: 'queued', outcome: null, authority_epoch: 1, execution_generation: 1 }
        : {})
    })
    socket.send(readyFrame())
  })
  const client = new HermesGateway()

  try {
    await client.connect(publicUrl(server))
    await client.request('session.resume', { session_id: 'chat', profile: 'engineer' })
    await expect(client.request('prompt.submit', { session_id: 'chat', text: 'fixture input' })).resolves.toMatchObject({ status: 'queued' })
    expect(frames.find(frame => frame.method === 'prompt.submit')?.params).toMatchObject({
      session_id: 'chat', profile: 'engineer', submission_id: expect.any(String)
    })
    expect(protocol).toBeUndefined()
  } finally {
    await shut(client, server)
  }
})

test.each([{}, { session_authority: false }, { session_authority: 'true' }])('a reconnect resets protocol selection for a non-canonical advertisement %j', async advertisement => {
  const server = await listen()
  const creates: Record<string, unknown>[] = []
  let connection = 0
  server.on('connection', (socket: FixtureSocket) => {
    const canonical = ++connection === 1
    socket.on('message', bytes => {
      const frame = JSON.parse(bytes.toString())

      if (frame.method === 'session.create') {creates.push(frame.params)}
      reply(socket, frame)
    })
    socket.send(readyFrame(canonical ? { session_authority: true } : advertisement))
  })
  const client = new HermesGateway()
  const url = publicUrl(server)

  try {
    await client.connect(url)
    await client.request('session.create', { source: 'desktop', cols: 80, request_id: 'first' })
    expect(creates[0]).toHaveProperty('request_id', 'first')
    client.close()
    await client.connect(url)
    expect(client.sessionWire).toBe('legacy')
    await client.request('session.create', { source: 'desktop', cols: 80, request_id: 'second' })
    expect(creates[1]).not.toHaveProperty('request_id')
  } finally {
    await shut(client, server)
  }
})

// Whoever closes it, an opened socket that never became ready fails its dial with one text, which
// names the closed connection the way the transport does.
test.each(['viewer', 'peer'] as const)('%s disconnect rejects an unfinished public protocol handshake', async closer => {
  const server = await listen()
  let peer: FixtureSocket | undefined
  server.on('connection', (socket: FixtureSocket) => { peer = socket })
  const client = new HermesGateway()
  const opened = transportOpened(client)
  const rejected = expect(client.connect(publicUrl(server))).rejects.toThrow('Hermes gateway connection closed before protocol readiness')

  try {
    await opened

    if (closer === 'viewer') { client.close() } else { peer?.terminate() }
    await rejected
  } finally {
    await shut(client, server)
  }
})

test('a public readiness timeout closes the failed transport and permits redial', async () => {
  const server = await listen()
  let connections = 0
  server.on('connection', (socket: FixtureSocket) => {
    if (++connections > 1) {
      socket.send(JSON.stringify({ jsonrpc: '2.0', method: 'event', params: {
        type: 'gateway.ready', payload: { session_authority: true }
      } }))
    }

    socket.on('message', bytes => {
      const frame = JSON.parse(bytes.toString())
      socket.send(JSON.stringify({ jsonrpc: '2.0', id: frame.id, result: {} }))
    })
  })
  const client = new HermesGateway()
  const url = publicUrl(server)
  const opened = transportOpened(client)
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })

  try {
    const rejected = expect(client.connect(url)).rejects.toThrow('protocol readiness timed out')
    await opened
    await vi.advanceTimersByTimeAsync(30_001)
    await rejected
    expect(client.connectionState).toBe('closed')
    vi.useRealTimers()
    await client.connect(url)
    await expect(client.request('ping')).resolves.toEqual({})
    expect(connections).toBe(2)
  } finally {
    vi.useRealTimers()
    await shut(client, server)
  }
})

test('requests made at transport open wait for public protocol readiness', async () => {
  const server = await listen()
  const frames: Array<{ method: string; params: Record<string, unknown> }> = []

  let announceReady = () => {}
  server.on('connection', (socket: FixtureSocket) => {
    announceReady = () => socket.send(JSON.stringify({ jsonrpc: '2.0', method: 'event', params: {
      type: 'gateway.ready', payload: { session_authority: true }
    } }))
    socket.on('message', bytes => {
      const frame = JSON.parse(bytes.toString())
      frames.push(frame)
      const result = frame.method === 'session.resume' ? snapshot : {}
      socket.send(JSON.stringify({ jsonrpc: '2.0', id: frame.id, result }))
    })
  })
  const client = new HermesGateway()
  const opened = transportOpened(client)
  const connected = client.connect(publicUrl(server))
  void connected.catch(() => {})

  try {
    await opened
    const resumed = client.request('session.resume', { session_id: 'chat', profile: 'engineer' })
    void resumed.catch(() => {})
    await new Promise(resolve => setTimeout(resolve, 25))
    expect(frames.filter(frame => frame.method === 'session.resume')).toHaveLength(0)
    announceReady()
    await connected
    await resumed
    expect(frames.find(frame => frame.method === 'session.resume')?.params).toMatchObject({
      session_id: 'chat', profile: 'engineer'
    })
  } finally {
    await shut(client, server)
  }
})

test.each([true, false])('a closed listener can immediately reconnect without rejecting the replacement handshake (ready=%s)', async advertised => {
  const server = await listen()
  const peers: FixtureSocket[] = []
  server.on('connection', (socket: FixtureSocket) => {
    peers.push(socket)
    socket.on('message', bytes => {
      const frame = JSON.parse(bytes.toString())
      socket.send(JSON.stringify({ jsonrpc: '2.0', id: frame.id, result: { pong: true } }))
    })

    if (advertised || peers.length > 1) {
      socket.send(JSON.stringify({ jsonrpc: '2.0', method: 'event', params: {
        type: 'gateway.ready', payload: { session_authority: true }
      } }))
    }
  })
  const client = new HermesGateway()
  const url = publicUrl(server)
  let redial: Promise<void> | undefined

  let stop = () => {}

  try {
    const opened = transportOpened(client)
    stop = client.onState(state => {
      if (state !== 'closed') { return }
      stop()
      redial = client.connect(url)
      void redial.catch(() => {})
    })
    const initial = client.connect(url)
    const initialOutcome = initial.then(() => 'ready', () => 'closed')
    await opened

    if (advertised) { await initial }
    peers[0].terminate()
    await vi.waitFor(() => expect(redial).toBeDefined())
    await expect(redial).resolves.toBeUndefined()
    await expect(initialOutcome).resolves.toBe(advertised ? 'ready' : 'closed')
    await expect(client.request('ping')).resolves.toEqual({ pong: true })
    expect(peers).toHaveLength(2)
  } finally {
    stop()
    await shut(client, server)
  }
})
