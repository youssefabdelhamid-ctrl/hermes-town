import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import { mkdtemp, rm, mkdir } from 'node:fs/promises';
import { chromium } from 'playwright';
import { createTownServer } from '../server/townServer.mjs';
import { createFleetServer } from '../server/fleetServer.mjs';
import { INGRESS_VERSION } from '../server/lib/contract.mjs';

const temp = await mkdtemp(path.join(os.tmpdir(), 'hermes-town-fleet-browser-'));
const token = crypto.randomBytes(32).toString('base64url');
const towns = [0, 1, 2].map(i => createTownServer({ token, journalPath: path.join(temp, `${i}.jsonl`) }));
let fleet, browser;
try {
  const addresses = await Promise.all(towns.map(t => t.listen(0)));
  const config = { buddies: addresses.map((a, i) => ({ id: ['nova', 'nia', 'quiet'][i], name: ['Nova', 'Nia', 'Quiet buddy'][i], url: `http://127.0.0.1:${a.port}` })) };
  fleet = createFleetServer({ config, staticRoot: path.resolve('dist') });
  const fa = await fleet.listen(0);
  const emit = async (i, key, kind) => {
    const result = await fetch(`${config.buddies[i].url}/api/town/ingest`, {
      method: 'POST', headers: { authorization: `Bearer ${token}` },
      body: JSON.stringify({ v: INGRESS_VERSION, events: [{ id: crypto.randomBytes(12).toString('hex'), key, kind, role: key.includes('/child/') ? 'research' : 'coordinator' }] }),
    });
    assert.equal(result.status, 202);
  };
  const main = 'h/main/0123456789abcdef', child = 'h/child/0123456789abcdef';
  for (const i of [0, 1]) { await emit(i, main, 'spawned'); await emit(i, main, 'assigned'); await emit(i, child, 'spawned'); }
  browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  const errors = [];
  page.on('pageerror', e => errors.push(e.message));
  await page.goto(`http://127.0.0.1:${fa.port}/?hour=17`);
  await page.waitForFunction(() => window.__town?.sim.residents.has('buddy/nova') && window.__town?.sim.residents.has('buddy/nia'));
  await page.waitForFunction(() => document.querySelectorAll('.buddy-row').length === 3);
  await page.waitForFunction(() => window.__town.game.scene.getScene('town').isAllBuddies());
  assert.equal(await page.evaluate(() => window.__town.sim.residents.has('buddy/quiet')), false, 'No invented resident before real activity');
  assert.equal(await page.evaluate(() => [...window.__town.sim.residents.values()].filter(r => r.isChild).length), 2, 'Identical upstream keys must not collide');
  await page.locator('[data-buddy="nova"]').click();
  await page.waitForFunction(() => window.__town.game.scene.getScene('town').selectedId() === 'buddy/nova');
  const identity = await page.evaluate(() => { const r = window.__town.sim.residents.get('buddy/nova'); return [r.id, r.home.id, r.name]; });
  const previousSeq = await page.evaluate(() => window.__town.sim.residents.get('buddy/nova').seq);
  await emit(0, main, 'departed');
  await page.waitForFunction(() => ['leaving', 'resting'].includes(window.__town.sim.residents.get('buddy/nova').state));
  await emit(0, 'h/main/fedcba9876543210', 'spawned');
  await emit(0, 'h/main/fedcba9876543210', 'assigned');
  await page.waitForFunction(seq => window.__town.sim.residents.get('buddy/nova').seq >= seq + 3, previousSeq);
  assert.ok(await page.evaluate(() => !['leaving', 'resting'].includes(window.__town.sim.residents.get('buddy/nova').state)), 'New work interrupts a buddy that is walking home');
  assert.deepEqual(await page.evaluate(() => { const r = window.__town.sim.residents.get('buddy/nova'); return [r.id, r.home.id, r.name]; }), identity);
  // Quiet time affects presentation, never removes persistent buddies.
  await page.evaluate(() => { for (let i = 0; i < 26000; i++) window.__town.sim.update(0.1); });
  assert.ok(await page.evaluate(() => window.__town.sim.residents.has('buddy/nova') && window.__town.sim.residents.has('buddy/nia')));
  await page.reload();
  await page.waitForFunction(() => window.__town?.sim.residents.has('buddy/nova'));
  assert.deepEqual(await page.evaluate(() => { const r = window.__town.sim.residents.get('buddy/nova'); return [r.id, r.home.id, r.name]; }), identity);
  // Restart only Nova with a new journal/stream; Nia must remain intact.
  await towns[0].close();
  await page.waitForFunction(() => document.querySelector('[data-buddy="nova"]')?.textContent.includes('disconnected'), { timeout: 15000 });
  assert.ok(await page.evaluate(() => window.__town.sim.residents.has('buddy/nia')));
  towns[0] = createTownServer({ token, journalPath: path.join(temp, 'nova-restarted.jsonl') });
  await towns[0].listen(addresses[0].port);
  await emit(0, main, 'spawned'); await emit(0, main, 'assigned');
  await page.waitForFunction(() => document.querySelector('[data-buddy="nova"]')?.textContent.includes('working'), { timeout: 15000 });
  assert.ok(await page.evaluate(() => window.__town.sim.residents.has('buddy/nia')));
  await page.getByRole('button', { name: 'All buddies', exact: true }).click();
  await page.waitForTimeout(500);
  const visible = () => page.evaluate(() => {
    const scene = window.__town.game.scene.getScene('town'), view = scene.cameras.main.worldView;
    const overlays = ['#masthead', '#sidebar', '#controls', '#minimap'].map(s => document.querySelector(s).getBoundingClientRect());
    return [...window.__town.sim.residents.values()].filter(r => r.state !== 'gone').every(r => {
      const x = (r.x - view.x) * scene.cameras.main.zoom, y = (r.y - view.y) * scene.cameras.main.zoom;
      return x >= 0 && x <= innerWidth && y >= 0 && y <= innerHeight
        && overlays.every(o => !(x >= o.left && x <= o.right && y >= o.top && y <= o.bottom));
    });
  });
  assert.ok(await visible(), 'All residents fit the desktop camera');
  await mkdir('output/playwright', { recursive: true });
  await page.screenshot({ path: 'output/playwright/all-buddies-desktop.png' });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.waitForTimeout(700);
  assert.ok(await visible(), 'All residents fit after mobile resize');
  await page.screenshot({ path: 'output/playwright/all-buddies-mobile.png' });
  await page.getByRole('button', { name: 'Library', exact: true }).click();
  await page.waitForFunction(() => !window.__town.game.scene.getScene('town').isAllBuddies());
  assert.deepEqual(errors, []);
  console.log('Fleet browser: roster, identity, quiet retention, namespacing, independent restart, camera, mobile passed');
} finally {
  await browser?.close();
  await fleet?.close();
  for (const t of towns) if (t.server.listening) await t.close();
  await rm(temp, { recursive: true, force: true });
}
