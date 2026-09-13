import { useState } from 'react'
import { describe, expect, it } from 'bun:test'
import { connectTest } from '@gpuix/react/automation'
import { createTestRoot } from '@gpuix/react/testing'
import { ChipSelect, matchSelectOptions, type SelectOption } from '../src/ui/primitives.tsx'
import { applyResolvedTheme, colors, lightColors } from '../src/ui/theme.ts'
import { describeNative } from './helpers/native-renderer.ts'

describe('select option matching', () => {
  it('uses Localterm-style fuzzy matching across model names and provider IDs', () => {
    expect(matchSelectOptions(options, 'm 23').map((option) => option.value)).toEqual(['provider/model-23'])
    expect(matchSelectOptions(options, 'provider 4')[0]?.value).toBe('provider/model-4')
    expect(matchSelectOptions(options, '')).toHaveLength(options.length)
  })
})

const options: SelectOption[] = Array.from({ length: 24 }, (_, index) => ({
  value: `provider/model-${index}`,
  label: `Model ${index}`,
  detail: `provider/model-${index}`,
}))

const largeOptions: SelectOption[] = Array.from({ length: 10_000 }, (_, index) => ({
  value: `provider/large-model-${index}`,
  label: `Large model ${index}`,
  detail: `provider/large-model-${index}`,
}))

function SearchableSelectFixture() {
  const [value, setValue] = useState(options[0]!.value)
  return (
    <div style={{ width: 620, height: 560, display: 'flex', alignItems: 'flex-end', justifyContent: 'center', paddingBottom: 40 }}>
      <ChipSelect searchable testId="searchable-model-picker" value={value} options={options} width={320} onChange={setValue} />
    </div>
  )
}

function LargeSelectFixture() {
  const [value, setValue] = useState(largeOptions[0]!.value)
  return (
    <div style={{ width: 620, height: 560, display: 'flex', alignItems: 'flex-end', justifyContent: 'center', paddingBottom: 40 }}>
      <ChipSelect testId="large-model-picker" value={value} options={largeOptions} width={320} onChange={setValue} />
    </div>
  )
}

function SelectFixture() {
  const [value, setValue] = useState(options.at(-1)!.value)
  return (
    <div style={{ width: 620, height: 560, display: 'flex', alignItems: 'flex-end', justifyContent: 'center', paddingBottom: 40 }}>
      <ChipSelect testId="overflow-model-picker" value={value} options={options} width={300} onChange={setValue} />
    </div>
  )
}

describeNative('bounded select content', () => {
  it('clips long model lists inside a scrollable border', async () => {
    const root = createTestRoot()
    root.render(<SelectFixture />)
    const automation = await connectTest(root.renderer)

    await automation.getByTestId('overflow-model-picker').click()
    await Bun.sleep(20)
    root.renderer.flush()
    const content = root.renderer.findByTestId('overflow-model-picker-content')!
    const surface = root.renderer.findByTestId('overflow-model-picker-surface')!
    const list = root.renderer.findByTestId('overflow-model-picker-list')!
    const motion = surface.customProps?.motion as { initial: { opacity: number; top: number }; animate: { opacity: number; top: number } }
    expect(content.style.backgroundColor).toBe(colors.background)
    expect(surface.style.overflow).toBe('hidden')
    expect(list.style.overflow).toBe('hidden')
    expect((await automation.getByTestId('overflow-model-picker-surface').bounds()).height).toBeLessThanOrEqual(340)
    expect(motion.initial).toEqual({ opacity: 0, top: 4 })
    expect(motion.animate).toEqual({ opacity: 1, top: 0 })
    expect(await automation.getByTestId('overflow-model-picker-option').count()).toBe(24)

    const virtualList = root.renderer.findByTestId('overflow-model-picker-virtual-list')!
    expect(virtualList.type).toBe('virtual-list')
    root.renderer.scrollTo(virtualList.id, 0, -10_000)
    root.renderer.flush()
    expect(root.renderer.getScrollOffset(virtualList.id)?.[1]).toBeLessThan(0)
    expect(root.renderer.getPaintedText()).toContain('Model 23')

    await automation.close()
    root.unmount()
  })

  it('bounds ten-thousand model rows and rematerializes the deep native viewport', async () => {
    const root = createTestRoot()
    root.render(<LargeSelectFixture />)
    const automation = await connectTest(root.renderer)

    await automation.getByTestId('large-model-picker').click()
    await Bun.sleep(20)
    root.renderer.flush()
    const list = root.renderer.findByTestId('large-model-picker-virtual-list')!
    expect(list.type).toBe('virtual-list')
    expect(list.customProps?.itemCount).toBe(largeOptions.length)
    expect(await automation.getByTestId('large-model-picker-option').count()).toBeLessThanOrEqual(160)
    expect(root.renderer.getPaintedText()).toContain('Large model 0')

    root.renderer.scrollToItem(list.id, largeOptions.length - 1)
    root.renderer.flush()
    await Bun.sleep(25)
    root.renderer.flush()
    expect(await automation.getByTestId('large-model-picker-option').count()).toBeLessThanOrEqual(160)
    expect(await automation.getByText('Large model 9999').count()).toBe(1)

    await automation.close()
    root.unmount()
  })

  it('shows every model in the active theme and filters them from a focused search field', async () => {
    applyResolvedTheme('light')
    const root = createTestRoot()
    root.render(<SearchableSelectFixture />)
    const automation = await connectTest(root.renderer)

    await automation.getByTestId('searchable-model-picker').click()
    await Bun.sleep(20)
    root.renderer.flush()
    expect(await automation.getByTestId('searchable-model-picker-search').count()).toBe(1)
    expect(root.renderer.findByTestId('searchable-model-picker-content')?.style.backgroundColor).toBe(lightColors.background)
    expect(root.renderer.findByTestId('searchable-model-picker-surface')?.style.backgroundColor).toBe(lightColors.popover)
    expect(await automation.getByTestId('searchable-model-picker-option').count()).toBe(options.length)
    expect(root.renderer.getPaintedText()).toContain(`${options.length} of ${options.length} models`)

    await automation.getByTestId('searchable-model-picker-search').fill('m 23')
    root.renderer.flush()
    expect(await automation.getByTestId('searchable-model-picker-option').count()).toBe(1)
    expect(root.renderer.getPaintedText()).toContain('Model 23')
    expect(root.renderer.getPaintedText()).toContain(`1 of ${options.length} models`)

    await automation.getByTestId('searchable-model-picker-option').click()
    expect(await automation.getByTestId('searchable-model-picker-content').count()).toBe(1)
    const exitMotion = root.renderer.findByTestId('searchable-model-picker-surface')?.customProps?.motion as { animate: { opacity: number; top: number } }
    expect(exitMotion.animate).toEqual({ opacity: 0, top: 4 })
    expect(root.renderer.findByTestId('searchable-model-picker-content')?.style.pointerEvents).toBe('none')
    await Bun.sleep(180)
    root.renderer.flush()
    expect(await automation.getByTestId('searchable-model-picker-content').count()).toBe(0)
    await automation.close()
    root.unmount()
    applyResolvedTheme('dark')
  })

  it('keeps floating option clicks from reaching controls behind the menu', async () => {
    let behindClicks = 0
    let selected = ''
    const root = createTestRoot()
    function OverlapFixture() {
      const [open, setOpen] = useState(false)
      return (
        <div style={{ position: 'relative', width: 620, height: 560 }}>
          <div testId="picker-underlay" style={{ position: 'absolute', top: 0, right: 0, bottom: 0, left: 0, backgroundColor: '#111111', pointerEvents: open ? 'none' : 'auto' }} onClick={() => { behindClicks += 1 }} />
          <div style={{ position: 'absolute', left: 160, bottom: 40 }}>
            <ChipSelect testId="shielded-picker" value={options.at(-1)!.value} options={options} width={300} onOpenChange={setOpen} onChange={(value) => { selected = value }} />
          </div>
        </div>
      )
    }
    root.render(<OverlapFixture />)
    const automation = await connectTest(root.renderer)

    await automation.getByTestId('shielded-picker').click()
    await Bun.sleep(20)
    root.renderer.flush()
    await automation.getByText('Model 0').click()

    expect(selected).toBe(options[0]!.value)
    expect(behindClicks).toBe(0)
    expect(await automation.getByTestId('shielded-picker-content').count()).toBe(1)
    expect(root.renderer.findByTestId('shielded-picker-content')?.style.pointerEvents).toBe('none')
    await Bun.sleep(180)
    root.renderer.flush()
    expect(await automation.getByTestId('shielded-picker-content').count()).toBe(0)
    await automation.close()
    root.unmount()
  })
})
