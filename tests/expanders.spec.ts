import {expect, Page, test} from '@playwright/test';
import {readFile} from 'node:fs/promises';
import {setupGedcomRoute} from './helpers';

// In test.ged, Bonifacy Gibbs (I1) is married to Jarmila Valenta (I2), whose
// parents are Temuri Valenta and Darby Varley. Their children (family F1) are
// Asim and Marie (I4), mother of Gandalf.
const URL = '/#/view?url=https://example.org/family.ged&indi=I1';

/** Longer than the chart transitions. */
const ANIMATION_MS = 1500;
/** Longer than the longest wait for an animation in chart_wrapper.ts. */
const MAX_ANIMATION_MS = 2500;

/**
 * Returns a [+]/[-] button of the given class, found through the data bound
 * to it by d3: the node id, or the id of the individual or spouse in the node.
 */
async function expanderButton(
  page: Page,
  className: string,
  key: 'id' | 'indi' | 'spouse',
  id: string,
) {
  await page.evaluate(
    ({className, key, id}) => {
      document.querySelectorAll('g.expander').forEach((element) => {
        const node = (
          element as unknown as {
            __data__?: {
              id?: string;
              data?: {indi?: {id?: string}; spouse?: {id?: string}};
            };
          }
        ).__data__;
        const nodeId = key === 'id' ? node?.id : node?.data?.[key]?.id;
        element.toggleAttribute(
          'data-test-button',
          element.classList.contains(className) && nodeId === id,
        );
      });
    },
    {className, key, id},
  );
  return page.locator('g.expander[data-test-button]');
}

/** The [+]/[-] button above Jarmila, which shows or hides her parents. */
function jarmilaButton(page: Page) {
  return expanderButton(page, 'spouseExpander', 'spouse', 'I2');
}

/** Clicks the [+]/[-] button above Jarmila. */
async function toggleJarmilaParents(page: Page) {
  // force: true because the button is small and drawn over the chart links.
  await (await jarmilaButton(page)).click({force: true});
}

/** Returns the opacity of the box of the given person in the chart. */
async function boxOpacity(page: Page, name: string) {
  return page.evaluate((name) => {
    const node = Array.from(document.querySelectorAll('#chart g.node')).find(
      (element) => element.textContent?.includes(name),
    );
    return node ? getComputedStyle(node).opacity : 'missing';
  }, name);
}

/** Returns whether the whole chart fits in the SVG element, on screen. */
async function chartFitsInSvg(page: Page) {
  return page.evaluate(() => {
    // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
    const svg = document.getElementById('chartSvg')!.getBoundingClientRect();
    // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
    const chart = document.getElementById('chart')!.getBoundingClientRect();
    return chart.right <= svg.right + 1 && chart.bottom <= svg.bottom + 1;
  });
}

test.describe('Collapse buttons', () => {
  test.beforeEach(async ({context}) => {
    await setupGedcomRoute(context);
  });

  test('are always shown', async ({page}) => {
    await page.goto(URL);
    await expect(page.getByTestId('chart')).toContainText('Temuri');
    await expect(page.locator('g.expander').first()).toBeVisible();
  });

  test('expand all branches from the settings', async ({page}) => {
    await page.goto(URL);
    const chart = page.getByTestId('chart');
    await expect(chart).toContainText('Temuri');
    await toggleJarmilaParents(page);
    await expect(chart).not.toContainText('Temuri');

    await page.getByText('Settings', {exact: true}).click();
    await page.getByRole('button', {name: 'Expand all branches'}).click();

    await expect(chart).toContainText('Temuri');
  });

  test('hide a single child', async ({page}) => {
    await page.goto(URL);
    const chart = page.getByTestId('chart');
    await expect(chart).toContainText('Gandalf');
    /** The button below Bonifacy and Jarmila, for all their children. */
    const familyButton = () =>
      expanderButton(page, 'familyExpander', 'id', 'F1');
    // A [-] has a single line, a [+] has two.
    await expect((await familyButton()).locator('line')).toHaveCount(1);

    // force: true because the button is small and drawn over the chart links.
    await (
      await expanderButton(page, 'childExpander', 'indi', 'I4')
    ).click({force: true});
    // Marie and her descendants are hidden, not her brother.
    await expect(chart).not.toContainText('Marie');
    await expect(chart).not.toContainText('Gandalf');
    await expect(chart).toContainText('Asim');
    await page.waitForTimeout(ANIMATION_MS);

    // The family button shows [+], which shows the hidden child again.
    await expect((await familyButton()).locator('line')).toHaveCount(2);
    await (await familyButton()).click({force: true});
    await expect(chart).toContainText('Marie');
    await expect(chart).toContainText('Gandalf');
    await page.waitForTimeout(ANIMATION_MS);
    expect(await boxOpacity(page, 'Marie')).toBe('1');
    await expect((await familyButton()).locator('line')).toHaveCount(1);
  });

  test('keep the nearest sibling of a hidden child in place', async ({
    page,
  }) => {
    await page.goto(URL);
    await expect(page.getByTestId('chart')).toContainText('Gandalf');
    // Zoom in, and scroll to the right, so that the view can follow the chart
    // when it becomes narrower.
    for (let i = 0; i < 4; i++) {
      await page.locator('.zoom-in').click();
    }
    await page.waitForTimeout(ANIMATION_MS);
    await page.locator('#svgContainer').evaluate((container) => {
      container.scrollLeft = container.scrollWidth;
    });
    await page.waitForTimeout(ANIMATION_MS);
    const marieButton = () =>
      expanderButton(page, 'childExpander', 'indi', 'I4');
    const before = await (await marieButton()).boundingBox();

    // Hide Asim, the brother of Marie, on her left.
    await (
      await expanderButton(page, 'childExpander', 'indi', 'I3')
    ).click({force: true});
    await expect(page.getByTestId('chart')).not.toContainText('Asim');
    await page.waitForTimeout(ANIMATION_MS);

    const after = await (await marieButton()).boundingBox();
    expect(Math.abs((after?.x ?? 0) - (before?.x ?? 0))).toBeLessThan(2);
    expect(Math.abs((after?.y ?? 0) - (before?.y ?? 0))).toBeLessThan(2);
  });

  test('stay collapsed when a setting changes', async ({page}) => {
    await page.goto(URL);
    const chart = page.getByTestId('chart');
    await expect(chart).toContainText('Temuri');
    await toggleJarmilaParents(page);
    await expect(chart).not.toContainText('Temuri');

    // Changing settings draws a new chart.
    await page.getByText('Settings', {exact: true}).click();
    await page
      .locator('form.details .item')
      .filter({hasText: 'Sex'})
      .getByText('hide', {exact: true})
      .click();
    await expect(page).toHaveURL(/[?&]s=h(&|$)/);
    const above = page
      .locator('form.details .item')
      .filter({hasText: 'Generations above'});
    await above.getByText('limit to', {exact: true}).click();
    await expect(page).toHaveURL(/[?&]gu=/);
    await page.waitForTimeout(ANIMATION_MS);
    await expect(chart).toContainText('Mervyn');
    await expect(chart).not.toContainText('Temuri');

    // Until all the branches are expanded.
    await page.getByRole('button', {name: 'Expand all branches'}).click();
    await expect(chart).toContainText('Temuri');
  });

  test('keep the clicked button in place', async ({page}) => {
    await page.goto(URL);
    await expect(page.getByTestId('chart')).toContainText('Temuri');
    // Zoom in so that the chart is larger than the window and can be
    // scrolled; a smaller chart is centered instead.
    for (let i = 0; i < 4; i++) {
      await page.locator('.zoom-in').click();
    }
    await page.waitForTimeout(ANIMATION_MS);
    const before = await (await jarmilaButton(page)).boundingBox();

    await toggleJarmilaParents(page);
    await page.waitForTimeout(ANIMATION_MS);

    const after = await (await jarmilaButton(page)).boundingBox();
    expect(Math.abs((after?.x ?? 0) - (before?.x ?? 0))).toBeLessThan(2);
    expect(Math.abs((after?.y ?? 0) - (before?.y ?? 0))).toBeLessThan(2);
  });

  test('collapse and expand a branch', async ({page}) => {
    await page.goto(URL);
    const chart = page.getByTestId('chart');
    await expect(chart).toContainText('Temuri');
    const url = page.url();

    await toggleJarmilaParents(page);
    await expect(chart).not.toContainText('Temuri');
    // The paternal branch is still there and the selection did not change.
    await expect(chart).toContainText('Radobod');
    expect(page.url()).toBe(url);
    await page.waitForTimeout(ANIMATION_MS);

    await toggleJarmilaParents(page);
    await expect(chart).toContainText('Temuri');
    // The boxes shown again must fade in completely.
    await page.waitForTimeout(ANIMATION_MS);
    expect(await boxOpacity(page, 'Temuri')).toBe('1');
  });

  test('resize the chart when a branch is expanded', async ({page}) => {
    await page.goto(URL);
    const chart = page.getByTestId('chart');
    await expect(chart).toContainText('Temuri');

    // Collapse, then select other people so that the chart is resized to the
    // smaller collapsed tree.
    await toggleJarmilaParents(page);
    await expect(chart).not.toContainText('Temuri');
    await chart.getByText('Asim').click({force: true});
    await expect(page).toHaveURL(/indi=I3/);
    await chart.getByText('Bonifacy').click({force: true});
    await expect(page).toHaveURL(/indi=I1/);
    await expect(chart).toContainText('Marie');
    await expect(chart).not.toContainText('Temuri');
    // Let the chart settle, so that only the expander can resize it.
    await page.waitForTimeout(MAX_ANIMATION_MS);

    // Expanding again must enlarge the SVG so that nothing is cut off.
    await toggleJarmilaParents(page);
    await expect(chart).toContainText('Temuri');
    await page.waitForTimeout(ANIMATION_MS);
    await expect.poll(() => chartFitsInSvg(page), {timeout: 5000}).toBe(true);
  });

  test('do not freeze the chart when clicked during an animation', async ({
    page,
  }) => {
    await page.goto(URL);
    const chart = page.getByTestId('chart');
    await expect(chart).toContainText('Asim');

    // Click a button right after selecting someone, while the chart moves.
    await chart.getByText('Marie').click({force: true});
    await expect(page).toHaveURL(/indi=I4/);
    await toggleJarmilaParents(page);

    // The chart must still follow the next selections: centered on Marie, the
    // hourglass chart does not show her brother Asim; centered on their father
    // Bonifacy, it does.
    await expect(chart).not.toContainText('Asim');
    await chart.getByText('Bonifacy').click({force: true});
    await expect(page).toHaveURL(/indi=I1/);
    await expect(chart).toContainText('Asim');
  });

  test('are not included in exported files', async ({page}) => {
    await page.goto(URL);
    await expect(page.locator('g.expander').first()).toBeVisible();

    await page.getByText('Download', {exact: true}).click();
    const downloadPromise = page.waitForEvent('download');
    await page.getByText('SVG file', {exact: true}).click();
    const download = await downloadPromise;
    const svg = await readFile((await download.path()) ?? '', 'utf-8');

    expect(svg).toContain('Bonifacy');
    // The stylesheet still mentions .expander, but no button is left.
    expect(svg).not.toMatch(/class="[^"]*expander/);
  });
});
