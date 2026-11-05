interface DecoderCallbacks {
  current(): boolean;
  output(frame: VideoFrame): void;
  error(message: string): void;
}

// Decoder outputs are always closed, including obsolete generations and failed canvas draws.
export async function createH264Decoder(
  config: VideoDecoderConfig,
  callbacks: DecoderCallbacks,
): Promise<VideoDecoder | undefined> {
  const support = await VideoDecoder.isConfigSupported(config);
  if (!callbacks.current()) return;
  if (!support.supported)
    throw new Error(`H.264 codec ${config.codec} is not supported by this browser`);
  const decoder = new VideoDecoder({
    output(frame) {
      try {
        if (callbacks.current()) callbacks.output(frame);
      } catch (error) {
        callbacks.error(
          `Device video draw failed: ${error instanceof Error ? error.message : String(error)}`,
        );
      } finally {
        frame.close();
      }
    },
    error(error) {
      if (callbacks.current()) callbacks.error(`H.264 decoder failed: ${error.message}`);
    },
  });
  try {
    decoder.configure(support.config ?? config);
  } catch (error) {
    decoder.close();
    throw new Error(
      `H.264 decoder configuration failed: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  return decoder;
}
