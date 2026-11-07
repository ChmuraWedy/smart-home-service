# Device readings and status updates

A reported value, an HTTP snapshot, and a command acknowledgement are different kinds of evidence. The interface keeps their source and timestamp separate and never treats missing data as false or zero.

## Sharing reports

The backend uses the official Sharing SDK's MQTT reports. Reports are stored in SQLite with per-DP timestamps. Visible dashboard cards read the server cache every four seconds. Those reads can schedule one shared inventory refresh per minute to recover changes missed by the event stream. An older report yields to a conflicting HTTP reading once the report is at least a minute old.

Definitions are fetched when a device needs them. Opening details or manually refreshing can request a selected-device HTTP snapshot. Newer reports take priority over older snapshots. Inventory subscriptions can continue receiving reports while details are closed. The Developer API route has no equivalent automatic report subscription; it retains explicit status refresh.

Late responses from cancelled views are ignored. Background cache reads preserve edits and do not overwrite a newer manual refresh or command result. Hidden pages, off-screen tiles, and the list behind open details stop their cache checks.

## Local readings

Visible local cards read the SQLite cache every four seconds and use `watch=true` to renew a ten-second collection lease. A shared background collector reads watched devices directly over the LAN every five seconds. Multiple browsers watching the same device share one watch. Leaving, hiding, or scrolling away stops lease renewal, so abandoned watches expire automatically.

The collector supports at most 64 watched devices and four concurrent reads, without a queued backlog or overlapping reads of one device. Slow devices can delay their next reading. Zigbee children use their saved gateway. Disabled or incomplete connections are skipped. Failed reads preserve existing observations and timestamps. Recent reports from commands, explicit reads, or room displays avoid an immediate duplicate background read.

One manual Refresh button per device card still requests a TinyTuya read immediately. Redundant per-value refresh icons are removed. Cache requests without `watch=true` remain passive. Selected room displays retain their separately configured collector. Observations older than the freshness threshold are marked stale rather than presented as newly measured. Sleeping Zigbee sensors may not answer LAN requests; an absent motion reading remains unknown.

## Sending changes

Switches send immediately. Other valid edits send automatically after a short pause (350 ms for sliders, color, and text); select changes send on the next task. Only changed values are included, and rapid edits are combined. Invalid fields are not sent and do not block unrelated valid edits. Wizards keep edits local until Done or Save, then send automatically. Cancellation keeps the previous settings. Destructive camera formatting still requires its own confirmation.

With automatic status updates active, commands do not trigger an extra immediate status request. An accepted target remains distinct from the observed value so an old cached reading does not cause a misleading visual rollback. A failed command is shown and is never automatically retried or sent through another transport.

On mobile, details occupy the full screen with a fixed header and a scrolling content pane. The page underneath cannot scroll or receive detail clicks. Nested dialogs restore scrolling only after the final dialog closes.

[Activity logs](device-activity.md) preserve received events and available snapshots; they do not reconstruct the complete Smart Life history.

## Passive IP announcements

A single always-running Tuya receiver maintains the [shared network announcement cache](packet-capture.md). This is separate from five-second status reads: announcements reveal an observed IP and protocol, not whether a light is on. Device cards read cached network details when their network section is expanded; no per-device listener Start/Stop action is needed.
