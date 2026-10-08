import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import { mkdtemp, rm } from 'node:fs/promises';
import { createTownServer } from '../server/townServer.mjs';
import { createFleetServer, parseFleetConfig, publicEvent } from '../server/fleetServer.mjs';
import { INGRESS_VERSION } from '../server/lib/contract.mjs';
import { createTownState } from '../server/lib/townState.mjs';

for (const url of ['http://example.com:4187', 'http://127.0.0.1:4187/private', 'http://user:secret@localhost:4187', 'https://localhost:4187']) {
  assert.throws(() => parseFleetConfig({ buddies: [{ id: 'a', name: 'A', url }] }));
}
assert.throws(() => parseFleetConfig({ buddies: [{ id: 'a', name: 'A', url: 'http://localhost:4187', token: 'secret' }] }));
assert.throws(() => parseFleetConfig({ buddies: [0, 1].map(() => ({ id: 'a', name: 'A', url: 'http://localhost:4187' })) }));
const token = crypto.randomBytes(32).toString('base64url');
const temp = await mkdtemp(path.join(os.tmpdir(), 'hermes-town-fleet-'));
const a = createTownServer({ token, journalPath: path.join(temp, 'a.jsonl') });
const b = createTownServer({ token, journalPath: path.join(temp, 'b.jsonl') });
let fleet;
const key = 'h/main/0123456789abcdef';
let clock = 1000;
const retained = createTownState({ journalPath: path.join(temp, 'retention.jsonl'), clock: () => clock });
retained.ingest([{ id: 'retained_initial', key, kind: 'spawned', role: 'coordinator' }]);
clock += 16 * 60;
assert.equal(retained.snapshot().events.length, 0);
assert.equal(retained.snapshot(null, null, true).events.length, 1, 'Fleet snapshots preserve quiet evidence');
assert.equal(publicEvent({ id: 'PRIVATE_SENTINEL', agentId: key, cursor: 1, seq: 1, at: 1, type: 'agent.spawned', role: 'general' }), null);
const safe = publicEvent({ id: 'e1', agentId: key, cursor: 1, seq: 1, at: 1, type: 'agent.assigned', prompt: 'PRIVATE_SENTINEL', action: 'PRIVATE_SENTINEL' });
assert.equal(JSON.stringify(safe).includes('PRIVATE_SENTINEL'), false);
try {
  const aa = await a.listen(0), ba = await b.listen(0);
  const config = { buddies: [
    { id: 'nova', name: 'Nova', url: `http://127.0.0.1:${aa.port}` },
    { id: 'nia', name: 'Nia', url: `http://127.0.0.1:${ba.port}` },
  ] };
  fleet = createFleetServer({ config });
  await assert.rejects(() => fleet.listen(0, '0.0.0.0'), /loopback/);
  const address = await fleet.listen(0);
  const base = `http://127.0.0.1:${address.port}`;
  const manifest = await (await fetch(`${base}/api/town/fleet`)).json();
  assert.deepEqual(manifest.buddies, config.buddies.map(({ id, name }) => ({ id, name })));
  assert.equal(JSON.stringify(manifest).includes('127.0.0.1'), false);
  for (const town of [a, b]) {
    town.state.ingest([{ id: crypto.randomBytes(16).toString('hex'), key, kind: 'spawned', role: 'coordinator' }]);
    town.state.ingest([{ id: crypto.randomBytes(16).toString('hex'), key, kind: 'departed', role: 'coordinator' }]);
  }
  for (const id of ['nova', 'nia']) {
    const response = await fetch(`${base}/api/town/fleet/${id}/snapshot`);
    assert.equal(response.status, 200);
    assert.match(response.headers.get('content-security-policy'), /connect-src 'self'/);
    assert.equal(response.headers.get('access-control-allow-origin'), null);
    const snapshot = await response.json();
    assert.equal(snapshot.events.length, 2, 'Quiet/departed sessions remain available for persistent buddies');
    assert.equal(snapshot.events[0].agentId, key);
    assert.equal(JSON.stringify(snapshot).includes(token), false);
  }
  assert.equal(a.state.snapshot().events.length, 0, 'Ordinary snapshots keep their original departure behavior');
  assert.equal((await fetch(`${base}/api/town/fleet/nova/ingest`, { method: 'POST', body: JSON.stringify({ v: INGRESS_VERSION }) })).status, 405);
  assert.equal((await fetch(`${base}/api/town/fleet/missing/snapshot`)).status, 404);
  // Each proxy forwards its own cursor/stream and must deliver live SSE.
  const controller = new AbortController();
  const stream = await fetch(`${base}/api/town/fleet/nia/events?since=2`, { signal: controller.signal });
  const reader = stream.body.getReader();
  await reader.read();
  await fetch(`${config.buddies[1].url}/api/town/ingest`, {
    method: 'POST', headers: { authorization: `Bearer ${token}` },
    body: JSON.stringify({ v: INGRESS_VERSION, events: [{ id: 'fleet_live_event', key, kind: 'assigned', role: 'coordinator' }] }),
  });
  let frames = '';
  while (!frames.includes('agent.assigned')) {
    const result = await reader.read();
    assert.ok(!result.done);
    frames += new TextDecoder().decode(result.value);
  }
  assert.ok(frames.includes('event: town'));
  controller.abort();
  await b.close();
  assert.equal((await fetch(`${base}/api/town/fleet/nia/snapshot`)).status, 503);
  assert.equal((await fetch(`${base}/api/town/fleet/nova/snapshot`)).status, 200, 'One disconnected source cannot clear the others');
  console.log('Fleet: configuration boundaries, retained buddies, isolated profiles, live SSE, disconnection passed');
} finally {
  await fleet?.close();
  if (a.server.listening) await a.close();
  if (b.server.listening) await b.close();
  await rm(temp, { recursive: true, force: true });
}
