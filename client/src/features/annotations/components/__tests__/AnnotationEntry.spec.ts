import { mount } from '@vue/test-utils'
import { describe, expect, it, vi } from 'vitest'
import type { AnnotationItem } from '@bookorbit/types'
import AnnotationEntry from '../shared/AnnotationEntry.vue'
import AnnotationEntryDetail from '../shared/AnnotationEntryDetail.vue'
import { copyToClipboard } from '@/lib/clipboard'

vi.mock('@/lib/clipboard', () => ({ copyToClipboard: vi.fn<() => Promise<boolean>>().mockResolvedValue(true) }))

const annotation: AnnotationItem = {
  id: 1,
  bookId: 5,
  cfi: null,
  jumpFileId: null,
  pageno: null,
  text: '<b>selected</b>',
  color: '#FACC15',
  style: 'highlight',
  note: null,
  chapterTitle: null,
  origin: 'web',
  positionStatus: null,
  chapterIndex: null,
  highlightedAt: '2026-01-01T00:00:00Z',
  createdAt: '2026-01-01T00:00:00Z',
}

function mountEntry(overrides: Partial<AnnotationItem> = {}, compact = false, stacked = false, showBook = false) {
  return mount(AnnotationEntry, {
    props: {
      annotation: { ...annotation, ...overrides },
      stacked,
      compact,
      selected: false,
      selecting: false,
      active: false,
      trashed: false,
      showDay: true,
      showBook,
      showChapter: true,
    },
    global: { stubs: { RouterLink: { template: '<a><slot /></a>' }, AnnotationBookThumb: true } },
  })
}

describe('AnnotationEntry context', () => {
  it('copies only the original selected text when context is present', async () => {
    const wrapper = mount(AnnotationEntryDetail, {
      props: { annotation: { ...annotation, context: { before: 'before ', after: ' after' } }, canJump: false, trashed: false },
      global: { stubs: { AnnotationSyncDetailPanel: true } },
    })
    const copy = wrapper.findAll('button').find((button) => button.text().includes('Copy text'))!
    await copy.trigger('click')
    expect(copyToClipboard).toHaveBeenCalledWith(annotation.text)
  })

  it.each([
    [false, false, false],
    [true, false, true],
    [false, true, true],
    [true, true, false],
  ])('shows the full context in compact=%s stacked=%s showBook=%s', (compact, stacked, showBook) => {
    const before = 'before '.repeat(50)
    const after = ' after'.repeat(50)
    const wrapper = mountEntry({ context: { before, after } }, compact, stacked, showBook)
    const strong = wrapper.get('strong')
    const quote = strong.element.parentElement!
    expect(quote.textContent?.trim()).toBe(`${before}<b>selected</b>${after}`.trim())
    expect(strong.classes()).toContain('font-bold')
    expect(quote.classList.contains('font-normal')).toBe(true)
    expect(quote.querySelector('b')).toBeNull()
    expect(quote.querySelectorAll('strong')).toHaveLength(1)
    expect(quote.className).not.toContain('line-clamp')
  })

  it.each([undefined, null])('keeps the original quote bold without context %s', (context) => {
    const wrapper = mountEntry({ context })
    expect(wrapper.get('strong').text()).toBe(annotation.text)
  })

  it('preserves context line breaks around the bold quote', () => {
    const wrapper = mountEntry({ context: { before: '上一句。\n', after: '\n下一句。' } })
    const quote = wrapper.get('strong').element.parentElement!
    expect(quote.textContent).toBe('上一句。\n<b>selected</b>\n下一句。')
    expect(quote.classList.contains('whitespace-pre-wrap')).toBe(true)
  })

  it('folds only highlights above 75 words without removing their text', async () => {
    const text = 'word '.repeat(76)
    const wrapper = mountEntry({ text })
    const quote = wrapper.get('strong').element.parentElement!
    expect(quote.textContent).toBe(text)
    expect(quote.classList.contains('line-clamp-5')).toBe(true)
    const toggle = wrapper.get('button[aria-expanded]')
    await toggle.trigger('click')
    expect(toggle.attributes('aria-expanded')).toBe('true')
    expect(quote.classList.contains('line-clamp-5')).toBe(false)
    expect(wrapper.emitted('open')).toBeUndefined()
    await toggle.trigger('click')
    expect(quote.classList.contains('line-clamp-5')).toBe(true)
    await wrapper.setProps({ annotation: { ...annotation, text: 'word '.repeat(75) } })
    expect(wrapper.find('button[aria-expanded]').exists()).toBe(false)
    expect(quote.classList.contains('line-clamp-5')).toBe(false)
  })

  it.each(['underline', 'strikethrough'])('applies %s only to the selected text', (style) => {
    const wrapper = mountEntry({ style, context: { before: 'before ', after: ' after' } })
    const className = style === 'underline' ? 'underline' : 'line-through'
    expect(wrapper.get('strong').classes()).toContain(className)
    expect(wrapper.get('strong').element.parentElement?.classList.contains(className)).toBe(false)
    expect(wrapper.get('strong').element.parentElement?.querySelector('span')?.classList.contains(className)).toBe(false)
  })
})
