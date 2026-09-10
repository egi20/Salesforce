# Dependency security notes

`npm audit` is expected to report **2 high** findings, both from the same source. This file
records why they are accepted rather than fixed, so nobody has to re-derive it — and so a
future reader can tell an accepted risk from an overlooked one.

Re-check this file whenever `npm audit` reports something that is not listed here.

## Accepted

### `pptxgenjs` → `image-size` (high)

- **Advisories:** infinite loops in the ICNS parser, and in the JXL and HEIF parsers,
  reachable by parsing a crafted image.
- **No fix exists.** The vulnerable range is `<=2.0.2` and 2.0.2 is the latest published
  version. There is nothing to upgrade to.
- **Unreachable in this application.** `image-size` is only called when pptxgenjs is asked
  to embed an image. `utils/documents/summaryPptx.js` builds the deck entirely from shapes,
  text and tables — it never calls `addImage`, never passes a path, and never passes a
  `data:` URI. No image, crafted or otherwise, reaches the parser.
- **What would change this.** Adding any image to the deck — a client logo, a chart
  rendered as a PNG — makes the parser reachable. If that happens, the input must come from
  a trusted source (an asset we ship, or bytes sharp has already re-encoded), not from an
  upload. Update this file at the same time.

## Fixed, and why the fix is shaped the way it is

These are in `overrides` in `package.json`. Each one is deliberate:

| Override | Reason |
|---|---|
| `mysql2: ^3.24.4` | `express-mysql-session` pins `mysql2@3.10.2`, affected by the auth-plugin downgrade that leaks plaintext credentials (`<3.22.0`) and the compressed-protocol decompression bomb (`<=3.23.0`). That copy sits on the live session path, so it matters as much as our own. The direct dependency was raised to the same range because npm rejects an override that contradicts it. |
| `qs: ^6.16.0` | `express@4` pins `qs@6.15.3` (array-limit bypass, `isBuffer` DoS). `body-parser` already resolved 6.16.0, so without this the tree shipped both versions. |
| `uuid: ^11.1.0` | `exceljs` pulls `uuid@8`, which is missing a buffer bounds check in v3/v5/v6. Verified against the workbook tests after the bump. |
| `htmlparser2: ^9.1.0` | Not a vulnerability. v12 is ESM-only: Node 22 can `require()` it, our declared floor of Node 18 cannot, and neither can Jest. |

`sharp` was raised to `^0.35.4` as a direct dependency rather than an override — the
libvips and libheif CVEs are fixed there, and the upgrade crosses a minor version, so it
belongs in the visible dependency list. The image pipeline in `models/ImageBlob.js` was
re-checked afterwards, including that a non-image buffer still fails to decode, which is
what makes re-encoding the real upload sanitiser.

`multer` was raised to `^2.3.0`. npm audit does NOT flag 1.x, but the maintainers deprecation
notice states plainly that 1.x is impacted by vulnerabilities patched in 2.x — including an
unhandled exception on a malformed multipart request. Audit silence is not evidence of
safety, and this package sits directly on the path where a stranger supplies bytes. The API
surface used here (`memoryStorage`, `limits`, `fileFilter`, `single`) is unchanged across
the major, and `tests/integration/fileUpload.test.js` now exercises it over real HTTP:
allowed types, a MIME/extension mismatch, the size limit, a second file, and a malformed
body.

`uuid` and `cors` were removed outright. Both came from the reference implementation's
dependency list and nothing here ever required them. An unused dependency is still an
audit finding and still ships.

## What `npm audit` does not tell you

It reports on the dependency tree, not on this application. A high-severity advisory in
code no call path reaches is less urgent than a moderate one in the request path — which is
why `mysql2` was worth an override and `image-size` is not. Read the advisory, find the
call site, then decide.
