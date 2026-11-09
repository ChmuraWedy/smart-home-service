import type { JsonValue } from './api';
import type { Reading } from './home-api';

export default function powerControlState({
  value, draft, dirty, reading, fresh, awaiting, displayPower,
}: {
  value: JsonValue;
  draft: string;
  dirty: boolean;
  reading?: Reading;
  fresh: boolean;
  awaiting: boolean;
  displayPower?: boolean | null;
}) {
  const selectedPower = dirty ? draft === 'true' : value === true;
  const reported = reading?.known && typeof reading.value === 'boolean' ? reading.value : null;
  const hasOverride = displayPower !== undefined;
  const shownPower = hasOverride ? displayPower === true : selectedPower;
  const powerKnown = hasOverride ? displayPower !== null : awaiting || reported !== null;
  const showPending = !hasOverride && awaiting;
  const showStale = !hasOverride && powerKnown && !fresh && !awaiting;
  const actionPower = awaiting ? selectedPower || null : reported;

  return {
    selectedPower,
    shownPower,
    powerKnown,
    showPending,
    showStale,
    actionPower,
  };
}
