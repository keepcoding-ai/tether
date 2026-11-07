// Helpers for tests that use the ≡ menu: most items live in a submenu (Painel, Nota, Mesa, Ferramentas) that opens on hover.
import type { Locator, Page } from 'playwright-core'

/** Opens the submenu that holds `command` (hover, like the person; no-op for a root item) and returns the item's locator. */
export async function revealMenuItem(page: Page, command: string): Promise<Locator> {
  const item = page.locator(`#app-menu li[data-command="${command}"]`)
  const parent = page.locator(`#app-menu > li.sub:has(> ul.submenu > li[data-command="${command}"])`)
  if (await parent.count()) {
    await parent.hover()
    await page.waitForSelector(`#app-menu > li.sub[aria-expanded="true"]:has(> ul.submenu > li[data-command="${command}"])`)
  }
  return item
}

/** Clicks a ≡ item by command, opening its submenu first when it has one. The menu must be open. */
export async function clickMenuItem(page: Page, command: string): Promise<void> {
  const item = await revealMenuItem(page, command)
  await item.click()
}
