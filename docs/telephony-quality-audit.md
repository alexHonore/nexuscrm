# Phone reliability and voice-quality investigation — 2026-10-24

The local phone implementation now handles several reproducible lifecycle and
audio-device failures. This is **not yet an end-to-end voice-quality sign-off**:
no affected caller's microphone, live gateway RTP statistics or recipient-side
audio has been measured during this investigation.

## Confirmed defects and local fixes

| Trigger | Previous behavior | Correction |
| --- | --- | --- |
| Cancel while microphone permission is pending | Capture continued waiting; hints/timeouts could outlive the call. | Abortable application-level capture; stop any stream returned after cancellation; clear all timers. |
| Receive a call with a missing selected headset | Incoming calls bypassed outgoing microphone preflight, fallback and timeout handling. | Same speech capture and missing-device fallback in both directions; incoming answer is idempotent. |
| Change headset while hanging up or changing again | A late stream could replace the wrong call's microphone or remain open. | Bind changes to the current session, serialize replacement and stop stale streams. |
| Mute during microphone replacement | A replacement could inherit stale mute state. | Recheck mute/hold when the track is actually installed. |
| Unplug an active microphone | The sender could keep an ended track, leaving the recipient without voice. | Detect ended capture, notify the caller and attempt the system microphone. Actual active device appears in diagnostics. |
| Chosen speaker disappears | Failed `setSinkId` was silently ignored; fallback to the system speaker was assumed. | Explicit fallback and serialized routing so old failures cannot undo a newer choice. |
| Remote audio track arrives before SIP progress | Early-media monitoring never started; local ringing could cover the carrier's audio. | Start monitoring from both events; don't restart local ringing after remote audio. Use audio energy when supplied to distinguish silent RTP. |
| Late events from an earlier call | An old `ended`/`failed` event could clear the next call's state. | Check session identity on callbacks and ignore duplicate terminal events. |
| Retry line initialization repeatedly | Multiple async initializations could create competing engines. | Serialize initialization and refuse a restart during a call. |
| Open several CRM tabs | Each tab registered the same SIP identity; the gateway's account-to-WebSocket mapping can be overwritten. | One phone owner per browser origin using Web Locks; waiting tabs say where the phone is and acquire it when the owner closes. Older browsers without Web Locks retain existing behavior. |
| Twilio: hang up during `Device.connect()` | Late connection could become an orphaned call. | Generation check, immediate state cleanup and disconnection of late results. |
| Twilio: choose system default in a live call | Called `unsetInputDevice`, which the SDK disallows during a connection. | Select `default`; release the microphone between calls. |
| Twilio: toggle mute while on hold | Could unmute a call still shown as held. | Track intentional mute and hold independently. |

Speech capture explicitly requests echo cancellation, noise suppression,
automatic gain control and one preferred channel. These are browser requests;
diagnostics show whether the browser reports applying the processing settings.
No artificial microphone boost, compressor or extra audio-processing chain was
introduced: clipping or double processing would make speech less intelligible.

## What can now be measured

During a call, open **Phone → Call connection** (French: **Téléphone → Connexion
de l'appel**). The panel shows the actual capture device, microphone state and
level where supported, codec, received/sent packet loss, jitter and round-trip
delay. It remains available for the last call in the desktop phone panel.

The quality report contains up to 90 recent samples in browser memory. Download
it for an affected call before starting the next one. It contains measurements
and the microphone's device label; it contains no recording, customer number,
credentials, SDP or IP addresses. Nothing is uploaded automatically.

**Direction matters:** `inbound-rtp` is what the caller hears; the gateway's
`remote-inbound-rtp` feedback describes what it receives from the caller. The
second is the relevant first measurement when the recipient complains about
the caller's voice. Missing feedback stays unavailable. Twilio's public sample
event supplies received-packet loss, which is never presented as sent loss.
See [WebRTC remote receiver statistics](https://developer.mozilla.org/en-US/docs/Web/API/RTCRemoteInboundRtpStreamStats)
and [Twilio Call sample events](https://www.twilio.com/docs/voice/sdks/javascript/twiliocall).

These reports cover **browser ↔ media service**, not media service ↔ voip.ms ↔
recipient carrier. A clean browser report cannot certify the entire call.
Loss is computed over intervals; stale remote reports expire after ten seconds.
The UI flags loss at 1%/3%, jitter at 30/50 ms, and round-trip delay at
300/500 ms as degraded/poor. Those are diagnostic thresholds, not a claimed MOS
score or a promise of speech quality. Missing measurements cannot earn a green
state.

## Gateway and codec findings

- Repository configuration sends WebRTC audio through Kamailio + RTPengine,
  then RTP to voip.ms. It does not configure Opus transcoding.
- The SDP workaround preserves G.722 and G.711 while trimming unsupported
  payloads and excess attributes for the known SIP/UDP MTU problem. Blindly
  re-enabling Opus would require a tested gateway transcoding change.
- Corrected gateway instructions that suggested Opus directly with voip.ms.
  voip.ms documents G.711 and G.722, among other codecs; G.722's RTP clock is
  8 kHz despite its wider audio bandwidth. Carrier routing still determines
  whether the far end receives wideband audio. See
  [voip.ms account codec settings](https://wiki.voip.ms/article/Account_Settings)
  and [RTPengine transcoding](https://github.com/sipwise/rtpengine/blob/master/docs/transcoding.md).
- The repository uses a public STUN server, with no TURN relay provisioned.
  Restricted networks may therefore fail to establish media. This is an
  infrastructure limitation to test, not a demonstrated cause of the reported
  poor voice. Adding TURN requires a reachable service and expiring credentials.
- The documented gateway shares a VPS with n8n. CPU contention, host location,
  packet loss and firewall behavior remain hypotheses until measured there.

Read-only Vercel inspection confirmed production variables named
`NEXT_PUBLIC_SIP_WSS_URL`, `VOIPMS_API_PROXY_URL` and `VOIPMS_SIP_DOMAIN` exist.
They are marked Sensitive. The CLI did not expose their values; local dotenv
fallbacks are **not evidence of the deployed endpoint or its absence**. No SSH
gateway alias was found in this Mac's SSH configuration. The gateway hostname
and access details have been requested to continue that part of the audit.

## Live acceptance check still required

1. Use an affected caller's normal device/browser. Call a designated test
   recipient and read a short passage at normal volume for at least a minute.
   Check both directions, interruptions, echo, clipped syllables and volume.
   Download the quality report. Repeat using a wired headset and a stable
   connection to isolate capture from network problems. Twilio likewise
   recommends a controlled headset/network environment in its
   [voice SDK best practices](https://www.twilio.com/docs/voice/sdks/javascript/best-practices).
2. Repeat with several concurrent callers, and compare quiet and busy periods
   on the gateway. Measure gateway CPU/steal, interface drops, UDP receive-buffer
   errors and RTP/RTCP loss/jitter in both directions. Verify the running
   Kamailio/RTPengine versions and configuration, POP and negotiated codecs.
3. Test incoming/outgoing calls, cancel during permission prompts, reconnect a
   headset, switch microphones, mute/hold/resume, DTMF, rapid redial and two CRM
   tabs. On mobile, test foreground/background and screen locking: browser
   suspension is outside what an in-page SIP client can guarantee.
4. If browser uplink measurements are clean while recipients still hear bad
   audio, correlate timestamps with the gateway/provider call trace. Compare
   multiple destination carriers before changing codecs or routes.

The release changes the webphone application and gateway setup documentation.
Provider account settings and the running gateway configuration are unchanged;
they still require the live acceptance check above.

## Local verification

- Before the main-branch release, the complete repository suite passed:
  **4,127 tests across 180 files**, against the local `nexus_test` database.
- 186 checks passed across 13 test files: both phone engines, microphone and
  speaker lifecycle, browser-tab ownership, quality calculations and French/
  English rendering, provider helpers, visual vocabulary and locale guards.
- ESLint and `git diff --check` cover the changed phone implementation/tests.
- The phone release was isolated from unfinished local conversion/campaign
  work. The isolated release passes full TypeScript checking and the production
  build (`pnpm build --webpack`, using the local test environment).
- The local dev server was restarted to reload the phone translations.
- Tests use simulated devices and transport events. Real browser microphones,
  mobile suspension, the live gateway and recipient audio still need the live
  acceptance check above.
