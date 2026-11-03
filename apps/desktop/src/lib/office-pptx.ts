import { unzipSync } from 'fflate'

export interface ChartSeries {
  name: string
  /** `null` where the chart has no value for that category. */
  values: Array<number | null>
}

/** A chart's cached data (the numbers PowerPoint drew), not its styling. */
export interface ChartPreview {
  /** The plot element without its `Chart` suffix: `bar`, `line`, `pie`, `scatter`, ... */
  kind: string
  title: string
  categories: string[]
  series: ChartSeries[]
}

export interface SlidePreview {
  paragraphs: string[]
  images: string[]
  /** Speaker notes; paragraphs are joined with `\n`, so a blank line stays visible. */
  notes: string
  charts: ChartPreview[]
}

const MAX_UNZIPPED_BYTES = 32 * 1024 * 1024

function textOf(bytes: Uint8Array | undefined): string {
  return bytes ? new TextDecoder().decode(bytes) : ''
}

function localName(element: Element): string {
  return element.localName
}

function descendants(root: ParentNode, name: string): Element[] {
  return Array.from(root.querySelectorAll('*')).filter(element => localName(element) === name)
}

function attribute(element: Element, name: string): string | null {
  for (const attr of element.attributes) {
    if (attr.localName === name) {
      return attr.value
    }
  }

  return null
}

function relationshipId(element: Element): string | null {
  for (const attr of element.attributes) {
    if (attr.localName === 'id' && /^rId/i.test(attr.value)) {
      return attr.value
    }
  }

  return null
}

function parseXml(xml: string): Document | null {
  if (!xml.trim()) {
    return null
  }

  const document = new DOMParser().parseFromString(xml, 'application/xml')

  return document.querySelector('parsererror') ? null : document
}

function entry(files: Record<string, Uint8Array>, path: string): Uint8Array | undefined {
  return files[path] ?? files[`/${path}`]
}

function zipPath(base: string, target: string): string {
  if (target.startsWith('/')) {
    return target.replace(/^\/+/, '')
  }

  const parts = base.split('/').slice(0, -1)

  for (const segment of target.split('/')) {
    if (segment === '..') {
      parts.pop()
    } else if (segment && segment !== '.') {
      parts.push(segment)
    }
  }

  return parts.join('/')
}

interface Relationship {
  /** Zip path of the target part. */
  target: string
  /** The relationship type URI, e.g. `.../relationships/notesSlide`. */
  type: string
}

function relationships(files: Record<string, Uint8Array>, path: string): Map<string, Relationship> {
  const document = parseXml(textOf(entry(files, path)))
  const targets = new Map<string, Relationship>()

  if (!document) {
    return targets
  }

  for (const relationship of descendants(document, 'Relationship')) {
    const id = attribute(relationship, 'Id')
    const target = attribute(relationship, 'Target')

    if (id && target) {
      targets.set(id, {
        target: zipPath(path.replace(/_rels\/[^/]+\.rels$/, ''), target),
        type: attribute(relationship, 'Type') ?? ''
      })
    }
  }

  return targets
}

function dataUrl(bytes: Uint8Array, path: string): string | null {
  const ext = path.split('.').pop()?.toLowerCase()

  const mime =
    ext === 'png'
      ? 'image/png'
      : ext === 'jpg' || ext === 'jpeg'
        ? 'image/jpeg'
        : ext === 'gif'
          ? 'image/gif'
          : ext === 'webp'
            ? 'image/webp'
            : null

  if (!mime) {
    return null
  }

  let binary = ''

  for (let index = 0; index < bytes.length; index += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(index, index + 0x8000))
  }

  return `data:${mime};base64,${btoa(binary)}`
}

/** Text runs of one `a:p`; a soft line break (`a:br`) becomes `\n`. */
function paragraphText(paragraph: Element): string {
  return Array.from(paragraph.querySelectorAll('*'))
    .filter(node => localName(node) === 't' || localName(node) === 'br')
    .map(node => (localName(node) === 'br' ? '\n' : (node.textContent ?? '')))
    .join('')
}

function slideText(document: Document): string[] {
  return descendants(document, 'p')
    .map(paragraph => paragraphText(paragraph).trim())
    .filter(Boolean)
}

/** Text of the notes page's body placeholder. The slide image and the slide
 * number field are placeholders of their own and stay out. */
function slideNotes(files: Record<string, Uint8Array>, rels: Map<string, Relationship>): string {
  const notesPath = [...rels.values()].find(relationship => relationship.type.endsWith('/notesSlide'))?.target
  const document = notesPath ? parseXml(textOf(entry(files, notesPath))) : null

  if (!document) {
    return ''
  }

  const body = descendants(document, 'sp').find(shape =>
    descendants(shape, 'ph').some(placeholder => attribute(placeholder, 'type') === 'body')
  )

  return body ? descendants(body, 'p').map(paragraphText).join('\n').trim() : ''
}

function child(element: Element, name: string): Element | undefined {
  return Array.from(element.children).find(node => localName(node) === name)
}

const CACHE_ELEMENTS = new Set(['strCache', 'numCache', 'strLit', 'numLit', 'lvl'])

/** Cached points of a `c:tx`, `c:cat` or `c:val` reference, `undefined` where
 * the cache skips an index. A multi-level category cache lists its innermost
 * level first, which is the visible label. */
function cachedPoints(reference: Element | undefined): Array<string | undefined> {
  const cache = reference
    ? Array.from(reference.querySelectorAll('*')).find(node => CACHE_ELEMENTS.has(localName(node)))
    : undefined

  if (!cache) {
    return []
  }

  const points: Array<string | undefined> = []

  for (const point of Array.from(cache.children).filter(node => localName(node) === 'pt')) {
    const index = Number(attribute(point, 'idx'))

    if (Number.isInteger(index) && index >= 0) {
      points[index] = child(point, 'v')?.textContent ?? undefined
    }
  }

  const count = Number(attribute(child(cache, 'ptCount') ?? cache, 'val'))

  // Array.from turns the holes of a sparse array into undefined entries.
  return Array.from(
    { length: Math.max(points.length, Number.isInteger(count) ? count : 0) },
    (_, index) => points[index]
  )
}

function parseChart(document: Document): ChartPreview | null {
  const plotArea = descendants(document, 'plotArea')[0]
  const plot = plotArea ? Array.from(plotArea.children).find(node => /Chart$/.test(localName(node))) : undefined

  if (!plot) {
    return null
  }

  // Only the chart's own title: axis titles are `c:title` elements too.
  const chartElement = descendants(document, 'chart')[0]
  const title = chartElement ? child(chartElement, 'title') : undefined
  const series = Array.from(plot.children).filter(node => localName(node) === 'ser')

  return {
    kind: localName(plot).replace(/Chart$/, ''),
    title: title
      ? descendants(title, 't')
          .map(node => node.textContent ?? '')
          .join('')
          .trim()
      : '',
    categories: series[0]
      ? cachedPoints(child(series[0], 'cat') ?? child(series[0], 'xVal')).map(label => label ?? '')
      : [],
    series: series.map(ser => ({
      name: cachedPoints(child(ser, 'tx'))[0] ?? '',
      values: cachedPoints(child(ser, 'val') ?? child(ser, 'yVal')).map(value =>
        value === undefined || value.trim() === '' || !Number.isFinite(Number(value)) ? null : Number(value)
      )
    }))
  }
}

function slideCharts(
  document: Document,
  files: Record<string, Uint8Array>,
  rels: Map<string, Relationship>
): ChartPreview[] {
  const charts: ChartPreview[] = []

  for (const reference of descendants(document, 'chart')) {
    const id = attribute(reference, 'id')
    const path = id ? rels.get(id)?.target : undefined
    const chart = path ? parseXml(textOf(entry(files, path))) : null
    const parsed = chart ? parseChart(chart) : null

    if (parsed) {
      charts.push(parsed)
    }
  }

  return charts
}

function slideImages(document: Document, files: Record<string, Uint8Array>, rels: Map<string, Relationship>): string[] {
  const images: string[] = []

  for (const blip of descendants(document, 'blip')) {
    const id = attribute(blip, 'embed')
    const path = id ? rels.get(id)?.target : undefined
    const bytes = path ? entry(files, path) : undefined
    const url = bytes && path ? dataUrl(bytes, path) : null

    if (url) {
      images.push(url)
    }
  }

  return images
}

export function parsePptx(bytes: Uint8Array): SlidePreview[] {
  let files: Record<string, Uint8Array>

  try {
    files = unzipSync(bytes)
  } catch {
    throw new Error('Could not read this presentation')
  }

  let inflated = 0

  for (const part of Object.values(files)) {
    inflated += part.length

    if (inflated > MAX_UNZIPPED_BYTES) {
      throw new Error('Presentation is too large to preview')
    }
  }

  const presentation = parseXml(textOf(entry(files, 'ppt/presentation.xml')))
  const rels = relationships(files, 'ppt/_rels/presentation.xml.rels')
  const slideIds = presentation ? descendants(presentation, 'sldId') : []

  const paths = slideIds
    .map(slide => {
      const id = relationshipId(slide)

      return id ? rels.get(id)?.target : undefined
    })
    .filter((path): path is string => Boolean(path))

  const fallback = Object.keys(files)
    .filter(path => /ppt\/slides\/slide\d+\.xml$/i.test(path))
    .sort()

  const slides = (paths.length ? paths : fallback).map(path => {
    const document = parseXml(textOf(entry(files, path)))
    const slideRels = relationships(files, path.replace(/([^/]+)$/, '_rels/$1.rels'))
    const notes = slideNotes(files, slideRels)

    if (!document) {
      return { paragraphs: [], images: [], notes, charts: [] }
    }

    return {
      paragraphs: slideText(document),
      images: slideImages(document, files, slideRels),
      notes,
      charts: slideCharts(document, files, slideRels)
    }
  })

  if (!slides.length) {
    throw new Error('Could not read this presentation')
  }

  return slides
}
