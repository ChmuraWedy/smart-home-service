import { render } from '@testing-library/react';
import type { ReactElement } from 'react';
import { Provider } from 'react-redux';
import { createAppStore } from '../store';

export function renderWithStore(ui: ReactElement) {
  const store = createAppStore();
  return render(ui, { wrapper: ({ children }) => <Provider store={store}>{children}</Provider> });
}
