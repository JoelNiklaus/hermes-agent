import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { Readable } from 'node:stream'

import { afterEach, beforeEach, expect, it, vi } from 'vitest'

import { registerFileSaveIpc } from './file-save-ipc'
import { finalizeGatewayDownload, saveGatewayDownload } from './gateway-file-download'

const electron = vi.hoisted(() => ({
  app: { getPath: vi.fn() },
  BrowserWindow: { fromWebContents: vi.fn(), getFocusedWindow: vi.fn() },
  dialog: { showSaveDialog: vi.fn() },
  ipcMain: { handle: vi.fn() }
}))

vi.mock('electron', () => electron)

const handlers = new Map<string, (event: any, ...args: any[]) => unknown>()
let dir: string

function windowFixture(id: number) {
  return {
    id,
    isDestroyed: vi.fn(() => false),
    focus: vi.fn(),
    show: vi.fn(),
    moveTop: vi.fn()
  }
}

function eventFixture() {
  return { sender: { isDestroyed: () => false } }
}

function responseFixture() {
  return Object.assign(Readable.from([Buffer.from([0, 255, 7])]), {
    statusCode: 200,
    headers: { 'content-disposition': 'attachment; filename="report.pdf"' }
  })
}

beforeEach(() => {
  vi.resetAllMocks()
  handlers.clear()
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'file-save-ipc-'))
  electron.app.getPath.mockReturnValue(dir)
  electron.ipcMain.handle.mockImplementation((channel, listener) => handlers.set(channel, listener))
})

afterEach(() => fs.rmSync(dir, { recursive: true, force: true }))

it('keeps the requesting remote window across an asynchronous gateway download', async () => {
  const remote = windowFixture(2)
  const primary = windowFixture(1)
  const event = eventFixture()
  const target = path.join(dir, 'report.pdf')
  const payload = { connectionId: 'remote', profile: 'work', sessionId: 'remote-session', path: '/report.pdf' }
  const response = responseFixture()
  const abort = vi.fn()
  electron.BrowserWindow.fromWebContents.mockReturnValue(remote)
  electron.BrowserWindow.getFocusedWindow.mockReturnValue(primary)
  electron.dialog.showSaveDialog.mockResolvedValue({ canceled: false, filePath: target })
  registerFileSaveIpc(async (request, deps) => {
    expect(request).toBe(payload)
    await Promise.resolve()

    return finalizeGatewayDownload(response, { fallbackName: 'fallback', suggested: '' }, abort, deps)
  })

  const pending = handlers.get('hermes:saveGatewayFile')!(event, payload)
  // The IPC sender can disappear/re-map while the gateway resolves. Its owner was captured already.
  electron.BrowserWindow.fromWebContents.mockReturnValue(primary)
  expect(await pending).toEqual({ saved: true, path: target })
  expect(electron.dialog.showSaveDialog).toHaveBeenCalledExactlyOnceWith(remote, {
    defaultPath: 'report.pdf',
    filters: [
      { name: 'PDF File', extensions: ['pdf'] },
      { name: 'All Files', extensions: ['*'] }
    ],
    title: 'Save File'
  })
  expect(fs.readFileSync(target)).toEqual(Buffer.from([0, 255, 7]))
  expect(abort).not.toHaveBeenCalled()
  expect(primary.focus).not.toHaveBeenCalled()
  expect(remote.focus).not.toHaveBeenCalled()
})

it('cancels a delayed download when its captured window closes before the dialog', async () => {
  const remote = windowFixture(2)
  const response = responseFixture()
  const abort = vi.fn(() => response.destroy())
  electron.BrowserWindow.fromWebContents.mockReturnValue(remote)
  electron.dialog.showSaveDialog.mockResolvedValue({ canceled: false, filePath: path.join(dir, 'closed.pdf') })
  registerFileSaveIpc(async (_request, deps) => {
    await Promise.resolve()

    return finalizeGatewayDownload(response, { fallbackName: 'report.pdf', suggested: '' }, abort, deps)
  })

  const pending = handlers.get('hermes:saveGatewayFile')!(eventFixture(), { path: '/report.pdf' })
  remote.isDestroyed.mockReturnValue(true)

  expect(await pending).toEqual({ canceled: true, saved: false })
  expect(electron.dialog.showSaveDialog).not.toHaveBeenCalled()
  expect(abort).toHaveBeenCalledOnce()
  expect(fs.readdirSync(dir)).toEqual([])
})

it('does not write text after its parent closes while the Save dialog is open', async () => {
  const remote = windowFixture(2)
  electron.BrowserWindow.fromWebContents.mockReturnValue(remote)
  electron.dialog.showSaveDialog.mockImplementation(async () => {
    remote.isDestroyed.mockReturnValue(true)

    return { canceled: false, filePath: path.join(dir, 'closed.md') }
  })
  registerFileSaveIpc(vi.fn())

  expect(await handlers.get('hermes:saveTextFileAs')!(eventFixture(), { content: '# text' })).toEqual({
    canceled: true,
    saved: false
  })
  expect(fs.readdirSync(dir)).toEqual([])
  expect(remote.focus).not.toHaveBeenCalled()
})

it('cancels a save request from destroyed web contents without resolving another window', async () => {
  electron.BrowserWindow.fromWebContents.mockImplementation(() => {
    throw new Error('Object has been destroyed')
  })
  registerFileSaveIpc(vi.fn())

  const event = { sender: { isDestroyed: () => true } }
  expect(await handlers.get('hermes:selectSavePath')!(event, {})).toBeNull()
  expect(electron.dialog.showSaveDialog).not.toHaveBeenCalled()
})

it.each([
  ['hermes:selectSavePath', { defaultPath: 'profile.json' }],
  ['hermes:saveTextFileAs', { content: '# remote transcript', defaultPath: '../../transcript.md' }]
])('parents %s to its requesting window', async (channel, request) => {
  const remote = windowFixture(2)
  const target = path.join(dir, 'chosen.txt')
  electron.BrowserWindow.fromWebContents.mockReturnValue(remote)
  electron.dialog.showSaveDialog.mockResolvedValue({ canceled: false, filePath: target })
  registerFileSaveIpc(vi.fn())

  await handlers.get(channel)!(eventFixture(), request)

  expect(electron.dialog.showSaveDialog).toHaveBeenCalledExactlyOnceWith(
    remote,
    expect.objectContaining({ title: 'Save' })
  )
  expect(remote.focus).not.toHaveBeenCalled()
})

it.each([
  ['hermes:selectSavePath', {}, null],
  ['hermes:saveTextFileAs', { content: 'text' }, { canceled: true, saved: false }],
  ['hermes:saveGatewayFile', { path: '/report.pdf' }, { canceled: true, saved: false }]
])('cancels %s when no sender window exists, without falling back', async (channel, request, result) => {
  electron.BrowserWindow.fromWebContents.mockReturnValue(null)
  electron.BrowserWindow.getFocusedWindow.mockReturnValue(windowFixture(1))
  const response = responseFixture()
  registerFileSaveIpc((_request, deps) =>
    finalizeGatewayDownload(response, { fallbackName: 'report.pdf', suggested: '' }, () => response.destroy(), deps)
  )

  expect(await handlers.get(channel)!(eventFixture(), request)).toEqual(result)
  expect(electron.dialog.showSaveDialog).not.toHaveBeenCalled()
  expect(fs.readdirSync(dir)).toEqual([])
})

it('aborts a canceled download without writing or restoring window focus', async () => {
  const remote = windowFixture(2)
  const primary = windowFixture(1)
  const response = responseFixture()
  const abort = vi.fn(() => response.destroy())
  electron.BrowserWindow.fromWebContents.mockReturnValue(remote)
  electron.BrowserWindow.getFocusedWindow.mockReturnValue(primary)
  electron.dialog.showSaveDialog.mockResolvedValue({ canceled: true })
  registerFileSaveIpc((_request, deps) =>
    finalizeGatewayDownload(response, { fallbackName: 'report.pdf', suggested: '' }, abort, deps)
  )

  expect(await handlers.get('hermes:saveGatewayFile')!(eventFixture(), {})).toEqual({ canceled: true, saved: false })
  expect(abort).toHaveBeenCalledOnce()
  expect(fs.readdirSync(dir)).toEqual([])
  expect(primary.focus).not.toHaveBeenCalled()
  expect(primary.show).not.toHaveBeenCalled()
  expect(remote.focus).not.toHaveBeenCalled()
  expect(remote.show).not.toHaveBeenCalled()
})

it('propagates a dialog failure and aborts the download without writing', async () => {
  const response = responseFixture()
  const abort = vi.fn(() => response.destroy())
  electron.BrowserWindow.fromWebContents.mockReturnValue(windowFixture(2))
  electron.dialog.showSaveDialog.mockRejectedValue(new Error('Save dialog failed'))
  registerFileSaveIpc((_request, deps) =>
    finalizeGatewayDownload(response, { fallbackName: 'report.pdf', suggested: '' }, abort, deps)
  )

  await expect(handlers.get('hermes:saveGatewayFile')!(eventFixture(), {})).rejects.toThrow('Save dialog failed')
  expect(abort).toHaveBeenCalledOnce()
  expect(fs.readdirSync(dir)).toEqual([])
})

it('keeps concurrent streaming and delayed 404-fallback saves on their own windows', async () => {
  const remote = windowFixture(2)
  const primary = windowFixture(1)
  const remoteTarget = path.join(dir, 'remote.patch')
  const localTarget = path.join(dir, 'local.zip')
  let resolveRead!: (value: string) => void

  const readReady = new Promise<string>(resolve => {
    resolveRead = resolve
  })

  electron.BrowserWindow.fromWebContents.mockReturnValueOnce(remote).mockReturnValueOnce(primary)
  electron.dialog.showSaveDialog
    .mockResolvedValueOnce({ canceled: false, filePath: localTarget })
    .mockResolvedValueOnce({ canceled: false, filePath: remoteTarget })
  registerFileSaveIpc((request, deps) =>
    saveGatewayDownload(
      { download: '/download', dataUrl: '/read' },
      { fallbackName: 'remote.patch', suggested: '' },
      {
        ...deps,
        download: async () => {
          if (request?.connectionId === 'remote') {
            throw Object.assign(new Error('Not found'), { statusCode: 404 })
          }

          return finalizeGatewayDownload(responseFixture(), { fallbackName: 'local.zip', suggested: '' }, vi.fn(), deps)
        },
        readDataUrl: () => readReady
      }
    )
  )

  const remoteSave = handlers.get('hermes:saveGatewayFile')!(eventFixture(), {
    connectionId: 'remote',
    path: '/remote.patch'
  })

  const localSave = handlers.get('hermes:saveGatewayFile')!(eventFixture(), {
    connectionId: 'local',
    path: '/local.zip'
  })

  expect(await localSave).toEqual({ path: localTarget, saved: true })
  resolveRead('data:text/plain,patch%20content')
  expect(await remoteSave).toEqual({ path: remoteTarget, saved: true })
  expect(electron.dialog.showSaveDialog.mock.calls.map(([parent]) => parent)).toEqual([primary, remote])
  expect(fs.readFileSync(localTarget)).toEqual(Buffer.from([0, 255, 7]))
  expect(fs.readFileSync(remoteTarget, 'utf8')).toBe('patch content')
})
