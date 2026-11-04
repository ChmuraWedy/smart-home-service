# Device readings and status updates

A reported value, an HTTP snapshot, and a command acknowledgement are different kinds of evidence. The interface keeps their source and timestamp separate and never treats missing data as false or zero.

## Sharing reports

The backend uses the official Sharing SDK's MQTT reports. Reports are stored in SQLite with per-DP timestamps; a newer reading for one DP does not refresh another DP. The browser reads our cache once per second while the relevant view is visible. These checks do not issue fresh Tuya HTTP requests.

Definitions are fetched when a device needs them. Opening details or manually refreshing can request a selected-device HTTP snapshot. Newer reports take priority over older snapshots. Inventory subscriptions can continue receiving reports while details are closed. The Developer API route has no equivalent automatic report subscription; it retains explicit status refresh.

Late responses from cancelled views are ignored. Background cache reads preserve edits and do not overwrite a newer manual refresh or command result. Hidden pages, off-screen tiles, and the list behind open details stop their cache checks.

## Local readings

Local views read the SQLite cache once per second. Visible local cards add `watch=true` to the existing state request; this only renews a three-second collection lease and does not perform LAN I/O in the HTTP request. A shared background collector reads watched devices every five seconds. Multiple browsers watching the same device share one watch. Leaving, hiding, or scrolling away stops lease renewal, so abandoned watches expire automatically.

The collector supports at most 64 watched devices and four concurrent reads, without a queued backlog or overlapping reads of one device. Slow devices can delay their next reading. Zigbee children use their saved gateway. Disabled or incomplete connections are skipped. Failed reads preserve existing observations and timestamps. Recent reports from commands, explicit reads, or room displays avoid an immediate duplicate background read.

Explicit Refresh still requests a TinyTuya read immediately. Cache requests without `watch=true` remain passive. Selected room displays retain their separately configured collector. Observations older than the freshness threshold are marked stale rather than presented as newly measured. Sleeping Zigbee sensors may not answer LAN requests; an absent motion reading remains unknown.

## Sending changes

Switches send immediately. Other valid edits send automatically after a short pause (350 ms for sliders, color, and text); select changes send on the next task. Only changed values are included, and rapid edits are combined. Invalid fields are not sent and do not block unrelated valid edits. Wizards keep edits local until Done or Save, then send automatically. Cancellation keeps the previous settings. Destructive camera formatting still requires its own confirmation.

With automatic status updates active, commands do not trigger an extra immediate status request. An accepted target remains distinct from the observed value so an old cached reading does not cause a misleading visual rollback. A failed command is shown and is never automatically retried or sent through another transport.

On mobile, details occupy the full screen with a fixed header and a scrolling content pane. The page underneath cannot scroll or receive detail clicks. Nested dialogs restore scrolling only after the final dialog closes.

[Activity logs](device-activity.md) preserve received events and available snapshots; they do not reconstruct the complete Smart Life history.
