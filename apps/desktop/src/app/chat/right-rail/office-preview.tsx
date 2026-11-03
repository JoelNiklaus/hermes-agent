import type { OfficePreviewKind } from '@hermes/shared'
import { useEffect, useState } from 'react'

import { docxPreviewDocument } from '@/lib/office-document'
import { odtPreviewDocument } from '@/lib/office-odf'
import { type ChartPreview, parsePptx, type SlidePreview } from '@/lib/office-pptx'
import { officeSourceName } from '@/lib/office-source'
import { dataUrlBytes, parseSpreadsheet, type SheetPreview } from '@/lib/office-workbook'

function ChartFigure({ chart }: { chart: ChartPreview }) {
  const values = chart.series.flatMap(series => series.values).filter((value): value is number => value !== null)
  const scale = Math.max(...values.map(Math.abs), 0) || 1

  return (
    <figure aria-label={chart.title || `${chart.kind} chart`} className="mt-4 text-[13px] leading-5">
      {chart.title && <figcaption className="mb-2 font-medium text-[#555]">{chart.title}</figcaption>}
      {chart.series.map((series, seriesIndex) => (
        <div className="mb-3" key={seriesIndex}>
          {chart.series.length > 1 && series.name && <div className="mb-1 text-[#666]">{series.name}</div>}
          <div className="grid grid-cols-[minmax(0,12rem)_minmax(0,1fr)_auto] items-center gap-x-3 gap-y-1">
            {series.values.map((value, pointIndex) => (
              <div className="contents" key={pointIndex}>
                <span className="text-[#444]">{chart.categories[pointIndex] ?? ''}</span>
                <span
                  className="h-3 rounded-sm bg-[#94a3b8]"
                  style={{ width: `${(Math.abs(value ?? 0) / scale) * 100}%` }}
                />
                <span className="text-right tabular-nums text-[#222]">{value ?? ''}</span>
              </div>
            ))}
          </div>
        </div>
      ))}
    </figure>
  )
}

function SlideCard({ number, slide }: { number: number; slide: SlidePreview }) {
  return (
    <div className="mx-auto mb-6 max-w-3xl">
      <article className="bg-white px-8 py-7 shadow-[0_1px_3px_rgba(0,0,0,0.22)]">
        <div className="mb-3 text-[11px] font-medium tracking-wide text-[#888]">SLIDE {number}</div>
        {slide.paragraphs.map((paragraph, paragraphIndex) => (
          <p
            className={paragraphIndex === 0 ? 'mb-3 text-2xl font-semibold' : 'mb-2 text-[15px] leading-6'}
            key={paragraphIndex}
          >
            {paragraph}
          </p>
        ))}
        {slide.images.map((src, imageIndex) => (
          // Data URLs of one image type share their first bytes, so a prefix is no key.
          <img alt="" className="mt-3 max-h-80 max-w-full" key={imageIndex} src={src} />
        ))}
        {slide.charts.map((chart, chartIndex) => (
          <ChartFigure chart={chart} key={chartIndex} />
        ))}
      </article>
      {slide.notes && (
        <section aria-label="Speaker notes" className="border-t border-[#d4d4d4] bg-[#f7f7f7] px-8 py-4">
          <div className="mb-1 text-[11px] font-medium tracking-wide text-[#888]">NOTES</div>
          <p className="text-[14px] leading-6 whitespace-pre-wrap text-[#333]">{slide.notes}</p>
        </section>
      )}
    </div>
  )
}

function columnLabel(index: number): string {
  let n = index + 1
  let label = ''

  while (n > 0) {
    const rem = (n - 1) % 26
    label = String.fromCharCode(65 + rem) + label
    n = Math.floor((n - 1) / 26)
  }

  return label
}

function isNumeric(value: string): boolean {
  return (
    /^-?\d{1,3}(?:,\d{3})*(?:\.\d+)?%?$/.test(value) ||
    /^-?\d+(?:\.\d+)?%?$/.test(value) ||
    /^\d{4}-\d{2}-\d{2}/.test(value)
  )
}

export function OfficePreview({
  dataUrl,
  kind,
  label,
  path
}: {
  dataUrl: string
  kind: OfficePreviewKind
  label: string
  path?: string
}) {
  const [html, setHtml] = useState<string>()
  const [sheets, setSheets] = useState<SheetPreview[]>()
  const [slides, setSlides] = useState<SlidePreview[]>()
  const [sheetIndex, setSheetIndex] = useState(0)
  const [error, setError] = useState<string>()

  useEffect(() => {
    let active = true
    setHtml(undefined)
    setSheets(undefined)
    setSlides(undefined)
    setSheetIndex(0)
    setError(undefined)

    async function load() {
      try {
        const bytes = dataUrlBytes(dataUrl)
        const sourceName = officeSourceName(path, label)

        if (kind === 'document') {
          const document = /\.odt$/i.test(sourceName) ? odtPreviewDocument(bytes) : await docxPreviewDocument(bytes)

          if (active) {
            setHtml(document)
          }

          return
        }

        if (kind === 'presentation') {
          const parsed = parsePptx(bytes)

          if (active) {
            setSlides(parsed)
          }

          return
        }

        const parsed = parseSpreadsheet(bytes, sourceName)

        if (active) {
          setSheets(parsed)
        }
      } catch (caught) {
        if (active) {
          setError(caught instanceof Error ? caught.message : String(caught))
        }
      }
    }

    void load()

    return () => {
      active = false
    }
  }, [dataUrl, kind, label, path])

  if (error) {
    return (
      <div className="flex h-full items-center justify-center p-6 text-center text-sm text-muted-foreground">
        {error}
      </div>
    )
  }

  if (kind === 'document' && html) {
    return <iframe className="h-full w-full border-0 bg-[#e7e6e6]" sandbox="" srcDoc={html} title={label} />
  }

  if (slides) {
    return (
      <div className="h-full overflow-auto bg-[#e7e6e6] px-4 py-6 text-[#222]">
        {slides.map((slide, index) => (
          <SlideCard key={index} number={index + 1} slide={slide} />
        ))}
      </div>
    )
  }

  if (sheets) {
    const sheet = sheets[Math.min(sheetIndex, sheets.length - 1)]
    const colCount = Math.max(sheet.widths?.length ?? 0, ...sheet.rows.map(row => row.length), 1)

    return (
      <div className="flex h-full min-h-0 flex-col bg-[#f3f3f3] text-[#222] [font-family:Calibri,'Segoe_UI',sans-serif]">
        <div className="min-h-0 flex-1 overflow-auto">
          <table className="border-separate border-spacing-0 text-[12px] leading-4">
            <thead className="sticky top-0 z-10">
              <tr>
                <th className="sticky left-0 z-20 h-5 w-10 border border-[#d4d4d4] bg-[#f8f9fb]" />
                {Array.from({ length: colCount }, (_, index) => (
                  <th
                    className="h-5 border border-[#d4d4d4] bg-[#f8f9fb] px-1 text-center font-normal text-[#666]"
                    key={columnLabel(index)}
                    style={{ minWidth: sheet.widths?.[index] ?? 88 }}
                  >
                    {columnLabel(index)}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {(sheet.rows.length ? sheet.rows : [[]]).map((row, rowIndex) => (
                <tr key={rowIndex}>
                  <th className="sticky left-0 z-10 w-10 border border-[#d4d4d4] bg-[#f8f9fb] px-1 text-center font-normal text-[#666]">
                    {rowIndex + 1}
                  </th>
                  {Array.from({ length: colCount }, (_, colIndex) => {
                    const value = row[colIndex] ?? ''

                    return (
                      <td
                        className={`h-5 border border-[#e2e2e2] bg-white px-1.5 align-middle whitespace-pre ${isNumeric(value) ? 'text-right' : 'text-left'}`}
                        key={colIndex}
                        style={{ minWidth: sheet.widths?.[colIndex] ?? 88 }}
                      >
                        {value}
                      </td>
                    )
                  })}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <div className="flex shrink-0 gap-0.5 overflow-x-auto border-t border-[#d4d4d4] bg-[#f3f3f3] px-1 py-0.5">
          {sheets.map((item, index) => (
            <button
              className={`shrink-0 border px-3 py-1 text-[11px] ${index === sheetIndex ? 'border-[#d4d4d4] border-b-white bg-white font-medium' : 'border-transparent text-[#666]'}`}
              key={`${item.name}-${index}`}
              onClick={() => setSheetIndex(index)}
              type="button"
            >
              {item.name}
            </button>
          ))}
        </div>
      </div>
    )
  }

  return null
}
