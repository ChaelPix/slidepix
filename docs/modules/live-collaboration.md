# Live collaboration

Package: `slidepix` (`src/live/`)

Purpose: let several people edit one deck at the same time without a SlidePix server. The host's file stays the only saved document.

## Open this module when

Changing invitations, peer connection, live merge, guest files, or presence.

## Ownership

The host extension owns the deck file and the order of accepted edits. Guests edit a `slidepix-live:` document backed by a mirror. `@slidepix/core` owns `mergeDecksLive`. The webview only sends presence and normal document edits.

## Behavior

**Share** copies `slidepix-live:1:<ticket>.<secret>` and shows the host fingerprint. **Join** accepts that string or a `cursor://` / `vscode://slidepix.slidepix/join?invite=` link. The host must allow the guest unless `slidepix.live.requireApproval` is off. Wrong secrets are rejected, and three failures ban that peer for the session.

The host applies each guest edit with `mergeDecksLive`, preferring the incoming edit when both sides changed the same property. An invalid combined deck is rejected. Guests keep their local change when a newer host state arrives, then send the merged result. Undo restores only the local step.

Guests download media the deck references and upload new media into the host's asset folder. During a session those uploads are embedded. Manim stays on the host. At most 8 guests can join.

The first time a guest opens a deck, SlidePix asks for a folder. Leaving that empty keeps the deck in the editor's temporary storage. The choice is remembered for that deck id. A later join reuses the folder when it still exists, or the temporary mirror when that was the choice. A missing folder is asked again. **Save locally** appears while the mirror is temporary: it copies the deck and its media into a chosen folder, and the session continues from there.

## Entry points

| File | Role |
| --- | --- |
| `manager.ts` | Commands, status bar, approval, settings |
| `transport.ts` | iroh QUIC endpoint, loaded only when a session starts |
| `sync.ts` | Host sequencer and guest client, with no VS Code or network |
| `host-session.ts` / `guest-session.ts` | Frame handling, reconnect, media transfer |
| `live-fs.ts` | `slidepix-live:` documents |
| `asset-mirror.ts` | Guest copies and path checks |

Settings: `slidepix.live.displayName`, `slidepix.live.relayMode` (`default`, `custom`, `disabled`), `slidepix.live.relayUrls`, `slidepix.live.requireApproval`.

## Change map

| To change... | Start with... | Verify with... |
| --- | --- | --- |
| Merge rules | `packages/core/src/merge.ts` | `merge.test.ts`, `sync.test.ts` |
| Wire format | `src/live/wire.ts` | `wire.test.ts` |
| Connection | `src/live/transport.ts` | `pnpm test:live` |
| Editor commands | `src/live/manager.ts`, `src/editor.ts` | Extension host, two windows |

## Dependencies

`@number0/iroh` supplies encrypted QUIC, NAT hole punching, and the public n0 relays. Direct connections are preferred. Relay bytes stay encrypted. `disabled` uses no relay. Intel macOS has no published binary; the editor still opens and reports that live collaboration is unavailable.

## Invariants and hazards

Remote peers are untrusted. Frames are schema-checked. Media paths go through `resolveMediaPath`, and the host serves a file only when a current or recent deck references it. Do not write a guest edit with `writeFile`; use `replaceDocument`. Do not add a second merge implementation.

Live Share, Open Collaboration Tools, Hyperswarm, and a webview WebRTC mesh were not used: they need an unsupported host, a server, UDP-only networking, or a public signaling service. A CRDT would be a second source of truth beside the deck file.

## Known limits

No character-level text merge. No view-only role. Linked media outside the deck's workspace folder is not copied. Manim runs only on the host.
