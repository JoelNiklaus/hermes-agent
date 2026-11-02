import { app, BrowserWindow, dialog, ipcMain, type IpcMainInvokeEvent } from 'electron'

import type { GatewayFileSaveDeps, GatewayFileSaveResult } from './gateway-file-download'
import { registerSaveDialogIpc, type SaveTextFileDeps } from './save-text-file'

export interface GatewayFileSavePayload {
  sessionId?: string
  connectionId?: unknown
  path?: unknown
  profile?: unknown
  suggestedName?: unknown
}

function saveDialogForEvent(event: IpcMainInvokeEvent): SaveTextFileDeps['showSaveDialog'] {
  // Capture before backend resolution or download awaits. The focused/primary window is not the owner.
  const parent = event.sender.isDestroyed() ? null : BrowserWindow.fromWebContents(event.sender)

  return async options => {
    if (!parent || parent.isDestroyed()) {
      return { canceled: true }
    }

    const result = await dialog.showSaveDialog(parent, options)

    return parent.isDestroyed() ? { canceled: true } : result
  }
}

/** All three saves bind the native dialog to their IPC sender, without changing backend ownership. */
export function registerFileSaveIpc(
  saveGatewayFile: (
    payload: GatewayFileSavePayload | undefined,
    deps: GatewayFileSaveDeps
  ) => Promise<GatewayFileSaveResult>
): void {
  registerSaveDialogIpc(ipcMain, event => ({
    defaultDir: () => app.getPath('documents'),
    showSaveDialog: saveDialogForEvent(event)
  }))

  ipcMain.handle('hermes:saveGatewayFile', (event, payload) =>
    saveGatewayFile(payload, { showSaveDialog: saveDialogForEvent(event) })
  )
}
