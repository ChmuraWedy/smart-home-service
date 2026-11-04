# Interface localization

The UI supports English (`en`) and Russian (`ru`). The header selector changes
language without reloading React or resetting device drafts. The preference is
stored separately from API credentials in `smart-home.ui.language.v1` and shared
between open tabs of the same origin. First visit uses the first supported
browser language, with English as the fallback.

`en.json` maps source Russian message IDs to English. Russian uses the source
text, so its catalog cannot be incomplete. Use `t('message')` for text and
accessible labels, and `t('message {0}', [value])` for interpolated messages.
Keep a whole sentence together when its word order depends on the language.
Messages remain text; translations never render HTML.

`localizeMessages` makes static tables of labels/options/help text resolve at
lookup time. It is only for presentation tables, not device configuration or
command payloads. When spreading an imported localized table into another
static table, spread `rawMessages(table)` so initialization does not capture the
startup language. Components still keep stable device/parameter keys.

`dateLocale()` selects the date/time locale. Numeric input parsing, units on the
wire, identifiers, device/room names, Unicode aliases, enum values, JSON/raw data,
and credentials retain their original values. Known Russian service errors are
translated in the client; unknown upstream/firmware messages remain intact.

To add UI copy, update `en.json` and call `t` at the presentation boundary. Tests
check inline source-message coverage, nonempty English translations and matching
interpolation placeholders. The UI regression suite uses Russian explicitly;
localization tests also exercise English, browser detection, persistence,
blocked storage, live changes, preserved drafts and unchanged command payloads.

To add a language, extend `Locale`, language detection and the selector, supply
a catalog and date locale, and add the same behavior checks. Language selection
must never change an API host, key, device identity, or command value.
