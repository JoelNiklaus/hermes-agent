import { render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'

import { barChartXml, deckDataUrl } from '@/lib/office-pptx.fixture'

import { OfficePreview } from './office-preview'

function renderDeck(slides: Parameters<typeof deckDataUrl>[0]) {
  return render(
    <OfficePreview dataUrl={deckDataUrl(slides)} kind="presentation" label="talk.pptx" path="/tmp/talk.pptx" />
  )
}

describe('OfficePreview: presentations', () => {
  it("shows each slide's speaker notes, keeping their blank lines", async () => {
    renderDeck([
      { text: ['The gap'], notes: ['[25s] Each recipe was tested alone.', '', 'Q&A only: seed variance.'] },
      { text: ['No notes here'] }
    ])

    const notes = await screen.findAllByRole('region', { name: /speaker notes/i })

    expect(notes).toHaveLength(1)
    expect(notes[0].textContent).toContain('[25s] Each recipe was tested alone.\n\nQ&A only: seed variance.')
  })

  it("draws a chart's categories next to their values", async () => {
    renderDeck([{ text: ['Baselines'], chart: barChartXml('Macro score') }])

    const chart = await screen.findByRole('figure', { name: /macro score/i })

    expect(chart.textContent).toContain('DCLM (filtered web)')
    expect(chart.textContent).toContain('13.77')
    expect(chart.textContent).toContain('REWIRE')
    expect(chart.textContent).toContain('13.49')
  })

  it('shows every picture of a slide when two pictures share a file type', async () => {
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {})

    // Two different PNGs that share their first 32 bytes, as real PNG headers
    // (signature plus IHDR chunk) do.
    const png = (tail: number) =>
      new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, ...Array(24).fill(0), tail])

    try {
      const { container } = renderDeck([{ text: ['Thank you'], pngs: [png(1), png(2)] }])

      await screen.findByText('Thank you')

      expect(container.querySelectorAll('img')).toHaveLength(2)
      expect(consoleError.mock.calls.flat().join(' ')).not.toMatch(/same key/i)
    } finally {
      consoleError.mockRestore()
    }
  })
})
