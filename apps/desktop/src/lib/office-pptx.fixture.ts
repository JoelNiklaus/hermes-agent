import { strToU8, zipSync } from 'fflate'

// Test-only builders for minimal .pptx packages in the shapes PowerPoint and
// python-pptx write.

const NS = {
  a: 'http://schemas.openxmlformats.org/drawingml/2006/main',
  c: 'http://schemas.openxmlformats.org/drawingml/2006/chart',
  p: 'http://schemas.openxmlformats.org/presentationml/2006/main',
  r: 'http://schemas.openxmlformats.org/officeDocument/2006/relationships'
}

const REL = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships'

export interface TestSlide {
  text: string[]
  // Paragraphs of the notes body placeholder; '' is an empty paragraph.
  notes?: string[]
  chart?: string
  /** PNG bytes of pictures on the slide. */
  pngs?: Uint8Array[]
}

function rels(entries: Array<[id: string, type: string, target: string]>): string {
  return `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${entries
    .map(([id, type, target]) => `<Relationship Id="${id}" Type="${REL}/${type}" Target="${target}"/>`)
    .join('')}</Relationships>`
}

function escapeXml(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
}

function paragraphs(lines: string[]): string {
  // `<br/>` in a line becomes a soft line break (`a:br`) between two runs.
  return lines
    .map(line =>
      line
        ? `<a:p>${line
            .split('<br/>')
            .map(run => `<a:r><a:t>${escapeXml(run)}</a:t></a:r>`)
            .join('<a:br/>')}</a:p>`
        : '<a:p/>'
    )
    .join('')
}

// The shape PowerPoint and python-pptx write: a slide image placeholder, the
// notes body, and a slide number field that must not leak into the notes.
function notesXml(lines: string[], slideNumber: number): string {
  return `<?xml version="1.0"?>
<p:notes xmlns:a="${NS.a}" xmlns:p="${NS.p}" xmlns:r="${NS.r}"><p:cSld><p:spTree>
<p:sp><p:nvSpPr><p:cNvPr id="2" name="Slide Image Placeholder 1"/><p:cNvSpPr/><p:nvPr><p:ph type="sldImg"/></p:nvPr></p:nvSpPr><p:spPr/></p:sp>
<p:sp><p:nvSpPr><p:cNvPr id="3" name="Notes Placeholder 2"/><p:cNvSpPr/><p:nvPr><p:ph type="body" idx="1"/></p:nvPr></p:nvSpPr><p:spPr/><p:txBody><a:bodyPr/>${paragraphs(lines)}</p:txBody></p:sp>
<p:sp><p:nvSpPr><p:cNvPr id="4" name="Slide Number Placeholder 3"/><p:cNvSpPr/><p:nvPr><p:ph type="sldNum" idx="10"/></p:nvPr></p:nvSpPr><p:spPr/><p:txBody><a:bodyPr/><a:p><a:fld id="{F7021451}" type="slidenum"><a:t>${slideNumber}</a:t></a:fld></a:p></p:txBody></p:sp>
</p:spTree></p:cSld></p:notes>`
}

function slideXml(slide: TestSlide): string {
  const chart = slide.chart
    ? `<p:graphicFrame><p:nvGraphicFramePr><p:cNvPr id="5" name="Chart"/><p:cNvGraphicFramePr/><p:nvPr/></p:nvGraphicFramePr><a:graphic><a:graphicData uri="${NS.c}"><c:chart xmlns:c="${NS.c}" r:id="rIdChart"/></a:graphicData></a:graphic></p:graphicFrame>`
    : ''

  const pictures = (slide.pngs ?? [])
    .map((_, index) => `<p:pic><p:blipFill><a:blip r:embed="rIdImage${index}"/></p:blipFill></p:pic>`)
    .join('')

  return `<?xml version="1.0"?>
<p:sld xmlns:a="${NS.a}" xmlns:p="${NS.p}" xmlns:r="${NS.r}"><p:cSld><p:spTree>
<p:sp><p:txBody>${paragraphs(slide.text)}</p:txBody></p:sp>${chart}${pictures}
</p:spTree></p:cSld></p:sld>`
}

export function deck(slides: TestSlide[]): Uint8Array {
  const files: Record<string, Uint8Array> = {
    'ppt/presentation.xml': strToU8(
      `<p:presentation xmlns:p="${NS.p}" xmlns:r="${NS.r}"><p:sldIdLst>${slides
        .map((_, index) => `<p:sldId id="${256 + index}" r:id="rId${index + 1}"/>`)
        .join('')}</p:sldIdLst></p:presentation>`
    ),
    'ppt/_rels/presentation.xml.rels': strToU8(
      rels(slides.map((_, index) => [`rId${index + 1}`, 'slide', `slides/slide${index + 1}.xml`]))
    )
  }

  slides.forEach((slide, index) => {
    const number = index + 1

    const slideRels: Array<[string, string, string]> = [
      ['rIdLayout', 'slideLayout', '../slideLayouts/slideLayout1.xml']
    ]

    files[`ppt/slides/slide${number}.xml`] = strToU8(slideXml(slide))

    if (slide.notes) {
      slideRels.push(['rIdNotes', 'notesSlide', `../notesSlides/notesSlide${number}.xml`])
      files[`ppt/notesSlides/notesSlide${number}.xml`] = strToU8(notesXml(slide.notes, number))
    }

    if (slide.chart) {
      // An absolute target, as PowerPoint writes chart relationships.
      slideRels.push(['rIdChart', 'chart', `/ppt/charts/chart${number}.xml`])
      files[`ppt/charts/chart${number}.xml`] = strToU8(slide.chart)
    }

    slide.pngs?.forEach((png, imageIndex) => {
      slideRels.push([`rIdImage${imageIndex}`, 'image', `../media/image${number}-${imageIndex}.png`])
      files[`ppt/media/image${number}-${imageIndex}.png`] = png
    })

    files[`ppt/slides/_rels/slide${number}.xml.rels`] = strToU8(rels(slideRels))
  })

  return zipSync(files)
}

export function points(values: string[]): string {
  return `<c:ptCount val="${values.length}"/>${values.map((value, index) => `<c:pt idx="${index}"><c:v>${value}</c:v></c:pt>`).join('')}`
}

// A bar chart as PowerPoint writes it: a cached series name, multi-level
// category labels and a number cache, behind formulas into the embedded sheet.
export function barChartXml(title: string | null): string {
  const titleXml = title
    ? `<c:title><c:tx><c:rich><a:bodyPr/><a:p><a:r><a:t>${title}</a:t></a:r></a:p></c:rich></c:tx></c:title><c:autoTitleDeleted val="0"/>`
    : '<c:autoTitleDeleted val="1"/>'

  return `<?xml version="1.0"?>
<c:chartSpace xmlns:c="${NS.c}" xmlns:a="${NS.a}" xmlns:r="${NS.r}"><c:chart>${titleXml}<c:plotArea><c:layout/>
<c:barChart><c:barDir val="bar"/><c:grouping val="clustered"/>
<c:ser><c:idx val="0"/><c:order val="0"/>
<c:tx><c:strRef><c:f>Sheet1!$B$1</c:f><c:strCache>${points(['Score'])}</c:strCache></c:strRef></c:tx>
<c:cat><c:multiLvlStrRef><c:f>Sheet1!$A$2:$A$3</c:f><c:multiLvlStrCache><c:ptCount val="2"/><c:lvl>${points(['DCLM (filtered web)', 'REWIRE'])}</c:lvl></c:multiLvlStrCache></c:multiLvlStrRef></c:cat>
<c:val><c:numRef><c:f>Sheet1!$B$2:$B$3</c:f><c:numCache><c:formatCode>General</c:formatCode>${points(['13.77', '13.49'])}</c:numCache></c:numRef></c:val>
</c:ser></c:barChart></c:plotArea></c:chart></c:chartSpace>`
}

export function deckDataUrl(slides: TestSlide[]): string {
  return `data:application/vnd.openxmlformats-officedocument.presentationml.presentation;base64,${Buffer.from(deck(slides)).toString('base64')}`
}
