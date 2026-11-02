import { expect, expectTypeOf, it } from 'vitest'

import { registerSaveDialogIpc } from './save-text-file'

it('scopes save-dialog dependencies to the requesting IPC event', async () => {
  expectTypeOf<Parameters<typeof registerSaveDialogIpc>[1]>().toBeFunction()

  const handlers = new Map<string, (event: { sender: string }, ...args: any[]) => unknown>()
  const parents: string[] = []
  registerSaveDialogIpc(
    { handle: (channel, listener) => void handlers.set(channel, listener) },
    (event: { sender: string }) => ({
      defaultDir: () => '/unused',
      showSaveDialog: async () => {
        parents.push(event.sender)

        return { canceled: true }
      }
    })
  )

  expect(await handlers.get('hermes:selectSavePath')!({ sender: 'remote' }, {})).toBeNull()
  expect(await handlers.get('hermes:saveTextFileAs')!({ sender: 'local' }, { content: 'text' })).toEqual({
    canceled: true,
    saved: false
  })
  expect(parents).toEqual(['remote', 'local'])
})
