import { expect, test } from 'claude-code/testing'

const PANE = {
  component: 'Pane',
  requestId: 'leet',
  props: {
    title: 'LeetCode',
    isFocused: true,
    bodyColumns: 70,
    placement: 'dock',
    scroll: { offset: 0, bodyRows: 40 },
    view: {},
  },
} as const

test('the hub opens on Home and switches tabs', async $ => {
  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount({ plugin: 'leet', surface, ...PANE })
    expect(await ui.find({ type: 'Text', text: /◆ Today/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /Arrays & Hashing/ })).toBeDefined()

    await ui.press({ key: 'tab-problem' })
    expect(await ui.find({ type: 'Text', text: /No problem open yet/ })).toBeDefined()

    await ui.press({ key: 'tab-list' })
    expect(await ui.find({ key: 'row-contains-duplicate' })).toBeDefined()

    // Filters are presses, never a dropdown that could be left open.
    await ui.press({ key: 'f-level-Hard' })
    expect(await ui.find({ key: 'row-contains-duplicate' })).toBeUndefined()
    await ui.press({ key: 'f-level-step' })
    expect(await ui.find({ key: 'row-contains-duplicate' })).toBeDefined()
    await ui.press({ key: 'f-pattern-next' })
    expect(await ui.find({ type: 'Text', text: 'Arrays & Hashing' })).toBeDefined()
    expect(await ui.find({ key: 'row-valid-palindrome' })).toBeUndefined()
    await ui.press({ key: 'f-pattern-prev' })
    expect(await ui.find({ key: 'row-valid-palindrome' })).toBeDefined()

    await ui.press({ key: 'tab-home' })
    await ui.unmount()
  }
})
