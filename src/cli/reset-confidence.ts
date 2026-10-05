import { AGENT_IDS, type AgentId } from "#src/core/agent.js";
import { readRecentEvents } from "#src/logging/log.js";

export interface ResetCounts {
  stated: number;
  guessed: number;
}

export type ResetConfidence = Record<AgentId, ResetCounts>;

/** Only retained blocked observations with a recorded source are evidence. */
export async function readResetConfidence(
  directory: string,
): Promise<ResetConfidence | undefined> {
  const counts: ResetConfidence = {
    claude: { stated: 0, guessed: 0 },
    codex: { stated: 0, guessed: 0 },
    gemini: { stated: 0, guessed: 0 },
  };

  try {
    const events = await readRecentEvents(
      directory,
      Infinity,
      (event) =>
        Number.isFinite(Date.parse(event.timestamp)) &&
        event.agent !== undefined &&
        AGENT_IDS.includes(event.agent) &&
        [
          "agent.waiting_known_reset",
          "agent.waiting_unknown_reset",
          "agent.long_term_block",
        ].includes(event.event),
    );

    for (const event of events) {
      // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition -- disk records can omit fields despite the stored-event type
      const source = event.fields?.reset_source;
      if (
        event.agent !== undefined &&
        (source === "stated" || source === "guessed")
      ) {
        counts[event.agent][source] += 1;
      }
    }

    return counts;
  } catch {
    return undefined;
  }
}

export function resetConfidenceLabel(counts: ResetCounts | undefined): string {
  if (counts === undefined) return "unavailable (log unreadable)";
  const total = counts.stated + counts.guessed;
  return total === 0
    ? "no recorded reset sources"
    : `${String(Math.round((100 * counts.stated) / total))}% provider-stated (${String(counts.stated)}/${String(total)})`;
}
