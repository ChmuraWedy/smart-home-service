#pragma once
// Copy to panel_config.h. Never commit actual Wi-Fi/API credentials.
#define WIFI_SSID "YOUR_WIFI"
#define WIFI_PASSWORD "YOUR_PASSWORD"
// LAN endpoint. Use the server's LAN IP, not 127.0.0.1.
#define API_BASE "http://192.168.1.10:8000/api/v1"
#define API_TOKEN "YOUR_API_TOKEN"
// Empty uses panel-<MAC>; can set a stable ASCII slug instead.
#define PANEL_ID "wall-panel"
#define PANEL_NAME "Панель комнаты"
#define DISPLAY_ROTATION 1
// Resistive factory calibration varies. Tune these or use a calibration sketch.
#define TOUCH_X_MIN 200
#define TOUCH_X_MAX 3900
#define TOUCH_Y_MIN 200
#define TOUCH_Y_MAX 3900
#define TOUCH_ROTATION 0
#define DISPLAY_INVERT 0
#define DISPLAY_RGB_ORDER 0
