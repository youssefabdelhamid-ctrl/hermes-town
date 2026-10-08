import type { TownSim } from '../sim/town';
import type { BuddyStatus, Source, TownEvent } from './events';
import { createLiveSource } from './liveSource';

interface Buddy {
  id: string;
  name: string;
  source: Source;
  sessions: Map<string, TownEvent['type']>;
  lastEventAt: number | null;
  activity: BuddyStatus['activity'];
  latestMain: string | null;
  serial: number;
}

/** Detect a fleet collector; ordinary Town servers retain their existing source. */
export function createFleetSource(sim: TownSim): Source {
  const buddies: Buddy[] = [];
  let fallback: Source | null = null;
  let state: 'connecting' | 'disconnected' = 'connecting';
  let stopped = true;
  let retry: number | null = null;
  let generation = 0;
  const discover = async (run: number): Promise<void> => {
    try {
      const response = await fetch('/api/town/fleet', { cache: 'no-store' });
      if (stopped || run !== generation) return;
      if (response.status === 404) {
        fallback = createLiveSource(sim);
        fallback.start(); return;
      }
      if (!response.ok) throw new Error('Collector unavailable');
      const body = await response.json() as { v?: unknown; buddies?: unknown };
      if (body.v !== 'hermes-town.fleet.v1' || !Array.isArray(body.buddies) || !body.buddies.length || body.buddies.length > 64) throw new Error('Invalid fleet');
      const ids = new Set<string>();
      const configured = body.buddies.map((raw: unknown) => {
        const b = raw as Record<string, unknown>;
        if (!b || typeof b.id !== 'string' || !/^[a-z][a-z0-9_-]{0,31}$/.test(b.id) || ids.has(b.id)
          || typeof b.name !== 'string' || !b.name.trim() || b.name.length > 48) throw new Error('Invalid buddy');
        ids.add(b.id); return { id: b.id, name: b.name };
      });
      if (stopped || run !== generation) return;
      for (const config of configured) {
        const buddy: Buddy = { ...config, source: null as unknown as Source, sessions: new Map(), lastEventAt: null, activity: 'unknown', latestMain: null, serial: 0 };
        const prefix = `/api/town/fleet/${buddy.id}`;
        buddy.source = createLiveSource({
          push(e) {
            buddy.sessions.set(e.agentId, e.type);
            // Keep tracking bounded, just like each upstream Town projection.
            if (buddy.sessions.size > 256) buddy.sessions.delete(buddy.sessions.keys().next().value!);
            buddy.lastEventAt = Math.max(buddy.lastEventAt ?? 0, e.at);
            if (e.agentId.includes('/main/')) {
              if (e.type === 'agent.spawned' || e.type === 'agent.assigned' || e.type === 'agent.tool_started') buddy.latestMain = e.agentId;
              // A late ending from an older session cannot retire the newer one.
              if (buddy.latestMain !== null && buddy.latestMain !== e.agentId) return;
              if (buddy.latestMain === null) buddy.latestMain = e.agentId;
              buddy.activity = e.type === 'agent.assigned' || e.type === 'agent.tool_started' ? 'working'
                : e.type === 'agent.waiting' || e.type === 'agent.completed' ? 'waiting'
                : e.type === 'agent.failed' ? 'failed' : e.type === 'agent.departed' ? 'quiet' : 'unknown';
              sim.pushBuddy(buddy.id, buddy.name, e, ++buddy.serial);
            } else {
              sim.push({ ...e, id: `${buddy.id}:${e.id}`, agentId: `fleet/${buddy.id}/${e.agentId}` });
            }
          },
          reset() {
            buddy.sessions.clear(); buddy.latestMain = null; buddy.activity = 'unknown'; buddy.lastEventAt = null;
            sim.resetBuddy(buddy.id);
          },
          settle() {
            sim.settleBuddy(buddy.id, buddy.lastEventAt !== null && buddy.source.now() - buddy.lastEventAt > 600);
          },
        }, { snapshot: `${prefix}/snapshot`, stream: `${prefix}/events` });
        buddies.push(buddy);
        buddy.source.start();
      }
    } catch {
      if (stopped || run !== generation) return;
      state = 'disconnected';
      retry = window.setTimeout(() => { retry = null; void discover(run); }, 2500);
    }
  };
  return {
    label: 'live Hermes buddies',
    start() { if (!stopped) return; stopped = false; state = 'connecting'; void discover(++generation); },
    stop() {
      stopped = true; generation++;
      if (retry !== null) window.clearTimeout(retry);
      fallback?.stop(); for (const b of buddies) b.source.stop();
      buddies.length = 0; fallback = null;
    },
    status() {
      if (stopped) return 'idle';
      if (fallback) return fallback.status();
      if (!buddies.length) return state;
      return buddies.some(b => b.source.status() === 'connected') ? 'connected'
        : buddies.some(b => b.source.status() === 'connecting' || b.source.status() === 'reconnecting') ? 'reconnecting' : 'disconnected';
    },
    now: () => fallback?.now() ?? Date.now() / 1000,
    bridge() {
      if (fallback) return fallback.bridge?.() ?? null;
      const known = buddies.map(b => b.source.bridge?.()).filter((b): b is NonNullable<typeof b> => b !== null && b !== undefined);
      return known.length ? { receivedEvents: known.reduce((n, b) => n + b.receivedEvents, 0), lastEventAt: known.reduce<number | null>((at, b) => b.lastEventAt === null ? at : Math.max(at ?? 0, b.lastEventAt), null) } : null;
    },
    omitted: () => fallback?.omitted?.() ?? { stale: 0, departed: 0 },
    buddies: () => buddies.map(b => ({
      id: b.id, name: b.name, connection: b.source.status(),
      activity: b.lastEventAt !== null && b.source.now() - b.lastEventAt > 600 ? 'quiet' : b.activity,
      lastEventAt: b.lastEventAt === null ? null : Date.now() / 1000 - (b.source.now() - b.lastEventAt),
      residentId: sim.residents.has(`buddy/${b.id}`) ? `buddy/${b.id}` : null,
      sessions: [...b.sessions].filter(([id, kind]) => id.includes('/main/') && kind !== 'agent.departed').length,
    })),
  };
}
