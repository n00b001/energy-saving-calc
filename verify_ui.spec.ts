import { test, expect } from '@playwright/test';

test('verify energy simulator', async ({ page }) => {
  await page.goto('http://localhost:5173');

  // Wait for the app to load
  await page.waitForSelector('h1:has-text("VELOCITY")');

  // Take a screenshot of the overview
  await page.screenshot({ path: 'overview.png', fullPage: true });

  // Switch to Energy Params tab
  await page.click('button:has-text("Energy Params")');
  await page.waitForSelector('h3:has-text("Asset Sizing")');

  // Click "Add Another Solar Array"
  await page.click('button:has-text("+ Add Another Solar Array")');

  // Take a screenshot of multi-array support
  await page.screenshot({ path: 'solar_arrays.png', fullPage: true });

  // Switch to Data Sync tab
  await page.click('button:has-text("Data Sync")');
  await page.waitForSelector('h3:has-text("Data Sync")');
  await page.screenshot({ path: 'data_sync.png', fullPage: true });
});
