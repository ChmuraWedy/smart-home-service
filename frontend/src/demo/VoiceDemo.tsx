import { useEffect, useRef, useState } from 'react';
import type { FormEvent } from 'react';
import type { HomeApi, LocalDevice } from '../home-api';
import examples from './voice-examples.json';
import './voice-demo.css';

type Example = typeof examples[number];
type Turn = { id: string; transcript: string; title: string; detail: string; badge: string };

async function runExample(api: HomeApi, devices: LocalDevice[], example: Example, signal?: AbortSignal): Promise<Turn> {
  const { transcript } = example;
  const id = crypto.randomUUID();
  try {
    const device = devices.find(({ name }) => name === example.device);
    if (!device) throw new Error('The example device is unavailable.');
    if (typeof example.value === 'boolean') {
      const result = await api.setCapability(device.id, example.reading, example.value);
      if (!result.acknowledged) throw new Error('The demo did not accept the command.');
    }
    const state = await api.state(device.id, false, signal);
    const reading = state.values[example.reading];
    if (!state.available || !reading?.known || reading.stale) throw new Error('The demo reading is unavailable.');
    let detail = `${device.name} is ${reading.value}${example.unit ?? ''}.`;
    if (typeof reading.value === 'boolean') detail = `${device.name} is ${reading.value ? 'on' : 'off'}.`;
    return {
      id, transcript, title: device.name, detail, badge: 'Reported state',
    };
  } catch (error) {
    return {
      id,
      transcript,
      title: 'Home Voice',
      detail: error instanceof Error ? error.message : 'This example could not be replayed.',
      badge: 'Unconfirmed',
    };
  }
}

const opening = examples.filter((example) => example.value === undefined);

export default function VoiceDemo({ api }: { api: HomeApi }) {
  const [turns, setTurns] = useState<Turn[]>([]);
  const [devices, setDevices] = useState<LocalDevice[]>([]);
  const [busy, setBusy] = useState(true);
  const [status, setStatus] = useState('Loading sample conversation…');
  const [text, setText] = useState('');
  const [next, setNext] = useState(0);
  const conversation = useRef<HTMLElement>(null);

  useEffect(() => {
    const controller = new AbortController();
    api.inventory(controller.signal).then(async (inventory) => {
      const initial = await Promise.all(opening.map((example) => runExample(api, inventory.devices, example, controller.signal)));
      if (controller.signal.aborted) return;
      setDevices(inventory.devices);
      setTurns(initial);
      setStatus('Play a scripted voice example');
      setBusy(false);
    }).catch(() => {
      if (!controller.signal.aborted) setStatus('The demo dashboard is unavailable. Reopen chat to retry.');
    });
    return () => controller.abort();
  }, [api]);

  useEffect(() => {
    const log = conversation.current;
    if (log && turns.length > opening.length) log.scrollTop = log.scrollHeight;
  }, [turns]);

  async function replay(example: Example) {
    setBusy(true);
    setStatus('Replaying example…');
    const turn = await runExample(api, devices, example);
    setTurns((history) => [...history.slice(-29), turn]);
    setStatus('Play a scripted voice example');
    setBusy(false);
  }

  function playNext() {
    setNext((next + 1) % examples.length);
    return replay(examples[next]);
  }

  async function sendTyped(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const example = examples.find(({ transcript }) => transcript.toLowerCase() === text.trim().toLowerCase());
    if (!example) {
      setStatus('Choose one of the listed example messages.');
      return;
    }
    setText('');
    await replay(example);
  }

  return (
    <div className="demo-voice">
      <header className="demo-voice-header">
        <h3>Home Voice</h3>
        <p>Conversation · Scripted demo</p>
        <p>Replies use the dashboard’s current values. This demo runs without a microphone or live voice agent.</p>
      </header>
      <section className="demo-voice-conversation" aria-label="Conversation" ref={conversation}>
        <div role="log" aria-label="Messages" aria-relevant="additions">
          {turns.map(({
            id, transcript, title, detail, badge,
          }) => (
            <div className="demo-voice-turn" key={id}>
              <p className="demo-voice-utterance">{transcript}</p>
              <article className="demo-voice-answer">
                <div>
                  <h4>{title}</h4>
                  <span>{badge}</span>
                </div>
                <p>{detail}</p>
              </article>
            </div>
          ))}
        </div>
      </section>
      <div className="demo-voice-footer">
        <button
          type="button"
          className="demo-voice-mic"
          aria-label="Play a scripted voice example"
          disabled={busy}
          onClick={playNext}
        >
          <svg
            aria-hidden="true"
            width="38"
            height="38"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.6"
            strokeLinecap="round"
          >
            <rect
              x="9"
              y="2"
              width="6"
              height="13"
              rx="3"
            />
            <path d="M5 10v2a7 7 0 0 0 14 0v-2M12 19v3m-3 0h6" />
          </svg>
        </button>
        <p role="status">{status}</p>
        <details>
          <summary>Type instead</summary>
          <form onSubmit={sendTyped}>
            <input
              aria-label="Message Home Voice"
              placeholder="Choose an example message"
              list="demo-voice-prompts"
              value={text}
              onChange={(event) => setText(event.currentTarget.value)}
              disabled={busy}
              required
            />
            <datalist id="demo-voice-prompts">
              {examples.map(({ transcript }) => <option key={transcript} value={transcript}>{transcript}</option>)}
            </datalist>
            <button type="submit" aria-label="Send typed message" disabled={busy}>↑</button>
          </form>
        </details>
      </div>
    </div>
  );
}
