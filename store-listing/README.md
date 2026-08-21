# Store listing copy (34 languages)

One `<locale>.txt` per language. Each file holds two blocks:

- **EDGE SEARCH TERMS** — the 7 search terms for the Edge Partner Center
  "Search terms" field, which is per-language.
- **OVERVIEW** — the long description for the store listing's
  Overview/Description field.

These are **not** shipped inside the extension package. They are pasted
into the store dashboards by hand:

| Store | Where |
|---|---|
| Chrome Web Store | Developer Dashboard → item → Store listing → language selector → Description |
| Edge | Partner Center → Extension → Store listings → per-language → Description + Search terms |
| Firefox (AMO) | Developer Hub → Edit listing → Describe Add-on → translations |

The extension's own `name` and `description` are localized separately,
from `apps/extension/public/_locales/<locale>/messages.json`, and update
only when a new version is published.

Locale codes follow Chrome's `_locales` convention (underscore, e.g.
`pt_BR`, `zh_CN`), matching the `_locales` directories.
