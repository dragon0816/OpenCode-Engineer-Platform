# OEP dictation and microphone access

Branch `ux/dictation-microphone` starts at `cb637fb` on `main`. The owner reviews and merges it locally.

## Root cause

OEP 0.6.0 went directly to `SpeechRecognition.start()`. Its error handler displayed the same microphone permission warning for `not-allowed` and `service-not-allowed`. A raw `audio-capture` would have used the generic retry message. The reported warning therefore identifies two possible browser errors and leaves the cause of either one open. The owner saw no prompt and both site lists were empty. That is evidence against a saved per-site block. It leaves open an early browser refusal, a missing audio input, or an unavailable speech service. [Web Speech API error codes](https://webaudio.github.io/web-speech-api/#speechrecognitionerrorevent)

The adapter serves a top-level `http://127.0.0.1:<port>` page with no `Permissions-Policy` response header. The default microphone allowlist is `self`. The existing CSP limits page connections to the local origin. Chromium handles speech service networking in its browser process. The launcher opens the pairing URL through the Windows default-browser association using `Start-Process` with no app-window or browser policy flags. Chromium confirmed that the actual OEP page was secure, top-level, and allowed to request microphone access. [Secure Contexts](https://www.w3.org/TR/secure-contexts/#is-origin-trustworthy) · [Media Capture and Streams Permissions Policy](https://www.w3.org/TR/mediacapture-streams/#permissions-policy-integration) · [Chromium network speech recognition engine](https://chromium.googlesource.com/chromium/src/+/refs/heads/main/content/browser/speech/network_speech_recognition_engine_impl.cc)

### Native Edge probe

Headless Edge `157.0.4341.60` ran in fresh profiles against an ephemeral loopback server using the adapter’s `secureHeaders`. The probe used the browser’s native APIs, a DevTools user gesture for recognition, and per-origin microphone permission overrides. External hostname resolution was blocked for the probe. `--use-fake-device-for-media-stream` supplied synthetic input for the device control. A second route added `Permissions-Policy: microphone=()` as the policy control.

| Scenario | Observed output |
| --- | --- |
| Fresh profile without a fake device | Secure context, microphone allowed by document policy, permission `prompt`, recognition constructor present. A direct speech start emitted `not-allowed`, and permission stayed `prompt`. |
| Microphone permission granted with no fake device | Zero audio inputs. `getUserMedia` rejected with `NotFoundError`. Native speech start still emitted `not-allowed`. |
| Fake device, microphone permission denied | `getUserMedia` rejected with `NotAllowedError`. |
| Fake device, microphone permission granted, OEP headers | `getUserMedia` returned an audio track and stopping it produced `audio:ended`. A separate native recognition start emitted `audio-capture`. |
| Fake device, origin granted, document microphone policy disabled | The document reported microphone policy `false`. `getUserMedia` rejected with `NotAllowedError` even though the origin override was still `granted`. |

The missing-input run reproduced the browser error that triggered the legacy warning while the browser still reported `prompt`. The extra denial under an explicit document policy and the successful fake-device capture under OEP’s headers distinguish a site policy block from the shipped page configuration. The browser tests exercise the separate `service-not-allowed` path with a mock. The owner’s raw error, physical inputs, and managed Edge profile remain unverified. The checked Windows user and machine Edge registry locations had no `SpeechRecognitionEnabled` or `AudioCaptureAllowed` values, including their recommended policy locations. A managed browser profile can have its own effective settings. [Edge speech recognition policy](https://learn.microsoft.com/en-us/deployedge/microsoft-edge-browser-policies/speechrecognitionenabled) · [Edge audio capture policy](https://learn.microsoft.com/en-us/deployedge/microsoft-edge-browser-policies/AudioCaptureAllowed)

The copied settings URLs also opened the exact loopback origin and showed a microphone setting in native Edge `157.0.4341.60` and Chrome `157.0.8103.52`. Edge redirected its `content/siteDetails` URL to the newer site permissions route and kept the encoded origin.

## Fix

- Start dictation with `getUserMedia({ audio: true })` so the browser can ask for site permission. Stop every temporary track before starting recognition. Permission denial, missing device, and unreadable device each have their own message. An audio capture failure tells the user to check that a microphone is connected and available. No speech gives a quiet retry hint. Network errors remain retryable.
- Permission denial opens a keyboard-accessible dialog in Traditional Chinese or English. It shows the current permission when the browser reports it, gives the Edge and Chrome address-bar steps, and copies the current origin’s settings URL. If clipboard access fails, it selects the URL for manual copying. Check again re-queries permission and retries capture.
- `service-not-allowed` explains that the browser speech service is unavailable and typing still works. The first failure disables the control for the current tab session, including reloads, and leaves a localized tooltip and accessible description. The recognizer still uses `zh-TW` as before.

## Owner checks

If OEP reports a blocked microphone, use the permission dialog for the exact current origin, including its port. If it reports no microphone or a capture problem, check whether Windows lists an input under **Settings → System → Sound → Input** and allows desktop apps to use the microphone under **Settings → Privacy & security → Microphone**. [Windows microphone privacy settings](https://support.microsoft.com/en-us/windows/privacy/windows-camera-microphone-and-privacy)

If capture works and OEP reports that the browser speech service is unavailable, open `edge://policy` in the same Edge profile and check `SpeechRecognitionEnabled`. If capture is blocked without a site prompt, also check `AudioCaptureAllowed` and any organization-managed site permissions. Ask IT whether Edge’s cloud recognition is permitted and reachable on the company network. Microsoft documents that this feature uses Azure Cognitive Services and sends voice data off the computer. Typing remains available under the existing policy. Reopen OEP in a fresh tab after a policy change to test again. [Edge speech recognition policy](https://learn.microsoft.com/en-us/deployedge/microsoft-edge-browser-policies/speechrecognitionenabled) · [Edge audio capture policy](https://learn.microsoft.com/en-us/deployedge/microsoft-edge-browser-policies/AudioCaptureAllowed)

## Assertions and verification

The original Chromium assertions for the exact transcript `合成語音`, the `not-allowed` permission hint, and the `network` retry hint moved into `verifyDictation` so they run with the new capture and dialog flow. The new assertions verify capture constraints and track cleanup, cancellation during a pending request, distinct browser and device errors, permission states, both settings URLs, clipboard fallback, retry, keyboard focus, narrow layout, both locales, and the speech service lockout across reloads. A focused run of these checks also passed in Chrome.

`npm ci` installed 14 packages and reported 0 vulnerabilities. The worktree uses copies of `.phase0/assets` and `.phase0/source` from the main checkout. The hook installer initially rejected an inherited snapshot from the main checkout. Its hook and scanner hashes matched the checked-in versions. Selecting `.githooks` in this worktree let the installer activate the hooks and set `merge.ff=false`.

The first ordered pass stopped at `npm test` with 103 passed and one catalog contract failure. The new error mappings stored raw catalog keys, which the existing static contract could not discover. The mappings now store localized message callbacks. The contract assertions stayed unchanged.

The first full browser run passed dictation and then failed in the existing Telegram channel assignment test. The test tried to read `#channel-save` just after reopening the dialog. The previous close event can still be pending and clear the newly opened content. The test now waits for the closed dialog’s content to clear before reopening it. The assignment, confirmation, and focus assertions remain in place.

Each gate used a fresh temporary `OEP_DATA_DIR` and process-local verification Python. The installed OEP and its data were outside the test runs.

### Ordered gates

Implementation and test revision `c72123d`.

| Gate | Exit | Elapsed | Observed result |
| --- | ---: | ---: | --- |
| `npm run lint` | 0 | 1.28 s | 284 source and configuration files checked |
| `npm run typecheck` | 0 | 6.15 s | TypeScript completed |
| `npm test` | 0 | 17.27 s | 104 passed, 0 failed, 0 skipped |
| `npm run build:release` | 0 | 19.49 s | Windows x64 ZIP built and passed the release scan |
| `npm run test:e2e:browser` run 1 | 0 | 134.98 s | Full Edge suite passed, 0 orphans |
| `npm run test:e2e:browser` run 2 | 0 | 135.53 s | Full Edge suite passed, 0 orphans |
| `npm run test:e2e:browser` run 3 | 0 | 135.02 s | Full Edge suite passed, 0 orphans |
| `npm run test:release:determinism` | 0 | 34.50 s | 1 passed. Both rebuilt ZIPs matched the release build. |
| `npm run scan` | 0 | 1.61 s | 739 files scanned, 0 hits |

The release ZIP SHA-256 was `511e33df3b6edaa7d08a5b09884c4097860780efb7018138cab2c63dfa98d8ae`.

`test:e2e:web` remains for the reviewer. An interactive test of the owner’s Edge permission prompt and a real speech transcription remain unverified.
