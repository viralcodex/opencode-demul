// After dropping a dependent frame, forward configuration only until a new keyframe arrives.
export class VideoFlow {
  private waitingKeyframe = true;
  private needsRecovery = false;

  constructor(
    private readonly maxBufferedBytes: number,
    private readonly recover: () => void,
  ) {}

  accept(
    frame: { key: boolean; picture: boolean; bytes: Uint8Array },
    bufferedAmount: number,
  ): boolean {
    if (bufferedAmount + frame.bytes.byteLength > this.maxBufferedBytes) {
      this.waitingKeyframe = true;
      this.needsRecovery = true;
      return false;
    }
    if (frame.key) {
      this.waitingKeyframe = false;
      this.needsRecovery = false;
      return true;
    }
    if (this.needsRecovery) {
      this.needsRecovery = false;
      this.recover();
    }
    return !frame.picture || !this.waitingKeyframe;
  }

  reset(): void {
    this.waitingKeyframe = true;
    this.needsRecovery = false;
  }
}
