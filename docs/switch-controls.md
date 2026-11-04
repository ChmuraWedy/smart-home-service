# Switch channels, timers, and backlight

The switch card translates known parameters and their values without changing Tuya codes or command payloads.

| Tuya code | Meaning |
| --- | --- |
| `switch_N` | Independent channel power |
| `countdown_N` | Channel timer, in the unit declared by the device |
| `relay_status` | State to restore after electrical power is restored |
| `switch_backlight` | Switch button backlight |
| `switch_inching` | Automatic turn-off after switching on |

`relay_status` values such as `power_off`/`off`, `power_on`/`on`, and `last`/`memory` are shown as Off, On, and Restore previous state. They describe power restoration, rather than the relay's current state.

On the main screen, each real channel has its own power control. In details, existing alias tags sit below **Channel N**. The clock beside its label expands the corresponding timer below the channel. Power-on state, backlight, and inching are under **Additional settings**.

Tuya describes inching as automatically turning a switch off after a configured interval, for example one minute. The inspected device exposes it as a String DP without a documented string encoding. The UI explains its purpose without inventing the format. See [Tuya switch definitions](https://developer.tuya.com/en/docs/iot/smart-switch-product-function-definition?id=K9r7gh4lbe886).

## Channel aliases

Channel aliases are local labels in our database, shown as tags below the original channel heading. Add with **+** and edit inline with the pencil. They do not replace channel identifiers, timer names, DP mappings, or Smart Life's names. Storage is scoped by account and provider and does not require local inventory registration.

`PUT /api/v1/cloud/devices/{device_id}/channel-labels?provider=sharing` accepts:

```json
{"labels":{"switch_1":"Desk light","switch_2":null}}
```

A null removes the saved label. Function definitions can include `user_label`; the API field name is retained for compatibility, but this is an application alias, not proof of a name retrieved from Tuya. Unknown channels, empty/unprintable text, and labels over 120 characters are rejected. Saving an alias does not send a cloud command.

The inspected Sharing API exposes channel codes such as `switch_1` and `switch_2`, but did not expose user-defined Smart Life channel names. Existing application aliases are kept explicitly separate from that source data.
