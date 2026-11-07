# Device aliases

[Interface guide](../frontend/README.md) · [Channel aliases](switch-controls.md)

In a full device card, the **Aliases** row appears below the device name. Use **+** to add an alias inline. Each tag has a pencil that opens an input within the same tag border. Save, delete, and cancel use accessible checkmark, trash, and close icons. Escape cancels editing. There is no separate alias management window.

Aliases persist across reopening and participate in device search. They do not replace the real device name or the separate channel aliases, and they do not rename anything in Smart Life.

Devices support up to 32 user aliases of 1–64 characters. The first character must be a Unicode letter; subsequent characters may include letters, combining marks, digits, spaces, periods, hyphens, and underscores. Text is normalized to NFC, trimmed, and lowercased. Russian, Belarusian, Polish, and other scripts are supported. A registered device's current name remains an automatic alias rather than an editable tag.

Local cards save through `PATCH /api/v1/devices/{id}`. Cloud cards use `GET` and `PUT /api/v1/cloud/devices/{tuya_id}/aliases?provider=sharing|developer`. A write body is `{"aliases":["desk_light"]}`; an empty list removes user aliases. Requests require the service key and validate the selected account. The device inventory includes aliases, avoiding an additional request per card.

Registered devices use the inventory alias store. Cloud-only devices use an account/provider-scoped store without inventing local device records. If the device is later registered, the cloud card merges the aliases and migrates them into inventory on the next save. Conflicting aliases return 409 while preserving existing tags.

Saving changes only aliases in this application's database. It does not send a device command or change network settings or keys.

Under **Name and alias translations** in device details, choose the name or an alias and enter its display text in English, Russian, Polish, or Belarusian. **Settings → Device names and aliases** chooses between originals and matching the app language in the current browser. A missing translation uses the original text. Dashboard search accepts either form.

Translations are saved separately from the original names and tags. Renamed or deleted aliases lose their previous translations. Local devices and cloud-only devices save through the corresponding `PUT .../translations` route, with `kind`, `original`, and `values` keyed by locale. An empty `values` object restores the original.
