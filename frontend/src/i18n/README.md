# Interface localization

The UI supports English (`en`), Russian (`ru`), Polish (`pl`) and Belarusian (`be`). The language selector in the app menu
changes language without reloading React or resetting device drafts. The preference is
stored separately from API credentials in `smart-home.ui.language.v1` and shared
between open tabs of the same origin. First visit uses the first supported
browser language, with English as the fallback.

`en.json`, `ru.json`, `pl.json`, and `be.json` use the same named message keys.
Use `t(MSG.SHOW_STATE)` for text and accessible labels, and
`t(MSG.CHANNEL_TIMER, [channel])` for interpolated messages. `MSG` is derived
from the Russian catalog and TypeScript checks that every locale includes each key.
Keep a whole sentence together when its word order depends on the language.
Messages remain text; translations never render HTML.

`localizeMessages` resolves `MSG` values in presentation tables at lookup time.
When spreading an imported localized table into another
static table, spread `rawMessages(table)` so initialization does not capture the
startup language. Components still keep stable device/parameter keys.

`dateLocale()` selects the date/time locale. Numeric input parsing, units on the
wire, identifiers, device/room names, Unicode aliases, enum values, JSON/raw data,
and credentials retain their original values. `translateText` handles known
service errors and previously formatted notices. Unknown upstream and firmware
messages remain intact.

To add UI copy, update every catalog and call `t` at the presentation boundary.
Keep the same key when editing a translation. Tests
check named message usage, identical catalog keys, nonempty translations and matching
interpolation placeholders. The UI regression suite uses Russian explicitly;
localization tests exercise all supported languages, browser detection, persistence,
blocked storage, live changes, preserved drafts and unchanged command payloads.

To add a language, import its catalog into `catalogs`, extend `LANGUAGES` with its
native name and date locale, and add the same behavior checks. Locale validation,
browser detection and the selector use that registry. For incoming text, exact
Russian catalog matches take precedence over reverse lookups in the other languages. Language selection
must never change an API host, key, device identity, or command value.

## Screenshot examples

The [README localization examples](../../../README.md#localization-examples) show actual Polish bulb controls and Belarusian motion-sensor activity. These are captures of the running interface rather than translated image overlays. Device names and configured rooms remain unchanged; only interface presentation follows the chosen locale. All documentation prose remains in English.
