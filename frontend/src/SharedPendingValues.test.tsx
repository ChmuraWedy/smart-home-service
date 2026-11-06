import { act, fireEvent, renderHook, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { rotateCloudAccountScope } from './cloud-account-scope';
import { CapabilityField, useControlSession } from './components/DeviceControls';
import type { ControlSpec } from './controls';
import { HomeApi } from './home-api';
import type { Reading } from './home-api';
import { beginPendingValue, cloudPendingScope, localPendingScope, pendingReadingReported, pendingValueKey, PENDING_READING_TIMEOUT_MS } from './pending-device-values';
import { createAppStore } from './store';
import { renderWithStore } from './test/render-with-store';
import { usePendingPrivacyState } from './use-pending-device-value';

const known = (value: Reading['value'], observedAt?: number): Reading =>
  ({ value, known: true, stale: false, observed_at: observedAt === undefined ? undefined : new Date(observedAt).toISOString() });
const connection = { baseUrl: 'http://api.test', token: 'fixture' };
const power: ControlSpec = { key: 'switch_led', label: 'Power', kind: 'boolean', writable: true, readable: true };
const brightness: ControlSpec = { key: 'bright_value', label: 'Brightness', kind: 'number', minimum: 1, maximum: 100, writable: true, readable: true };
const privacy: ControlSpec = { ...power, key: 'basic_private', label: 'Privacy' };
const pendingMessage = 'Ожидаем новое показание';
const defaultProps = { local: false, disabled: false, immediatePower: true, pendingScope: 'device' };

afterEach(() => { vi.useRealTimers(); });

describe('shared accepted targets', () => {
  it('shares an acknowledged power target across fields and across remounts until a new report', async () => {
    vi.useFakeTimers();
    const now = Date.now();
    const cached = known(false, now - 5000);
    const send = vi.fn().mockResolvedValue(true);
    const field = (key: string, reading: Reading) => <CapabilityField key={key} {...defaultProps} spec={power} now={now} reading={reading} onSend={send} />;
    const view = renderWithStore(<>{field('card', cached)}{field('sheet', cached)}</>);
    const [card, sheet] = screen.getAllByRole('switch');
    fireEvent.click(card);
    await act(async () => {});
    expect(send).toHaveBeenCalledExactlyOnceWith(true);
    expect(card).toBeChecked();
    expect(sheet).toBeChecked();
    expect(screen.getAllByText(pendingMessage)).toHaveLength(2);

    view.rerender(field('details', known(true, now - 10000)));
    expect(screen.getByRole('switch')).toBeChecked();
    expect(screen.getByText(pendingMessage)).toBeInTheDocument();
    view.rerender(field('details', known(true, now + 1000)));
    expect(screen.getByRole('switch')).toBeChecked();
    expect(screen.queryByText(pendingMessage)).not.toBeInTheDocument();
  });

  it('preserves another editor’s unsent draft while a shared value is acknowledged', async () => {
    vi.useFakeTimers();
    const now = Date.now();
    const send = vi.fn().mockResolvedValue(true);
    const reading = known(40, now - 1000);
    renderWithStore(<>
      <section aria-label="First"><CapabilityField {...defaultProps} spec={brightness} now={now} reading={reading} onSend={send} /></section>
      <section aria-label="Second"><CapabilityField {...defaultProps} spec={brightness} now={now} reading={reading} onSend={send} /></section>
    </>);
    const first = within(screen.getByRole('region', { name: 'First' }));
    const second = within(screen.getByRole('region', { name: 'Second' }));
    fireEvent.change(second.getByRole('spinbutton'), { target: { value: '75' } });
    fireEvent.change(first.getByRole('spinbutton'), { target: { value: '65' } });
    fireEvent.click(first.getByRole('button', { name: 'Применить' }));
    await act(async () => {});
    expect(first.getByRole('spinbutton')).toHaveValue(65);
    expect(second.getByRole('spinbutton')).toHaveValue(75);
    expect(send).toHaveBeenCalledExactlyOnceWith(65);
    await act(async () => vi.advanceTimersByTime(PENDING_READING_TIMEOUT_MS));
    expect(first.getByRole('spinbutton')).toHaveValue(40);
    expect(second.getByRole('spinbutton')).toHaveValue(75);
    expect(screen.queryByText(pendingMessage)).not.toBeInTheDocument();
  });

  it('isolates connections, accounts, providers, devices, routes, and capabilities', () => {
    vi.useFakeTimers();
    const api = new HomeApi(connection);
    const another = new HomeApi(connection);
    const store = createAppStore();
    const scope = cloudPendingScope(api, 'sharing', '7');
    const target = pendingValueKey(scope, power.key);
    beginPendingValue(store.dispatch, target, true, known(false), false)();
    rotateCloudAccountScope(api, 'sharing');
    const unrelatedScopes = [
      cloudPendingScope(api, 'sharing', '7'),
      cloudPendingScope(api, 'developer', '7'),
      cloudPendingScope(api, 'sharing', '8'),
      cloudPendingScope(another, 'sharing', '7'),
      localPendingScope(api, 7),
    ];
    const { pendingDeviceValues } = store.getState();
    for (const unrelated of unrelatedScopes) expect(pendingDeviceValues[pendingValueKey(unrelated, power.key)]).toBeUndefined();
    expect(pendingDeviceValues[pendingValueKey(scope, brightness.key)]).toBeUndefined();
    expect(pendingDeviceValues[target]?.target?.value).toBe(true);
  });

  it('ignores a late acknowledgement after a newer command was already reported', () => {
    vi.useFakeTimers();
    const store = createAppStore();
    const key = pendingValueKey('device', brightness.key);
    const older = beginPendingValue(store.dispatch, key, 70, known(40), false);
    const newer = beginPendingValue(store.dispatch, key, 80, known(40), false);
    newer();
    const sequence = store.getState().pendingDeviceValues[key]!.sequence;
    store.dispatch(pendingReadingReported({ key, sequence }));
    older();
    expect(store.getState().pendingDeviceValues[key]).toEqual({ sequence });
    vi.advanceTimersByTime(PENDING_READING_TIMEOUT_MS);
    expect(store.getState().pendingDeviceValues[key]).toBeUndefined();
    older();
    expect(store.getState().pendingDeviceValues[key]).toBeUndefined();
  });
});

describe('privacy confirmation', () => {
  it('does not let a very late privacy acknowledgement revive a resolved gate', () => {
    vi.useFakeTimers();
    const store = createAppStore();
    const key = pendingValueKey('device', privacy.key);
    const older = beginPendingValue(store.dispatch, key, true, known(false), true);
    const newer = beginPendingValue(store.dispatch, key, false, known(true), true);
    newer();
    const sequence = store.getState().pendingDeviceValues[key]!.sequence;
    store.dispatch(pendingReadingReported({ key, sequence }));
    vi.advanceTimersByTime(PENDING_READING_TIMEOUT_MS + 1);
    older();
    expect(store.getState().pendingDeviceValues[key]).toEqual({ sequence, protectsPrivacy: true });
  });

  function FieldWithPlayback({ reading, now, send }: { reading: Reading; now: number; send: (value: unknown) => Promise<boolean> }) {
    const status = usePendingPrivacyState(defaultProps.pendingScope, reading.value === true);
    return <>
      <CapabilityField {...defaultProps} spec={privacy} now={now} reading={reading} onSend={send} />
      <button disabled={status !== false}>Watch video</button>
    </>;
  }

  it.each(['report', 'explicit live query'] as const)('keeps playback blocked after a timed-out reversal until a newer %s', async source => {
    vi.useFakeTimers();
    const now = Date.now();
    const send = vi.fn().mockResolvedValue(true);
    const reading = source === 'report' ? known(false, now - 1000) : known(false);
    const view = renderWithStore(<FieldWithPlayback reading={reading} now={now} send={send} />);
    const watch = screen.getByRole('button', { name: 'Watch video' });
    const toggle = screen.getByRole('switch', { name: 'Privacy' });
    expect(watch).toBeEnabled();
    fireEvent.click(toggle);
    await act(async () => {});
    expect(toggle).toBeChecked();
    expect(watch).toBeDisabled();
    fireEvent.click(toggle);
    await act(async () => {});
    expect(send.mock.calls).toEqual([[true], [false]]);
    expect(toggle).not.toBeChecked();
    expect(watch).toBeDisabled();
    await act(async () => vi.advanceTimersByTime(PENDING_READING_TIMEOUT_MS));
    expect(screen.queryByText(pendingMessage)).not.toBeInTheDocument();
    expect(watch).toBeDisabled();
    const newerAt = Date.now();
    const newer = source === 'report' ? known(false, newerAt) : { ...reading, liveRequestAt: newerAt };
    view.rerender(<FieldWithPlayback reading={newer} now={newerAt} send={send} />);
    expect(watch).toBeEnabled();
  });
});

it('acknowledges an old route command without writing its result into the new session', async () => {
  let accept!: () => void;
  const receipt = new Promise<{ text: string }>(resolve => { accept = () => resolve({ text: 'Accepted' }); });
  let finishLoading!: () => void;
  const loading = new Promise<string>(resolve => { finishLoading = () => resolve('new route'); });
  const first = vi.fn().mockResolvedValue('old route');
  const second = vi.fn().mockReturnValue(loading);
  const authError = vi.fn();
  const { result, rerender } = renderHook(({ load }) => useControlSession<string>(load, authError), { initialProps: { load: first } });
  await waitFor(() => expect(result.current.data).toBe('old route'));
  let command!: Promise<boolean>;
  act(() => { command = result.current.execute(() => receipt); });
  expect(result.current.busy).toBe(true);
  rerender({ load: second });
  await act(async () => { accept(); await expect(command).resolves.toBe(true); });
  expect(first).toHaveBeenCalledOnce();
  expect(result.current.busy).toBe(true);
  expect(result.current.notice.text).toBe('');
  await act(async () => { finishLoading(); });
  expect(result.current.data).toBe('new route');
  expect(result.current.busy).toBe(false);
});
