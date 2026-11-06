import { MSG, localizeMessages, t } from "./i18n";
import type { ControlSpec } from './controls';
import type { JsonValue } from './api';

// Tuya's standard camera DP names. Availability and writable ranges still come
// exclusively from the selected device's API definitions.
export const CAMERA_LABELS: Record<string, string> = localizeMessages({
  basic_private: MSG.PRIVACY_MODE, basic_nightvision: MSG.NIGHT_VISION,
  basic_flip: MSG.FLIP_IMAGE, basic_osd: MSG.VIDEO_TIMESTAMP,
  basic_anti_flicker: MSG.ANTI_FLICKER, basic_indicator: MSG.CAMERA_INDICATOR, basic_wdr: MSG.WIDE_DYNAMIC_RANGE,
  basic_shimmer: MSG.LOW_LIGHT_COLOR_IMAGE, basic_device_volume: MSG.CAMERA_VOLUME,
  motion_switch: MSG.MOTION_DETECTION, motion_sensitivity: MSG.MOTION_SENSITIVITY,
  humanoid_filter: MSG.HUMAN_DETECTION, motion_area_switch: MSG.LIMIT_DETECTION_AREA, motion_area: MSG.DETECTION_AREA,
  decibel_switch: MSG.SOUND_DETECTION, decibel_sensitivity: MSG.SOUND_SENSITIVITY, decibel_upload: MSG.SOUND_DETECTION_EVENT,
  siren_switch: MSG.SIREN, alarm_message: MSG.ALARM_MESSAGE, movement_detect_pic: MSG.MOTION_EVENT_MEDIA,
  record_switch: MSG.MEMORY_CARD_RECORDING, record_mode: MSG.RECORDING_MODE, record_loop: MSG.LOOP_RECORDING,
  sd_storge: MSG.MEMORY_CARD_CAPACITY, sd_status: MSG.MEMORY_CARD_STATUS,
  sd_format: MSG.FORMAT_MEMORY_CARD, sd_format_state: MSG.FORMATTING_STATUS,
});

// Numeric strings have different meanings for different DPs; never translate
// them globally or change the original command value.
export const CAMERA_OPTIONS: Record<string, Record<string, string>> = localizeMessages({
  basic_nightvision: { '0':MSG.AUTO, '1':MSG.OFF, '2':MSG.ON },
  basic_anti_flicker: { '0':MSG.OFF, '1':MSG.TEXT_50_HZ, '2':MSG.TEXT_60_HZ },
  motion_sensitivity: { '0':MSG.LOW, '1':MSG.MEDIUM, '2':MSG.HIGH },
  decibel_sensitivity: { '0':MSG.LOW, '1':MSG.HIGH },
  record_mode: { '1':MSG.EVENTS_ONLY, '2':MSG.CONTINUOUS },
});

export const CAMERA_HELP: Record<string, string> = localizeMessages({
  basic_private: MSG.CAMERA_HELP_BASIC_PRIVATE,
  basic_nightvision: MSG.CAMERA_HELP_BASIC_NIGHTVISION,
  basic_flip: MSG.CAMERA_HELP_BASIC_FLIP,
  basic_osd: MSG.CAMERA_HELP_BASIC_OSD,
  basic_anti_flicker: MSG.CAMERA_HELP_BASIC_ANTI_FLICKER,
  motion_switch: MSG.CAMERA_HELP_MOTION_SWITCH,
  motion_sensitivity: MSG.CAMERA_HELP_MOTION_SENSITIVITY,
  humanoid_filter: MSG.CAMERA_HELP_HUMANOID_FILTER,
  motion_area_switch: MSG.CAMERA_HELP_MOTION_AREA_SWITCH,
  motion_area: MSG.CAMERA_HELP_MOTION_AREA,
  decibel_switch: MSG.CAMERA_HELP_DECIBEL_SWITCH,
  decibel_sensitivity: MSG.CAMERA_HELP_DECIBEL_SENSITIVITY,
  siren_switch: MSG.CAMERA_HELP_SIREN_SWITCH,
  record_switch: MSG.CAMERA_HELP_RECORD_SWITCH,
  record_mode: MSG.CAMERA_HELP_RECORD_MODE,
  record_loop: MSG.CAMERA_HELP_RECORD_LOOP,
  sd_storge: MSG.CAMERA_HELP_SD_STORGE,
  sd_status: MSG.CAMERA_HELP_SD_STATUS,
  sd_format: MSG.CAMERA_HELP_SD_FORMAT,
  sd_format_state: MSG.CAMERA_HELP_SD_FORMAT_STATE,
});

export const CAMERA_QUICK_LABELS: Record<string, string> = localizeMessages({
  basic_private:MSG.PRIVACY, motion_switch:MSG.MOTION, decibel_switch:MSG.SOUND, siren_switch:MSG.SIREN,
});

const GROUPS = localizeMessages([
  { title:MSG.IMAGE_AND_SOUND, keys:['basic_private','basic_nightvision','basic_flip','basic_osd','basic_anti_flicker','basic_indicator','basic_wdr','basic_shimmer','basic_device_volume'] },
  { title:MSG.DETECTION_AND_ALERTS, keys:['motion_switch','motion_sensitivity','humanoid_filter','motion_area_switch','motion_area','decibel_switch','decibel_sensitivity','siren_switch'] },
  { title:MSG.RECORDING_AND_MEMORY_CARD, keys:['record_switch','record_mode','record_loop','sd_status','sd_storge','sd_format_state'] },
]);

export function cameraStorage(status:Record<string,JsonValue>) {
  // sd_status is a categorical code, not a scaled measurement. Interpret only
  // the documented raw codes; never infer a mounted card from record_switch.
  const labels:Record<string,string>={'1':t(MSG.MEMORY_CARD_READY),'2':t(MSG.MEMORY_CARD_ERROR),'3':t(MSG.NOT_ENOUGH_SPACE_ON_THE_CARD),'4':t(MSG.MEMORY_CARD_IS_BEING_FORMATTED),'5':t(MSG.MEMORY_CARD_NOT_INSERTED)};
  const code=typeof status.sd_status==='number' || typeof status.sd_status==='string' ? String(status.sd_status) : '';
  return {ready:code==='1',canFormat:['1','2','3'].includes(code),label:labels[code] || t(MSG.MEMORY_CARD_STATUS_UNKNOWN)};
}

export const isStorageSetting=(key:string)=>['record_switch','record_mode','record_loop','ipc_mute_record','sd_format'].includes(key);

export function cameraSettingsGroups(specs: ControlSpec[]) {
  const grouped = new Set(GROUPS.flatMap(group => group.keys));
  return {
    groups: GROUPS.map(group => ({title:group.title, specs:group.keys.flatMap(key => specs.filter(spec => spec.key === key))})).filter(group => group.specs.length),
    additional: specs.filter(spec => !grouped.has(spec.key)),
  };
}

export function cameraPrivacyBlock(value:boolean | null | undefined) {
  return value===true ? t(MSG.PRIVACY_MODE_IS_ON) : value===null ? t(MSG.CHECKING_PRIVACY_MODE) : undefined;
}
