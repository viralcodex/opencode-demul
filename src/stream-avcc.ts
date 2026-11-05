import { WebSocket } from "ws";
import { get as httpGet, type IncomingMessage } from "node:http";
import { get as httpsGet } from "node:https";
import { AvccStream, type AvccFrame } from "./avcc.js";
import { VideoFlow } from "./video-flow.js";

export interface AvccSource {
  readonly url: string;
  readonly authorization: string;
}

export function bridgeAvcc(source: AvccSource, downstream: WebSocket, maxBufferedBytes: number) {
  let current: AbortController | undefined;
  let receivedFrame = false;
  let restarting = false;
  const abort = () => current?.abort();
  const reset = () => {
    // Opening the AVCC subscription already requests a keyframe. Ignore resets until it has sent video.
    if (!receivedFrame || restarting) return;
    restarting = true;
    abort();
  };
  downstream.on("close", abort);
  downstream.on("error", abort);

  const run = async () => {
    try {
      while (downstream.readyState === WebSocket.OPEN) {
        const controller = new AbortController();
        current = controller;
        restarting = false;
        receivedFrame = false;
        try {
          await pumpAvcc(
            source,
            controller.signal,
            forwardFrames(downstream, maxBufferedBytes, reset, () => {
              receivedFrame = true;
            }),
          );
        } catch (error) {
          if (!controller.signal.aborted) throw error;
        } finally {
          controller.abort();
        }
        if (!restarting) break;
      }
    } catch (error) {
      if (downstream.readyState !== WebSocket.OPEN) return;
      const token = source.authorization.slice("Bearer ".length);
      const message = (error instanceof Error ? error.message : String(error))
        .replaceAll(token, "[redacted]")
        .slice(0, 512);
      downstream.send(JSON.stringify({ ok: false, error: message }));
      downstream.close(1011);
    } finally {
      current = undefined;
      downstream.off("close", abort);
      downstream.off("error", abort);
    }
  };

  return {
    done: run(),
    reset,
  };
}

function forwardFrames(
  downstream: WebSocket,
  maxBufferedBytes: number,
  recover: () => void,
  onFrame: () => void,
) {
  const flow = new VideoFlow(maxBufferedBytes, recover);
  return (frame: AvccFrame) => {
    if (downstream.readyState !== WebSocket.OPEN) return;
    if (!flow.accept({ ...frame, picture: true }, downstream.bufferedAmount)) return;
    downstream.send(frame.bytes, { binary: true });
    onFrame();
  };
}

async function pumpAvcc(source: AvccSource, signal: AbortSignal, send: (frame: AvccFrame) => void) {
  const response = await openStream(source, signal);
  const stream = new AvccStream();
  try {
    if (response.statusCode !== 200)
      throw new Error(`iOS H.264 stream returned HTTP ${response.statusCode}`);
    for await (const chunk of response) {
      if (signal.aborted) return;
      for (const frame of stream.push(chunk)) {
        if (signal.aborted) return;
        send(frame);
      }
    }
    if (signal.aborted) return;
    stream.finish();
    throw new Error("iOS H.264 stream ended. Refresh devices to retry.");
  } finally {
    response.destroy();
  }
}

// Node HTTP closes the capture connection on abort in both Node and Bun, and never follows redirects with credentials.
function openStream(source: AvccSource, signal: AbortSignal): Promise<IncomingMessage> {
  return new Promise((resolve, reject) => {
    const url = new URL(source.url);
    const get = url.protocol === "https:" ? httpsGet : httpGet;
    const request = get(url, { headers: { authorization: source.authorization }, signal }, resolve);
    request.once("error", reject);
    request.once("close", () =>
      reject(new Error("iOS H.264 connection closed before stream headers")),
    );
  });
}
