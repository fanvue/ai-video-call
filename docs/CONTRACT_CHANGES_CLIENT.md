# Proposed contract changes (client side)

Not applied — `src/lib/live/contract.ts` is server/shared owned. Coding against existing types
in the meantime; flagging for agreement.

## 1. `POST /api/live/reference` does not return a starting `LiveState`

It returns `{ anchorFrameUrl, wardrobe, lookLock, captured }`. There is no server-provided
`body`, `world`, or `surroundings` for the first `LiveSessionSnapshot` the client has to send
with the `greeting` job. The client currently seeds these itself
(`src/lib/live/client/defaultLiveState.ts`): a fixed per-scene `surroundings` string and a
generic seated/camera-facing `body`/`baselineBody`. This works because the `greeting` job's
result overwrites `state` anyway, but it means the very first request the client sends carries
a client-invented `LiveState` rather than one the server (or a vision pass on the reference
photo) actually derived.

Proposal: either have `/api/live/reference` also return a starting `LiveState`, or add a
dedicated `kind: "init"` response field so the client never has to invent physical state.

## 2. `ClipResult` has no explicit "does this clip have audible speech" flag

The client's gapless player needs to know whether to unmute a clip (native speech mode) or keep
it silent (text mode, no speech). We currently infer `hasSpeech = speechMode === "native" &&
result.reply !== null`, i.e. "native mode and this clip carries a reply". That is a guess: idle
ambience clips in native mode never speak in our assumption, and a `checkIn` line always counts
as speech if present. If the server's speech behaviour differs, add an explicit
`clipResultSchema.hasSpeech: boolean`.
