import { describe, expect, it } from 'vitest'

import { parsePptx } from './office-pptx'
import { barChartXml, deck, points } from './office-pptx.fixture'

describe('powerpoint preview: speaker notes', () => {
  it("reads each slide's speaker notes without the slide number field", () => {
    const [slide] = parsePptx(deck([{ text: ['The gap'], notes: ['[25s] The open recipes were each tested alone.'] }]))

    expect(slide.notes).toBe('[25s] The open recipes were each tested alone.')
  })

  it('keeps the paragraph breaks and blank lines of multi-paragraph notes', () => {
    const [slide] = parsePptx(
      deck([{ text: ['Thanks'], notes: ['[20s] The links are here.', '', 'For questions, not to read aloud.', ''] }])
    )

    expect(slide.notes).toBe('[20s] The links are here.\n\nFor questions, not to read aloud.')
  })

  it('gives a slide without a notes slide empty notes', () => {
    const slides = parsePptx(deck([{ text: ['Title'] }, { text: ['Second'], notes: ['Say this.'] }]))

    expect(slides.map(slide => slide.notes)).toEqual(['', 'Say this.'])
  })
})

describe('powerpoint preview: slide text', () => {
  it('keeps the words around a line break inside a slide paragraph apart', () => {
    const [slide] = parsePptx(deck([{ text: ['First line<br/>second line'] }]))

    expect(slide.paragraphs).toEqual(['First line\nsecond line'])
  })
})

describe('powerpoint preview: long decks', () => {
  it('keeps every slide of a 63-slide deck', () => {
    const slides = parsePptx(
      deck(Array.from({ length: 63 }, (_, index) => ({ text: [`Slide ${index + 1}`], notes: [`Notes ${index + 1}`] })))
    )

    expect(slides).toHaveLength(63)
    expect(slides[62]).toMatchObject({ paragraphs: ['Slide 63'], notes: 'Notes 63' })
  })
})

describe('powerpoint preview: charts', () => {
  it('reads the cached categories and values of a chart on a slide', () => {
    const [slide] = parsePptx(deck([{ text: ['Baselines'], chart: barChartXml(null) }]))

    expect(slide.charts).toEqual([
      {
        kind: 'bar',
        title: '',
        categories: ['DCLM (filtered web)', 'REWIRE'],
        series: [{ name: 'Score', values: [13.77, 13.49] }]
      }
    ])
  })

  it('reads the chart title when the chart shows one', () => {
    const [slide] = parsePptx(deck([{ text: ['Baselines'], chart: barChartXml('Macro score') }]))

    expect(slide.charts[0].title).toBe('Macro score')
  })

  it('gives a slide without charts an empty chart list', () => {
    const [slide] = parsePptx(deck([{ text: ['Title'] }]))

    expect(slide.charts).toEqual([])
  })

  it('reads a point missing from the value cache as null, not zero', () => {
    const chart = barChartXml(null).replace(
      `${points(['13.77', '13.49'])}</c:numCache>`,
      '<c:ptCount val="2"/><c:pt idx="1"><c:v>13.49</c:v></c:pt></c:numCache>'
    )

    const [slide] = parsePptx(deck([{ text: ['Baselines'], chart }]))

    expect(slide.charts[0].series[0].values).toEqual([null, 13.49])
  })
})
