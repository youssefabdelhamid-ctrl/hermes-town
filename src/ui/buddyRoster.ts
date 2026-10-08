import { paintCharacterSheet, lookFor, FRAME_W, FRAME_H, CHARACTER_SCALE, CHARACTER_BASELINE, FRAME_COLUMNS, idleFrame } from '../art/characters';
import { hashString } from '../art/painter';
import type { BuddyStatus, Source } from '../live/events';
import type { TownSim } from '../sim/town';
import { PLACE_LABEL } from '../sim/toolMap';

const age = (seconds: number): string => seconds < 60 ? `${Math.floor(seconds)}s` : seconds < 3600 ? `${Math.floor(seconds / 60)}m` : `${Math.floor(seconds / 3600)}h`;

export function createBuddyRoster(sim: TownSim, source: Source, select: (id: string) => void): () => void {
  const list = document.querySelector<HTMLElement>('#buddy-list')!;
  const count = document.querySelector<HTMLElement>('#buddy-count')!;
  const rows = new Map<string, { button: HTMLButtonElement; status: HTMLElement; detail: HTMLElement }>();
  const configured = (): BuddyStatus[] => source.buddies?.() ?? [];
  const all = (): BuddyStatus[] => {
    const fleet = configured();
    if (fleet.length) return fleet;
    return [...sim.residents.values()].filter(r => r.kind === 'session' && !r.isChild && r.state !== 'gone').map(r => ({
      id: r.id, name: r.name, connection: source.status(), residentId: r.id, sessions: 1,
      lastEventAt: source.now() - (sim.now() - r.lastEventAt),
      activity: r.memory || r.state === 'resting' ? 'quiet' : r.state === 'waiting' || r.state === 'posted' ? 'waiting' : r.state === 'failed' ? 'failed' : 'working',
    }));
  };
  list.addEventListener('click', e => {
    const row = (e.target as HTMLElement).closest<HTMLButtonElement>('[data-buddy]');
    const buddy = all().find(b => b.id === row?.dataset.buddy);
    if (buddy?.residentId) select(buddy.residentId);
  });
  return () => {
    const buddies = all(), ids = new Set(buddies.map(b => b.id));
    count.textContent = String(buddies.length);
    for (const [id, row] of rows) if (!ids.has(id)) { row.button.remove(); rows.delete(id); }
    const empty = document.querySelector<HTMLElement>('#buddy-empty')!;
    empty.hidden = buddies.length > 0;
    for (const b of buddies) {
      let row = rows.get(b.id);
      const resident = b.residentId ? sim.residents.get(b.residentId) : null;
      if (!row) {
        const button = document.createElement('button'); button.type = 'button'; button.className = 'buddy-row'; button.dataset.buddy = b.id;
        const portrait = document.createElement('canvas'); portrait.width = 48; portrait.height = 64; portrait.className = 'buddy-portrait'; portrait.setAttribute('aria-hidden', 'true');
        const role = resident?.role ?? 'coordinator', identity = b.residentId ?? `buddy/${b.id}`;
        const bucket = `${role}-${hashString(identity) % 16}`;
        const sheet = paintCharacterSheet(lookFor(bucket, role)), frame = idleFrame('down', 0);
        const ctx = portrait.getContext('2d')!; ctx.imageSmoothingEnabled = false;
        const fw = FRAME_W * CHARACTER_SCALE, fh = FRAME_H * CHARACTER_SCALE;
        ctx.drawImage(sheet, frame % FRAME_COLUMNS * fw, Math.floor(frame / FRAME_COLUMNS) * fh, fw, fh,
          (48 - FRAME_W * 2) / 2, 64 - CHARACTER_BASELINE * 2, FRAME_W * 2, FRAME_H * 2);
        const info = document.createElement('span'); info.className = 'buddy-info';
        const name = document.createElement('strong'); name.textContent = b.name;
        const status = document.createElement('span'); status.className = 'buddy-status';
        const detail = document.createElement('span'); detail.className = 'buddy-detail';
        info.append(name, status, detail); button.append(portrait, info); list.append(button);
        row = { button, status, detail }; rows.set(b.id, row);
      }
      const status = b.connection !== 'connected' ? b.connection : b.activity;
      row.button.dataset.state = status;
      row.button.disabled = !b.residentId;
      row.status.textContent = status === 'unknown' ? b.residentId ? 'activity unknown' : 'awaiting first session' : status;
      row.button.setAttribute('aria-label', `${b.name} · ${row.status.textContent}`);
      const place = resident?.place ? PLACE_LABEL[resident.place] : resident?.state === 'resting' ? 'at home' : resident ? 'in town' : 'no session observed';
      row.detail.textContent = `${place} · ${b.lastEventAt === null ? 'no event yet' : `${age(Math.max(0, source.now() - b.lastEventAt))} ago`}`
        + (b.sessions > 1 ? ` · ${b.sessions} sessions` : '');
    }
  };
}
