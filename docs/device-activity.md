# Activity logs and compact device cards

Each device has a persistent SQLite activity log, separated by Tuya account/provider or local transport. Reads require the service key and ownership validation.

```text
GET /api/v1/activity/devices/{id}?provider=sharing|developer|local&limit=50&before=...
```

Cloud routes use the Tuya ID; local routes use the inventory record ID. Events are newest first with a `next_before` cursor. Up to 2,000 events are retained per device and source.

## Motion sensors

A motion sensor's activity log is open in the main details area. Its **Motion** filter shows actual motion events and saved motion snapshots. Temperature sensors do not get a motion filter simply because they have a log. The current state remains a separate sensor reading; missing data is not interpreted as no motion.

While the log is open, the browser reads it every three seconds from our database. Closing it or hiding the page stops this polling. The log does not start new LAN polls just to build history.

## Event meaning

Sharing records received device reports, including repeated motion with a different event timestamp. Duplicate delivery and out-of-order reports do not create misleading new events. Device time is used when available, with reception time available separately.

Saved snapshots are labeled and recorded on first observation or a changed value. They do not overwrite newer real reports. Developer records available snapshots and commands; local transport records normalized reads and commands, including display collector reads. Earlier Smart Life history is not recovered.

Command requests and outcomes are separate events. ACK is acceptance rather than confirmation. Rejection and unknown outcomes remain distinct. Tokens, local keys, private nested fields, and large compound payloads are excluded or summarized. Alias edits and manual device mappings are not part of this command/reading journal.

## Cards and navigation

Main cards show the available power channels, compact sensor icons/values, aliases, room, online state, and battery. Unknown battery is not guessed; units and scaling come from known metadata. A raw legacy battery number without a unit is not automatically labeled as a percentage.

Tile switches send an immediate single command through the selected route. Details also send edits automatically; sliders and text wait briefly for editing to stop. Modes, brightness, colors, schedules, and timers live in details. Channel aliases are tags beneath their source labels.

Cards have a minimum width of 340px when space allows and fit mobile screens without horizontal scrolling. Details close with an accessible 44px icon. Connection information explains the room, physical link, selected command route, and online state. A direct physical connection can still be controlled through the Smart Life cloud.

Visible Sharing tiles read cached reports; off-screen tiles and tiles behind dialogs stop updating. Device icons follow category/known capabilities, not guessed names. Previously deferred devices can resume setup through their configuration action.
