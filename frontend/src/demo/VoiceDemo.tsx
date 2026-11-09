import { useState } from 'react';
import type { HomeApi } from '../home-api';
import examples from './voice-examples.json';

export default function VoiceDemo({ api }: { api: HomeApi }) {
  const [selected, setSelected] = useState<number | null>(null);
  const [reply, setReply] = useState('');
  const [busy, setBusy] = useState(false);

  async function replay(index: number) {
    const example = examples[index];
    setSelected(index);
    setReply('');
    setBusy(true);
    try {
      const { devices } = await api.inventory();
      const device = devices.find(({ name }) => name === example.device);
      if (!device) throw new Error('The example device is unavailable.');
      if (typeof example.value === 'boolean') {
        const result = await api.setCapability(device.id, example.reading, example.value);
        if (!result.acknowledged) throw new Error('The demo did not accept the command.');
      }
      const state = await api.state(device.id);
      const reading = state.values[example.reading];
      if (!state.available || !reading?.known || reading.stale) throw new Error('The demo reading is unavailable.');
      if (typeof reading.value === 'boolean') {
        setReply(`${device.name} is ${reading.value ? 'on' : 'off'}.`);
      } else {
        setReply(`${device.name} is ${reading.value}${example.unit ?? ''}.`);
      }
    } catch (error) {
      setReply(error instanceof Error ? error.message : 'This example could not be replayed.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="demo-voice">
      <p>These transcripts are scripted and run without a live voice agent or microphone. Replies use the current data from the simulated dashboard.</p>
      <div className="demo-voice-examples">
        {examples.map(({ transcript }, index) => (
          <button
            key={transcript}
            type="button"
            className="secondary compact"
            disabled={busy}
            onClick={() => replay(index)}
          >
            {transcript}
          </button>
        ))}
      </div>
      {selected !== null && (
        <p>
          <strong>Example transcript</strong>
          {' “'}{examples[selected].transcript}”
        </p>
      )}
      <div role="status">{busy ? 'Replaying example…' : reply}</div>
    </div>
  );
}
