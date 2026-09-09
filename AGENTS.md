# README maintenance

After a product change affecting a user-visible feature, behavior, supported setting/default, installation, or compatibility, review `README.md` and `README.en.md` and update the affected sections in the same change before finishing. A purely internal refactor or a change to one user’s local settings/data does not require a README edit. A fix that restores already-documented behavior needs a consistency check, not another feature paragraph.

Write for users deciding whether to install the plugin and learning how to use it:

- Cover current benefits, how to use the feature, defaults that affect use, and important limits or actions the user needs to take.
- Keep the Chinese and English versions consistent. Rewrite or remove outdated statements instead of appending a running change log.
- Keep implementation details out of the README: internal field names, RPC methods, database/storage schemas, algorithms, request-count calculations, debugging history, and test counts belong in focused developer or troubleshooting docs when needed.
- Installation commands and prerequisites that users actually need may remain, preferably in a short optional section. Link to deeper guidance rather than repeating it.
- Describe estimates and external forecasts accurately; do not turn incomplete evidence into a promised capability.
- Preserve existing useful media. Public documentation and tests must not include real private task IDs, account values, access URLs, or unreviewed screenshots; use clearly synthetic examples.

Before publishing documentation, check feature claims against the current implementation, verify local links/media paths, and confirm that both READMEs explain the same behavior. Do not expand documentation for changes that users do not need to know about.
