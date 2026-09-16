# nerve-sdk Publishing & Release Standards

Guidelines for versioning and publishing `@nervehq/sdk` to npm.

---

## 1. SemVer Discipline

- **Patch (0.1.X):** Bug fixes, documentation updates, dependency bumps.
- **Minor (0.X.0):** Non-breaking additions (new methods, optional request properties).
- **Major (X.0.0):** Breaking contract changes (renamed fields, removed parameters).

---

## 2. Release Steps

1. Verify tests and schema conformance: `npm run test && npm run check:schema`.
2. Compile dist output: `npm run build`.
3. Update version in `package.json` and document changes in `CHANGELOG.md`.
4. Publish with provenance:
   ```bash
   npm publish --access public --provenance
   ```
