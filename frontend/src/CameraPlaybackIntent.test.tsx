import { act, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, expect, it, vi } from 'vitest';
import { CloudApi } from './api';
import { cameraPlaybackPreferenceKey, cameraPlaybackStopped, setCameraPlaybackStopped } from './camera-playback-preferences';
import { CameraLive } from './components/CameraLive';
import { MSG, t } from './i18n';

vi.mock('./camera-stream', async importOriginal => ({
  ...await importOriginal<typeof import('./camera-stream')>(),
  connectCameraWebRTC: vi.fn(() => vi.fn()),
}));

const connection = { baseUrl: 'http://api.test', token: 'test-key' };
const stream = (id = 'camera') => ({
  device_id: id, type: 'webrtc' as const,
  url: `http://media.test/play/native/${'a'.repeat(43)}/ws`,
});

beforeEach(() => {
  vi.spyOn(HTMLMediaElement.prototype, 'pause').mockImplementation(() => {});
  vi.spyOn(HTMLMediaElement.prototype, 'load').mockImplementation(() => {});
});

it('keeps explicit Stop across auto-start changes and remounts until Watch video is pressed', async () => {
  const api = new CloudApi(connection);
  const allocate = vi.spyOn(api, 'cameraStream').mockResolvedValue(stream());
  const props = { api, deviceId: 'camera', provider: 'sharing' as const, onAuthError: vi.fn(), autoStart: true };
  const view = render(<CameraLive {...props} />);
  await screen.findByLabelText(t(MSG.LIVE_CAMERA_VIDEO));
  await userEvent.setup().click(screen.getByRole('button', { name: t(MSG.STOP) }));
  expect(screen.queryByLabelText(t(MSG.LIVE_CAMERA_VIDEO))).toBeNull();
  view.rerender(<CameraLive {...props} autoStart={false} />);
  view.rerender(<CameraLive {...props} />);
  expect(allocate).toHaveBeenCalledOnce();
  view.unmount();
  render(<CameraLive {...props} />);
  expect(screen.getByRole('button', { name: t(MSG.WATCH_VIDEO) })).toBeEnabled();
  expect(allocate).toHaveBeenCalledOnce();
  await userEvent.setup().click(screen.getByRole('button', { name: t(MSG.WATCH_VIDEO) }));
  await screen.findByLabelText(t(MSG.LIVE_CAMERA_VIDEO));
  expect(allocate).toHaveBeenCalledTimes(2);
  expect(cameraPlaybackStopped(cameraPlaybackPreferenceKey(api.baseUrl, 'camera'))).toBe(false);
});

it('remembers Stop while stream allocation is still in flight', async () => {
  const api = new CloudApi(connection);
  let resolve!: (value: ReturnType<typeof stream>) => void;
  const allocate = vi.spyOn(api, 'cameraStream').mockReturnValue(new Promise(done => { resolve = done; }));
  const props = { api, deviceId: 'camera', provider: 'sharing' as const, onAuthError: vi.fn(), autoStart: true };
  const view = render(<CameraLive {...props} />);
  await userEvent.setup().click(await screen.findByRole('button', { name: t(MSG.STOP) }));
  await act(async () => resolve(stream()));
  view.unmount();
  render(<CameraLive {...props} />);
  expect(allocate).toHaveBeenCalledOnce();
  expect(screen.queryByLabelText(t(MSG.LIVE_CAMERA_VIDEO))).toBeNull();
});

it('shares Stop across cloud and local playback URLs for the same physical camera', async () => {
  const api = new CloudApi(connection);
  const allocate = vi.spyOn(api, 'cameraStream').mockResolvedValue(stream());
  const common = { api, provider: 'sharing' as const, playbackId: 'physical-camera', onAuthError: vi.fn(), autoStart: true };
  const view = render(<CameraLive {...common} deviceId="camera" />);
  await screen.findByLabelText(t(MSG.LIVE_CAMERA_VIDEO));
  await userEvent.setup().click(screen.getByRole('button', { name: t(MSG.STOP) }));
  view.unmount();
  render(<CameraLive {...common} deviceId="local-camera:module-id" />);
  expect(allocate).toHaveBeenCalledOnce();
  expect(screen.queryByLabelText(t(MSG.LIVE_CAMERA_VIDEO))).toBeNull();
});

it('does not save privacy cleanup as a manual Stop', async () => {
  const api = new CloudApi(connection);
  vi.spyOn(api, 'cameraStream').mockResolvedValue(stream());
  const props = { api, deviceId: 'camera', provider: 'sharing' as const, onAuthError: vi.fn(), autoStart: true };
  const view = render(<CameraLive {...props} />);
  await screen.findByLabelText(t(MSG.LIVE_CAMERA_VIDEO));
  view.rerender(<CameraLive {...props} viewingBlocked={t(MSG.PRIVACY_MODE_IS_ON)} />);
  await waitFor(() => expect(screen.queryByLabelText(t(MSG.LIVE_CAMERA_VIDEO))).toBeNull());
  expect(cameraPlaybackStopped(cameraPlaybackPreferenceKey(api.baseUrl, 'camera'))).toBe(false);
});

it('keeps Stop in memory when browser storage refuses writes', async () => {
  const api = new CloudApi(connection);
  const allocate = vi.spyOn(api, 'cameraStream').mockResolvedValue(stream());
  const props = { api, deviceId: 'camera', provider: 'sharing' as const, onAuthError: vi.fn(), autoStart: true };
  const first = render(<CameraLive {...props} />);
  await screen.findByLabelText(t(MSG.LIVE_CAMERA_VIDEO));
  const storage = vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => { throw new Error('Storage full'); });
  try {
    await userEvent.setup().click(screen.getByRole('button', { name: t(MSG.STOP) }));
    first.unmount();
    render(<CameraLive {...props} />);
    expect(screen.queryByLabelText(t(MSG.LIVE_CAMERA_VIDEO))).toBeNull();
    expect(allocate).toHaveBeenCalledOnce();
  } finally {
    storage.mockRestore();
    act(() => setCameraPlaybackStopped(cameraPlaybackPreferenceKey(api.baseUrl, 'camera'), false));
  }
});
