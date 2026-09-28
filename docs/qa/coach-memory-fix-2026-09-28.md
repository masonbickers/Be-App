# Coach memory fix — 28 September 2026

The running Render service uses `masonbickers/Be-App` and was pinned to commit `672952b71a19d99e0bd54974044b2f1e5d36bc46`; the canonical checkout points to `masonbickers/version1.0-app`. The remote API did not contain the newer memory endpoint, server retrieval or chat protocol. Local updates alone could not change its behaviour.

The focused release is based on that exact live commit, preserving email verification and existing integrations. It adds an authenticated `/coach-chat/memory` compatibility endpoint and server-owned memory loading for legacy chat requests. Explicit supported “remember…” commands return a receipt after the database transaction completes. Existing preferences are read by update and creation recency; disabled, archived and superseded facts are excluded, and the saved-preferences switch prevents reads and new saves. Memory is scoped to verified server identity.

Conversation history reaches the model as normal user/assistant turns instead of a topic-filtered system summary. A content budget preserves more short turns without exceeding the context limit. Equipment, dietary and timing constraints are matched by their relevant domains rather than requiring literal shared words. Injury context remains topic-relevant. The fallback transport receives the same conversation turns.

The canonical client also sends up to 200 retained messages on the legacy path. This client change needs an app build; the backend improvements work with existing clients' smaller supplied histories. No unrelated dirty-checkout work, package updates, Firestore rules/indexes, v2 flags or worker deployments are included. The release supports durable preferences and current-chat continuity, not full searchable recall of archived transcripts.

Verification: 95 canonical memory/chat tests passed. The production-based release passed 18 tests, including the actual HTTP route/model payload, explicit save, new-repository recall, correction, inactive/global-disabled memory and account isolation. The lost older-turn test failed against the original deployed source and passed after the patch. Focused ESLint has no errors (existing unused-code warnings remain); canonical `npm run design:check` passed. No visual styles changed.

Production rollout and authenticated account acceptance are recorded below once completed. Existing configured QA credentials belong to an unverified password account; verification enforcement is preserved. Synthetic Firestore fixtures do not prove successful live account transactions or model recall.

## Production result

Render deployed commit `d3494ec7af06f4cbce185b831420c7db1a814ec1` using the existing specific-commit flow. Its dashboard reports **Deploy succeeded | Live**, with the memory-fix title and source SHA; startup logs confirm Firebase initialisation and the API listening successfully. Deployment: `dep-dat89ko473hc73f56kng`. Draft PR: https://github.com/masonbickers/Be-App/pull/4. The existing main/verification branches were not merged or reset.

Live API health returned 200. The memory endpoint rejected signed-out and invalid-token requests with 401. Existing QA sign-in succeeded and matched the configured UID, but its account is still unverified; read-only chat returned 403 `EMAIL_VERIFICATION_REQUIRED`. No live memories were created or removed, and verification was not bypassed. Live save → new-chat recall must be confirmed with a verified account. Suggested acceptance: “Remember I only have dumbbells”, open a new chat, then “Give me a strength session”; follow with a corrected preference and inactive-memory check.

Deployment screenshot: `/private/tmp/coach-memory-deployed-20260928.png`. The local client change to the 200-message window is ready for the next app build; no TestFlight build was made for this backend fix.
