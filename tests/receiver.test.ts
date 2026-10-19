import { afterEach, describe, expect, it, vi } from "vitest";

// Only the browser and Cast transports are faked. main.ts constructs the real
// installed SendspinPlayer and exchanges real SDK protocol messages.
class TestSocket {
  static OPEN = 1;
  static instances: TestSocket[] = [];
  readyState = 0;
  onopen?: () => void;
  onmessage?: (event: { data: string }) => void;
  onclose?: () => void;
  sent: any[] = [];
  constructor(readonly url: string) {
    TestSocket.instances.push(this);
  }
  open() {
    this.readyState = TestSocket.OPEN;
    this.onopen?.();
  }
  send(data: string) {
    this.sent.push(JSON.parse(data));
  }
  receive(type: string, payload: unknown) {
    this.onmessage?.({ data: JSON.stringify({ type, payload }) });
  }
  close() {
    this.readyState = 3;
  }
}

afterEach(() => {
  vi.clearAllTimers();
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("Cast receiver with SDK 3.2", () => {
  it.each([
    "Mozilla/5.0 (X11; Linux armv7l) CrKey/1.56.500000",
    "Mozilla/5.0 (Linux; Android 11; SHIELD Android TV) CrKey/1.56.500000",
  ])("retains v1 protocol and hardware controls on %s", async (userAgent) => {
    vi.useFakeTimers();
    vi.resetModules();
    TestSocket.instances = [];
    const context = {
      addEventListener: vi.fn(),
      addCustomMessageListener: vi.fn(),
      start: vi.fn(),
      stop: vi.fn(),
      getSystemVolume: () => ({ level: 0.42, muted: false }),
      setSystemVolumeLevel: vi.fn(),
      setSystemVolumeMuted: vi.fn(),
      sendCustomMessage: vi.fn(),
    };
    vi.stubGlobal("navigator", { userAgent });
    vi.stubGlobal("window", {
      cast: {
        framework: { CastReceiverContext: { getInstance: () => context } },
      },
      location: { href: "https://receiver.test/receiver.html" },
      addEventListener: vi.fn(),
      setInterval,
      clearInterval,
      setTimeout,
      clearTimeout,
    });
    vi.stubGlobal("document", { addEventListener: vi.fn() });
    vi.stubGlobal("localStorage", { setItem: vi.fn() });
    vi.stubGlobal("AudioContext", class {});
    vi.stubGlobal("WebSocket", TestSocket);
    const { SendspinPlayer } = await import("@sendspin/sendspin-js");
    const connect = vi.spyOn(SendspinPlayer.prototype, "connect");
    await import("../src/js/main");
    await Promise.resolve();
    expect(context.start).toHaveBeenCalled();
    const onConfig = context.addCustomMessageListener.mock.calls[0][1];
    onConfig({
      data: {
        type: "config",
        serverUrl: "http://ma.test:8927",
        playerId: "cast-test",
        playerName: "Test Cast",
        syncDelay: 330,
        codecs: ["pcm"],
      },
    });
    await Promise.resolve();
    const socket = TestSocket.instances[0];
    // Pinned-SDK test seam: verify the receiver's actual constructor options
    // reach the Cast scheduler, including its unreliable-timestamp guard.
    const scheduler = (connect.mock.contexts[0] as any).scheduler;
    expect(scheduler.outputMode).toBe(
      userAgent.includes("Android") ? "media-element" : "direct",
    );
    expect(scheduler.correctionMode).toBe("sync");
    expect(scheduler.useHardwareVolume).toBe(true);
    expect(scheduler.useOutputLatencyCompensation).toBe(true);
    const getOutputTimestamp = vi.fn(() => {
      throw new Error("Unreliable firmware timestamp");
    });
    for (let index = 0; index < 12; index++) {
      scheduler.clockSource.getTimingSnapshot({
        currentTime: 10 + index / 10,
        getOutputTimestamp,
      });
    }
    expect(getOutputTimestamp).not.toHaveBeenCalled();
    expect(scheduler.clockSource.active).toBe("estimated");
    expect(socket.url).toBe("ws://ma.test:8927/sendspin");
    socket.open();
    await vi.advanceTimersByTimeAsync(0);
    expect(socket.sent[0]).toMatchObject({
      type: "client/hello",
      payload: {
        client_id: "cast-test",
        name: "Test Cast",
        version: 1,
        supported_roles: ["player@v1", "controller@v1", "metadata@v1"],
        "player@v1_support": { buffer_capacity: 2 * 1024 * 1024 },
      },
    });
    const formats =
      socket.sent[0].payload["player@v1_support"].supported_formats;
    expect(formats[0].codec).toBe("pcm");
    expect(
      formats.some((format: { codec: string }) => format.codec === "opus"),
    ).toBe(false);
    socket.receive("server/hello", {});
    expect(
      socket.sent.find((message) => message.type === "client/state"),
    ).toMatchObject({
      payload: { player: { volume: 42, muted: false, static_delay_ms: 330 } },
    });
    socket.receive("server/command", {
      player: { command: "volume", volume: 65 },
    });
    expect(context.setSystemVolumeLevel).toHaveBeenCalledWith(0.65);
    socket.receive("server/command", {
      player: { command: "set_static_delay", static_delay_ms: 410 },
    });
    expect(context.sendCustomMessage).toHaveBeenCalledWith(
      "urn:x-cast:sendspin",
      undefined,
      {
        type: "config",
        syncDelay: 410,
      },
    );
    expect(socket.sent[socket.sent.length - 1]).toMatchObject({
      type: "client/state",
      payload: { player: { static_delay_ms: 410 } },
    });
    expect(context.stop).not.toHaveBeenCalled();
  });
});
