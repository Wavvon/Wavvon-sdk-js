// The voice transport (voice-transport-v3.md): one WebRTC data channel,
// negotiated on stream 0, unordered, no retransmission, over werift. The hub
// is ICE-lite and answers with its host candidates, so no STUN or TURN server
// is configured. The room sees only send, onMessage, onClose and close.

import { VoiceError } from "./errors.js";

/** A packet that still fits one SCTP chunk in a 1280-byte path MTU; a split one is lost whole if any piece is. */
export const MAX_PACKET = 1200;
const OPEN_TIMEOUT_MS = 10_000;

export interface Link {
  send(packet: Uint8Array): void;
  close(): void;
}

export interface LinkHandlers {
  onMessage(packet: Uint8Array): void;
  onClose(): void;
}

export interface PendingOffer {
  sdp: string;
  accept(answerSdp: string, handlers: LinkHandlers): Promise<Link>;
  close(): void;
}

type Werift = typeof import("werift");

async function loadWerift(): Promise<Werift> {
  try {
    return await import("werift");
  } catch (e) {
    throw new VoiceError("transport", `voice needs the optional "werift" package (npm i werift): ${String(e)}`);
  }
}

export async function createOffer(): Promise<PendingOffer> {
  const { RTCPeerConnection } = await loadWerift();
  const pc = new RTCPeerConnection({ iceServers: [] });
  const dc = pc.createDataChannel("voice", { negotiated: true, id: 0, ordered: false, maxRetransmits: 0 });
  const close = () => {
    void pc.close().catch(() => {});
  };
  try {
    await pc.setLocalDescription(await pc.createOffer());
    // The hub takes no trickled candidates: the offer must carry them all.
    if (pc.iceGatheringState !== "complete") {
      await new Promise<void>((resolve) => {
        const { unSubscribe } = pc.iceGatheringStateChange.subscribe((s) => {
          if (s === "complete") {
            unSubscribe();
            resolve();
          }
        });
      });
    }
  } catch (e) {
    close();
    throw new VoiceError("transport", `could not build the WebRTC offer: ${String(e)}`);
  }
  const sdp = pc.localDescription?.sdp;
  if (!sdp) {
    close();
    throw new VoiceError("transport", "WebRTC produced no offer");
  }
  return {
    sdp,
    close,
    async accept(answerSdp, handlers) {
      let closed = false;
      const ended = () => {
        if (closed) return;
        closed = true;
        handlers.onClose();
      };
      dc.onMessage.subscribe((data) => {
        if (typeof data !== "string") handlers.onMessage(new Uint8Array(data));
      });
      dc.stateChanged.subscribe((s) => {
        if (s === "closed") ended();
      });
      pc.connectionStateChange.subscribe((s) => {
        if (s === "failed" || s === "closed") ended();
      });
      try {
        await pc.setRemoteDescription({ type: "answer", sdp: answerSdp });
        if (dc.readyState !== "open") {
          await new Promise<void>((resolve, reject) => {
            const timer = setTimeout(() => reject(new Error("timed out")), OPEN_TIMEOUT_MS);
            dc.stateChanged.subscribe((s) => {
              if (s === "open") {
                clearTimeout(timer);
                resolve();
              }
            });
          });
        }
      } catch (e) {
        closed = true;
        close();
        throw new VoiceError("transport", `voice data channel did not open: ${String(e)}`);
      }
      return {
        send(packet) {
          if (dc.readyState === "open") dc.send(Buffer.from(packet.buffer, packet.byteOffset, packet.byteLength));
        },
        close() {
          closed = true;
          close();
        },
      };
    },
  };
}
