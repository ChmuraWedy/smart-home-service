import type { CombinedMemberInput } from './home-api';

type LayoutMember = { member: CombinedMemberInput };

export default function combinedLayout<T extends LayoutMember>(entries: T[]) {
  const byId = new Map(entries.map((entry) => [entry.member.device_id, entry]));
  const roots: T[] = [];
  const channels = new Map<string, Map<string, T[]>>();

  function sourceOf(member: CombinedMemberInput) {
    const { power_source: source } = member;
    if (!source || !byId.has(source.device_id)) return undefined;
    // An unsaved draft can contain a loop. Keep its devices visible until it is fixed.
    const seen = new Set([member.device_id]);
    for (let upstream = source; upstream;) {
      if (seen.has(upstream.device_id)) return undefined;
      seen.add(upstream.device_id);
      const next = byId.get(upstream.device_id)?.member.power_source;
      if (!next) break;
      upstream = next;
    }
    return source;
  }

  entries.forEach((entry) => {
    const source = sourceOf(entry.member);
    if (!source) {
      roots.push(entry);
      return;
    }
    const relay = channels.get(source.device_id) ?? new Map<string, T[]>();
    const powered = relay.get(source.channel) ?? [];
    powered.push(entry);
    relay.set(source.channel, powered);
    channels.set(source.device_id, relay);
  });
  return { byId, roots, channels };
}
