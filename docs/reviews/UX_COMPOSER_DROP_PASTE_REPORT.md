# R22 composer drop and paste

## Root cause

At `25035da`, the textarea and model row were inside `#drop`. In a reduced Chromium reproduction with the old drag listeners, the textarea bubbled the file drop to the wrapper. A file dropped in the conversation reached the document's navigation guard without reaching the upload listener. The only feedback was a dashed outline on the wrapper, which could clear on a drag leave between child controls. Existing Chromium tests dispatched file drops directly to the wrapper.

The textarea had no paste handler. Clipboard files and bitmaps therefore never entered the upload path. PNG and JPEG were already allowed, while GIF and WebP were excluded by the picker, upload service and preview. The owner's original pointer position, file type and attachment-button state were unavailable.

## Changes

- The visible chat section accepts file drops across the conversation and composer. The composer and message area highlight together, with the release hint in Traditional Chinese and English. The browser handles text-only drags and pastes normally.
- Clipboard files and file items enter the same upload queue as the attachment button. Mixed pastes also replace the current text selection or insert at the caret. Images without a name use a localized prefix, local date and time, and the appropriate extension. Chromium can report a nameless bitmap as `image.png`. The handler treats `image.<extension>` as a generated name for the supported image types, so a copied file with the same generic name also receives a timestamp.
- PNG, JPEG, GIF and WebP use the existing attachment validation, storage, media and right-panel preview paths. Unsupported types show the localized server error. The existing status region announces counts for successful and failed uploads. Attachment availability, upload limits, auto-selection and classification continue through the existing controls and service.

## Chromium coverage

- Browser drag input drops a single file on the textarea, multiple files on the conversation, and plain text on the textarea. The tests check release hints in both languages and narrow viewport bounds.
- Synthetic clipboard events cover a PNG blob, a bitmap default filename, an item-only unnamed image, and a mixed paste with named GIF and WebP files and a rejected type. Checks cover localized names, insertion at the selection, auto-selection, classification and localized errors. Browser text input verifies the editor after a text-only paste event is allowed to follow its default path.
- Pasted PNG, GIF and WebP must decode in the right-panel preview. The suite retained every existing assertion, including the JPEG preview and i18n catalog parity checks.

[Synthetic drop hint at 390 px](../validation/gui/composer-drop-hint-zh-TW-narrow.png)

## Ordered gates

Each gate used a fresh temporary data directory. Test commands used the verification venv through process-local `PATH` and `OEP_PYTHON`. Dependencies were installed with `npm ci` and the pinned `.phase0/assets` and `.phase0/source` were copied from the main checkout. The hook installer initially rejected the inherited snapshot outside this worktree. Clearing the worktree's hook override allowed the installer to enable the checked-in hooks for this worktree.

| Gate | Exit | Observed result |
| --- | ---: | --- |
| `npm run lint` | 0 | 280 files checked (1.11 s) |
| `npm run typecheck` | 0 | TypeScript completed (5.39 s) |
| `npm test` | 0 | 103 passed, 0 failed, 0 skipped, including catalog parity (15.97 s) |
| `npm run build:release` | 0 | Windows x64 ZIP built and passed the release secret scan (17.30 s) |
| `npm run test:e2e:browser`, run 1 | 0 | Chromium passed, 0 orphans (116.07 s) |
| `npm run test:e2e:browser`, run 2 | 0 | Chromium passed, 0 orphans (122.37 s) |
| `npm run test:e2e:browser`, run 3 | 0 | Chromium passed, 0 orphans (121.88 s) |
| `npm run test:e2e:delegation` | 0 | 4 passed, 0 failed, 0 skipped (66.43 s) |
| `npm run scan` | 0 | 721 files scanned, 0 hits |

Release ZIP SHA-256 is `9dd6e144dae787b74e58f42dff0eb167bd02ee50b32bab6792fd822662e5a2e0`.

## Development runs

The first browser attempt stopped at the existing Traditional Chinese UI-text check for `#attachment-help`, which flagged the newly enumerated abbreviation `GIF`. The help text now uses the existing localized category for images and includes the paste instruction. The language assertion stayed in place.

The next attempt timed out waiting for the localized error after a mixed paste. The attachment upload alerted for the rejected type, then a conversation refresh replaced the alert with an older failed turn's message. The latest request error now stays visible through those refreshes. The browser test still requires the detailed error in both languages.

## Reviewer follow-up

The reviewer owns `npm run test:e2e:web`. Chromium used synthetic clipboards, so native Windows Explorer and Snipping Tool clipboard integration was outside this run.
