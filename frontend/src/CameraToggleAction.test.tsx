import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { expect, it, vi } from 'vitest';
import CameraToggleAction from './components/CameraToggleAction';
import type { ControlSpec } from './controls';
import type { Reading } from './home-api';
import { MSG, t } from './i18n';
import { renderWithStore } from './test/render-with-store';

const spec: ControlSpec = {
  key: 'motion_switch', label: 'Motion detection', kind: 'boolean', readable: true, writable: true,
};

it('retains a pending camera setting until a newer device report confirms it', async () => {
  const at = new Date().toISOString();
  const reading: Reading = { value: false, known: true, stale: false, observed_at: at };
  const send = vi.fn(async () => true);
  const props = { pendingScope: 'camera-test', spec, reading, now: Date.now(), disabled: false, onSend: send };
  const view = renderWithStore(<CameraToggleAction {...props} />);
  const toggle = screen.getByRole('switch', { name: spec.label });
  await userEvent.setup().click(toggle);
  await waitFor(() => expect(send).toHaveBeenCalledWith(true));
  expect(toggle).toBeChecked();
  expect(screen.getByRole('status')).toHaveTextContent(t(MSG.WAITING_FOR_A_NEW_READING));
  view.rerender(<CameraToggleAction {...props} reading={{ ...reading }} />);
  expect(toggle).toBeChecked();
  view.rerender(<CameraToggleAction {...props} reading={{ ...reading, value: true, observed_at: new Date(Date.now() + 1000).toISOString() }} />);
  await waitFor(() => expect(screen.queryByRole('status')).toBeNull());
  expect(toggle).toBeChecked();
  expect(send).toHaveBeenCalledOnce();
});

it('does not offer an unknown camera reading as an editable off state', async () => {
  const send = vi.fn(async () => true);
  renderWithStore(<CameraToggleAction pendingScope="unknown-camera" spec={spec} reading={{ value: null, known: false, stale: false }} now={Date.now()} disabled={false} onSend={send} />);
  const toggle = screen.getByRole('switch', { name: spec.label });
  expect(toggle).toBeDisabled();
  expect(toggle).toHaveAttribute('title', `${spec.label}: ${t(MSG.NO_DATA)}`);
  await userEvent.setup().click(toggle);
  expect(send).not.toHaveBeenCalled();
});
