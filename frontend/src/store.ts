import { configureStore, createSlice } from '@reduxjs/toolkit';
import type { PayloadAction } from '@reduxjs/toolkit';
import { useDispatch, useSelector } from 'react-redux';
import { localDeviceCache } from './local-device-cache';
import { pendingDeviceValuesReducer } from './pending-device-values';

type DashboardControlState = {
  detailsOpen: boolean;
  pendingCommands: Record<string, true | undefined>;
};

const initialState: DashboardControlState = { detailsOpen: false, pendingCommands: {} };
const commandKey = (deviceId: string) => 'device:' + deviceId;

const dashboardControls = createSlice({
  name: 'dashboardControls',
  initialState,
  reducers: {
    setDetailsOpen(state, action: PayloadAction<boolean>) {
      state.detailsOpen = action.payload;
    },
    setCommandPending(state, action: PayloadAction<{ deviceId: string; pending: boolean }>) {
      const key = commandKey(action.payload.deviceId);
      if (action.payload.pending) state.pendingCommands[key] = true;
      else delete state.pendingCommands[key];
    },
  },
});

export const { setDetailsOpen, setCommandPending } = dashboardControls.actions;

export function createAppStore() {
  return configureStore({
    reducer: {
      dashboardControls: dashboardControls.reducer,
      pendingDeviceValues: pendingDeviceValuesReducer,
      [localDeviceCache.reducerPath]: localDeviceCache.reducer,
    },
    middleware: defaults => defaults().concat(localDeviceCache.middleware),
    devTools: import.meta.env.DEV,
  });
}

type AppStore = ReturnType<typeof createAppStore>;
type RootState = ReturnType<AppStore['getState']>;
export type AppDispatch = AppStore['dispatch'];
export const useAppDispatch = useDispatch.withTypes<AppDispatch>();
export const useAppSelector = useSelector.withTypes<RootState>();

export const selectDashboardLocked = ({ dashboardControls }: RootState) =>
  dashboardControls.detailsOpen || Object.keys(dashboardControls.pendingCommands).length > 0;

export const selectCommandPending = ({ dashboardControls }: RootState, deviceId: string) =>
  dashboardControls.pendingCommands[commandKey(deviceId)] === true;
