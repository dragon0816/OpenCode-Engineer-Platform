# Phase 3G BI Knowledge plugin

## Extraction regression

The 0.8 attachment work changed the shared Web request helper to read `file.content`. BI extraction still passed a raw browser `File`. The helper received no request body, selected GET and omitted the CSRF header. The adapter never started conversion. The panel now passes the selected file's name, media type and bytes in the shared upload format. The Chromium test checks POST, CSRF, exact byte count and HTTP 202 before waiting for the original validation and review assertions.
