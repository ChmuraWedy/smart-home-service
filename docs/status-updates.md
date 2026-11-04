# Device readings and status updates

A reported value, an HTTP snapshot, and a command acknowledgement are different kinds of evidence. The interface keeps their source and timestamp separate and never treats missing data as false or zero.

## Sharing reports

The backend uses the official Sharing SDK's MQTT reports. Reports are stored in SQLite with per-DP timestamps; a newer reading for one DP does not refresh another DP. The browser reads our cache every three seconds while the relevant view is visible. This is not a fresh Tuya HTTP request on every poll.

Definitions are fetched when a device needs them. A manual refresh requests a selected-device HTTP snapshot. Newer reports take priority over older snapshots. Opening or closing a card does not send a device command. Inventory subscription can continue receiving reports when details are closed; visible tiles read only their relevant saved data.

Late responses from cancelled views are ignored. Background reads preserve unsaved field edits and do not overwrite a newer manual refresh or command result. Hidden pages, off-screen tiles, and the list behind an open dialog stop their browser polling. Local and Developer control do not gain automatic cloud polling from this behavior.

## Local readings

Local list/detail views initially read the SQLite cache. Explicit refresh performs a TinyTuya read; commands are followed by a separate read. Selected room displays can also poll their configured devices through the collector. Observations older than the freshness threshold are marked stale rather than presented as newly measured.

Sleeping Zigbee sensors may not answer a LAN status request. Their old reading remains old, and an absent motion reading remains unknown. A timeout does not create a new observation.

## Applying changes

The full card keeps drafts until **Apply**, compares them with the initial values, and sends only changes. Power controls on main-screen tiles send immediately. A pending accepted target is distinguished from the observed value so an old cache response does not cause a misleading visual rollback.

ACK means the command was accepted, not that physical state changed. Read failure after ACK is shown separately from command rejection. The service does not automatically retry a command or switch its transport after a timeout.

The details view shows reading age and refresh actions. [Activity logs](device-activity.md) preserve received events and available snapshots; they do not reconstruct the complete Smart Life history.
