# protocol/

The machine readable half of the Myrlin mobile v2 protocol: JSON Schemas for every request, response, stream frame and push payload, and golden test vectors for the signing format. The normative text is `docs/plans/PROTOCOL.md`; where a schema and that document disagree, the document wins and the schema is a bug. Workbook's Node tests and the app's Swift tests both use these files (BUILD-CONTRACT sections 3.5, 4.4 and 5), and a later Android client will too.

## Layout

```
protocol/
  README.md                this file
  schemas/                 JSON Schema draft 2020-12, one file per resource, the stream envelope, each event
  vectors/pairing.json     golden vectors for MSF-2 signing, ids, the match code, the manual code and the QR link
  tools/make-vectors.js    regenerates vectors/pairing.json with the TEST ONLY keys it embeds
  tools/verify-vectors.js  re-verifies every vector with a separate implementation (exit 0 when all pass)
```

## Conventions

- Draft 2020-12. Every file has `$id` `https://myrlin.io/protocol/v2/schemas/<path>` and refers to others by relative `$ref`, so a validator that loads the whole folder resolves every reference offline.
- Shared ids, encodings and enums live in `schemas/common/defs.json` (`$defs`).
- Request bodies have `additionalProperties: false`: the app must send only fields of the revision it speaks. Responses and events have `additionalProperties: true`: clients ignore fields they do not know (PROTOCOL.md 0.1). Workbook ignores unknown request fields at run time; the strict request schemas exist to catch app bugs in tests.
- Enums are strict in the schemas. The fallbacks PROTOCOL.md names for unknown values are client behaviour, not schema leniency.
- Keywords used, and the only ones a validator must support: `$schema`, `$id`, `$ref`, `$defs`, `title`, `description`, `type` (including type arrays), `properties`, `required`, `additionalProperties`, `enum`, `const`, `pattern`, `minLength`, `maxLength`, `minimum`, `maximum`, `items`, `prefixItems`, `minItems`, `maxItems`, `uniqueItems`, `minProperties`, `oneOf`, `anyOf`, `allOf`, `if`, `then`. No `format`, no `$dynamicRef`, no `unevaluatedProperties`, so a small validator suffices where a dependency is not allowed (BUILD-CONTRACT B1 writes one for Workbook's tests).
- Each stream event file (`schemas/stream/events/<type>.json`) validates the whole frame: the envelope of `schemas/stream/envelope.json` plus that event's `topic`, `type` and `data`.
- Names, ids and time units follow PROTOCOL.md section 0: camelCase fields, points in time as integer milliseconds named `ts` or `...AtMs`, binary values in base64url without padding.

## Golden vectors (`vectors/pairing.json`)

Every key in the file is marked `testOnly` and is public on purpose: never use it outside tests. The file holds, for each MSF-2 purpose (PROTOCOL.md 2.2), the typed fields, the exact signing input as UTF-8 text, as base64url and as a byte length, its SHA-256, and a real raw `r||s` signature; two negative vectors that must fail (a field changed after signing, and a key that is not the pinned one); the match code with its intermediate hash and 32 bit integer, plus the code a man in the middle would produce; the manual code with its alphabet and normalization cases; and both QR link forms with their parsed fields.

```
node protocol/tools/make-vectors.js     # rewrite vectors/pairing.json (signatures change, everything else must not)
node protocol/tools/verify-vectors.js   # expect "131/131 checks passed"
```

A Swift test (BUILD-CONTRACT I0) and a Workbook test (BUILD-CONTRACT B1) must each: rebuild every signing input from `fields` and match `signingInputB64u` byte for byte; verify every signature with the `verifyWith` key and get `expectValid`; derive `computerId` and `deviceId` from the SPKI; recompute the match code; parse both QR links. Both implementations must also sign their own input and have the other side's verifier accept it.

## Schema index

### `schemas/common/`

| File | Title | What it describes |
| - | - | - |
| `defs.json` | Shared definitions | Ids, encodings and enums shared by every mobile v2 schema. PROTOCOL.md sections 0 and 3. |
| `error.json` | Error | Every non 2xx body: {error, code} plus the extra fields PROTOCOL.md section 13 lists for that code. |

### `schemas/handshake/`

| File | Title | What it describes |
| - | - | - |
| `hello-request.json` | HelloRequest | POST /api/m/v2/hello (public). PROTOCOL.md 2.8. |
| `hello-response.json` | HelloResponse | Answer to POST /hello. Signed by K_c with purpose hello-response (workbookVersion is not signed). PROTOCOL.md 2.8. |
| `identity-response.json` | IdentityResponse | GET /api/m/v2/identity?nonce= (public). Signed with purpose identity. PROTOCOL.md 2.4 step 2. |
| `pair-challenge.json` | PairChallenge | 202 answer to POST /pair. Signed by K_c with purpose pair-challenge. PROTOCOL.md 2.4 step 3. |
| `pair-request.json` | PairRequest | POST /api/m/v2/pair (public). Signed by K_d with purpose pair-request. PROTOCOL.md 2.4 step 3. |
| `pair-status.json` | PairStatus | GET /api/m/v2/pair/:pairId?wait= (public). When allowed, signed by K_c with purpose pair-response. PROTOCOL.md 2.4 step 5. |
| `revoked.json` | RevokedResponse | 403 DEVICE_REVOKED from hello or session, signed by K_c with purpose revoked. The phone forgets the computer only when sig verifies. PROTOCOL.md 2.11. |
| `session-request.json` | SessionRequest | POST /api/m/v2/session (public). Signed by K_d with purpose session-request. PROTOCOL.md 2.8. |
| `session-response.json` | SessionResponse | Answer to POST /session: the 15 minute in memory token. PROTOCOL.md 2.8 and 2.9. |

### `schemas/resources/`

| File | Title | What it describes |
| - | - | - |
| `browse.json` | BrowseResult | GET /api/m/v2/browse?path=. PROTOCOL.md 4.2. |
| `computer.json` | Computer | GET /api/m/v2/computer. PROTOCOL.md 3.2. |
| `device-patch.json` | DevicePatch | PATCH /api/m/v2/devices/me. PROTOCOL.md 4.3.2. |
| `device.json` | Device | This phone as the computer knows it. GET /api/m/v2/devices/me. PROTOCOL.md 3.3. |
| `live-activity-token.json` | LiveActivityToken | PUT /api/m/v2/devices/me/live-activities/:activityId. PROTOCOL.md 4.3.3. |
| `preferences-patch.json` | PreferencesPatch | PATCH /api/m/v2/devices/me/preferences: any subset, nested merge, no nulls. PROTOCOL.md 4.3.4. |
| `preferences.json` | Preferences | GET and PATCH answer of /api/m/v2/devices/me/preferences. PROTOCOL.md 3.3. |
| `push-registration.json` | PushRegistration | PUT /api/m/v2/devices/me/push. PROTOCOL.md 4.3.3. |

### `schemas/sessions/`

| File | Title | What it describes |
| - | - | - |
| `answer-request.json` | AnswerRequest | POST .../prompts/:promptId/answer. Per kind rules are in PROTOCOL.md 4.4.7; exactly one of dismiss, decision, optionIndex, answers is used. |
| `answer-result.json` | AnswerResult | 200 answer of POST .../answer. PROTOCOL.md 4.4.7. |
| `attachment-ref.json` | AttachmentRef | An upload attached to a phone sent message. PROTOCOL.md 3.6. |
| `branch-request.json` | BranchRequest | POST /api/m/v2/sessions/:sessionId/branch: a native same provider fork, answered with NewSessionResult. PROTOCOL.md 4.5.8. |
| `client-request.json` | ClientRequest | Body of interrupt and stop: only a clientRequestId. PROTOCOL.md 4.4.6 and 4.5.5. |
| `commands.json` | CommandList | GET /api/m/v2/sessions/:sessionId/commands: the composer's slash commands. PROTOCOL.md 4.4.8. |
| `continue-here-request.json` | ContinueHereRequest | POST /api/m/v2/sessions/:sessionId/continue-here. PROTOCOL.md 4.5.7. |
| `interrupt-result.json` | InterruptResult | Answer of POST .../interrupt. PROTOCOL.md 4.4.6 and 7.5. |
| `lineage.json` | Lineage | Migration links of a session. PROTOCOL.md 3.4.7. |
| `message-page.json` | MessagePage | GET /api/m/v2/sessions/:sessionId/messages. PROTOCOL.md 4.4.3. |
| `message.json` | Message | One message with typed parts and a stable id. PROTOCOL.md 3.6. |
| `new-session-request.json` | NewSessionRequest | POST /api/m/v2/sessions: launch without a socket. PROTOCOL.md 4.5.6. |
| `new-session-result.json` | NewSessionResult | 201 answer of POST /sessions, of continue-here and of branch (send is then absent or null). PROTOCOL.md 4.5.6 to 4.5.8. |
| `part-text.json` | PartText | GET .../messages/:messageId/parts/:partIndex/text. PROTOCOL.md 4.4.4. |
| `part.json` | Part | One typed part of a message. PROTOCOL.md 3.6. |
| `prompt.json` | Prompt | An open TUI dialog read from the VT screen. PROTOCOL.md 3.7 and 8. |
| `prompts.json` | PromptList | GET /api/m/v2/sessions/:sessionId/prompts. PROTOCOL.md 4.4.7. |
| `recent-sessions.json` | RecentSessions | GET /api/m/v2/sessions/recent (snapshot of topic sessions). PROTOCOL.md 4.4.1. |
| `restart-request.json` | RestartRequest | POST /api/m/v2/sessions/:sessionId/restart. PROTOCOL.md 4.5.4. |
| `resume-anyway-request.json` | ResumeAnywayRequest | POST /api/m/v2/sessions/:sessionId/resume-anyway. PROTOCOL.md 4.5.7. |
| `send-record.json` | SendRecord | One phone send and its lifecycle; also the data of send.update. PROTOCOL.md 3.8 and 7. |
| `send-request.json` | SendRequest | POST /api/m/v2/sessions/:sessionId/send; also the message of a new session. PROTOCOL.md 4.4.5. |
| `sends.json` | SendList | GET /api/m/v2/sessions/:sessionId/sends. PROTOCOL.md 4.4.5. |
| `session-detail.json` | SessionDetail | GET /api/m/v2/sessions/:sessionId (snapshot of topic session:<id>). PROTOCOL.md 4.4.2. |
| `session-meta.json` | SessionMeta | Full description of one session; also the data of session.meta. PROTOCOL.md 3.4.4. |
| `session-patch.json` | SessionPatch | PATCH /api/m/v2/sessions/:sessionId: rename, pin, archive. PROTOCOL.md 4.5.1. |
| `session-settings-patch.json` | SessionSettingsPatch | PATCH /api/m/v2/sessions/:sessionId/settings: only keys to change; null resets. PROTOCOL.md 4.5.3. |
| `session-settings.json` | SessionSettings | GET and PATCH answer of /api/m/v2/sessions/:sessionId/settings. PROTOCOL.md 4.5.3. |
| `session-state.json` | SessionState | Turn state of one session; also the data of session.state. PROTOCOL.md 3.4.5 and 6. |
| `session-summary.json` | SessionSummary | One conversation in lists, the tree and search. PROTOCOL.md 3.4.3. |
| `settings-schema.json` | SettingsSchema | GET /api/m/v2/providers/:provider/settings-schema. PROTOCOL.md 4.5.3. |
| `status-result.json` | StatusResult | Answer of restart (202) and stop (200). PROTOCOL.md 4.5.4 and 4.5.5. |
| `turn.json` | Turn | A turn; also the data of turn.start and turn.end. PROTOCOL.md 3.5 and 6. |

### `schemas/workspace/`

| File | Title | What it describes |
| - | - | - |
| `folder-node.json` | FolderNode | A Workbook project folder (workspace group). PROTOCOL.md 4.6. |
| `name-patch.json` | NamePatch | PATCH /api/m/v2/projects/:projectId and /folders/:folderId. PROTOCOL.md 4.5.2. |
| `project-node.json` | ProjectNode | A Workbook project (workspace) or the synthetic unassigned project. PROTOCOL.md 4.6. |
| `tabs-patch-result.json` | TabsPatchResult | 200 answer of PATCH /tabs. PROTOCOL.md 4.8. |
| `tabs-patch.json` | TabsPatch | PATCH /api/m/v2/tabs: 1 to 50 intent operations applied in order, all or nothing. PROTOCOL.md 4.8. |
| `tabs-response.json` | TabsResponse | GET /api/m/v2/tabs (snapshot of topic tabs). PROTOCOL.md 4.8. |
| `tabs.json` | TabsState | The desktop tab groups as the phone sees them. PROTOCOL.md 3.9. |
| `tree-project.json` | TreeProject | GET /api/m/v2/tree/projects/:projectId. PROTOCOL.md 4.6. |
| `tree.json` | Tree | GET /api/m/v2/tree (snapshot of topic sessions). PROTOCOL.md 4.6. |

### `schemas/search/`

| File | Title | What it describes |
| - | - | - |
| `search-messages.json` | MessageSearchResult | GET /api/m/v2/search/messages, with coverage (A15). PROTOCOL.md 4.9.2. |
| `search-names.json` | NameSearchResult | GET /api/m/v2/search/names. PROTOCOL.md 4.9.1. |

### `schemas/media/`

| File | Title | What it describes |
| - | - | - |
| `upload-chunk-result.json` | UploadChunkResult | Answer of PUT /uploads/:uploadId/chunks?offset=. PROTOCOL.md 4.10. |
| `upload-complete.json` | UploadComplete | POST /api/m/v2/uploads/:uploadId/complete. PROTOCOL.md 4.10. |
| `upload-create.json` | UploadCreate | POST /api/m/v2/uploads. PROTOCOL.md 4.10. |
| `upload.json` | Upload | An upload; also the data of upload.progress. PROTOCOL.md 3.10 and 4.10. |

### `schemas/accounts/`

| File | Title | What it describes |
| - | - | - |
| `account.json` | Account | One Claude or Codex account with Glass usage windows. PROTOCOL.md 3.11. |
| `accounts-response.json` | AccountsResponse | GET /api/m/v2/accounts (snapshot of topic accounts). PROTOCOL.md 4.11. |
| `accounts.json` | AccountsSnapshot | Glass parity accounts snapshot (A10); also the data of accounts.updated. PROTOCOL.md 3.11. |
| `label-request.json` | LabelRequest | PUT /api/m/v2/accounts/:provider/:accountId/label. PROTOCOL.md 4.11. |
| `login-flow.json` | LoginFlow | A Glass isolated sign in on the computer. PROTOCOL.md 4.11. |
| `login-request.json` | LoginRequest | POST /api/m/v2/accounts/login. PROTOCOL.md 4.11. |
| `refresh-request.json` | AccountsRefreshRequest | POST /api/m/v2/accounts/refresh. PROTOCOL.md 4.11. |
| `refresh-result.json` | AccountsRefreshResult | 202 answer of POST /accounts/refresh. PROTOCOL.md 4.11. |
| `swap-request.json` | SwapRequest | POST /api/m/v2/accounts/swap. PROTOCOL.md 4.11. |
| `swap-result.json` | SwapResult | 200 answer of POST /accounts/swap. PROTOCOL.md 4.11. |

### `schemas/migrate/`

| File | Title | What it describes |
| - | - | - |
| `migration-approve-request.json` | MigrationApproveRequest | POST /api/m/v2/migrations/:migrationId/approve. PROTOCOL.md 4.12.4. |
| `migration-preview-request.json` | MigrationPreviewRequest | POST /api/m/v2/sessions/:sessionId/migrations/preview. PROTOCOL.md 4.12.1. |
| `migration-preview.json` | MigrationPreview | Answer of the preview route. PROTOCOL.md 4.12.1. |
| `migration-report.json` | MigrationReport | GET /api/m/v2/migrations/:migrationId/report. PROTOCOL.md 4.12.6. |
| `migration-retry-request.json` | MigrationRetryRequest | POST /api/m/v2/migrations/:migrationId/retry. PROTOCOL.md 4.12.4. |
| `migration-start-request.json` | MigrationStartRequest | POST /api/m/v2/sessions/:sessionId/migrations (Idempotency-Key header required). PROTOCOL.md 4.12.2. |
| `migration-turn.json` | MigrationTurn | GET /api/m/v2/migrations/:migrationId/turns/:turnNumber. PROTOCOL.md 4.12.7. |
| `migration.json` | MigrationSnapshot | A migration; also the data of migration.progress. PROTOCOL.md 3.12. |
| `migrations-list.json` | MigrationList | GET /api/m/v2/migrations (snapshot of topic migrations). PROTOCOL.md 4.12.3. |
| `report-header.json` | ReportHeader | The takeover report JSON header, camelCased by Workbook (A20, F15). PROTOCOL.md 4.12.6. |

### `schemas/admin/`

| File | Title | What it describes |
| - | - | - |
| `admin-device-patch.json` | AdminDevicePatch | PATCH /api/mobile-admin/devices/:deviceId. PROTOCOL.md 11.4. |
| `admin-device.json` | AdminDevice | A paired phone as the desktop Devices tab shows it. PROTOCOL.md 11.4. |
| `admin-devices.json` | AdminDeviceList | GET /api/mobile-admin/devices. PROTOCOL.md 11.4. |
| `allow-request.json` | AllowRequest | POST /api/mobile-admin/pair-requests/:pairId/allow. PROTOCOL.md 2.6 and 11.3. |
| `apns-config.json` | ApnsConfig | PUT /api/mobile-admin/apns. The p8 text is stored as a 0600 file and never returned. PROTOCOL.md 10.1 and 11.2. |
| `audit.json` | AuditList | GET /api/mobile-admin/devices/:deviceId/audit. PROTOCOL.md 11.4. |
| `pair-offer.json` | PairOffer | 201 answer of POST /api/mobile-admin/pair-offers. PROTOCOL.md 11.3. |
| `pair-request-summary.json` | PairRequestSummary | A pending pair shown in the desktop Allow dialog; also the data of the mobile:pair-request SSE event. PROTOCOL.md 11.3. |
| `pair-requests.json` | PairRequestList | GET /api/mobile-admin/pair-requests. PROTOCOL.md 11.3. |
| `settings-update.json` | AdminSettingsUpdate | PUT /api/mobile-admin/settings. PROTOCOL.md 1.4 and 11.1. |
| `status.json` | AdminStatus | GET /api/mobile-admin/status (main server, desktop auth). PROTOCOL.md 11.1. |
| `test-push-result.json` | TestPushResult | Answer of POST /api/mobile-admin/devices/:deviceId/test-push. PROTOCOL.md 11.4. |

### `schemas/push/`

| File | Title | What it describes |
| - | - | - |
| `alert-payload.json` | AlertPayload | The APNs payload Workbook sends. Keys inside aps are Apple's spelling; m is Myrlin's. PROTOCOL.md 10.3. |

### `schemas/stream/`

| File | Title | What it describes |
| - | - | - |
| `client-command.json` | ClientCommand | Every client frame on /ws/m/v2. PROTOCOL.md 5.3. |
| `control.json` | ControlFrame | Server control frames (topic $control, seq 0). PROTOCOL.md 5.3. |
| `envelope.json` | StreamEnvelope | Every server frame on /ws/m/v2: events and $control frames. PROTOCOL.md 5.3. |
| `notice.json` | Notice | A computer notice; the data of computer.notice carries it. PROTOCOL.md 3.13. |

### `schemas/stream/events/`

| File | Title | What it describes |
| - | - | - |
| `accounts.updated.json` | Event accounts.updated | The accounts.updated event with its envelope. PROTOCOL.md 5.4 and 4.11. |
| `computer.notice.json` | Event computer.notice | The computer.notice event with its envelope. PROTOCOL.md 5.4 and 3.13. |
| `message.add.json` | Event message.add | The message.add event with its envelope. PROTOCOL.md 5.4. |
| `message.update.json` | Event message.update | The message.update event with its envelope. PROTOCOL.md 5.4 and 7.3. |
| `migration.progress.json` | Event migration.progress | The migration.progress event with its envelope. PROTOCOL.md 5.4 and 4.12.5. |
| `prompt.open.json` | Event prompt.open | The prompt.open event with its envelope. PROTOCOL.md 5.4 and 8. |
| `prompt.resolved.json` | Event prompt.resolved | The prompt.resolved event with its envelope. PROTOCOL.md 5.4 and 8.4. |
| `send.update.json` | Event send.update | The send.update event with its envelope. PROTOCOL.md 5.4 and 7.4. |
| `session.meta.json` | Event session.meta | The session.meta event with its envelope. PROTOCOL.md 5.4 and 3.4.4. |
| `session.state.json` | Event session.state | The session.state event with its envelope. PROTOCOL.md 5.4 and 6. |
| `sessions.changed.json` | Event sessions.changed | The sessions.changed event with its envelope. PROTOCOL.md 5.4. |
| `tabs.updated.json` | Event tabs.updated | The tabs.updated event with its envelope. PROTOCOL.md 5.4 and 4.8. |
| `tool.end.json` | Event tool.end | The tool.end event with its envelope. PROTOCOL.md 5.4. |
| `tool.start.json` | Event tool.start | The tool.start event with its envelope. PROTOCOL.md 5.4. |
| `turn.end.json` | Event turn.end | The turn.end event with its envelope. PROTOCOL.md 5.4 and 6. |
| `turn.start.json` | Event turn.start | The turn.start event with its envelope. PROTOCOL.md 5.4 and 6. |
| `upload.progress.json` | Event upload.progress | The upload.progress event with its envelope. PROTOCOL.md 5.4 and 4.10. |
